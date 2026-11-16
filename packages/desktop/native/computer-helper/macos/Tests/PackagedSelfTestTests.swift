import Foundation

private struct PackagedSelfTestFailure: Error {
    let message: String
}

/// Pure bundle/signature evidence only. The actual Security adapter is exercised by C5 from a signed bundle.
func runPackagedSelfTestTests() throws -> Int {
    var checks = 0
    func check(_ condition: @autoclosure () -> Bool, _ message: String) throws {
        guard condition() else { throw PackagedSelfTestFailure(message: message) }
        checks += 1
    }
    func fixture(_ channel: Identity.Channel) -> PackagedHelperEvidence {
        let helper = "/Applications/Fixture \(channel.name).app/Contents/Helpers/\(Identity.bundle)"
        return PackagedHelperEvidence(bundlePath: helper, executablePath: helper + "/Contents/MacOS/" + Identity.executable,
            info: [
                "CFBundleIdentifier": .string(channel.helperBundleId),
                "CFBundleExecutable": .string(Identity.executable),
                "CFBundlePackageType": .string("APPL"),
                "CFBundleName": .string(channel.helperName),
                "CFBundleDisplayName": .string(channel.helperName),
                "CFBundleShortVersionString": .string(Identity.helperVersion),
                "CFBundleVersion": .string(Identity.helperVersion),
                "LSMinimumSystemVersion": .string(Identity.minimumSystemVersion),
                "LSUIElement": .bool(true),
                "LSMultipleInstancesProhibited": .bool(true),
                "NSPrincipalClass": .string("NSApplication"),
                "CFBundleIconFile": .string("AppIcon"),
                "NSScreenCaptureUsageDescription": .string(PackagedHelperSelfTest.usageDescription(channel.helperName)),
                "VectorComputerSourceDigest": .string(String(repeating: "a", count: 64)),
            ],
            signature: PackagedHelperSignature(valid: true, identifier: channel.helperBundleId,
                hardenedRuntime: true, entitlements: [:], adhoc: true, developerID: false, teamID: nil))
    }

    for channel in Identity.channels {
        let base = fixture(channel)
        try check(PackagedHelperSelfTest.validate(base), "Each channel must accept its own empty-entitlement hardened ad-hoc bundle")
        var signed = base
        signed.signature.adhoc = false
        signed.signature.developerID = true
        signed.signature.teamID = "TEAM123456"
        try check(PackagedHelperSelfTest.validate(signed), "A valid Developer ID signature is accepted without invoking parent or privacy checks")
        for wrong in [channel.appId, channel.appId + ".helper", channel.appId + ".helper.computer", "ai.vector.unknown.computer"] {
            var changed = base
            changed.info["CFBundleIdentifier"] = .string(wrong)
            changed.signature.identifier = wrong
            try check(!PackagedHelperSelfTest.validate(changed), "App, Electron-helper and unknown channel identifiers are refused")
        }
        var wrongSignature = base
        wrongSignature.signature.identifier = channel.appId
        try check(!PackagedHelperSelfTest.validate(wrongSignature), "A signature identifier must match its generated helper channel")

        for key in ["CFBundleExecutable", "CFBundlePackageType", "CFBundleName", "CFBundleDisplayName",
                    "CFBundleShortVersionString", "CFBundleVersion", "LSMinimumSystemVersion", "NSPrincipalClass",
                    "CFBundleIconFile", "NSScreenCaptureUsageDescription", "VectorComputerSourceDigest"] {
            var changed = base
            changed.info.removeValue(forKey: key)
            try check(!PackagedHelperSelfTest.validate(changed), "Missing required bundle metadata is refused")
            changed.info[key] = .string("unexpected")
            try check(!PackagedHelperSelfTest.validate(changed), "Wrong required bundle metadata is refused")
        }
        for key in ["LSUIElement", "LSMultipleInstancesProhibited"] {
            for value in [JSONValue.bool(false), .integer(1), .string("true")] {
                var changed = base
                changed.info[key] = value
                try check(!PackagedHelperSelfTest.validate(changed), "Accessory and single-instance flags require actual true booleans")
            }
        }
        for key in ["NSAppleEventsUsageDescription", "NSAppleScriptEnabled", "NSScriptingDefinition"] {
            var changed = base
            changed.info[key] = .string("unexpected")
            try check(!PackagedHelperSelfTest.validate(changed), "Apple Events and scripting metadata are not part of this helper")
        }
        for digest in ["", String(repeating: "a", count: 63), String(repeating: "A", count: 64),
                       String(repeating: "g", count: 64), "{{SOURCE_DIGEST}}"] {
            var changed = base
            changed.info["VectorComputerSourceDigest"] = .string(digest)
            try check(!PackagedHelperSelfTest.validate(changed), "Unrendered or malformed source digests are refused")
        }
        var anotherChannel = base
        anotherChannel.info["CFBundleDisplayName"] = .string("wrong channel name")
        try check(!PackagedHelperSelfTest.validate(anotherChannel), "The helper display name must follow its generated channel")
        var wrongVersion = base
        wrongVersion.info["CFBundleVersion"] = .string("1.99.112")
        try check(!PackagedHelperSelfTest.validate(wrongVersion), "The app release version cannot replace the helper version")

        for path in ["relative/\(Identity.bundle)", base.bundlePath + "/../" + Identity.bundle,
                     base.bundlePath + ".replacement", base.bundlePath + "\0"] {
            var changed = base
            changed.bundlePath = path
            changed.executablePath = path + "/Contents/MacOS/" + Identity.executable
            try check(!PackagedHelperSelfTest.validate(changed), "Packaged checks require a canonical helper bundle path")
        }
        var moved = base
        moved.executablePath = "/tmp/" + Identity.executable
        try check(!PackagedHelperSelfTest.validate(moved), "A detached executable cannot claim packaged placement")
        moved.executablePath = base.bundlePath + "/Contents/MacOS/another-helper"
        try check(!PackagedHelperSelfTest.validate(moved), "The executing binary must match the generated helper executable")

        for key in ["com.apple.security.cs.allow-jit", "com.apple.security.cs.allow-dyld-environment-variables",
                    "com.apple.security.cs.disable-library-validation", "com.apple.security.automation.apple-events",
                    "com.apple.security.device.audio-input", "unknown.entitlement"] {
            var changed = base
            changed.signature.entitlements[key] = .bool(false)
            try check(!PackagedHelperSelfTest.validate(changed), "Even false-valued and unknown entitlements violate the exact empty set")
        }
        var invalid = base
        invalid.signature.valid = false
        try check(!PackagedHelperSelfTest.validate(invalid), "An invalid signature cannot pass packaged verification")
        invalid = base
        invalid.signature.hardenedRuntime = false
        try check(!PackagedHelperSelfTest.validate(invalid), "An empty entitlement set without hardened runtime is refused")
        invalid = signed
        invalid.signature.developerID = false
        try check(!PackagedHelperSelfTest.validate(invalid), "A certificate signature needs the actual Developer ID requirement")
        for team in [nil, "", "TEAM12345", "team123456", "TEAM12345\""] as [String?] {
            var changed = signed
            changed.signature.teamID = team
            try check(!PackagedHelperSelfTest.validate(changed), "Missing or malformed Developer ID teams are refused")
        }
        invalid = base
        invalid.signature.developerID = true
        try check(!PackagedHelperSelfTest.validate(invalid), "Conflicting ad-hoc and Developer ID facts are refused")
        invalid = base
        invalid.signature.teamID = "TEAM123456"
        try check(!PackagedHelperSelfTest.validate(invalid), "An ad-hoc signature cannot claim a signing team")
    }
    return checks
}
