import Foundation

func runCommandLineTests() throws {
    func check(_ arguments: [String], _ expected: HelperCommand) throws {
        if try HelperCommand.parse(arguments) != expected { throw HelperCommand.UsageError.invalidArguments }
    }
    try check(["--version", "--json"], .version)
    try check(["--probe", "--json"], .probe)
    try check(["--stdio", "--parent-pid", "123"], .serve(parentPID: 123))
    try check(["--computer-worker", "--probe", "--json", "--parent-pid", "123"], .worker(parentPID: 123, probe: true))
    try check(["--self-test=privileged", "--target", "Fixture.app", "--report", "/tmp/report.json"], .selfTest(mode: "privileged", target: "Fixture.app", report: "/tmp/report.json"))
    for arguments in [
        [], ["--version"], ["--probe"], ["--stdio"], ["--stdio", "--json", "--parent-pid", "1"],
        ["--stdio", "--parent-pid", "0"], ["--stdio", "--parent-pid", "-1"],
        ["--stdio", "--parent-pid", "2147483648"], ["--stdio", "--parent-pid", "+1"],
        ["--stdio", "--parent-pid", "1", "--parent-pid", "2"], ["--probe", "--json", "--json"],
        ["--version", "--probe", "--json"], ["--computer-worker", "--version", "--json"],
        ["--self-test=unknown"], ["--self-test=unprivileged", "--stdio"], ["--self-test=packaged", "--report", ""],
        ["--version", "--json", "--report", "/tmp/report.json"], ["--unknown"],
    ] {
        do {
            _ = try HelperCommand.parse(arguments)
        } catch HelperCommand.UsageError.invalidArguments {
            continue
        }
        throw HelperCommand.UsageError.invalidArguments
    }
}
