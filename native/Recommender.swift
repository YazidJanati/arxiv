import AppKit
import Foundation

// ChatGPT authentication stays with the official local Codex client. The reader's
// arXiv fetch bridge remains restricted to arXiv; this worker only reviews supplied text.
final class RecommendationWorker {
    private let queue = DispatchQueue(label: "arxiv.recommendations", qos: .utility)
    private let lock = NSLock()
    private var active: Process?
    private var stopping = false
    private var cancellationGeneration = 0
    private let executableOverride: URL?
    private let directory: URL
    init(directory: URL, executable: URL? = nil) { self.directory = directory; self.executableOverride = executable }
    func cancel() {
        lock.lock(); cancellationGeneration += 1; let process = active; lock.unlock()
        if let process = process, process.isRunning { process.terminate() }
    }
    private func dateKey() -> String {
        let formatter = DateFormatter(); formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = .current; formatter.dateFormat = "yyyy-MM-dd"
        return formatter.string(from: Date())
    }
    private func usage() -> [String: Any] {
        if let data = try? Data(contentsOf: directory.appendingPathComponent("recommendation-usage.json")),
           let value = try? JSONSerialization.jsonObject(with: data) as? [String: Any], value["date"] as? String == dateKey(),
           let batches = value["batches"] as? Int, batches >= 0 { return value }
        return ["date": dateKey(), "batches": 0, "inputTokens": 0, "outputTokens": 0]
    }
    private func saveUsage(_ value: [String: Any]) throws {
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]).write(to: directory.appendingPathComponent("recommendation-usage.json"), options: [.atomic])
    }
    private func models() -> [[String: String]] {
        let file = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".codex/models_cache.json")
        if let data = try? Data(contentsOf: file), let cache = try? JSONSerialization.jsonObject(with: data) as? [String: Any], let list = cache["models"] as? [[String: Any]] {
            let choices = list.compactMap { model -> [String: String]? in
                guard let id = model["slug"] as? String, id.hasPrefix("gpt-"), let name = model["display_name"] as? String else { return nil }
                return ["id": id, "name": name]
            }
            if !choices.isEmpty { return choices }
        }
        return [["id": "gpt-6.1-terra", "name": "GPT-6.1 Terra"]]
    }
    static func executableCandidates(applicationsDirectory: String = "/Applications") -> [String] {
        ["/opt/homebrew/bin/codex", "/usr/local/bin/codex",
         applicationsDirectory + "/Codex.app/Contents/Resources/codex",
         applicationsDirectory + "/ChatGPT.app/Contents/Resources/codex-cli/bin/codex",
         applicationsDirectory + "/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex"]
    }
    static func findExecutable(in candidates: [String]) -> String? {
        candidates.first { FileManager.default.isExecutableFile(atPath: $0) }
    }
    private var executable: String? {
        if let path = executableOverride?.path { return FileManager.default.isExecutableFile(atPath: path) ? path : nil }
        return Self.findExecutable(in: Self.executableCandidates())
    }
    func stop() {
        lock.lock(); stopping = true; let process = active; lock.unlock()
        if let process = process, process.isRunning { process.terminate() }
    }
    private func failure(_ message: String) -> NSError {
        NSError(domain: "arxiv.recommendations", code: 1, userInfo: [NSLocalizedDescriptionKey: message])
    }
    // No shell interpolation, blocking work on the main thread, inherited API keys,
    // or model-initiated file/network tools. Pipes cannot fill with verbose output.
    private func run(_ arguments: [String], input: String = "", timeout: TimeInterval = 300, generation: Int? = nil) throws -> (Int32, String, String) {
        guard let path = executable else { throw failure("Install Codex CLI, then connect your ChatGPT account in Settings.") }
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent("arxiv-recommend-" + UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        defer { try? FileManager.default.removeItem(at: folder) }
        let outputURL = folder.appendingPathComponent("stdout"), errorURL = folder.appendingPathComponent("stderr")
        FileManager.default.createFile(atPath: outputURL.path, contents: nil)
        FileManager.default.createFile(atPath: errorURL.path, contents: nil)
        let output = try FileHandle(forWritingTo: outputURL), errors = try FileHandle(forWritingTo: errorURL)
        defer { try? output.close(); try? errors.close() }
        let inputURL = folder.appendingPathComponent("input")
        try Data(input.utf8).write(to: inputURL)
        let stdin = try FileHandle(forReadingFrom: inputURL)
        defer { try? stdin.close() }
        let process = Process()
        process.executableURL = URL(fileURLWithPath: path)
        process.arguments = arguments
        process.currentDirectoryURL = folder
        var environment = ProcessInfo.processInfo.environment
        environment["PATH"] = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
        for key in ["OPENAI_API_KEY", "CODEX_API_KEY", "OPENAI_BASE_URL", "CODEX_THREAD_ID"] { environment.removeValue(forKey: key) }
        process.environment = environment
        process.standardInput = stdin; process.standardOutput = output; process.standardError = errors
        lock.lock()
        if stopping || (generation != nil && generation != cancellationGeneration) { lock.unlock(); throw failure("Review cancelled.") }
        do { try process.run(); active = process; lock.unlock() }
        catch { lock.unlock(); throw error }
        let deadline = DispatchWorkItem { if process.isRunning { process.terminate() } }
        DispatchQueue.global().asyncAfter(deadline: .now() + timeout, execute: deadline)
        defer { deadline.cancel(); lock.lock(); active = nil; lock.unlock() }
        process.waitUntilExit()
        let stdout = String(data: (try? Data(contentsOf: outputURL)) ?? Data(), encoding: .utf8) ?? ""
        let stderr = String(data: (try? Data(contentsOf: errorURL)) ?? Data(), encoding: .utf8) ?? ""
        return (process.terminationStatus, stdout, stderr)
    }
    // Read public account metadata through Codex's protocol; never read auth files.
    private func accountSnapshot() throws -> [String: Any] {
        guard let path = executable else { throw failure("Codex CLI is unavailable.") }
        let process = Process(), input = Pipe(), output = Pipe()
        process.executableURL = URL(fileURLWithPath: path)
        process.arguments = ["app-server"]
        var environment = ProcessInfo.processInfo.environment
        environment["PATH"] = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
        for key in ["OPENAI_API_KEY", "CODEX_API_KEY", "OPENAI_BASE_URL", "CODEX_THREAD_ID"] { environment.removeValue(forKey: key) }
        process.environment = environment
        process.standardInput = input; process.standardOutput = output; process.standardError = FileHandle.nullDevice
        lock.lock()
        if stopping { lock.unlock(); throw failure("Reader is closing.") }
        do { try process.run(); active = process; lock.unlock() } catch { lock.unlock(); throw error }
        let deadline = DispatchWorkItem { if process.isRunning { process.terminate() } }
        DispatchQueue.global().asyncAfter(deadline: .now() + 25, execute: deadline)
        defer {
            deadline.cancel(); try? input.fileHandleForWriting.close()
            if process.isRunning { process.terminate() }; process.waitUntilExit()
            try? output.fileHandleForReading.close()
            lock.lock(); active = nil; lock.unlock()
        }
        func rpc(_ id: Int, _ method: String, _ params: Any) throws -> [String: Any] {
            var data = try JSONSerialization.data(withJSONObject: ["id": id, "method": method, "params": params])
            data.append(10); try input.fileHandleForWriting.write(contentsOf: data)
            var line = Data(), total = 0
            while total < 2 * 1024 * 1024 {
                guard let byte = try output.fileHandleForReading.read(upToCount: 1), !byte.isEmpty else { break }
                total += 1
                if byte[0] != 10 { line.append(byte); continue }
                defer { line.removeAll(keepingCapacity: true) }
                guard let value = try? JSONSerialization.jsonObject(with: line) as? [String: Any], value["id"] as? Int == id else { continue }
                guard let result = value["result"] as? [String: Any] else { throw failure("Codex could not read account usage. Check connection and try again.") }
                return result
            }
            throw failure("Codex account usage is unavailable. No review was started.")
        }
        _ = try rpc(1, "initialize", ["clientInfo": ["name": "arxiv_reader", "version": "0.1.0"]])
        let accountResult = try rpc(2, "account/read", ["refreshToken": false])
        guard let account = accountResult["account"] as? [String: Any], account["type"] as? String == "chatgpt" else { throw failure("Connect a ChatGPT account through Codex first.") }
        var result: [String: Any] = ["account": account, "accountKey": accountResult["userId"] as? String ?? ((account["email"] as? String ?? "unknown") + "|" + (account["workspaceName"] as? String ?? ""))]
        // Preserve account identity even if the usage endpoint is temporarily unavailable.
        if let limits = try? rpc(3, "account/rateLimits/read", NSNull()) {
            result["ordinaryUsageAllowed"] = limits["ordinaryUsageAllowed"]
            let buckets = limits["rateLimitsByLimitId"] as? [String: [String: Any]]
            let snapshots = buckets?.isEmpty == false ? buckets! : ["codex": limits["rateLimits"] as? [String: Any] ?? [:]]
            let windows = snapshots.flatMap { key, snapshot in [snapshot["primary"], snapshot["secondary"]].compactMap { value -> [String: Any]? in
                guard var window = value as? [String: Any] else { return nil }; window["bucket"] = key; return window
            } }
                .filter { ($0["windowDurationMins"] as? Int) == 300 }
            // Use the most-used five-hour bucket: a conservative guard across models.
            if !windows.isEmpty, windows.allSatisfy({ window in
                guard let used = window["usedPercent"] as? Double, used.isFinite, (0...100).contains(used),
                      let reset = window["resetsAt"] as? Double else { return false }
                return reset > Date().timeIntervalSince1970
            }), let window = windows.max(by: { ($0["usedPercent"] as! Double) < ($1["usedPercent"] as! Double) }) {
                result["fiveHourUsage"] = window
                result["fiveHourWindows"] = windows
            }
        }
        return result
    }
    private struct TokenEntry: Codable {
        var id: String
        var account: String
        var at: Double
        var input: Int
        var output: Int
        var reported: Bool
    }
    private func tokenEntries() throws -> [TokenEntry] {
        let file = directory.appendingPathComponent("recommendation-token-budget.json")
        guard FileManager.default.fileExists(atPath: file.path) else { return [] }
        let entries = try JSONDecoder().decode([TokenEntry].self, from: Data(contentsOf: file))
        guard entries.allSatisfy({ $0.at.isFinite && $0.input >= 0 && $0.output >= 0 && $0.input <= 1_000_000_000 && $0.output <= 1_000_000_000 }) else { throw failure("Could not read the review token ledger.") }
        return entries.filter { $0.at > Date().timeIntervalSince1970 - 5 * 3600 }
    }
    private func saveTokens(_ entries: [TokenEntry]) throws {
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        try JSONEncoder().encode(entries).write(to: directory.appendingPathComponent("recommendation-token-budget.json"), options: [.atomic])
    }
    private func tokenSummary(_ account: String) throws -> [String: Any] {
        let entries = try tokenEntries().filter { $0.account == account }
        return ["inputTokens": entries.reduce(0) { $0 + $1.input }, "outputTokens": entries.reduce(0) { $0 + $1.output },
                "totalTokens": entries.reduce(0) { $0 + $1.input + $1.output }, "unreportedAttempts": entries.filter { !$0.reported }.count]
    }
    private func status() throws -> [String: Any] {
        guard executable != nil else { return ["available": false, "connected": false, "message": "Install Codex CLI to use your ChatGPT account."] }
        let (code, out, err) = try run(["login", "status"], timeout: 15)
        let connected = code == 0 && (out + err).contains("Logged in using ChatGPT")
        var result: [String: Any] = ["available": true, "connected": connected, "models": models(), "usage": usage(), "message": connected ? "Connected through Codex · uses your ChatGPT plan limits" : "Connect a ChatGPT account through Codex. API-key billing is not used."]
        if connected, let snapshot = try? accountSnapshot() {
            result.merge(snapshot) { _, new in new }
            if let account = snapshot["accountKey"] as? String, let tokens = try? tokenSummary(account) { result["reviewTokenUsage"] = tokens }
        }
        return result
    }
    func handle(operation: String, body: [String: Any], reply: @escaping (Any?, String?) -> Void) {
        lock.lock(); let generation = cancellationGeneration; lock.unlock()
        queue.async { [self] in
            do {
                let result: Any
                switch operation {
                case "recommendationStatus": result = try status()
                case "recommendationLogin":
                    if (try status())["connected"] as? Bool != true {
                        let (code, _, _) = try run(["login"], timeout: 240)
                        guard code == 0 else { throw failure("ChatGPT sign-in did not complete. Try connecting again in Settings.") }
                    }
                    result = try status()
                default:
                    guard let instructions = body["instructions"] as? String, instructions.utf8.count <= 50000,
                          let prompt = body["prompt"] as? String, prompt.utf8.count <= 500000 else { throw failure("The recommendation request is too large.") }
                    guard let data = prompt.data(using: .utf8),
                          let request = try JSONSerialization.jsonObject(with: data) as? [String: Any],
                          let papers = request["papers"] as? [[String: Any]], !papers.isEmpty, papers.count <= 30 else { throw failure("The review batch has no valid papers.") }
                    let ids = papers.compactMap { $0["id"] as? String }
                    guard ids.count == papers.count, Set(ids).count == ids.count else { throw failure("The review batch has invalid paper IDs.") }
                    let snapshot = try accountSnapshot()
                    guard let account = snapshot["accountKey"] as? String, !account.hasPrefix("unknown") else { throw failure("Connect a ChatGPT account before reviewing papers.") }
                    let limit = body["reviewTokenLimit"] as? Int ?? 200_000
                    guard (1...10_000_000).contains(limit) else { throw failure("Choose a review token budget between 1 and 10,000,000 in Settings.") }
                    let tokens = try tokenSummary(account)
                    guard (tokens["totalTokens"] as? Int ?? 0) < limit else { throw failure("Paper-review token budget reached (\(tokens["totalTokens"] ?? 0) / \(limit) tokens in the last five hours). Wait for older usage to expire or change the token budget in Settings.") }
                    guard snapshot["ordinaryUsageAllowed"] as? Bool != false else { throw failure("Your account's included usage is unavailable. Review paused.") }
                    guard let model = body["model"] as? String,
                          model.range(of: #"^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$"#, options: .regularExpression) != nil,
                          let dailyLimit = body["dailyBatchLimit"] as? Int, (1...100).contains(dailyLimit) else { throw failure("Choose a model and daily batch limit in Settings.") }
                    var dailyUsage = usage()
                    let used = dailyUsage["batches"] as? Int ?? 0
                    guard used < dailyLimit else { throw failure("Daily batch limit reached. Completed work is saved. Resume another day or change the limit in Settings.") }
                    // Reserve durably before execution, including failed/interrupted requests.
                    dailyUsage["batches"] = used + 1
                    try saveUsage(dailyUsage)
                    let schema: [String: Any] = ["type": "object", "properties": ["recommendations": ["type": "array", "items": ["type": "object", "properties": ["id": ["type": "string", "enum": ids], "kind": ["type": "string", "enum": ["direct", "adjacent"]], "reason": ["type": "string", "minLength": 1, "maxLength": 1600]], "required": ["id", "kind", "reason"], "additionalProperties": false]]], "required": ["recommendations"], "additionalProperties": false]
                    let schemaURL = FileManager.default.temporaryDirectory.appendingPathComponent("arxiv-schema-" + UUID().uuidString + ".json")
                    try JSONSerialization.data(withJSONObject: schema).write(to: schemaURL, options: [.atomic])
                    defer { try? FileManager.default.removeItem(at: schemaURL) }
                    let encoded = try JSONSerialization.data(withJSONObject: [instructions], options: [.withoutEscapingSlashes])
                    let quoted = String(String(data: encoded, encoding: .utf8)!.dropFirst().dropLast())
                    let args = ["exec", "--model", model, "--json", "--ignore-user-config", "--ephemeral", "--skip-git-repo-check", "--sandbox", "read-only", "--color", "never", "--output-schema", schemaURL.path,
                        "-c", "developer_instructions=" + quoted, "-c", "web_search=\"disabled\"", "-c", "model_reasoning_effort=\"low\"",
                        "-c", "features.shell_tool=false", "-c", "features.plugins=false", "-c", "features.apps=false", "-c", "features.multi_agent=false",
                        "-c", "features.computer_use=false", "-c", "features.browser_use=false", "-c", "features.code_mode=false", "-c", "features.image_generation=false",
                        "-c", "features.memories=false", "-c", "features.hooks=false", "-c", "features.skill_search=false", "-"]
                    var entries = try tokenEntries()
                    let attemptID = UUID().uuidString
                    entries.append(TokenEntry(id: attemptID, account: account, at: Date().timeIntervalSince1970, input: 0, output: 0, reported: false))
                    try saveTokens(entries)
                    let (code, out, _) = try run(args, input: prompt, generation: generation)
                    var finalMessage = "", batchInput = 0, batchOutput = 0, reported = false
                    for line in out.split(separator: "\n") {
                        guard let data = String(line).data(using: .utf8), let event = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { continue }
                        if event["type"] as? String == "item.completed", let item = event["item"] as? [String: Any], item["type"] as? String == "agent_message", let text = item["text"] as? String { finalMessage = text }
                        if event["type"] as? String == "turn.completed", let tokens = event["usage"] as? [String: Any] {
                            if let input = tokens["input_tokens"] as? Int, let output = tokens["output_tokens"] as? Int, (0...1_000_000_000).contains(input), (0...1_000_000_000).contains(output) {
                                batchInput += input; batchOutput += output; reported = true
                            }
                        }
                    }
                    if let index = entries.firstIndex(where: { $0.id == attemptID }) {
                        entries[index].input = batchInput; entries[index].output = batchOutput
                        entries[index].reported = reported; entries[index].at = Date().timeIntervalSince1970
                    }
                    try saveTokens(entries)
                    dailyUsage["inputTokens"] = (dailyUsage["inputTokens"] as? Int ?? 0) + batchInput
                    dailyUsage["outputTokens"] = (dailyUsage["outputTokens"] as? Int ?? 0) + batchOutput
                    try saveUsage(dailyUsage)
                    guard code == 0 else { throw failure("ChatGPT could not finish this batch. Completed batches are saved. Check your connection and usage limits, then click Review day to resume.") }
                    guard finalMessage.utf8.count <= 2 * 1024 * 1024, let data = finalMessage.data(using: .utf8), var object = try JSONSerialization.jsonObject(with: data) as? [String: Any], object["recommendations"] is [[String: Any]] else { throw failure("ChatGPT returned an unreadable review. Completed batches are saved.") }
                    object["dailyUsage"] = dailyUsage; object["model"] = model; object["reviewTokenUsage"] = try tokenSummary(account)
                    result = object
                }
                DispatchQueue.main.async { reply(result, nil) }
            } catch { DispatchQueue.main.async { reply(nil, error.localizedDescription) } }
        }
    }
}
