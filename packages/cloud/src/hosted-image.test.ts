import { describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, readdir, rm, symlink, writeFile } from "node:fs/promises"
import os from "node:os"
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

/** An empty temporary folder, removed when the test's `await using` scope ends. */
async function emptyFolder(prefix: string) {
  const directory = await mkdtemp(path.join(os.tmpdir(), prefix))
  return { directory, [Symbol.asyncDispose]: () => rm(directory, { recursive: true, force: true }) }
}

const notices = Object.fromEntries(cliNotices.map((name) => [name, `notice ${name}\n`]))
const written = async (directory: string) =>
  readdir(directory).then(
    (names) => names.sort(),
    () => [],
  )

describe("the CLI in the image", () => {
  test("is the published release's x86-64 musl binary, by exact version, checked against its manifest", async () => {
    await using sample = await cliReleaseFixture()
    const { manifest, files } = await publishedRelease(sample)
    const { fetcher, asked } = store(files)
    const output = path.join(sample.root, "hosted", "bin", "vector")
    const directory = path.join(sample.root, "hosted", "notices")
    const result = await fetchImageCli({
      origin: sample.input.origin,
      version: sample.input.version,
      output,
      notices: directory,
      fetcher,
    })
    expect(result).toEqual({
      version: sample.input.version,
      sourceRevision: sample.input.sourceRevision,
      sha256: manifest.targets[IMAGE_CLI_TARGET]!.sha256,
    })
    expect(IMAGE_CLI_TARGET).toBe("linux-x64-baseline-musl")
    const binary = await Bun.file(output).bytes()
    const source = await Bun.file(path.join(sample.input.source, `vector-${IMAGE_CLI_TARGET}`, "bin", "vector")).bytes()
    expect(Buffer.from(binary).equals(Buffer.from(source))).toBe(true)
    expect((await Bun.file(output).stat()).mode & 0o777).toBe(0o755)
    // The notices exactly as the CLI build wrote them next to bin/ (the fixture keeps the build's layout), mode 0644.
    expect(await written(directory)).toEqual([...cliNotices].sort())
    for (const name of cliNotices) {
      const notice = await Bun.file(path.join(directory, name)).bytes()
      const shipped = await Bun.file(path.join(sample.input.source, `vector-${IMAGE_CLI_TARGET}`, name)).bytes()
      expect({ name, same: Buffer.from(notice).equals(Buffer.from(shipped)) }).toEqual({ name, same: true })
      expect({ name, mode: (await Bun.file(path.join(directory, name)).stat()).mode & 0o777 }).toEqual({
        name,
        mode: 0o644,
      })
    }
    // Only the manifest and that one archive, from the release's own store, never following a redirect.
    expect(asked.map((entry) => entry.url)).toEqual([
      `${sample.input.origin}/releases/vector-cli/v${sample.input.version}/manifest.json`,
      manifest.targets[IMAGE_CLI_TARGET]!.url,
    ])
    for (const entry of asked) expect(entry.init.redirect).toBe("error")
    // A second run never writes over the first.
    await expect(
      fetchImageCli({
        origin: sample.input.origin,
        version: sample.input.version,
        output,
        notices: directory,
        fetcher,
      }),
    ).rejects.toThrow("already exists")
  })

  test("a notices folder already there, even empty or a dangling link, refuses the run; a failed notice write leaves no binary", async () => {
    await using sample = await cliReleaseFixture()
    const { files } = await publishedRelease(sample)
    const output = path.join(sample.root, "hosted", "bin", "vector")
    const run = (notices: string) =>
      fetchImageCli({
        origin: sample.input.origin,
        version: sample.input.version,
        output,
        notices,
        fetcher: store(files).fetcher,
      })
    const directory = path.join(sample.root, "hosted", "notices")
    await mkdir(directory, { recursive: true })
    await writeFile(path.join(directory, "DEPENDENCY_NOTICES.md"), "left from an earlier run\n")
    await expect(run(directory)).rejects.toThrow(`${directory} already exists`)
    expect(await Bun.file(output).exists()).toBe(false)
    expect(await written(directory)).toEqual(["DEPENDENCY_NOTICES.md"])
    expect(await Bun.file(path.join(directory, "DEPENDENCY_NOTICES.md")).text()).toBe("left from an earlier run\n")
    await rm(path.join(directory, "DEPENDENCY_NOTICES.md"))
    await expect(run(directory)).rejects.toThrow(`${directory} already exists`)
    expect(await written(directory)).toEqual([])
    // A link as the folder, even a dangling one: nothing is written where it points.
    const linked = path.join(sample.root, "hosted", "linked")
    await symlink(path.join(sample.root, "nowhere"), linked)
    await expect(run(linked)).rejects.toThrow(`${linked} already exists`)
    expect(await readdir(sample.root)).not.toContain("nowhere")
    const blocked = path.join(sample.root, "blocked")
    await writeFile(blocked, "a file where the notices folder should be\n")
    await expect(run(blocked)).rejects.toThrow(`${blocked} already exists`)
    // Only "not there" counts as absent: a path under a file fails the check itself (lstat, which Bun runs as statx on
    // Linux), not the notices folder's mkdir after the archive is unpacked.
    await expect(run(path.join(blocked, "notices"))).rejects.toMatchObject({
      code: "ENOTDIR",
      syscall: expect.stringMatching(/stat/),
    })
    expect(await Bun.file(output).exists()).toBe(false)
    // Under a dangling link the check finds nothing and the notices folder cannot be made. The notices are written
    // before the binary, so a run that fails on them leaves no binary for the image build, and nothing where it points.
    await symlink(path.join(sample.root, "elsewhere"), path.join(sample.root, "dangling"))
    await expect(run(path.join(sample.root, "dangling", "notices"))).rejects.toMatchObject({ code: "ENOENT" })
    expect(await Bun.file(output).exists()).toBe(false)
    expect(await readdir(sample.root)).not.toContain("elsewhere")
  })

  test("a tampered archive, another version's manifest or a missing release writes nothing", async () => {
    await using sample = await cliReleaseFixture()
    const { manifest, files } = await publishedRelease(sample)
    const output = path.join(sample.root, "bin", "vector")
    const directory = path.join(sample.root, "notices")
    const url = manifest.targets[IMAGE_CLI_TARGET]!.url
    const tampered = new Map(files)
    const bytes = new Uint8Array(files.get(url)!)
    bytes[bytes.length - 1] ^= 1
    tampered.set(url, bytes)
    await expect(
      fetchImageCli({
        origin: sample.input.origin,
        version: sample.input.version,
        output,
        notices: directory,
        fetcher: store(tampered).fetcher,
      }),
    ).rejects.toThrow("does not match its release manifest")
    const renamed = new Map(files)
    renamed.set(
      `${sample.input.origin}/${CliRelease.manifestPath("1.99.124")}`,
      files.get(`${sample.input.origin}/${CliRelease.manifestPath(sample.input.version)}`)!,
    )
    await expect(
      fetchImageCli({
        origin: sample.input.origin,
        version: "1.99.124",
        output,
        notices: directory,
        fetcher: store(renamed).fetcher,
      }),
    ).rejects.toThrow("another version")
    await expect(
      fetchImageCli({
        origin: sample.input.origin,
        version: "1.99.125",
        output,
        notices: directory,
        fetcher: store(files).fetcher,
      }),
    ).rejects.toThrow("404")
    expect(await Bun.file(output).exists()).toBe(false)
    expect(await written(directory)).toEqual([])
  })

  test("a channel name, a partial version or another store is refused before anything is fetched", async () => {
    await using sample = await cliReleaseFixture()
    const { files } = await publishedRelease(sample)
    const output = path.join(sample.root, "bin", "vector")
    const directory = path.join(sample.root, "notices")
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
      await expect(fetchImageCli({ origin, version, output, notices: directory, fetcher })).rejects.toThrow()
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
      const directory = path.join(sample.root, label, "notices")
      await expect(unpackImageCli({ ...crafted, output, notices: directory })).rejects.toThrow(message)
      expect({ label, binary: await Bun.file(output).exists(), notices: await written(directory) }).toEqual({
        label,
        binary: false,
        notices: [],
      })
    }
    const good = await archive(sample.root, { vector: elf(62), ...notices })
    const output = path.join(sample.root, "good", "vector")
    const directory = path.join(sample.root, "good", "notices")
    await expect(unpackImageCli({ ...good, output, notices: directory })).resolves.toEqual({
      sha256: good.asset.sha256,
    })
    for (const name of cliNotices) expect(await Bun.file(path.join(directory, name)).text()).toBe(`notice ${name}\n`)
    // The size and digest come from the manifest: bytes that differ from it are refused before they are opened.
    await expect(
      unpackImageCli({
        ...good,
        asset: { ...good.asset, size: good.asset.size + 1 },
        output: path.join(sample.root, "x", "vector"),
        notices: path.join(sample.root, "x", "notices"),
      }),
    ).rejects.toThrow("does not match")
    expect(await written(path.join(sample.root, "x"))).toEqual([])
  })
})

describe("the image's notices", () => {
  test("the image's Dockerfile copies every notice the cli step writes, into the image's notices folder", async () => {
    const dockerfile = await Bun.file(path.join(import.meta.dir, "../../hosted-computer/image/Dockerfile")).text()
    const sources = /^COPY --chmod=644 (.+) \/usr\/share\/vector\/$/m.exec(dockerfile)?.[1]?.split(" ")
    expect(sources).toEqual(cliNotices.map((name) => `notices/${name}`))
  })

  test("the cli command needs both paths, and checks them before it fetches or writes anything", async () => {
    await using scratch = await emptyFolder("vector-image-cli-main-")
    const run = (...args: string[]) => {
      const result = Bun.spawnSync([process.execPath, path.join(import.meta.dir, "hosted-image.ts"), "cli", ...args], {
        cwd: scratch.directory,
        env: { PATH: process.env.PATH ?? "" },
        stdout: "pipe",
        stderr: "pipe",
      })
      return { code: result.exitCode, said: result.stderr.toString().trim() }
    }
    const missing = { code: 1, said: "Pass --output <path> --notices <directory>." }
    expect(run("--output", "bin/vector")).toEqual(missing)
    expect(run("--notices", "notices")).toEqual(missing)
    expect(run("--output", "bin/vector", "--notices")).toEqual(missing)
    // A flag is never taken as the value of the flag before it.
    expect(run("--output", "--notices", "notices")).toEqual(missing)
    // Both given: the next check is the store's origin, which this environment does not set.
    expect(run("--output", "bin/vector", "--notices", "notices")).toEqual({
      code: 1,
      said: "Set VECTOR_CLI_BLOB_ORIGIN to Vector's download store.",
    })
    expect(await readdir(scratch.directory)).toEqual([])
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
