import Foundation

/** The grant-free shipped smoke uses the actual parser and codec. Native scenarios are added by M11. */
func runHelperSelfTest(mode: String, target: String?, report: String?) throws -> Int32 {
    var checks: [JSONValue] = []
    var failed = false
    func record(_ name: String, _ body: () throws -> Bool) {
        let passed = (try? body()) == true
        if !passed { failed = true }
        checks.append(.object(["name": .string(name), "ok": .bool(passed)]))
    }
    if mode != "unprivileged" {
        // These modes never fall back to exercising the owner's desktop. M10/M11 replace this explicit skip.
        let result: JSONValue = .object(["checks": .array([.object([
            "name": .string(mode == "packaged" ? "packaged-native-checks" : "privileged-native-checks"),
            "ok": .bool(false), "skipped": .bool(true),
            "detail": .string("The native scenario is not included in this helper target yet."),
        ])])])
        try writeHelperReport(result, report: report)
        return 77
    }
    record("strict-cli") {
        guard try HelperCommand.parse(["--version", "--json"]) == .version else { return false }
        do {
            _ = try HelperCommand.parse(["--stdio", "--parent-pid", "0"])
            return false
        } catch HelperCommand.UsageError.invalidArguments { return true }
    }
    record("partial-frame-round-trip") {
        let expected = try Request(id: 1, op: "hello", args: ["protocol": .object(["min": .integer(1), "max": .integer(1)])])
        let value = try JSONDecoder().decode(JSONValue.self, from: JSONEncoder().encode(expected))
        let bytes = try FrameWriter.frame(value)
        let reader = FrameReader()
        var received: [Request] = []
        var failures: [Response] = []
        for byte in bytes {
            reader.consume(Data([byte]), onRequest: { received.append($0) }, onFailure: { failures.append($0) })
        }
        return received == [expected] && failures.isEmpty && reader.finish()
    }
    record("malformed-envelope-and-eof") {
        let reader = FrameReader()
        var requests: [Request] = []
        var failures: [Response] = []
        let malformed = try FrameWriter.frame(.object(["id": .integer(0), "op": .string("hello")]))
        reader.consume(malformed, onRequest: { requests.append($0) }, onFailure: { failures.append($0) })
        guard requests.isEmpty, failures.count == 1, failures[0].value["id"]?.intValue == 0 else { return false }
        reader.consume(Data([0, 0]), onRequest: { requests.append($0) }, onFailure: { failures.append($0) })
        return !reader.finish()
    }
    record("oversized-frame-refusal") {
        let reader = FrameReader()
        var failures: [Response] = []
        reader.consume(Data([1, 0, 0, 1]), onRequest: { _ in failed = true }, onFailure: { failures.append($0) })
        return failures.count == 1 && failures[0].value["code"]?.stringValue == "frame_too_large" && !reader.finish()
    }
    try writeHelperReport(.object(["checks": .array(checks)]), report: report)
    return failed ? 1 : 0
}

private func writeHelperReport(_ result: JSONValue, report: String?) throws {
    var bytes = try JSONEncoder().encode(result)
    bytes.append(10)
    if let report {
        try bytes.write(to: URL(fileURLWithPath: report), options: .atomic)
    }
    try FileHandle.standardOutput.write(contentsOf: bytes)
}
