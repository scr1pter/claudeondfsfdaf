import Darwin
import Foundation
import Security

struct PackagedHelperSignature {
    var valid: Bool
    var identifier: String
    var hardenedRuntime: Bool
    var entitlements: [String: JSONValue]
    var adhoc: Bool
    var developerID: Bool
    var teamID: String?
}

struct PackagedHelperEvidence {
    /// The adapter resolves these against the current process; fixtures supply canonical, existing-path shapes.
    var bundlePath: String
    var executablePath: String
    var info: [String: JSONValue]
    var signature: PackagedHelperSignature
}

enum PackagedHelperSelfTest {
    /// This check observes only its own bundle and signature. It has no serving-parent, TCC or input capability.
    static func run() -> Bool {
        guard let process = HelperLifecycle.processIdentity(getpid()),
              let bundle = canonical(Bundle.main.bundleURL.path),
              let info = readInfo(bundle + "/Contents/Info.plist"),
              let signature = ownSignature(bundle: URL(fileURLWithPath: bundle)) else { return false }
        return validate(PackagedHelperEvidence(bundlePath: bundle, executablePath: process.executable,
                                               info: info, signature: signature))
    }

    static func validate(_ evidence: PackagedHelperEvidence) -> Bool {
        let info = evidence.info
        guard evidence.bundlePath.hasPrefix("/"), !evidence.bundlePath.contains("\0"),
              URL(fileURLWithPath: evidence.bundlePath).standardizedFileURL.path == evidence.bundlePath,
              URL(fileURLWithPath: evidence.bundlePath).lastPathComponent == Identity.bundle,
              evidence.executablePath == evidence.bundlePath + "/Contents/MacOS/" + Identity.executable,
              let identifier = info["CFBundleIdentifier"]?.stringValue,
              let channel = Identity.channels.first(where: { $0.helperBundleId == identifier }),
              identifier != channel.appId + ".helper", !identifier.hasPrefix(channel.appId + ".helper."),
              info["CFBundleExecutable"]?.stringValue == Identity.executable,
              info["CFBundlePackageType"]?.stringValue == "APPL",
              info["CFBundleName"]?.stringValue == channel.helperName,
              info["CFBundleDisplayName"]?.stringValue == channel.helperName,
              info["CFBundleShortVersionString"]?.stringValue == Identity.helperVersion,
              info["CFBundleVersion"]?.stringValue == Identity.helperVersion,
              info["LSMinimumSystemVersion"]?.stringValue == Identity.minimumSystemVersion,
              info["LSUIElement"]?.boolValue == true,
              info["LSMultipleInstancesProhibited"]?.boolValue == true,
              info["NSPrincipalClass"]?.stringValue == "NSApplication",
              info["CFBundleIconFile"]?.stringValue == "AppIcon",
              info["NSScreenCaptureUsageDescription"]?.stringValue == usageDescription(channel.helperName),
              info["NSAppleEventsUsageDescription"] == nil,
              info["NSAppleScriptEnabled"] == nil,
              info["NSScriptingDefinition"] == nil,
              let digest = info["VectorComputerSourceDigest"]?.stringValue,
              digest.utf8.count == 64, digest.utf8.allSatisfy({ (48...57).contains($0) || (97...102).contains($0) }) else {
            return false
        }
        let signature = evidence.signature
        guard signature.valid, signature.identifier == identifier, signature.hardenedRuntime,
              signature.entitlements.isEmpty else { return false }
        if signature.adhoc { return !signature.developerID && signature.teamID == nil }
        guard signature.developerID, let team = signature.teamID else { return false }
        return validTeamID(team)
    }

    static func usageDescription(_ name: String) -> String {
        "\(name) uses screen recording only during computer tasks you approve."
    }

    private static func validTeamID(_ value: String) -> Bool {
        value.utf8.count == 10 && value.utf8.allSatisfy({ (48...57).contains($0) || (65...90).contains($0) })
    }

    private static func canonical(_ path: String) -> String? {
        guard let value = realpath(path, nil) else { return nil }
        defer { free(value) }
        return String(cString: value)
    }

    private static func readInfo(_ path: String) -> [String: JSONValue]? {
        let descriptor = open(path, O_RDONLY | O_CLOEXEC | O_NONBLOCK | O_NOFOLLOW)
        guard descriptor >= 0 else { return nil }
        defer { Darwin.close(descriptor) }
        var status = stat()
        let limit = 1_048_576
        guard fstat(descriptor, &status) == 0, status.st_mode & mode_t(S_IFMT) == mode_t(S_IFREG),
              status.st_size > 0, status.st_size <= off_t(limit) else { return nil }
        var bytes = [UInt8](repeating: 0, count: limit + 1)
        var count = 0
        while count < bytes.count {
            let received = bytes.withUnsafeMutableBytes { buffer in
                Darwin.read(descriptor, buffer.baseAddress!.advanced(by: count), buffer.count - count)
            }
            if received < 0 && errno == EINTR { continue }
            guard received >= 0 else { return nil }
            if received == 0 { break }
            count += received
        }
        guard count <= limit,
              let property = try? PropertyListSerialization.propertyList(from: Data(bytes.prefix(count)), options: [], format: nil),
              JSONSerialization.isValidJSONObject(property),
              let json = try? JSONSerialization.data(withJSONObject: property),
              let value = try? JSONDecoder().decode(JSONValue.self, from: json) else { return nil }
        return value.objectValue
    }

    private static func ownSignature(bundle: URL) -> PackagedHelperSignature? {
        var code: SecCode?
        var staticCode: SecStaticCode?
        var bundleCode: SecStaticCode?
        guard SecCodeCopySelf([], &code) == errSecSuccess, let code,
              SecCodeCopyStaticCode(code, [], &staticCode) == errSecSuccess, let staticCode,
              SecStaticCodeCreateWithPath(bundle as CFURL, [], &bundleCode) == errSecSuccess, let bundleCode,
              SecCodeCheckValidity(code, [.noNetworkAccess], nil) == errSecSuccess,
              SecStaticCodeCheckValidity(bundleCode, [.noNetworkAccess], nil) == errSecSuccess else { return nil }
        var information: CFDictionary?
        guard SecCodeCopySigningInformation(staticCode, SecCSFlags(rawValue: kSecCSSigningInformation), &information) == errSecSuccess,
              let information else { return nil }
        let fields = information as NSDictionary
        guard let flagNumber = fields[kSecCodeInfoFlags] as? NSNumber,
              let identifier = fields[kSecCodeInfoIdentifier] as? String,
              Identity.channels.contains(where: { $0.helperBundleId == identifier }) else { return nil }
        let flags = SecCodeSignatureFlags(rawValue: flagNumber.uint32Value)
        let entitlements: [String: JSONValue]
        if let value = fields[kSecCodeInfoEntitlementsDict] {
            guard let dictionary = value as? NSDictionary, dictionary.count == 0 else { return nil }
            entitlements = [:]
        } else { entitlements = [:] }
        let adhoc = flags.contains(.adhoc)
        let team = fields[kSecCodeInfoTeamIdentifier] as? String
        var developerID = false
        if !adhoc, let team, validTeamID(team) {
            var requirement: SecRequirement?
            let rule = "anchor apple generic and certificate leaf[field.1.2.840.113635.100.6.1.13] exists and certificate leaf[subject.OU] = \"\(team)\" and identifier \"\(identifier)\""
            developerID = SecRequirementCreateWithString(rule as CFString, [], &requirement) == errSecSuccess &&
                requirement.map { SecCodeCheckValidity(code, [.noNetworkAccess], $0) == errSecSuccess } == true
        }
        return PackagedHelperSignature(valid: true, identifier: identifier, hardenedRuntime: flags.contains(.runtime),
                                       entitlements: entitlements, adhoc: adhoc, developerID: developerID, teamID: team)
    }
}
