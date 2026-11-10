import { describe, test, expect } from "bun:test"
import { ConfigV1 } from "@vectordevai/core/v1/config/config"
import { LayerNode } from "@vectordevai/core/effect/layer-node"
import { filesystem } from "@vectordevai/core/effect/app-node-platform"
import { FSUtil } from "@vectordevai/core/fs-util"
import { Effect, FileSystem } from "effect"
import { Truncate } from "@/tool/truncate"
import { WebFence } from "@vectordevai/core/research/fence"
import { Config } from "@/config/config"
import { Identifier } from "../../src/id/id"
import { Process } from "@/util/process"
import path from "path"
import { utimes } from "node:fs/promises"
import { testEffect } from "../lib/effect"
import { writeFileStringScoped } from "../lib/filesystem"
import { TestConfig } from "../fixture/config"

const FIXTURES_DIR = path.join(import.meta.dir, "fixtures")
const ROOT = path.resolve(import.meta.dir, "..", "..")

const it = testEffect(LayerNode.compile(LayerNode.group([Truncate.node, FSUtil.node, filesystem])))

const configuredLayer = (cfg: ConfigV1.Info) =>
  LayerNode.compile(LayerNode.group([Truncate.node, FSUtil.node, filesystem, Config.node]), [
    [Config.node, TestConfig.layer({ get: () => Effect.succeed(cfg) })],
  ])
const configuredIt = (cfg: ConfigV1.Info) => testEffect(configuredLayer(cfg))

describe("Truncate", () => {
  describe("output", () => {
    it.live("truncates large json file by bytes", () =>
      Effect.gen(function* () {
        const svc = yield* Truncate.Service
        const fsys = yield* FSUtil.Service
        const content = yield* fsys.readFileString(path.join(FIXTURES_DIR, "models-api.json"))
        const result = yield* svc.output(content)

        expect(result.truncated).toBe(true)
        expect(result.content).toContain("truncated...")
        if (result.truncated) expect(result.outputPath).toBeDefined()
      }),
    )

    it.live("returns content unchanged when under limits", () =>
      Effect.gen(function* () {
        const svc = yield* Truncate.Service
        const content = "line1\nline2\nline3"
        const result = yield* svc.output(content)

        expect(result.truncated).toBe(false)
        expect(result.content).toBe(content)
      }),
    )

    it.live("truncates by line count", () =>
      Effect.gen(function* () {
        const svc = yield* Truncate.Service
        const lines = Array.from({ length: 100 }, (_, i) => `line${i}`).join("\n")
        const result = yield* svc.output(lines, { maxLines: 10 })

        expect(result.truncated).toBe(true)
        expect(result.content).toContain("...90 lines truncated...")
      }),
    )

    it.live("truncates by byte count", () =>
      Effect.gen(function* () {
        const svc = yield* Truncate.Service
        const content = "a".repeat(1000)
        const result = yield* svc.output(content, { maxBytes: 100 })

        expect(result.truncated).toBe(true)
        expect(result.content).toContain("truncated...")
      }),
    )

    it.live("a single line longer than the budget still shows its start, or its end from the tail", () =>
      Effect.gen(function* () {
        const svc = yield* Truncate.Service
        const line = `start ${"é".repeat(5_000)} end`
        const head = yield* svc.output(line, { maxBytes: 101 })
        expect(head.content.startsWith("start éé")).toBe(true)
        expect(head.content).not.toContain("\uFFFD")
        const tail = yield* svc.output(line, { maxBytes: 101, direction: "tail" })
        expect(tail.content.endsWith("éé end")).toBe(true)
        expect(tail.content).not.toContain("\uFFFD")
      }),
    )

    it.live("saves what it is given to save, and names a saved web page so Grep and Read fence it", () =>
      Effect.gen(function* () {
        const svc = yield* Truncate.Service
        const page = "heat pump ".repeat(200)
        const fenced = WebFence.fenceWebPage({ url: "https://e.example/", tool: "webfetch" }, page)
        const web = yield* svc.output(page, { maxBytes: 100, save: () => fenced })
        if (!web.truncated) throw new Error("expected a truncated page")
        expect(web.outputPath).toEndWith(".web")
        expect(WebFence.savedFile(web.outputPath)).toBe(true)
        expect(yield* Effect.promise(() => Bun.file(web.outputPath).text())).toBe(fenced)
        // Output that is not web text keeps its plain name, and a short page is never built or saved.
        const shell = yield* svc.output("x".repeat(1000), { maxBytes: 100 })
        if (!shell.truncated) throw new Error("expected truncated output")
        expect(WebFence.savedFile(shell.outputPath)).toBe(false)
        const built: string[] = []
        const short = yield* svc.output("short", {
          save: () => {
            built.push("built")
            return fenced
          },
        })
        expect({ truncated: short.truncated, built }).toEqual({ truncated: false, built: [] })
      }),
    )

    it.live("truncates from head by default", () =>
      Effect.gen(function* () {
        const svc = yield* Truncate.Service
        const lines = Array.from({ length: 10 }, (_, i) => `line${i}`).join("\n")
        const result = yield* svc.output(lines, { maxLines: 3 })

        expect(result.truncated).toBe(true)
        expect(result.content).toContain("line0")
        expect(result.content).toContain("line1")
        expect(result.content).toContain("line2")
        expect(result.content).not.toContain("line9")
      }),
    )

    it.live("truncates from tail when direction is tail", () =>
      Effect.gen(function* () {
        const svc = yield* Truncate.Service
        const lines = Array.from({ length: 10 }, (_, i) => `line${i}`).join("\n")
        const result = yield* svc.output(lines, { maxLines: 3, direction: "tail" })

        expect(result.truncated).toBe(true)
        expect(result.content).toContain("line7")
        expect(result.content).toContain("line8")
        expect(result.content).toContain("line9")
        expect(result.content).not.toContain("line0")
      }),
    )

    test("uses default MAX_LINES and MAX_BYTES", () => {
      expect(Truncate.MAX_LINES).toBe(2000)
      expect(Truncate.MAX_BYTES).toBe(50 * 1024)
    })

    it.live("limits() falls back to MAX_LINES/MAX_BYTES when Config is not provided", () =>
      Effect.gen(function* () {
        const svc = yield* Truncate.Service
        const resolved = yield* svc.limits()
        expect(resolved.maxLines).toBe(Truncate.MAX_LINES)
        expect(resolved.maxBytes).toBe(Truncate.MAX_BYTES)
      }),
    )

    describe("with tool_output config", () => {
      const limitsIt = configuredIt({ tool_output: { max_lines: 123, max_bytes: 456 } })
      limitsIt.live("limits() reflects config overrides", () =>
        Effect.gen(function* () {
          const resolved = yield* (yield* Truncate.Service).limits()
          expect(resolved.maxLines).toBe(123)
          expect(resolved.maxBytes).toBe(456)
        }),
      )

      // Huge byte budget isolates line truncation. 100 lines against max_lines: 10
      // proves the configured line limit is what `output()` enforces.
      const lineIt = configuredIt({ tool_output: { max_lines: 10, max_bytes: 1024 * 1024 } })
      lineIt.live("output() truncates to configured max_lines", () =>
        Effect.gen(function* () {
          const content = Array.from({ length: 100 }, (_, i) => `line${i}`).join("\n")
          const result = yield* (yield* Truncate.Service).output(content)
          expect(result.truncated).toBe(true)
          expect(result.content).toContain("...90 lines truncated...")
        }),
      )

      // Huge line budget isolates byte truncation.
      const byteIt = configuredIt({ tool_output: { max_lines: 1_000_000, max_bytes: 100 } })
      byteIt.live("output() truncates to configured max_bytes", () =>
        Effect.gen(function* () {
          const content = "a".repeat(1000)
          const result = yield* (yield* Truncate.Service).output(content)
          expect(result.truncated).toBe(true)
          expect(result.content).toContain("bytes truncated...")
        }),
      )

      const overrideIt = configuredIt({ tool_output: { max_lines: 10, max_bytes: 100 } })
      overrideIt.live("per-call options still override config", () =>
        Effect.gen(function* () {
          const content = Array.from({ length: 50 }, (_, i) => `line${i}`).join("\n")
          const result = yield* (yield* Truncate.Service).output(content, {
            maxLines: 1000,
            maxBytes: 1024 * 1024,
          })
          expect(result.truncated).toBe(false)
        }),
      )
    })

    it.live("large single-line file truncates with byte message", () =>
      Effect.gen(function* () {
        const svc = yield* Truncate.Service
        const fsys = yield* FSUtil.Service
        const content = yield* fsys.readFileString(path.join(FIXTURES_DIR, "models-api.json"))
        const result = yield* svc.output(content)

        expect(result.truncated).toBe(true)
        expect(result.content).toContain("bytes truncated...")
        expect(Buffer.byteLength(content, "utf-8")).toBeGreaterThan(Truncate.MAX_BYTES)
      }),
    )

    it.live("writes full output to file when truncated", () =>
      Effect.gen(function* () {
        const svc = yield* Truncate.Service
        const lines = Array.from({ length: 100 }, (_, i) => `line${i}`).join("\n")
        const result = yield* svc.output(lines, { maxLines: 10 })

        expect(result.truncated).toBe(true)
        expect(result.content).toContain("The tool call succeeded but the output was truncated")
        expect(result.content).toContain("Grep")
        if (!result.truncated) throw new Error("expected truncated")
        expect(result.outputPath).toBeDefined()
        expect(result.outputPath).toContain("tool_")

        const fsys = yield* FSUtil.Service
        const written = yield* fsys.readFileString(result.outputPath!)
        expect(written).toBe(lines)
      }),
    )

    it.live("points at Grep and ranged Read, not a subagent, even when the agent may launch one", () =>
      Effect.gen(function* () {
        const svc = yield* Truncate.Service
        const lines = Array.from({ length: 100 }, (_, i) => `line${i}`).join("\n")
        const agent = { permission: [{ permission: "task", pattern: "*", action: "allow" as const }] }
        const result = yield* svc.output(lines, { maxLines: 10 }, agent as any)

        expect(result.truncated).toBe(true)
        expect(result.content).toContain("Grep")
        // A subagent starts from an empty context, so it costs far more than searching the saved file.
        expect(result.content).not.toContain("Task tool")
      }),
    )

    it.live("omits Task tool hint when agent lacks task permission", () =>
      Effect.gen(function* () {
        const svc = yield* Truncate.Service
        const lines = Array.from({ length: 100 }, (_, i) => `line${i}`).join("\n")
        const agent = { permission: [{ permission: "task", pattern: "*", action: "deny" as const }] }
        const result = yield* svc.output(lines, { maxLines: 10 }, agent as any)

        expect(result.truncated).toBe(true)
        expect(result.content).toContain("Grep")
        expect(result.content).not.toContain("Task tool")
      }),
    )

    it.live("does not write file when not truncated", () =>
      Effect.gen(function* () {
        const svc = yield* Truncate.Service
        const content = "short content"
        const result = yield* svc.output(content)

        expect(result.truncated).toBe(false)
        if (result.truncated) throw new Error("expected not truncated")
        expect("outputPath" in result).toBe(false)
      }),
    )

    test("loads truncate effect in a fresh process", async () => {
      const out = await Process.run([process.execPath, "run", path.join(ROOT, "src", "tool", "truncate.ts")], {
        cwd: ROOT,
      })

      expect(out.code).toBe(0)
    }, 20000)
  })

  describe("cleanup", () => {
    const DAY_MS = 24 * 60 * 60 * 1000

    it.live("preserves foreign artifact filenames without aborting cleanup", () =>
      Effect.gen(function* () {
        const svc = yield* Truncate.Service
        const fs = yield* FileSystem.FileSystem
        const names = ["tool_result_fixture", "tool_", "tool_000000000000", "tool_000000000000retained-artifact"]
        yield* Effect.forEach(names, (name) => writeFileStringScoped(path.join(Truncate.DIR, name), "retained result"))
        const old = yield* writeFileStringScoped(
          path.join(Truncate.DIR, Identifier.create("tool", "ascending", Date.now() - 10 * DAY_MS)),
          "expired tool output",
        )
        const oldPage = yield* writeFileStringScoped(
          path.join(Truncate.DIR, `${Identifier.create("tool", "ascending", Date.now() - 10 * DAY_MS)}.web`),
          "expired web page",
        )
        yield* svc.cleanup()
        expect(yield* fs.exists(old)).toBe(false)
        expect(yield* fs.exists(oldPage)).toBe(false)
        for (const name of names) expect(yield* fs.exists(path.join(Truncate.DIR, name))).toBe(true)
      }),
    )

    it.live("deletes files older than 7 days and preserves recent files", () =>
      Effect.gen(function* () {
        const svc = yield* Truncate.Service
        const fs = yield* FileSystem.FileSystem

        yield* fs.makeDirectory(Truncate.DIR, { recursive: true })

        const old = path.join(Truncate.DIR, Identifier.create("tool", "ascending", Date.now() - 10 * DAY_MS))
        const recent = path.join(Truncate.DIR, Identifier.create("tool", "ascending", Date.now() - 3 * DAY_MS))

        yield* writeFileStringScoped(old, "old content")
        yield* writeFileStringScoped(recent, "recent content")
        yield* svc.cleanup()

        expect(yield* fs.exists(old)).toBe(false)
        expect(yield* fs.exists(recent)).toBe(true)
      }),
    )

    // Background command logs (5.H): `shell-<shl_ id>.log`, up to 64 MiB each.
    it.live("deletes a background command's log once its command started and last wrote over 7 days ago", () =>
      Effect.gen(function* () {
        const svc = yield* Truncate.Service
        const fs = yield* FileSystem.FileSystem
        yield* fs.makeDirectory(Truncate.DIR, { recursive: true })
        const log = (age: number) =>
          path.join(Truncate.DIR, `shell-${Identifier.create("shl", "ascending", Date.now() - age)}.log`)
        // Sets when the file was last written.
        const aged = (file: string, age: number) =>
          Effect.promise(() => utimes(file, (Date.now() - age) / 1000, (Date.now() - age) / 1000))

        const old = log(10 * DAY_MS)
        const recent = log(3 * DAY_MS)
        // A command that started long ago and wrote yesterday is still in use.
        const writing = log(10 * DAY_MS)
        // A command this process still runs keeps its log, however long it has been quiet.
        const held = log(10 * DAY_MS)
        const foreign = path.join(Truncate.DIR, "shell-notes.log")
        for (const file of [old, recent, writing, held, foreign]) yield* writeFileStringScoped(file, "output")
        yield* aged(old, 9 * DAY_MS)
        yield* aged(writing, DAY_MS)
        yield* aged(held, 9 * DAY_MS)
        yield* aged(foreign, 30 * DAY_MS)
        const release = Truncate.hold(held)

        yield* svc.cleanup()
        expect(yield* fs.exists(old)).toBe(false)
        expect(yield* fs.exists(recent)).toBe(true)
        expect(yield* fs.exists(writing)).toBe(true)
        expect(yield* fs.exists(held)).toBe(true)
        expect(yield* fs.exists(foreign)).toBe(true)

        // Once the command ends, its log ages out like any other.
        release()
        yield* svc.cleanup()
        expect(yield* fs.exists(held)).toBe(false)
      }),
    )
  })
})
