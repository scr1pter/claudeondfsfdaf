import Foundation
import Security
import CryptoKit

// This CI-only observer never changes Trust Settings or keychains.
func refuse() -> Never {
    print("{\"verificationFailed\":true}")
    exit(1)
}

func onlyUnconditionalDeny(_ settings: CFArray?) -> Bool {
    guard let rows = settings as? [[String: Any]], !rows.isEmpty else { return false }
    return rows.allSatisfy { row in
        guard row.count == 1,
              let result = row[kSecTrustSettingsResult as String] as? NSNumber,
              CFGetTypeID(result) == CFNumberGetTypeID() else { return false }
        // kSecTrustSettingsResultDeny is 3; missing/empty settings mean TrustRoot.
        return result.intValue == 3 && result.doubleValue == 3
    }
}

guard CommandLine.arguments.count == 5 else { refuse() }
let bytes: Data
do { bytes = try Data(contentsOf: URL(fileURLWithPath: CommandLine.arguments[1])) }
catch { refuse() }
guard !bytes.isEmpty, bytes.count <= 65_536,
      SHA256.hash(data: bytes).map({ String(format: "%02x", $0) }).joined() == CommandLine.arguments[2],
      Insecure.SHA1.hash(data: bytes).map({ String(format: "%02x", $0) }).joined() == CommandLine.arguments[3],
      FileManager.default.fileExists(atPath: CommandLine.arguments[4]),
      let certificate = SecCertificateCreateWithData(nil, bytes as CFData) else { refuse() }

var admin: CFArray?
guard SecTrustSettingsCopyTrustSettings(certificate, .admin, &admin) == errSecSuccess,
      onlyUnconditionalDeny(admin) else { refuse() }
var user: CFArray?
let userStatus = SecTrustSettingsCopyTrustSettings(certificate, .user, &user)
guard userStatus == errSecItemNotFound || userStatus == errSecNoTrustSettings ||
        (userStatus == errSecSuccess && onlyUnconditionalDeny(user)) else { refuse() }

guard let policy = SecPolicyCreateWithProperties(kSecPolicyAppleCodeSigning, nil) else { refuse() }
var trust: SecTrust?
guard SecTrustCreateWithCertificates(certificate, policy, &trust) == errSecSuccess,
      let trust,
      SecTrustSetNetworkFetchAllowed(trust, false) == errSecSuccess else { refuse() }
var error: CFError?
let accepted = SecTrustEvaluateWithError(trust, &error)
var result = SecTrustResultType.invalid
guard !accepted, error != nil,
      SecTrustGetTrustResult(trust, &result) == errSecSuccess,
      result == .deny,
      FileManager.default.fileExists(atPath: CommandLine.arguments[4]) else { refuse() }
print("{\"certificate\":true,\"adminDeny\":true,\"userPositive\":false,\"codeSignDenied\":true}")
