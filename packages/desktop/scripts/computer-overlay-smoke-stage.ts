import { createHash } from "node:crypto"
import { lstat, mkdtemp, readFile, readdir, readlink, realpath, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import {
  parseHelperManifest,
  sourceDigestFor,
  type HelperArchitecture,
  type HelperManifest,
  type HelperPlatform,
} from "./build-computer-helper"
import { generateIdentitySources, readIdentity } from "./computer-helper-identity"
import { computerOverlaySourceDigest, computerOverlaySourceGraph } from "./computer-overlay-smoke-source"

export const COMPUTER_OVERLAY_STAGE_MANIFEST = "computer-overlay-smoke.json"
export const COMPUTER_OVERLAY_STAGE_BUNDLES = [
  "smoke/computer-overlay-smoke-electron.mjs",
  "smoke/computer-overlay-smoke-preload.cjs",
  "smoke/computer-fake-helper.mjs",
] as const
export function computerOverlayStagePaths(platform: HelperPlatform) {
  return platform === "win32"
    ? {
        driver: "resources/computer/vector-computer.exe",
        electron: "electron/electron.exe",
        defaultApp: "electron/resources/default_app.asar",
      }
    : {
        driver: "resources/computer/VectorComputerOverlayDriver.app/Contents/MacOS/VectorComputerOverlayDriver",
        electron: "electron/Electron.app/Contents/MacOS/Electron",
        defaultApp: "electron/Electron.app/Contents/Resources/default_app.asar",
      }
}

/** The C2 builder emits this exact separate, never-shipped artifact after pinning these bundles. */
export function parseComputerOverlayStage(
  value: unknown,
  input: {
    platform: HelperPlatform
    architecture: HelperArchitecture
    sourceDigest: string
    identity: { helperVersion: string; protocol: { min: number; max: number } }
  },
): HelperManifest {
  const manifest = parseHelperManifest(value)
  if (
    manifest.platform !== input.platform ||
    manifest.sourceDigest !== input.sourceDigest ||
    manifest.helperVersion !== input.identity.helperVersion ||
    manifest.protocol.min !== input.identity.protocol.min ||
    manifest.protocol.max !== input.identity.protocol.max ||
    Object.keys(manifest.files).length > 16_384
  )
    throw new Error("The computer overlay artifact does not match its actual source and protocol.")
  const paths = computerOverlayStagePaths(input.platform)
  for (const mandatory of [paths.driver, paths.electron, paths.defaultApp, ...COMPUTER_OVERLAY_STAGE_BUNDLES])
    if (!manifest.files[mandatory]?.arch.includes(input.architecture))
      throw new Error("The computer overlay artifact is missing a required host file.")
  for (const relative of Object.keys(manifest.files)) {
    if (
      !(
        relative.startsWith("resources/computer/") ||
        relative.startsWith("electron/") ||
        COMPUTER_OVERLAY_STAGE_BUNDLES.includes(relative as (typeof COMPUTER_OVERLAY_STAGE_BUNDLES)[number])
      )
    )
      throw new Error("The computer overlay artifact contains an unexpected file.")
    if (!manifest.files[relative]!.arch.includes(input.architecture))
      throw new Error("The computer overlay artifact has an incompatible host file.")
  }
  return manifest
}

/**
 * CI must restore only the exact current immutable C2 artifact before calling this verifier. Recompute C2's
 * source digest and repeat every staged byte check before either Electron or the finite native driver starts.
 * The dedicated overlay digest binds C2 native inputs and the independently resolved current smoke graph.
 */
export async function verifyComputerOverlayStage(
  root: string,
  input: {
    platform: HelperPlatform
    architecture: HelperArchitecture
    directory?: string
    channel?: "prod" | "beta" | "dev"
  },
) {
  const directory = input.directory ?? fileURLToPath(new URL("../", import.meta.url))
  const channel = input.channel ?? process.env.VECTOR_CHANNEL ?? "prod"
  if (channel !== "prod" && channel !== "beta" && channel !== "dev")
    throw new Error("The overlay stage source channel is invalid.")
  const base = await realpath(root)
  const info = await lstat(base)
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("The computer overlay artifact root is invalid.")
  const manifestFile = path.join(base, COMPUTER_OVERLAY_STAGE_MANIFEST)
  const manifestInfo = await lstat(manifestFile)
  if (
    !manifestInfo.isFile() ||
    manifestInfo.isSymbolicLink() ||
    manifestInfo.size < 1 ||
    manifestInfo.size > 1024 * 1024
  )
    throw new Error("The computer overlay artifact manifest is invalid.")
  const raw: unknown = JSON.parse(await readFile(manifestFile, "utf8"))
  const candidate = parseHelperManifest(raw)
  const generated = await mkdtemp(path.join(tmpdir(), "vector-computer-overlay-identity-"))
  try {
    const identityFile = generateIdentitySources(generated, {
      identity: path.join(directory, "native/computer-helper/identity.json"),
      blocklist: path.join(directory, "native/computer-helper/blocklist.json"),
    }).find((file) => file.endsWith("Identity.swift"))!
    const nativeDigest = await sourceDigestFor(directory, input.platform, channel, candidate.toolchain, identityFile)
    const sourceDigest = computerOverlaySourceDigest(nativeDigest, await computerOverlaySourceGraph(directory))
    const manifest = parseComputerOverlayStage(raw, {
      ...input,
      sourceDigest,
      identity: readIdentity(path.join(directory, "native/computer-helper/identity.json")),
    })
    const observed: string[] = []
    async function visit(current: string) {
      for (const entry of await readdir(current, { withFileTypes: true })) {
        const file = path.join(current, entry.name),
          relative = path.relative(base, file).split(path.sep).join("/")
        if (relative === COMPUTER_OVERLAY_STAGE_MANIFEST) continue
        if (relative === "profile") throw new Error("The computer overlay artifact must not carry a previous profile.")
        if (entry.isSymbolicLink()) {
          // Electron's signed macOS frameworks contain relative internal links. No native driver,
          // bundle, script or external target may use a link to escape its admitted artifact.
          const resolved = await realpath(file)
          const target = await readlink(file)
          if (
            input.platform !== "darwin" ||
            path.isAbsolute(target) ||
            !relative.startsWith("electron/Electron.app/") ||
            !resolved.startsWith(path.join(base, "electron", "Electron.app") + path.sep)
          )
            throw new Error("The computer overlay artifact contains an unsafe link.")
          continue
        }
        if (entry.isDirectory()) {
          await visit(file)
          continue
        }
        const status = await lstat(file)
        const metadata = manifest.files[relative]
        if (
          !status.isFile() ||
          status.isSymbolicLink() ||
          status.size < 1 ||
          status.size > 512 * 1024 * 1024 ||
          !metadata ||
          !(await realpath(file)).startsWith(base + path.sep) ||
          createHash("sha256")
            .update(await readFile(file))
            .digest("hex") !== metadata.sha256
        )
          throw new Error("A computer overlay artifact file failed its bounded byte check.")
        observed.push(relative)
        if (observed.length > 16_384) throw new Error("The computer overlay artifact file bound was exceeded.")
      }
    }
    await visit(base)
    if (observed.sort().join("\0") !== Object.keys(manifest.files).sort().join("\0"))
      throw new Error("The computer overlay artifact catalog is incomplete.")
    const paths = computerOverlayStagePaths(input.platform)
    return {
      root: base,
      manifest,
      driver: path.join(base, ...paths.driver.split("/")),
      electron: path.join(base, ...paths.electron.split("/")),
      main: path.join(base, ...COMPUTER_OVERLAY_STAGE_BUNDLES[0].split("/")),
    }
  } finally {
    await rm(generated, { recursive: true, force: true })
  }
}

/** These positively identified bootstrap prerequisites happen before any Electron process exists. */
export function parseComputerOverlayBootstrapUnavailable(bytes: Uint8Array, exitCode: number | null) {
  if (exitCode !== 77 || bytes.byteLength < 2 || bytes.byteLength > 4096) return undefined
  let value: unknown
  try {
    const line = new TextDecoder("utf-8", { fatal: true }).decode(bytes)
    if (!line.endsWith("\n") || line.split("\n").length !== 2) return undefined
    value = JSON.parse(line.slice(0, -1))
  } catch {
    return undefined
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
  const result = value as Record<string, unknown>
  if (
    Object.keys(result).sort().join(",") !== "check,id,ok,protocol,reason,skipped" ||
    result.id !== 1 ||
    result.protocol !== 1 ||
    result.check !== "native-os-stop" ||
    result.ok !== false ||
    result.skipped !== true ||
    !["medium_token_unavailable", "isolation_required", "noninteractive_desktop"].includes(String(result.reason))
  )
    return undefined
  return {
    protocol: 1 as const,
    platform: "win32" as const,
    skipped: true as const,
    reason:
      result.reason === "medium_token_unavailable"
        ? ("elevated_fixture" as const)
        : result.reason === "isolation_required"
          ? ("isolated_desktop_required" as const)
          : ("native_target_unavailable" as const),
  }
}
