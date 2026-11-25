import { execFile } from "node:child_process"
import { cp, mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from "node:fs/promises"
import { createRequire } from "node:module"
import path from "node:path"
import { promisify } from "node:util"
import {
  emitWindowsHolderCompanion,
  verifyWindowsHolderBundle,
  windowsHolderBundlePlugin,
} from "../../engine/script/windows-holder-bundle"
import { windowsHolderCompanionName } from "../../engine/src/tool/shell/windows-holder-companion-name"
import { copyWindowsHolderResource } from "./windows-holder-resource"
import desktop from "../package.json"

const { CI, GITHUB_ACTIONS, GITHUB_JOB, GITHUB_RUN_ID, GITHUB_SHA, RUNNER_ARCH, RUNNER_ENVIRONMENT, RUNNER_TEMP } =
  process.env
const arch = process.env.VECTOR_WINDOWS_HOLDER_ARCH
const manifestSha256 = process.env.VECTOR_WINDOWS_HOLDER_MANIFEST_SHA256
if (
  process.platform !== "win32" ||
  (arch !== "x64" && arch !== "arm64") ||
  process.arch !== arch ||
  RUNNER_ARCH !== arch.toUpperCase() ||
  CI !== "true" ||
  GITHUB_ACTIONS !== "true" ||
  GITHUB_JOB !== "native" ||
  RUNNER_ENVIRONMENT !== "github-hosted" ||
  !RUNNER_TEMP ||
  !/^[a-z]:\\/i.test(RUNNER_TEMP) ||
  path.win32.normalize(RUNNER_TEMP) !== RUNNER_TEMP ||
  !/^[1-9][0-9]{0,29}$/.test(GITHUB_RUN_ID ?? "") ||
  GITHUB_RUN_ID !== process.env.VECTOR_WINDOWS_HOLDER_BUILD_RUN ||
  !GITHUB_SHA ||
  GITHUB_SHA !== process.env.VECTOR_WINDOWS_HOLDER_REVISION ||
  !manifestSha256 ||
  !/^[a-f0-9]{64}$/.test(manifestSha256)
) {
  throw new Error("The Electron holder smoke requires its exact hosted Windows holder job.")
}

const executableVersion = desktop.devDependencies.electron
const require = createRequire(import.meta.url)
const electronPackage = require.resolve("electron/package.json")
const distribution = path.join(path.dirname(electronPackage), "dist")
if (
  require(electronPackage).version !== executableVersion ||
  (await readFile(path.join(distribution, "version"), "utf8")).trim().replace(/^v/, "") !== executableVersion ||
  path.relative(distribution, await realpath(distribution)) !== ""
) {
  throw new Error("The exact pinned Electron distribution is required.")
}
const manifest = path.join(RUNNER_TEMP, "vector-windows-holder-bundle", "manifest.json")
const assets = await verifyWindowsHolderBundle({
  manifest,
  pin: manifestSha256,
  checkout: GITHUB_SHA,
  architectures: [arch],
  expectedWire: "vsh1",
})
const asset = assets[arch]
if (!asset) throw new Error("The paired Electron holder asset is missing.")

const directory = await mkdtemp(path.join(RUNNER_TEMP, "vector-electron-holder-check-"))
try {
  const staged = path.join(directory, "engine/dist/node/windows-holder")
  await mkdir(staged, { recursive: true })
  const holder = await emitWindowsHolderCompanion(staged, asset)
  const targets = { [arch]: holder }
  await writeFile(path.join(staged, "desktop-build.json"), JSON.stringify({ version: 1, manifestSha256, targets }), {
    flag: "wx",
  })

  const app = path.join(directory, "application")
  const resources = path.join(app, "resources")
  await cp(distribution, app, { recursive: true, force: false, errorOnExist: true })
  // Electron's Windows app.isPackaged checks the executable basename.
  const executable = path.join(app, "VectorHolderSmoke.exe")
  await rename(path.join(app, "electron.exe"), executable)
  await copyWindowsHolderResource(path.join(directory, "desktop"), resources, arch, {
    GITHUB_ACTIONS,
    VECTOR_WINDOWS_HOLDER_MANIFEST: manifest,
    VECTOR_WINDOWS_HOLDER_MANIFEST_SHA256: manifestSha256,
  })
  const holderFile = path.join(resources, "engine", "windows-holder", windowsHolderCompanionName(arch, holder.sha256))

  const archiveSource = path.join(directory, "archive-source")
  const archiveFile = path.join(resources, "app.asar")
  const bundle = await Bun.build({
    entrypoints: [path.join(import.meta.dirname, "../../engine/test/fixture/windows-holder-electron.ts")],
    outdir: archiveSource,
    target: "node",
    format: "esm",
    naming: "utility.mjs",
    plugins: [windowsHolderBundlePlugin(assets, [arch], { placement: "electron", targets })],
  })
  if (!bundle.success || bundle.outputs.length !== 1) throw new Error("The Electron holder utility bundle failed.")
  await writeFile(
    path.join(archiveSource, "package.json"),
    JSON.stringify({ name: "vector-holder-smoke", main: "main.mjs" }),
  )
  await writeFile(
    path.join(archiveSource, "main.mjs"),
    `
import { app, utilityProcess } from "electron"
import { join } from "node:path"

const mode = process.env.VECTOR_WINDOWS_HOLDER_ELECTRON_CHECK
const report = "vector-holder-electron " + mode + "\\n"
app.disableHardwareAcceleration()
const timer = setTimeout(() => app.exit(4), 25_000)
app.whenReady().then(() => {
  if (!app.isPackaged || process.defaultApp) return app.exit(2)
  if (app.getAppPath().toLowerCase() !== join(process.resourcesPath, "app.asar").toLowerCase()) return app.exit(3)
  const utility = utilityProcess.fork(join(app.getAppPath(), "utility.mjs"),
    [mode, ${JSON.stringify(arch)}, ${JSON.stringify(executableVersion)}],
    { stdio: "pipe", serviceName: "vector-holder-smoke" })
  let received = false
  utility.once("error", () => app.exit(5))
  utility.on("message", (message) => {
    if (received || message !== report) return app.exit(6)
    received = true
    process.stdout.write(message, () => utility.postMessage("acknowledge"))
  })
  utility.on("exit", (code) => {
    clearTimeout(timer)
    if (received && code === 0) return app.exit(0)
    app.exit(Number.isInteger(code) && code >= 10 && code <= 16 ? code : 7)
  })
}).catch(() => app.exit(8))
`,
  )
  const builder = createRequire(require.resolve("electron-builder/package.json"))
  const packager = createRequire(builder.resolve("app-builder-lib/package.json"))
  const asar = packager("@electron/asar") as { createPackage(source: string, destination: string): Promise<void> }
  await asar.createPackage(archiveSource, archiveFile)

  const run = promisify(execFile)
  const stages = new Map([
    [2, "packaged-identity"],
    [3, "asar-path"],
    [4, "electron-watchdog"],
    [5, "utility-fork"],
    [6, "utility-receipt"],
    [7, "utility-exit"],
    [8, "electron-ready"],
    [10, "utility-channel"],
    [11, "utility-identity"],
    [12, "utility-resources"],
    [13, "holder-selection"],
    [14, "holder-start"],
    [15, "holder-completion"],
    [16, "holder-assertions"],
  ])
  const probe = async (mode: "present" | "missing" | "changed") => {
    const profile = path.join(directory, mode)
    await mkdir(profile)
    const result = await run(
      executable,
      [`--user-data-dir=${profile}`, "--disable-background-networking", "--disable-component-update", "--no-first-run"],
      {
        env: {
          SystemRoot: "C:\\Windows",
          WINDIR: "C:\\Windows",
          TEMP: profile,
          TMP: profile,
          APPDATA: profile,
          LOCALAPPDATA: profile,
          VECTOR_WINDOWS_HOLDER_ELECTRON_CHECK: mode,
        },
        windowsHide: true,
        timeout: 30_000,
        maxBuffer: 4096,
      },
    ).catch((error: unknown) => {
      const code = error && typeof error === "object" && "code" in error ? error.code : undefined
      const stage = (typeof code === "number" ? stages.get(code) : undefined) ?? "electron-launch"
      throw new Error(`The packaged Electron holder check failed during the ${mode} case (${stage}).`)
    })
    if (result.stdout.trim() !== `vector-holder-electron ${mode}`)
      throw new Error("The Electron holder receipt is invalid.")
  }
  await probe("present")
  await rm(holderFile)
  await probe("missing")
  await writeFile(holderFile, Buffer.alloc(holder.size), { flag: "wx" })
  await probe("changed")
  console.log(
    `The pinned Electron utility verified native ${arch} resources, direct startup and fail-closed admission.`,
  )
} finally {
  await rm(directory, { recursive: true, force: true, maxRetries: 4, retryDelay: 50 })
}
