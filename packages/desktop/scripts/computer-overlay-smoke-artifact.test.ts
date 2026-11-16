import { describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import {
  archiveComputerOverlayStage,
  checkComputerOverlayTar,
  computerOverlayArtifactName,
  restoreComputerOverlayArtifact,
} from "./computer-overlay-smoke-artifact"
import {
  COMPUTER_OVERLAY_STAGE_BUNDLES,
  COMPUTER_OVERLAY_STAGE_MANIFEST,
  computerOverlayStagePaths,
} from "./computer-overlay-smoke-stage"
import type { HelperPlatform, NativeCommand } from "./build-computer-helper"

// All archives, files, commands and source proofs here are injected boundary fixtures; no tar/native process runs.
type Entry = { name: string; type?: string; mode?: number; content?: string | Buffer; target?: string }
const sha = "a".repeat(40),
  artifactDigest = "sha256:" + "b".repeat(64)
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex")
function entries(platform: HelperPlatform = "darwin"): Entry[] {
  const paths = computerOverlayStagePaths(platform)
  const files = [paths.driver, paths.electron, paths.defaultApp, ...COMPUTER_OVERLAY_STAGE_BUNDLES].map((name) => ({
    name,
    content: Buffer.from("isolated-archive-fixture:" + name),
    mode: 0o755,
  }))
  const manifest = {
    helperVersion: "1.0.11",
    protocol: { min: 1, max: 1 },
    platform,
    sourceDigest: "c".repeat(64),
    toolchain: "isolated archive fixture",
    files: Object.fromEntries(files.map((file) => [file.name, { sha256: hash(file.content), arch: ["x64"] }])),
  }
  return [{ name: COMPUTER_OVERLAY_STAGE_MANIFEST, content: JSON.stringify(manifest) }, ...files]
}
function tar(values: Entry[]) {
  return Buffer.concat([
    ...values.flatMap((entry) => {
      const body = entry.type === "2" || entry.type === "5" ? Buffer.alloc(0) : Buffer.from(entry.content ?? "fixture")
      const header = Buffer.alloc(512)
      let name = entry.name,
        prefix = ""
      if (Buffer.byteLength(name) > 100) {
        const split = name.lastIndexOf("/")
        prefix = name.slice(0, split)
        name = name.slice(split + 1)
      }
      if (Buffer.byteLength(name) > 100 || Buffer.byteLength(prefix) > 155)
        throw new Error("The test header exceeded portable ustar bounds.")
      header.write(name, 0, 100)
      header.write(prefix, 345, 155)
      header.write((entry.mode ?? 0o644).toString(8).padStart(7, "0") + "\0", 100)
      header.write(body.length.toString(8).padStart(11, "0") + "\0", 124)
      header.fill(32, 148, 156)
      header[156] = (entry.type ?? "0").charCodeAt(0)
      if (entry.target) header.write(entry.target, 157, 100)
      header.write("ustar\0", 257)
      header.write("00", 263)
      header.write(
        header
          .reduce((sum, byte) => sum + byte, 0)
          .toString(8)
          .padStart(6, "0") + "\0 ",
        148,
      )
      return [header, body, Buffer.alloc((512 - (body.length % 512)) % 512)]
    }),
    Buffer.alloc(1024),
  ])
}
const artifact = (name: string, id = 1) => ({
  id,
  name,
  expired: false,
  digest: artifactDigest,
  workflow_run: { id: 42, head_sha: sha, repository_id: 7, head_repository_id: 7 },
})
const environment = (root?: string) => ({
  GITHUB_REPOSITORY: "fixture/repo",
  GITHUB_RUN_ID: "42",
  GITHUB_SHA: sha,
  ...(root ? { RUNNER_TEMP: root } : {}),
})
async function materialize(root: string, values: Entry[]) {
  for (const entry of values) {
    const file = path.join(root, ...entry.name.split("/"))
    if (entry.type === "5") {
      await mkdir(file, { recursive: true })
      continue
    }
    await mkdir(path.dirname(file), { recursive: true })
    if (entry.type === "2") await symlink(entry.target!, file)
    else await writeFile(file, entry.content ?? "fixture")
  }
}

describe("separate immutable computer overlay artifacts", () => {
  test("names admit only one source/release suffix and remain separate from shipping helpers", () => {
    expect(computerOverlayArtifactName("darwin", "v1.99.112")).toBe("computer-overlay-smoke-darwin-v1.99.112")
    expect(computerOverlayArtifactName("win32", sha)).toBe(`computer-overlay-smoke-win32-${sha}`)
    for (const suffix of ["", "../escape", "release\n", "a".repeat(129)])
      expect(() => computerOverlayArtifactName("win32", suffix)).toThrow()
  })
  test("accepts complete portable native stages and hashes actual archived bytes", () => {
    for (const platform of ["darwin", "win32"] as const) {
      const values = entries(platform),
        result = checkComputerOverlayTar(tar(values), platform)
      expect(Object.keys(result.files)).toEqual(values.map((entry) => entry.name))
      const name = COMPUTER_OVERLAY_STAGE_BUNDLES[0]
      const content = values.find((entry) => entry.name === name)!.content!
      expect(result.files[name]?.sha256).toBe(hash(typeof content === "string" ? Buffer.from(content) : content))
      expect(result.links).toEqual({})
    }
  })
  test("only Mac Electron internal relative link chains can point to an actual archived target", () => {
    const base = "electron/Electron.app/Contents/Frameworks/Test.framework"
    const values = [
      ...entries(),
      { name: `${base}/Versions/A/library`, content: "fixture" },
      { name: `${base}/Versions/Current`, type: "2", target: "A" },
      { name: `${base}/library`, type: "2", target: "Versions/Current/library" },
    ]
    expect(checkComputerOverlayTar(tar(values), "darwin").links[`${base}/library`]).toBe("Versions/Current/library")
    expect(() =>
      checkComputerOverlayTar(
        tar([...entries("win32"), { name: "electron/link", type: "2", target: "electron.exe" }]),
        "win32",
      ),
    ).toThrow()
  })
  test("refuses absent, outside, absolute, cyclic and write-through link targets before extraction", () => {
    const base = "electron/Electron.app/Contents/Frameworks"
    const bad: Entry[][] = [
      [{ name: `${base}/link`, type: "2", target: "missing" }],
      [{ name: `${base}/link`, type: "2", target: "/etc/file" }],
      [{ name: `${base}/link`, type: "2", target: "../../../../../escape" }],
      [
        { name: `${base}/a`, type: "2", target: "b" },
        { name: `${base}/b`, type: "2", target: "a" },
      ],
      [{ name: `${base}/a`, type: "2", target: ".." }],
      [
        { name: `${base}/target/file`, content: "fixture" },
        { name: `${base}/link`, type: "2", target: "target" },
        { name: `${base}/link/overwritten`, content: "unsafe" },
      ],
      [{ name: "resources/computer/link", type: "2", target: "../electron" }],
    ]
    for (const extra of bad) expect(() => checkComputerOverlayTar(tar([...entries(), ...extra]), "darwin")).toThrow()
  })
  test("refuses escapes, profile carryover, unknown scripts, PAX, hardlinks and special modes", () => {
    for (const entry of [
      { name: "../escape" },
      { name: "/absolute" },
      { name: "electron/../escape" },
      { name: "electron\\escape" },
      { name: "profile/Preferences" },
      { name: "smoke/arbitrary.mjs" },
      { name: "electron/pax", type: "x" },
      { name: "electron/hardlink", type: "1", target: "electron/Electron.app" },
      { name: "electron/device", type: "3" },
      { name: "electron/suid", mode: 0o4755 },
    ])
      expect(() => checkComputerOverlayTar(tar([...entries(), entry]), "darwin")).toThrow()
    for (const name of ["electron/CON", "electron/file.", "electron/file ", "electron/ELECTRON.EXE"])
      expect(() => checkComputerOverlayTar(tar([...entries("win32"), { name }]), "win32")).toThrow()
  })
  test("requires all finite stage artifacts and rejects duplicate writes", () => {
    const values = entries()
    for (let index = 0; index < values.length; index++)
      expect(() => checkComputerOverlayTar(tar(values.filter((_, current) => current !== index)), "darwin")).toThrow(
        "required stage",
      )
    expect(() => checkComputerOverlayTar(tar([...values, values[0]!]), "darwin")).toThrow()
  })
  test("checks checksum, terminator, padding, trailing bytes and payload bounds", () => {
    const valid = tar(entries())
    const checksum = Buffer.from(valid)
    checksum[0] ^= 1
    const padding = Buffer.from(valid)
    const length = Number.parseInt(padding.subarray(124, 136).toString().replace(/\0.*$/s, ""), 8)
    padding[512 + length] = 1
    for (const changed of [
      checksum,
      padding,
      valid.subarray(0, -512),
      Buffer.concat([valid, Buffer.from("trailing")]),
      Buffer.concat([valid, tar(entries())]),
    ])
      expect(() => checkComputerOverlayTar(changed, "darwin")).toThrow()
  })
  test("source/run identity is mandatory and required absence cannot become a cache success", async () => {
    let requests = 0
    const run: NativeCommand = async () => {
      requests++
      return { code: 0, stdout: JSON.stringify([{ artifacts: [] }]), stderr: "" }
    }
    await expect(
      restoreComputerOverlayArtifact(
        { platform: "darwin", suffix: sha, destination: "/unused" },
        { run, environment: {} },
      ),
    ).rejects.toThrow("run identity")
    expect(requests).toBe(0)
    expect(
      (
        await restoreComputerOverlayArtifact(
          { platform: "darwin", suffix: sha, destination: "/unused" },
          { run, environment: environment() },
        )
      ).restored,
    ).toBe(false)
    await expect(
      restoreComputerOverlayArtifact(
        { platform: "darwin", suffix: sha, destination: "/unused", required: true },
        { run, environment: environment() },
      ),
    ).rejects.toThrow("required immutable")
  })
  test("restores only the exact immutable source artifact, with private extraction and two source checks", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "vector-overlay-restore-test-"))
    const destination = path.join(root, "stage"),
      name = computerOverlayArtifactName("darwin", sha),
      values = entries(),
      commands: string[] = [],
      verified: string[] = []
    try {
      const run: NativeCommand = async (command, args, settings) => {
        commands.push(command + " " + args[0])
        if (command === "gh" && args[0] === "api")
          return { code: 0, stdout: JSON.stringify([{ artifacts: [artifact(name)] }]), stderr: "" }
        if (command === "gh")
          await writeFile(path.join(args[args.indexOf("--dir") + 1]!, "computer-overlay-smoke-darwin.tar"), tar(values))
        if (command === "tar") {
          expect(args[0]).toBe("-xpf")
          expect(settings.env.TAR_OPTIONS).toBeUndefined()
          await materialize(args[args.indexOf("-C") + 1]!, values)
        }
        return { code: 0, stdout: "", stderr: "" }
      }
      const result = await restoreComputerOverlayArtifact(
        { platform: "darwin", suffix: sha, destination, required: true },
        {
          environment: { ...environment(root), TAR_OPTIONS: "unsafe inherited options" },
          run,
          architecture: "x64",
          verify: async (file) => {
            verified.push(file)
          },
        },
      )
      expect(result.artifacts).toEqual([{ name, id: "1", digest: artifactDigest }])
      expect(result.restored).toBe(true)
      expect(verified).toHaveLength(2)
      expect(verified[0]).not.toBe(destination)
      expect(verified[1]).toBe(destination)
      expect(commands).toEqual(["gh api", "gh run", "gh api", "tar -xpf"])
      expect(await readFile(path.join(destination, COMPUTER_OVERLAY_STAGE_MANIFEST), "utf8")).toBe(
        values[0]!.content as string,
      )
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
  test("changed immutable identity is rejected before extraction", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "vector-overlay-changed-test-")),
      name = computerOverlayArtifactName("darwin", sha)
    let listings = 0,
      extracted = false
    try {
      const run: NativeCommand = async (command, args) => {
        if (command === "gh" && args[0] === "api")
          return { code: 0, stdout: JSON.stringify([{ artifacts: [artifact(name, ++listings)] }]), stderr: "" }
        if (command === "gh")
          await writeFile(
            path.join(args[args.indexOf("--dir") + 1]!, "computer-overlay-smoke-darwin.tar"),
            tar(entries()),
          )
        if (command === "tar") extracted = true
        return { code: 0, stdout: "", stderr: "" }
      }
      await expect(
        restoreComputerOverlayArtifact(
          { platform: "darwin", suffix: sha, destination: path.join(root, "stage") },
          { environment: environment(root), run },
        ),
      ).rejects.toThrow("identity changed")
      expect(extracted).toBe(false)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
  test("failed source proof never populates the requested destination", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "vector-overlay-proof-test-")),
      destination = path.join(root, "stage"),
      name = computerOverlayArtifactName("darwin", sha),
      values = entries()
    try {
      const run: NativeCommand = async (command, args) => {
        if (command === "gh" && args[0] === "api")
          return { code: 0, stdout: JSON.stringify([{ artifacts: [artifact(name)] }]), stderr: "" }
        if (command === "gh")
          await writeFile(path.join(args[args.indexOf("--dir") + 1]!, "computer-overlay-smoke-darwin.tar"), tar(values))
        if (command === "tar") await materialize(args[args.indexOf("-C") + 1]!, values)
        return { code: 0, stdout: "", stderr: "" }
      }
      await expect(
        restoreComputerOverlayArtifact(
          { platform: "darwin", suffix: sha, destination },
          {
            environment: environment(root),
            run,
            verify: async () => {
              throw new Error("fixture source mismatch")
            },
          },
        ),
      ).rejects.toThrow("source mismatch")
      expect(await lstat(destination).catch(() => undefined)).toBeUndefined()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
  test("archive creation checks exact stage bytes and creates only a new output", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "vector-overlay-archive-test-")),
      source = path.join(root, "stage"),
      output = path.join(root, "computer-overlay-smoke-darwin.tar"),
      values = entries()
    let proofs = 0
    try {
      await materialize(source, values)
      const run: NativeCommand = async (command, args, settings) => {
        expect(command).toBe("tar")
        expect(args).toContain("--format=ustar")
        expect(settings.env.TAR_OPTIONS).toBeUndefined()
        await writeFile(args[args.indexOf("-cpf") + 1]!, tar(values))
        return { code: 0, stdout: "", stderr: "" }
      }
      const dependencies = {
        run,
        verify: async () => {
          proofs++
        },
        environment: { TAR_OPTIONS: "ignored" },
      }
      const result = await archiveComputerOverlayStage({ platform: "darwin", archive: source, output }, dependencies)
      expect(result.bytes).toBe(tar(values).length)
      expect(proofs).toBe(2)
      expect(await readFile(output)).toEqual(tar(values))
      await expect(
        archiveComputerOverlayStage({ platform: "darwin", archive: source, output }, dependencies),
      ).rejects.toThrow()
      expect(await readFile(output)).toEqual(tar(values))
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
