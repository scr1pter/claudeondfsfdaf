import { expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { readFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import {
  encodeLinuxIsolationAsset,
  linuxIsolationBuildPlugin,
  linuxIsolationCIMode,
  linuxIsolationDefines,
} from "./linux-isolation-asset"

test("the build literal preserves exact UTF-8, CRLF and quoting with the digest of those bytes", () => {
  const bytes = Buffer.from('# fixture: café\r\nprint("quoted \\\" text")\r\n')
  const asset = JSON.parse(encodeLinuxIsolationAsset(bytes))
  expect(asset).toEqual({
    v: 1,
    entry: bytes.toString("utf8"),
    sha256: createHash("sha256").update(bytes).digest("hex"),
  })
  expect(Buffer.from(asset.entry, "utf8")).toEqual(bytes)
  const changed = JSON.parse(encodeLinuxIsolationAsset(Buffer.from(bytes.toString("utf8").replaceAll("\r\n", "\n"))))
  expect(changed.sha256).not.toBe(asset.sha256)
})

test("invalid or oversized source and transport bytes fail the build instead of changing the installed code", () => {
  for (const bytes of [
    Buffer.alloc(0),
    Buffer.alloc(131_073, 0x61),
    Buffer.from([0xc0, 0xaf]),
    Buffer.from([0xef, 0xbb, 0xbf, 0x61]),
    Buffer.from("nul\0source"),
    Buffer.alloc(131_072, 0x22),
  ])
    expect(() => encodeLinuxIsolationAsset(bytes)).toThrow()
})

test("both build targets receive the fixed source and default inactive compile-time mode", async () => {
  const node = await linuxIsolationDefines()
  const bun = await linuxIsolationDefines(false)
  expect(node).toEqual(bun)
  expect(node.VECTOR_LINUX_ISOLATION_CI).toBe("false")
  const bytes = await readFile(new URL("../packages/core/src/process-isolation/linux/entry.py", import.meta.url))
  const asset = JSON.parse(node.VECTOR_LINUX_ISOLATION_ASSET)
  expect(Buffer.from(asset.entry, "utf8")).toEqual(bytes)
  expect(asset.sha256).toBe(createHash("sha256").update(bytes).digest("hex"))
  const ci = await linuxIsolationDefines(true)
  expect(ci.VECTOR_LINUX_ISOLATION_CI).toBe("true")
  expect(ci.VECTOR_LINUX_ISOLATION_ASSET).toBe(node.VECTOR_LINUX_ISOLATION_ASSET)
})

test("CI activation requires the explicit build argument and the GitHub Actions build context", () => {
  expect(linuxIsolationCIMode([], undefined)).toBe(false)
  expect(linuxIsolationCIMode([], "true")).toBe(false)
  expect(linuxIsolationCIMode(["--isolation-ci"], "true")).toBe(true)
  for (const context of [undefined, "false", "1"])
    expect(() => linuxIsolationCIMode(["--isolation-ci"], context)).toThrow()
})

test("ambient globals cannot activate the source module or supply native bytes", async () => {
  Object.assign(globalThis, {
    VECTOR_LINUX_ISOLATION_CI: true,
    VECTOR_LINUX_ISOLATION_ASSET: { v: 1, entry: "ambient fixture", sha256: "a".repeat(64) },
  })
  try {
    const { GithubIsolationBuild } = await import("../packages/engine/src/cli/cmd/github.isolation-build")
    expect(GithubIsolationBuild.enabled).toBe(false)
    expect(GithubIsolationBuild.asset).toBeUndefined()
  } finally {
    Reflect.deleteProperty(globalThis, "VECTOR_LINUX_ISOLATION_CI")
    Reflect.deleteProperty(globalThis, "VECTOR_LINUX_ISOLATION_ASSET")
  }
})

test("the exact module replacement embeds the identical asset in actual Node and Bun bundles", async () => {
  const entrypoint = fileURLToPath(new URL("../packages/engine/src/cli/cmd/github.isolation-build.ts", import.meta.url))
  const source = await readFile(new URL("../packages/core/src/process-isolation/linux/entry.py", import.meta.url))
  const sha256 = createHash("sha256").update(source).digest("hex")
  for (const target of ["node", "bun"] as const) {
    const bundle = await Bun.build({
      entrypoints: [entrypoint],
      target,
      plugins: [await linuxIsolationBuildPlugin(true)],
      write: false,
      format: "esm",
    })
    expect(bundle.success).toBe(true)
    expect(bundle.outputs).toHaveLength(1)
    const output = await bundle.outputs[0]!.text()
    expect(output).toContain(sha256)
    expect(output).toContain("var enabled = true")
    // Inspect output only; neither the bundle nor its Python string is executed.
  }
})
