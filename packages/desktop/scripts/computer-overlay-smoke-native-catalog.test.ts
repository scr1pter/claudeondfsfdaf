import { expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { createManifest } from "./build-computer-helper"
import { verifyComputerSmokeNativeCatalog } from "./computer-overlay-smoke-native-catalog"

declare const Bun: {
  build(input: {
    entrypoints: string[]
    outdir: string
    naming: string
    target: "node"
    format: "esm"
  }): Promise<{ success: boolean; outputs: { path: string }[] }>
}
const expected = {
  platform: "darwin" as const,
  architecture: "arm64",
  helperVersion: "1.0.14",
  sourceDigest: "a".repeat(64),
  protocol: { min: 1, max: 1 },
}
const driver = "resources/computer/VectorComputerOverlayDriver.app/Contents/MacOS/VectorComputerOverlayDriver"
const fake = "smoke/computer-fake-helper.mjs"
async function fixture() {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "vector-native-catalog-")))
  const names = [
    driver,
    "smoke/computer-overlay-smoke-electron.mjs",
    "smoke/computer-overlay-smoke-preload.cjs",
    fake,
    "electron/Electron.app/Contents/Resources/default_app.asar",
  ]
  const files: Record<string, { sha256: string; arch: "arm64"[] }> = {}
  for (const name of names) {
    await mkdir(path.dirname(path.join(root, name)), { recursive: true })
    const bytes = Buffer.from("sealed fixture " + name)
    await writeFile(path.join(root, name), bytes)
    files[name] = { sha256: createHash("sha256").update(bytes).digest("hex"), arch: ["arm64"] }
  }
  const manifest = createManifest({
    helperVersion: expected.helperVersion,
    protocol: expected.protocol,
    platform: "darwin",
    sourceDigest: expected.sourceDigest,
    toolchain: "fixture",
    files,
  })
  const save = () => writeFile(path.join(root, "computer-overlay-smoke.json"), JSON.stringify(manifest))
  await save()
  return { root, manifest, save, close: () => rm(root, { recursive: true, force: true }) }
}

test("native catalog admission keeps builder schema, exact identity guards and absent-manifest semantics", async () => {
  const f = await fixture()
  try {
    expect(await verifyComputerSmokeNativeCatalog(f.root, expected)).toBe(path.join(f.root, driver))
    for (const [patch, cause] of [
      [{ platform: "win32" }, "identity_platform"],
      [{ helperVersion: "1.0.13" }, "identity_version"],
      [{ sourceDigest: "b".repeat(64) }, "identity_source"],
      [{ protocol: { min: 1, max: 2 } }, "identity_protocol"],
      [{ files: null }, "catalog_shape"],
    ] as const) {
      await writeFile(path.join(f.root, "computer-overlay-smoke.json"), JSON.stringify({ ...f.manifest, ...patch }))
      await expect(verifyComputerSmokeNativeCatalog(f.root, expected)).rejects.toMatchObject({
        diagnostic: { phase: "artifact", cause, architecture: "arm64" },
      })
    }
    await writeFile(path.join(f.root, "computer-overlay-smoke.json"), " ".repeat(1024 * 1024 + 1))
    await expect(verifyComputerSmokeNativeCatalog(f.root, expected)).rejects.toMatchObject({
      diagnostic: { cause: "manifest_size" },
    })
    await expect(verifyComputerSmokeNativeCatalog(path.join(f.root, "missing"), expected)).rejects.toMatchObject({
      diagnostic: { cause: "artifact_root_io" },
    })
    await writeFile(path.join(f.root, "computer-overlay-smoke.json"), "{")
    await expect(verifyComputerSmokeNativeCatalog(f.root, expected)).rejects.toMatchObject({
      diagnostic: { cause: "manifest_json" },
    })
    await rm(path.join(f.root, "computer-overlay-smoke.json"))
    expect(await verifyComputerSmokeNativeCatalog(f.root, expected)).toBeUndefined()
    await mkdir(path.join(f.root, "computer-overlay-smoke.json"))
    await expect(verifyComputerSmokeNativeCatalog(f.root, expected)).rejects.toMatchObject({
      diagnostic: { cause: "manifest_type" },
    })
  } finally {
    await f.close()
  }
})

test("native catalog failures expose only fixed roles and ordinals while rejecting file/path/hash changes", async () => {
  const f = await fixture()
  try {
    const original = structuredClone(f.manifest.files)
    for (const [entry, cause] of [
      [{ ...original[fake]!, sha256: "PRIVATE" }, "catalog_sha"],
      [{ ...original[fake]!, arch: ["x64"] }, "catalog_arch"],
    ] as const) {
      await writeFile(
        path.join(f.root, "computer-overlay-smoke.json"),
        JSON.stringify({ ...f.manifest, files: { ...original, [fake]: entry } }),
      )
      await expect(verifyComputerSmokeNativeCatalog(f.root, expected)).rejects.toMatchObject({
        diagnostic: { cause, role: "fake", architecture: "arm64" },
      })
    }
    await writeFile(
      path.join(f.root, "computer-overlay-smoke.json"),
      JSON.stringify({ ...f.manifest, files: { "../PRIVATE": original[fake] } }),
    )
    await expect(verifyComputerSmokeNativeCatalog(f.root, expected)).rejects.toMatchObject({
      diagnostic: { cause: "catalog_path", role: "resource", ordinal: 0 },
    })
    const missing = { ...original }
    delete missing[fake]
    await writeFile(path.join(f.root, "computer-overlay-smoke.json"), JSON.stringify({ ...f.manifest, files: missing }))
    await expect(verifyComputerSmokeNativeCatalog(f.root, expected)).rejects.toMatchObject({
      diagnostic: { cause: "mandatory_file", role: "fake" },
    })
    await f.save()
    await writeFile(path.join(f.root, fake), "changed fixture")
    await expect(verifyComputerSmokeNativeCatalog(f.root, expected)).rejects.toMatchObject({
      diagnostic: { cause: "file_hash", role: "fake" },
    })
    await writeFile(path.join(f.root, fake), "")
    await expect(verifyComputerSmokeNativeCatalog(f.root, expected)).rejects.toMatchObject({
      diagnostic: { cause: "file_size", role: "fake" },
    })
    await rm(path.join(f.root, fake))
    await expect(verifyComputerSmokeNativeCatalog(f.root, expected)).rejects.toMatchObject({
      diagnostic: { cause: "file_io", role: "fake" },
    })
    await mkdir(path.join(f.root, fake))
    await expect(verifyComputerSmokeNativeCatalog(f.root, expected)).rejects.toMatchObject({
      diagnostic: { cause: "file_kind", role: "fake" },
    })
  } finally {
    await f.close()
  }
})

test("an explicit physical filesystem admits complete ASAR bytes while a virtual archive-root view still fails closed", async () => {
  const f = await fixture()
  try {
    const archive = path.join(f.root, "electron/Electron.app/Contents/Resources/default_app.asar")
    const virtual = { lstat: async (file: string) => lstat(file === archive ? f.root : file), readFile, realpath }
    await expect(verifyComputerSmokeNativeCatalog(f.root, expected, virtual)).rejects.toMatchObject({
      diagnostic: { cause: "file_kind", role: "runtime" },
    })
    expect(await verifyComputerSmokeNativeCatalog(f.root, expected, { lstat, readFile, realpath })).toBe(
      path.join(f.root, driver),
    )
    await writeFile(archive, "changed physical archive bytes")
    await expect(
      verifyComputerSmokeNativeCatalog(f.root, expected, { lstat, readFile, realpath }),
    ).rejects.toMatchObject({ diagnostic: { cause: "file_hash", role: "runtime" } })
  } finally {
    await f.close()
  }
})

test("actual Node imports the compiled catalog without Electron and enforces its same byte checks", async () => {
  const f = await fixture()
  const output = await mkdtemp(path.join(tmpdir(), "vector-native-catalog-node-"))
  try {
    const built = await Bun.build({
      entrypoints: [fileURLToPath(new URL("./computer-overlay-smoke-native-catalog.ts", import.meta.url))],
      outdir: output,
      naming: "catalog.mjs",
      target: "node",
      format: "esm",
    })
    expect(built.success).toBe(true)
    expect(built.outputs).toHaveLength(1)
    const run = () =>
      spawnSync(
        "node",
        [
          "--input-type=module",
          "--eval",
          `const catalog = await import(process.argv[1]); const files = await import("node:fs/promises"); try { const driver = await catalog.verifyComputerSmokeNativeCatalog(process.argv[2], JSON.parse(process.argv[3]), files); console.log(JSON.stringify({driver,bun:typeof Bun})); } catch(error) { console.log(JSON.stringify({diagnostic:error.diagnostic,bun:typeof Bun})); process.exitCode=1; }`,
          pathToFileURL(built.outputs[0]!.path).href,
          f.root,
          JSON.stringify(expected),
        ],
        { encoding: "utf8", timeout: 10_000 },
      )
    const accepted = run()
    expect(accepted.error).toBeUndefined()
    expect(accepted.status, accepted.stderr).toBe(0)
    expect(JSON.parse(accepted.stdout)).toEqual({ driver: path.join(f.root, driver), bun: "undefined" })
    await writeFile(path.join(f.root, fake), "changed fixture")
    const rejected = run()
    expect(rejected.status, rejected.stderr).toBe(1)
    const fact = JSON.parse(rejected.stdout)
    expect(fact.bun).toBe("undefined")
    expect(fact.diagnostic).toMatchObject({
      phase: "artifact",
      cause: "file_hash",
      role: "fake",
      architecture: "arm64",
    })
    expect(Object.keys(fact.diagnostic).sort()).toEqual(["architecture", "cause", "ordinal", "phase", "role"])
    expect(rejected.stdout).not.toContain(f.root)
    expect(rejected.stdout).not.toContain("changed fixture")
  } finally {
    await f.close()
    await rm(output, { recursive: true, force: true })
  }
}, 30_000)
