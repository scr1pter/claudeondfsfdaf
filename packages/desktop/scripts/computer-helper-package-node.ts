import { createHash } from "node:crypto"
import { lstat, mkdir, readFile, realpath } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import type { ComputerHelperPackContext } from "./computer-helper-package"

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
  const sources = new Set([
    path.join(base, "scripts/computer-helper-package.ts"),
    path.join(base, "scripts/build-computer-helper.ts"),
    path.join(base, "scripts/computer-helper-identity.ts"),
  ])
  const result = await Bun.build({
    entrypoints: [path.join(base, "scripts/computer-helper-package.ts")],
    target: "node",
    format: "esm",
    outdir: output,
    naming: bundleName,
    plugins: [
      {
        name: "preserve-computer-helper-package-source-roots",
        setup(builder) {
          builder.onLoad(
            { filter: /(?:computer-helper-(?:package|identity)|build-computer-helper)\.ts$/ },
            async (args) => {
              if (!sources.has(args.path)) return
              return {
                contents: (await readFile(args.path, "utf8")).replaceAll(
                  "import.meta.url",
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
  const file = path.join(output, bundleName)
  const status = await lstat(file)
  if (!status.isFile() || status.isSymbolicLink())
    throw new Error("The Node computer helper package verifier is not a regular file.")
  return { file, sha256: digest(await readFile(file)) }
}

export async function prepareComputerHelperNode(
  context: ComputerHelperPackContext,
  input: {
    channel: "prod" | "beta" | "dev"
    directory?: string
    environment?: NodeJS.ProcessEnv
  },
) {
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
  await verifier.prepareComputerHelper(context, { channel: input.channel, directory, environment })
}
