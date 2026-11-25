import { expect, test } from "bun:test"
import { rm, symlink, utimes } from "node:fs/promises"
import path from "node:path"
import { list } from "tar"
import { BlobReader, Uint8ArrayWriter, ZipReader } from "@zip.js/zip.js"
import { CliRelease } from "@vectordevai/schema/cli-release"
import { cliNotices, hashCliFile, packageCliRelease } from "./cli-release-package"
import { cliReleaseFixture } from "./cli-release-fixture"

test("packages all twelve native targets as exactly four flat regular files with the pinned identity", async () => {
  await using fixture = await cliReleaseFixture()
  const manifest = await packageCliRelease(fixture.input)
  expect(CliRelease.decode(manifest, fixture.input.origin)).toEqual(manifest)
  expect(manifest.sourceRevision).toBe(fixture.input.sourceRevision)
  expect(manifest.catalogSha256).toBe(fixture.input.catalogSha256)
  for (const target of CliRelease.targets) {
    const asset = manifest.targets[target]!
    const archive = path.join(fixture.input.output, asset.filename)
    expect(await hashCliFile(archive)).toEqual({ size: asset.size, sha256: asset.sha256 })
    const binary = target.startsWith("windows-") ? "vector.exe" : "vector"
    const expected = [binary, ...cliNotices]
    const files = new Map<string, Uint8Array>()
    if (target.startsWith("windows-")) {
      const reader = new ZipReader(new BlobReader(Bun.file(archive)))
      try {
        const entries = await reader.getEntries()
        expect(entries.map((entry) => entry.filename)).toEqual(expected)
        for (const entry of entries) {
          expect(entry.directory).toBe(false)
          expect((entry.externalFileAttributes >>> 16) & 0o170000).toBe(0o100000)
          if (entry.directory || !entry.getData) throw new Error("Unexpected directory or unreadable entry")
          files.set(entry.filename, await entry.getData(new Uint8ArrayWriter(), { useWebWorkers: false }))
        }
      } finally {
        await reader.close()
      }
    } else {
      const entries: Array<{ name: string; type: string }> = []
      await list({
        file: archive,
        onReadEntry: (entry) => {
          entries.push({ name: entry.path, type: entry.type })
        },
      })
      expect(entries).toEqual(expected.map((name) => ({ name, type: "File" })))
      for (const [name, file] of await new Bun.Archive(await Bun.file(archive).bytes()).files())
        files.set(name, await file.bytes())
    }
    for (const name of expected)
      expect(files.get(name)).toEqual(
        await Bun.file(
          path.join(fixture.input.source, `vector-${target}`, name === binary ? `bin/${name}` : name),
        ).bytes(),
      )
  }
})

function holderFixture(arch: "x64" | "arm64", wire: "json" | "vsh1" = "json") {
  const bytes = Buffer.alloc(512)
  const pe = 64
  const optional = pe + 24
  const pe32Plus = wire === "vsh1" || arch === "x64"
  const optionalSize = pe32Plus ? 240 : 224
  const directories = pe32Plus ? 112 : 96
  const clr = optional + directories + 14 * 8
  bytes.writeUInt16LE(0x5a4d, 0)
  bytes.writeUInt32LE(pe, 60)
  bytes.writeUInt32LE(0x4550, pe)
  bytes.writeUInt16LE(arch === "x64" ? 0x8664 : wire === "vsh1" ? 0xaa64 : 0x14c, pe + 4)
  bytes.writeUInt16LE(1, pe + 6)
  bytes.writeUInt16LE(optionalSize, pe + 20)
  bytes.writeUInt16LE(2, pe + 22)
  bytes.writeUInt16LE(pe32Plus ? 0x20b : 0x10b, optional)
  bytes.writeUInt16LE(3, optional + 68)
  bytes.writeUInt32LE(16, optional + directories - 4)
  const section = optional + optionalSize
  if (wire === "vsh1") {
    bytes.writeUInt16LE(0x140, optional + 70)
    bytes.writeUInt32LE(0x2000, optional + 16)
    bytes.writeUInt32LE(128, section + 8)
    bytes.writeUInt32LE(0x20000020, section + 36)
  } else {
    bytes.writeUInt32LE(0x2000, clr)
    bytes.writeUInt32LE(72, clr + 4)
  }
  bytes.writeUInt32LE(0x2000, section + 12)
  bytes.writeUInt32LE(128, section + 16)
  bytes.writeUInt32LE(384, section + 20)
  bytes.writeUInt32LE(1, 384 + 16)
  return bytes
}

async function writeHolder(
  source: string,
  target: CliRelease.Target,
  arch: "x64" | "arm64",
  bytes = holderFixture(arch),
  sha256 = new Bun.CryptoHasher("sha256").update(bytes).digest("hex"),
) {
  const root = path.join(source, `vector-${target}`)
  const file = path.join(root, "package.json")
  const name = `vector-holder-${arch}-${sha256}.exe`
  await Bun.write(
    file,
    JSON.stringify({ ...(await Bun.file(file).json()), vectorWindowsHolder: { arch, size: bytes.length, sha256 } }),
  )
  await Bun.write(path.join(root, "bin", name), bytes)
  return name
}

test.each(["json", "vsh1"] as const)("adds exactly one verified %s holder to each Windows ZIP", async (wire) => {
  await using fixture = await cliReleaseFixture()
  const windows = CliRelease.targets.filter((target) => target.startsWith("windows-"))
  const prepared = new Map<CliRelease.Target, { name: string; bytes: Buffer }>()
  for (const target of windows) {
    const arch = target === "windows-arm64" ? "arm64" : "x64"
    const bytes = holderFixture(arch, wire)
    prepared.set(target, { name: await writeHolder(fixture.input.source, target, arch, bytes), bytes })
  }

  const manifest = await packageCliRelease(fixture.input)
  expect(manifest.schemaVersion).toBe(1)
  for (const [target, holder] of prepared) {
    const archive = path.join(fixture.input.output, CliRelease.filename(target))
    const reader = new ZipReader(new BlobReader(Bun.file(archive)))
    try {
      const entries = await reader.getEntries()
      expect(entries.map((entry) => entry.filename)).toEqual(["vector.exe", ...cliNotices, holder.name])
      const companion = entries[4]!
      if (companion.directory || !companion.getData) throw new Error("Unexpected holder entry")
      expect(companion.externalFileAttributes >>> 16).toBe(0o100755)
      expect(await companion.getData(new Uint8ArrayWriter(), { useWebWorkers: false })).toEqual(
        new Uint8Array(holder.bytes),
      )
    } finally {
      await reader.close()
    }
  }
  expect(await packageCliRelease(fixture.input)).toEqual(manifest)
})

test("rejects inconsistent Windows holder formats before writing any release archive", async () => {
  await using fixture = await cliReleaseFixture()
  for (const target of CliRelease.targets.filter((target) => target.startsWith("windows-"))) {
    const arch = target === "windows-arm64" ? "arm64" : "x64"
    await writeHolder(fixture.input.source, target, arch, holderFixture(arch, arch === "arm64" ? "json" : "vsh1"))
  }
  await expect(packageCliRelease(fixture.input)).rejects.toThrow("one Windows holder format")
  expect(await Bun.file(path.join(fixture.input.output, CliRelease.filename("darwin-arm64"))).exists()).toBe(false)
})

test.each([
  ["windows-arm64", "x64", holderFixture("x64"), undefined, "descriptor"],
  ["windows-arm64", "arm64", holderFixture("x64", "vsh1"), undefined, "native Windows console"],
  ["windows-arm64", "arm64", holderFixture("x64"), undefined, "managed Windows console"],
  ["windows-arm64", "arm64", holderFixture("arm64"), "a".repeat(64), "does not match"],
  ["windows-arm64", "arm64", Buffer.alloc(1_048_577), undefined, "descriptor"],
  ["windows-arm64", "arm64", holderFixture("arm64"), undefined, "every Windows target"],
  ["linux-arm64", "arm64", holderFixture("arm64"), undefined, "descriptor"],
] as const)(
  "rejects invalid or incomplete Windows holder inputs for %s (%s)",
  async (target, arch, bytes, sha256, error) => {
    await using fixture = await cliReleaseFixture()
    await writeHolder(fixture.input.source, target, arch, bytes, sha256)
    await expect(packageCliRelease(fixture.input)).rejects.toThrow(error)
    expect(await Bun.file(path.join(fixture.input.output, CliRelease.filename("darwin-arm64"))).exists()).toBe(false)
  },
)

test("archives are deterministic across source mtimes and safe to prepare again", async () => {
  await using fixture = await cliReleaseFixture()
  const first = await packageCliRelease(fixture.input)
  for (const target of CliRelease.targets)
    await utimes(path.join(fixture.input.source, `vector-${target}`, "LICENSE"), new Date(), new Date())
  expect(await packageCliRelease({ ...fixture.input, output: path.join(fixture.root, "again") })).toEqual(first)
  expect(await packageCliRelease(fixture.input)).toEqual(first)
})

test.each([
  ["version", "1.99.122"],
  ["vectorStandalone", false],
  ["vectorSourceRevision", "b".repeat(40)],
  ["vectorCatalogSha256", "b".repeat(64)],
])("refuses mismatched %s before creating any archives", async (field, value) => {
  await using fixture = await cliReleaseFixture()
  const file = path.join(fixture.input.source, "vector-linux-x64", "package.json")
  await Bun.write(file, JSON.stringify({ ...(await Bun.file(file).json()), [field]: value }))
  await expect(packageCliRelease(fixture.input)).rejects.toThrow("build identity")
  expect(await Bun.file(path.join(fixture.input.output, "vector-darwin-arm64.tar.gz")).exists()).toBe(false)
})

test("refuses missing targets, wrong native headers, mismatched notices, and source symlinks", async () => {
  for (const mode of ["missing", "header", "notice", "symlink"]) {
    await using fixture = await cliReleaseFixture()
    const directory = path.join(fixture.input.source, "vector-windows-arm64")
    if (mode === "missing") await rm(directory, { recursive: true })
    if (mode === "header") await Bun.write(path.join(directory, "bin/vector.exe"), new Uint8Array(256))
    if (mode === "notice") await Bun.write(path.join(directory, "LICENSE"), "different notice")
    if (mode === "symlink") {
      await rm(path.join(directory, "LICENSE"))
      await symlink(path.join(fixture.input.source, "vector-linux-x64/LICENSE"), path.join(directory, "LICENSE"))
    }
    await expect(packageCliRelease(fixture.input)).rejects.toThrow()
    expect(await Bun.file(path.join(fixture.input.output, "vector-darwin-arm64.tar.gz")).exists()).toBe(false)
  }
})

test.each(["former name", "borrowed registration"])(
  "refuses to prepare any archive when one binary carries a %s",
  async (planted) => {
    await using fixture = await cliReleaseFixture()
    // Derived from the required MIT notice, as the audit itself does; never written here.
    const name = (await Bun.file(path.resolve(import.meta.dir, "../../../THIRD_PARTY_NOTICES.md")).text())
      .split("<!-- vector-upstream-attribution -->")[1]
      ?.match(/^Copyright \(c\) \d{4} (.+)$/m)?.[1]
      ?.trim() as string
    const binary = path.join(fixture.input.source, "vector-windows-arm64/bin/vector.exe")
    const bytes = await Bun.file(binary).bytes()
    bytes.set(new TextEncoder().encode(planted === "former name" ? name : "Ov23li8tweQw6odWQebz"), 200)
    await Bun.write(binary, bytes)
    await expect(packageCliRelease(fixture.input)).rejects.toThrow("artifact audit violation")
    for (const target of CliRelease.targets)
      expect(await Bun.file(path.join(fixture.input.output, CliRelease.filename(target))).exists()).toBe(false)
  },
)

test("refuses wrong prepared catalog and never overwrites conflicting prepared archives", async () => {
  await using fixture = await cliReleaseFixture()
  await expect(packageCliRelease({ ...fixture.input, catalogSha256: "0".repeat(64) })).rejects.toThrow("pinned digest")
  await packageCliRelease(fixture.input)
  const file = path.join(fixture.input.output, CliRelease.filename("darwin-arm64"))
  await Bun.write(file, "conflicting local archive")
  await expect(packageCliRelease(fixture.input)).rejects.toThrow("Refusing to replace different prepared")
  expect(await Bun.file(file).text()).toBe("conflicting local archive")
})
