import { createHash } from "node:crypto"
import { lstat, mkdir, readFile, realpath } from "node:fs/promises"
import { createRequire } from "node:module"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import type { ComputerHelperPackContext, ComputerHelperPackageResult } from "./computer-helper-package"

declare const Bun: {
  build(options: {
    entrypoints: string[]
    target: "node"
    format: "esm"
    outdir: string
    naming: string
    plugins: {
      name: string
      setup(builder: {
        onLoad(
          options: { filter: RegExp },
          load: (args: { path: string }) => Promise<{ contents: string; loader: "ts" } | undefined>,
        ): void
      }): void
    }[]
  }): Promise<{ success: boolean }>
}

const packageDirectory = fileURLToPath(new URL("../", import.meta.url))
const bundleDirectory = "native/build/computer-helper-package-node"
const bundleName = "prepare.mjs"
const signingBundleName = "signing.mjs"
const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex")

export function computerHelperSkipRequested(channel: "prod" | "beta" | "dev", environment: NodeJS.ProcessEnv) {
  const value = environment.VECTOR_COMPUTER_HELPER
  if (value !== undefined && value !== "skip")
    throw new Error("VECTOR_COMPUTER_HELPER only accepts the explicit dev-only skip option.")
  if (value === "skip" && channel !== "dev") throw new Error("Only an explicit dev build may skip the computer helper.")
  return value === "skip"
}

/** One compiler-only Bun call; afterPack executes the resulting verifier in actual Node. */
export async function buildNodeComputerHelperPackage(directory = packageDirectory) {
  if (typeof Bun === "undefined" || typeof Bun.build !== "function")
    throw new Error("Build the computer helper package verifier with Bun.")
  const base = await realpath(directory)
  const output = path.join(base, bundleDirectory)
  await mkdir(output, { recursive: true })
  if (!(await realpath(output)).startsWith(base + path.sep))
    throw new Error("The computer helper verifier output escapes its package.")
  const hands = await realpath(createRequire(import.meta.url).resolve("@vectordevai/schema/hands"))
  if (!(await lstat(hands)).isFile()) throw new Error("The computer helper brand source is not a regular file.")
  const sources = new Set([
    path.join(base, "scripts/computer-helper-package.ts"),
    path.join(base, "scripts/computer-helper-package-node.ts"),
    path.join(base, "scripts/computer-helper-sign.ts"),
    path.join(base, "scripts/build-computer-helper.ts"),
    path.join(base, "scripts/computer-helper-identity.ts"),
    hands,
  ])
  for (const entry of [
    { source: "computer-helper-package.ts", name: bundleName },
    { source: "computer-helper-sign.ts", name: signingBundleName },
  ]) {
    const result = await Bun.build({
      entrypoints: [path.join(base, "scripts", entry.source)],
      target: "node",
      format: "esm",
      outdir: output,
      naming: entry.name,
      plugins: [
        {
          name: "preserve-computer-helper-package-source-roots",
          setup(builder) {
            builder.onLoad(
              {
                filter:
                  /(?:(?:computer-helper-(?:package(?:-node)?|identity|sign)|build-computer-helper)\.ts|[/\\]hands\.ts)$/,
              },
              async (args) => {
                if (!sources.has(args.path)) return
                // Hands self-reexports its namespace. Read its authoritative source independently
                // of Bun.test's runtime module cache, just as for our transformed build entries.
                return {
                  contents: (await readFile(args.path, "utf8")).replaceAll(
                    /\bimport\.meta\.url\b/g,
                    JSON.stringify(pathToFileURL(args.path).href),
                  ),
                  loader: "ts",
                }
              },
            )
          },
        },
      ],
    })
    if (!result.success) throw new Error("The Node computer helper package verifier could not be built.")
  }
  const file = path.join(output, bundleName)
  const status = await lstat(file)
  if (!status.isFile() || status.isSymbolicLink())
    throw new Error("The Node computer helper package verifier is not a regular file.")
  const signingFile = path.join(output, signingBundleName)
  const signingStatus = await lstat(signingFile)
  if (!signingStatus.isFile() || signingStatus.isSymbolicLink())
    throw new Error("The Node computer helper signing module is not a regular file.")
  return {
    file,
    sha256: digest(await readFile(file)),
    signing: { file: signingFile, sha256: digest(await readFile(signingFile)) },
  }
}

export async function prepareComputerHelperNode(
  context: ComputerHelperPackContext,
  input: {
    channel: "prod" | "beta" | "dev"
    directory?: string
    environment?: NodeJS.ProcessEnv
  },
): Promise<ComputerHelperPackageResult | undefined> {
  const environment = input.environment ?? process.env
  if (computerHelperSkipRequested(input.channel, environment) || context.electronPlatformName === "linux") return
  if (context.electronPlatformName !== "darwin" && context.electronPlatformName !== "win32")
    throw new Error("The computer helper package platform is unsupported.")
  const expected = environment.VECTOR_COMPUTER_HELPER_PACKAGE_SHA256
  if (!expected || !/^[a-f0-9]{64}$/.test(expected))
    throw new Error("The computer helper package verifier was not prepared. Use the desktop package script.")
  const directory = await realpath(input.directory ?? packageDirectory)
  const file = path.join(directory, bundleDirectory, bundleName)
  const status = await lstat(file)
  const resolved = await realpath(file)
  if (
    !status.isFile() ||
    status.isSymbolicLink() ||
    !resolved.startsWith(directory + path.sep) ||
    digest(await readFile(file)) !== expected
  )
    throw new Error("The Node computer helper package verifier failed its build hash check.")
  const verifier: unknown = await import(`${pathToFileURL(resolved).href}?sha256=${expected}`)
  if (
    !verifier ||
    typeof verifier !== "object" ||
    !("prepareComputerHelper" in verifier) ||
    typeof verifier.prepareComputerHelper !== "function"
  )
    throw new Error("The Node computer helper package verifier has no afterPack entry.")
  const result: unknown = await verifier.prepareComputerHelper(context, {
    channel: input.channel,
    directory,
    environment,
  })
  if (
    !result ||
    typeof result !== "object" ||
    !("manifests" in result) ||
    !Array.isArray(result.manifests) ||
    !("skipped" in result) ||
    result.skipped !== false
  )
    throw new Error("The Node computer helper verifier returned no verified artifact.")
  return result as ComputerHelperPackageResult
}

/** All builder signing hooks share this one verified Node module and its private baseline map. */
export async function loadComputerHelperSigningNode(
  input: { directory?: string; environment?: NodeJS.ProcessEnv } = {},
) {
  const environment = input.environment ?? process.env
  const expected = environment.VECTOR_COMPUTER_HELPER_SIGN_SHA256
  if (!expected || !/^[a-f0-9]{64}$/.test(expected))
    throw new Error("The computer helper signing module was not prepared. Use the desktop package script.")
  const directory = await realpath(input.directory ?? packageDirectory)
  const file = path.join(directory, bundleDirectory, signingBundleName)
  const status = await lstat(file)
  const resolved = await realpath(file)
  if (
    !status.isFile() ||
    status.isSymbolicLink() ||
    !resolved.startsWith(directory + path.sep) ||
    digest(await readFile(file)) !== expected
  )
    throw new Error("The Node computer helper signing module failed its build hash check.")
  const signer: unknown = await import(`${pathToFileURL(resolved).href}?sha256=${expected}`)
  if (
    !signer ||
    typeof signer !== "object" ||
    [
      "prepareComputerHelperMacSigning",
      "signComputerHelperMac",
      "finalizeComputerHelperMacSigning",
      "verifyComputerHelperMacSigningArtifacts",
      "signUnsignedMacWithComputerHelper",
      "installUnsignedMacComputerHelperFuses",
      "signMacWithComputerHelper",
    ].some((name) => typeof Reflect.get(signer, name) !== "function")
  )
    throw new Error("The Node computer helper signing module has no required entry point.")
  return signer as typeof import("./computer-helper-sign")
}
