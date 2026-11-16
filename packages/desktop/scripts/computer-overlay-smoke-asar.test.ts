import { expect, test } from "bun:test"
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { computerSmokeAsarCapability } from "./computer-overlay-smoke-asar"

test("the capability probe reads only the fixed own archive and reports physical versus virtual views without content", async () => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "vector-asar-capability-")))
  try {
    const archive = path.join(root, "default_app.asar")
    const bytes = Buffer.from("private test archive payload")
    await writeFile(archive, bytes)
    const physical = { lstat, readFile, realpath }
    const virtual = {
      lstat: async (file: string) => {
        expect(file).toBe(archive)
        return lstat(root)
      },
      readFile: async (file: string): Promise<Buffer> => {
        expect(file).toBe(archive)
        throw new Error("PRIVATE virtual archive error")
      },
    }
    const result = await computerSmokeAsarCapability(virtual, physical, root)
    expect(result).toEqual({
      protocol: 1,
      rawRegular: true,
      rawBounded: true,
      rawBytes: bytes.length,
      rawRead: true,
      virtualDirectory: true,
      virtualRead: false,
    })
    expect(JSON.stringify(result)).not.toContain(root)
    expect(JSON.stringify(result)).not.toContain("private")
    expect(JSON.stringify(result)).not.toContain("PRIVATE")
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("unavailable or nonregular own archive observations remain bounded metadata without changing an admission decision", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "vector-asar-capability-"))
  try {
    const physical = { lstat, readFile, realpath }
    expect(await computerSmokeAsarCapability(physical, physical, root)).toEqual({
      protocol: 1,
      rawRegular: false,
      rawBounded: false,
      rawBytes: 0,
      rawRead: false,
      virtualDirectory: false,
      virtualRead: false,
    })
    await mkdir(path.join(root, "default_app.asar"))
    const result = await computerSmokeAsarCapability(physical, physical, root)
    expect(result.rawRegular).toBe(false)
    expect(result.rawBounded).toBe(false)
    expect(result.rawRead).toBe(false)
    expect(result.rawBytes).toBe(0)
    expect(result.virtualDirectory).toBe(true)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
