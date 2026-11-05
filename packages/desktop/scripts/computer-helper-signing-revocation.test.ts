import { expect, test } from "bun:test"
import { X509Certificate } from "node:crypto"
import { readFileSync } from "node:fs"
import {
  certificateWitness,
  cleanupStages,
  parseCertificateWitness,
  parseSearchList,
  validateSearchList,
  verifyCertificateWitness,
  verifyNoValidIdentity,
  verifyRevocationReport,
} from "../../../.github/scripts/computer-helper-signing-verification.mjs"

const certificate = readFileSync(new URL("../test/fixture/local-ca/company-root.pem", import.meta.url))
const other = readFileSync(new URL("../test/fixture/local-ca/public-root.pem", import.meta.url))
const subject = new X509Certificate(certificate).subject

test("the revocation witness binds actual certificate bytes and the expected subject", () => {
  const witness = certificateWitness(certificate, subject)
  expect(witness.sha256).toMatch(/^[a-f0-9]{64}$/)
  expect(witness.sha1).toMatch(/^[a-f0-9]{40}$/)
  expect(verifyCertificateWitness(certificate, witness, subject)).toEqual(witness)
  expect(() => certificateWitness(certificate, "CN=Another generated identity")).toThrow("certificate-subject")
  expect(() => verifyCertificateWitness(other, witness, new X509Certificate(other).subject)).toThrow(
    "certificate-changed",
  )
  for (const value of [
    null,
    {},
    { ...witness, extra: true },
    { ...witness, sha1: "f".repeat(39) },
    { ...witness, sha256: "G".repeat(64) },
    { ...witness, sha256: 1 },
  ])
    expect(() => parseCertificateWitness(value)).toThrow("certificate-witness")
})

test("search-list restoration retains exact paths/order and refuses malformed or ambiguous snapshots", () => {
  const expected = ["/Users/runner/Library/Keychains/login.keychain-db", "/Library/Keychains/System.keychain"]
  expect(parseSearchList(expected.map((value) => `    ${JSON.stringify(value)}`).join("\n"))).toEqual(expected)
  expect(validateSearchList([])).toEqual([])
  for (const value of [["relative"], ["/safe", "/safe"], ["/safe\nunsafe"], [1], {}, Array(65).fill("/safe")])
    expect(() => validateSearchList(value)).toThrow("search-list-invalid")
  expect(() => parseSearchList("/unquoted")).toThrow()
})

test("only the complete independent revocation result permits cleanup", () => {
  const proof = { certificate: true, adminDeny: true, userPositive: false, codeSignDenied: true }
  expect(() => verifyRevocationReport(proof)).not.toThrow()
  for (const value of [
    null,
    {},
    { ...proof, certificate: false },
    { ...proof, adminDeny: false },
    { ...proof, userPositive: true },
    { ...proof, codeSignDenied: false },
    { ...proof, extra: true },
  ])
    expect(() => verifyRevocationReport(value)).toThrow("revocation-report")
})

test("the actual codesigning identity query must no longer admit the exact fingerprint", () => {
  const sha1 = "a".repeat(40)
  expect(() => verifyNoValidIdentity("     0 valid identities found\n", sha1)).not.toThrow()
  expect(() =>
    verifyNoValidIdentity(`  1) ${"B".repeat(40)} "Other identity"\n     1 valid identities found\n`, sha1),
  ).not.toThrow()
  for (const value of [
    "",
    "query failed",
    "1 valid identities found\n",
    `  1) ${sha1.toUpperCase()} "Fixture"\n     1 valid identities found\n`,
  ])
    expect(() => verifyNoValidIdentity(value, sha1)).toThrow("identity-still-valid")
})

test("keychain deletion requires both revocation and exact search-list restoration, with failures retaining evidence", () => {
  for (const failed of [undefined, "revoke", "restore", "removeKeychain"]) {
    const calls: string[] = []
    const action = (name: string) => () => {
      calls.push(name)
      if (failed === name) throw new Error("fixture")
    }
    expect(
      cleanupStages({
        revoke: action("revoke"),
        restore: action("restore"),
        removeKeychain: action("removeKeychain"),
        discardLoosePrivateFiles: action("discardLoosePrivateFiles"),
        removeDirectory: action("removeDirectory"),
      }),
    ).toBe(failed === undefined)
    expect(calls.slice(0, 2)).toEqual(["revoke", "restore"])
    expect(calls).toContain("discardLoosePrivateFiles")
    expect(calls.includes("removeKeychain")).toBe(failed !== "revoke" && failed !== "restore")
    expect(calls.includes("removeDirectory")).toBe(failed === undefined)
  }
})

test("the CI observer checks unconditional Deny and real negative trust before deleting the live keychain", () => {
  const swift = readFileSync(
    new URL("../../../.github/scripts/computer-helper-signing-verification.swift", import.meta.url),
    "utf8",
  )
  expect(swift).toContain("!rows.isEmpty")
  expect(swift).toContain("row.count == 1")
  expect(swift).toContain("result.intValue == 3")
  expect(swift).toContain("SecTrustSettingsCopyTrustSettings(certificate, .admin")
  expect(swift).toContain("SecTrustSettingsCopyTrustSettings(certificate, .user")
  expect(swift).toContain("SecTrustEvaluateWithError(trust, &error)")
  expect(swift).toContain("result == .deny")
  expect(swift.match(/fileExists\(atPath: CommandLine.arguments\[4\]\)/g)).toHaveLength(2)
  expect(swift).not.toMatch(/SecTrustSettingsSet|SecTrustSettingsRemove|SecTrustSetAnchorCertificates/)
  const cleanup = readFileSync(
    new URL("../../../.github/scripts/computer-helper-signing-cleanup.sh", import.meta.url),
    "utf8",
  )
  expect(cleanup).not.toMatch(/authorizationdb|remove-trusted-cert|\|\| true/)
})
