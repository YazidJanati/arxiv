import AppKit
import Foundation

func request(_ worker: RecommendationWorker, _ operation: String, _ body: [String: Any] = [:]) async throws -> [String: Any] {
    try await withCheckedThrowingContinuation { continuation in
        worker.handle(operation: operation, body: body) { value, error in
            if let error = error { continuation.resume(throwing: NSError(domain: "test", code: 1, userInfo: [NSLocalizedDescriptionKey: error])) }
            else { continuation.resume(returning: value as? [String: Any] ?? [:]) }
        }
    }
}
func check(_ condition: @autoclosure () -> Bool, _ message: String) throws {
    if !condition() { throw NSError(domain: "test", code: 1, userInfo: [NSLocalizedDescriptionKey: message]) }
}
let folder = FileManager.default.temporaryDirectory.appendingPathComponent("arxiv-worker-test-" + UUID().uuidString)
try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
let fake = folder.appendingPathComponent("codex")
let source = #"""
#!/usr/bin/env python3
import json, pathlib, sys, time
root = pathlib.Path(__file__).parent
reset_file = root / 'reset'
if not reset_file.exists(): reset_file.write_text(str(int(time.time()) + 3600))
reset = int(reset_file.read_text())
if sys.argv[1] == 'app-server':
    for line in sys.stdin:
        req = json.loads(line)
        method = req['method']
        if method == 'initialize': result = {}
        elif method == 'account/read': result = {'account': {'type': 'chatgpt', 'email': 'other@example.com' if (root / 'other-account').exists() else 'reader@example.com', 'planType': 'plus', 'workspaceName': 'Research'}}
        else:
            fixture = root / 'limits.json'
            result = json.loads(fixture.read_text()) if fixture.exists() else {'ordinaryUsageAllowed': True, 'rateLimits': {'primary': {'usedPercent': 90, 'windowDurationMins': 300, 'resetsAt': reset}}}
        print(json.dumps({'id': req['id'], 'result': result}), flush=True)
    sys.exit(0)
if sys.argv[1] == 'login':
    print('Logged in using ChatGPT')
    sys.exit(0)
schema = json.loads(pathlib.Path(sys.argv[sys.argv.index('--output-schema') + 1]).read_text())
fields = schema['properties']['recommendations']['items']['properties']
assert fields['id']['enum'] == ['2610.00001'], 'Output IDs must be constrained to this batch'
assert fields['reason']['maxLength'] == 1600 and fields['reason']['minLength'] == 1
with (root / 'calls').open('a') as f:
    f.write(json.dumps(sys.argv[1:]) + '\n')
if (root / 'hold').exists():
    while True: time.sleep(0.05)
if (root / 'increase').exists():
    (root / 'limits.json').write_text(json.dumps({'rateLimits': {'primary': {'usedPercent': 96, 'windowDurationMins': 300, 'resetsAt': reset}}}))
print(json.dumps({'type':'item.completed','item':{'type':'agent_message','text':json.dumps({'recommendations':[{'id':'2610.00001','kind':'direct','reason':'Test sampling method.'}]})}}))
print(json.dumps({'type':'turn.completed','usage':{'input_tokens':12,'cached_input_tokens':4,'output_tokens':3}}))
if (root / 'fail').exists(): sys.exit(1)
"""#
try source.write(to: fake, atomically: true, encoding: .utf8)
try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: fake.path)
let worker = RecommendationWorker(directory: folder, executable: fake)
Task { @MainActor in
    do {
        // A Mac with only ChatGPT installed must discover its bundled CLI.
        let bundled = folder.appendingPathComponent("ChatGPT.app/Contents/Resources/codex-cli/bin/codex")
        try FileManager.default.createDirectory(at: bundled.deletingLastPathComponent(), withIntermediateDirectories: true)
        try FileManager.default.copyItem(at: fake, to: bundled)
        let candidates = RecommendationWorker.executableCandidates(applicationsDirectory: folder.path).filter { $0.hasPrefix(folder.path) }
        try check(RecommendationWorker.findExecutable(in: candidates) == bundled.path, "Must discover the CLI bundled with ChatGPT")
        let bundledStatus = try await request(RecommendationWorker(directory: folder, executable: bundled), "recommendationStatus")
        try check(bundledStatus["connected"] as? Bool == true, "Bundled CLI must report the existing ChatGPT login")
        let status = try await request(worker, "recommendationStatus")
        try check(status["connected"] as? Bool == true, "Must detect ChatGPT login")
        try check((status["account"] as? [String: Any])?["email"] as? String == "reader@example.com", "Must show connected account identity")
        try check((status["fiveHourUsage"] as? [String: Any])?["usedPercent"] as? Double == 90, "Must report five-hour usage")
        let body: [String: Any] = ["model": "gpt-6.1-terra", "dailyBatchLimit": 1, "instructions": "Review abstracts only", "prompt": "{\"papers\":[{\"id\":\"2610.00001\",\"abstract\":\"Supplied fixture abstract\"}]}"]
        let limitsFile = folder.appendingPathComponent("limits.json")
        for limits: [String: Any] in [
            ["ordinaryUsageAllowed": false, "rateLimits": ["primary": ["usedPercent": 0, "windowDurationMins": 300, "resetsAt": Date().timeIntervalSince1970 + 3600]]]
        ] {
            try JSONSerialization.data(withJSONObject: limits).write(to: limitsFile)
            do { _ = try await request(worker, "recommend", body); throw NSError(domain: "test", code: 4, userInfo: [NSLocalizedDescriptionKey: "Usage guard bypassed"]) }
            catch { try check(!error.localizedDescription.contains("guard bypassed"), "Must block at ceiling, unavailable usage, or denied included usage") }
            try check(!FileManager.default.fileExists(atPath: folder.appendingPathComponent("calls").path), "Blocked usage must not invoke model or spend a batch")
        }
        try FileManager.default.removeItem(at: limitsFile)
        let result = try await request(worker, "recommend", body)
        try check(result["model"] as? String == "gpt-6.1-terra", "Must report selected model")
        let usage = result["dailyUsage"] as? [String: Any] ?? [:]
        try check(usage["batches"] as? Int == 1 && usage["inputTokens"] as? Int == 12 && usage["outputTokens"] as? Int == 3, "Must persist actual usage")
        let args = try JSONSerialization.jsonObject(with: Data(contentsOf: folder.appendingPathComponent("calls"))) as? [String] ?? []
        try check(args.contains("gpt-6.1-terra") && args.contains("--model") && args.contains("--json"), "Must pin model and request usage events")
        let afterReview = try await request(worker, "recommendationStatus")
        try check((afterReview["reviewTokenUsage"] as? [String: Any])?["totalTokens"] as? Int == 15, "Must count actual input plus output tokens regardless of account usage")
        var strictBody = body; strictBody["reviewTokenLimit"] = 15; strictBody["dailyBatchLimit"] = 10
        do { _ = try await request(RecommendationWorker(directory: folder, executable: fake), "recommend", strictBody); throw NSError(domain: "test", code: 5, userInfo: [NSLocalizedDescriptionKey: "Custom budget bypassed"]) }
        catch { try check(error.localizedDescription.contains("budget reached"), "Restart must preserve the app-specific token budget") }
        // A fresh worker cannot bypass the same day's persisted cap.
        let restarted = RecommendationWorker(directory: folder, executable: fake)
        do { _ = try await request(restarted, "recommend", body); throw NSError(domain: "test", code: 2, userInfo: [NSLocalizedDescriptionKey: "Budget was bypassed"]) }
        catch { try check(error.localizedDescription.contains("Daily batch limit"), "Must block before model execution") }
        try Data().write(to: folder.appendingPathComponent("hold"))
        var next = body; next["dailyBatchLimit"] = 2
        let pending = Task { try await request(restarted, "recommend", next) }
        for _ in 0..<100 {
            let calls = (try? String(contentsOf: folder.appendingPathComponent("calls"), encoding: .utf8)) ?? ""
            if calls.split(separator: "\n").count == 2 { break }
            try await Task.sleep(nanoseconds: 20_000_000)
        }
        restarted.cancel()
        do { _ = try await pending.value; throw NSError(domain: "test", code: 3, userInfo: [NSLocalizedDescriptionKey: "Cancellation failed"]) }
        catch { try check(!error.localizedDescription.contains("Cancellation failed"), "Must cancel the running model") }
        let final = try await request(restarted, "recommendationStatus")
        try check((final["usage"] as? [String: Any])?["batches"] as? Int == 2, "Cancelled attempts must count toward the daily cap")
        try FileManager.default.removeItem(at: folder.appendingPathComponent("hold"))
        try Data().write(to: folder.appendingPathComponent("increase"))
        var extra = body; extra["dailyBatchLimit"] = 10
        _ = try await request(restarted, "recommend", extra)
        let measured = try await request(restarted, "recommendationStatus")
        try check((measured["reviewTokenUsage"] as? [String: Any])?["totalTokens"] as? Int == 30, "Must count two reported 15-token requests without charging cancelled attempts a guessed amount")
        try check((measured["reviewTokenUsage"] as? [String: Any])?["unreportedAttempts"] as? Int == 1, "Must show cancelled attempts with missing usage reports")
        try Data().write(to: folder.appendingPathComponent("other-account"))
        let other = try await request(restarted, "recommendationStatus")
        try check((other["reviewTokenUsage"] as? [String: Any])?["totalTokens"] as? Int == 0, "Different accounts must have separate token budgets")
        try FileManager.default.removeItem(at: folder.appendingPathComponent("other-account"))
        try Data().write(to: folder.appendingPathComponent("fail"))
        do { _ = try await request(restarted, "recommend", extra); throw NSError(domain: "test", code: 6, userInfo: [NSLocalizedDescriptionKey: "Failure ignored"]) }
        catch { try check(error.localizedDescription.contains("could not finish"), "Failed model attempt must report its error") }
        let failed = try await request(restarted, "recommendationStatus")
        try check((failed["reviewTokenUsage"] as? [String: Any])?["totalTokens"] as? Int == 45, "Reported tokens from failed requests must count too")
        let reset = Double(try String(contentsOf: folder.appendingPathComponent("reset"), encoding: .utf8))!
        try JSONSerialization.data(withJSONObject: ["rateLimits": ["primary": ["usedPercent": 99, "windowDurationMins": 300, "resetsAt": reset]]]).write(to: limitsFile)
        let idle = try await request(restarted, "recommendationStatus")
        try check((idle["reviewTokenUsage"] as? [String: Any])?["totalTokens"] as? Int == 45, "Other account usage must not count")
        try JSONSerialization.data(withJSONObject: ["rateLimits": ["primary": ["usedPercent": 0, "windowDurationMins": 300, "resetsAt": reset + 18000]]]).write(to: limitsFile)
        let renewed = try await request(restarted, "recommendationStatus")
        try check((renewed["reviewTokenUsage"] as? [String: Any])?["totalTokens"] as? Int == 45, "Account quota resets must not erase a rolling token ledger")
        let ledgerFile = folder.appendingPathComponent("recommendation-token-budget.json")
        var entries = try JSONSerialization.jsonObject(with: Data(contentsOf: ledgerFile)) as! [[String: Any]]
        for index in entries.indices { entries[index]["at"] = Date().timeIntervalSince1970 - 18001 }
        try JSONSerialization.data(withJSONObject: entries).write(to: ledgerFile)
        let expired = try await request(restarted, "recommendationStatus")
        try check((expired["reviewTokenUsage"] as? [String: Any])?["totalTokens"] as? Int == 0, "Tokens must expire after five hours")
        try FileManager.default.removeItem(at: folder)
        print("PASS: account identity, rolling token budget, model pinning, JSONL usage, persisted budget, cancellation; no real model requests")
        exit(0)
    } catch {
        try? FileManager.default.removeItem(at: folder)
        print("FAIL: \(error.localizedDescription)")
        exit(1)
    }
}
RunLoop.main.run()
