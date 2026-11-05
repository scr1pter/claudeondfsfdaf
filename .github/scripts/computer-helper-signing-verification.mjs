import { execFileSync } from "node:child_process"
import { createHash, X509Certificate } from "node:crypto"
import { existsSync, lstatSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const record = (value) => value !== null && typeof value === "object" && !Array.isArray(value)
const fail = (stage) => {
  throw new Error(stage)
}

export function certificateWitness(bytes, subject) {
  const certificate = new X509Certificate(bytes)
  if (certificate.subject !== subject) fail("certificate-subject")
  return {
    sha256: createHash("sha256").update(certificate.raw).digest("hex"),
    sha1: createHash("sha1").update(certificate.raw).digest("hex"),
  }
}

export function parseCertificateWitness(value) {
  if (
    !record(value) ||
    Object.keys(value).sort().join(",") !== "sha1,sha256" ||
    typeof value.sha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(value.sha256) ||
    typeof value.sha1 !== "string" ||
    !/^[a-f0-9]{40}$/.test(value.sha1)
  )
    fail("certificate-witness")
  return value
}

export function verifyCertificateWitness(bytes, value, subject) {
  const expected = parseCertificateWitness(value)
  const actual = certificateWitness(bytes, subject)
  if (actual.sha256 !== expected.sha256 || actual.sha1 !== expected.sha1) fail("certificate-changed")
  return expected
}

export function validateSearchList(value) {
  if (
    !Array.isArray(value) ||
    value.length > 64 ||
    new Set(value).size !== value.length ||
    value.some((item) => typeof item !== "string" || !path.isAbsolute(item) || /[\x00-\x1f\x7f]/.test(item))
  )
    fail("search-list-invalid")
  return value
}

export function parseSearchList(text) {
  return validateSearchList(
    text
      .split(/\r?\n/)
      .filter((line) => line.trim())
      .map((line) => JSON.parse(line.trim())),
  )
}

export function verifyRevocationReport(value) {
  if (
    !record(value) ||
    Object.keys(value).sort().join(",") !== "adminDeny,certificate,codeSignDenied,userPositive" ||
    value.certificate !== true ||
    value.adminDeny !== true ||
    value.userPositive !== false ||
    value.codeSignDenied !== true
  )
    fail("revocation-report")
}

export function identityInventory(output, sha1) {
  if (typeof output !== "string" || output.length > 65_536 || !/^[a-f0-9]{40}$/.test(sha1)) fail("identity-query")
  const identities = [...output.matchAll(/^\s*\d+\)\s+([a-fA-F0-9]{40})\s+"[^\r\n]*"[^\r\n]*$/gm)]
  const counts = [...output.matchAll(/^\s*(\d+) valid identities found\s*$/gm)]
  if (
    counts.length !== 1 ||
    output
      .split(/\r?\n/)
      .some(
        (line) =>
          line.trim() &&
          !/^\s*\d+\)\s+[a-fA-F0-9]{40}\s+"[^\r\n]*"[^\r\n]*$/.test(line) &&
          !/^\s*\d+ valid identities found\s*$/.test(line),
      ) ||
    Number(counts[0][1]) !== identities.length
  )
    fail("identity-output")
  return { count: identities.length, fixturePresent: identities.some((item) => item[1].toLowerCase() === sha1) }
}

export function verifyKeychainDeletion({ keychainPresent, original, observed, output, sha1 }) {
  if (keychainPresent !== false) fail("keychain-retained")
  if (JSON.stringify(validateSearchList(original)) !== JSON.stringify(validateSearchList(observed)))
    fail("search-list-readback")
  if (identityInventory(output, sha1).fixturePresent) fail("identity-still-present")
}

/** Both revocation and exact search-list restoration precede deletion; failed attempts retain retry evidence. */
export function cleanupStages(actions, marker = () => {}) {
  let failed = false
  for (const stage of ["revoke", "restore"]) {
    try {
      actions[stage]()
      marker(stage, true)
    } catch (error) {
      failed = true
      marker(stage, false, error instanceof Error ? error.message : undefined)
    }
  }
  if (!failed) {
    try {
      actions.removeKeychain()
      marker("keychain", true)
    } catch (error) {
      failed = true
      marker("keychain", false, error instanceof Error ? error.message : undefined)
    }
  }
  actions.discardLoosePrivateFiles()
  if (!failed) actions.removeDirectory()
  return !failed
}

function main() {
  if (
    process.platform !== "darwin" ||
    !["--record", "--cleanup"].includes(process.argv[2]) ||
    process.argv.length !== 4
  )
    fail("arguments")
  if (!/^[1-9]\d*$/.test(process.env.GITHUB_RUN_ID ?? "") || !/^[1-9]\d*$/.test(process.env.GITHUB_RUN_ATTEMPT ?? ""))
    fail("run-identity")
  const directory = realpathSync(process.argv[3])
  const expected = path.join(
    realpathSync(process.env.RUNNER_TEMP),
    `vector-hands-signing-${process.env.GITHUB_RUN_ID}-${process.env.GITHUB_RUN_ATTEMPT}`,
  )
  if (directory !== expected || lstatSync(process.argv[3]).isSymbolicLink()) fail("directory")
  const subject = `CN=Vector Hands CI Signing ${process.env.GITHUB_RUN_ID}-${process.env.GITHUB_RUN_ATTEMPT}`
  const regular = (name, limit = 65_536) => {
    const file = path.join(directory, name)
    const status = lstatSync(file)
    if (!status.isFile() || status.isSymbolicLink() || status.size > limit || realpathSync(file) !== file)
      fail("fixture-file")
    return file
  }
  if (process.argv[2] === "--record") {
    const witness = certificateWitness(readFileSync(regular("signing.crt")), subject)
    writeFileSync(path.join(directory, "certificate-witness.json"), JSON.stringify(witness) + "\n", {
      flag: "wx",
      mode: 0o600,
    })
    console.log("certificate-fixture certificate-witness=recorded")
    return
  }
  const security = (args, stage, timeout = 5_000) => command("/usr/bin/security", args, stage, timeout)
  const command = (executable, args, stage, timeout) => {
    try {
      return execFileSync(executable, args, {
        encoding: "utf8",
        timeout,
        killSignal: "SIGKILL",
        maxBuffer: 65_536,
        stdio: ["ignore", "pipe", "pipe"],
      })
    } catch {
      fail(stage)
    }
  }
  const keychain = path.join(directory, "signing.keychain-db")
  const reasons = new Set([
    "certificate-subject",
    "certificate-witness",
    "certificate-changed",
    "fixture-file",
    "deny-set",
    "deny-verification",
    "revocation-report",
    "identity-query",
    "identity-output",
    "identity-still-present",
    "search-list-invalid",
    "search-list-snapshot",
    "search-list-restore",
    "search-list-readback",
    "keychain-removal",
    "keychain-retained",
  ])
  const marker = (stage, success, reason) =>
    console.log(
      `signing-cleanup stage=${stage} result=${success ? "verified" : "failed"}${!success ? ` reason=${reasons.has(reason) ? reason : "verification-failed"}` : ""}`,
    )
  const actions = {
    revoke() {
      const certificate = regular("signing.crt")
      const bytes = readFileSync(certificate)
      const witness = verifyCertificateWitness(
        bytes,
        JSON.parse(readFileSync(regular("certificate-witness.json"), "utf8")),
        subject,
      )
      regular("signing.keychain-db", 64 * 1024 * 1024)
      // The alarm belongs to the privileged process that execs security, not merely to sudo's parent.
      command(
        "/usr/bin/sudo",
        [
          "-n",
          "/usr/bin/perl",
          "-e",
          'alarm 25; exec @ARGV or die "revocation-exec-failed\\n"',
          "/usr/bin/security",
          "add-trusted-cert",
          "-d",
          "-r",
          "deny",
          "-k",
          keychain,
          certificate,
        ],
        "deny-set",
        30_000,
      )
      const der = path.join(directory, "signing-verification.der")
      writeFileSync(der, new X509Certificate(bytes).raw, { mode: 0o600 })
      const verifier = fileURLToPath(new URL("./computer-helper-signing-verification.swift", import.meta.url))
      verifyRevocationReport(
        JSON.parse(
          command(
            "/usr/bin/xcrun",
            ["swift", verifier, der, witness.sha256, witness.sha1, keychain],
            "deny-verification",
            35_000,
          ),
        ),
      )
      // Apple's legacy IdentityCursor "valid" filter omits the explicit-Deny
      // trust result. Inventory can therefore retain this now-denied identity
      // until its private key is deleted; the public SecTrust .deny above is
      // the effective code-signing trust gate.
      const inventory = identityInventory(
        security(["find-identity", "-v", "-p", "codesigning", keychain], "identity-query"),
        witness.sha1,
      )
      console.log(
        `signing-cleanup identity-inventory count=${inventory.count} fixture-present=${inventory.fixturePresent} scope=owned-keychain`,
      )
      regular("signing.keychain-db", 64 * 1024 * 1024)
      verifyCertificateWitness(
        readFileSync(regular("signing.crt")),
        JSON.parse(readFileSync(regular("certificate-witness.json"), "utf8")),
        subject,
      )
      console.log("signing-cleanup effective-trust=revoked deny-metadata=retained-until-disposable-runner-destruction")
    },
    restore() {
      const snapshot = path.join(directory, "keychain-search-list.json")
      if (!existsSync(snapshot)) {
        if (existsSync(keychain)) fail("search-list-snapshot")
        return
      }
      const original = validateSearchList(JSON.parse(readFileSync(regular("keychain-search-list.json"), "utf8")))
      if (original.includes(keychain)) fail("search-list-snapshot")
      security(["list-keychains", "-d", "user", "-s", ...original], "search-list-restore")
      if (
        JSON.stringify(parseSearchList(security(["list-keychains", "-d", "user"], "search-list-readback"))) !==
        JSON.stringify(original)
      )
        fail("search-list-readback")
    },
    removeKeychain() {
      if (!existsSync(keychain)) return
      regular("signing.keychain-db", 64 * 1024 * 1024)
      command(
        "/usr/bin/perl",
        [
          "-e",
          'alarm 15; exec @ARGV or die "cleanup-exec-failed\\n"',
          "/usr/bin/security",
          "delete-keychain",
          keychain,
        ],
        "keychain-removal",
        20_000,
      )
      if (existsSync(keychain)) fail("keychain-retained")
      const witness = parseCertificateWitness(JSON.parse(readFileSync(regular("certificate-witness.json"), "utf8")))
      verifyKeychainDeletion({
        keychainPresent: existsSync(keychain),
        original: JSON.parse(readFileSync(regular("keychain-search-list.json"), "utf8")),
        observed: parseSearchList(security(["list-keychains", "-d", "user"], "search-list-readback")),
        output: security(["find-identity", "-v", "-p", "codesigning"], "identity-query"),
        sha1: witness.sha1,
      })
      console.log("signing-cleanup owned-keychain=deleted exact-identity=absent-from-restored-search-list")
    },
    discardLoosePrivateFiles() {
      for (const name of ["signing.key", "signing.p12", "request.cnf", "signing-verification.der"])
        rmSync(path.join(directory, name), { force: true })
    },
    removeDirectory() {
      rmSync(directory, { recursive: true })
    },
  }
  if (!cleanupStages(actions, marker)) process.exitCode = 1
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main()
  } catch {
    console.error("signing-cleanup result=verification-failed")
    process.exitCode = 1
  }
}
