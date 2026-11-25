import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { appendFile, lstat, mkdir, mkdtemp, readdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { maximumExecutableBytes, validateNativeExecutable } from "./windows-holder-binary.ts"
import {
  canonicalWindowsHolderNativeSource,
  maximumNativeSourceBytes,
  windowsHolderNativeSources,
  windowsHolderNativeSourceSha256,
} from "./windows-holder-native-source.mjs"

const repository = fileURLToPath(new URL("../../..", import.meta.url))
const binaryAbi = "packages/engine/script/windows-holder-binary.ts"
const sourceAbi = "packages/engine/script/windows-holder-native-source.mjs"
const nativeDirectory = "packages/engine/native/windows-holder/"
const revisionPattern = /^[0-9a-f]{40}$/
const numberPattern = /^[1-9][0-9]{0,29}$/
const compilerPlatforms = { x64: "x64", arm64: "ARM64" }
const visualStudioGenerators = new Map([
  ["17.0", "Visual Studio 17 2022"],
  ["18.0", "Visual Studio 18 2026"],
])
const outputName = "vector-windows-holder-bundle"
const compilerVariables = new Set([
  "SYSTEMROOT",
  "SYSTEMDRIVE",
  "WINDIR",
  "TEMP",
  "TMP",
  "PATH",
  "COMSPEC",
  "PROGRAMDATA",
  "PROGRAMFILES",
  "PROGRAMFILES(X86)",
  "PROGRAMW6432",
  "PROCESSOR_ARCHITECTURE",
  "NUMBER_OF_PROCESSORS",
  "INCLUDE",
  "LIB",
  "LIBPATH",
  "VCINSTALLDIR",
  "VCTOOLSINSTALLDIR",
  "VCTOOLSVERSION",
  "VSINSTALLDIR",
  "VISUALSTUDIOVERSION",
  "WINDOWSSDKDIR",
  "WINDOWSSDKVERSION",
  "UNIVERSALCRTSDKDIR",
  "UCRTVERSION",
])

export function parseBuildInputs(argv) {
  const [declaredRevision, declaration] = argv
  if (
    argv.length !== 2 ||
    !revisionPattern.test(declaredRevision ?? "") ||
    (declaration !== "x64" && declaration !== "x64,arm64")
  ) {
    throw new Error("Expected a full reviewed revision and x64 or x64,arm64.")
  }
  return { revision: declaredRevision, architectures: declaration.split(",") }
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex")
}

export function holderManifest(revision, sources, executables) {
  if (!revisionPattern.test(revision)) throw new Error("Invalid reviewed revision.")
  const keys = Object.keys(executables).sort().join(",")
  if (keys !== "x64" && keys !== "arm64,x64") throw new Error("Invalid Windows holder target set.")
  const sourceSha256 = windowsHolderNativeSourceSha256(sources)
  const targets = {}
  for (const arch of ["x64", "arm64"]) {
    if (!Object.hasOwn(executables, arch)) continue
    const bytes = executables[arch]
    if (!Buffer.isBuffer(bytes)) throw new Error("Expected a Windows holder executable.")
    validateNativeExecutable(bytes, arch)
    targets[arch] = {
      sourceSha256,
      executableSha256: sha256(bytes),
      size: bytes.length,
    }
  }
  return Buffer.from(JSON.stringify({ version: 2, revision, targets }) + "\n")
}

async function boundedFile(file, maximum) {
  const info = await lstat(file)
  if (
    !info.isFile() ||
    info.nlink !== 1 ||
    info.size < 1 ||
    info.size > maximum ||
    (await realpath(file)).toLowerCase() !== file.toLowerCase()
  ) {
    throw new Error("Invalid file in the Windows holder producer.")
  }
  const bytes = await readFile(file)
  if (bytes.length !== info.size) throw new Error("Windows holder file changed while reading it.")
  return bytes
}

function hostedBuild(env) {
  if (
    process.platform !== "win32" ||
    process.arch !== "x64" ||
    env.RUNNER_ARCH !== "X64" ||
    env.CI !== "true" ||
    env.GITHUB_ACTIONS !== "true" ||
    env.RUNNER_ENVIRONMENT !== "github-hosted" ||
    env.VECTOR_WINDOWS_HOLDER_PRODUCER !== "1" ||
    !numberPattern.test(env.GITHUB_RUN_ID ?? "") ||
    !numberPattern.test(env.GITHUB_RUN_ATTEMPT ?? "")
  ) {
    throw new Error("An explicitly authorized disposable hosted Windows x64 job is required.")
  }
  for (const candidate of [env.SystemRoot, env.ProgramFiles, env.RUNNER_TEMP, env.GITHUB_OUTPUT]) {
    if (!candidate || !/^[a-z]:\\/i.test(candidate) || path.win32.normalize(candidate) !== candidate) {
      throw new Error("Invalid fixed Windows build location.")
    }
  }
  const outputLocation = path.win32.relative(env.RUNNER_TEMP, env.GITHUB_OUTPUT)
  if (!outputLocation || path.win32.isAbsolute(outputLocation) || outputLocation.split(path.win32.sep)[0] === "..") {
    throw new Error("Invalid hosted build output location.")
  }
  const cleanEnv = Object.fromEntries(
    ["SystemRoot", "WINDIR", "TEMP", "TMP"].flatMap((name) => (env[name] ? [[name, env[name]]] : [])),
  )
  return { env, cleanEnv }
}

async function readCommittedSource(revision, runner) {
  const git = path.win32.join(runner.env.ProgramFiles, "Git", "cmd", "git.exe")
  const gitEnv = {
    ...runner.cleanEnv,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "NUL",
    GIT_OPTIONAL_LOCKS: "0",
  }
  const read = (args) => {
    const result = spawnSync(git, args, {
      cwd: repository,
      env: gitEnv,
      windowsHide: true,
      timeout: 15_000,
      maxBuffer: maximumNativeSourceBytes,
      stdio: ["ignore", "pipe", "ignore"],
    })
    if (result.error || result.status !== 0) throw new Error("Could not verify the exact checkout.")
    return result.stdout
  }
  if (read(["rev-parse", "--verify", "HEAD"]).toString("ascii").trim() !== revision) {
    throw new Error("The reviewed revision does not match the checkout.")
  }
  const trackedBytes = async (name) => {
    const bytes = await boundedFile(path.join(repository, name), maximumNativeSourceBytes)
    const content = canonicalWindowsHolderNativeSource(bytes)
    if (!content.equals(canonicalWindowsHolderNativeSource(read(["show", revision + ":" + name])))) {
      throw new Error("An input differs from its committed source.")
    }
    return content
  }
  await Promise.all([binaryAbi, sourceAbi].map(trackedBytes))
  return Object.fromEntries(
    await Promise.all(windowsHolderNativeSources.map(async (file) => [file, await trackedBytes(file)])),
  )
}

function windowsToolchain(runner) {
  const generator = visualStudioGenerators.get(runner.env.VisualStudioVersion?.trim())
  const toolset = runner.env.VCToolsVersion?.trim()
  const sdk = runner.env.WindowsSDKVersion?.trim().replace(/[\\/]$/, "")
  if (!generator || !/^\d+\.\d+\.\d+$/.test(toolset ?? "") || !/^10\.0\.\d+\.\d+$/.test(sdk ?? ""))
    throw new Error("The pinned MSVC developer environment is unavailable.")
  return {
    cmake: path.win32.join(runner.env.ProgramFiles, "CMake", "bin", "cmake.exe"),
    env: Object.fromEntries(Object.entries(runner.env).filter(([name]) => compilerVariables.has(name.toUpperCase()))),
    generator,
    sdk,
    toolset,
  }
}

function runCmake(toolchain, source, arch, step, args) {
  const result = spawnSync(toolchain.cmake, args, {
    cwd: source,
    env: toolchain.env,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
    maxBuffer: 1_048_576,
    timeout: 120_000,
  })
  if (!result.error && result.status === 0) return

  const output = [result.stdout, result.stderr].join("\n")
  console.error(
    "Windows native holder build failure: " +
      JSON.stringify({
        arch,
        step,
        exitCode: result.status,
        signal: result.signal,
        cmakeErrors: Math.min(8, output.match(/^\s*CMake Error(?=[: \t])/gm)?.length ?? 0),
        msvcCodes: [
          ...new Set(
            [...output.matchAll(/\berror\s+((?:C|D|RC|LNK|MSB)\d{4})\b/gi)].map((match) => match[1].toUpperCase()),
          ),
        ].slice(0, 8),
        generator: toolchain.generator,
        spawnError: ["ENOENT", "ETIMEDOUT", "ENOBUFS", "EACCES"].includes(result.error?.code)
          ? result.error.code
          : null,
      }),
  )
  throw new Error("The pinned MSVC toolchain could not build the Windows holder.")
}

async function buildWindowsHolder(input, runner) {
  const sources = await readCommittedSource(input.revision, runner)
  const root = await realpath(runner.env.RUNNER_TEMP)
  if (root.toLowerCase() !== runner.env.RUNNER_TEMP.toLowerCase()) throw new Error("Noncanonical build scratch.")
  const toolchain = windowsToolchain(runner)
  const staging = await mkdtemp(path.join(root, "vector-holder-build-"))
  try {
    const artifact = path.join(staging, "artifact")
    const source = path.join(staging, "source")
    await mkdir(artifact)
    await mkdir(source)
    for (const file of windowsHolderNativeSources.filter((file) => file.startsWith(nativeDirectory)))
      await writeFile(path.join(source, path.basename(file)), sources[file], { flag: "wx" })
    const executables = {}
    for (const arch of input.architectures) {
      const build = path.join(staging, arch)
      runCmake(toolchain, source, arch, "configure", [
        "-S",
        source,
        "-B",
        build,
        "-G",
        toolchain.generator,
        "-A",
        `${compilerPlatforms[arch]},version=${toolchain.sdk}`,
        "-T",
        `version=${toolchain.toolset}`,
        "--fresh",
      ])
      runCmake(toolchain, source, arch, "compile", [
        "--build",
        build,
        "--config",
        "Release",
        "--target",
        "vector-holder-probe",
      ])
      const bytes = await boundedFile(path.join(build, "Release", "holder.exe"), maximumExecutableBytes)
      validateNativeExecutable(bytes, arch)
      await writeFile(path.join(artifact, "holder-" + arch + ".exe"), bytes, { flag: "wx" })
      executables[arch] = bytes
    }
    const manifest = holderManifest(input.revision, sources, executables)
    await writeFile(path.join(artifact, "manifest.json"), manifest, { flag: "wx" })
    const expectedFiles = ["manifest.json", ...input.architectures.map((arch) => "holder-" + arch + ".exe")].sort()
    if ((await readdir(artifact)).sort().join("|") !== expectedFiles.join("|")) {
      throw new Error("Unexpected files in the Windows holder artifact.")
    }
    await rename(artifact, path.join(root, outputName))
    await appendFile(
      runner.env.GITHUB_OUTPUT,
      [
        "manifest_digest=" + sha256(manifest),
        "source_revision=" + input.revision,
        "build_run_id=" + runner.env.GITHUB_RUN_ID,
        "build_attempt=" + runner.env.GITHUB_RUN_ATTEMPT,
        "",
      ].join("\n"),
    )
  } finally {
    await rm(staging, { recursive: true, force: true, maxRetries: 4, retryDelay: 50 })
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const input = parseBuildInputs([
      process.env.VECTOR_WINDOWS_HOLDER_SOURCE_REVISION,
      process.env.VECTOR_WINDOWS_HOLDER_TARGETS,
    ])
    await buildWindowsHolder(input, hostedBuild(process.env))
  } catch (cause) {
    console.error(
      cause instanceof Error && !("code" in cause) ? cause.message : "Windows holder artifact build failed.",
    )
    process.exitCode = 1
  }
}
