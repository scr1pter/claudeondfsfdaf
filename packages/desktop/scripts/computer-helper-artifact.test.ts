import { describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import {
  checkComputerHelperTar,
  computerHelperArtifactNames,
  restoreComputerHelperArtifacts,
  selectComputerHelperArtifacts,
} from "./computer-helper-artifact"
import type { NativeCommand } from "./build-computer-helper"

const sha = "a".repeat(40)
const digest = "sha256:" + "b".repeat(64)
const names = computerHelperArtifactNames("native-darwin", "v1.99.112")
const artifact = (name: string, id: number) => ({
  id,
  name,
  expired: false,
  digest,
  workflow_run: { id: 42, head_sha: sha, repository_id: 7, head_repository_id: 7 },
})
const listing = () => [{ artifacts: names.map((name, index) => artifact(name, index + 1)) }]

function tar(entries: { name: string; type?: string; mode?: number; content?: string }[]) {
  return Buffer.concat([
    ...entries.flatMap((entry) => {
      const body = Buffer.from(entry.content ?? "fixture")
      const header = Buffer.alloc(512)
      header.write(entry.name, 0, 100)
      header.write((entry.mode ?? 0o644).toString(8).padStart(7, "0") + "\0", 100)
      header.write(body.length.toString(8).padStart(11, "0") + "\0", 124)
      header.fill(32, 148, 156)
      header[156] = (entry.type ?? "0").charCodeAt(0)
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

describe("immutable native helper artifacts", () => {
  test("helper names are stable across attempts and contain only validated source/release suffixes", () => {
    expect(names).toEqual(["computer-helper-darwin-v1.99.112", "computer-helper-darwin-tests-v1.99.112"])
    expect(computerHelperArtifactNames("win32-final", "v1.99.112")).toEqual(["computer-helper-win32-final-v1.99.112"])
    for (const suffix of ["../escape", "v1.99.112\n", "", "a".repeat(129)])
      expect(() => computerHelperArtifactNames("win32-source", suffix)).toThrow()
  })

  test("selection binds exact ids/digests to the current run, commit and repository", () => {
    expect(selectComputerHelperArtifacts(listing(), names, { run: "42", sha })).toEqual(
      names.map((name, index) => ({ name, id: String(index + 1), digest })),
    )
    expect(selectComputerHelperArtifacts([{ artifacts: [] }], names, { run: "42", sha })).toEqual([])
    for (const change of [
      { expired: true },
      { digest: "invalid" },
      { workflow_run: { id: 43, head_sha: sha, repository_id: 7, head_repository_id: 7 } },
      { workflow_run: { id: 42, head_sha: "c".repeat(40), repository_id: 7, head_repository_id: 7 } },
      { workflow_run: { id: 42, head_sha: sha, repository_id: 7, head_repository_id: 8 } },
    ]) {
      const entries = listing()
      Object.assign(entries[0]!.artifacts[0]!, change)
      expect(() => selectComputerHelperArtifacts(entries, names, { run: "42", sha })).toThrow()
    }
    expect(() =>
      selectComputerHelperArtifacts([{ artifacts: [artifact(names[0]!, 1)] }], names, { run: "42", sha }),
    ).toThrow("incomplete")
    expect(() =>
      selectComputerHelperArtifacts([{ artifacts: names.map((name) => artifact(name, 1)) }], names, { run: "42", sha }),
    ).toThrow("conflicting ids")
    const single = [{ artifacts: [artifact(names[0]!, 1)] }]
    expect(
      selectComputerHelperArtifacts(single, [names[0]!], {
        run: "42",
        sha,
        expectedId: "1",
        expectedDigest: "b".repeat(64),
      }),
    ).toHaveLength(1)
    expect(() => selectComputerHelperArtifacts(single, [names[0]!], { run: "42", sha, expectedId: "2" })).toThrow(
      "id changed",
    )
  })

  test("portable tar validation refuses escaping paths, links, PAX overrides, special modes and duplicate writes", () => {
    const good = tar([{ name: "computer-helper.json" }, { name: "VectorComputer.app/Contents/MacOS/VectorComputer" }])
    expect(checkComputerHelperTar(good, "darwin-source")).toEqual([
      "computer-helper.json",
      "VectorComputer.app/Contents/MacOS/VectorComputer",
    ])
    for (const entry of [
      { name: "../escape" },
      { name: "VectorComputer.app/../../escape" },
      { name: "/etc/file" },
      { name: "VectorComputer.app/link", type: "2" },
      { name: "VectorComputer.app/pax", type: "x" },
      { name: "VectorComputer.app/setuid", mode: 0o4755 },
    ])
      expect(() => checkComputerHelperTar(tar([entry]), "darwin-source")).toThrow()
    expect(() =>
      checkComputerHelperTar(
        tar([{ name: "computer-helper.json" }, { name: "computer-helper.json" }]),
        "darwin-source",
      ),
    ).toThrow()
    good[0] ^= 1
    expect(() => checkComputerHelperTar(good, "darwin-source")).toThrow()
  })

  test("restore downloads exact same-run artifacts, rechecks identity and extracts only checked archives", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "vector-helper-restore-"))
    const commands: { command: string; args: readonly string[] }[] = []
    try {
      const run: NativeCommand = async (command, args) => {
        commands.push({ command, args })
        if (command === "gh" && args[0] === "api") return { code: 0, stdout: JSON.stringify(listing()), stderr: "" }
        if (command === "gh") {
          const directory = args[args.indexOf("--dir") + 1]!
          const tests = args[args.indexOf("--name") + 1]!.includes("-tests-")
          await writeFile(
            path.join(directory, tests ? "computer-helper-darwin-tests.tar" : "computer-helper-darwin.tar"),
            tar([{ name: tests ? "tests/VectorComputerTests" : "computer-helper.json" }]),
          )
        }
        return { code: 0, stdout: "", stderr: "" }
      }
      const result = await restoreComputerHelperArtifacts(
        { mode: "native-darwin", suffix: "v1.99.112", destination: path.join(root, "output"), required: true },
        {
          run,
          environment: { GITHUB_REPOSITORY: "fixture/repo", GITHUB_RUN_ID: "42", GITHUB_SHA: sha, RUNNER_TEMP: root },
        },
      )
      expect(result.restored).toBe(true)
      expect(
        commands.filter((item) => item.command === "gh" && item.args[0] === "run").map((item) => item.args.slice(0, 3)),
      ).toEqual([
        ["run", "download", "42"],
        ["run", "download", "42"],
      ])
      expect(commands.filter((item) => item.command === "tar").every((item) => item.args[0] === "-xpf")).toBe(true)
      expect(commands.filter((item) => item.command === "tar")).toHaveLength(2)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("missing required artifacts fail without downloads or extraction", async () => {
    const run: NativeCommand = async () => ({ code: 0, stdout: JSON.stringify([{ artifacts: [] }]), stderr: "" })
    const environment = { GITHUB_REPOSITORY: "fixture/repo", GITHUB_RUN_ID: "42", GITHUB_SHA: sha }
    await expect(
      restoreComputerHelperArtifacts(
        { mode: "darwin-source", suffix: "v1.99.112", destination: "/unused", required: true },
        { run, environment },
      ),
    ).rejects.toThrow("required immutable")
    expect(
      (
        await restoreComputerHelperArtifacts(
          { mode: "darwin-source", suffix: "v1.99.112", destination: "/unused" },
          { run, environment },
        )
      ).restored,
    ).toBe(false)
  })
})
