import Foundation

private enum ServerTestError: Error { case failed(String) }

private func serverExpect(_ condition: Bool, _ message: String) throws {
  if !condition { throw ServerTestError.failed(message) }
}

private final class ServerTestClock {
  private var now = 0
  private var next = 0
  private var timers: [Int: (at: Int, callback: () -> Void)] = [:]

  func schedule(_ ms: Int, _ callback: @escaping () -> Void) -> (() -> Void) {
    next += 1
    let id = next
    timers[id] = (now + ms, callback)
    return { self.timers.removeValue(forKey: id) }
  }

  func advance(_ ms: Int) {
    let end = now + ms
    while let due = timers.filter({ $0.value.at <= end }).min(by: {
      $0.value.at == $1.value.at ? $0.key < $1.key : $0.value.at < $1.value.at
    }) {
      timers.removeValue(forKey: due.key)
      now = due.value.at
      due.value.callback()
    }
    now = end
  }
}

private final class ServerFixture {
  let clock = ServerTestClock()
  var responses: [Response] = []
  var events: [Event] = []
  var releases = 0
  var stopped = false
  var nextId = 0
  var server: Dispatcher!

  init(responsible: Bool = true, pendingLimitBytes: Int = 2 * maxFrameBytes) {
    server = Dispatcher(
      responsible: responsible, architecture: "arm64", operatingSystem: "virtual test OS",
      send: { [weak self] in self?.responses.append($0) },
      event: { [weak self] in self?.events.append($0) },
      releaseAll: { [weak self] in self?.releases += 1; return 0 },
      stopped: { [weak self] in self?.stopped = true },
      execute: { $0() }, deliver: { $0() },
      schedule: clock.schedule, pendingLimitBytes: pendingLimitBytes
    )
  }

  @discardableResult func request(_ op: String, _ args: [String: JSONValue] = [:]) throws -> Int {
    nextId += 1
    server.receive(try Request(id: nextId, op: op, args: args))
    return nextId
  }

  func result(_ id: Int) -> JSONValue? { responses.first { $0.value["id"]?.intValue == id }?.value }

  @discardableResult func begin(_ id: String = "native-test", revision: Int = 0, paused: Bool = false,
                               approved: [JSONValue] = []) throws -> Int {
    try request("session.begin", [
      "sessionId": .string(id), "phaseRevision": .integer(Int64(revision)), "paused": .bool(paused),
      "mode": .string("foreground"), "approved": .array(approved), "vectorPids": .array([.integer(200)]),
      "vectorWindowIds": .array([.string("vector-1")]), "overlayWindowIds": .array([.string("overlay-1")]),
      "escStops": .bool(true), "stopChord": .string("Command+Shift+Escape"), "heartbeatMs": .integer(2000),
    ])
  }

  func phase(_ revision: Int = 0, id: String = "native-test") -> [String: JSONValue] {
    ["sessionId": .string(id), "phaseRevision": .integer(Int64(revision))]
  }
}

/// Pure dispatcher tests: virtual time, queued callbacks and injected input release only; no native grant or input.
func runServerTests() throws -> Int {
  var count = 0
  func test(_ body: () throws -> Void) throws { try body(); count += 1 }

  try test {
    let fake = ServerFixture(responsible: false)
    let hello = try fake.request("hello", ["protocol": .object(["min": .integer(1), "max": .integer(1)])])
    let value = fake.result(hello)
    try serverExpect(value?["ok"]?.boolValue == true, "hello negotiates the supported range")
    try serverExpect(value?["responsible"]?.boolValue == false, "hello reports actual responsibility")
    try serverExpect(value?["helper"]?["version"]?.stringValue == Identity.helperVersion, "hello uses generated identity")
    try serverExpect(value?["features"]?.objectValue == [:], "M1 advertises no unimplemented capability")
    try serverExpect(value?["permissions"]?["screen"]?.stringValue == "notDetermined", "an unbound dispatcher leaves OS grants unobserved")
    let incompatible = try fake.request("hello", ["protocol": .object(["min": .integer(2), "max": .integer(2)])])
    try serverExpect(fake.result(incompatible)?["code"]?.stringValue == "helper_incompatible", "incompatible hello refuses")
  }

  try test {
    let fake = ServerFixture(responsible: false)
    var invoked = false
    fake.server.register(op: "permissions.request", deadlineMs: 100, requiresSession: false) { _, _, done in
      invoked = true
      done(.success(ServerReply()))
    }
    let request = try fake.request("permissions.request", ["service": .string("screen")])
    try serverExpect(!invoked, "a nonresponsible helper never enters an OS prompt handler")
    try serverExpect(fake.result(request)?["ok"]?.boolValue == true && fake.result(request)?["screen"]?.stringValue == "notDetermined",
                     "a nonresponsible permission request returns status without an OS prompt")
    let malformed = try fake.request("permissions.request", ["service": .string("screen"), "bundleId": .string("other.app")])
    try serverExpect(fake.result(malformed)?["code"]?.stringValue == "failed" && !invoked,
                     "the nonresponsible status fallback still rejects extra authority fields")
    let begin = try fake.begin()
    try serverExpect(fake.result(begin)?["code"]?.stringValue == "responsible_missing", "nonresponsible session refused")
    let status = try fake.request("permissions.status")
    try serverExpect(fake.result(status)?["accessibility"]?.stringValue == "notDetermined", "status remains a read without prompting")
  }

  try test {
    let fake = ServerFixture()
    let unknown = try fake.request("unimplemented.operation")
    try serverExpect(fake.result(unknown)?["code"]?.stringValue == "unsupported_action", "unknown op fails without crashing")
    let invalid = try fake.request("hello", ["protocol": .bool(true)])
    try serverExpect(fake.result(invalid)?["code"]?.stringValue == "failed", "invalid hello arguments refuse")
    let extra = try fake.request("heartbeat", ["unexpected": .bool(true)])
    try serverExpect(fake.result(extra)?["code"]?.stringValue == "failed", "control arguments are strict")
    let cancel = try fake.request("cancel")
    try serverExpect(fake.result(cancel)?["ok"]?.boolValue == true, "cancel while idle succeeds")
    let release = try fake.request("input.releaseAll")
    try serverExpect(fake.result(release)?["released"]?.intValue == 0, "releaseAll succeeds without a session")
  }

  try test {
    let fake = ServerFixture()
    var completion: Dispatcher.Completion?
    var context: OperationContext?
    var starts: [Int] = []
    fake.server.register(op: "apps.list", deadlineMs: 100, requiresSession: false) { request, current, done in
      starts.append(request.id)
      context = current
      completion = done
    }
    let first = try fake.request("apps.list")
    let second = try fake.request("apps.list")
    try serverExpect(starts == [first], "a pending asynchronous operation serializes later handlers")
    let heartbeat = try fake.request("heartbeat")
    try serverExpect(fake.result(heartbeat)?["ok"]?.boolValue == true, "heartbeat bypasses a pending operation")
    let oldContext = context
    let oldCompletion = completion
    let cancelled = try fake.request("cancel", ["target": .integer(Int64(first))])
    try serverExpect(fake.result(cancelled)?["ok"]?.boolValue == true && starts == [first, second], "cancel immediately advances the serial queue")
    try serverExpect(fake.result(first)?["code"]?.stringValue == "failed", "cancel answers the original request")
    try serverExpect(oldContext?.isCurrent() == false, "cancel invalidates the native continuation")
    oldCompletion?(.success(ServerReply()))
    try serverExpect(fake.responses.filter { $0.value["id"]?.intValue == first }.count == 1, "late completion cannot answer twice")
    completion?(.success(ServerReply(fields: ["apps": .array([])])))
    try serverExpect(fake.result(second)?["ok"]?.boolValue == true, "the next handler completes normally")
  }

  try test {
    let fake = ServerFixture()
    var completion: Dispatcher.Completion?
    var starts = 0
    fake.server.register(op: "apps.list", deadlineMs: 100, requiresSession: false) { _, _, done in starts += 1; completion = done }
    let first = try fake.request("apps.list")
    let queued = try fake.request("apps.list")
    _ = try fake.request("cancel", ["target": .integer(Int64(queued))])
    try serverExpect(starts == 1 && fake.result(first) == nil, "targeting queued work leaves the active operation alone")
    try serverExpect(fake.result(queued)?["code"]?.stringValue == "failed", "queued target receives its cancellation")
    completion?(.success(ServerReply()))
    try serverExpect(starts == 1, "a cancelled queued handler never runs")
  }

  try test {
    let fake = ServerFixture()
    let begin = try fake.begin(paused: true)
    try serverExpect(fake.result(begin)?["ok"]?.boolValue == true, "a valid phased session starts")
    try serverExpect(fake.events.first?.value["event"]?.stringValue == "input_detection", "each phased begin supplies its detection witness")
    try serverExpect(fake.events.first?.value["alive"]?.boolValue == false, "M1 reports that no event tap exists yet")
    let stale = try fake.request("session.update", ["sessionId": .string("other"), "phaseRevision": .integer(1), "paused": .bool(false)])
    try serverExpect(fake.result(stale)?["code"]?.stringValue == "changed", "a foreign session cannot unpause the holder")
    let update = try fake.request("session.update", ["sessionId": .string("native-test"), "phaseRevision": .integer(2), "paused": .bool(false)])
    try serverExpect(fake.result(update)?["ok"]?.boolValue == true, "a current newer phase is accepted")
    let older = try fake.request("session.update", ["sessionId": .string("native-test"), "phaseRevision": .integer(1), "paused": .bool(false)])
    try serverExpect(fake.result(older)?["code"]?.stringValue == "changed", "an older phase cannot replace the current one")
    let rewrite = try fake.request("session.update", ["vectorPids": .array([])])
    try serverExpect(fake.result(rewrite)?["code"]?.stringValue == "failed", "Vector process exclusions cannot be rewritten")
    try serverExpect(fake.server.sessionSnapshot()?.vectorPids == [200], "the begin exclusions remain intact")
  }

  try test {
    let fake = ServerFixture()
    let malformed: JSONValue = .object(["platform": .string("macos"), "bundleId": .string("com.example.fixture")])
    let foreign: JSONValue = .object(["platform": .string("windows"), "kind": .string("aumid"), "aumid": .string("fixture")])
    let identity: JSONValue = .object([
      "platform": .string("macos"), "bundleId": .string("com.example.fixture"), "teamId": .string("ABCDEFGHIJ"),
      "apple": .bool(false), "system": .bool(false), "verified": .bool(true), "name": .string("Fixture app"),
    ])
    let badBegin = try fake.begin(approved: [malformed])
    try serverExpect(fake.result(badBegin)?["code"]?.stringValue == "failed", "malformed approvals refuse before begin acknowledgment")
    try serverExpect(fake.server.sessionSnapshot() == nil, "a refused begin creates no session authority")
    let begin = try fake.begin(approved: [identity])
    try serverExpect(fake.result(begin)?["ok"]?.boolValue == true, "strict valid native approval begins normally")
    for invalid in [malformed, foreign] {
      let update = try fake.request("session.update", [
        "sessionId": .string("native-test"), "phaseRevision": .integer(1), "approved": .array([invalid]),
      ])
      try serverExpect(fake.result(update)?["code"]?.stringValue == "failed", "malformed and foreign approvals refuse before update acknowledgment")
      try serverExpect(fake.server.sessionSnapshot()?.approved == [identity] && fake.server.sessionSnapshot()?.revision == 0,
                       "a refused approval update cannot replace the captured policy or phase")
    }
  }

  try test {
    let fake = ServerFixture()
    var posts = 0
    fake.server.register(op: "input.key", deadlineMs: 100) { _, context, done in
      _ = context.withCurrent { posts += 1 }
      done(.success(ServerReply()))
    }
    _ = try fake.begin()
    fake.clock.advance(4999)
    _ = try fake.request("heartbeat")
    fake.clock.advance(4999)
    try serverExpect(fake.releases == 1, "a fresh heartbeat cancels the old deadline")
    fake.clock.advance(1)
    let stopped = try fake.request("input.key", fake.phase())
    try serverExpect(fake.result(stopped)?["code"]?.stringValue == "stopped" && posts == 0, "five seconds of silence halts input before the handler")
    _ = try fake.request("heartbeat")
    _ = try fake.request("session.update", ["sessionId": .string("native-test"), "phaseRevision": .integer(1), "paused": .bool(false)])
    let stillStopped = try fake.request("input.key", fake.phase(1))
    try serverExpect(fake.result(stillStopped)?["code"]?.stringValue == "stopped", "heartbeat and phase update never clear the halt latch")
    _ = try fake.begin("fresh")
    let fresh = try fake.request("input.key", fake.phase(id: "fresh"))
    try serverExpect(fake.result(fresh)?["ok"]?.boolValue == true && posts == 1, "only a fresh begin restores input")
  }

  try test {
    let fake = ServerFixture()
    var completion: Dispatcher.Completion?
    var context: OperationContext?
    fake.server.register(op: "input.hold", deadlineMs: 100) { _, current, done in context = current; completion = done }
    _ = try fake.begin()
    let held = try fake.request("input.hold", fake.phase())
    fake.clock.advance(100)
    try serverExpect(fake.result(held)?["code"]?.stringValue == "timeout", "per-operation deadline answers the original request")
    var posted = false
    try serverExpect(context?.withCurrent { posted = true } == false && !posted, "a timed-out callback cannot post input")
    completion?(.success(ServerReply()))
    try serverExpect(fake.responses.filter { $0.value["id"]?.intValue == held }.count == 1, "a timed-out request cannot answer a second time")
    try serverExpect(fake.releases >= 2, "input is released before timeout completion")
  }

  try test {
    let fake = ServerFixture()
    var context: OperationContext?
    fake.server.register(op: "input.hold", deadlineMs: 100) { _, current, _ in context = current }
    _ = try fake.begin()
    let held = try fake.request("input.hold", fake.phase())
    fake.server.pauseForPhysicalInput()
    try serverExpect(fake.result(held)?["code"]?.stringValue == "paused", "physical input immediately interrupts pending work")
    let resume = try fake.request("session.update", ["sessionId": .string("native-test"), "phaseRevision": .integer(1), "paused": .bool(false)])
    try serverExpect(fake.result(resume)?["code"]?.stringValue == "changed", "an in-flight working update cannot undo physical take-over")
    try serverExpect(context?.isCurrent() == false, "physical take-over invalidates existing continuations")
    _ = try fake.begin("replacement")
    try serverExpect(context?.isCurrent() == false, "a successor cannot revive its predecessor's callback")
  }

  try test {
    let fake = ServerFixture()
    var posts = 0
    fake.server.register(op: "input.key", deadlineMs: 100, requiresSession: false) { _, current, done in
      _ = current.withCurrent { posts += 1 }
      done(.success(ServerReply()))
    }
    let absent = try fake.request("input.key")
    try serverExpect(fake.result(absent)?["code"]?.stringValue == "unavailable", "known mutations always require a session")
    _ = try fake.begin()
    let wrong = try fake.request("input.key", fake.phase(1))
    try serverExpect(fake.result(wrong)?["code"]?.stringValue == "changed", "a mutation must carry the exact native revision")
    _ = try fake.request("session.update", ["sessionId": .string("native-test"), "phaseRevision": .integer(1), "paused": .bool(true)])
    let paused = try fake.request("input.key", fake.phase(1))
    try serverExpect(fake.result(paused)?["code"]?.stringValue == "paused" && posts == 0, "native mutation guards cannot be disabled by registration options")
  }

  try test {
    let fake = ServerFixture(pendingLimitBytes: 512)
    var completions: [Dispatcher.Completion] = []
    fake.server.register(op: "unit.pending", deadlineMs: 100, requiresSession: false) { _, _, done in completions.append(done) }
    let body: [String: JSONValue] = ["payload": .string(String(repeating: "x", count: 200))]
    let first = try fake.request("unit.pending", body)
    _ = try fake.request("unit.pending", body)
    let overflow = try fake.request("unit.pending", body)
    try serverExpect(fake.result(overflow)?["code"]?.stringValue == "busy", "the aggregate pending frame budget bounds retained JSON")
    _ = try fake.request("cancel", ["target": .integer(Int64(first))])
    let admitted = try fake.request("unit.pending", body)
    try serverExpect(fake.result(admitted) == nil && completions.count == 2, "retired operations return their retained-byte budget")
    fake.server.close(reason: "test")
  }

  try test {
    let fake = ServerFixture()
    var context: OperationContext?
    fake.server.register(op: "input.hold", deadlineMs: 100) { _, current, _ in context = current }
    _ = try fake.begin()
    let held = try fake.request("input.hold", fake.phase())
    let queued = try fake.request("input.hold", fake.phase())
    let shutdown = try fake.request("shutdown")
    try serverExpect(fake.stopped && fake.result(shutdown)?["ok"]?.boolValue == true, "shutdown acknowledges before exit")
    try serverExpect(fake.result(held)?["code"]?.stringValue == "stopped" && fake.result(queued)?["code"]?.stringValue == "stopped", "shutdown cancels active and queued operations")
    try serverExpect(context?.isCurrent() == false && fake.server.sessionSnapshot() == nil, "shutdown revokes every continuation and session")
    let count = fake.responses.count
    _ = try fake.request("heartbeat")
    try serverExpect(fake.responses.count == count, "a closed dispatcher cannot resume serving")
  }

  try test {
    let fake = ServerFixture()
    var completion: Dispatcher.Completion?
    fake.server.register(op: "apps.list", deadlineMs: 100, requiresSession: false) { _, _, done in completion = done }
    let pending = try fake.request("apps.list")
    fake.server.close(reason: "eof")
    try serverExpect(fake.result(pending)?["code"]?.stringValue == "stopped" && fake.releases > 0, "EOF revokes authority before process exit")
    completion?(.success(ServerReply()))
    try serverExpect(fake.responses.filter { $0.value["id"]?.intValue == pending }.count == 1, "EOF fences late responses")
  }

  try test {
    var pendingWrites: [() -> Void] = []
    var stopped = false
    var releases = 0
    let server = Dispatcher(
      responsible: true, architecture: "arm64", operatingSystem: "virtual",
      send: { _ in }, event: { _ in },
      releaseAll: { releases += 1; return 0 }, stopped: { stopped = true },
      execute: { $0() }, deliver: { pendingWrites.append($0) }, schedule: ServerTestClock().schedule
    )
    for id in 1...129 {
      server.receive(try Request(id: id, op: "hello", args: ["protocol": .object(["min": .integer(1), "max": .integer(1)])]))
    }
    try serverExpect(stopped && releases > 0 && pendingWrites.count == 128, "an unread output channel has a bounded queue and revokes authority")
  }

  try test {
    let fake = ServerFixture()
    var oldContext: OperationContext?
    var oldCompletion: Dispatcher.Completion?
    var posts = 0
    fake.server.register(op: "input.hold", deadlineMs: 100) { _, current, done in oldContext = current; oldCompletion = done }
    fake.server.register(op: "input.key", deadlineMs: 100) { _, current, done in
      _ = current.withCurrent { posts += 1 }
      done(.success(ServerReply()))
    }
    _ = try fake.begin()
    let held = try fake.request("input.hold", fake.phase())
    let queued = try fake.request("input.key", fake.phase())
    let pause = try fake.request("session.update", ["sessionId": .string("native-test"), "phaseRevision": .integer(1), "paused": .bool(true)])
    try serverExpect(fake.result(pause)?["ok"]?.boolValue == true, "phase updates do not wait behind a pending native handler")
    try serverExpect(fake.result(held)?["code"]?.stringValue == "changed" && fake.result(queued)?["code"]?.stringValue == "changed", "a new phase cancels active and queued older authority")
    var latePost = false
    try serverExpect(oldContext?.withCurrent { latePost = true } == false && !latePost && posts == 0, "old phase callbacks and queued input cannot post after pause acknowledgement")
    oldCompletion?(.success(ServerReply()))
    try serverExpect(fake.responses.filter { $0.value["id"]?.intValue == held }.count == 1, "a phase-cancelled native result cannot answer later")
    _ = try fake.begin("successor")
    try serverExpect(oldContext?.isCurrent() == false, "a replacement session never revives old input authority")
  }

  try test {
    let fake = ServerFixture()
    var context: OperationContext?
    var posts = 0
    fake.server.register(op: "input.hold", deadlineMs: 100) { _, current, _ in context = current }
    fake.server.register(op: "input.key", deadlineMs: 100) { _, current, done in
      _ = current.withCurrent { posts += 1 }
      done(.success(ServerReply()))
    }
    _ = try fake.begin()
    let held = try fake.request("input.hold", fake.phase())
    let queued = try fake.request("input.key", fake.phase())
    let cancel = try fake.request("cancel", ["target": .integer(Int64(held))])
    try serverExpect(fake.result(cancel)?["ok"]?.boolValue == true, "cancel responds while the native callback is pending")
    try serverExpect(fake.result(queued)?["code"]?.stringValue == "failed" && posts == 0, "cancelling active input drops input already queued under the same phase")
    try serverExpect(context?.isCurrent() == false, "cancellation invalidates the old native callback")
    let freshRequest = try fake.request("input.key", fake.phase())
    try serverExpect(fake.result(freshRequest)?["ok"]?.boolValue == true && posts == 1, "cancel does not invent a process-wide stop latch for later requests")
  }

  return count
}
