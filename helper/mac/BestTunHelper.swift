// Best's TUN helper for macOS: a small root service (LaunchDaemon) that runs sing-box's TUN for the
// user who installed it. Creating a TUN interface and changing routes needs root on macOS, while
// Best itself always runs as the user.
//
//  - It listens on a local socket only. A request is accepted only from the user who installed the
//    helper (their id is in a root-owned file next to it) or from root.
//  - It runs only its own copy of sing-box (root-owned, next to it), never a program it is given.
//  - It takes a sing-box TUN configuration and checks it against a strict list of what Best's TUN
//    ever uses: one TUN inbound, a SOCKS outbound to 127.0.0.1, direct, block, DNS servers and
//    routing rules. Anything that could read or write a file as root (log output, cache file,
//    rule sets, certificates, the Clash API…) is refused.
//  - TUN stops when the Best that started it goes away (quit or crash), so the network is never
//    left pointing at a proxy that no longer runs.
// Protocol: one JSON object per line. {"cmd":"hello"} → {"ok":true,"version":…};
// {"cmd":"start","config":{…}} → {"started":true} or {"error":"…"}, then {"log":"…"} lines and
// {"exit":code}; {"cmd":"stop"} → {"stopped":true}.

import CryptoKit
import Darwin
import Foundation

let helperVersion = "1"
let home = "/Library/PrivilegedHelperTools/com.best.client.tun"
let socketPath = "/var/run/com.best.client.tun.socket"
let runDir = home + "/run"
let singBox = home + "/sing-box"
let maxRequest = 2 * 1024 * 1024
/// SHA-256 of the helper's own sing-box (read once).
let singBoxDigest: String = {
  guard let data = FileManager.default.contents(atPath: singBox) else { return "" }
  return SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
}()

// MARK: - Configuration check

struct Refused: Error { let reason: String }

func object(_ v: Any?, _ at: String) throws -> [String: Any] {
  guard let d = v as? [String: Any] else { throw Refused(reason: "\(at) must be an object") }
  return d
}

func array(_ v: Any?, _ at: String) throws -> [Any] {
  guard let a = v as? [Any] else { throw Refused(reason: "\(at) must be a list") }
  return a
}

func only(_ d: [String: Any], _ allowed: Set<String>, _ at: String) throws {
  for k in d.keys where !allowed.contains(k) { throw Refused(reason: "\(at).\(k) is not allowed") }
}

/// Plain values only (text, numbers, true/false, lists of them). A text that names a file
/// ("/…", "~…") is refused unless `paths` allows it here.
func plain(_ v: Any, _ at: String, paths: Bool = false) throws {
  switch v {
  case let s as String:
    if s.count > 4096 || s.contains("\u{0}") { throw Refused(reason: "\(at) is too long") }
    if !paths && (s.hasPrefix("/") || s.hasPrefix("~")) { throw Refused(reason: "\(at) names a file") }
  case is NSNumber:
    break
  case let a as [Any]:
    if a.count > 5000 { throw Refused(reason: "\(at) is too long") }
    for (i, x) in a.enumerated() {
      if x is [Any] || x is [String: Any] { throw Refused(reason: "\(at)[\(i)] must be plain") }
      try plain(x, "\(at)[\(i)]", paths: paths)
    }
  default:
    throw Refused(reason: "\(at) must be plain")
  }
}

func plainObject(_ v: Any?, _ allowed: Set<String>, _ at: String, paths: Set<String> = []) throws {
  let d = try object(v, at)
  try only(d, allowed, at)
  for (k, x) in d { try plain(x, "\(at).\(k)", paths: paths.contains(k)) }
}

let routeRuleKeys: Set<String> = [
  "process_path_regex", "process_path", "process_name", "action", "protocol", "ip_version", "ip_is_private",
  "ip_cidr", "outbound", "domain", "domain_suffix", "domain_keyword", "port", "port_range", "network",
  "inbound", "invert", "sniffer", "timeout", "method", "no_drop", "server",
]
let dnsRuleKeys: Set<String> = [
  "domain", "domain_suffix", "domain_keyword", "query_type", "server", "action", "ip_version", "outbound",
  "inbound", "network", "port", "invert", "disable_cache", "strategy",
]
let dnsServerTypes: Set<String> = ["https", "h3", "tls", "quic", "udp", "tcp", "local", "hosts", "fakeip"]

func checkConfig(_ c: [String: Any]) throws {
  try only(c, ["log", "dns", "inbounds", "outbounds", "route"], "config")
  if let log = c["log"] {
    try plainObject(log, ["level", "timestamp", "disabled"], "log")
    // TUN carries every user's traffic: no level that writes their connections into the log
    if let level = (log as? [String: Any])?["level"], !["warn", "error", "fatal", "panic"].contains(level as? String ?? "") {
      throw Refused(reason: "log.level must be warn or quieter")
    }
  }
  // exactly one TUN inbound
  let inbounds = try array(c["inbounds"], "inbounds")
  guard inbounds.count == 1 else { throw Refused(reason: "exactly one inbound is allowed") }
  let tun = try object(inbounds[0], "inbounds[0]")
  guard tun["type"] as? String == "tun" else { throw Refused(reason: "the inbound must be a TUN") }
  try plainObject(tun, ["type", "tag", "address", "mtu", "auto_route", "strict_route", "stack", "route_exclude_address",
                        "route_address", "interface_name"], "inbounds[0]")
  if let name = tun["interface_name"] as? String, !(name.hasPrefix("utun") && name.dropFirst(4).allSatisfy(\.isNumber)) {
    throw Refused(reason: "the TUN interface must be utun")
  }
  // outbounds: the local proxy, direct and block only
  for (i, o) in try array(c["outbounds"], "outbounds").enumerated() {
    let d = try object(o, "outbounds[\(i)]")
    switch d["type"] as? String {
    case "socks":
      try plainObject(d, ["type", "tag", "server", "server_port", "version", "domain_resolver"], "outbounds[\(i)]")
      guard d["server"] as? String == "127.0.0.1" else { throw Refused(reason: "the proxy must be on this computer") }
    case "direct":
      try plainObject(d, ["type", "tag", "domain_resolver"], "outbounds[\(i)]")
    case "block":
      try plainObject(d, ["type", "tag"], "outbounds[\(i)]")
    default:
      throw Refused(reason: "outbounds[\(i)] has a type that is not allowed")
    }
  }
  // DNS
  if let dnsAny = c["dns"] {
    let dns = try object(dnsAny, "dns")
    try only(dns, ["servers", "rules", "final", "strategy", "independent_cache", "reverse_mapping", "disable_cache"], "dns")
    for k in ["final", "strategy", "independent_cache", "reverse_mapping", "disable_cache"] { if let v = dns[k] { try plain(v, "dns.\(k)") } }
    for (i, s) in try array(dns["servers"] ?? [Any](), "dns.servers").enumerated() {
      let d = try object(s, "dns.servers[\(i)]")
      let at = "dns.servers[\(i)]"
      guard let type = d["type"] as? String, dnsServerTypes.contains(type) else { throw Refused(reason: "\(at) has a type that is not allowed") }
      try only(d, ["type", "tag", "server", "server_port", "path", "headers", "detour", "domain_resolver", "tls", "predefined",
                   "inet4_range", "inet6_range"], at)
      for (k, v) in d where !["path", "headers", "tls", "predefined"].contains(k) { try plain(v, "\(at).\(k)") }
      if let p = d["path"] {
        // a URL path of DNS over HTTPS ("/dns-query"), never a file (the hosts type reads one)
        guard type == "https" || type == "h3", let s = p as? String, s.hasPrefix("/"), !s.contains(".."), s.count < 256 else {
          throw Refused(reason: "\(at).path is not allowed")
        }
      }
      if let h = d["headers"] { for (k, v) in try object(h, "\(at).headers") { try plain(v, "\(at).headers.\(k)") } }
      if let t = d["tls"] { try plainObject(t, ["enabled", "server_name", "insecure", "alpn"], "\(at).tls") }
      if let p = d["predefined"] { for (k, v) in try object(p, "\(at).predefined") { try plain(v, "\(at).predefined.\(k)") } }
    }
    for (i, r) in try array(dns["rules"] ?? [Any](), "dns.rules").enumerated() {
      try plainObject(r, dnsRuleKeys, "dns.rules[\(i)]")
    }
  }
  // routing
  let route = try object(c["route"], "route")
  try only(route, ["rules", "final", "auto_detect_interface", "default_domain_resolver", "default_interface"], "route")
  for k in ["final", "auto_detect_interface", "default_domain_resolver", "default_interface"] { if let v = route[k] { try plain(v, "route.\(k)") } }
  for (i, r) in try array(route["rules"] ?? [Any](), "route.rules").enumerated() {
    try plainObject(r, routeRuleKeys, "route.rules[\(i)]", paths: ["process_path"])
  }
}

// MARK: - The running sing-box

let pidFile = runDir + "/sing-box.pid"

/// The command line of a running process (empty when it is gone), through ps.
func commandOf(_ pid: Int32) -> String {
  let p = Process()
  p.executableURL = URL(fileURLWithPath: "/bin/ps")
  p.arguments = ["-p", String(pid), "-o", "comm="]
  let out = Pipe()
  p.standardOutput = out
  p.standardError = FileHandle.nullDevice
  do { try p.run() } catch { return "" }
  p.waitUntilExit()
  return String(data: out.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
}

/// A sing-box left by an earlier run of this helper (it was killed, or crashed): stop it, so its
/// routes do not point at a proxy that is gone. Only the process that is our own sing-box program.
func stopLeftover() {
  guard let s = try? String(contentsOfFile: pidFile, encoding: .utf8), let pid = Int32(s.trimmingCharacters(in: .whitespacesAndNewlines)), pid > 1 else { return }
  if commandOf(pid) == singBox {
    kill(pid, SIGTERM)
    for _ in 0..<30 where commandOf(pid) == singBox { Thread.sleep(forTimeInterval: 0.1) }
    if commandOf(pid) == singBox { kill(pid, SIGKILL) }
  }
  unlink(pidFile)
}

final class Session {
  let lock = NSLock()           // the fields below
  let op = NSRecursiveLock()    // one start or stop at a time
  let writing = NSLock()        // one message at a time on a connection
  var process: Process?
  var client: Int32 = -1
  var recent: [String] = []

  var currentClient: Int32 { lock.lock(); defer { lock.unlock() }; return client }

  /// One line to a client. The connection has a send time limit (serve()), so a client that stops
  /// reading cannot hold this up: the line is dropped.
  func send(_ fd: Int32, _ obj: [String: Any]) {
    guard fd >= 0, var data = try? JSONSerialization.data(withJSONObject: obj) else { return }
    data.append(0x0A)
    writing.lock(); defer { writing.unlock() }
    data.withUnsafeBytes { buf in
      var off = 0
      while off < buf.count {
        let n = write(fd, buf.baseAddress! + off, buf.count - off)
        if n <= 0 { break }
        off += n
      }
    }
  }

  func start(_ config: [String: Any], for fd: Int32) -> [String: Any] {
    op.lock(); defer { op.unlock() }
    stop()
    do {
      try checkConfig(config)
    } catch let e as Refused {
      return ["error": "configuration refused: \(e.reason)"]
    } catch {
      return ["error": "configuration refused"]
    }
    let fm = FileManager.default
    try? fm.createDirectory(atPath: runDir, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
    chmod(runDir, 0o700)
    let file = runDir + "/tun.json"
    guard let data = try? JSONSerialization.data(withJSONObject: config) else { return ["error": "configuration unreadable"] }
    fm.createFile(atPath: file, contents: data, attributes: [.posixPermissions: 0o600])
    let p = Process()
    p.executableURL = URL(fileURLWithPath: singBox)
    p.arguments = ["run", "-c", file, "-D", runDir]
    p.currentDirectoryURL = URL(fileURLWithPath: runDir)
    p.environment = ["PATH": "/usr/bin:/bin:/usr/sbin:/sbin"]
    let out = Pipe()
    p.standardOutput = out
    p.standardError = out
    lock.lock(); recent = []; client = fd; lock.unlock()
    out.fileHandleForReading.readabilityHandler = { [weak self] h in
      let chunk = h.availableData
      guard let self = self, !chunk.isEmpty, let text = String(data: chunk, encoding: .utf8) else { return }
      for line in text.split(separator: "\n") where !line.isEmpty {
        let s = String(line.prefix(2000))
        self.lock.lock(); self.recent.append(s); if self.recent.count > 6 { self.recent.removeFirst() }; let to = self.client; self.lock.unlock()
        self.send(to, ["log": s])
      }
    }
    p.terminationHandler = { [weak self] proc in
      guard let self = self else { return }
      out.fileHandleForReading.readabilityHandler = nil
      try? FileManager.default.removeItem(atPath: file)
      unlink(pidFile)
      self.lock.lock(); let current = self.process === proc; let to = self.client; self.lock.unlock()
      if current { self.send(to, ["exit": Int(proc.terminationStatus)]) }
    }
    do { try p.run() } catch { lock.lock(); client = -1; lock.unlock(); return ["error": "sing-box did not start: \(error.localizedDescription)"] }
    lock.lock(); process = p; lock.unlock()
    try? String(p.processIdentifier).write(toFile: pidFile, atomically: true, encoding: .utf8)
    Thread.sleep(forTimeInterval: 1.5) // TUN and routes are in place by then
    if !p.isRunning {
      lock.lock(); let last = recent.joined(separator: " | "); process = nil; client = -1; lock.unlock()
      return ["error": "sing-box stopped: \(last)"]
    }
    return ["started": true]
  }

  func stop() {
    op.lock(); defer { op.unlock() }
    lock.lock(); let p = process; process = nil; client = -1; lock.unlock()
    guard let proc = p, proc.isRunning else { return }
    proc.terminate()
    for _ in 0..<30 where proc.isRunning { Thread.sleep(forTimeInterval: 0.1) }
    if proc.isRunning { kill(proc.processIdentifier, SIGKILL) }
    unlink(pidFile)
  }

  /// The client that started TUN went away: stop it.
  func dropped(_ fd: Int32) {
    lock.lock(); let mine = client == fd; lock.unlock()
    if mine { stop() }
  }
}

let session = Session()

// MARK: - Socket

func ownerId() -> uid_t? {
  guard let s = try? String(contentsOfFile: home + "/owner", encoding: .utf8), let n = UInt32(s.trimmingCharacters(in: .whitespacesAndNewlines)) else { return nil }
  return n
}

func serve(_ fd: Int32) {
  defer { session.dropped(fd); close(fd) }
  var uid: uid_t = 0
  var gid: gid_t = 0
  // a client that stops reading cannot block the helper: a line that cannot go within 2 s is dropped
  var limit = timeval(tv_sec: 2, tv_usec: 0)
  setsockopt(fd, SOL_SOCKET, SO_SNDTIMEO, &limit, socklen_t(MemoryLayout<timeval>.size))
  guard getpeereid(fd, &uid, &gid) == 0, uid == 0 || uid == ownerId() else {
    session.send(fd, ["error": "not allowed for this user"])
    return
  }
  var buffer = Data()
  var chunk = [UInt8](repeating: 0, count: 65536)
  while true {
    let n = read(fd, &chunk, chunk.count)
    if n <= 0 { return }
    buffer.append(chunk, count: n)
    if buffer.count > maxRequest { session.send(fd, ["error": "request too large"]); return }
    while let nl = buffer.firstIndex(of: 0x0A) {
      let line = buffer.subdata(in: buffer.startIndex..<nl)
      buffer.removeSubrange(buffer.startIndex...nl)
      guard let req = (try? JSONSerialization.jsonObject(with: line)) as? [String: Any], let cmd = req["cmd"] as? String else {
        session.send(fd, ["error": "unreadable request"]); continue
      }
      switch cmd {
      case "hello":
        // the app compares the sing-box fingerprint with its own copy: a new Best (or core) means install again
        session.send(fd, ["ok": true, "version": helperVersion, "singbox": singBoxDigest])
      case "start":
        guard let config = req["config"] as? [String: Any] else { session.send(fd, ["error": "no configuration"]); continue }
        session.send(fd, session.start(config, for: fd))
      case "stop":
        session.stop()
        session.send(fd, ["stopped": true])
      default:
        session.send(fd, ["error": "unknown request"])
      }
    }
  }
}

signal(SIGPIPE, SIG_IGN)
// Stopped by launchd (removal, a new install): stop TUN first, so no root sing-box is left behind.
var stopSignals: [DispatchSourceSignal] = []
for sig in [SIGTERM, SIGINT, SIGHUP] {
  signal(sig, SIG_IGN)
  let src = DispatchSource.makeSignalSource(signal: sig, queue: .global())
  src.setEventHandler { session.stop(); unlink(socketPath); exit(0) }
  src.resume()
  stopSignals.append(src)
}
stopLeftover()
unlink(socketPath)
let listener = socket(AF_UNIX, SOCK_STREAM, 0)
guard listener >= 0 else { exit(1) }
var addr = sockaddr_un()
addr.sun_family = sa_family_t(AF_UNIX)
let pathBytes = Array(socketPath.utf8)
guard pathBytes.count < MemoryLayout.size(ofValue: addr.sun_path) else { exit(1) }
withUnsafeMutableBytes(of: &addr.sun_path) { raw in
  raw.copyBytes(from: pathBytes)
  raw[pathBytes.count] = 0
}
let bound = withUnsafePointer(to: &addr) { p in
  p.withMemoryRebound(to: sockaddr.self, capacity: 1) { bind(listener, $0, socklen_t(MemoryLayout<sockaddr_un>.size)) }
}
guard bound == 0 else { exit(1) }
// Anyone may connect; serve() answers only the owner (or root).
chmod(socketPath, 0o666)
guard listen(listener, 8) == 0 else { exit(1) }
while true {
  let c = accept(listener, nil, nil)
  if c < 0 { continue }
  Thread.detachNewThread { serve(c) }
}
