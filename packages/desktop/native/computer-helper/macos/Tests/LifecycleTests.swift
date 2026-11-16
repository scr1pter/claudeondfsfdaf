import Darwin
import Foundation

/// Called by the shared standalone test entry. No process launch, privacy request, screen or input access.
func runLifecycleTests() throws -> Int {
    var checks = 0
    func check(_ condition: @autoclosure () -> Bool, _ message: String) throws {
        guard condition() else { throw LifecycleTestFailure(message: message) }
        checks += 1
    }

    try check(!HelperLifecycle.responsibilityMatches(observed: nil, current: 42), "Missing responsibility must fail closed")
    try check(!HelperLifecycle.responsibilityMatches(observed: -1, current: 42), "Failed responsibility lookup must fail closed")
    try check(!HelperLifecycle.responsibilityMatches(observed: 0, current: 42), "PID zero is not a responsible process")
    try check(!HelperLifecycle.responsibilityMatches(observed: 41, current: 42), "Inherited caller responsibility must be refused")
    try check(HelperLifecycle.responsibilityMatches(observed: 42, current: 42), "Only the observed self PID is self responsible")

    let identity = HelperProcessIdentity(pid: 42, parentPID: 1, startSeconds: 123, startMicroseconds: 456, executable: "/fixture/parent")
    let reused = HelperProcessIdentity(pid: 42, parentPID: 1, startSeconds: 124, startMicroseconds: 456, executable: "/fixture/parent")
    let microseconds = HelperProcessIdentity(pid: 42, parentPID: 1, startSeconds: 123, startMicroseconds: 457, executable: "/fixture/parent")
    try check(identity != reused && identity != microseconds, "PID reuse must not retain the original process identity")
    try check(identity != HelperProcessIdentity(pid: 42, parentPID: 7, startSeconds: 123, startMicroseconds: 456, executable: "/fixture/parent"), "Reparenting must invalidate the caller chain")
    try check(identity != HelperProcessIdentity(pid: 42, parentPID: 1, startSeconds: 123, startMicroseconds: 456, executable: "/fixture/replacement"), "An executable replacement must not retain identity")

    for channel in Identity.channels {
        let app = "/Applications/Fixture \(channel.name).app"
        let helper = "\(app)/Contents/Helpers/\(Identity.bundle)/Contents/MacOS/\(Identity.executable)"
        let parent = "\(app)/Contents/MacOS/vector-fixture"
        func topology(_ executable: String? = nil, _ caller: String? = nil, _ appID: String? = nil,
                      _ helperID: String? = nil, _ main: String = "vector-fixture") -> Bool {
            HelperLifecycle.matchesContainingApplication(helperExecutable: executable ?? helper, parentExecutable: caller ?? parent,
                                                          appID: appID ?? channel.appId, helperID: helperID ?? channel.helperBundleId, mainExecutable: main)
        }
        try check(topology(), "Each generated channel must accept its own containing main executable")
        try check(!topology(helper, "\(app)/Contents/Frameworks/Electron Helper.app/Contents/MacOS/Electron Helper"), "An Electron child is not the Vector main caller")
        try check(!topology(helper, "/Applications/Other.app/Contents/MacOS/vector-fixture"), "Another app cannot call this helper")
        try check(!topology(helper, parent, "ai.vector.attacker"), "Unknown channel identities must be refused")
        try check(!topology(helper, parent, channel.appId, "\(channel.appId).helper"), "Electron helper bundle IDs cannot stand in for computer IDs")
        try check(!topology("\(app)/Contents/Resources/\(Identity.bundle)/Contents/MacOS/\(Identity.executable)"), "A relocated helper must not inherit the containing app claim")
        try check(!topology("\(helper).replacement"), "The helper executable name must match generated identity")
        try check(!topology(helper, parent, channel.appId, channel.helperBundleId, "../vector-fixture"), "Main executable metadata cannot traverse directories")
        try check(!topology(helper, parent, channel.appId, channel.helperBundleId, ""), "Missing main executable metadata must fail closed")
    }

    try check(!HelperLifecycle.protocolDescriptorIsValid(-1), "An absent protocol descriptor must be refused")
    let temporary = URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent(UUID().uuidString)
    guard FileManager.default.createFile(atPath: temporary.path, contents: Data()) else { throw LifecycleTestFailure(message: "Could not create descriptor fixture") }
    defer { try? FileManager.default.removeItem(at: temporary) }
    let file = open(temporary.path, O_RDONLY | O_CLOEXEC)
    guard file >= 0 else { throw LifecycleTestFailure(message: "Could not open descriptor fixture") }
    defer { Darwin.close(file) }
    try check(!HelperLifecycle.protocolDescriptorIsValid(file), "A regular file is not a protocol channel")
    var endpoints: [Int32] = [0, 0]
    guard socketpair(AF_UNIX, SOCK_STREAM, 0, &endpoints) == 0 else { throw LifecycleTestFailure(message: "Could not create socket fixture") }
    defer { endpoints.forEach { Darwin.close($0) } }
    try check(HelperLifecycle.protocolDescriptorIsValid(endpoints[0]) && HelperLifecycle.protocolDescriptorIsValid(endpoints[1]), "A real duplex socketpair is an eligible protocol channel")

    try check(HelperLifecycle.exitCode(waitStatus: 0) == 0, "A clean child exit must be preserved")
    try check(HelperLifecycle.exitCode(waitStatus: 7 << 8) == 7, "A failed child exit must be preserved")
    for code in [Int32(0), Int32(1), Int32(2), Int32(77)] {
        try check(HelperLifecycle.exitCode(waitStatus: code << 8) == code, "One-shot pass, failure, usage and skip must survive supervisor reaping")
    }
    let target = "/fixture/tests/VectorComputerTestTarget.app"
    for mode in [HelperWorkerLaunchMode.serving, .probe, .privileged(target: target, report: nil),
                 .privileged(target: target, report: "/fixture/report.json")] {
        let arguments = HelperLifecycle.workerArguments(parentPID: 123, mode: mode)
        let parsed = try HelperCommand.parse(arguments)
        switch mode {
        case .serving:
            try check(mode.usesProtocol && parsed == .worker(parentPID: 123, probe: false), "Only serving inherits the duplex protocol descriptor")
        case .probe:
            try check(!mode.usesProtocol && parsed == .worker(parentPID: 123, probe: true), "Probe remains a one-shot worker without fd3")
        case .privileged(let path, let report):
            try check(!mode.usesProtocol && !arguments.contains("--stdio") && !arguments.contains("--probe") &&
                parsed == .privilegedWorker(parentPID: 123, target: path, report: report), "Privileged reports use their own strict one-shot worker, never protocol serving")
        }
    }
    try check(HelperLifecycle.exitCode(waitStatus: SIGTERM) == 128 + SIGTERM, "A signaled child exit must remain a failure")
    return checks
}

private struct LifecycleTestFailure: Error {
    let message: String
}
