import CoreGraphics
import CryptoKit
import Darwin
import Foundation

private struct PrivilegedSelfTestTestFailure: Error { let message: String }
private func privilegedExpect(_ value: @autoclosure () throws -> Bool, _ message: String) throws {
    if try !value() { throw PrivilegedSelfTestTestFailure(message: message) }
}

private func privilegedEvidence(bundle: String = "/virtual/tests/VectorComputerTestTarget.app", executable: String? = nil,
                                identifier: String = "ai.vector.computer.test-target", sealed: String = "ai.vector.computer.test-target",
                                source: String = String(repeating: "a", count: 64), signature: Bool = true,
                                hardened: Bool = true, empty: Bool = true) -> PrivilegedTargetEvidence {
    PrivilegedTargetEvidence(bundlePath: bundle, executablePath: executable ?? bundle + "/Contents/MacOS/VectorComputerTestTarget",
        identifier: identifier, sealedIdentifier: sealed, sourceDigest: source,
        signatureValid: signature, hardenedRuntime: hardened, emptyEntitlements: empty)
}
private func privilegedRect(_ x: Double, _ y: Double, _ width: Double, _ height: Double) -> JSONValue {
    .object(["x": .number(x), "y": .number(y), "w": .number(width), "h": .number(height)])
}
private func privilegedState(_ evidence: PrivilegedTargetEvidence = privilegedEvidence()) -> JSONValue {
    let hash = SHA256.hash(data: Data("synthetic private value".utf8)).map { String(format: "%02x", $0) }.joined()
    let summary: JSONValue = .object(["length": .integer(23), "sha256": .string(hash),
        "selection": .object(["location": .integer(23), "length": .integer(0)])])
    var views: [String: JSONValue] = [:]
    for (name, bounds) in [("patch", privilegedRect(-180, 100, 160, 100)), ("button", privilegedRect(50, 110, 240, 36)),
                           ("text", privilegedRect(-180, 240, 500, 28)), ("secure", privilegedRect(-180, 310, 500, 28))] {
        views[name] = .object(["identifier": .string("fixture." + name), "bounds": bounds])
    }
    return .object([
        "pid": .integer(101), "parentPID": .integer(100), "bundleID": .string(evidence.identifier),
        "bundlePath": .string(evidence.bundlePath), "executablePath": .string(evidence.executablePath), "sourceDigest": .string(evidence.sourceDigest),
        "ready": .bool(true), "windowNumber": .integer(10), "backdropWindowNumber": .integer(11),
        "windowBounds": privilegedRect(-200, 80, 560, 380), "backdropBounds": privilegedRect(-224, 56, 608, 428),
        "views": .object(views), "patchRGB": .array([.integer(32), .integer(128), .integer(192)]),
        "backdropRGB": .array([.integer(224), .integer(96), .integer(32)]), "counter": .integer(2), "text": summary, "secure": summary,
        "visible": .bool(true), "minimized": .bool(false), "foreground": .bool(true), "postEvent": .bool(false),
        "events": .object(["keyDowns": .integer(0), "keyUps": .integer(0), "buttonDowns": .integer(0), "buttonUps": .integer(0),
            "heldKeys": .integer(0), "heldButtons": .integer(0), "escapes": .integer(0)]),
        "foreignEsc": .object(["status": .string("idle"), "pid": .integer(101), "tag": .string("5654435446474553")]),
    ])
}
private func privilegedReplacing(_ value: JSONValue, _ path: [String], _ replacement: JSONValue?) throws -> JSONValue {
    guard let key = path.first, var fields = value.objectValue else {
        throw PrivilegedSelfTestTestFailure(message: "Invalid synthetic state mutation")
    }
    if path.count == 1 { fields[key] = replacement }
    else {
        guard let child = fields[key] else { throw PrivilegedSelfTestTestFailure(message: "Missing synthetic state parent") }
        fields[key] = try privilegedReplacing(child, Array(path.dropFirst()), replacement)
    }
    return .object(fields)
}
private func privilegedPasses() -> [PrivilegedCheckResult] {
    PrivilegedCheckCatalog.names.map { PrivilegedCheckResult(name: $0, ok: true) }
}

/// Fixed data only: no signature/filesystem queries, permission calls, processes, desktop, app or native scenario.
func runPrivilegedSelfTestTests() throws -> Int {
    var count = 0
    func test(_ body: () throws -> Void) throws { try body(); count += 1 }

    try test {
        let expected = ["privileged-isolated-target", "capture-color-patch", "capture-overlay-exclusion",
            "ax-counter-increment", "ax-value-set-and-readback", "secure-field-refusal", "tagged-click-increments",
            "stale-capture-refusal", "background-ax-without-pointer-or-focus", "background-selection-insertion",
            "helper-tagged-escape-ignored", "foreign-escape-stops", "owned-input-release", "isolated-target-cleanup"]
        try privilegedExpect(PrivilegedCheckCatalog.names == expected && Set(expected).count == 14,
            "The privileged catalog must retain all fourteen concrete scenario names in their fixed order")
        try privilegedExpect(PrivilegedCheckCatalog.reasons == ["responsibility_missing", "accessibility_denied", "screen_denied", "post_event_denied",
            "target_post_event_denied", "noninteractive_desktop", "input_detection_unavailable", "physical_takeover", "target_unavailable",
            "target_validation_failed", "target_spawn_failed", "target_handshake_failed", "target_process_changed",
            "target_responsibility_missing", "target_state_invalid", "target_identity_unavailable",
            "target_options_invalid", "target_bundle_invalid", "target_control_invalid", "target_application_failed",
            "target_report_invalid", "target_encoding_failed", "target_output_failed", "target_exited", "target_crashed",
            "assertion_failed", "native_operation_failed", "deadline_exceeded", "cleanup_failed"],
            "Reports may use only the bounded machine-readable reason vocabulary")
        for stage in PrivilegedTargetStage.allCases {
            var checks = privilegedPasses()
            checks[0] = PrivilegedCheckResult(name: PrivilegedCheckCatalog.names[0], ok: false, detail: stage.rawValue)
            let report = PrivilegedCheckReport(checks: checks)
            try privilegedExpect(report.valid && report.exitCode == 1 && report.wire["checks"]?.arrayValue?.first?["detail"] == .string(stage.rawValue),
                "Every setup stage remains a real failure with a fixed content-free diagnostic")
        }
        for (code, expected) in [(20, PrivilegedTargetStage.options), (21, .bundle), (22, .control),
                                 (23, .application), (24, .state), (25, .output), (26, .encoding), (0, .exited), (1, .exited)] {
            try privilegedExpect(PrivilegedTargetStage.failure(waitStatus: Int32(code << 8)) == expected,
                "Private startup exit codes must remain fixed and content-free")
        }
        try privilegedExpect(PrivilegedTargetStage.failure(waitStatus: 9) == .crashed,
            "A signalled target remains a failure without reporting a crash payload")
    }
    try test {
        let report = PrivilegedCheckReport(checks: privilegedPasses())
        try privilegedExpect(report.valid && report.exitCode == 0, "Every required successful scenario produces exit0")
        guard let wire = report.wire.objectValue, let checks = wire["checks"]?.arrayValue else {
            throw PrivilegedSelfTestTestFailure(message: "Missing fixed report envelope")
        }
        try privilegedExpect(Set(wire.keys) == ["checks"] && checks.count == 14 && checks.allSatisfy {
            $0.objectValue.map { Set($0.keys) == ["name", "ok"] } == true && $0["ok"] == .bool(true)
        }, "A successful report exposes only fixed names and success booleans")
    }
    try test {
        for reason in PrivilegedCheckCatalog.reasons {
            let report = PrivilegedCheckReport.skipped(reason)
            try privilegedExpect(report.valid && report.exitCode == 77 && report.checks.allSatisfy { !$0.ok && $0.skipped && $0.detail == reason },
                "A declared skipped catalog must remain an explicit exit77 rather than an all-green result")
            try privilegedExpect(report.wire["checks"]?.arrayValue?.allSatisfy {
                $0["ok"] == .bool(false) && $0["skipped"] == .bool(true) && $0["detail"] == .string(reason)
            } == true, "A skipped wire record preserves its finite reason code")
        }
    }
    try test {
        for index in PrivilegedCheckCatalog.names.indices {
            var checks = privilegedPasses()
            checks[index] = PrivilegedCheckResult(name: checks[index].name, ok: false, skipped: true, detail: "screen_denied")
            try privilegedExpect(PrivilegedCheckReport(checks: checks).exitCode == 77, "One real skip makes a mixed successful report exit77")
            let failed = (index + 1) % checks.count
            checks[failed] = PrivilegedCheckResult(name: checks[failed].name, ok: false, detail: "assertion_failed")
            let report = PrivilegedCheckReport(checks: checks)
            try privilegedExpect(report.valid && report.exitCode == 1, "Any actual failure takes precedence over otherwise valid skips")
        }
    }
    try test {
        let base = privilegedPasses()
        var swapped = base; swapped.swapAt(1, 2)
        var duplicate = base; duplicate[1] = duplicate[0]
        var unknown = base; unknown[0] = PrivilegedCheckResult(name: "arbitrary-private-detail", ok: true)
        for checks in [Array(base.dropLast()), base + [base[0]], swapped, duplicate, unknown, []] {
            let report = PrivilegedCheckReport(checks: checks)
            try privilegedExpect(!report.valid && report.exitCode == 1,
                "Missing, extra, reordered, duplicate and unknown scenarios cannot masquerade as a completed catalog")
            try privilegedExpect(report.wire["checks"]?.arrayValue?.compactMap { $0["name"]?.stringValue } == PrivilegedCheckCatalog.names &&
                report.wire["checks"]?.arrayValue?.allSatisfy { $0["ok"] == .bool(false) && $0["detail"] == .string("native_operation_failed") } == true,
                "Even an invalid report serializes a fixed failure catalog without reflecting arbitrary scenario names")
        }
    }
    try test {
        var checks = privilegedPasses()
        checks[0] = PrivilegedCheckResult(name: checks[0].name, ok: true, skipped: true, detail: "screen_denied")
        try privilegedExpect(!PrivilegedCheckReport(checks: checks).valid && PrivilegedCheckReport(checks: checks).exitCode == 1,
            "A skipped check cannot simultaneously claim success")
        for detail in ["", "raw typed content", "/private/screenshot.png", "screen_denied\nprivate", "ASSERTION_FAILED"] {
            checks = privilegedPasses()
            checks[0] = PrivilegedCheckResult(name: checks[0].name, ok: false, detail: detail)
            let report = PrivilegedCheckReport(checks: checks)
            try privilegedExpect(!report.valid && report.exitCode == 1,
                "A failure detail is a fixed reason code, never raw text, a path or an arbitrary native error")
            try privilegedExpect(report.wire["checks"]?.arrayValue?.allSatisfy { $0["detail"] == .string("native_operation_failed") } == true,
                "Invalid details are replaced by a finite reason before serialization, including failure reports")
        }
    }
    try test {
        let evidence = privilegedEvidence()
        try privilegedExpect(PrivilegedTargetPolicy.valid(evidence, expectedSource: String(repeating: "a", count: 64)),
            "A canonical isolated fixture with matching sealed identity, digest, runtime and empty entitlements is admissible")
        for path in ["relative/VectorComputerTestTarget.app", "/virtual/../VectorComputerTestTarget.app", "/virtual/./VectorComputerTestTarget.app",
                     "/virtual/VectorComputerTestTarget.app/", "/virtual/VectorComputerTestTarget.app.replacement", "/virtual/Other.app",
                     "/virtual/VectorComputerTestTarget.app\0"] {
            try privilegedExpect(!PrivilegedTargetPolicy.valid(privilegedEvidence(bundle: path), expectedSource: evidence.sourceDigest),
                "A target proof cannot substitute a relative, noncanonical, lookalike or wrong bundle path")
        }
        for executable in ["/virtual/VectorComputerTestTarget", evidence.bundlePath + "/Contents/MacOS/Other",
                           evidence.executablePath + "/../VectorComputerTestTarget", evidence.executablePath + "\0"] {
            try privilegedExpect(!PrivilegedTargetPolicy.valid(privilegedEvidence(executable: executable), expectedSource: evidence.sourceDigest),
                "The executable must be exactly the canonical binary inside the verified target bundle")
        }
    }
    try test {
        let source = String(repeating: "a", count: 64)
        for evidence in [privilegedEvidence(identifier: "ai.vector.computer"), privilegedEvidence(sealed: "ai.vector.computer"),
                         privilegedEvidence(source: String(repeating: "b", count: 64)), privilegedEvidence(signature: false),
                         privilegedEvidence(hardened: false), privilegedEvidence(empty: false)] {
            try privilegedExpect(!PrivilegedTargetPolicy.valid(evidence, expectedSource: source),
                "A matching filename never waives actual signature, sealed bundle identity, source, hardened runtime or entitlement evidence")
        }
        for source in ["", String(repeating: "a", count: 63), String(repeating: "A", count: 64), String(repeating: "g", count: 64)] {
            try privilegedExpect(!PrivilegedTargetPolicy.valid(privilegedEvidence(source: source), expectedSource: source),
                "Even equal source claims must use the exact lowercase64-hex artifact digest grammar")
        }
    }
    try test {
        try privilegedExpect(PrivilegedTargetPolicy.hex(String(repeating: "a", count: 32), count: 32) &&
            PrivilegedTargetPolicy.hex(String(repeating: "0", count: 64), count: 64), "Canonical nonce and digest widths remain distinct")
        for value in [String(repeating: "Ａ", count: 64), String(repeating: "a", count: 65), String(repeating: "a", count: 63),
                      String(repeating: "A", count: 64), String(repeating: "a", count: 63) + "\n"] {
            try privilegedExpect(!PrivilegedTargetPolicy.hex(value, count: 64), "Unicode lookalikes, controls, case and width mismatches cannot alias an artifact digest")
        }
    }
    try test {
        try privilegedExpect(PrivilegedTargetPolicy.rect(privilegedRect(-200.5, 40.25, 12.5, 20)) == CGRect(x: -200.5, y: 40.25, width: 12.5, height: 20),
            "Actual Quartz geometry retains finite negative origins and fractional points")
        for (index, value) in [privilegedRect(0, 0, 0, 2), privilegedRect(0, 0, -1, 2), privilegedRect(0, 0, 1, -2), privilegedRect(Double.nan, 0, 1, 2),
                      privilegedRect(0, Double.infinity, 1, 2), privilegedRect(Double.greatestFiniteMagnitude, 0, Double.greatestFiniteMagnitude, 2),
                      JSONValue.object(["x": .bool(true), "y": .integer(0), "w": .integer(1), "h": .integer(1)]),
                      .object(["x": .integer(0), "y": .integer(0), "w": .integer(1), "h": .integer(1), "text": .string("private")])].enumerated() {
            try privilegedExpect(PrivilegedTargetPolicy.rect(value) == nil, "Malformed, overflowing or extra-field rectangles cannot become target geometry (case \(index + 1))")
        }
    }
    try test {
        let evidence = privilegedEvidence(), state = privilegedState()
        try privilegedExpect(PrivilegedTargetPolicy.state(state, pid: 101, parent: 100, evidence: evidence),
            "A complete synthetic fixture state validates without observing any process, file or desktop")
        let bytes = try JSONEncoder().encode(state)
        try privilegedExpect(bytes.count < 16 * 1024 && String(data: bytes, encoding: .utf8)?.contains("synthetic private value") == false &&
            state["text"]?["sha256"]?.stringValue?.utf8.count == 64 && state["secure"]?["sha256"]?.stringValue?.utf8.count == 64,
            "The finite private state contains only text length/hash summaries and remains bounded")
    }
    try test {
        let evidence = privilegedEvidence(), state = privilegedState()
        let changes: [([String], JSONValue?)] = [
            (["pid"], .integer(102)), (["parentPID"], .integer(99)), (["pid"], .bool(true)), (["bundleID"], .string("ai.vector.computer")),
            (["bundlePath"], .string("/virtual/Other.app")), (["executablePath"], .string("/virtual/Other")),
            (["sourceDigest"], .string(String(repeating: "b", count: 64))), (["ready"], .bool(false)), (["ready"], .integer(1)),
            (["windowNumber"], .integer(0)), (["windowNumber"], .integer(Int64(UInt32.max) + 1)), (["backdropWindowNumber"], .integer(10)),
            (["counter"], .integer(-1)), (["counter"], .integer(1_000_001)), (["visible"], .string("true")), (["postEvent"], nil),
        ]
        for (path, value) in changes {
            try privilegedExpect(!PrivilegedTargetPolicy.state(try privilegedReplacing(state, path, value), pid: 101, parent: 100, evidence: evidence),
                "Every state remains bound to exact native PID/parent/artifact/window metadata and real booleans")
        }
        let zero = try privilegedReplacing(privilegedReplacing(state, ["pid"], .integer(0)), ["parentPID"], .integer(0))
        try privilegedExpect(!PrivilegedTargetPolicy.state(zero, pid: 0, parent: 0, evidence: evidence), "Even matching expected process identifiers must refer to real non-system fixture processes")
    }
    try test {
        let evidence = privilegedEvidence(), state = privilegedState()
        for path in [["typedText"], ["screenshotBytes"], ["text", "value"], ["secure", "value"],
                     ["text", "selection", "text"], ["views", "patch", "text"], ["foreignEsc", "key"], ["events", "keys"]] {
            let changed = try privilegedReplacing(state, path, .string("MUST_NOT_BECOME_REPORT_DATA"))
            try privilegedExpect(!PrivilegedTargetPolicy.state(changed, pid: 101, parent: 100, evidence: evidence),
                "Unknown state fields cannot smuggle typed text, key identity or image data into an accepted evidence record")
        }
    }
    try test {
        let evidence = privilegedEvidence(), state = privilegedState()
        let changes: [([String], JSONValue?)] = [
            (["backdropBounds"], state["windowBounds"]), (["backdropBounds"], privilegedRect(1000, 1000, 100, 100)),
            (["views", "patch", "bounds"], privilegedRect(-500, 100, 10, 10)), (["views", "button", "identifier"], .string("other.button")),
            (["views", "secure"], nil), (["views", "other"], .object([:])),
            (["patchRGB"], .array([.integer(1), .integer(2), .integer(3)])), (["backdropRGB"], .array([.integer(32), .integer(128), .integer(192)])),
        ]
        for (path, replacement) in changes {
            try privilegedExpect(!PrivilegedTargetPolicy.state(try privilegedReplacing(state, path, replacement), pid: 101, parent: 100, evidence: evidence),
                "Distinct containing own-window geometry and exact fixed-view/color identities prevent sampling an unrelated desktop surface")
        }
    }
    try test {
        let evidence = privilegedEvidence(), state = privilegedState()
        for name in ["text", "secure"] {
            let changes: [([String], JSONValue?)] = [
                (["length"], .integer(-1)), (["length"], .integer(4001)), (["length"], .bool(true)),
                (["sha256"], .string(String(repeating: "A", count: 64))), (["sha256"], nil),
                (["selection", "location"], .integer(24)), (["selection", "length"], .integer(1)),
                (["selection", "location"], .integer(-1)), (["selection", "length"], .integer(9_007_199_254_740_991)),
            ]
            for (suffix, replacement) in changes {
                try privilegedExpect(!PrivilegedTargetPolicy.state(try privilegedReplacing(state, [name] + suffix, replacement), pid: 101, parent: 100, evidence: evidence),
                    "Text metadata has finite UTF16 lengths, exact lowercase hashes and bounded selection arithmetic")
            }
            let missing = try privilegedReplacing(state, [name, "selection"], nil)
            let null = try privilegedReplacing(state, [name, "selection"], .null)
            try privilegedExpect(PrivilegedTargetPolicy.state(missing, pid: 101, parent: 100, evidence: evidence) &&
                PrivilegedTargetPolicy.state(null, pid: 101, parent: 100, evidence: evidence), "An unavailable selection is explicit absence, never a fabricated caret")
        }
    }
    try test {
        let evidence = privilegedEvidence(), state = privilegedState()
        let boundary = try privilegedReplacing(privilegedReplacing(state, ["events", "heldKeys"], .integer(128)), ["events", "heldButtons"], .integer(8))
        try privilegedExpect(PrivilegedTargetPolicy.state(boundary, pid: 101, parent: 100, evidence: evidence), "Held counters accept their exact finite bounds")
        let changes: [([String], JSONValue?)] = [
            (["events", "heldKeys"], .integer(129)), (["events", "heldButtons"], .integer(9)), (["events", "keyUps"], .integer(-1)),
            (["events", "buttonDowns"], .integer(1_000_001)), (["events", "escapes"], .string("1")),
            (["foreignEsc", "pid"], .integer(102)), (["foreignEsc", "tag"], .string("564543544f52484e")),
            (["foreignEsc", "tag"], .integer(1)), (["foreignEsc", "status"], .string("unverified")),
        ]
        for (path, replacement) in changes {
            try privilegedExpect(!PrivilegedTargetPolicy.state(try privilegedReplacing(state, path, replacement), pid: 101, parent: 100, evidence: evidence),
                "Event metadata cannot claim another process/helper tag, arbitrary status or unbounded owned state")
        }
        for status in ["idle", "posted", "not_granted", "not_foreground", "not_isolated", "failed"] {
            let changed = try privilegedReplacing(state, ["foreignEsc", "status"], .string(status))
            try privilegedExpect(PrivilegedTargetPolicy.state(changed, pid: 101, parent: 100, evidence: evidence), "Every declared foreign-Escape status remains finite and explicit")
        }
    }
    return count
}
