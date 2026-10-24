import AppKit
import WebKit

// All data comes from the local bundle. Remote HTML is fetched as text and is
// parsed by DOMParser; it is never navigated to or executed inside the web view.
final class Resources: NSObject, WKURLSchemeHandler {
    let root: URL
    init(root: URL) { self.root = root.standardizedFileURL }
    func webView(_ webView: WKWebView, start task: WKURLSchemeTask) {
        guard let url = task.request.url else { return }
        let relative = url.path == "/" ? "index.html" : String(url.path.dropFirst())
        let file = root.appendingPathComponent(relative).standardizedFileURL
        guard file.path.hasPrefix(root.path + "/"), let data = try? Data(contentsOf: file) else {
            task.didFailWithError(NSError(domain: "arxiv", code: 404, userInfo: [NSLocalizedDescriptionKey: "Resource not found"]))
            return
        }
        let mime: String
        switch file.pathExtension {
        case "html": mime = "text/html"
        case "js": mime = "application/javascript"
        case "css": mime = "text/css"
        case "svg": mime = "image/svg+xml"
        case "png": mime = "image/png"
        default: mime = "application/octet-stream"
        }
        task.didReceive(URLResponse(url: url, mimeType: mime, expectedContentLength: data.count, textEncodingName: "utf-8"))
        task.didReceive(data)
        task.didFinish()
    }
    func webView(_ webView: WKWebView, stop task: WKURLSchemeTask) {}
}

typealias Reply = (Any?, String?) -> Void
final class ArxivNetwork {
    private var queue: [(URL, Reply)] = []
    private var busy = false
    private var lastStart = Date.distantPast
    private let session: URLSession = {
        let config = URLSessionConfiguration.default
        config.timeoutIntervalForRequest = 45
        config.timeoutIntervalForResource = 60
        config.httpMaximumConnectionsPerHost = 1
        config.urlCache = nil
        return URLSession(configuration: config)
    }()
    func fetch(path: String, reply: @escaping Reply) {
        let listing = #"^/list/[a-z][a-z0-9-]*(?:\.[A-Z]{2})?/recent\?skip=[0-9]+&show=2000$"#
        let catchup = #"^/catchup/[a-z][a-z0-9-]*(?:\.[A-Z]{2})?/[0-9]{4}-[0-9]{2}-[0-9]{2}\?abs=True&page=[1-9][0-9]*$"#
        let abstract = #"^/abs/(?:[0-9]{4}\.[0-9]{4,5}|[a-z-]+(?:\.[A-Z]{2})?/[0-9]{7})(?:v[0-9]+)?$"#
        guard path.range(of: catchup, options: .regularExpression) != nil || path.range(of: listing, options: .regularExpression) != nil || path.range(of: abstract, options: .regularExpression) != nil,
              let url = URL(string: "https://arxiv.org" + path) else {
            reply(nil, "Unsupported arXiv request."); return
        }
        queue.append((url, reply))
        drain()
    }
    private func drain() {
        guard !busy, !queue.isEmpty else { return }
        busy = true
        let (url, reply) = queue.removeFirst()
        // Respect arXiv's request spacing, including category switches and abstracts.
        let delay = max(0, 3 - Date().timeIntervalSince(lastStart))
        DispatchQueue.main.asyncAfter(deadline: .now() + delay) { [self] in
            lastStart = Date()
            var request = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData)
            request.setValue("arxiv-reader/0.1 (personal desktop reader; https://github.com/YazidJanati/arxiv)", forHTTPHeaderField: "User-Agent")
            request.setValue("text/html", forHTTPHeaderField: "Accept")
            session.dataTask(with: request) { [self] data, response, error in
                DispatchQueue.main.async { [self] in
                    defer { busy = false; drain() }
                    if let error = error { reply(nil, "Could not reach arXiv. \(error.localizedDescription)"); return }
                    guard let response = response as? HTTPURLResponse else { reply(nil, "Invalid response from arXiv."); return }
                    guard response.statusCode == 200 else {
                        let message = response.statusCode == 404
                            ? "arXiv could not find this section. Check the category code in Settings."
                            : "arXiv is unavailable (HTTP \(response.statusCode)). Try refreshing in a moment."
                        reply(nil, message); return
                    }
                    guard let data = data, data.count <= 32 * 1024 * 1024, let html = String(data: data, encoding: .utf8) else {
                        reply(nil, "arXiv returned an unreadable response."); return
                    }
                    reply(html, nil)
                }
            }.resume()
        }
    }
}

final class Bridge: NSObject, WKScriptMessageHandlerWithReply {
    private let network = ArxivNetwork()
    private let directory: URL
    init(directory: URL) { self.directory = directory }
    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage, replyHandler reply: @escaping Reply) {
        guard message.frameInfo.isMainFrame, message.frameInfo.request.url?.scheme == "arxiv-app",
              let body = message.body as? [String: Any], let operation = body["operation"] as? String else {
            reply(nil, "Unsupported message."); return
        }
        do {
            switch operation {
            case "fetch":
                guard let path = body["path"] as? String else { reply(nil, "Missing path."); return }
                network.fetch(path: path, reply: reply)
            case "cacheKeys":
                guard FileManager.default.fileExists(atPath: directory.path) else { reply([], nil); return }
                let keys = try FileManager.default.contentsOfDirectory(atPath: directory.path)
                    .filter { $0.hasSuffix(".json") }
                    .map { String($0.dropLast(5)) }
                    .filter { $0.hasPrefix("day-v2-") || $0.hasPrefix("feed-") || $0.hasPrefix("abstract-") }
                reply(keys, nil)
            case "removeCache":
                guard let key = body["key"] as? String,
                      key.range(of: #"^(day-v2-|feed-|abstract-)[A-Za-z0-9._-]+$"#, options: .regularExpression) != nil else {
                    reply(nil, "Only disposable paper caches can be removed."); return
                }
                let file = directory.appendingPathComponent(key + ".json")
                if FileManager.default.fileExists(atPath: file.path) { try FileManager.default.removeItem(at: file) }
                reply(NSNull(), nil)
            case "read", "write":
                guard let key = body["key"] as? String, key.range(of: #"^[A-Za-z0-9._-]{1,150}$"#, options: .regularExpression) != nil else {
                    reply(nil, "Invalid storage key."); return
                }
                let file = directory.appendingPathComponent(key + ".json")
                if operation == "read" {
                    guard FileManager.default.fileExists(atPath: file.path) else { reply(NSNull(), nil); return }
                    let data = try Data(contentsOf: file)
                    reply(try JSONSerialization.jsonObject(with: data, options: [.fragmentsAllowed]), nil)
                } else {
                    guard let value = body["value"] else { reply(nil, "Missing value."); return }
                    let data = try JSONSerialization.data(withJSONObject: value, options: [.fragmentsAllowed, .sortedKeys])
                    guard data.count <= 16 * 1024 * 1024 else { reply(nil, "Local record is too large."); return }
                    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
                    try data.write(to: file, options: [.atomic])
                    reply(NSNull(), nil)
                }
            case "open":
                guard let value = body["url"] as? String, let url = URL(string: value), url.scheme == "https",
                      url.host == "arxiv.org", url.user == nil, url.password == nil else { reply(nil, "Only arXiv links can be opened."); return }
                if NSWorkspace.shared.open(url) { reply(NSNull(), nil) } else { reply(nil, "Could not open your browser.") }
            case "appearance":
                switch body["theme"] as? String {
                case "dark": NSApp.appearance = NSAppearance(named: .darkAqua)
                case "light": NSApp.appearance = NSAppearance(named: .aqua)
                default: NSApp.appearance = nil
                }
                reply(NSNull(), nil)
            default: reply(nil, "Unknown operation.")
            }
        } catch { reply(nil, error.localizedDescription) }
    }
}

final class AppDelegate: NSObject, NSApplicationDelegate, WKNavigationDelegate, NSWindowDelegate {
    private var window: NSWindow!
    private var webView: WKWebView!
    private var bridge: Bridge!
    private var resources: Resources!
    private var quitting = false
    private var support: URL {
        FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent("arxiv-reader", isDirectory: true)
    }
    func applicationDidFinishLaunching(_ notification: Notification) {
        URLCache.shared.removeAllCachedResponses()
        NSApp.setActivationPolicy(.regular)
        NSApp.appearance = NSAppearance(named: .darkAqua)
        buildMenu()
        let config = WKWebViewConfiguration()
        config.preferences.javaScriptCanOpenWindowsAutomatically = false
        resources = Resources(root: Bundle.main.resourceURL!.appendingPathComponent("web"))
        config.setURLSchemeHandler(resources, forURLScheme: "arxiv-app")
        bridge = Bridge(directory: support)
        config.userContentController.addScriptMessageHandler(bridge, contentWorld: .page, name: "arxiv")
        webView = WKWebView(frame: .zero, configuration: config)
        webView.navigationDelegate = self
        webView.allowsBackForwardNavigationGestures = false
        webView.setValue(false, forKey: "drawsBackground")
        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1120, height: 780), styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
        window.title = "arxiv"
        window.minSize = NSSize(width: 560, height: 380)
        window.backgroundColor = NSColor(calibratedWhite: 0.118, alpha: 1)
        window.contentView = webView
        window.delegate = self
        window.isReleasedWhenClosed = false
        window.setFrameAutosaveName("arxiv-main")
        if !window.setFrameUsingName("arxiv-main") { window.center() }
        webView.load(URLRequest(url: URL(string: "arxiv-app://reader/index.html")!))
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        if ProcessInfo.processInfo.arguments.contains("--smoke-test") { runSmokeTest() }
    }
    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        if !flag { window.makeKeyAndOrderFront(nil) }; return true
    }
    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        if navigationAction.request.url?.scheme == "arxiv-app" { decisionHandler(.allow) }
        else { decisionHandler(.cancel) }
    }
    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        if quitting { return .terminateNow }
        // callAsyncJavaScript awaits the frontend save queue before responding.
        webView.callAsyncJavaScript("return window.arxivBeforeQuit ? await window.arxivBeforeQuit() : true", arguments: [:], in: nil, in: .page) { result in
            let saved: Bool
            if case .success(let value) = result { saved = (value as? Bool) ?? false } else { saved = false }
            if saved { self.quitting = true; NSApp.reply(toApplicationShouldTerminate: true) }
            else {
                let alert = NSAlert()
                alert.messageText = "Your changes haven’t been saved."
                alert.informativeText = "Return to the app and use Retry save, or quit without saving the latest changes."
                alert.addButton(withTitle: "Keep open")
                alert.addButton(withTitle: "Quit without saving")
                let quit = alert.runModal() == .alertSecondButtonReturn
                self.quitting = quit
                NSApp.reply(toApplicationShouldTerminate: quit)
            }
        }
        return .terminateLater
    }
    @objc private func command(_ sender: NSMenuItem) {
        guard let command = sender.representedObject as? String else { return }
        let data = try! JSONSerialization.data(withJSONObject: [command])
        let argument = String(data: data, encoding: .utf8)!
        webView.evaluateJavaScript("window.arxivCommand?.(...\(argument))", completionHandler: nil)
    }
    private func item(_ title: String, command name: String, key: String) -> NSMenuItem {
        let menu = NSMenuItem(title: title, action: #selector(command(_:)), keyEquivalent: key)
        menu.target = self; menu.representedObject = name; return menu
    }
    private func buildMenu() {
        let main = NSMenu()
        let app = NSMenu()
        app.addItem(withTitle: "About arxiv", action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)), keyEquivalent: "")
        app.addItem(.separator())
        app.addItem(item("Settings…", command: "settings", key: ","))
        app.addItem(.separator())
        app.addItem(withTitle: "Hide arxiv", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
        app.addItem(withTitle: "Hide Others", action: #selector(NSApplication.hideOtherApplications(_:)), keyEquivalent: "h").keyEquivalentModifierMask = [.command, .option]
        app.addItem(withTitle: "Show All", action: #selector(NSApplication.unhideAllApplications(_:)), keyEquivalent: "")
        app.addItem(.separator())
        app.addItem(withTitle: "Quit arxiv", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        let appItem = NSMenuItem(); appItem.submenu = app; main.addItem(appItem)
        let edit = NSMenu(title: "Edit")
        for (title, action, key) in [("Undo", "undo:", "z"), ("Redo", "redo:", "Z"), ("Cut", "cut:", "x"), ("Copy", "copy:", "c"), ("Paste", "paste:", "v"), ("Select All", "selectAll:", "a")] {
            edit.addItem(withTitle: title, action: Selector(action), keyEquivalent: key)
        }
        edit.addItem(.separator()); edit.addItem(item("Find…", command: "search", key: "f"))
        let editItem = NSMenuItem(); editItem.submenu = edit; main.addItem(editItem)
        let view = NSMenu(title: "View")
        view.addItem(item("Toggle Sidebar", command: "sidebar", key: "b"))
        view.addItem(item("Refresh Papers", command: "refresh", key: "r"))
        let viewItem = NSMenuItem(); viewItem.submenu = view; main.addItem(viewItem)
        let windowMenu = NSMenu(title: "Window")
        windowMenu.addItem(withTitle: "Minimize", action: #selector(NSWindow.performMiniaturize(_:)), keyEquivalent: "m")
        windowMenu.addItem(withTitle: "Zoom", action: #selector(NSWindow.performZoom(_:)), keyEquivalent: "")
        let windowItem = NSMenuItem(); windowItem.submenu = windowMenu; main.addItem(windowItem)
        NSApp.windowsMenu = windowMenu; NSApp.mainMenu = main
    }
    // Exercised against the installed binary: real WebKit, real arXiv, native
    // messaging and disk persistence. Logs are kept out of normal app launches.
    private func runSmokeTest() {
        let script = #"""
        const wait = async (predicate, timeout = 90000) => {
          const start = Date.now();
          while (!predicate()) { if (Date.now() - start > timeout) throw new Error('Timed out waiting for UI'); await new Promise(r => setTimeout(r, 100)); }
        };
        await wait(() => document.querySelectorAll('[data-day]').length === 7);
        const weekdays = [...document.querySelectorAll('[data-day]')].filter(b => !['Saturday','Sunday'].some(d => b.textContent.includes(d)) && b.dataset.day <= new Date().toLocaleDateString('en-CA'));
        const day = weekdays.at(-1);
        if (!day) throw new Error('No eligible weekday');
        day.click();
        document.querySelector(`[data-date="${day.dataset.day}"][data-category="cs.LG"]`).click();
        await wait(() => document.querySelectorAll('.paper').length > 0 && document.querySelector('#reader').getAttribute('aria-busy') === 'false');
        const count = document.querySelectorAll('.paper').length;
        document.querySelector('.paper-title').click();
        await wait(() => document.querySelector('.abstract p')?.textContent.length > 100);
        const title = document.querySelector('.paper-title').textContent;
        const data = await window.webkit.messageHandlers.arxiv.postMessage({operation:'read',key:'state'});
        return { count, title, abstract: document.querySelector('.abstract p').textContent.slice(0,100), persistedStateReadable: data === null || typeof data === 'object' };
        """#
        DispatchQueue.main.asyncAfter(deadline: .now() + 2) { [self] in
            webView.callAsyncJavaScript(script, arguments: [:], in: nil, in: .page) { result in
                let output: String
                switch result {
                case .success(let value): output = "PASS \(value)"
                case .failure(let error): output = "FAIL \(error)"
                }
                let target = FileManager.default.temporaryDirectory.appendingPathComponent("arxiv-smoke-test.txt")
                try? output.write(to: target, atomically: true, encoding: .utf8)
                NSLog("arxiv smoke: %@", output)
            }
        }
    }
}
let application = NSApplication.shared
let delegate = AppDelegate()
application.delegate = delegate
application.run()
