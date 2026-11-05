import Foundation
import Dispatch

struct ServerFailure: Error {
  let code: String
  let message: String
}

struct ServerReply {
  var fields: [String: JSONValue] = [:]
  var image: Data? = nil
}

struct ServerSession {
  /// Wire ids/revisions may be reused; native observations belong to one accepted authority snapshot.
  var observationEpoch = UUID()
  let id: String
  var revision: Int?
  var mode: String
  var paused: Bool
  var approved: [JSONValue]
  let vectorPids: [Int]
  let vectorWindowIds: [String]
  var overlayWindowIds: [String]
  var escStops: Bool
  let stopChord: String
}

/// Native handlers must put each OS mutation inside withCurrent, including callbacks after an asynchronous wait.
/// The same lock fences cancellation, phase changes and the actual posting; a late callback cannot reopen input.
struct OperationContext {
  let session: ServerSession?
  let isCurrent: () -> Bool
  let withCurrent: (_ body: () -> Void) -> Bool
}

/// One asynchronous operation at a time. Control requests never wait behind an asynchronous native operation.
final class Dispatcher {
  typealias Completion = (Result<ServerReply, ServerFailure>) -> Void
  typealias Handler = (Request, OperationContext, @escaping Completion) -> Void
  typealias Schedule = (Int, @escaping () -> Void) -> (() -> Void)

  private struct Registration {
    let deadlineMs: Int
    let requiresSession: Bool
    let mutating: Bool
    let handler: Handler
  }

  private struct Active {
    let token: UUID
    let request: Request
    let generation: UInt64
    let sessionId: String?
    let revision: Int?
    let mutating: Bool
    let requiresSession: Bool
    var cancelDeadline: (() -> Void)?
  }

  private let lock = NSRecursiveLock()
  private let responsible: Bool
  private let architecture: String
  private let operatingSystem: String
  private let send: (Response) -> Void
  private let sendImage: ((Response, Data) -> Void)?
  private let event: (Event) -> Void
  private let releaseAll: () -> Int
  private let observationsInvalidated: () -> Void
  private let stopped: () -> Void
  private let features: () -> [String: Bool]
  private let permissions: () -> [String: JSONValue]
  private let execute: (@escaping () -> Void) -> Void
  private let deliver: (@escaping () -> Void) -> Void
  private let schedule: Schedule
  private var handlers: [String: Registration] = [:]
  private var queue: [Request] = []
  private var retainedBytes = 0
  private var retainedSizes: [Int: Int] = [:]
  private var admittedGenerations: [Int: UInt64] = [:]
  private let pendingLimitBytes: Int
  private var active: Active?
  private var session: ServerSession?
  private var generation: UInt64 = 0
  private var closed = false
  private var halted = false
  private var physicalPause = false
  private var cancelHeartbeat: (() -> Void)?
  private var heartbeatGeneration: UInt64 = 0
  private var pendingOutputCount = 0
  private var pendingOutputBytes = 0
  private var outputFailed = false

  init(
    responsible: Bool,
    architecture: String,
    operatingSystem: String,
    send: @escaping (Response) -> Void,
    event: @escaping (Event) -> Void,
    releaseAll: @escaping () -> Int = { 0 },
    observationsInvalidated: @escaping () -> Void = {},
    stopped: @escaping () -> Void = {},
    sendImage: ((Response, Data) -> Void)? = nil,
    features: @escaping () -> [String: Bool] = { [:] },
    permissions: @escaping () -> [String: JSONValue] = {
      ["screen": .string("notDetermined"), "accessibility": .string("notDetermined"), "postEvent": .string("notDetermined")]
    },
    execute: ((@escaping () -> Void) -> Void)? = nil,
    deliver: ((@escaping () -> Void) -> Void)? = nil,
    schedule: Schedule? = nil,
    pendingLimitBytes: Int = 2 * maxFrameBytes
  ) {
    self.responsible = responsible
    self.architecture = String(architecture.prefix(32))
    self.operatingSystem = String(operatingSystem.prefix(128))
    self.send = send
    self.event = event
    self.releaseAll = releaseAll
    self.observationsInvalidated = observationsInvalidated
    self.stopped = stopped
    self.sendImage = sendImage
    self.features = features
    self.permissions = permissions
    self.pendingLimitBytes = max(1, min(pendingLimitBytes, 2 * maxFrameBytes))
    let worker = DispatchQueue(label: "ai.vector.computer.operations")
    let writer = DispatchQueue(label: "ai.vector.computer.responses")
    let timers = DispatchQueue(label: "ai.vector.computer.deadlines")
    self.execute = execute ?? { worker.async(execute: DispatchWorkItem(block: $0)) }
    self.deliver = deliver ?? { writer.async(execute: DispatchWorkItem(block: $0)) }
    self.schedule = schedule ?? { ms, callback in
      let item = DispatchWorkItem(block: callback)
      timers.asyncAfter(deadline: .now() + .milliseconds(ms), execute: item)
      return { item.cancel() }
    }
  }

  /// Registration only supplies a handler. A feature is advertised separately, once its implementation is ready.
  func register(
    op: String,
    deadlineMs: Int,
    requiresSession: Bool = true,
    mutating: Bool = false,
    handler: @escaping Handler
  ) {
    locked {
      guard !closed, !Self.builtins.contains(op), deadlineMs > 0, deadlineMs <= 600_000 else { return }
      handlers[op] = Registration(deadlineMs: deadlineMs, requiresSession: Self.mutations.contains(op) || requiresSession,
                                  mutating: Self.mutations.contains(op) || mutating, handler: handler)
    }
  }

  func receive(_ request: Request) {
    locked {
      guard !closed else { return }
      guard request.id > 0, request.id <= 9_007_199_254_740_991 else {
        reply(.failure(id: 0, code: "failed", error: "A request needs a positive integer id."))
        return
      }
      guard active?.request.id != request.id, !queue.contains(where: { $0.id == request.id }) else {
        reply(.failure(id: request.id, code: "failed", error: "This request id is already active."))
        return
      }
      if Self.immediate.contains(request.op) {
        control(request)
        return
      }
      guard let byteCount = try? JSONEncoder().encode(request).count, byteCount <= maxFrameBytes else {
        fail(request, "frame_too_large", "The request exceeds the frame limit.")
        return
      }
      guard queue.count < 1000, byteCount <= pendingLimitBytes - retainedBytes else {
        reply(.failure(id: request.id, code: "busy", error: "The operation queue is full."))
        return
      }
      retainedSizes[request.id] = byteCount
      admittedGenerations[request.id] = generation
      retainedBytes += byteCount
      queue.append(request)
      pump()
    }
  }

  /// EOF, parent death and launch failure all invalidate authority before the process exits.
  func close(reason: String = "closed") {
    locked {
      guard !closed else { return }
      closed = true
      halted = true
      generation &+= 1
      observationsInvalidated()
      cancelHeartbeat?()
      cancelHeartbeat = nil
      _ = releaseAll()
      cancelActive(code: "stopped", message: "The helper has closed.")
      rejectQueued(code: "stopped", message: "The helper has closed.")
      session = nil
    }
  }

  /// M8 calls this before publishing physical take-over; session.update can never clear the resulting latch.
  func pauseForPhysicalInput() {
    locked {
      physicalPause = true
      session?.paused = true
      generation &+= 1
      observationsInvalidated()
      _ = releaseAll()
      cancelActive(code: "paused", message: "Physical input paused this task.")
      pump()
    }
  }

  func sessionSnapshot() -> ServerSession? { locked { session } }

  /// Native reconfiguration invalidates geometries before the notification reaches desktop main.
  func notifyDisplayChange() {
    locked {
      guard !closed else { return }
      emit(Event(name: "display_change"))
    }
  }

  private static let mutations: Set<String> = [
    "input.click", "input.move", "input.drag", "input.scroll", "input.key", "input.type", "input.hold",
    "app.activate", "app.launch", "program.launch", "window.focus", "ui.perform", "ui.setValue", "clipboard.write",
  ]
  private static let phases: Set<String> = ["session.begin", "session.update", "session.end"]
  private static let immediate: Set<String> = Set(["heartbeat", "cancel", "input.releaseAll", "shutdown"]).union(phases)
  private static let builtins: Set<String> = Set(["hello", "session.begin", "session.update", "session.end", "permissions.status"]).union(immediate)

  private func locked<T>(_ body: () -> T) -> T {
    lock.lock()
    defer { lock.unlock() }
    return body()
  }

  private func output(_ bytes: Int, _ body: @escaping () -> Void) {
    guard !outputFailed else { return }
    guard pendingOutputCount < 128, bytes <= 2 * maxFrameBytes - pendingOutputBytes else {
      outputFailed = true
      close(reason: "output-backpressure")
      stopped()
      return
    }
    pendingOutputCount += 1
    pendingOutputBytes += bytes
    deliver {
      body()
      self.locked {
        self.pendingOutputCount -= 1
        self.pendingOutputBytes -= bytes
      }
    }
  }

  private func reply(_ response: Response) {
    let bytes = (try? JSONEncoder().encode(response).count) ?? maxFrameBytes + 1
    output(bytes) { self.send(response) }
  }

  private func emit(_ value: Event) {
    let bytes = (try? JSONEncoder().encode(value).count) ?? maxFrameBytes + 1
    output(bytes) { self.event(value) }
  }

  private func fail(_ request: Request, _ code: String, _ message: String) {
    reply(.failure(id: request.id, code: code, error: message))
  }

  private func pump() {
    guard !closed, active == nil, !queue.isEmpty else { return }
    let request = queue.removeFirst()
    let registration = handlers[request.op]
    let token = UUID()
    active = Active(token: token, request: request, generation: admittedGenerations[request.id] ?? generation, sessionId: session?.id,
                    revision: session?.revision, mutating: registration?.mutating ?? false, requiresSession: registration?.requiresSession ?? true)
    execute { [weak self] in self?.start(request, registration, token) }
  }

  private func start(_ request: Request, _ registration: Registration?, _ token: UUID) {
    let context: OperationContext? = locked {
      guard active?.token == token, !closed else { return nil }
      if builtin(request) {
        forget(request.id)
        active = nil
        pump()
        return nil
      }
      guard let registration else {
        fail(request, "unsupported_action", "This operation is not implemented.")
        forget(request.id)
        active = nil
        pump()
        return nil
      }
      if let refusal = admission(request, registration) {
        fail(request, refusal.code, refusal.message)
        forget(request.id)
        active = nil
        pump()
        return nil
      }
      let cancel = schedule(registration.deadlineMs) { [weak self] in self?.deadline(token) }
      guard active?.token == token else { cancel(); return nil }
      active?.cancelDeadline = cancel
      return OperationContext(
        session: session,
        isCurrent: { [weak self] in
          guard let self else { return false }
          return self.locked { self.current(token) }
        },
        withCurrent: { [weak self] body in
          guard let self else { return false }
          return self.locked {
            guard self.current(token) else { return false }
            body()
            return true
          }
        }
      )
    }
    guard let context, let registration else { return }
    registration.handler(request, context) { [weak self] result in self?.complete(token, result) }
  }

  private func current(_ token: UUID) -> Bool {
    guard !closed, let active, active.token == token else { return false }
    if active.requiresSession && (active.generation != generation || active.sessionId != session?.id || active.revision != session?.revision) { return false }
    return !active.mutating || (!halted && !physicalPause && session?.paused == false)
  }

  private func admission(_ request: Request, _ registration: Registration) -> ServerFailure? {
    guard responsible else { return ServerFailure(code: "responsible_missing", message: "The helper does not own its OS permissions.") }
    if registration.mutating && halted { return ServerFailure(code: "stopped", message: "Input has stopped until a new session begins.") }
    if registration.requiresSession && session == nil { return ServerFailure(code: "unavailable", message: "No computer session is active.") }
    if registration.requiresSession && active?.generation != generation { return ServerFailure(code: "changed", message: "The computer session changed while the request was queued.") }
    if registration.mutating {
      if physicalPause || session?.paused == true { return ServerFailure(code: "paused", message: "This task is paused.") }
      if let session, let revision = session.revision,
         request.args["sessionId"]?.stringValue != session.id || request.args["phaseRevision"]?.intValue != revision {
        return ServerFailure(code: "changed", message: "The computer session phase changed.")
      }
    }
    return nil
  }

  private func complete(_ token: UUID, _ result: Result<ServerReply, ServerFailure>) {
    locked {
      guard let active, active.token == token else { return }
      guard current(token) else {
        cancelActive(code: "changed", message: "The computer session changed during the operation.")
        pump()
        return
      }
      active.cancelDeadline?()
      self.active = nil
      forget(active.request.id)
      switch result {
      case .success(let value):
        let response = Response.success(id: active.request.id, fields: value.fields)
        if let image = value.image {
          if let sendImage {
            let bytes = ((try? JSONEncoder().encode(response).count) ?? maxFrameBytes + 1) + image.count
            output(bytes) { sendImage(response, image) }
          }
          else { fail(active.request, "capture_unavailable", "Image output is unavailable.") }
        } else { reply(response) }
      case .failure(let failure): fail(active.request, failure.code, failure.message)
      }
      pump()
    }
  }

  private func deadline(_ token: UUID) {
    locked {
      guard let active, active.token == token else { return }
      if active.mutating {
        halted = true
        _ = releaseAll()
      }
      cancelActive(code: "timeout", message: "The native operation timed out.")
      pump()
    }
  }

  private func cancelActive(code: String, message: String) {
    guard let current = active else { return }
    active = nil
    current.cancelDeadline?()
    forget(current.request.id)
    fail(current.request, code, message)
  }

  private func rejectQueued(code: String, message: String) {
    let pending = queue
    queue.removeAll()
    for request in pending { forget(request.id); fail(request, code, message) }
  }

  private func forget(_ id: Int) {
    retainedBytes -= retainedSizes.removeValue(forKey: id) ?? 0
    admittedGenerations.removeValue(forKey: id)
  }

  private func invalidateSessionWork() {
    generation &+= 1
    observationsInvalidated()
    _ = releaseAll()
    if active?.requiresSession == true { cancelActive(code: "changed", message: "The computer session phase changed.") }
    let cancelled = queue.filter { handlers[$0.op]?.requiresSession == true }
    queue.removeAll { handlers[$0.op]?.requiresSession == true }
    for request in cancelled {
      forget(request.id)
      fail(request, "changed", "The computer session changed while this request was queued.")
    }
  }

  private func cancelQueuedMutations(_ generation: UInt64? = nil) {
    let cancelled = queue.filter {
      handlers[$0.op]?.mutating == true && (generation == nil || admittedGenerations[$0.id] == generation)
    }
    let ids = Set(cancelled.map { $0.id })
    queue.removeAll { ids.contains($0.id) }
    for request in cancelled {
      forget(request.id)
      fail(request, "failed", "Pending input was cancelled.")
    }
  }

  private func control(_ request: Request) {
    if Self.phases.contains(request.op) {
      _ = builtin(request)
      pump()
      return
    }
    let allowed: Set<String> = request.op == "cancel" ? ["target"] : []
    guard Set(request.args.keys).isSubset(of: allowed) else { fail(request, "failed", "Invalid control arguments."); return }
    switch request.op {
    case "heartbeat":
      if session != nil { armHeartbeat() }
      reply(.success(id: request.id))
    case "cancel":
      if let target = request.args["target"], target.intValue == nil || target.intValue! < 0 || target.intValue! > 9_007_199_254_740_991 {
        fail(request, "failed", "Invalid cancellation target."); return
      }
      if let target = request.args["target"]?.intValue,
         let index = queue.firstIndex(where: { $0.id == target }) {
        let pending = queue.remove(at: index)
        forget(pending.id)
        fail(pending, "failed", "Cancelled.")
      } else if let current = active,
                request.args["target"] == nil || request.args["target"]?.intValue == current.request.id {
        _ = releaseAll()
        if current.requiresSession { cancelQueuedMutations(current.generation) }
        cancelActive(code: "failed", message: "Cancelled.")
      }
      reply(.success(id: request.id))
      pump()
    case "input.releaseAll":
      let released = max(0, releaseAll())
      cancelQueuedMutations()
      if active?.mutating == true { cancelActive(code: "failed", message: "Input was released.") }
      reply(.success(id: request.id, fields: ["released": .integer(Int64(released))]))
      pump()
    case "shutdown":
      close(reason: "shutdown")
      output(64) { self.send(.success(id: request.id)); self.stopped() }
    default: break
    }
  }

  private func armHeartbeat() {
    cancelHeartbeat?()
    heartbeatGeneration &+= 1
    let ticket = heartbeatGeneration
    cancelHeartbeat = schedule(5000) { [weak self] in
      self?.locked {
        guard let self, !self.closed, self.session != nil, self.heartbeatGeneration == ticket else { return }
        self.cancelHeartbeat = nil
        self.halted = true
        self.generation &+= 1
        _ = self.releaseAll()
        self.cancelActive(code: "stopped", message: "Input stopped because no heartbeat arrived.")
        self.pump()
      }
    }
  }

  private func builtin(_ request: Request) -> Bool {
    switch request.op {
    case "hello":
      guard Set(request.args.keys) == ["protocol"], let range = request.args["protocol"]?.objectValue,
            Set(range.keys) == ["min", "max"], let minimum = range["min"]?.intValue,
            let maximum = range["max"]?.intValue, minimum > 0, maximum > 0 else {
        fail(request, "failed", "Invalid protocol range."); return true
      }
      guard minimum <= Identity.protocolMax, maximum >= Identity.protocolMin else {
        fail(request, "helper_incompatible", "The helper uses an incompatible protocol."); return true
      }
      reply(.success(id: request.id, fields: [
        "protocol": .object(["min": .integer(Int64(Identity.protocolMin)), "max": .integer(Int64(Identity.protocolMax))]),
        "helper": .object(["version": .string(Identity.helperVersion), "platform": .string("macos"), "arch": .string(architecture), "os": .string(operatingSystem)]),
        "features": .object(features().mapValues(JSONValue.bool)),
        "permissions": .object(permissions()),
        "limits": .object(["maxFrameBytes": .integer(Int64(maxFrameBytes))]),
        "responsible": .bool(responsible),
      ]))
      return true
    case "permissions.status":
      guard request.args.isEmpty else { fail(request, "failed", "Invalid permission status arguments."); return true }
      reply(.success(id: request.id, fields: permissions()))
      return true
    case "permissions.request" where !responsible:
      // A helper that does not own attribution may report status, but never enter an OS prompt handler.
      guard Set(request.args.keys) == Set(["service"]),
            let service = request.args["service"]?.stringValue, ["screen", "accessibility"].contains(service) else {
        fail(request, "failed", "Invalid permission request arguments.")
        return true
      }
      reply(.success(id: request.id, fields: permissions()))
      return true
    case "session.begin":
      guard responsible else { fail(request, "responsible_missing", "The helper does not own its OS permissions."); return true }
      guard let next = Self.decodeSession(request.args) else { fail(request, "failed", "Invalid session arguments."); return true }
      if next.mode == "background" && features()["background"] != true { fail(request, "unsupported_action", "Background operation is unavailable."); return true }
      invalidateSessionWork()
      guard !closed else { return true }
      session = next
      halted = false
      physicalPause = false
      armHeartbeat()
      if next.revision != nil {
        let detection = Event(name: "input_detection", fields: ["alive": .bool(false), "reason": .string("probe_missing")])
        emit(detection)
      }
      reply(.success(id: request.id))
      return true
    case "session.update":
      guard var current = session else { fail(request, "unavailable", "No computer session is active."); return true }
      let allowed: Set<String> = ["sessionId", "phaseRevision", "approved", "mode", "escStops", "paused", "overlayWindowIds"]
      guard Set(request.args.keys).isSubset(of: allowed), Self.validUpdate(request.args) else { fail(request, "failed", "Invalid session update arguments."); return true }
      let revision = request.args["phaseRevision"]?.intValue
      if let id = request.args["sessionId"]?.stringValue, id != current.id { fail(request, "changed", "The active session changed."); return true }
      if let previous = current.revision,
         request.args["sessionId"]?.stringValue != current.id || revision == nil || revision! < previous {
        fail(request, "changed", "The computer session phase changed."); return true
      }
      if physicalPause && request.args["paused"]?.boolValue == false { fail(request, "changed", "Physical take-over needs a fresh session."); return true }
      if request.args["mode"]?.stringValue == "background" && features()["background"] != true { fail(request, "unsupported_action", "Background operation is unavailable."); return true }
      invalidateSessionWork()
      guard !closed else { return true }
      current.revision = revision ?? current.revision
      current.mode = request.args["mode"]?.stringValue ?? current.mode
      current.paused = request.args["paused"]?.boolValue ?? current.paused
      current.approved = request.args["approved"]?.arrayValue ?? current.approved
      current.escStops = request.args["escStops"]?.boolValue ?? current.escStops
      current.overlayWindowIds = Self.ids(request.args["overlayWindowIds"]) ?? current.overlayWindowIds
      current.observationEpoch = UUID()
      session = current
      reply(.success(id: request.id))
      return true
    case "session.end":
      guard request.args.isEmpty else { fail(request, "failed", "Invalid session end arguments."); return true }
      invalidateSessionWork()
      guard !closed else { return true }
      cancelHeartbeat?()
      cancelHeartbeat = nil
      session = nil
      reply(.success(id: request.id))
      return true
    default: return false
    }
  }

  private static func id(_ value: JSONValue?) -> String? {
    guard let string = value?.stringValue, !string.isEmpty, string.utf16.count <= 256 else { return nil }
    return string
  }

  private static func ids(_ value: JSONValue?) -> [String]? {
    guard let array = value?.arrayValue, array.allSatisfy({ id($0) != nil }) else { return nil }
    return array.compactMap { id($0) }
  }

  private static func validUpdate(_ fields: [String: JSONValue]) -> Bool {
    if let value = fields["sessionId"], id(value) == nil { return false }
    if let value = fields["phaseRevision"], value.intValue == nil || value.intValue! < 0 || value.intValue! > 9_007_199_254_740_991 { return false }
    if let value = fields["mode"], value.stringValue != "foreground" && value.stringValue != "background" { return false }
    for key in ["paused", "escStops"] { if let value = fields[key], value.boolValue == nil { return false } }
    if let value = fields["approved"] {
      guard let approved = value.arrayValue, SessionPolicy.validApprovals(approved) else { return false }
    }
    if let value = fields["overlayWindowIds"], ids(value) == nil { return false }
    return true
  }

  private static func decodeSession(_ fields: [String: JSONValue]) -> ServerSession? {
    let required: Set<String> = ["sessionId", "mode", "approved", "vectorPids", "vectorWindowIds", "overlayWindowIds", "escStops", "stopChord", "heartbeatMs"]
    guard required.isSubset(of: Set(fields.keys)), Set(fields.keys).isSubset(of: required.union(["paused", "phaseRevision"])),
          validUpdate(fields), let sessionId = id(fields["sessionId"]), let mode = fields["mode"]?.stringValue,
          let approved = fields["approved"]?.arrayValue, let pids = fields["vectorPids"]?.arrayValue,
          pids.allSatisfy({ $0.intValue != nil && $0.intValue! > 0 && $0.intValue! <= 9_007_199_254_740_991 }),
          let vectorIds = ids(fields["vectorWindowIds"]), let overlays = ids(fields["overlayWindowIds"]),
          let escStops = fields["escStops"]?.boolValue, let chord = fields["stopChord"]?.stringValue,
          chord.utf16.count <= 64, fields["heartbeatMs"]?.intValue == 2000 else { return nil }
    return ServerSession(id: sessionId, revision: fields["phaseRevision"]?.intValue, mode: mode,
                         paused: fields["paused"]?.boolValue ?? false, approved: approved,
                         vectorPids: pids.compactMap { $0.intValue }, vectorWindowIds: vectorIds,
                         overlayWindowIds: overlays, escStops: escStops, stopChord: chord)
  }
}
