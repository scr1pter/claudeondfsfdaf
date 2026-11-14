import { createHash } from "node:crypto"
import { readFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import type { BunPlugin } from "bun"

// Both build targets embed the same bytes. Runtime code has no source-file fallback.
export function encodeLinuxIsolationAsset(bytes: Uint8Array) {
  if (!bytes.length || bytes.length > 131_072) throw new Error("Invalid Linux isolation asset size")
  const entry = new TextDecoder("utf-8", { fatal: true }).decode(bytes)
  if (entry.includes("\0") || !Buffer.from(entry, "utf8").equals(bytes))
    throw new Error("Linux isolation assets must preserve their exact UTF-8 bytes")
  const literal = JSON.stringify({
    v: 1,
    entry,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  })
  if (Buffer.byteLength(literal) > 262_144) throw new Error("Linux isolation asset transport is too large")
  return literal
}

export function linuxIsolationCIMode(args: readonly string[], githubActions: string | undefined) {
  const requested = args.includes("--isolation-ci")
  if (requested && githubActions !== "true")
    throw new Error("The Linux isolation CI build requires an explicit GitHub Actions build")
  return requested
}

export async function linuxIsolationDefines(ci = false) {
  if (typeof ci !== "boolean") throw new Error("Invalid Linux isolation build mode")
  return {
    VECTOR_LINUX_ISOLATION_ASSET: encodeLinuxIsolationAsset(
      await readFile(new URL("../packages/core/src/process-isolation/linux/entry.py", import.meta.url)),
    ),
    VECTOR_LINUX_ISOLATION_CI: String(ci),
  }
}

export async function linuxIsolationBuildPlugin(ci = false): Promise<BunPlugin> {
  const literal = await linuxIsolationDefines(ci)
  const sha256: string = JSON.parse(literal.VECTOR_LINUX_ISOLATION_ASSET).sha256
  const module = fileURLToPath(new URL("../packages/engine/src/cli/cmd/github.isolation-build.ts", import.meta.url))
  const core = fileURLToPath(new URL("../packages/core/src/process-isolation/build.ts", import.meta.url))
  return {
    name: "vector-linux-isolation-asset",
    setup(build) {
      build.onLoad({ filter: /[/\\]github\.isolation-build\.ts$/ }, (args) => {
        if (args.path !== module) return
        return {
          contents: [
            `export const enabled = ${literal.VECTOR_LINUX_ISOLATION_CI}`,
            `export const asset = Object.freeze(${literal.VECTOR_LINUX_ISOLATION_ASSET})`,
            'export * as GithubIsolationBuild from "./github.isolation-build"',
          ].join("\n"),
          loader: "ts",
        }
      })
      build.onLoad({ filter: /[/\\]process-isolation[/\\]build\.ts$/ }, (args) => {
        if (args.path !== core) return
        return {
          contents: [
            `export const enabled = ${literal.VECTOR_LINUX_ISOLATION_CI}`,
            `export const entrySHA = ${JSON.stringify(sha256)}`,
            'export * as LinuxIsolationBuild from "./build"',
          ].join("\n"),
          loader: "ts",
        }
      })
    },
  }
}
