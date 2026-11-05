import Foundation
import Darwin

// C2 compiles this entry separately from Sources/main.swift. No native screen, input or privacy operation runs.
do {
    try runCommandLineTests()
    _ = try runProtocolTests()
    _ = try runServerTests()
    _ = try runLifecycleTests()
    _ = try runPackagedSelfTestTests()
    _ = try runBlocklistTests()
    _ = try runPermissionsTests()
    _ = try runGeometryTests()
    _ = try runCaptureTests()
    _ = try runAccessibilityRegistryTests()
    _ = try runAccessibilityTests()
    _ = try runAccessibilityTextTests()
    _ = try runMenuSafetyTests()
    _ = try runHeldInputTests()
    _ = try runInputTests()
    _ = try runInputKeySafetyTests()
    _ = try runHostOwnershipTests()
    _ = try runProgramLaunchRegistryTests()
    _ = try runAppsTests()
    _ = try runClipboardTests()
    _ = try runEventTapTests()
    _ = try runWatchdogTests()
    print("Computer helper unit checks passed.")
    exit(0)
} catch {
    FileHandle.standardError.write(Data("Computer helper unit checks failed.\n".utf8))
    exit(1)
}
