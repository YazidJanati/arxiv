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
if sys.argv[1] == 'login':
    print('Logged in using ChatGPT')
    sys.exit(0)
with (root / 'calls').open('a') as f:
    f.write(json.dumps(sys.argv[1:]) + '\n')
if (root / 'hold').exists():
    while True: time.sleep(0.05)
print(json.dumps({'type':'item.completed','item':{'type':'agent_message','text':json.dumps({'recommendations':[{'id':'2610.00001','kind':'direct','reason':'Test sampling method.'}]})}}))
print(json.dumps({'type':'turn.completed','usage':{'input_tokens':12,'cached_input_tokens':0,'output_tokens':3}}))
"""#
try source.write(to: fake, atomically: true, encoding: .utf8)
try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: fake.path)
let worker = RecommendationWorker(directory: folder, executable: fake)
Task { @MainActor in
    do {
        let status = try await request(worker, "recommendationStatus")
        try check(status["connected"] as? Bool == true, "Must detect ChatGPT login")
        let body: [String: Any] = ["model": "gpt-6.1-terra", "dailyBatchLimit": 1, "instructions": "Review abstracts only", "prompt": "Supplied fixture abstract"]
        let result = try await request(worker, "recommend", body)
        try check(result["model"] as? String == "gpt-6.1-terra", "Must report selected model")
        let usage = result["dailyUsage"] as? [String: Any] ?? [:]
        try check(usage["batches"] as? Int == 1 && usage["inputTokens"] as? Int == 12 && usage["outputTokens"] as? Int == 3, "Must persist actual usage")
        let args = try JSONSerialization.jsonObject(with: Data(contentsOf: folder.appendingPathComponent("calls"))) as? [String] ?? []
        try check(args.contains("gpt-6.1-terra") && args.contains("--model") && args.contains("--json"), "Must pin model and request usage events")
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
        try FileManager.default.removeItem(at: folder)
        print("PASS: model pinning, JSONL usage, persisted budget, cancellation; no real model requests")
        exit(0)
    } catch {
        try? FileManager.default.removeItem(at: folder)
        print("FAIL: \(error.localizedDescription)")
        exit(1)
    }
}
RunLoop.main.run()
