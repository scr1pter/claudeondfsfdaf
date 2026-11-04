import Foundation

enum HelperCommand: Equatable {
    case version
    case probe
    case serve(parentPID: Int32)
    case worker(parentPID: Int32, probe: Bool)
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
                guard !value.isEmpty, value.utf8.count <= 16_384, !value.contains("\0"), !value.hasPrefix("--") else {
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
            guard flags.isEmpty, values["--parent-pid"] == nil else { throw UsageError.invalidArguments }
            return .selfTest(mode: mode, target: values["--target"], report: values["--report"])
        }
        guard values["--target"] == nil, values["--report"] == nil else { throw UsageError.invalidArguments }
        if flags == Set(["--version", "--json"]), values.isEmpty { return .version }
        if flags == Set(["--probe", "--json"]), values.isEmpty { return .probe }
        guard let rawPID = values["--parent-pid"], values.count == 1,
              rawPID.utf8.allSatisfy({ $0 >= 48 && $0 <= 57 }), let pid = Int32(rawPID), pid > 0 else {
            throw UsageError.invalidArguments
        }
        if flags == Set(["--stdio"]) { return .serve(parentPID: pid) }
        if flags == Set(["--computer-worker", "--stdio"]) { return .worker(parentPID: pid, probe: false) }
        if flags == Set(["--computer-worker", "--probe", "--json"]) { return .worker(parentPID: pid, probe: true) }
        throw UsageError.invalidArguments
    }
}
