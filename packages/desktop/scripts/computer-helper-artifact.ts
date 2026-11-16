import { appendFile, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { parseArgs } from "node:util"
import { runNativeCommand, type NativeCommand } from "./build-computer-helper"

type Mode = "native-darwin" | "native-win32" | "darwin-source" | "win32-source" | "win32-final" | "arm64-package"
const modes: readonly Mode[] = [
  "native-darwin",
  "native-win32",
  "darwin-source",
  "win32-source",
  "win32-final",
  "arm64-package",
]
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
const context = (environment: NodeJS.ProcessEnv) => {
  const repository = environment.GITHUB_REPOSITORY
  const run = environment.GITHUB_RUN_ID
  const sha = environment.GITHUB_SHA
  if (
    !repository ||
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository) ||
    !run ||
    !/^[1-9]\d*$/.test(run) ||
    !Number.isSafeInteger(Number(run)) ||
    !sha ||
    !/^[a-f0-9]{40}$/.test(sha)
  )
    throw new Error("Computer helper artifacts require the exact current GitHub run identity.")
  return { repository, run, sha }
}

export function computerHelperArtifactNames(mode: Mode, suffix: string) {
  if (!modes.includes(mode) || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(suffix))
    throw new Error("The computer helper artifact request is invalid.")
  const platform = mode.includes("darwin") ? "darwin" : "win32"
  if (mode === "win32-final") return [`computer-helper-win32-final-${suffix}`]
  if (mode === "arm64-package") return [`computer-helper-win32-arm64-package-${suffix}`]
  const shipping = `computer-helper-${platform}-${suffix}`
  return mode.startsWith("native-") ? [shipping, `computer-helper-${platform}-tests-${suffix}`] : [shipping]
}

export function selectComputerHelperArtifacts(
  value: unknown,
  names: readonly string[],
  input: { run: string; sha: string; expectedId?: string; expectedDigest?: string },
) {
  if (
    !Array.isArray(value) ||
    value.length > 100 ||
    value.some((page) => !record(page) || !Array.isArray(page.artifacts))
  )
    throw new Error("The GitHub artifact listing is invalid.")
  const artifacts = value
    .flatMap((page) => (page as { artifacts: unknown[] }).artifacts)
    .filter((artifact) => record(artifact) && names.includes(String(artifact.name)))
  if (!artifacts.length) return []
  if (
    artifacts.length !== names.length ||
    names.some((name) => artifacts.filter((artifact) => record(artifact) && artifact.name === name).length !== 1)
  )
    throw new Error("The immutable computer helper artifact set is incomplete or ambiguous.")
  const selected = names.map((name) => {
    const artifact = artifacts.find((item) => record(item) && item.name === name)
    if (
      !record(artifact) ||
      !Number.isSafeInteger(artifact.id) ||
      Number(artifact.id) < 1 ||
      artifact.expired !== false ||
      typeof artifact.digest !== "string" ||
      !/^sha256:[a-f0-9]{64}$/.test(artifact.digest) ||
      !record(artifact.workflow_run) ||
      artifact.workflow_run.id !== Number(input.run) ||
      artifact.workflow_run.head_sha !== input.sha ||
      !Number.isSafeInteger(artifact.workflow_run.repository_id) ||
      Number(artifact.workflow_run.repository_id) < 1 ||
      artifact.workflow_run.repository_id !== artifact.workflow_run.head_repository_id
    )
      throw new Error("A computer helper artifact is expired or belongs to another source/run.")
    if (input.expectedId !== undefined && (names.length !== 1 || String(artifact.id) !== input.expectedId))
      throw new Error("The packaged helper proof artifact id changed.")
    if (
      input.expectedDigest !== undefined &&
      artifact.digest !==
        (input.expectedDigest.startsWith("sha256:") ? input.expectedDigest : `sha256:${input.expectedDigest}`)
    )
      throw new Error("The packaged helper proof artifact digest changed.")
    return { name, id: String(artifact.id), digest: artifact.digest }
  })
  if (new Set(selected.map((artifact) => artifact.id)).size !== selected.length)
    throw new Error("The immutable computer helper artifacts have conflicting ids.")
  return selected
}

function allowedTarName(file: string, mode: Mode, tests: boolean) {
  if (tests)
    return mode === "native-darwin"
      ? file === "tests" || file.startsWith("tests/")
      : file === "x64" || file === "arm64" || /^(?:x64|arm64)\/tests(?:\/|$)/.test(file)
  if (mode.includes("darwin"))
    return file === "computer-helper.json" || file === "VectorComputer.app" || file.startsWith("VectorComputer.app/")
  if (mode === "arm64-package")
    return [
      "resources",
      "resources/computer",
      "resources/app.asar",
      "resources/computer/vector-computer.exe",
      "resources/computer/computer-helper.json",
    ].includes(file)
  return (
    file === "x64" || file === "arm64" || /^(?:x64|arm64)\/(?:vector-computer\.exe|computer-helper\.json)$/.test(file)
  )
}

/** C6 emits portable ustar: no links, devices, PAX path overrides, special modes or escaping names. */
export function checkComputerHelperTar(input: Uint8Array, mode: Mode, tests = false) {
  const bytes = Buffer.from(input)
  const names = new Set<string>()
  const files: string[] = []
  const text = (data: Buffer) => data.toString("utf8").replace(/\0.*$/s, "")
  const number = (data: Buffer) => {
    const value = text(data).trim()
    if (!/^[0-7]*$/.test(value)) throw new Error("The computer helper tar numeric header is invalid.")
    return value ? Number.parseInt(value, 8) : 0
  }
  if (!bytes.length || bytes.length % 512 !== 0 || bytes.length > 1024 * 1024 * 1024)
    throw new Error("The computer helper archive size is invalid.")
  for (const state = { offset: 0 }; state.offset < bytes.length; ) {
    const header = bytes.subarray(state.offset, state.offset + 512)
    if (header.every((value) => value === 0)) {
      if (!bytes.subarray(state.offset).every((value) => value === 0))
        throw new Error("The computer helper tar contains trailing data.")
      break
    }
    const checksum = header.reduce((sum, value, index) => sum + (index >= 148 && index < 156 ? 32 : value), 0)
    const prefix = text(header.subarray(345, 500))
    const file = [prefix, text(header.subarray(0, 100))].filter(Boolean).join("/").replace(/\/$/, "")
    const type = String.fromCharCode(header[156]!)
    const size = number(header.subarray(124, 136))
    if (
      text(header.subarray(257, 263)) !== "ustar" ||
      checksum !== number(header.subarray(148, 156)) ||
      !["\0", "0", "5"].includes(type) ||
      text(header.subarray(157, 257)) !== "" ||
      (number(header.subarray(100, 108)) & 0o7000) !== 0 ||
      !Number.isSafeInteger(size) ||
      size < 0 ||
      state.offset + 512 + size > bytes.length ||
      (type === "5" && size !== 0) ||
      !file ||
      file.startsWith("/") ||
      file.includes("\\") ||
      /[\p{C}]/u.test(file) ||
      file.split("/").some((part) => !part || part === "." || part === ".." || part.includes(":")) ||
      !allowedTarName(file, mode, tests) ||
      names.has(file) ||
      names.size >= 16_384
    )
      throw new Error("The computer helper tar contains an unsafe or unexpected entry.")
    names.add(file)
    if (type !== "5") files.push(file)
    state.offset += 512 + Math.ceil(size / 512) * 512
  }
  if (!files.length) throw new Error("The computer helper archive contains no files.")
  return files
}

export async function restoreComputerHelperArtifacts(
  input: {
    mode: Mode
    suffix: string
    destination: string
    required?: boolean
    expectedId?: string
    expectedDigest?: string
  },
  dependencies: { environment?: NodeJS.ProcessEnv; run?: NativeCommand } = {},
) {
  const environment = dependencies.environment ?? process.env
  const identity = context(environment)
  const names = computerHelperArtifactNames(input.mode, input.suffix)
  const run = dependencies.run ?? runNativeCommand
  const command = async (args: string[]) => {
    const result = await run("gh", args, { cwd: process.cwd(), env: environment, timeoutMs: 120_000 })
    if (result.code !== 0 || Buffer.byteLength(result.stdout) > 4 * 1024 * 1024)
      throw new Error("The immutable computer helper artifact request failed.")
    return result.stdout
  }
  const list = async () =>
    selectComputerHelperArtifacts(
      JSON.parse(
        await command([
          "api",
          "--paginate",
          "--slurp",
          `repos/${identity.repository}/actions/runs/${identity.run}/artifacts`,
        ]),
      ),
      names,
      { ...identity, expectedId: input.expectedId, expectedDigest: input.expectedDigest },
    )
  const artifacts = await list()
  if (!artifacts.length) {
    if (input.required) throw new Error("The required immutable computer helper artifact is missing.")
    return { restored: false, artifacts }
  }
  const directory = await mkdtemp(path.join(environment.RUNNER_TEMP ?? os.tmpdir(), "computer-helper-artifacts-"))
  try {
    for (const artifact of artifacts)
      await command([
        "run",
        "download",
        identity.run,
        "--repo",
        identity.repository,
        "--name",
        artifact.name,
        "--dir",
        directory,
      ])
    if (JSON.stringify(await list()) !== JSON.stringify(artifacts))
      throw new Error("The immutable computer helper artifact identity changed during download.")
    const platform = input.mode.includes("darwin") ? "darwin" : "win32"
    const archives =
      input.mode === "win32-final"
        ? ["computer-helper-win32-final.tar"]
        : input.mode === "arm64-package"
          ? ["computer-helper-win32-arm64-package.tar"]
          : [
              `computer-helper-${platform}.tar`,
              ...(input.mode.startsWith("native-") ? [`computer-helper-${platform}-tests.tar`] : []),
            ]
    if ((await readdir(directory)).toSorted().join("\0") !== archives.toSorted().join("\0"))
      throw new Error("The helper artifact contains unexpected archive files.")
    for (const archive of archives) {
      const file = path.join(directory, archive)
      const info = await lstat(file)
      if (!info.isFile() || info.isSymbolicLink() || info.size > 1024 * 1024 * 1024)
        throw new Error("The helper archive is not a bounded regular file.")
      checkComputerHelperTar(await readFile(file), input.mode, archive.endsWith("-tests.tar"))
    }
    await mkdir(input.destination, { recursive: true })
    const target = await lstat(input.destination)
    if (!target.isDirectory() || target.isSymbolicLink() || (await readdir(input.destination)).length)
      throw new Error("Computer helpers cannot be restored over stale, linked or cached files.")
    const destination = await realpath(input.destination)
    for (const archive of archives) {
      const result = await run("tar", ["-xpf", path.join(directory, archive), "-C", destination], {
        cwd: process.cwd(),
        env: environment,
        timeoutMs: 120_000,
      })
      if (result.code !== 0) throw new Error("The immutable helper archive could not be extracted.")
    }
    return { restored: true, artifacts }
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

if (import.meta.main) {
  const parsed = parseArgs({
    strict: true,
    allowPositionals: false,
    options: {
      mode: { type: "string" },
      suffix: { type: "string" },
      destination: { type: "string" },
      required: { type: "boolean", default: false },
      "expected-id": { type: "string" },
      "expected-digest": { type: "string" },
    },
  })
  if (!modes.includes(parsed.values.mode as Mode) || !parsed.values.suffix || !parsed.values.destination)
    throw new Error(
      "Usage: --mode <helper-artifact-kind> --suffix <release-or-source> --destination <empty-directory> [--required]",
    )
  const result = await restoreComputerHelperArtifacts({
    mode: parsed.values.mode as Mode,
    suffix: parsed.values.suffix,
    destination: path.resolve(parsed.values.destination),
    required: parsed.values.required,
    expectedId: parsed.values["expected-id"],
    expectedDigest: parsed.values["expected-digest"],
  })
  if (process.env.GITHUB_OUTPUT)
    await appendFile(
      process.env.GITHUB_OUTPUT,
      `restored=${result.restored}\nartifact_ids=${result.artifacts.map((artifact) => artifact.id).join(",")}\nartifact_digests=${result.artifacts.map((artifact) => artifact.digest).join(",")}\n`,
    )
  console.log(
    result.restored
      ? "Restored the exact helper artifact ids, source/run identity and safe archives."
      : "No earlier helper artifact exists in this run.",
  )
}
