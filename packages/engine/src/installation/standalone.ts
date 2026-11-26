import { createHash, randomBytes } from "node:crypto"
import { spawn } from "node:child_process"
import { lstat, mkdir, readFile, readdir, realpath, rm, rmdir, writeFile } from "node:fs/promises"
import path from "node:path"
import { Schema } from "effect"
import { CliRelease } from "@vectordevai/schema/cli-release"
import { WindowsPowerShell } from "@vectordevai/core/util/windows-powershell"
import { Egress } from "@vectordevai/core/local-mode/egress"

export type Receipt = {
  directory: string
  executable: string
  metadata: string
  version: string
  target: CliRelease.Target
  channel: CliRelease.Channel
  binary: string
  binarySha256: string
  archiveSha256: string
}
export type Result = { status: "complete" } | { status: "scheduled"; statusFile: string }
export type Run = (command: string[]) => Promise<{ code: number; stdout: string; stderr: string }>
const notices = ["LICENSE", "THIRD_PARTY_NOTICES.md", "DEPENDENCY_NOTICES.md"]

export async function receipt(executable = process.execPath): Promise<Receipt | undefined> {
  const resolved = await realpath(executable).catch(() => undefined)
  if (!resolved) return
  const binary = path.basename(resolved)
  if (!["vector", "vector-native", "vector.exe", "vector-native.exe"].includes(binary)) return
  const directory = path.dirname(resolved)
  const metadata = path.join(directory, `.vector-${binary}`)
  const file = path.join(metadata, "receipt.tsv")
  const stats = await Promise.all([lstat(resolved), lstat(metadata), lstat(file)]).catch(() => undefined)
  if (!stats || !stats[0]?.isFile() || !stats[1]?.isDirectory() || !stats[2]?.isFile()) return
  if (stats.some((stat) => stat.isSymbolicLink()) || stats[2]!.size > 2048) return
  const raw = await readFile(file, "utf8")
  if (!raw.endsWith("\n") || raw.slice(0, -1).includes("\n") || raw.includes("\r")) return
  const fields = raw.slice(0, -1).split("\t")
  const legacy = fields[1] === "1" && fields.length === 8
  const withHolder = fields[1] === "2" && fields.length === 9
  if ((!legacy && !withHolder) || fields[0] !== "vector-standalone" || fields[5] !== binary) return
  if (
    !Schema.is(CliRelease.Version)(fields[2]) ||
    !Schema.is(CliRelease.Target)(fields[3]) ||
    !Schema.is(CliRelease.Channel)(fields[4])
  )
    return
  if (!Schema.is(CliRelease.Digest)(fields[6]) || !Schema.is(CliRelease.Digest)(fields[7])) return
  if (withHolder) {
    const arch =
      fields[3] === "windows-arm64"
        ? "arm64"
        : fields[3] === "windows-x64" || fields[3] === "windows-x64-baseline"
          ? "x64"
          : undefined
    const holder = /^vector-holder-(x64|arm64)-[a-f0-9]{64}\.exe$/.exec(fields[8]!)
    if (!binary.endsWith(".exe") || !arch || holder?.[1] !== arch) return
  }
  const owned = await Promise.all(notices.map((name) => lstat(path.join(metadata, name)))).catch(() => undefined)
  if (!owned?.every((stat) => stat.isFile() && !stat.isSymbolicLink())) return
  if (
    createHash("sha256")
      .update(await readFile(resolved))
      .digest("hex") !== fields[6]
  )
    return
  return {
    directory,
    executable: resolved,
    metadata,
    version: fields[2],
    target: fields[3],
    channel: fields[4],
    binary,
    binarySha256: fields[6],
    archiveSha256: fields[7],
  }
}

export async function latest(
  value: Receipt,
  request: (url: string, init: RequestInit) => Promise<Response> = (url, init) => Egress.fetch("updates", url, init),
) {
  const response = await request(
    `https://vectordev.ai/api/cli-release?version=${value.channel}&target=${value.target}`,
    { redirect: "error", signal: AbortSignal.timeout(30_000) },
  )
  if (!response.ok) {
    await response.body?.cancel()
    throw new Error("Vector could not read the standalone release channel.")
  }
  const text = await bounded(response, CliRelease.MAX_MANIFEST_BYTES)
  const selected = Schema.decodeUnknownSync(Schema.fromJsonString(CliRelease.Selection), { onExcessProperty: "error" })(
    text,
  )
  const url = new URL(selected.url)
  if (
    selected.target !== value.target ||
    (value.channel === "latest" && selected.version.includes("-")) ||
    selected.pathname !== CliRelease.archivePath(selected.version, selected.target) ||
    selected.filename !== CliRelease.filename(selected.target) ||
    !/^[a-z0-9]+\.public\.blob\.vercel-storage\.com$/.test(url.hostname) ||
    selected.url !== `https://${url.hostname}/${selected.pathname}`
  )
    throw new Error("Vector returned invalid standalone release metadata.")
  return selected.version
}

export async function upgrade(value: Receipt, version: string, run: Run): Promise<Result> {
  Schema.decodeUnknownSync(CliRelease.Version)(version)
  if (!(await receipt(value.executable))) throw new Error("The standalone executable changed; upgrade was canceled.")
  const operation = randomBytes(16).toString("hex")
  const directory = path.join(value.directory, `.vector-upgrade-${operation}`)
  await mkdir(directory, { mode: 0o700 })
  const windows = process.platform === "win32"
  const script = path.join(directory, windows ? "install.ps1" : "install")
  // An upgrade is one the user started; with Vector Local on it goes once they confirmed the check (vector upgrade).
  const response = await Egress.fetch("updates", `https://vectordev.ai/${windows ? "install.ps1" : "install"}`, {
    redirect: "error",
    signal: AbortSignal.timeout(30_000),
    manual: true,
  })
  if (!response.ok) {
    await response.body?.cancel()
    await rm(directory, { recursive: true })
    throw new Error("Vector could not download its standalone installer.")
  }
  await writeFile(script, await bounded(response, 128_000), { mode: 0o600, flag: "wx" })
  if (windows) {
    const { WindowsRemoval } = await import("./windows-remove")
    const identity = await run([
      "powershell.exe",
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      WindowsRemoval.identity(process.pid),
    ])
    if (identity.code !== 0 || !/^\d{18}$/.test(identity.stdout.trim()))
      throw new Error("Could not identify the running Vector process for safe replacement.")
    await launch(script, {
      Version: version,
      InstallDir: value.directory,
      BinaryName: value.binary,
      WaitForProcessId: String(process.pid),
      WaitForStartTicks: identity.stdout.trim(),
      OperationId: operation,
    }).catch(async (error: unknown) => {
      await rm(directory, { recursive: true, force: true })
      throw error
    })
    return await prepared(value.directory, operation)
  }
  const result = await run([
    "sh",
    script,
    "--version",
    version,
    "--install-dir",
    value.directory,
    "--binary-name",
    value.binary,
  ]).finally(() => rm(directory, { recursive: true, force: true }))
  if (result.code !== 0)
    throw new Error(
      "Standalone upgrade did not complete. Inspect installer output and any preserved recovery directory before retrying.",
    )
  const installed = await receipt(value.executable)
  if (installed?.version !== version) throw new Error("The standalone receipt did not confirm the requested version.")
  return { status: "complete" }
}

export async function uninstall(value: Receipt, run: Run): Promise<Result> {
  if (!(await receipt(value.executable))) throw new Error("The standalone executable changed; uninstall was canceled.")
  if (process.platform !== "win32") {
    const lock = path.join(value.directory, `.vector-${value.binary}.lock`)
    await mkdir(lock)
    try {
      if ((await receipt(value.executable))?.binarySha256 !== value.binarySha256)
        throw new Error("The standalone executable changed; uninstall was canceled.")
      await rm(value.executable)
      for (const name of [...notices, "receipt.tsv"]) await rm(path.join(value.metadata, name))
      if ((await readdir(value.metadata)).length === 0) await rmdir(value.metadata)
    } finally {
      await rmdir(lock)
    }
    return { status: "complete" }
  }
  const operation = randomBytes(16).toString("hex")
  const directory = path.join(value.directory, `.vector-uninstall-${operation}`)
  await mkdir(directory, { mode: 0o700 })
  const statusFile = path.join(value.directory, `.vector-update-${operation}.json`)
  const { WindowsRemoval } = await import("./windows-remove")
  const identity = await run([
    "powershell.exe",
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    WindowsRemoval.identity(process.pid),
  ])
  if (identity.code !== 0 || !/^\d{18}$/.test(identity.stdout.trim()))
    throw new Error("Could not identify Vector for deferred removal.")
  const script = path.join(directory, "remove.ps1")
  await writeFile(
    script,
    WindowsRemoval.script({
      pid: process.pid,
      startTicks: identity.stdout.trim(),
      executable: value.executable,
      metadata: value.metadata,
      lock: path.join(value.directory, `.vector-${value.binary}.lock`),
      statusFile,
      temporaryDirectory: directory,
      binarySha256: value.binarySha256,
      // Holder files can be in use by another standalone binary in this directory.
      files: [
        value.executable,
        ...notices.map((name) => path.join(value.metadata, name)),
        path.join(value.metadata, "receipt.tsv"),
      ],
    }),
    { mode: 0o600, flag: "wx" },
  )
  await launch(script).catch(async (error: unknown) => {
    await rm(directory, { recursive: true, force: true })
    throw error
  })
  return await prepared(value.directory, operation)
}

async function launch(script: string, parameters: Record<string, string> = {}) {
  const literal = (value: string) =>
    `([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${Buffer.from(value, "utf8").toString("base64")}')))`
  const command = Buffer.from(
    `$ErrorActionPreference = 'Stop'; $parameters = @{${Object.entries(parameters)
      .map(([key, value]) => `${literal(key)} = ${literal(value)}`)
      .join("; ")}}; & ${literal(script)} @parameters`,
    "utf16le",
  ).toString("base64")
  // A detached, hidden Windows PowerShell can exit before running its script. START gives
  // the worker its own minimized console; CMD receives no dynamic paths or parameter values.
  const child = spawn(
    "cmd.exe",
    [
      "/d",
      "/s",
      "/c",
      "start",
      "",
      "/min",
      "powershell.exe",
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-EncodedCommand",
      command,
    ],
    {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
      env: WindowsPowerShell.environment("powershell.exe"),
      timeout: 10_000,
    },
  )
  await new Promise<void>((resolve, reject) => {
    child.once("error", reject)
    child.once("exit", (code, signal) => {
      if (code === 0) return resolve()
      reject(new Error(`Could not launch the deferred operation (exit ${code}, signal ${signal ?? "none"}).`))
    })
  })
}

async function prepared(directory: string, operation: string): Promise<Result> {
  const statusFile = path.join(directory, `.vector-update-${operation}.json`)
  const deadline = Date.now() + 310_000
  while (Date.now() < deadline) {
    const value = await readFile(statusFile, "utf8").catch(() => undefined)
    const status =
      value &&
      Schema.decodeUnknownOption(
        Schema.fromJsonString(Schema.Struct({ state: Schema.String, message: Schema.optional(Schema.String) })),
      )(value)
    if (status && status._tag === "Some") {
      if (status.value.state === "prepared") {
        await writeFile(`${statusFile}.ready`, "ready\n", { mode: 0o600, flag: "wx" })
        return { status: "scheduled", statusFile }
      }
      if (status.value.state === "failed") throw new Error(status.value.message ?? "Deferred operation failed.")
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(
    `The deferred operation did not become ready. Inspect ${statusFile}; the current executable has not been replaced.`,
  )
}

async function bounded(response: Response, limit: number) {
  const reader = response.body?.getReader()
  if (!reader) throw new Error("Vector returned an empty response.")
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    while (true) {
      const value = await reader.read()
      if (value.done) return Buffer.concat(chunks).toString("utf8")
      total += value.value.byteLength
      if (total > limit) throw new Error("Vector returned an oversized response.")
      chunks.push(value.value)
    }
  } finally {
    await reader.cancel().catch(() => undefined)
  }
}

export * as Standalone from "./standalone"
