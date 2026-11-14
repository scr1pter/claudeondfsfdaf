import Foundation

enum HelperCommand: Equatable {
    case version
    case probe
    case serve(parentPID: Int32)
    case worker(parentPID: Int32, probe: Bool)
    case privilegedWorker(parentPID: Int32, target: String, report: String?)
    case selfTest(mode: String, target: String?, report: String?)

    enum UsageError: Error { case invalidArguments }

    static func parse(_ arguments: [String]) throws -> HelperCommand {
        var flags = Set<String>()
        var values: [String: String] = [:]
        var index = 0
        while index < arguments.count {
            let argument = arguments[index]
            if ["--version", "--json", "--probe", "--stdio", "--computer-worker"].contains(argument) {
                guard flags.insert(argument).inserted else { throw UsageError.invalidArguments }
            } else if ["--parent-pid", "--target", "--report"].contains(argument) {
                index += 1
                guard index < arguments.count, values[argument] == nil else { throw UsageError.invalidArguments }
                let value = arguments[index]
                guard !value.isEmpty, value.utf8.count <= 4096, !value.contains("\0"), !value.hasPrefix("--") else {
                    throw UsageError.invalidArguments
                }
                values[argument] = value
            } else if argument.hasPrefix("--self-test=") {
                guard values["self-test"] == nil else { throw UsageError.invalidArguments }
                let mode = String(argument.dropFirst("--self-test=".count))
                guard ["unprivileged", "privileged", "packaged"].contains(mode) else { throw UsageError.invalidArguments }
                values["self-test"] = mode
            } else {
                throw UsageError.invalidArguments
            }
            index += 1
        }
        if let mode = values["self-test"] {
            if let report = values["--report"], !absolutePath(report) { throw UsageError.invalidArguments }
            if mode == "privileged" {
                guard let target = values["--target"], absolutePath(target) else { throw UsageError.invalidArguments }
                if flags == Set(["--computer-worker"]) {
                    guard let pid = parentPID(values["--parent-pid"]) else { throw UsageError.invalidArguments }
                    return .privilegedWorker(parentPID: pid, target: target, report: values["--report"])
                }
            } else if values["--target"] != nil { throw UsageError.invalidArguments }
            guard flags.isEmpty, values["--parent-pid"] == nil else { throw UsageError.invalidArguments }
            return .selfTest(mode: mode, target: values["--target"], report: values["--report"])
        }
        guard values["--target"] == nil, values["--report"] == nil else { throw UsageError.invalidArguments }
        if flags == Set(["--version", "--json"]), values.isEmpty { return .version }
        if flags == Set(["--probe", "--json"]), values.isEmpty { return .probe }
        guard values.count == 1, let pid = parentPID(values["--parent-pid"]) else {
            throw UsageError.invalidArguments
        }
        if flags == Set(["--stdio"]) { return .serve(parentPID: pid) }
        if flags == Set(["--computer-worker", "--stdio"]) { return .worker(parentPID: pid, probe: false) }
        if flags == Set(["--computer-worker", "--probe", "--json"]) { return .worker(parentPID: pid, probe: true) }
        throw UsageError.invalidArguments
    }

    /// Pure syntax only. Launch-time identity validation resolves the actual existing target/parent directory.
    static func absolutePath(_ value: String) -> Bool {
        value.hasPrefix("/") && value.utf8.count <= 4096 &&
            !value.unicodeScalars.contains(where: { $0.value < 0x20 || (0x7f...0x9f).contains($0.value) }) &&
            URL(fileURLWithPath: value).standardizedFileURL.path == value &&
            URL(fileURLWithPath: value).lastPathComponent != "/"
    }

    private static func parentPID(_ value: String?) -> Int32? {
        guard let value, value.utf8.allSatisfy({ (48...57).contains($0) }), let pid = Int32(value), pid > 0 else { return nil }
        return pid
    }
}
