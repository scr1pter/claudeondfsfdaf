import Foundation
import Darwin

// C2 compiles this entry separately from Sources/main.swift. No native screen, input or privacy operation runs.
do {
    try runCommandLineTests()
    _ = try runProtocolTests()
    _ = try runServerTests()
    _ = try runLifecycleTests()
    _ = try runPackagedSelfTestTests()
    print("Computer helper M1 unit checks passed.")
    exit(0)
} catch {
    FileHandle.standardError.write(Data("Computer helper M1 unit checks failed.\n".utf8))
    exit(1)
}
