import AppKit
import Darwin
import Foundation

private let agBundleID = "com.google.antigravity"
private let fuseSentinel = Data("dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX".utf8)

private let homeURL = FileManager.default.homeDirectoryForCurrentUser
private let dataDirURL = homeURL.appendingPathComponent(".antigravity-zh")
private let configFileURL = dataDirURL.appendingPathComponent("config.json")
private let runtimeStateURL = dataDirURL.appendingPathComponent("runtime-state.json")
private let deployedHookURL = dataDirURL.appendingPathComponent("app/runtime/main-hook.js")
private let devToolsPortURL = homeURL.appendingPathComponent("Library/Application Support/Antigravity/DevToolsActivePort")
private let logFileURL = homeURL.appendingPathComponent("Library/Logs/antigravity-zh.log")

final class Box<T>: @unchecked Sendable {
    var value: T
    init(_ value: T) { self.value = value }
}

enum LauncherError: LocalizedError {
    case message(String)
    var errorDescription: String? {
        switch self {
        case .message(let text): return text
        }
    }
}

func appendLog(_ message: String) {
    let dir = logFileURL.deletingLastPathComponent()
    try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    let ts = ISO8601DateFormatter().string(from: Date())
    let line = "[\(ts)] [launcher] \(message)\n"
    guard let data = line.data(using: .utf8) else { return }
    if FileManager.default.fileExists(atPath: logFileURL.path),
       let handle = try? FileHandle(forWritingTo: logFileURL) {
        defer { try? handle.close() }
        _ = try? handle.seekToEnd()
        try? handle.write(contentsOf: data)
    } else {
        try? data.write(to: logFileURL, options: .atomic)
    }
}

@MainActor
@discardableResult
func showAlert(title: String, message: String, style: NSAlert.Style = .informational, buttons: [String] = ["好"]) -> NSApplication.ModalResponse {
    let app = NSApplication.shared
    app.setActivationPolicy(.accessory)
    app.activate()
    let alert = NSAlert()
    alert.alertStyle = style
    alert.messageText = title
    alert.informativeText = message
    if let iconPath = Bundle.main.path(forResource: "icon", ofType: "icns"),
       let img = NSImage(contentsOfFile: iconPath) {
        alert.icon = img
    }
    for title in buttons {
        alert.addButton(withTitle: title)
    }
    return alert.runModal()
}

func findAntigravityApp() -> URL? {
    let candidates = [
        URL(fileURLWithPath: "/Applications/Antigravity.app"),
        homeURL.appendingPathComponent("Applications/Antigravity.app")
    ]
    return candidates.first { FileManager.default.fileExists(atPath: $0.path) }
}

func resolveHookURL() -> URL? {
    if FileManager.default.fileExists(atPath: deployedHookURL.path) {
        return deployedHookURL
    }
    if let repoRoot = Bundle.main.infoDictionary?["AGZHRepoRoot"] as? String {
        let fallback = URL(fileURLWithPath: repoRoot).appendingPathComponent("runtime/main-hook.js")
        if FileManager.default.fileExists(atPath: fallback.path) {
            return fallback
        }
    }
    return nil
}

func readConfiguredEngine() -> String {
    guard let data = try? Data(contentsOf: configFileURL),
          let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
          let engine = json["engine"] as? String,
          !engine.isEmpty else {
        return "auto"
    }
    return engine
}

func isHookActive() -> Bool {
    guard let data = try? Data(contentsOf: runtimeStateURL),
          let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
          let engine = json["engine"] as? String, engine == "hook",
          let pidNum = json["pid"] as? NSNumber else {
        return false
    }
    let pid = pid_t(pidNum.int32Value)
    guard pid > 0 else { return false }
    if kill(pid, 0) == 0 { return true }
    return errno == EPERM
}

func httpGetData(url: URL, timeout: TimeInterval = 1.5) -> Data? {
    let config = URLSessionConfiguration.ephemeral
    config.timeoutIntervalForRequest = timeout
    config.timeoutIntervalForResource = timeout
    let session = URLSession(configuration: config)
    defer { session.invalidateAndCancel() }

    let sem = DispatchSemaphore(value: 0)
    let box = Box<Data?>(nil)
    let task = session.dataTask(with: url) { data, resp, err in
        defer { sem.signal() }
        guard err == nil,
              let http = resp as? HTTPURLResponse,
              http.statusCode == 200 else {
            return
        }
        box.value = data
    }
    task.resume()
    _ = sem.wait(timeout: .now() + timeout + 0.3)
    return box.value
}

func isCdpReachable() -> Bool {
    guard let raw = try? String(contentsOf: devToolsPortURL, encoding: .utf8),
          let firstLine = raw.split(whereSeparator: \.isNewline).first,
          let port = UInt16(firstLine.trimmingCharacters(in: .whitespaces)),
          port > 0,
          let url = URL(string: "http://127.0.0.1:\(port)/json/list"),
          let data = httpGetData(url: url, timeout: 1.5),
          let obj = try? JSONSerialization.jsonObject(with: data),
          obj is [Any] else {
        return false
    }
    return true
}

func runningAntigravityApps() -> [NSRunningApplication] {
    NSRunningApplication.runningApplications(withBundleIdentifier: agBundleID)
}

func openApp(_ appURL: URL, arguments: [String] = []) throws {
    let config = NSWorkspace.OpenConfiguration()
    config.activates = true
    config.createsNewApplicationInstance = false
    config.arguments = arguments

    let sem = DispatchSemaphore(value: 0)
    let errBox = Box<Error?>(nil)
    NSWorkspace.shared.openApplication(at: appURL, configuration: config) { _, err in
        errBox.value = err
        sem.signal()
    }
    if sem.wait(timeout: .now() + 10) == .timedOut {
        throw LauncherError.message("启动 Antigravity.app 超时")
    }
    if let err = errBox.value {
        throw LauncherError.message("无法启动 Antigravity.app: \(err.localizedDescription)")
    }
}

func quitAndWait(_ apps: [NSRunningApplication], timeout: TimeInterval = 10) -> Bool {
    for app in apps where !app.isTerminated {
        app.terminate()
    }
    let deadline = Date().addingTimeInterval(timeout)
    while Date() < deadline {
        let alive = apps.contains(where: { !$0.isTerminated }) || !runningAntigravityApps().isEmpty
        if !alive { return true }
        Thread.sleep(forTimeInterval: 0.15)
    }
    return !apps.contains(where: { !$0.isTerminated }) && runningAntigravityApps().isEmpty
}

func supportsCliInspectFuse(appURL: URL) -> Bool {
    let fwURL = appURL.appendingPathComponent("Contents/Frameworks/Electron Framework.framework/Electron Framework")
    guard let handle = try? FileHandle(forReadingFrom: fwURL) else { return false }
    defer { try? handle.close() }

    let chunkSize = 4 * 1024 * 1024
    let overlap = fuseSentinel.count + 32
    var offset: UInt64 = 0

    while true {
        try? handle.seek(toOffset: offset)
        guard let chunk = try? handle.read(upToCount: chunkSize), !chunk.isEmpty else {
            return false
        }
        if let range = chunk.range(of: fuseSentinel) {
            let abs = offset + UInt64(range.upperBound)
            try? handle.seek(toOffset: abs)
            guard let tail = try? handle.read(upToCount: 32), tail.count >= 2 else {
                return false
            }
            let count = Int(tail[1])
            let flagIndex = 2 + 3
            guard count > 3, tail.count > flagIndex else { return false }
            return tail[flagIndex] == 0x31
        }
        if chunk.count < chunkSize { return false }
        offset += UInt64(chunk.count - overlap)
    }
}

func resolveEngine(configured: String, appURL: URL) throws -> String {
    switch configured {
    case "cdp":
        return "cdp"
    case "hook":
        guard supportsCliInspectFuse(appURL: appURL) else {
            throw LauncherError.message("当前 Antigravity 版本未启用 CLI Inspect Fuse，请将配置 engine 改为 auto 或 cdp")
        }
        return "hook"
    case "auto", "":
        return supportsCliInspectFuse(appURL: appURL) ? "hook" : "cdp"
    default:
        throw LauncherError.message("未知引擎配置: \(configured)")
    }
}

func pickFreePort() throws -> UInt16 {
    let fd = socket(AF_INET, SOCK_STREAM, 0)
    guard fd >= 0 else {
        throw LauncherError.message("创建临时 socket 失败 (errno=\(errno))")
    }
    defer { Darwin.close(fd) }

    var addr = sockaddr_in()
    addr.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
    addr.sin_family = sa_family_t(AF_INET)
    addr.sin_port = 0
    addr.sin_addr.s_addr = inet_addr("127.0.0.1")

    let bindRes = withUnsafePointer(to: &addr) { ptr -> Int32 in
        ptr.withMemoryRebound(to: sockaddr.self, capacity: 1) { saPtr in
            Darwin.bind(fd, saPtr, socklen_t(MemoryLayout<sockaddr_in>.size))
        }
    }
    guard bindRes == 0 else {
        throw LauncherError.message("绑定空闲端口失败 (errno=\(errno))")
    }

    var bound = sockaddr_in()
    var len = socklen_t(MemoryLayout<sockaddr_in>.size)
    let nameRes = withUnsafeMutablePointer(to: &bound) { ptr -> Int32 in
        ptr.withMemoryRebound(to: sockaddr.self, capacity: 1) { saPtr in
            Darwin.getsockname(fd, saPtr, &len)
        }
    }
    guard nameRes == 0 else {
        throw LauncherError.message("读取分配端口失败 (errno=\(errno))")
    }
    let port = UInt16(bigEndian: bound.sin_port)
    guard port > 0 else {
        throw LauncherError.message("分配到无效端口 0")
    }
    return port
}

final class InspectorClient: NSObject, URLSessionWebSocketDelegate, @unchecked Sendable {
    private var session: URLSession!
    private var task: URLSessionWebSocketTask!
    private let openSem = DispatchSemaphore(value: 0)
    private let pausedSem = DispatchSemaphore(value: 0)
    private let lock = NSLock()
    private var seq = 0
    private var closed = false
    private var openError: Error?
    private var pausedSignaled = false
    private var pending: [Int: DispatchSemaphore] = [:]
    private var responses: [Int: [String: Any]] = [:]

    init(wsURL: URL) {
        super.init()
        let config = URLSessionConfiguration.ephemeral
        self.session = URLSession(configuration: config, delegate: self, delegateQueue: nil)
        self.task = self.session.webSocketTask(with: wsURL)
    }

    func open(timeout: TimeInterval = 4) throws {
        task.resume()
        receiveNext()
        if openSem.wait(timeout: .now() + timeout) == .timedOut {
            close()
            throw LauncherError.message("Inspector WebSocket 连接超时")
        }
        if let err = openError {
            close()
            throw LauncherError.message("Inspector WebSocket 连接失败: \(err.localizedDescription)")
        }
    }

    func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask, didOpenWithProtocol protocol: String?) {
        openSem.signal()
    }

    func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask, didCloseWith closeCode: URLSessionWebSocketTask.CloseCode, reason: Data?) {
        failAll()
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        if let err = error {
            lock.lock()
            if openError == nil { openError = err }
            lock.unlock()
        }
        failAll()
    }

    private func failAll() {
        lock.lock()
        closed = true
        let sems = Array(pending.values)
        pending.removeAll()
        lock.unlock()
        openSem.signal()
        for s in sems { s.signal() }
    }

    private func receiveNext() {
        task.receive { [weak self] result in
            guard let self else { return }
            switch result {
            case .success(let message):
                let data: Data?
                switch message {
                case .string(let s): data = s.data(using: .utf8)
                case .data(let d): data = d
                @unknown default: data = nil
                }
                if let d = data,
                   let json = try? JSONSerialization.jsonObject(with: d) as? [String: Any] {
                    if let id = json["id"] as? Int {
                        self.lock.lock()
                        self.responses[id] = json
                        let sem = self.pending.removeValue(forKey: id)
                        self.lock.unlock()
                        sem?.signal()
                    } else if (json["method"] as? String) == "Debugger.paused" {
                        self.lock.lock()
                        let shouldSignal = !self.pausedSignaled
                        self.pausedSignaled = true
                        self.lock.unlock()
                        if shouldSignal { self.pausedSem.signal() }
                    }
                }
                self.receiveNext()
            case .failure:
                self.failAll()
            }
        }
    }

    @discardableResult
    func send(_ method: String, params: [String: Any] = [:], timeout: TimeInterval = 4) -> [String: Any]? {
        lock.lock()
        if closed {
            lock.unlock()
            return nil
        }
        seq += 1
        let id = seq
        let sem = DispatchSemaphore(value: 0)
        pending[id] = sem
        lock.unlock()

        let payload: [String: Any] = ["id": id, "method": method, "params": params]
        guard let data = try? JSONSerialization.data(withJSONObject: payload),
              let text = String(data: data, encoding: .utf8) else {
            lock.lock()
            pending.removeValue(forKey: id)
            lock.unlock()
            return nil
        }

        task.send(.string(text)) { [weak self] err in
            guard err != nil, let self else { return }
            self.lock.lock()
            let s = self.pending.removeValue(forKey: id)
            self.lock.unlock()
            s?.signal()
        }

        _ = sem.wait(timeout: .now() + timeout)
        lock.lock()
        pending.removeValue(forKey: id)
        let resp = responses.removeValue(forKey: id)
        lock.unlock()
        return resp
    }

    func waitPaused(timeout: TimeInterval = 1.5) {
        _ = pausedSem.wait(timeout: .now() + timeout)
    }

    func close() {
        failAll()
        task.cancel(with: .normalClosure, reason: nil)
        session.invalidateAndCancel()
    }

    static func inject(port: UInt16, hookPath: String, timeout: TimeInterval = 8) throws {
        guard let listURL = URL(string: "http://127.0.0.1:\(port)/json/list") else {
            throw LauncherError.message("无效的 Inspector 端口 \(port)")
        }
        let deadline = Date().addingTimeInterval(timeout)
        var wsURL: URL?
        while Date() < deadline {
            if let data = httpGetData(url: listURL, timeout: 0.5),
               let targets = try? JSONSerialization.jsonObject(with: data) as? [[String: Any]] {
                for target in targets {
                    if let s = target["webSocketDebuggerUrl"] as? String, let u = URL(string: s) {
                        wsURL = u
                        break
                    }
                }
            }
            if wsURL != nil { break }
            Thread.sleep(forTimeInterval: 0.04)
        }
        guard let targetWS = wsURL else {
            throw LauncherError.message("等待主进程 Inspector 超时 (端口 \(port))")
        }

        let client = InspectorClient(wsURL: targetWS)
        try client.open()
        defer {
            _ = client.send("Debugger.disable", timeout: 1.5)
            _ = client.send("Debugger.resume", timeout: 1.5)
            _ = client.send("Runtime.runIfWaitingForDebugger", timeout: 1.5)
            client.close()
        }

        _ = client.send("Debugger.enable")
        _ = client.send("Runtime.enable")
        _ = client.send("Runtime.runIfWaitingForDebugger")
        client.waitPaused(timeout: 1.5)

        let argData = try JSONSerialization.data(withJSONObject: [hookPath])
        let argArray = String(data: argData, encoding: .utf8) ?? "[]"
        let hookLiteral = String(argArray.dropFirst().dropLast())
        let expr = """
        (() => {
            const p = \(hookLiteral);
            const m = process.getBuiltinModule ? process.getBuiltinModule('module') : require('module');
            m.createRequire(p)(p);
            return Boolean(globalThis.__agzhMainHooked);
        })()
        """

        guard let resp = client.send("Runtime.evaluate", params: ["expression": expr, "returnByValue": true]) else {
            throw LauncherError.message("执行主进程 Hook 超时或连接断开")
        }
        if let errObj = resp["error"] as? [String: Any] {
            let msg = (errObj["message"] as? String) ?? "Inspector 调用错误"
            throw LauncherError.message(msg)
        }
        guard let resultWrapper = resp["result"] as? [String: Any] else {
            throw LauncherError.message("Inspector 返回格式异常")
        }
        if let exc = resultWrapper["exceptionDetails"] as? [String: Any] {
            let exObj = exc["exception"] as? [String: Any]
            let msg = (exObj?["description"] as? String) ?? (exc["text"] as? String) ?? "主进程 Hook 执行异常"
            throw LauncherError.message(msg)
        }
        let remoteVal = resultWrapper["result"] as? [String: Any]
        guard (remoteVal?["value"] as? Bool) == true else {
            throw LauncherError.message("主进程 Hook 加载未就绪")
        }
    }
}

@MainActor
func runLauncher() {
    do {
        guard let appURL = findAntigravityApp() else {
            _ = showAlert(
                title: "未找到 Antigravity",
                message: "请确认已安装 /Applications/Antigravity.app。",
                style: .critical
            )
            exit(1)
        }

        if isHookActive() || isCdpReachable() {
            try openApp(appURL)
            exit(0)
        }

        let running = runningAntigravityApps()
        if !running.isEmpty {
            let answer = showAlert(
                title: "重启切换为中文版？",
                message: "检测到 Antigravity 正在以官方英文模式运行，是否退出并重新以中文模式启动？",
                style: .warning,
                buttons: ["重启切换", "取消"]
            )
            guard answer == .alertFirstButtonReturn else {
                exit(0)
            }
            guard quitAndWait(running) else {
                _ = showAlert(
                    title: "退出超时",
                    message: "等待 Antigravity 退出超时，请手动退出后重试。",
                    style: .critical
                )
                exit(1)
            }
        }

        let configured = readConfiguredEngine()
        let engine = try resolveEngine(configured: configured, appURL: appURL)
        if engine == "hook" {
            guard let hookURL = resolveHookURL() else {
                throw LauncherError.message("未找到主进程 Hook 脚本，请先在项目目录运行 node bin/cli.js install")
            }
            let port = try pickFreePort()
            appendLog("正在通过 --inspect-brk 端口 \(port) 启动 Antigravity")
            try openApp(appURL, arguments: ["--inspect-brk=127.0.0.1:\(port)"])
            try InspectorClient.inject(port: port, hookPath: hookURL.path)
            appendLog("主进程 Hook 注入成功 (端口 \(port))")
        } else {
            appendLog("正在通过 Browser CDP 模式启动 Antigravity")
            try openApp(appURL, arguments: ["--remote-debugging-port=0"])
        }
        exit(0)
    } catch {
        let msg = error.localizedDescription
        appendLog("启动失败: \(msg)")
        _ = showAlert(title: "Antigravity-zh 启动失败", message: msg, style: .critical)
        exit(1)
    }
}

#if AGZH_LAUNCHER_TEST
runSelfTests()
#else
MainActor.assumeIsolated {
    runLauncher()
}
#endif
