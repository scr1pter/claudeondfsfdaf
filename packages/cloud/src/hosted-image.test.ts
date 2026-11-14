import { describe, expect, test } from "bun:test"
import { mkdir, writeFile } from "node:fs/promises"
import path from "node:path"
import { create } from "tar"
import { CliRelease } from "@vectordevai/schema/cli-release"
import { cliReleaseFixture } from "./cli-release-fixture"
import { cliNotices, packageCliRelease } from "./cli-release-package"
import type { Cli } from "./hosted-budget"
import {
  fetchImageCli,
  IMAGE_CLI_TARGET,
  imageTag,
  loginRegistry,
  pickDigest,
  registryRepository,
  unpackImageCli,
  type Fetcher,
} from "./hosted-image"

// WP A58: the image workflow's code. The cloud computer's image takes the Vector CLI from a release already published
// to Vector's download store, checked against its manifest (never a moving tag); its registry tag and pushed digest
// are checked before the bake; Docker signs in through the pinned Vercel CLI with the token in the environment only.
// Everything runs against fixtures here: nothing reaches Vector's store, Vercel or a registry.

const REPOSITORY = "vcr.vercel.com/vector-hosted/computers/vector-computer"

/** Serves a fixture release's files from its origin, and records what was asked for. */
function store(files: Map<string, Uint8Array>) {
  const asked: { url: string; init: RequestInit }[] = []
  const fetcher: Fetcher = async (url, init) => {
    asked.push({ url, init })
    const bytes = files.get(url)
    return bytes ? new Response(bytes, { status: 200 }) : new Response("missing", { status: 404 })
  }
  return { fetcher, asked }
}

async function publishedRelease(sample: Awaited<ReturnType<typeof cliReleaseFixture>>) {
  const manifest = await packageCliRelease(sample.input)
  const files = new Map<string, Uint8Array>()
  files.set(
    `${sample.input.origin}/${CliRelease.manifestPath(sample.input.version)}`,
    await Bun.file(path.join(sample.input.output, "manifest.json")).bytes(),
  )
  for (const target of CliRelease.targets) {
    const asset = manifest.targets[target]!
    files.set(asset.url, await Bun.file(path.join(sample.input.output, asset.filename)).bytes())
  }
  return { manifest, files }
}

async function archive(root: string, entries: Record<string, Uint8Array | string>) {
  const directory = path.join(root, `crafted-${Math.random().toString(36).slice(2)}`)
  await mkdir(directory)
  for (const [name, content] of Object.entries(entries)) await writeFile(path.join(directory, name), content)
  const file = `${directory}.tar.gz`
  await create({ gzip: true, file, cwd: directory, portable: true }, Object.keys(entries))
  const bytes = await Bun.file(file).bytes()
  const asset: CliRelease.Asset = {
    filename: CliRelease.filename(IMAGE_CLI_TARGET),
    pathname: CliRelease.archivePath("1.99.123", IMAGE_CLI_TARGET),
    url: `https://fixturestore.public.blob.vercel-storage.com/${CliRelease.archivePath("1.99.123", IMAGE_CLI_TARGET)}`,
    size: bytes.byteLength,
    sha256: new Bun.CryptoHasher("sha256").update(bytes).digest("hex"),
  }
  return { bytes, asset }
}

function elf(machine: number) {
  const bytes = new Uint8Array(256)
  const view = new DataView(bytes.buffer)
  view.setUint32(0, 0x7f454c46, false)
  bytes[4] = 2
  bytes[5] = 1
  view.setUint16(18, machine, true)
  return bytes
}

const notices = Object.fromEntries(cliNotices.map((name) => [name, `notice ${name}\n`]))

describe("the CLI in the image", () => {
  test("is the published release's x86-64 musl binary, by exact version, checked against its manifest", async () => {
    await using sample = await cliReleaseFixture()
    const { manifest, files } = await publishedRelease(sample)
    const { fetcher, asked } = store(files)
    const output = path.join(sample.root, "hosted", "bin", "vector")
    const result = await fetchImageCli({ origin: sample.input.origin, version: sample.input.version, output, fetcher })
    expect(result).toEqual({
      version: sample.input.version,
      sourceRevision: sample.input.sourceRevision,
      sha256: manifest.targets[IMAGE_CLI_TARGET]!.sha256,
    })
    expect(IMAGE_CLI_TARGET).toBe("linux-x64-baseline-musl")
    const written = await Bun.file(output).bytes()
    const source = await Bun.file(path.join(sample.input.source, `vector-${IMAGE_CLI_TARGET}`, "bin", "vector")).bytes()
    expect(Buffer.from(written).equals(Buffer.from(source))).toBe(true)
    expect((await Bun.file(output).stat()).mode & 0o777).toBe(0o755)
    // Only the manifest and that one archive, from the release's own store, never following a redirect.
    expect(asked.map((entry) => entry.url)).toEqual([
      `${sample.input.origin}/releases/vector-cli/v${sample.input.version}/manifest.json`,
      manifest.targets[IMAGE_CLI_TARGET]!.url,
    ])
    for (const entry of asked) expect(entry.init.redirect).toBe("error")
    // A second run never writes over the first.
    await expect(fetchImageCli({ origin: sample.input.origin, version: sample.input.version, output, fetcher })).rejects.toThrow(
      "already exists",
    )
  })

  test("a tampered archive, another version's manifest or a missing release writes nothing", async () => {
    await using sample = await cliReleaseFixture()
    const { manifest, files } = await publishedRelease(sample)
    const output = path.join(sample.root, "bin", "vector")
    const url = manifest.targets[IMAGE_CLI_TARGET]!.url
    const tampered = new Map(files)
    const bytes = new Uint8Array(files.get(url)!)
    bytes[bytes.length - 1] ^= 1
    tampered.set(url, bytes)
    await expect(
      fetchImageCli({ origin: sample.input.origin, version: sample.input.version, output, fetcher: store(tampered).fetcher }),
    ).rejects.toThrow("does not match its release manifest")
    const renamed = new Map(files)
    renamed.set(
      `${sample.input.origin}/${CliRelease.manifestPath("1.99.124")}`,
      files.get(`${sample.input.origin}/${CliRelease.manifestPath(sample.input.version)}`)!,
    )
    await expect(
      fetchImageCli({ origin: sample.input.origin, version: "1.99.124", output, fetcher: store(renamed).fetcher }),
    ).rejects.toThrow("another version")
    await expect(
      fetchImageCli({ origin: sample.input.origin, version: "1.99.125", output, fetcher: store(files).fetcher }),
    ).rejects.toThrow("404")
    expect(await Bun.file(output).exists()).toBe(false)
  })

  test("a channel name, a partial version or another store is refused before anything is fetched", async () => {
    await using sample = await cliReleaseFixture()
    const { files } = await publishedRelease(sample)
    const output = path.join(sample.root, "bin", "vector")
    for (const [origin, version] of [
      [sample.input.origin, "latest"],
      [sample.input.origin, "beta"],
      [sample.input.origin, "1.99"],
      [sample.input.origin, ""],
      ["https://example.com", sample.input.version],
      ["http://fixturestore.public.blob.vercel-storage.com", sample.input.version],
      ["", sample.input.version],
    ] as const) {
      const { fetcher, asked } = store(files)
      await expect(fetchImageCli({ origin, version, output, fetcher })).rejects.toThrow()
      expect({ origin, version, asked: asked.length }).toEqual({ origin, version, asked: 0 })
    }
  })

  test("an archive holding anything but the binary and its notices, or another machine's binary, is refused", async () => {
    await using sample = await cliReleaseFixture()
    const cases: Array<[string, Record<string, Uint8Array | string>, string]> = [
      ["extra file", { vector: elf(62), ...notices, "postinstall.sh": "#!/bin/sh\n" }, "besides the binary"],
      ["no notices", { vector: elf(62) }, "besides the binary"],
      ["arm64 binary", { vector: elf(183), ...notices }, "64-bit x86"],
      ["not a program", { vector: "#!/bin/sh\necho hi\n".padEnd(80, " "), ...notices }, "64-bit x86"],
    ]
    for (const [label, entries, message] of cases) {
      const crafted = await archive(sample.root, entries)
      const output = path.join(sample.root, label, "vector")
      await expect(unpackImageCli({ ...crafted, output })).rejects.toThrow(message)
      expect({ label, written: await Bun.file(output).exists() }).toEqual({ label, written: false })
    }
    const good = await archive(sample.root, { vector: elf(62), ...notices })
    const output = path.join(sample.root, "good", "vector")
    await expect(unpackImageCli({ ...good, output })).resolves.toEqual({ sha256: good.asset.sha256 })
    // The size and digest come from the manifest: bytes that differ from it are refused before they are opened.
    await expect(
      unpackImageCli({ ...good, asset: { ...good.asset, size: good.asset.size + 1 }, output: path.join(sample.root, "x", "vector") }),
    ).rejects.toThrow("does not match")
  })
})

describe("the registry", () => {
  test("only the hosted team's registry, as vcr.vercel.com/<team>/<project>/<name>", () => {
    expect(registryRepository(REPOSITORY)).toBe(REPOSITORY)
    expect(registryRepository(`  ${REPOSITORY}\n`)).toBe(REPOSITORY)
    for (const value of [
      undefined,
      "",
      "ghcr.io/vector/computer",
      "docker.io/library/alpine",
      "vcr.vercel.com/vector-hosted/computer",
      `${REPOSITORY}:latest`,
      `${REPOSITORY}@sha256:${"a".repeat(64)}`,
      "vcr.vercel.com/Vector/computers/vector-computer",
      "vcr.vercel.com/vector-hosted/computers/vector computer",
      "https://vcr.vercel.com/vector-hosted/computers/vector-computer",
      "vcr.vercel.com.example.com/a/b/c",
      "vcr.vercel.com/vector_hosted/computers/vector-computer",
    ])
      expect({ value, accepted: registryRepository(value) }).toEqual({ value, accepted: undefined })
  })

  test("each generation has its own tag; a bad generation or repository is refused", () => {
    expect(imageTag(REPOSITORY, "7")).toBe(`${REPOSITORY}:g7`)
    expect(imageTag(` ${REPOSITORY}\n`, "12")).toBe(`${REPOSITORY}:g12`)
    for (const generation of ["0", "-1", "07", "1.5", "", "1; echo", "1000000"])
      expect(() => imageTag(REPOSITORY, generation)).toThrow()
    expect(() => imageTag("ghcr.io/vector/computer", "7")).toThrow()
  })

  test("the bake gets the one digest the push produced in that repository", () => {
    const digest = `${REPOSITORY}@sha256:${"b".repeat(64)}`
    expect(pickDigest(REPOSITORY, `${digest}\n`)).toBe(digest)
    expect(pickDigest(REPOSITORY, `docker.io/library/other@sha256:${"c".repeat(64)}\n${digest}\n\n`)).toBe(digest)
    expect(pickDigest(REPOSITORY, "")).toBeUndefined()
    expect(pickDigest(REPOSITORY, `${REPOSITORY}-x@sha256:${"b".repeat(64)}\n`)).toBeUndefined()
    expect(pickDigest(REPOSITORY, `${REPOSITORY}@sha256:${"b".repeat(63)}\n`)).toBeUndefined()
    expect(pickDigest(REPOSITORY, `${digest}\n${REPOSITORY}@sha256:${"d".repeat(64)}\n`)).toBeUndefined()
    // bake-snapshot.ts takes it as it is: the image pinned by digest.
    expect(digest).toMatch(/^[a-z0-9][a-z0-9._/-]{0,250}@sha256:[a-f0-9]{64}$/)
  })

  test("Docker signs in through the pinned Vercel CLI, with the token never on its command line", async () => {
    const calls: string[][] = []
    const cli: Cli = async (args) => {
      calls.push(args)
      return { code: 0, stdout: "" }
    }
    await loginRegistry({ token: "fixture-hosted-token", team: "team_fixtureHosted", project: "prj_fixtureHosted", cli })
    expect(calls).toEqual([["vcr", "login", "docker"]])
    expect(JSON.stringify(calls)).not.toContain("fixture-hosted-token")
    for (const settings of [
      { token: "", team: "team_fixtureHosted", project: "prj_fixtureHosted" },
      { token: "fixture-hosted-token", team: "", project: "prj_fixtureHosted" },
      { token: "fixture-hosted-token", team: "team_fixtureHosted", project: "x" },
    ]) {
      const before = calls.length
      await expect(loginRegistry({ ...settings, cli })).rejects.toThrow()
      expect(calls.length).toBe(before)
    }
    await expect(
      loginRegistry({
        token: "fixture-hosted-token",
        team: "team_fixtureHosted",
        project: "prj_fixtureHosted",
        cli: async () => ({ code: 1, stdout: "fixture-hosted-token" }),
      }),
    ).rejects.toThrow("could not sign Docker in")
  })
})
