import CoreGraphics
import Foundation

private struct OverlayDriverTestFailure: Error { let message: String }
private func overlayDriverCheck(_ condition: @autoclosure () -> Bool, _ message: String) throws {
    if !condition() { throw OverlayDriverTestFailure(message: message) }
}

// Pure finite-policy boundary tests only. No process, window, grant, capture or input API is called.
// Checkpoint 72 explicitly compiles this file with Policy.swift and invokes this function.
func runOverlayDriverPolicyTests() throws -> Int {
    let nonce = String(repeating: "a", count: 64), source = String(repeating: "b", count: 64)
    let options = OverlayDriverOptions(parent: 42, nonce: nonce)
    let start = "123456:123"
    let cli = ["--overlay-stop", "--parent-pid", "42", "--nonce", nonce]
    func rectangle(_ x: Double, _ y: Double, _ w: Double, _ h: Double) -> JSONValue {
        .object(["x": .number(x), "y": .number(y), "w": .number(w), "h": .number(h)])
    }
    func fields() -> [String: JSONValue] {
        ["protocol": .integer(1), "nonce": .string(nonce), "parentPID": .integer(42),
         "parentCreationTime": .string(start), "sourceDigest": .string(source), "bannerWindowId": .string("100"),
         "bannerBounds": rectangle(-200, 20, 600, 90), "stopBounds": rectangle(250, 40, 80, 40),
         "bannerTitle": .string("Vector computer smoke " + nonce), "glowWindowIds": .array([.string("101"), .string("102")])]
    }
    func decode(_ values: [String: JSONValue]) -> OverlayDriverRequest? {
        OverlayDriverRequest.decode(.object(values), options: options, start: start, source: source)
    }
    var count = 0
    func test(_ body: () throws -> Void) rethrows { try body(); count += 1 }

    try test {
        try overlayDriverCheck(OverlayDriverOptions.parse(cli) == options, "overlay-driver.exact-public-cli")
        let worker = OverlayDriverOptions.parse(["--overlay-worker", "--parent-pid", "42", "--supervisor-pid", "43", "--nonce", nonce])
        try overlayDriverCheck(worker == OverlayDriverOptions(parent: 42, nonce: nonce, supervisor: 43), "overlay-driver.exact-private-topology")
        try overlayDriverCheck(OverlayDriverOptions.parse(["--overlay-worker", "--parent-pid", "42", "--supervisor-pid", "42", "--nonce", nonce]) == nil, "overlay-driver.no-parent-supervisor-alias")
    }
    try test {
        for value in ["", "0", "1", "042", "-42", "+42", "42 ", "42.0", "2147483648", "4294967295"] {
            var arguments = cli; arguments[2] = value
            try overlayDriverCheck(OverlayDriverOptions.parse(arguments) == nil, "overlay-driver.parent-is-canonical-native-pid")
        }
        var arguments = cli; arguments[2] = "2147483647"
        try overlayDriverCheck(OverlayDriverOptions.parse(arguments)?.parent == Int32.max, "overlay-driver.native-pid-boundary")
    }
    try test {
        for value in [String(repeating: "a", count: 63), String(repeating: "a", count: 65), String(repeating: "A", count: 64),
                      String(repeating: "g", count: 64), String(repeating: "\0", count: 64), ""] {
            var arguments = cli; arguments[4] = value
            try overlayDriverCheck(OverlayDriverOptions.parse(arguments) == nil, "overlay-driver.nonce-is-exact-private-hex")
        }
        for argument in ["--stdio", "--click", "--script=other.mjs", "--target-pid=90", "--report=private.txt", "--no-sandbox"] {
            try overlayDriverCheck(OverlayDriverOptions.parse(cli + [argument]) == nil, "overlay-driver.no-generic-command-extension")
        }
        var reordered = cli; reordered.swapAt(1, 3)
        try overlayDriverCheck(OverlayDriverOptions.parse(reordered) == nil, "overlay-driver.no-cli-ambiguity")
    }
    try test {
        for value in ["0:0", "0123:1", "123:01", "123:1000000", "123:-1", "123:1:1", "123", ":1", "1:", "+1:1", "1: 1"] {
            try overlayDriverCheck(!OverlayDriverPolicy.start(value), "overlay-driver.kernel-start-is-lossless-canonical-microseconds")
        }
        try overlayDriverCheck(OverlayDriverPolicy.start("18446744073709551615:999999"), "overlay-driver.kernel-start-retains-full-integer-range")
        try overlayDriverCheck(OverlayDriverPolicy.window("4294967295") == UInt32.max, "overlay-driver-window-id-retains-full-native-range")
        for value in ["0", "0100", "-1", "+100", "100.0", "4294967296", ""] {
            try overlayDriverCheck(OverlayDriverPolicy.window(value) == nil, "overlay-driver.window-id-is-not-coerced")
        }
    }
    try test {
        let request = decode(fields())
        try overlayDriverCheck(request?.banner == 100 && request?.parent == 42 && request?.glows == [101, 102] && request?.start == start,
            "overlay-driver.private-wire-retains-native-scope")
        var value = fields(); value.removeValue(forKey: "glowWindowIds")
        try overlayDriverCheck(decode(value)?.glows.isEmpty == true, "overlay-driver.capture-prerequisite-is-explicitly-optional")
    }
    try test {
        for key in fields().keys where key != "glowWindowIds" {
            var value = fields(); value.removeValue(forKey: key)
            try overlayDriverCheck(decode(value) == nil, "overlay-driver.no-missing-admission-field")
        }
        for key in ["x", "pid", "command", "keys", "path", "text", "op", "captureApp"] {
            var value = fields(); value[key] = .string("unclassified authority")
            try overlayDriverCheck(decode(value) == nil, "overlay-driver.no-arbitrary-input-capture-or-output-authority")
        }
    }
    try test {
        let substitutions: [(String, JSONValue)] = [("protocol", .integer(2)), ("protocol", .string("1")), ("protocol", .bool(true)),
            ("parentPID", .integer(43)), ("parentPID", .string("42")), ("parentPID", .bool(true)),
            ("nonce", .string(source)), ("parentCreationTime", .string("123456:124")),
            ("parentCreationTime", .integer(123456)), ("sourceDigest", .string(nonce)), ("sourceDigest", .string(source.uppercased())),
            ("bannerWindowId", .integer(100)), ("bannerWindowId", .string("0100")),
            ("bannerTitle", .string("Vector computer smoke " + nonce + " "))]
        for (key, replacement) in substitutions {
            var value = fields(); value[key] = replacement
            try overlayDriverCheck(decode(value) == nil, "overlay-driver.no-identity-protocol-or-title-substitution")
        }
        try overlayDriverCheck(OverlayDriverRequest.decode(.object(fields()), options: options, start: "0123456:123", source: source) == nil,
            "overlay-driver.even-expected-start-must-be-canonical")
        try overlayDriverCheck(OverlayDriverRequest.decode(.object(fields()), options: options, start: start, source: String(repeating: "z", count: 64)) == nil,
            "overlay-driver.expected-source-cannot-authorize-malformed-digest")
    }
    try test {
        for values in [[JSONValue.string("101"), .string("101")], [.string("100")], [.integer(101)], [.string("0")], [.string("0101")], [.bool(true)]] {
            var value = fields(); value["glowWindowIds"] = .array(values)
            try overlayDriverCheck(decode(value) == nil, "overlay-driver.glow-family-has-unique-native-ids-outside-banner")
        }
        var value = fields(); value["glowWindowIds"] = .array((101...356).map { .string(String($0)) })
        try overlayDriverCheck(decode(value)?.glows.count == 256, "overlay-driver.glow-family-boundary-is-finite")
        value["glowWindowIds"] = .array((101...357).map { .string(String($0)) })
        try overlayDriverCheck(decode(value) == nil, "overlay-driver.glow-family-cannot-grow-unbounded")
        value["glowWindowIds"] = .object([:])
        try overlayDriverCheck(decode(value) == nil, "overlay-driver.glow-family-is-not-coerced")
    }
    try test {
        for invalid in [rectangle(0, 0, 0, 20), rectangle(0, 0, -1, 20), rectangle(0, 0, 20, -1), rectangle(0, 0, 16385, 20),
                        rectangle(.infinity, 0, 20, 20), rectangle(0, .nan, 20, 20), rectangle(-1000001, 0, 20, 20)] {
            try overlayDriverCheck(OverlayDriverRect.decode(invalid) == nil, "overlay-driver.rejects-unbounded-or-nonfinite-geometry")
        }
        try overlayDriverCheck(OverlayDriverRect.decode(rectangle(-200, -300, 80, 40)) != nil, "overlay-driver.accepts-real-negative-display-origins")
        var extra = rectangle(1, 2, 3, 4).objectValue!; extra["destination"] = .integer(90)
        try overlayDriverCheck(OverlayDriverRect.decode(.object(extra)) == nil, "overlay-driver.rectangle-carries-no-extra-authority")
        extra = rectangle(1, 2, 3, 4).objectValue!; extra["w"] = .bool(true)
        try overlayDriverCheck(OverlayDriverRect.decode(.object(extra)) == nil, "overlay-driver.boolean-is-not-a-coordinate")
    }
    try test {
        for bounds in [rectangle(-201, 40, 80, 40), rectangle(250, 90, 80, 40), rectangle(250, 40, 151, 40)] {
            var value = fields(); value["stopBounds"] = bounds
            try overlayDriverCheck(decode(value) == nil, "overlay-driver.stop-hint-must-fit-owned-banner")
        }
        let native = OverlayDriverRect(x: -200, y: -50, w: 80, h: 40)
        try overlayDriverCheck(native.matchesHint(OverlayDriverRect(x: -199, y: -51, w: 81, h: 39)), "overlay-driver.hint-allows-one-logical-point-rounding")
        try overlayDriverCheck(!native.matchesHint(OverlayDriverRect(x: -198.99, y: -50, w: 80, h: 40)), "overlay-driver.hint-cannot-retarget-native-center")
        try overlayDriverCheck(native != OverlayDriverRect(x: -199, y: -50, w: 80, h: 40), "overlay-driver.native-reobservation-requires-exact-bounds")
    }
    try test {
        let result = OverlayDriverResult(stop: OverlayDriverOutcome(ok: true), capture: OverlayDriverOutcome(ok: true))
        try overlayDriverCheck(result.exitCode == 0, "overlay-driver.complete-native-success-exit")
        try overlayDriverCheck(Set(result.wire.objectValue?.keys.map { $0 } ?? []) == ["id", "ok", "protocol", "check", "capture"],
            "overlay-driver.final-report-has-no-observed-text-image-title-path-or-private-channel-fact")
        try overlayDriverCheck(result.wire["id"]?.intValue == 1 && result.wire["protocol"]?.intValue == 1 && result.wire["check"]?.stringValue == "native-os-stop",
            "overlay-driver.fixed-final-report-catalog")
    }
    try test {
        for reason in OverlayDriverReason.allCases {
            let skipped = OverlayDriverOutcome.skip(reason)
            if reason.maySkip {
                try overlayDriverCheck(skipped.valid && skipped.skipped && OverlayDriverResult(stop: skipped).exitCode == 77,
                    "overlay-driver-only-positive-prerequisites-may-skip")
            } else {
                try overlayDriverCheck(skipped.valid && !skipped.skipped && skipped.reason == .assertionFailed && OverlayDriverResult(stop: skipped).exitCode == 1,
                    "overlay-driver-assertion-admission-source-and-cleanup-failures-never-skip")
            }
        }
    }
    try test {
        for malformed in [OverlayDriverOutcome(ok: true, skipped: true, reason: .screenDenied), OverlayDriverOutcome(ok: true, reason: .parentInvalid),
                          OverlayDriverOutcome(ok: false), OverlayDriverOutcome(ok: false, skipped: true),
                          OverlayDriverOutcome(ok: false, skipped: true, reason: .assertionFailed)] {
            try overlayDriverCheck(!malformed.valid && OverlayDriverResult(stop: malformed).exitCode == 1,
                "overlay-driver-inconsistent-result-cannot-pass-or-skip")
            try overlayDriverCheck(malformed.wire == .object(["ok": .bool(false), "reason": .string("assertion_failed")]),
                "overlay-driver-invalid-report-is-sanitized-before-write")
        }
    }
    try test {
        let skipped = OverlayDriverOutcome.skip(.screenDenied), failed = OverlayDriverOutcome(ok: false, reason: .cleanupFailed), passed = OverlayDriverOutcome(ok: true)
        try overlayDriverCheck(OverlayDriverResult(stop: passed, capture: skipped).exitCode == 77, "overlay-driver-native-stop-does-not-hide-missing-capture-evidence")
        try overlayDriverCheck(OverlayDriverResult(stop: skipped, capture: failed).exitCode == 1 && OverlayDriverResult(stop: failed, capture: skipped).exitCode == 1,
            "overlay-driver-failure-takes-precedence-over-a-prerequisite-skip")
    }
    try test {
        let bounds = OverlayDriverRect(x: -1920, y: -200, w: 1920, h: 1080), strips = OverlayDriverPolicy.strips(bounds)
        try overlayDriverCheck(strips.count == 4 && Set(strips.map { "\($0.x):\($0.y):\($0.w):\($0.h)" }).count == 4 && strips.allSatisfy { bounds.contains($0) },
            "overlay-driver-expects-four-contained-strips-on-negative-origin-display")
        try overlayDriverCheck(strips[0] == OverlayDriverRect(x: -1920, y: -200, w: 1920, h: 24) && strips[1] == OverlayDriverRect(x: -24, y: -176, w: 24, h: 1032),
            "overlay-driver-edge-evidence-uses-product-native-strip-geometry")
        let small = OverlayDriverPolicy.strips(OverlayDriverRect(x: 0, y: 0, w: 9, h: 6))
        try overlayDriverCheck(small.count == 4 && small.allSatisfy { $0.valid } && small[0].h == 2 && small[1].h == 2,
            "overlay-driver-strip-clamp-preserves-positive-small-display-bounds")
        try overlayDriverCheck(OverlayDriverPolicy.strips(OverlayDriverRect(x: 0, y: 0, w: 2, h: 2)).isEmpty,
            "overlay-driver-never-invents-zero-width-glow-evidence")
    }
    try test {
        try overlayDriverCheck(OverlayDriverPolicy.violet(100, 80, 150) && OverlayDriverPolicy.violet(32, 49, 64), "overlay-driver-fixed-violet-edge-predicate")
        let unrelated: [(UInt8, UInt8, UInt8)] = [(31, 0, 64), (32, 50, 64), (60, 0, 69), (32, 0, 63), (0, 0, 0), (255, 255, 255), (0, 0, 255)]
        for pixel in unrelated {
            try overlayDriverCheck(!OverlayDriverPolicy.violet(pixel.0, pixel.1, pixel.2), "overlay-driver-unrelated-edge-color-is-not-glow-proof")
        }
    }
    return count
}
