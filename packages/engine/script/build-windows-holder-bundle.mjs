import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { appendFile, lstat, mkdir, mkdtemp, readdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { compiledSource, maximumExecutableBytes, validateExecutable } from "./windows-holder-binary.ts"

const repository = fileURLToPath(new URL("../../..", import.meta.url))
const maintainedHolder = "packages/engine/src/tool/shell/windows-holder.ts"
const binaryAbi = "packages/engine/script/windows-holder-binary.ts"
const maximumSourceBytes = 65_536
const revisionPattern = /^[0-9a-f]{40}$/
const numberPattern = /^[1-9][0-9]{0,29}$/
const compilerPlatforms = { x64: "x64", arm64: "anycpu" }
const outputName = "vector-windows-holder-bundle"

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

export function holderManifest(revision, source, executables) {
  if (!revisionPattern.test(revision)) throw new Error("Invalid reviewed revision.")
  const keys = Object.keys(executables).sort().join(",")
  if (keys !== "x64" && keys !== "arm64,x64") throw new Error("Invalid Windows holder target set.")
  const targets = {}
  for (const arch of ["x64", "arm64"]) {
    if (!Object.hasOwn(executables, arch)) continue
    const bytes = executables[arch]
    if (!Buffer.isBuffer(bytes)) throw new Error("Expected a Windows holder executable.")
    validateExecutable(bytes, arch)
    targets[arch] = {
      sourceSha256: sha256(compiledSource(source, arch)),
      executableSha256: sha256(bytes),
      size: bytes.length,
    }
  }
  return Buffer.from(JSON.stringify({ version: 1, revision, targets }) + "\n")
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
      maxBuffer: maximumSourceBytes,
      stdio: ["ignore", "pipe", "ignore"],
    })
    if (result.error || result.status !== 0) throw new Error("Could not verify the exact checkout.")
    return result.stdout
  }
  if (read(["rev-parse", "--verify", "HEAD"]).toString("ascii").trim() !== revision) {
    throw new Error("The reviewed revision does not match the checkout.")
  }
  const trackedBytes = async (name) => {
    const bytes = await boundedFile(path.join(repository, name), maximumSourceBytes)
    const content = new TextDecoder("utf-8", { fatal: true }).decode(bytes).replaceAll("\r\n", "\n")
    if (!Buffer.from(content).equals(read(["show", revision + ":" + name]))) {
      throw new Error("An input differs from its committed source.")
    }
    return bytes
  }
  await trackedBytes(binaryAbi)
  return trackedBytes(maintainedHolder)
}

async function buildWindowsHolder(input, runner) {
  const source = await readCommittedSource(input.revision, runner)
  const root = await realpath(runner.env.RUNNER_TEMP)
  if (root.toLowerCase() !== runner.env.RUNNER_TEMP.toLowerCase()) throw new Error("Noncanonical build scratch.")
  const framework = path.win32.join(runner.env.SystemRoot, "Microsoft.NET", "Framework64", "v4.0.30319")
  const compiler = path.win32.join(framework, "csc.exe")
  const references = ["System.dll", "System.Core.dll", "System.Web.Extensions.dll"].map(
    (name) => "/reference:" + path.win32.join(framework, name),
  )
  const staging = await mkdtemp(path.join(root, "vector-holder-build-"))
  try {
    const artifact = path.join(staging, "artifact")
    await mkdir(artifact)
    const executables = {}
    for (const arch of input.architectures) {
      const file = path.join(staging, "holder-" + arch + ".cs")
      const output = path.join(artifact, "holder-" + arch + ".exe")
      await writeFile(file, compiledSource(source, arch), { flag: "wx" })
      const result = spawnSync(
        compiler,
        [
          "/nologo",
          "/noconfig",
          "/target:exe",
          "/platform:" + compilerPlatforms[arch],
          "/main:VectorStandaloneEntryPoint",
          ...references,
          "/out:" + output,
          file,
        ],
        {
          cwd: path.win32.join(runner.env.SystemRoot, "System32"),
          env: runner.cleanEnv,
          windowsHide: true,
          stdio: "ignore",
          timeout: 30_000,
        },
      )
      if (result.error || result.status !== 0) throw new Error("The fixed Windows compiler could not build the holder.")
      executables[arch] = await boundedFile(output, maximumExecutableBytes)
    }
    const manifest = holderManifest(input.revision, source, executables)
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
