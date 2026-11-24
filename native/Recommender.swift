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
    private var executable: String? {
        if let path = executableOverride?.path { return FileManager.default.isExecutableFile(atPath: path) ? path : nil }
        let candidates = ["/opt/homebrew/bin/codex", "/usr/local/bin/codex", "/Applications/Codex.app/Contents/Resources/codex"]
        return candidates.first { FileManager.default.isExecutableFile(atPath: $0) }
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
    private func status() throws -> [String: Any] {
        guard executable != nil else { return ["available": false, "connected": false, "message": "Install Codex CLI to use your ChatGPT account."] }
        let (code, out, err) = try run(["login", "status"], timeout: 15)
        let connected = code == 0 && (out + err).contains("Logged in using ChatGPT")
        return ["available": true, "connected": connected, "models": models(), "usage": usage(), "message": connected ? "Connected through Codex · uses your ChatGPT plan limits" : "Connect a ChatGPT account through Codex. API-key billing is not used."]
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
                    guard (try status())["connected"] as? Bool == true else { throw failure("Connect your ChatGPT account in Settings before reviewing papers.") }
                    guard let model = body["model"] as? String,
                          model.range(of: #"^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$"#, options: .regularExpression) != nil,
                          let dailyLimit = body["dailyBatchLimit"] as? Int, (1...100).contains(dailyLimit) else { throw failure("Choose a model and daily batch limit in Settings.") }
                    var dailyUsage = usage()
                    let used = dailyUsage["batches"] as? Int ?? 0
                    guard used < dailyLimit else { throw failure("Daily batch limit reached. Completed work is saved. Resume another day or change the limit in Settings.") }
                    // Reserve durably before execution, including failed/interrupted requests.
                    dailyUsage["batches"] = used + 1
                    try saveUsage(dailyUsage)
                    let schema: [String: Any] = ["type": "object", "properties": ["recommendations": ["type": "array", "items": ["type": "object", "properties": ["id": ["type": "string"], "kind": ["type": "string", "enum": ["direct", "adjacent"]], "reason": ["type": "string"]], "required": ["id", "kind", "reason"], "additionalProperties": false]]], "required": ["recommendations"], "additionalProperties": false]
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
                    let (code, out, _) = try run(args, input: prompt, generation: generation)
                    var finalMessage = ""
                    for line in out.split(separator: "\n") {
                        guard let data = String(line).data(using: .utf8), let event = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { continue }
                        if event["type"] as? String == "item.completed", let item = event["item"] as? [String: Any], item["type"] as? String == "agent_message", let text = item["text"] as? String { finalMessage = text }
                        if event["type"] as? String == "turn.completed", let tokens = event["usage"] as? [String: Any] {
                            dailyUsage["inputTokens"] = (dailyUsage["inputTokens"] as? Int ?? 0) + (tokens["input_tokens"] as? Int ?? 0)
                            dailyUsage["outputTokens"] = (dailyUsage["outputTokens"] as? Int ?? 0) + (tokens["output_tokens"] as? Int ?? 0)
                        }
                    }
                    try saveUsage(dailyUsage)
                    guard code == 0 else { throw failure("ChatGPT could not finish this batch. Completed batches are saved. Check your connection and usage limits, then click Review day to resume.") }
                    guard finalMessage.utf8.count <= 2 * 1024 * 1024, let data = finalMessage.data(using: .utf8), var object = try JSONSerialization.jsonObject(with: data) as? [String: Any], object["recommendations"] is [[String: Any]] else { throw failure("ChatGPT returned an unreadable review. Completed batches are saved.") }
                    object["dailyUsage"] = dailyUsage; object["model"] = model
                    result = object
                }
                DispatchQueue.main.async { reply(result, nil) }
            } catch { DispatchQueue.main.async { reply(nil, error.localizedDescription) } }
        }
    }
}
