import Foundation

private struct PermissionTestFailure: Error {
    let message: String
}

private func permissionCheck(_ condition: @autoclosure () throws -> Bool, _ message: String) throws {
    if try !condition() { throw PermissionTestFailure(message: message) }
}

private final class PermissionTestState {
    var screen = false
    var accessibility = false
    var postEvent = false
    var screenResult = false
    var accessibilityResult = false
    var postEventResult = false
    var resetResult = true
    var epoch = 1
    var insideFence = false
    var sideEffectsInsideFence = 0
    var reads: [String: Int] = [:]
    var prompts: [String: Int] = [:]
    var commands: [PermissionResetCommand] = []
    var results: [Result<ServerReply, ServerFailure>] = []
    var onScreenRead: (() -> Void)?
    var onAccessibilityRead: (() -> Void)?
    var onPostEventRead: (() -> Void)?
    var onScreenRequest: (() -> Void)?
    var onAccessibilityRequest: (() -> Void)?
    var onPostEventRequest: (() -> Void)?
    var onReset: (() -> Void)?

    func read(_ service: String) -> Bool {
        reads[service, default: 0] += 1
        switch service {
        case "screen": onScreenRead?(); return screen
        case "accessibility": onAccessibilityRead?(); return accessibility
        default: onPostEventRead?(); return postEvent
        }
    }

    func request(_ service: String) -> Bool {
        prompts[service, default: 0] += 1
        if insideFence { sideEffectsInsideFence += 1 }
        switch service {
        case "screen": onScreenRequest?(); return screenResult
        case "accessibility": onAccessibilityRequest?(); return accessibilityResult
        default: onPostEventRequest?(); return postEventResult
        }
    }
}

private final class PermissionTestQueue {
    var work: [() -> Void] = []

    func drain() {
        while !work.isEmpty { work.removeFirst()() }
    }
}

private final class PermissionFixture {
    let state: PermissionTestState
    let queue: PermissionTestQueue
    let service: PermissionService

    init(helperBundleId: String? = Identity.channels[0].helperBundleId) {
        let state = PermissionTestState()
        let queue = PermissionTestQueue()
        self.state = state
        self.queue = queue
        self.service = PermissionService(
            helperBundleId: helperBundleId,
            operations: PermissionOperations(
                screenStatus: { state.read("screen") },
                accessibilityStatus: { state.read("accessibility") },
                postEventStatus: { state.read("postEvent") },
                requestScreen: { state.request("screen") },
                requestAccessibility: { state.request("accessibility") },
                requestPostEvent: { state.request("postEvent") }
            ),
            execute: { queue.work.append($0) },
            resetProcess: { command in
                if state.insideFence { state.sideEffectsInsideFence += 1 }
                state.commands.append(command)
                state.onReset?()
                return state.resetResult
            }
        )
    }

    func context() -> OperationContext {
        let state = state
        let epoch = state.epoch
        return OperationContext(
            session: nil,
            isCurrent: { state.epoch == epoch },
            withCurrent: { body in
                guard state.epoch == epoch else { return false }
                state.insideFence = true
                defer { state.insideFence = false }
                body()
                return true
            }
        )
    }

    func request(_ service: String = "screen", responsible: Bool = true) {
        request(["service": .string(service)], responsible: responsible)
    }

    func request(_ args: [String: JSONValue], responsible: Bool = true) {
        let state = state
        service.request(args, responsible: responsible, context: context()) { state.results.append($0) }
    }

    func reset(_ service: String = "screen", responsible: Bool = true) {
        reset(["service": .string(service)], responsible: responsible)
    }

    func reset(_ args: [String: JSONValue], responsible: Bool = true) {
        let state = state
        service.reset(args, responsible: responsible, context: context()) { state.results.append($0) }
    }

    func success(_ index: Int = 0) throws -> [String: JSONValue] {
        guard index >= 0, index < state.results.count, case .success(let reply) = state.results[index] else {
            throw PermissionTestFailure(message: "Expected a current permission status reply")
        }
        return reply.fields
    }

    func failure(_ index: Int = 0) -> String? {
        guard index >= 0, index < state.results.count, case .failure(let error) = state.results[index] else { return nil }
        return error.code
    }

    func prompts(_ service: String) -> Int { state.prompts[service, default: 0] }
}

/// Every operation, executor and reset command is injected. These tests never instantiate the system operation
/// adapter, execute tccutil, query real OS permission state, request a grant, or touch a native desktop.
func runPermissionsTests() throws -> Int {
    var count = 0
    func test(_ body: () throws -> Void) throws { try body(); count += 1 }

    try test {
        let fake = PermissionFixture()
        let first = fake.service.status()
        try permissionCheck(first == ["screen": .string("denied"), "accessibility": .string("denied"), "postEvent": .string("denied")],
                            "Absent Bool preflights report missing grants without inventing denial history")
        fake.state.screen = true
        fake.state.accessibility = true
        let changed = fake.service.status()
        try permissionCheck(changed["screen"] == .string("granted") && changed["accessibility"] == .string("granted") &&
                            changed["postEvent"] == .string("denied"), "Every status read observes current injected preflights")
        fake.state.screen = false
        fake.state.accessibility = false
        fake.state.postEvent = true
        let latest = fake.service.status()
        try permissionCheck(latest["screen"] == .string("denied") && latest["accessibility"] == .string("denied") &&
                            latest["postEvent"] == .string("granted"), "An earlier grant is never cached in the service")
        try permissionCheck(fake.state.reads == ["screen": 3, "accessibility": 3, "postEvent": 3],
                            "Each status call checks all three required preflights afresh")
        try permissionCheck(fake.state.prompts.isEmpty && fake.state.commands.isEmpty && fake.queue.work.isEmpty,
                            "Status and probe-style reads never request access or reset anything")
    }

    try test {
        try permissionCheck(PermissionService.settingsURL(service: "screen")?.absoluteString ==
                            "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture",
                            "Screen Recording has exactly its fixed System Settings anchor")
        try permissionCheck(PermissionService.settingsURL(service: "accessibility")?.absoluteString ==
                            "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility",
                            "Accessibility has exactly its fixed System Settings anchor")
        for service in ["", "ScreenCapture", "postEvent", "Accessibility", "screen?Privacy_AllFiles",
                        "x-apple.systempreferences:other", "screen; open attacker", "screen\0"] {
            try permissionCheck(PermissionService.settingsURL(service: service) == nil,
                                "No caller-selected pane or shell-shaped service becomes a URL")
        }
    }

    try test {
        let fake = PermissionFixture()
        fake.state.screenResult = true
        fake.request()
        fake.request()
        try permissionCheck(fake.prompts("screen") == 0, "Admission queues work without synchronously requesting access")
        fake.queue.drain()
        try permissionCheck(fake.prompts("screen") == 1 && fake.prompts("accessibility") == 0 && fake.prompts("postEvent") == 0,
                            "Screen Recording is attempted at most once per worker and service")
        try permissionCheck(fake.state.results.count == 2, "Every explicit call receives a current status")
        try permissionCheck(try fake.success()["screen"] == .string("denied"),
                            "A request API's return value cannot optimistically override a still-false preflight")
        fake.request()
        fake.queue.drain()
        try permissionCheck(fake.prompts("screen") == 1, "Repeated clicks direct the user to Settings without another OS request")
        try permissionCheck(fake.state.sideEffectsInsideFence == 0,
                            "A potentially blocking system request must not hold the dispatcher's phase lock")
    }

    try test {
        let fake = PermissionFixture()
        fake.request("accessibility")
        fake.request("accessibility")
        fake.request("screen")
        fake.queue.drain()
        try permissionCheck(fake.prompts("accessibility") == 1 && fake.prompts("postEvent") == 1 && fake.prompts("screen") == 1,
                            "One Accessibility attempt includes its distinct post-event request, and Screen remains independent")
        try permissionCheck(fake.state.sideEffectsInsideFence == 0, "Both Accessibility APIs run outside the dispatcher fence")
    }

    try test {
        let accessibilityGranted = PermissionFixture()
        accessibilityGranted.state.accessibility = true
        accessibilityGranted.request("accessibility")
        accessibilityGranted.queue.drain()
        try permissionCheck(accessibilityGranted.prompts("accessibility") == 0 && accessibilityGranted.prompts("postEvent") == 1,
                            "A granted AX permission does not hide missing post-event permission")
        let postEventGranted = PermissionFixture()
        postEventGranted.state.postEvent = true
        postEventGranted.request("accessibility")
        postEventGranted.queue.drain()
        try permissionCheck(postEventGranted.prompts("accessibility") == 1 && postEventGranted.prompts("postEvent") == 0,
                            "Already granted post-event access is not requested again")
        let allGranted = PermissionFixture()
        allGranted.state.screen = true
        allGranted.state.accessibility = true
        allGranted.state.postEvent = true
        allGranted.request("screen")
        allGranted.request("accessibility")
        allGranted.queue.drain()
        try permissionCheck(allGranted.state.prompts.isEmpty, "No OS request is made for an already granted service")
    }

    try test {
        let fake = PermissionFixture()
        fake.request("screen", responsible: false)
        fake.request("accessibility", responsible: false)
        fake.queue.drain()
        try permissionCheck(fake.state.prompts.isEmpty && fake.state.commands.isEmpty,
                            "A helper without independent responsibility never requests or resets access")
        try permissionCheck(try fake.success()["screen"] == .string("denied"), "An irresponsible request still returns truthful preflight status")
        fake.request("screen")
        fake.request("accessibility")
        fake.queue.drain()
        try permissionCheck(fake.prompts("screen") == 1 && fake.prompts("accessibility") == 1 && fake.prompts("postEvent") == 1,
                            "A responsibility refusal never consumes a future legitimate explicit attempt")
        fake.reset("screen", responsible: false)
        try permissionCheck(fake.failure(fake.state.results.count - 1) == "responsible_missing" && fake.state.commands.isEmpty,
                            "Reset cannot clear any entry when the helper does not own responsibility")
    }

    try test {
        let arguments: [[String: JSONValue]] = [
            [:], ["service": .null], ["service": .bool(true)], ["service": .string("postEvent")],
            ["service": .string("ScreenCapture")], ["service": .string("screen\0")],
            ["service": .string("screen"), "helperBundleId": .string(Identity.channels[0].appId)],
            ["service": .string("screen"), "bundleId": .string(Identity.channels[0].helperBundleId)],
            ["service": .string("accessibility"), "prompt": .bool(true)],
        ]
        for args in arguments {
            let fake = PermissionFixture()
            fake.request(args)
            fake.reset(args)
            fake.queue.drain()
            try permissionCheck(fake.state.results.count == 2 && fake.failure(0) == "failed" && fake.failure(1) == "failed",
                                "Request and reset accept only the exact screen/accessibility argument shape")
            try permissionCheck(fake.state.prompts.isEmpty && fake.state.commands.isEmpty && fake.state.reads.isEmpty,
                                "Malformed arguments are rejected before preflights, prompts, reset or latch mutation")
        }
    }

    try test {
        for channel in Identity.channels {
            let fake = PermissionFixture(helperBundleId: channel.helperBundleId)
            fake.reset("screen")
            fake.reset("accessibility")
            fake.queue.drain()
            try permissionCheck(fake.state.commands == [
                PermissionResetCommand(executable: "/usr/bin/tccutil",
                                       arguments: ["reset", "ScreenCapture", channel.helperBundleId], timeoutMs: 3000),
                PermissionResetCommand(executable: "/usr/bin/tccutil",
                                       arguments: ["reset", "Accessibility", channel.helperBundleId], timeoutMs: 3000),
            ], "Every generated channel resets only its own exact helper identity through a bounded absolute tccutil action")
            try permissionCheck(fake.state.results.count == 2 && fake.failure(0) == nil && fake.failure(1) == nil,
                                "Successful owned resets return fresh status")
            try permissionCheck(fake.state.sideEffectsInsideFence == 0, "The child reset process never blocks the dispatcher fence")
        }
    }

    try test {
        let forbidden: [String?] = [nil, "", Identity.channels[0].appId,
                                   Identity.channels[0].electronHelperIds[0],
                                   Identity.channels[0].helperBundleId + ".replacement", "ai.attacker.computer"]
        for identity in forbidden {
            let fake = PermissionFixture(helperBundleId: identity)
            fake.reset("screen")
            fake.queue.drain()
            try permissionCheck(fake.failure() == "failed" && fake.state.commands.isEmpty,
                                "Missing, parent, Electron or foreign identities can never become reset targets")
        }
    }

    try test {
        let fake = PermissionFixture()
        fake.request("screen")
        fake.request("accessibility")
        fake.queue.drain()
        fake.reset("accessibility")
        fake.queue.drain()
        fake.request("screen")
        fake.request("accessibility")
        fake.queue.drain()
        try permissionCheck(fake.prompts("screen") == 1 && fake.prompts("accessibility") == 2 && fake.prompts("postEvent") == 2,
                            "A successful explicit reset re-arms only its selected service")
        fake.reset("screen")
        fake.queue.drain()
        fake.request("screen")
        fake.queue.drain()
        try permissionCheck(fake.prompts("screen") == 2, "The explicitly reset Screen Recording service may be asked again")
    }

    try test {
        let fake = PermissionFixture()
        fake.request()
        fake.queue.drain()
        fake.state.resetResult = false
        fake.reset()
        fake.queue.drain()
        try permissionCheck(fake.failure(fake.state.results.count - 1) == "failed", "An unsuccessful tccutil result is a wire failure")
        fake.request()
        fake.queue.drain()
        try permissionCheck(fake.prompts("screen") == 1, "A failed reset does not clear the process's previous prompt attempt")
    }

    try test {
        let fake = PermissionFixture()
        fake.request()
        fake.state.epoch += 1
        fake.queue.drain()
        try permissionCheck(fake.failure() == "changed" && fake.state.prompts.isEmpty && fake.state.reads.isEmpty,
                            "A cancelled queued request performs no preflight or OS request")
        fake.request()
        fake.queue.drain()
        try permissionCheck(fake.prompts("screen") == 1, "Cancellation before reservation does not consume the next current attempt")
    }

    try test {
        let fake = PermissionFixture()
        fake.state.onAccessibilityRequest = { fake.state.epoch += 1 }
        fake.request("accessibility")
        fake.queue.drain()
        try permissionCheck(fake.failure() == "changed" && fake.prompts("accessibility") == 1,
                            "Cancellation during Accessibility request discards its late reply")
        try permissionCheck(fake.prompts("postEvent") == 0 && fake.state.reads["postEvent"] == nil,
                            "A cancelled Accessibility prompt must never trigger a delayed post-event prompt or read")
        fake.state.onAccessibilityRequest = nil
        fake.request("accessibility")
        fake.queue.drain()
        try permissionCheck(fake.prompts("accessibility") == 1 && fake.prompts("postEvent") == 0,
                            "A partially attempted service stays latched until explicit successful reset or worker replacement")
    }

    try test {
        let fake = PermissionFixture()
        fake.state.onScreenRead = { fake.state.epoch += 1 }
        fake.request()
        fake.queue.drain()
        try permissionCheck(fake.failure() == "changed" && fake.prompts("screen") == 0,
                            "Cancellation during preflight prevents the following request API")
        fake.state.onScreenRead = nil
        let unresponsible = PermissionFixture()
        unresponsible.state.onPostEventRead = { unresponsible.state.epoch += 1 }
        unresponsible.request(responsible: false)
        try permissionCheck(unresponsible.failure() == "changed", "A status result from a changed epoch is never returned as current")
        unresponsible.state.onPostEventRead = nil
    }

    try test {
        let fake = PermissionFixture()
        fake.request()
        fake.queue.drain()
        fake.reset()
        fake.state.epoch += 1
        fake.queue.drain()
        try permissionCheck(fake.state.commands.isEmpty && fake.failure(fake.state.results.count - 1) == "changed",
                            "A queued reset cancelled before execution cannot invoke tccutil")
        fake.request()
        fake.queue.drain()
        try permissionCheck(fake.prompts("screen") == 1, "Cancelling a reset never silently re-arms its service")
    }

    try test {
        let fake = PermissionFixture()
        fake.request()
        fake.queue.drain()
        fake.state.onReset = {
            fake.state.epoch += 1
            fake.request()
        }
        fake.reset()
        fake.queue.drain()
        try permissionCheck(fake.state.commands.count == 1 && fake.failure(1) == "changed",
                            "A reset finishing after its operation epoch changed cannot clear a successor's latch")
        try permissionCheck(fake.prompts("screen") == 1, "A current queued request cannot repeat a prompt after stale reset completion")
        fake.state.onReset = nil
        fake.reset()
        fake.queue.drain()
        fake.request()
        fake.queue.drain()
        try permissionCheck(fake.prompts("screen") == 2, "A subsequent current explicit reset can still re-arm the service")
    }

    try test {
        let fake = PermissionFixture()
        fake.state.onScreenRequest = {
            fake.state.onScreenRequest = nil
            fake.request()
        }
        fake.request()
        fake.queue.drain()
        try permissionCheck(fake.prompts("screen") == 1 && fake.state.results.count == 2,
                            "The request latch is reserved before a synchronous request callback can re-enter")
        let replacement = PermissionFixture()
        replacement.request()
        replacement.queue.drain()
        try permissionCheck(replacement.prompts("screen") == 1, "A fresh worker's service has an independent explicit-attempt latch")
    }

    try test {
        let fake = PermissionFixture()
        fake.request("screen")
        fake.reset("accessibility")
        fake.service.close()
        fake.service.close()
        fake.queue.drain()
        try permissionCheck(fake.state.results.count == 2 && fake.failure(0) != nil && fake.failure(1) != nil,
                            "Close idempotently fences every queued permission mutation")
        try permissionCheck(fake.state.prompts.isEmpty && fake.state.commands.isEmpty,
                            "A closed worker cannot start a delayed prompt or reset child")
        fake.state.screen = true
        let status = fake.service.status()
        try permissionCheck(status["screen"] == .string("granted") && fake.state.prompts.isEmpty && fake.state.commands.isEmpty,
                            "Even a read after close remains a preflight-only observation")
        fake.request("screen")
        fake.reset("screen")
        fake.queue.drain()
        try permissionCheck(fake.state.prompts.isEmpty && fake.state.commands.isEmpty,
                            "A later current context cannot reopen a closed permission service")
    }

    try test {
        let fake = PermissionFixture()
        fake.state.onAccessibilityRequest = { fake.service.close() }
        fake.request("accessibility")
        fake.queue.drain()
        try permissionCheck(fake.failure() != nil && fake.prompts("accessibility") == 1 && fake.prompts("postEvent") == 0,
                            "Worker close during an Accessibility prompt prevents its follow-up post-event prompt")
        fake.state.onAccessibilityRequest = nil
        fake.request("accessibility")
        fake.queue.drain()
        try permissionCheck(fake.prompts("accessibility") == 1 && fake.prompts("postEvent") == 0,
                            "No late framework return can reopen permission prompting")
    }

    try test {
        let fake = PermissionFixture()
        fake.request("screen")
        fake.queue.drain()
        fake.state.onReset = { fake.service.close() }
        fake.reset("screen")
        fake.queue.drain()
        try permissionCheck(fake.state.commands.count == 1 && fake.failure(1) != nil,
                            "A successful reset returning after worker close cannot publish success or re-arm prompting")
        fake.state.onReset = nil
        fake.request("screen")
        fake.queue.drain()
        try permissionCheck(fake.prompts("screen") == 1, "A closed reset completion cannot cause a later OS prompt")
    }

    return count
}

