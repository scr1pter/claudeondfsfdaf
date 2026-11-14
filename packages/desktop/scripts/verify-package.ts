// Asserts a packaged desktop app has one build identity from compilation
// through bundle metadata and, for release channels, the trusted update feed.
//
// 1.19.96 shipped without Contents/Resources/app-update.yml and every update
// check died with `ENOENT ... app-update.yml`, which the UI reported only as
// "Updates unavailable". electron-builder writes that file when it produces a
// real artifact; a `--dir` build skips it, so a packaged-looking app can be
// missing the one file the updater needs and nothing says so until a user
// clicks the button.
import { existsSync, readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { verifyNotices } from "./verify-notices"
import { BUILD_IDENTITY_FILE, parseBuildIdentity } from "./build-identity"

import { verifyComputerHelperMac } from "./verify-computer-helper"
export { checkComputerHelper, parseMacCodeSignature } from "./verify-computer-helper"

export type PackageCheck = { ok: true } | { ok: false; problem: string }

type PackagedAppInput = {
  bundleID?: string
  version?: string
  buildIdentity: { present: boolean; contents?: string }
  updaterMetadata: { present: boolean; contents?: string }
}

const channels = {
  "ai.vector.app.dev": "dev",
  "ai.vector.app.beta": "beta",
  "ai.vector.app": "prod",
} as const

export function checkUpdaterMetadata(input: { present: boolean; contents?: string }): PackageCheck {
  if (!input.present) {
    return {
      ok: false,
      problem:
        "app-update.yml is missing. electron-builder only writes it for a real target, so this was probably packaged with --dir. Every update check will fail with ENOENT.",
    }
  }
  const contents = input.contents ?? ""
  if (!/^provider:\s*\S+/m.test(contents)) return { ok: false, problem: "app-update.yml has no provider." }
  if (!/^url:\s*https:\/\/\S+/m.test(contents)) {
    return { ok: false, problem: "app-update.yml has no https update feed url." }
  }
  return { ok: true }
}

export function updaterMetadataPath(appPath: string) {
  return join(appPath, "Contents", "Resources", "app-update.yml")
}

export function buildIdentityPath(appPath: string) {
  return join(appPath, "Contents", "Resources", BUILD_IDENTITY_FILE)
}

export function checkPackagedApp(input: PackagedAppInput): PackageCheck {
  if (!input.bundleID || !(input.bundleID in channels)) {
    return { ok: false, problem: `Unrecognized Vector bundle id: ${input.bundleID || "missing"}.` }
  }
  if (!input.version) return { ok: false, problem: "The packaged app has no version." }
  if (!input.buildIdentity.present) {
    return {
      ok: false,
      problem: `${BUILD_IDENTITY_FILE} is missing. The app was packaged without running the channel-aware build.`,
    }
  }

  const identity = parseBuildIdentity(input.buildIdentity.contents ?? "")
  if (!identity) return { ok: false, problem: `${BUILD_IDENTITY_FILE} is malformed.` }
  const channel = channels[input.bundleID as keyof typeof channels]
  if (identity.channel !== channel) {
    return {
      ok: false,
      problem: `Compiled channel ${identity.channel} does not match ${input.bundleID} (${channel}). Refusing a mixed-channel package.`,
    }
  }
  if (identity.version !== input.version) {
    return {
      ok: false,
      problem: `Compiled version ${identity.version} does not match packaged version ${input.version}.`,
    }
  }

  if (channel === "dev") {
    if (input.updaterMetadata.present) {
      return { ok: false, problem: "A development build must not contain a production update feed." }
    }
    return { ok: true }
  }

  const metadata = checkUpdaterMetadata(input.updaterMetadata)
  if (!metadata.ok) return metadata
  const url = input.updaterMetadata.contents?.match(/^url:\s*(https:\/\/\S+)/m)?.[1]
  const expected = channel === "prod" ? "/releases/vector-updates" : "/releases/vector-beta-updates"
  if (!url?.replace(/\/$/, "").endsWith(expected)) {
    return { ok: false, problem: `${channel} package points at the wrong update feed: ${url || "missing"}.` }
  }
  return { ok: true }
}

// Given no argument, check every .app the last package run produced. The arch
// suffix on the output directory varies (mac, mac-arm64, mac-x64), so a fixed
// path would quietly verify nothing on the arch it was not written for.
export function packagedApps(distEntries: readonly { dir: string; apps: readonly string[] }[]) {
  return distEntries.flatMap((entry) => entry.apps.map((app) => join(entry.dir, app)))
}

if (import.meta.main) {
  const explicit = process.argv[2]
  const targets: string[] = []
  if (explicit) targets.push(explicit)
  else {
    const dist = fileURLToPath(new URL("../dist", import.meta.url))
    for (const dir of readdirSync(dist, { withFileTypes: true })) {
      if (!dir.isDirectory() || !dir.name.startsWith("mac")) continue
      const full = join(dist, dir.name)
      for (const entry of readdirSync(full)) if (entry.endsWith(".app")) targets.push(join(full, entry))
    }
  }
  if (!targets.length) {
    console.error("no packaged macOS app found to verify")
    process.exit(2)
  }
  for (const appPath of targets) {
    // Also runs the release byte audit over the whole .app.
    await verifyNotices(appPath, "darwin")
    await verify(appPath)
  }
  process.exit(0)
}

async function verify(appPath: string) {
  const metadata = updaterMetadataPath(appPath)
  const identity = buildIdentityPath(appPath)
  const result = checkPackagedApp({
    bundleID: plistValue(join(appPath, "Contents", "Info.plist"), "CFBundleIdentifier"),
    version: plistValue(join(appPath, "Contents", "Info.plist"), "CFBundleShortVersionString"),
    buildIdentity: {
      present: existsSync(identity),
      contents: existsSync(identity) ? readFileSync(identity, "utf8") : undefined,
    },
    updaterMetadata: {
      present: existsSync(metadata),
      contents: existsSync(metadata) ? readFileSync(metadata, "utf8") : undefined,
    },
  })
  if (!result.ok) {
    console.error(`${appPath} failed release verification: ${result.problem}`)
    process.exit(1)
  }
  if (
    !(
      process.env.VECTOR_COMPUTER_HELPER === "skip" &&
      plistValue(join(appPath, "Contents", "Info.plist"), "CFBundleIdentifier") === "ai.vector.app.dev"
    )
  )
    await verifyComputerHelperMac({
      app: appPath,
      expectSigning: process.env.VECTOR_SIGN_MAC === "true" ? "developer-id" : "adhoc",
    })
  console.log(`verified ${appPath} has one consistent compiled, bundle, update channel and computer helper`)
}

function plistValue(file: string, key: string) {
  const result = spawnSync("/usr/bin/plutil", ["-extract", key, "raw", "-o", "-", file], { timeout: 5000 })
  if (result.error || result.status !== 0) return
  return result.stdout.toString().trim()
}
