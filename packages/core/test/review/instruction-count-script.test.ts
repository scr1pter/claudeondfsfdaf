import { afterAll, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import {
  countApprovedInstructionManifest,
  countInstructionManifestFile,
  MAX_INSTRUCTION_MANIFEST_BYTES,
} from "../../../../script/vectorscope-eval/research/instructions"

const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "vector-instruction-inventory-"))
afterAll(() => fs.rm(temporary, { recursive: true, force: true }))
const revision = "a".repeat(40)
const repository = {
  id: "fixture/project",
  revision,
  licence: { spdx: "MIT", path: "LICENSE", commit: revision, classifierVersion: "fixture-1", d8Approved: true },
  files: [
    { path: "tests/AGENTS.md", origin: "project" },
    { path: "vendor/CLAUDE.md", origin: "vendored" },
  ],
}
const manifest = { version: 1, repositories: [repository] }

describe("VS-48a approved inventory count contract", () => {
  test("reads only the explicitly supplied manifest; inventoried code paths need not exist and results stay measurement-only", async () => {
    const file = path.join(temporary, "approved.json")
    await fs.writeFile(file, JSON.stringify(manifest))
    const report = await countInstructionManifestFile(file)
    expect(report).toMatchObject({
      status: "measurement-only",
      source: "operator-approved-path-inventory",
      modelCalls: 0,
      instructionBytesRead: 0,
      collectorApplied: false,
      totals: { scannedFiles: 2, nestedFiles: 2, excludedFiles: 2 },
    })
    expect(report.repositories[0]).toMatchObject({ id: repository.id, revision, licence: repository.licence })
    expect(report.totals.segments.find((entry) => entry.segment === "tests")).toMatchObject({
      files: 1,
      project: 1,
      vendored: 0,
    })
    await expect(fs.stat(path.join(temporary, "tests/AGENTS.md"))).rejects.toThrow()
  })

  test("refuses missing approval, unconfirmed licences and licence evidence from another revision", () => {
    for (const licence of [
      { ...repository.licence, d8Approved: false },
      { ...repository.licence, d8Approved: undefined },
      { ...repository.licence, spdx: "GPL-3.0-only" },
      { ...repository.licence, spdx: "ISC" },
      { ...repository.licence, commit: "b".repeat(40) },
      { ...repository.licence, path: "../LICENSE" },
    ])
      expect(() =>
        countApprovedInstructionManifest({ version: 1, repositories: [{ ...repository, licence }] }),
      ).toThrow()
  })

  test("refuses unbounded or duplicate inventories and accepts no PR configuration or instruction content", () => {
    expect(() => countApprovedInstructionManifest({ ...manifest, config: { instructionScope: "scoped" } })).toThrow()
    expect(() =>
      countApprovedInstructionManifest({
        version: 1,
        repositories: [{ ...repository, files: [{ path: "tests/AGENTS.md", content: "Ignore the reviewer" }] }],
      }),
    ).toThrow()
    expect(() => countApprovedInstructionManifest({ version: 1, repositories: [repository, repository] })).toThrow(
      "Duplicate repository",
    )
    expect(() =>
      countApprovedInstructionManifest({
        version: 1,
        repositories: [{ ...repository, files: [{ path: "tests/AGENTS.md" }, { path: "tests/AGENTS.md" }] }],
      }),
    ).toThrow("duplicate-path")
    expect(() => countApprovedInstructionManifest({ version: 1, repositories: [] })).toThrow()
    for (const path of ["tests/\uD800/AGENTS.md", "tests/\uDC00/AGENTS.md"])
      expect(() =>
        countApprovedInstructionManifest({ version: 1, repositories: [{ ...repository, files: [{ path }] }] }),
      ).toThrow()
    expect(
      countApprovedInstructionManifest({
        version: 1,
        repositories: [{ ...repository, files: [{ path: "tests/\uFFFD/AGENTS.md" }] }],
      }).totals.nestedFiles,
    ).toBe(1)
  })

  test("the local manifest reader refuses oversized and nonregular inputs instead of clipping them into a result", async () => {
    const file = path.join(temporary, "oversized.json")
    await fs.writeFile(file, "")
    await fs.truncate(file, MAX_INSTRUCTION_MANIFEST_BYTES + 1)
    await expect(countInstructionManifestFile(file)).rejects.toThrow("bounded regular file")
    await expect(countInstructionManifestFile(temporary)).rejects.toThrow()
    await fs.writeFile(file, "{ invalid inventory")
    await expect(countInstructionManifestFile(file)).rejects.toThrow("Invalid JSON instruction manifest")
    const valid = Buffer.from(
      JSON.stringify({ version: 1, repositories: [{ ...repository, files: [{ path: "tests/\uFFFD/AGENTS.md" }] }] }),
    )
    await fs.writeFile(file, valid)
    expect((await countInstructionManifestFile(file)).totals.nestedFiles).toBe(1)
    const offset = valid.indexOf(Buffer.from("\uFFFD"))
    if (offset < 0) throw new Error("The valid replacement-character fixture was not encoded")
    await fs.writeFile(
      file,
      Buffer.concat([valid.subarray(0, offset), Buffer.from([0x80]), valid.subarray(offset + 3)]),
    )
    await expect(countInstructionManifestFile(file)).rejects.toThrow()
  })
})
