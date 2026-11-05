import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import {
  COMPUTER_OVERLAY_ENTRYPOINTS,
  computerOverlayModuleReferences,
  computerOverlaySourceDigest,
  computerOverlaySourceGraph,
  verifyComputerOverlayBundleGraph,
} from "./computer-overlay-smoke-source"
const temporary: string[] = []
afterEach(async () => {
  for (const root of temporary.splice(0)) await rm(root, { recursive: true, force: true })
})
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "vector-overlay-source-test-"))
  temporary.push(root)
  const desktop = path.join(root, "packages/desktop")
  for (const file of [
    "package.json",
    "bun.lock",
    "packages/desktop/package.json",
    "packages/desktop/tsconfig.json",
    ...COMPUTER_OVERLAY_ENTRYPOINTS.map((entry) => `packages/desktop/${entry.input}`),
    "packages/desktop/src/main/dependency.ts",
  ]) {
    await mkdir(path.dirname(path.join(root, file)), { recursive: true })
    await writeFile(
      path.join(root, file),
      file === "package.json"
        ? JSON.stringify({ packageManager: "bun@1.3.14" })
        : file.endsWith(".json")
          ? "{}"
          : file.endsWith("computer-overlay-smoke-electron.ts")
            ? 'import "../src/main/dependency"\n'
            : "export const fixture = 1\n",
    )
  }
  return {
    root,
    desktop,
    entry: path.join(desktop, COMPUTER_OVERLAY_ENTRYPOINTS[0].input),
    dependency: path.join(desktop, "src/main/dependency.ts"),
  }
}
describe("independent overlay source admission", () => {
  test("a local assertion named require never invents a dependency from a string expression", () => {
    const references = computerOverlayModuleReferences(
      "/fixture/entry.ts",
      `
      import { value } from "./real-dependency"
      function require(value: unknown): asserts value { if (!value) throw new Error("assertion") }
      const result = { lease: 1 }
      require("lease" in result)
      require(value)
    `,
    )
    expect(references).toEqual(["./real-dependency"])
  })
  test("lexical require shadows apply only inside their actual scope", () => {
    const references = computerOverlayModuleReferences(
      "/fixture/entry.ts",
      `
      const outside = require("./outer-dependency")
      function check(result: object) {
        function require(value: unknown): asserts value { if (!value) throw new Error("assertion") }
        require("lease" in result)
      }
      const again = require.resolve("./resolved-dependency")
    `,
    )
    expect(references).toEqual(["./outer-dependency", "./resolved-dependency"])
  })
  test("real Node module loaders require one literal import and cannot hide runtime-selected modules", () => {
    const references = computerOverlayModuleReferences(
      "/fixture/entry.ts",
      `
      import { createRequire } from "node:module"
      const load = createRequire(import.meta.url)
      const loaded = load("./actual-dependency")
      export * from "./exported-dependency"
      type Shape = import("./type-dependency").Shape
    `,
    )
    expect(references).toEqual(["node:module", "./actual-dependency", "./exported-dependency", "./type-dependency"])
    for (const source of [
      'const name = "./dependency"; require(name)',
      'const result = {}; require("lease" in result)',
      'const name = "./dependency"; require.resolve(name)',
      'const name = "./dependency"; module.require(name)',
      'import { createRequire } from "node:module"; const load = createRequire(import.meta.url); load(name)',
      'const name = "./dependency"; import(name)',
    ])
      expect(() => computerOverlayModuleReferences("/fixture/entry.ts", source)).toThrow("unbounded runtime import")
  })

  test("admits the actual production overlay, native smoke and fake helper workspace graph", async () => {
    const graph = await computerOverlaySourceGraph(fileURLToPath(new URL("../", import.meta.url)))
    expect(graph.entries.map((entry) => entry.path)).toContain("packages/desktop/src/main/computer-overlay.ts")
    expect(graph.entries.map((entry) => entry.path)).toContain("packages/desktop/test/computer/fake-helper.ts")
  })
  test("resolves transitive actual workspace source and compiler/package inputs without a supplied file list", async () => {
    const value = await fixture(),
      graph = await computerOverlaySourceGraph(value.desktop)
    expect(graph.entries.map((entry) => entry.path)).toContain("packages/desktop/src/main/dependency.ts")
    expect(graph.entries.map((entry) => entry.path)).toContain("bun.lock")
    expect(graph.bunVersion).toBe("1.3.14")
    expect(new Set(graph.entries.map((entry) => entry.path)).size).toBe(graph.entries.length)
  })
  test("admits only the explicit Electron original-fs builtin while preserving its source and compiler binding", async () => {
    const value = await fixture()
    await writeFile(value.dependency, 'import originalFs from "original-fs"; export const raw = originalFs.promises\n')
    const graph = await computerOverlaySourceGraph(value.desktop)
    const consumed = graph.entries.find((entry) => entry.path === "packages/desktop/src/main/dependency.ts")!
    expect(Buffer.from(consumed.bytes).toString("utf8")).toContain('from "original-fs"')
    const built = await Bun.build({
      entrypoints: [value.entry],
      target: "node",
      format: "esm",
      outdir: path.join(value.root, "out"),
      naming: "main.mjs",
      metafile: true,
      external: ["electron", "original-fs"],
      allowUnresolved: ["original-fs"],
    })
    expect(built.success).toBe(true)
    await verifyComputerOverlayBundleGraph(built.metafile, value.desktop, graph, COMPUTER_OVERLAY_ENTRYPOINTS[0].input)
    await writeFile(value.dependency, 'import "unadmitted-electron-builtin"\n')
    await expect(computerOverlaySourceGraph(value.desktop)).rejects.toThrow("unresolved import")
  })
  test("a transitive source change or native C2 digest changes dedicated overlay authority", async () => {
    const value = await fixture(),
      before = await computerOverlaySourceGraph(value.desktop)
    await writeFile(value.dependency, "export const fixture = 2\n")
    const after = await computerOverlaySourceGraph(value.desktop)
    expect(computerOverlaySourceDigest("a".repeat(64), before)).not.toBe(
      computerOverlaySourceDigest("a".repeat(64), after),
    )
    expect(computerOverlaySourceDigest("b".repeat(64), before)).not.toBe(
      computerOverlaySourceDigest("a".repeat(64), before),
    )
    expect(computerOverlaySourceDigest("a".repeat(64), { ...before, entries: before.entries.toReversed() })).toBe(
      computerOverlaySourceDigest("a".repeat(64), before),
    )
  })
  test("rejects unresolved and runtime-selected imports instead of trusting an incomplete graph", async () => {
    const value = await fixture()
    for (const source of ['import "./missing"', 'const name = "./dependency"; void import(name)']) {
      await writeFile(value.entry, source)
      await expect(computerOverlaySourceGraph(value.desktop)).rejects.toThrow()
    }
  })
  test("requires an exact repository Bun compiler pin", async () => {
    const value = await fixture()
    for (const packageManager of ["bun@latest", "bun@^1.3.14", "node@24", undefined]) {
      await writeFile(path.join(value.root, "package.json"), JSON.stringify({ packageManager }))
      await expect(computerOverlaySourceGraph(value.desktop)).rejects.toThrow("exactly pinned")
    }
  })
  test("the pinned Bun compiler produces admissible real input metadata", async () => {
    const value = await fixture()
    const graph = await computerOverlaySourceGraph(value.desktop)
    const result = await Bun.build({
      entrypoints: [value.entry],
      target: "node",
      format: "esm",
      outdir: path.join(value.root, "out"),
      naming: "main.mjs",
      metafile: true,
      allowUnresolved: [],
    })
    expect(result.success).toBe(true)
    expect(result.outputs).toHaveLength(1)
    await verifyComputerOverlayBundleGraph(result.metafile, value.desktop, graph, COMPUTER_OVERLAY_ENTRYPOINTS[0].input)
  })
  test("actual compiler workspace metadata must match independently admitted bytes", async () => {
    const value = await fixture(),
      graph = await computerOverlaySourceGraph(value.desktop)
    const metadata = { inputs: { [value.entry]: { bytes: (await readFile(value.entry)).length, imports: [] } } }
    await verifyComputerOverlayBundleGraph(metadata, value.desktop, graph)
    await writeFile(value.entry, "export const altered = true")
    await expect(verifyComputerOverlayBundleGraph(metadata, value.desktop, graph)).rejects.toThrow("admitted graph")
  })
  test("compiler input lists cannot add an unadmitted workspace file or omit bounded metadata", async () => {
    const value = await fixture(),
      graph = await computerOverlaySourceGraph(value.desktop),
      unadmitted = path.join(value.desktop, "unadmitted.ts")
    await writeFile(unadmitted, "export const hidden = true")
    await expect(
      verifyComputerOverlayBundleGraph({ inputs: { [unadmitted]: { bytes: 25, imports: [] } } }, value.desktop, graph),
    ).rejects.toThrow("admitted graph")
    for (const metadata of [undefined, {}, { inputs: {} }, { inputs: { [value.entry]: { bytes: -1, imports: [] } } }])
      await expect(verifyComputerOverlayBundleGraph(metadata, value.desktop, graph)).rejects.toThrow()
  })
  test("digest inputs are ordered, unique, relative and measured", async () => {
    const graph = {
      entries: [{ path: "source.ts", bytes: Buffer.from("source") }],
      bunVersion: "1.3.14",
      resolverVersion: "5.6.2",
    }
    expect(computerOverlaySourceDigest("a".repeat(64), graph)).toMatch(/^[a-f0-9]{64}$/)
    for (const changed of [
      { ...graph, entries: [...graph.entries, ...graph.entries] },
      { ...graph, entries: [{ ...graph.entries[0]!, path: "../escape" }] },
      { ...graph, bunVersion: "latest" },
      { ...graph, entries: [] },
    ])
      expect(() => computerOverlaySourceDigest("a".repeat(64), changed)).toThrow()
    expect(() => computerOverlaySourceDigest("unmeasured", graph)).toThrow()
  })
})
