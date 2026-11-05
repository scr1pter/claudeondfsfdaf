import path from "node:path"
import { fileURLToPath } from "node:url"
import { BUILD_IDENTITY_FILE, parseBuildIdentity, requiredCliVersion } from "./build-identity"
import { ensureComputerHelper } from "./computer-helper-package"
import { parseComputerHelperHashes } from "./computer-helper-package-build"
import { buildNodeComputerHelperPackage, computerHelperSkipRequested } from "./computer-helper-package-node"

type PackageTarget = "mac" | "win" | "linux"

declare const Bun: {
  env: NodeJS.ProcessEnv
  file(file: string): { json(): Promise<unknown>; text(): Promise<string> }
  resolveSync(specifier: string, directory: string): string
  spawnSync(
    command: string[],
    options: {
      cwd: string
      env: NodeJS.ProcessEnv
      stderr: "inherit" | "pipe"
      stdout: "inherit" | "pipe"
      timeout?: number
    },
  ): { exitCode: number; stdout: Buffer; stderr: Buffer }
}

export function computerHelperPackageRequests(input: {
  builderArgs: readonly string[]
  hostPlatform: string
  hostArchitecture: string
}) {
  const targets = [
    { flag: "--mac", platform: "darwin" },
    { flag: "--win", platform: "win32" },
    { flag: "--linux", platform: "linux" },
  ] as const
  const selected = targets.filter((target) =>
    input.builderArgs.some((argument) => argument === target.flag || argument.startsWith(`${target.flag}=`)),
  )
  const platforms = selected.length ? selected : targets.filter((target) => target.platform === input.hostPlatform)
  if (!platforms.length) throw new Error("The desktop package platform is unsupported.")
  return platforms.map((target) => {
    if (target.platform === "linux") return { platform: target.platform, architectures: [] }
    if (input.builderArgs.some((argument) => argument === "--ia32" || argument === "--armv7l"))
      throw new Error("The computer helper supports x64 and arm64 desktop packages only.")
    const flags = ["x64", "arm64", "universal"].filter((architecture) =>
      input.builderArgs.includes(`--${architecture}`),
    )
    if (target.platform === "win32" && flags.includes("universal"))
      throw new Error("Universal Windows computer helpers are unsupported.")
    const packageTargets = input.builderArgs.flatMap((argument, index) => {
      if (argument.startsWith(`${target.flag}=`)) return [argument.slice(target.flag.length + 1)]
      if (argument !== target.flag) return []
      const remaining = input.builderArgs.slice(index + 1)
      const end = remaining.findIndex((value) => value.startsWith("-"))
      return remaining.slice(0, end < 0 ? undefined : end)
    })
    const architectures = (packageTargets.length ? packageTargets : [""]).flatMap((value) => {
      const explicit = value.split(":")[1]
      const requested = explicit ? [explicit] : flags.length ? flags : [input.hostArchitecture]
      if (
        requested.some(
          (architecture) =>
            architecture !== "x64" &&
            architecture !== "arm64" &&
            (architecture !== "universal" || target.platform !== "darwin"),
        )
      )
        throw new Error("Choose a supported computer helper package architecture.")
      return requested.flatMap((architecture) => (architecture === "universal" ? ["x64", "arm64"] : [architecture]))
    })
    return {
      platform: target.platform,
      architectures: (["x64", "arm64"] as const).filter((architecture) => architectures.includes(architecture)),
    }
  })
}

export function packageRequest(input: {
  argv: readonly string[]
  version: string
  environmentChannel?: string
  unsignedRelease?: boolean
}): {
  channel: "dev" | "beta" | "prod"
  target: PackageTarget | undefined
  environment: Record<string, string>
  builderArgs: string[]
} {
  // Bun's named scripts insert --target before a caller's forwarding separator.
  // The separator belongs to the script runner, not electron-builder's parser.
  const argv = input.argv.filter((arg) => arg !== "--")
  const inlineChannel = argv.find((arg) => arg.startsWith("--channel="))?.slice("--channel=".length)
  const channelFlag = argv.indexOf("--channel")
  const separateChannel = channelFlag >= 0 ? argv[channelFlag + 1] : undefined
  const requestedChannel = inlineChannel ?? separateChannel
  if (inlineChannel && separateChannel && inlineChannel !== separateChannel) {
    throw new Error("Package channel was provided twice with different values")
  }
  if (requestedChannel && input.environmentChannel && requestedChannel !== input.environmentChannel) {
    throw new Error(`Package channel ${requestedChannel} does not match VECTOR_CHANNEL=${input.environmentChannel}`)
  }
  const channel = requestedChannel ?? input.environmentChannel
  if (channel !== "dev" && channel !== "beta" && channel !== "prod") {
    throw new Error("Packaging requires an explicit channel: --channel dev|beta|prod or VECTOR_CHANNEL")
  }

  const targetValue = argv.find((arg) => arg.startsWith("--target="))?.slice("--target=".length)
  if (targetValue && targetValue !== "mac" && targetValue !== "win" && targetValue !== "linux") {
    throw new Error(`Unsupported package target: ${targetValue}`)
  }
  const target = targetValue as PackageTarget | undefined
  const requestedBuilderArgs = argv.filter((arg, index) => {
    if (arg.startsWith("--channel=") || arg.startsWith("--target=")) return false
    if (arg === "--channel" || (channelFlag >= 0 && index === channelFlag + 1)) return false
    return true
  })
  const targetedBuilderArgs = target ? [`--${target}`, ...requestedBuilderArgs] : requestedBuilderArgs
  const publishFlag = targetedBuilderArgs.indexOf("--publish")
  const publish =
    targetedBuilderArgs.find((arg) => arg.startsWith("--publish="))?.slice("--publish=".length) ??
    (publishFlag >= 0 ? targetedBuilderArgs[publishFlag + 1] : undefined)
  if (input.unsignedRelease && channel === "prod" && publish && publish !== "never") {
    throw new Error("Unsigned production artifacts are manual-download-only and cannot publish an update feed")
  }
  return {
    channel,
    target,
    environment: {
      VECTOR_CHANNEL: channel,
      VECTOR_VERSION: input.version,
    },
    builderArgs:
      input.unsignedRelease && channel === "prod" && !publish
        ? [...targetedBuilderArgs, "--publish", "never"]
        : targetedBuilderArgs,
  }
}

export function macPackagePaths(input: {
  builderArgs: readonly string[]
  channel: "dev" | "beta" | "prod"
  hostArchitecture: string
}) {
  const architectureFlags = ["x64", "arm64", "universal"].filter((arch) => input.builderArgs.includes(`--${arch}`))
  const macFlag = input.builderArgs.findIndex((arg) => arg === "--mac" || arg.startsWith("--mac="))
  const remaining = input.builderArgs.slice(macFlag + 1)
  const nextFlag = remaining.findIndex((arg) => arg.startsWith("-"))
  const targets = input.builderArgs[macFlag]?.startsWith("--mac=")
    ? [input.builderArgs[macFlag].slice("--mac=".length)]
    : remaining.slice(0, nextFlag < 0 ? undefined : nextFlag)
  const architectures = [
    ...new Set(
      (targets.length ? targets : [""]).flatMap((target) => {
        const explicit = target.split(":")[1]
        if (explicit) return [explicit]
        return architectureFlags.length ? architectureFlags : [input.hostArchitecture]
      }),
    ),
  ]
  const name = input.channel === "prod" ? "Vector" : input.channel === "beta" ? "Vector Beta" : "Vector Dev"
  // electron-builder omits the suffix for x64. Do not scan all dist/mac*:
  // another architecture may still contain an unrelated, older package.
  return architectures.map((arch) => path.join("dist", arch === "x64" ? "mac" : `mac-${arch}`, `${name}.app`))
}

export function packageEnvironment(
  environment: Record<string, string | undefined>,
  unsigned: boolean,
): NodeJS.ProcessEnv {
  if (!unsigned) return { ...environment }
  return {
    ...Object.fromEntries(
      Object.entries(environment).filter(([name]) => !/^(?:CSC_|WIN_CSC_|APPLE_|SENTRY_)/i.test(name)),
    ),
    VECTOR_SIGN_MAC: "false",
    VECTOR_NOTARIZE: "false",
    VECTOR_SIGN_DMG: "false",
    CSC_IDENTITY_AUTO_DISCOVERY: "false",
  }
}

export function requireDeveloperIdApplicationSignature(signature: string) {
  if (
    !/^Authority=Developer ID Application: [^\r\n]+\r?$/m.test(signature) ||
    /^Signature=adhoc\r?$/m.test(signature) ||
    !/^TeamIdentifier=[A-Z0-9]{10}\r?$/m.test(signature)
  )
    throw new Error("VECTOR_SIGN_MAC requires an actual Developer ID Application signature.")
}

if (import.meta.main) {
  const packageDir = fileURLToPath(new URL("../", import.meta.url))
  const manifest: unknown = await Bun.file(path.join(packageDir, "package.json")).json()
  if (!manifest || typeof manifest !== "object" || !("version" in manifest) || typeof manifest.version !== "string") {
    throw new Error("Desktop package.json has no version")
  }
  const request = packageRequest({
    argv: process.argv.slice(2),
    version: manifest.version,
    environmentChannel: Bun.env.VECTOR_CHANNEL,
    unsignedRelease: Bun.env.VECTOR_ALLOW_UNSIGNED_RELEASE === "true",
  })
  const requiredVersion = requiredCliVersion(
    "vectorRequiredCliVersion" in manifest ? manifest.vectorRequiredCliVersion : undefined,
    Bun.env.VECTOR_REQUIRED_CLI_VERSION,
  )
  const environment = packageEnvironment(
    { ...process.env, ...request.environment, VECTOR_REQUIRED_CLI_VERSION: requiredVersion },
    Bun.env.VECTOR_ALLOW_UNSIGNED_RELEASE === "true",
  )
  const skipHelper = computerHelperSkipRequested(request.channel, environment)
  const helperRequests = computerHelperPackageRequests({
    builderArgs: request.builderArgs,
    hostPlatform: process.platform,
    hostArchitecture: process.arch,
  })
  const windowsHashes: Partial<Record<"x64" | "arm64", string>> = {}
  for (const helper of helperRequests) {
    const result = await ensureComputerHelper({
      ...helper,
      channel: request.channel,
      directory: packageDir,
      environment,
    })
    Object.assign(windowsHashes, result.windowsHashes)
  }
  const hasWindows = helperRequests.some((helper) => helper.platform === "win32")
  const suppliedHashes = parseComputerHelperHashes(environment.VECTOR_COMPUTER_HELPER_SHA256)
  if (
    hasWindows &&
    !skipHelper &&
    environment.VECTOR_COMPUTER_HELPER_SHA256 !== undefined &&
    (Object.keys(suppliedHashes).length !== Object.keys(windowsHashes).length ||
      (["x64", "arm64"] as const).some((architecture) => suppliedHashes[architecture] !== windowsHashes[architecture]))
  )
    throw new Error("The supplied Windows helper hash map differs from the verified final helper bytes.")
  const verifier =
    !skipHelper && helperRequests.some((helper) => helper.platform !== "linux")
      ? await buildNodeComputerHelperPackage(packageDir)
      : undefined
  const preparedEnvironment: NodeJS.ProcessEnv = {
    ...environment,
    ...(hasWindows ? { VECTOR_COMPUTER_HELPER_SHA256: JSON.stringify(windowsHashes) } : {}),
    ...(verifier
      ? {
          VECTOR_COMPUTER_HELPER_PACKAGE_SHA256: verifier.sha256,
          VECTOR_COMPUTER_HELPER_SIGN_SHA256: verifier.signing.sha256,
        }
      : {}),
  }
  run([process.execPath, "run", "--no-env-file", "build"], packageDir, preparedEnvironment, "Desktop build failed")

  const identity = parseBuildIdentity(await Bun.file(path.join(packageDir, "out", BUILD_IDENTITY_FILE)).text())
  if (
    !identity ||
    identity.channel !== request.channel ||
    identity.version !== manifest.version ||
    identity.requiredCliVersion !== requiredVersion
  ) {
    throw new Error("Desktop build identity does not match the requested package channel and version")
  }

  const builder = path.join(
    path.dirname(Bun.resolveSync("electron-builder/package.json", path.dirname(fileURLToPath(import.meta.url)))),
    "cli.js",
  )
  run(
    ["node", builder, "--config", "electron-builder.config.ts", ...request.builderArgs],
    packageDir,
    preparedEnvironment,
    "Desktop packaging failed",
  )

  if (helperRequests.some((helper) => helper.platform === "darwin")) {
    for (const appPath of macPackagePaths({
      builderArgs: request.builderArgs,
      channel: request.channel,
      hostArchitecture: process.arch,
    })) {
      if (preparedEnvironment.VECTOR_SIGN_MAC === "true") {
        run(
          ["/usr/bin/codesign", "--verify", "--deep", "--strict", appPath],
          packageDir,
          preparedEnvironment,
          "Developer ID app signature verification failed",
        )
        const signature = Bun.spawnSync(["/usr/bin/codesign", "--display", "--verbose=4", appPath], {
          cwd: packageDir,
          env: preparedEnvironment,
          stdout: "pipe",
          stderr: "pipe",
          timeout: 10_000,
        })
        if (signature.exitCode !== 0)
          throw new Error("The packaged Developer ID Application signature could not be read.")
        requireDeveloperIdApplicationSignature(signature.stdout.toString() + "\n" + signature.stderr.toString())
      }
      run(
        [process.execPath, "--no-env-file", "./scripts/verify-package.ts", appPath],
        packageDir,
        preparedEnvironment,
        "Packaged app verification failed",
      )
    }
  }
}

function run(command: string[], cwd: string, env: Record<string, string | undefined>, message: string) {
  const result = Bun.spawnSync(command, { cwd, env, stderr: "inherit", stdout: "inherit" })
  if (result.exitCode !== 0) throw new Error(`${message} with exit code ${result.exitCode}`)
}
