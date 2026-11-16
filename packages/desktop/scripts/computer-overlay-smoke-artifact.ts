import { constants } from "node:fs"
import {
  appendFile,
  copyFile,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  realpath,
  rm,
} from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { createHash } from "node:crypto"
import { parseArgs } from "node:util"
import {
  parseHelperManifest,
  runNativeCommand,
  type HelperArchitecture,
  type HelperPlatform,
  type NativeCommand,
} from "./build-computer-helper"
import { selectComputerHelperArtifacts } from "./computer-helper-artifact"
import {
  COMPUTER_OVERLAY_STAGE_BUNDLES,
  COMPUTER_OVERLAY_STAGE_MANIFEST,
  computerOverlayStagePaths,
  verifyComputerOverlayStage,
} from "./computer-overlay-smoke-stage"

const LIMIT = 1024 * 1024 * 1024
const LINK_ROOT = "electron/Electron.app"
const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex")
export function computerOverlayArtifactName(platform: HelperPlatform, suffix: string) {
  if (!["darwin", "win32"].includes(platform) || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(suffix))
    throw new Error("The computer overlay artifact name is invalid.")
  return `computer-overlay-smoke-${platform}-${suffix}`
}
const archiveName = (platform: HelperPlatform) => `computer-overlay-smoke-${platform}.tar`
function sourceContext(environment: NodeJS.ProcessEnv) {
  const repository = environment.GITHUB_REPOSITORY,
    run = environment.GITHUB_RUN_ID,
    sha = environment.GITHUB_SHA
  if (
    !repository ||
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository) ||
    !run ||
    !/^[1-9]\d*$/.test(run) ||
    !Number.isSafeInteger(Number(run)) ||
    !sha ||
    !/^[a-f0-9]{40}$/.test(sha)
  )
    throw new Error("Computer overlay artifacts require the exact current GitHub run identity.")
  return { repository, run, sha }
}
function safeName(name: string) {
  return (
    name.length > 0 &&
    !name.startsWith("/") &&
    !name.includes("\\") &&
    !/[\p{C}]/u.test(name) &&
    name.split("/").every((part) => !!part && part !== "." && part !== ".." && !part.includes(":"))
  )
}
function allowedName(name: string, platform: HelperPlatform) {
  const driver = computerOverlayStagePaths(platform).driver
  const bundle = "resources/computer/VectorComputerOverlayDriver.app"
  return (
    name === COMPUTER_OVERLAY_STAGE_MANIFEST ||
    name === "resources" ||
    name === "resources/computer" ||
    name === "electron" ||
    name.startsWith("electron/") ||
    name === "smoke" ||
    (COMPUTER_OVERLAY_STAGE_BUNDLES as readonly string[]).includes(name) ||
    (platform === "win32" ? name === driver : name === bundle || name.startsWith(bundle + "/"))
  )
}
type TarEntry = { name: string; type: "file" | "directory" | "link"; target?: string; bytes?: Buffer; sha256?: string }
export type ComputerOverlayArchive = {
  files: Record<string, { sha256: string; bytes: number }>
  links: Record<string, string>
  manifest: Buffer
}

/** Validate the complete archive before tar may create any path. Never follow a link while extracting a file. */
export function checkComputerOverlayTar(input: Uint8Array, platform: HelperPlatform): ComputerOverlayArchive {
  if (!["darwin", "win32"].includes(platform)) throw new Error("The computer overlay archive platform is invalid.")
  const bytes = Buffer.from(input),
    entries = new Map<string, TarEntry>(),
    canonicalNames = new Set<string>()
  const field = (data: Buffer) => {
    const nul = data.indexOf(0),
      end = nul < 0 ? data.length : nul
    if (nul >= 0 && data.subarray(nul).some((byte) => byte !== 0))
      throw new Error("The computer overlay tar text field is invalid.")
    return new TextDecoder("utf-8", { fatal: true }).decode(data.subarray(0, end))
  }
  const number = (data: Buffer) => {
    const raw = new TextDecoder("utf-8", { fatal: true }).decode(data)
    const value = raw.replace(/^ +/, "").replace(/[\0 ]+$/, "")
    if (!/^[0-7]*$/.test(value)) throw new Error("The computer overlay tar number is invalid.")
    const result = value ? Number.parseInt(value, 8) : 0
    if (!Number.isSafeInteger(result)) throw new Error("The computer overlay tar number exceeded its bound.")
    return result
  }
  if (!bytes.length || bytes.length % 512 !== 0 || bytes.length > LIMIT)
    throw new Error("The computer overlay archive size is invalid.")
  let terminated = false
  for (let offset = 0; offset < bytes.length; ) {
    const header = bytes.subarray(offset, offset + 512)
    if (header.every((byte) => byte === 0)) {
      if (bytes.length - offset < 1024 || bytes.subarray(offset).some((byte) => byte !== 0))
        throw new Error("The computer overlay tar has invalid trailing data.")
      terminated = true
      break
    }
    const prefix = field(header.subarray(345, 500)),
      leaf = field(header.subarray(0, 100))
    const spelling = [prefix, leaf].filter(Boolean).join("/")
    const name = spelling.replace(/\/$/, "")
    const type = String.fromCharCode(header[156]!),
      size = number(header.subarray(124, 136)),
      mode = number(header.subarray(100, 108)),
      target = field(header.subarray(157, 257))
    const key = name.normalize("NFC").toLowerCase()
    if (
      platform === "win32" &&
      name
        .split("/")
        .some((part) => /[. ]$/.test(part) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i.test(part))
    )
      throw new Error("The computer overlay tar has a reserved Windows path.")
    const sum = header.reduce((total, value, index) => total + (index >= 148 && index < 156 ? 32 : value), 0)
    const end = offset + 512 + size,
      next = offset + 512 + Math.ceil(size / 512) * 512
    if (
      field(header.subarray(257, 263)) !== "ustar" ||
      field(header.subarray(263, 265)) !== "00" ||
      number(header.subarray(148, 156)) !== sum ||
      !["\0", "0", "2", "5"].includes(type) ||
      !safeName(name) ||
      !allowedName(name, platform) ||
      canonicalNames.has(key) ||
      entries.size >= 16_384 ||
      (mode & 0o7000) !== 0 ||
      size > 512 * 1024 * 1024 ||
      (type !== "5" && spelling.endsWith("/")) ||
      end > bytes.length ||
      next > bytes.length ||
      bytes.subarray(end, next).some((byte) => byte !== 0) ||
      ((type === "2" || type === "5") && size !== 0) ||
      (type !== "2" && target !== "")
    )
      throw new Error("The computer overlay tar contains an unsafe or unexpected entry.")
    canonicalNames.add(key)
    if (type === "2") {
      if (
        platform !== "darwin" ||
        !name.startsWith(LINK_ROOT + "/") ||
        !target ||
        target.startsWith("/") ||
        target.includes("\\") ||
        /[\p{C}:]/u.test(target) ||
        target.split("/").some((part) => part === "")
      )
        throw new Error("The computer overlay tar link is invalid.")
      const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(name), target))
      if (!resolved.startsWith(LINK_ROOT + "/")) throw new Error("The computer overlay tar link escapes Electron.")
      entries.set(name, { name, type: "link", target })
    } else if (type === "5") entries.set(name, { name, type: "directory" })
    else
      entries.set(name, {
        name,
        type: "file",
        bytes: bytes.subarray(offset + 512, end),
        sha256: digest(bytes.subarray(offset + 512, end)),
      })
    offset = next
  }
  if (!terminated) throw new Error("The computer overlay tar has no complete terminator.")
  const nodes = new Set(entries.keys())
  for (const entry of entries.values()) {
    const parts = entry.name.split("/")
    for (let size = 1; size < parts.length; size++) {
      const parent = parts.slice(0, size).join("/"),
        existing = entries.get(parent)
      if (existing && existing.type !== "directory")
        throw new Error("The computer overlay tar writes through a file or link.")
      nodes.add(parent)
    }
  }
  function resolveLink(name: string) {
    let current = name
    const seen = new Set<string>()
    for (let steps = 0; steps <= entries.size; steps++) {
      const parts = current.split("/")
      let replaced = false
      for (let size = 1; size <= parts.length; size++) {
        const prefix = parts.slice(0, size).join("/"),
          entry = entries.get(prefix)
        if (entry?.type !== "link") continue
        if (seen.has(prefix)) throw new Error("The computer overlay tar links contain a cycle.")
        seen.add(prefix)
        current = path.posix.normalize(path.posix.join(path.posix.dirname(prefix), entry.target!, ...parts.slice(size)))
        if (!current.startsWith(LINK_ROOT + "/"))
          throw new Error("The computer overlay tar link chain escapes Electron.")
        replaced = true
        break
      }
      if (!replaced) return current
    }
    throw new Error("The computer overlay tar link chain exceeded its bound.")
  }
  for (const entry of entries.values())
    if (entry.type === "link") {
      const target = resolveLink(entry.name)
      if (!nodes.has(target) || entry.name === target || entry.name.startsWith(target + "/"))
        throw new Error("The computer overlay tar link target is absent or cyclic.")
    }
  const files = Object.fromEntries(
    [...entries.values()]
      .filter((entry) => entry.type === "file")
      .map((entry) => [entry.name, { sha256: entry.sha256!, bytes: entry.bytes!.length }]),
  )
  const paths = computerOverlayStagePaths(platform)
  for (const mandatory of [
    COMPUTER_OVERLAY_STAGE_MANIFEST,
    paths.driver,
    paths.electron,
    paths.defaultApp,
    ...COMPUTER_OVERLAY_STAGE_BUNDLES,
  ])
    if (!Object.hasOwn(files, mandatory))
      throw new Error("The computer overlay archive is missing a required stage file.")
  return {
    files,
    links: Object.fromEntries(
      [...entries.values()].filter((entry) => entry.type === "link").map((entry) => [entry.name, entry.target!]),
    ),
    manifest: entries.get(COMPUTER_OVERLAY_STAGE_MANIFEST)!.bytes!,
  }
}

type Dependencies = {
  environment?: NodeJS.ProcessEnv
  run?: NativeCommand
  architecture?: HelperArchitecture
  verify?: (root: string, input: { platform: HelperPlatform; architecture: HelperArchitecture }) => Promise<unknown>
}
const hostArchitecture = (value: string): HelperArchitecture => {
  if (value !== "x64" && value !== "arm64")
    throw new Error("The computer overlay artifact host architecture is unsupported.")
  return value
}
function archiveEnvironment(environment: NodeJS.ProcessEnv) {
  return {
    ...Object.fromEntries(
      Object.entries(environment).filter(
        ([key]) => !/^(?:TAR_|BSDTAR_|DYLD_)/.test(key) && !["LD_PRELOAD", "LD_LIBRARY_PATH"].includes(key),
      ),
    ),
    COPYFILE_DISABLE: "1",
  }
}
const verifyStage = (root: string, platform: HelperPlatform, dependencies: Dependencies) =>
  (dependencies.verify ?? verifyComputerOverlayStage)(root, {
    platform,
    architecture: dependencies.architecture ?? hostArchitecture(process.arch),
  })
function verifyArchiveCatalog(catalog: ComputerOverlayArchive, platform: HelperPlatform) {
  let manifest: ReturnType<typeof parseHelperManifest>
  try {
    manifest = parseHelperManifest(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(catalog.manifest)))
  } catch {
    throw new Error("The computer overlay archive manifest is invalid.")
  }
  if (
    manifest.platform !== platform ||
    Object.keys(catalog.files)
      .filter((name) => name !== COMPUTER_OVERLAY_STAGE_MANIFEST)
      .sort()
      .join("\0") !== Object.keys(manifest.files).sort().join("\0")
  )
    throw new Error("The computer overlay archive disagrees with its complete manifest.")
  for (const [name, metadata] of Object.entries(manifest.files))
    if (catalog.files[name]?.sha256 !== metadata.sha256)
      throw new Error("A computer overlay archive file disagrees with its manifest bytes.")
}

export async function restoreComputerOverlayArtifact(
  input: { platform: HelperPlatform; suffix: string; destination: string; required?: boolean },
  dependencies: Dependencies = {},
) {
  const environment = dependencies.environment ?? process.env,
    identity = sourceContext(environment),
    names = [computerOverlayArtifactName(input.platform, input.suffix)],
    run = dependencies.run ?? runNativeCommand
  const command = async (args: string[]) => {
    const result = await run("gh", args, { cwd: process.cwd(), env: environment, timeoutMs: 120_000 })
    if (result.code !== 0 || Buffer.byteLength(result.stdout) > 4 * 1024 * 1024)
      throw new Error("The immutable computer overlay artifact request failed.")
    return result.stdout
  }
  const list = async () => {
    let value: unknown
    try {
      value = JSON.parse(
        await command([
          "api",
          "--paginate",
          "--slurp",
          `repos/${identity.repository}/actions/runs/${identity.run}/artifacts`,
        ]),
      )
    } catch {
      throw new Error("The immutable computer overlay artifact listing is invalid.")
    }
    return selectComputerHelperArtifacts(value, names, identity)
  }
  const artifacts = await list()
  if (!artifacts.length) {
    if (input.required) throw new Error("The required immutable computer overlay artifact is missing.")
    return { restored: false, artifacts }
  }
  const directory = await mkdtemp(path.join(environment.RUNNER_TEMP ?? os.tmpdir(), "computer-overlay-artifacts-"))
  try {
    await command([
      "run",
      "download",
      identity.run,
      "--repo",
      identity.repository,
      "--name",
      artifacts[0]!.name,
      "--dir",
      directory,
    ])
    if (JSON.stringify(await list()) !== JSON.stringify(artifacts))
      throw new Error("The immutable computer overlay artifact identity changed during download.")
    const archive = archiveName(input.platform)
    if ((await readdir(directory)).join("\0") !== archive)
      throw new Error("The computer overlay artifact contains unexpected archive files.")
    const file = path.join(directory, archive),
      info = await lstat(file)
    if (!info.isFile() || info.isSymbolicLink() || info.size < 1024 || info.size > LIMIT)
      throw new Error("The computer overlay archive is not a bounded regular file.")
    verifyArchiveCatalog(checkComputerOverlayTar(await readFile(file), input.platform), input.platform)
    const unpacked = path.join(directory, "unpacked")
    await mkdir(unpacked)
    const extracted = await run("tar", ["-xpf", file, "-C", unpacked], {
      cwd: process.cwd(),
      env: archiveEnvironment(environment),
      timeoutMs: 120_000,
    })
    if (extracted.code !== 0) throw new Error("The immutable computer overlay archive could not be extracted.")
    await verifyStage(unpacked, input.platform, dependencies)
    await mkdir(input.destination, { recursive: true })
    const destinationInfo = await lstat(input.destination)
    if (!destinationInfo.isDirectory() || destinationInfo.isSymbolicLink() || (await readdir(input.destination)).length)
      throw new Error("Computer overlay artifacts require an empty, regular destination directory.")
    const destination = await realpath(input.destination)
    await cp(unpacked, destination, { recursive: true, force: false, errorOnExist: true, verbatimSymlinks: true })
    await verifyStage(destination, input.platform, dependencies)
    return { restored: true, artifacts }
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

export async function archiveComputerOverlayStage(
  input: { platform: HelperPlatform; archive: string; output: string },
  dependencies: Dependencies = {},
) {
  if (!["darwin", "win32"].includes(input.platform) || path.basename(input.output) !== archiveName(input.platform))
    throw new Error("The computer overlay archive output name is invalid.")
  await verifyStage(input.archive, input.platform, dependencies)
  const source = await realpath(input.archive),
    output = path.resolve(input.output)
  await mkdir(path.dirname(output), { recursive: true })
  const directory = await mkdtemp(path.join(path.dirname(output), "computer-overlay-archive-"))
  try {
    const temporary = path.join(directory, archiveName(input.platform))
    const environment = archiveEnvironment(dependencies.environment ?? process.env)
    const result = await (dependencies.run ?? runNativeCommand)(
      "tar",
      [
        "--format=ustar",
        "--no-xattrs",
        "--no-acls",
        "--no-fflags",
        "--uid",
        "0",
        "--gid",
        "0",
        "--uname",
        "",
        "--gname",
        "",
        "-cpf",
        temporary,
        "-C",
        source,
        COMPUTER_OVERLAY_STAGE_MANIFEST,
        "electron",
        "resources",
        "smoke",
      ],
      { cwd: process.cwd(), env: environment, timeoutMs: 120_000 },
    )
    if (result.code !== 0) throw new Error("The separate computer overlay stage could not be archived.")
    const info = await lstat(temporary)
    if (!info.isFile() || info.isSymbolicLink() || info.size > LIMIT)
      throw new Error("The computer overlay archive is not a bounded regular file.")
    const bytes = await readFile(temporary),
      catalog = checkComputerOverlayTar(bytes, input.platform)
    verifyArchiveCatalog(catalog, input.platform)
    if (!catalog.manifest.equals(await readFile(path.join(source, COMPUTER_OVERLAY_STAGE_MANIFEST))))
      throw new Error("The computer overlay manifest changed while archiving.")
    const observedLinks: Record<string, string> = {}
    async function links(current: string) {
      for (const entry of await readdir(current, { withFileTypes: true })) {
        const file = path.join(current, entry.name)
        if (entry.isSymbolicLink())
          observedLinks[path.relative(source, file).split(path.sep).join("/")] = await readlink(file)
        else if (entry.isDirectory()) await links(file)
      }
    }
    await links(source)
    if (JSON.stringify(Object.entries(observedLinks).sort()) !== JSON.stringify(Object.entries(catalog.links).sort()))
      throw new Error("The computer overlay link catalog changed while archiving.")
    await verifyStage(source, input.platform, dependencies)
    await copyFile(temporary, output, constants.COPYFILE_EXCL)
    if (digest(await readFile(output)) !== digest(bytes))
      throw new Error("The computer overlay archive changed during its exclusive copy.")
    return { output, bytes: bytes.length }
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

if (import.meta.main) {
  const { values, tokens } = parseArgs({
    strict: true,
    tokens: true,
    allowPositionals: false,
    options: {
      platform: { type: "string" },
      suffix: { type: "string" },
      destination: { type: "string" },
      required: { type: "boolean", default: false },
      archive: { type: "string" },
      output: { type: "string" },
    },
  })
  const options = new Set<string>()
  for (const token of tokens)
    if (token.kind === "option") {
      if (options.has(token.name)) throw new Error("The computer overlay artifact received a duplicate argument.")
      options.add(token.name)
    }
  if (values.platform !== "darwin" && values.platform !== "win32")
    throw new Error("Choose the actual computer overlay artifact platform.")
  if (values.archive || values.output) {
    if (!values.archive || !values.output || values.suffix || values.destination || values.required)
      throw new Error("Usage: --platform <darwin|win32> --archive <verified-stage> --output <new-overlay-tar>")
    await archiveComputerOverlayStage({
      platform: values.platform,
      archive: path.resolve(values.archive),
      output: path.resolve(values.output),
    })
    process.stdout.write("Archived the separate source-bound computer overlay stage.\n")
  } else {
    if (!values.suffix || !values.destination)
      throw new Error(
        "Usage: --platform <darwin|win32> --suffix <source-or-release> --destination <empty-directory> [--required]",
      )
    const result = await restoreComputerOverlayArtifact({
      platform: values.platform,
      suffix: values.suffix,
      destination: path.resolve(values.destination),
      required: values.required,
    })
    if (process.env.GITHUB_OUTPUT)
      await appendFile(
        process.env.GITHUB_OUTPUT,
        `restored=${result.restored}\nartifact_ids=${result.artifacts.map((artifact) => artifact.id).join(",")}\nartifact_digests=${result.artifacts.map((artifact) => artifact.digest).join(",")}\n`,
      )
    process.stdout.write(
      result.restored
        ? "Restored the exact source/run computer overlay artifact and verified its stage.\n"
        : "No earlier computer overlay artifact exists in this run.\n",
    )
  }
}
