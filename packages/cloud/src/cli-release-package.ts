import { chmod, copyFile, lstat, mkdir, mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { create } from "tar"
import { BlobReader, BlobWriter, ZipWriter } from "@zip.js/zip.js"
import { CliRelease } from "@vectordevai/schema/cli-release"
import { releaseCatalogText } from "./upload-model-catalog"
import { assertCleanArtifacts } from "../../../script/artifact-audit"
import { maximumExecutableBytes, validatePackagedWindowsHolder } from "../../engine/script/windows-holder-binary"
import { windowsHolderCompanionName } from "../../engine/src/tool/shell/windows-holder-companion-name"

export const cliNotices = ["LICENSE", "THIRD_PARTY_NOTICES.md", "DEPENDENCY_NOTICES.md"] as const

export function cliBlobUrl(origin: string, pathname: string) {
  if (!/^https:\/\/[a-z0-9]+\.public\.blob\.vercel-storage\.com$/.test(origin))
    throw new Error("A canonical public Vector Blob store origin is required.")
  return `${origin}/${pathname}`
}

export async function hashCliFile(file: string) {
  const hash = new Bun.CryptoHasher("sha256")
  let size = 0
  for await (const chunk of Bun.file(file).stream()) {
    size += chunk.byteLength
    if (size > CliRelease.MAX_ARCHIVE_BYTES) throw new Error("The CLI release file exceeds the size limit.")
    hash.update(chunk)
  }
  if (!size) throw new Error("A CLI release file is empty.")
  return { size, sha256: hash.digest("hex") }
}

export async function packageCliRelease(input: {
  source: string
  output: string
  version: string
  channel: CliRelease.Channel
  sourceRevision: string
  catalogSha256: string
  origin: string
  publishedAt: string
}) {
  // Validate every platform before producing any archive. Missing or relabelled
  // builds must never produce a partly publishable release.
  const skeleton = {
    schemaVersion: 1 as const,
    version: input.version,
    channel: input.channel,
    publishedAt: input.publishedAt,
    sourceRevision: input.sourceRevision,
    catalogSha256: input.catalogSha256,
    targets: Object.fromEntries(
      CliRelease.targets.map((target) => [
        target,
        {
          filename: CliRelease.filename(target),
          pathname: CliRelease.archivePath(input.version, target),
          url: cliBlobUrl(input.origin, CliRelease.archivePath(input.version, target)),
          size: 1,
          sha256: "0".repeat(64),
        },
      ]),
    ),
  }
  CliRelease.decode(skeleton, input.origin)
  const catalogFile = path.join(input.source, "api.json")
  await regularFile(catalogFile)
  releaseCatalogText(await Bun.file(catalogFile).text())
  if ((await hashCliFile(catalogFile)).sha256 !== input.catalogSha256)
    throw new Error("The prepared CLI catalog does not match the pinned digest.")
  const notices = new Map<string, string>()
  const holders = new Map<CliRelease.Target, Awaited<ReturnType<typeof readWindowsHolder>>>()
  for (const target of CliRelease.targets) {
    const root = path.join(input.source, `vector-${target}`)
    await directory(root)
    await directory(path.join(root, "bin"))
    await regularFile(path.join(root, "package.json"))
    const metadata: unknown = await Bun.file(path.join(root, "package.json")).json()
    if (
      !metadata ||
      typeof metadata !== "object" ||
      !("name" in metadata) ||
      metadata.name !== `vector-${target}` ||
      !("version" in metadata) ||
      metadata.version !== input.version ||
      !("vectorStandalone" in metadata) ||
      metadata.vectorStandalone !== true ||
      !("vectorCatalogSha256" in metadata) ||
      metadata.vectorCatalogSha256 !== input.catalogSha256 ||
      !("vectorSourceRevision" in metadata) ||
      metadata.vectorSourceRevision !== input.sourceRevision
    )
      throw new Error(`The CLI build identity does not match the release: ${target}.`)
    const binary = path.join(root, "bin", target.startsWith("windows-") ? "vector.exe" : "vector")
    await regularFile(binary)
    nativeHeader(target, await Bun.file(binary).slice(0, 4096).bytes())
    if ("vectorWindowsHolder" in metadata) {
      holders.set(target, await readWindowsHolder(root, target, metadata.vectorWindowsHolder))
    }
    for (const name of cliNotices) {
      await regularFile(path.join(root, name))
      const digest = (await hashCliFile(path.join(root, name))).sha256
      if (notices.has(name) && notices.get(name) !== digest)
        throw new Error(`The CLI notice differs between targets: ${name}.`)
      notices.set(name, digest)
    }
  }

  const windowsTargets = CliRelease.targets.filter((target) => target.startsWith("windows-"))
  if (holders.size && holders.size !== windowsTargets.length)
    throw new Error("A CLI release must include a Windows holder for every Windows target or for none.")
  if (new Set(Array.from(holders.values(), (holder) => holder.wire)).size > 1)
    throw new Error("A CLI release must use one Windows holder format across every Windows target.")

  await mkdir(input.output, { recursive: true })
  const temporary = await mkdtemp(path.join(os.tmpdir(), "vector-cli-package-"))
  const targets: Record<string, CliRelease.Asset> = {}
  try {
    for (const target of CliRelease.targets) {
      const root = path.join(input.source, `vector-${target}`)
      const staging = path.join(temporary, target)
      await mkdir(staging)
      const binary = target.startsWith("windows-") ? "vector.exe" : "vector"
      const holder = holders.get(target)
      const entries = [binary, ...cliNotices, ...(holder ? [holder.name] : [])]
      for (const name of entries) {
        const staged = path.join(staging, name)
        if (holder?.name === name) await Bun.write(staged, holder.bytes)
        else await copyFile(name === binary ? path.join(root, "bin", name) : path.join(root, name), staged)
        await chmod(staged, name === binary || holder?.name === name ? 0o755 : 0o644)
      }
      const archive = path.join(temporary, CliRelease.filename(target))
      await writeArchive(archive, staging, binary, entries)
      targets[target] = { ...skeleton.targets[target]!, ...(await hashCliFile(archive)) }
    }
    // Container jobs consume the prepared archives directly, so no archive reaches the output
    // directory until all twelve pass the release byte audit.
    await assertCleanArtifacts(Object.values(targets).map((record) => path.join(temporary, record.filename)))
    for (const record of Object.values(targets)) {
      const output = path.join(input.output, record.filename)
      const exists = await Bun.file(output).exists()
      if (exists) {
        const existing = await hashCliFile(output)
        if (existing.sha256 !== record.sha256 || existing.size !== record.size)
          throw new Error(`Refusing to replace different prepared CLI bytes: ${record.filename}.`)
      }
      if (!exists) await copyFile(path.join(temporary, record.filename), output)
    }
    const manifest = CliRelease.decode({ ...skeleton, targets }, input.origin)
    const output = path.join(input.output, "manifest.json")
    if (
      (await Bun.file(output).exists()) &&
      (await Bun.file(output).text()) !== JSON.stringify(manifest, null, 2) + "\n"
    )
      throw new Error("Refusing to replace a different prepared CLI manifest.")
    await Bun.write(output, JSON.stringify(manifest, null, 2) + "\n")
    return manifest
  } finally {
    await rm(temporary, { recursive: true, force: true })
  }
}

async function writeArchive(archive: string, staging: string, binary: string, entries: string[]) {
  if (binary === "vector.exe") {
    const writer = new ZipWriter(new BlobWriter(), {
      lastModDate: new Date(1980, 0, 1),
      extendedTimestamp: false,
      level: 9,
      zip64: false,
    })
    for (const name of entries)
      await writer.add(name, new BlobReader(Bun.file(path.join(staging, name))), {
        useWebWorkers: false,
        msDosCompatible: false,
        externalFileAttributes: ((name.endsWith(".exe") ? 0o100755 : 0o100644) << 16) >>> 0,
      })
    await Bun.write(archive, await writer.close())
    return
  }
  await create(
    { cwd: staging, file: archive, gzip: { level: 9 }, portable: true, noPax: true, mtime: new Date(0) },
    entries,
  )
}

async function readWindowsHolder(root: string, target: CliRelease.Target, value: unknown) {
  const arch = target === "windows-arm64" ? "arm64" : target.startsWith("windows-x64") ? "x64" : undefined
  if (
    !arch ||
    !value ||
    typeof value !== "object" ||
    Object.keys(value).length !== 3 ||
    !("arch" in value) ||
    value.arch !== arch ||
    !("size" in value) ||
    typeof value.size !== "number" ||
    !Number.isSafeInteger(value.size) ||
    value.size <= 0 ||
    value.size > maximumExecutableBytes ||
    !("sha256" in value) ||
    typeof value.sha256 !== "string" ||
    value.sha256.length !== 64 ||
    !/^[a-f0-9]{64}$/.test(value.sha256)
  )
    throw new Error("Invalid Windows holder descriptor in the prepared CLI build.")

  const name = windowsHolderCompanionName(arch, value.sha256)
  const file = path.join(root, "bin", name)
  await regularFile(file)
  const bytes = Buffer.from(
    await Bun.file(file)
      .slice(0, maximumExecutableBytes + 1)
      .arrayBuffer(),
  )
  if (bytes.length !== value.size || new Bun.CryptoHasher("sha256").update(bytes).digest("hex") !== value.sha256)
    throw new Error("The Windows holder does not match the prepared CLI build descriptor.")
  const wire = validatePackagedWindowsHolder(bytes, arch)
  return { name, bytes, wire }
}

async function regularFile(file: string) {
  const stat = await lstat(file)
  if (!stat.isFile() || stat.nlink !== 1 || stat.size <= 0 || stat.size > CliRelease.MAX_ARCHIVE_BYTES)
    throw new Error(`The CLI release requires a nonempty regular file: ${path.basename(file)}.`)
}

async function directory(file: string) {
  if (!(await lstat(file)).isDirectory()) throw new Error("The CLI release contains a linked or invalid directory.")
}

function nativeHeader(target: CliRelease.Target, bytes: Uint8Array) {
  if (bytes.length < 64) throw new Error(`The CLI binary has no native header: ${target}.`)
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const arm = target.includes("-arm64")
  const matches = target.startsWith("darwin-")
    ? view.getUint32(0, true) === 0xfeedfacf && view.getUint32(4, true) === (arm ? 0x100000c : 0x1000007)
    : target.startsWith("linux-")
      ? view.getUint32(0, false) === 0x7f454c46 &&
        bytes[4] === 2 &&
        bytes[5] === 1 &&
        view.getUint16(18, true) === (arm ? 183 : 62)
      : view.getUint16(0, true) === 0x5a4d &&
        view.getUint32(60, true) <= bytes.length - 6 &&
        view.getUint32(view.getUint32(60, true), true) === 0x4550 &&
        view.getUint16(view.getUint32(60, true) + 4, true) === (arm ? 0xaa64 : 0x8664)
  if (!matches) throw new Error(`The CLI native header does not match its target: ${target}.`)
}
