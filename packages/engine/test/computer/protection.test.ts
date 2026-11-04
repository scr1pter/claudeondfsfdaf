import { afterEach, expect, test } from "bun:test"
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { ComputerProtection } from "../../src/computer/protection"

const temporary: string[] = []
afterEach(async () => {
  await Promise.all(temporary.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

async function fixture() {
  const directory = await mkdtemp(path.join(tmpdir(), "vector-computer-protection-"))
  temporary.push(directory)
  return directory
}

test("a linked configuration directory protects its canonical destination and future files", async () => {
  const directory = await fixture()
  const target = path.join(directory, "dotfiles")
  const linked = path.join(directory, "config")
  await mkdir(target)
  await symlink(target, linked, process.platform === "win32" ? "junction" : "dir")
  const result = ComputerProtection.resolveProtection({
    directory,
    home: directory,
    paths: [path.join(linked, "agent", "custom-reviewer.md")],
    instructions: [],
    directories: [linked],
  })
  expect(result.directories).toEqual([linked, target])
  expect(result.paths).toEqual([
    path.join(linked, "agent", "custom-reviewer.md"),
    path.join(target, "agent", "custom-reviewer.md"),
  ])
})

test("configured instructions outside default roots and personal memory paths are protected", async () => {
  const directory = await fixture()
  const project = path.join(directory, "project")
  const external = path.join(directory, "private", "custom-policy.txt")
  const memory = path.join(directory, "private", "custom-recall.txt")
  await mkdir(project)
  await mkdir(path.dirname(external))
  await writeFile(external, "Private instruction contents must not appear in the result")
  const result = ComputerProtection.resolveProtection({
    directory: project,
    home: directory,
    paths: [memory, external],
    instructions: [
      "../private/custom-policy.txt",
      "~/private/new-instruction.txt",
      "https://example.test/rules",
      "*.md",
    ],
    directories: [],
  })
  expect(result.paths).toContain(external)
  expect(result.paths).toContain(memory)
  expect(result.paths).toContain(path.join(directory, "private", "new-instruction.txt"))
  expect(
    result.paths.some((file) => file.includes("https:") || file.includes("*") || file.includes("Private instruction")),
  ).toBe(false)
})

test("unsafe or excessive protection metadata fails instead of silently dropping paths", async () => {
  const directory = await fixture()
  const input = { directory, home: directory, paths: [], instructions: [], directories: [] }
  expect(() => ComputerProtection.resolveProtection({ ...input, paths: ["bad\0path"] })).toThrow()
  expect(() => ComputerProtection.resolveProtection({ ...input, paths: ["x".repeat(16385)] })).toThrow()
  expect(() =>
    ComputerProtection.resolveProtection({
      ...input,
      paths: Array.from({ length: 4097 }, (_, i) => path.join(directory, String(i))),
    }),
  ).toThrow()
  const base = path.join(directory, "界".repeat(40), "界".repeat(40), "界".repeat(40))
  const paths = Array.from({ length: 1500 }, (_, i) => path.join(base, String(i)))
  // Each array is within the count, path-length and byte limits; their combined JSON exceeds 1 MiB.
  expect(Buffer.byteLength(JSON.stringify(ComputerProtection.resolveProtection({ ...input, paths })))).toBeLessThan(
    1024 * 1024,
  )
  expect(
    Buffer.byteLength(JSON.stringify(ComputerProtection.resolveProtection({ ...input, directories: paths }))),
  ).toBeLessThan(1024 * 1024)
  expect(() => ComputerProtection.resolveProtection({ ...input, paths, directories: paths })).toThrow()
})
