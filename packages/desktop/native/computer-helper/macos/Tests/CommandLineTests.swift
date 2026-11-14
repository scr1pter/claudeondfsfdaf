import Foundation

func runCommandLineTests() throws {
    func check(_ arguments: [String], _ expected: HelperCommand) throws {
        if try HelperCommand.parse(arguments) != expected { throw HelperCommand.UsageError.invalidArguments }
    }
    try check(["--version", "--json"], .version)
    try check(["--probe", "--json"], .probe)
    try check(["--stdio", "--parent-pid", "123"], .serve(parentPID: 123))
    try check(["--computer-worker", "--probe", "--json", "--parent-pid", "123"], .worker(parentPID: 123, probe: true))
    let target = "/fixture/tests/VectorComputerTestTarget.app"
    try check(["--self-test=unprivileged"], .selfTest(mode: "unprivileged", target: nil, report: nil))
    try check(["--self-test=packaged", "--report", "/tmp/report.json"], .selfTest(mode: "packaged", target: nil, report: "/tmp/report.json"))
    try check(["--self-test=privileged", "--target", target, "--report", "/tmp/report.json"], .selfTest(mode: "privileged", target: target, report: "/tmp/report.json"))
    try check(["--computer-worker", "--self-test=privileged", "--parent-pid", "123", "--target", target],
              .privilegedWorker(parentPID: 123, target: target, report: nil))
    try check(["--computer-worker", "--self-test=privileged", "--parent-pid", "123", "--target", target, "--report", "/tmp/report.json"],
              .privilegedWorker(parentPID: 123, target: target, report: "/tmp/report.json"))
    for arguments in [
        [], ["--version"], ["--probe"], ["--stdio"], ["--stdio", "--json", "--parent-pid", "1"],
        ["--stdio", "--parent-pid", "0"], ["--stdio", "--parent-pid", "-1"],
        ["--stdio", "--parent-pid", "2147483648"], ["--stdio", "--parent-pid", "+1"],
        ["--stdio", "--parent-pid", "1", "--parent-pid", "2"], ["--probe", "--json", "--json"],
        ["--version", "--probe", "--json"], ["--computer-worker", "--version", "--json"],
        ["--self-test=unknown"], ["--self-test=unprivileged", "--stdio"], ["--self-test=packaged", "--report", ""],
        ["--self-test=privileged"], ["--self-test=privileged", "--target", "Fixture.app"],
        ["--self-test=privileged", "--target", "/fixture/../VectorComputerTestTarget.app"],
        ["--self-test=privileged", "--target", target, "--report", "relative.json"],
        ["--self-test=privileged", "--target", target, "--report", "/tmp/../report.json"],
        ["--self-test=privileged", "--target", target, "--report", "/tmp/line\nreport.json"],
        ["--self-test=privileged", "--target", "/" + String(repeating: "x", count: 4096)],
        ["--self-test=unprivileged", "--target", target], ["--self-test=packaged", "--target", target],
        ["--computer-worker", "--self-test=unprivileged", "--parent-pid", "123"],
        ["--computer-worker", "--self-test=packaged", "--parent-pid", "123"],
        ["--computer-worker", "--self-test=privileged", "--target", target],
        ["--computer-worker", "--self-test=privileged", "--parent-pid", "0", "--target", target],
        ["--computer-worker", "--self-test=privileged", "--parent-pid", "123", "--target", target, "--stdio"],
        ["--computer-worker", "--self-test=privileged", "--parent-pid", "123", "--target", target, "--probe", "--json"],
        ["--self-test=privileged", "--parent-pid", "123", "--target", target],
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
