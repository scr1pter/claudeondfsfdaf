import { $ } from "bun"
import { describe, expect } from "bun:test"
import fs from "node:fs/promises"
import { symlinkSync, unlinkSync } from "node:fs"
import path from "node:path"
import { Effect, Exit, Option, Result, Schema } from "effect"
import { CrossSpawnSpawner } from "@vectordevai/core/cross-spawn-spawner"
import { AppNodeBuilder } from "@vectordevai/core/effect/app-node-builder"
import { LayerNode } from "@vectordevai/core/effect/layer-node"
import { ModelV2 } from "@vectordevai/core/model"
import { ProviderV2 } from "@vectordevai/core/provider"
import { selectFindings } from "@vectordevai/core/review/select"
import { invocationProblems } from "@vectordevai/core/review/invocation"
import { ReviewRun } from "@vectordevai/schema/review-run"
import { SessionProjector } from "@vectordevai/core/session/projector"
import type { LocalReviewDeps } from "@/cli/cmd/review"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Git } from "@/git"
import { ReviewLocalAdmission } from "@/review/local-admission"
import type { RunInput } from "@/review/run"
import { ReviewService } from "@/review/service"
import { Session } from "@/session/session"
import { TRUNCATION_DIR } from "@/tool/truncation-dir"
import { TestInstance, tmpdirScoped } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(LayerNode.compile(LayerNode.group([Git.node, CrossSpawnSpawner.node])))
const linux = process.platform === "linux" ? it.live : it.live.skip
const owner = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([Git.node, CrossSpawnSpawner.node, Session.node, SessionProjector.node, EventV2Bridge.node]),
  ),
)
const windows = process.platform === "win32" ? owner.instance : owner.instance.skip
const git = (cwd: string, ...args: string[]) =>
  Effect.promise(() => $`git ${args}`.cwd(cwd).quiet().text()).pipe(Effect.map((value) => value.trim()))

const fixture = Effect.gen(function* () {
  const directory = yield* tmpdirScoped({ git: true })
  yield* git(directory, "config", "core.autocrlf", "false")
  yield* Effect.promise(() => fs.mkdir(path.join(directory, "nested")))
  for (const file of ["private.ts", "secret-a.ts", "secret-b.ts", "visible.ts"])
    yield* Effect.promise(() => fs.writeFile(path.join(directory, file), "export const count = 1\n"))
  yield* git(directory, "add", ".")
  yield* git(directory, "commit", "-qm", "base")
  const head = yield* git(directory, "rev-parse", "HEAD")
  for (const file of ["private.ts", "secret-a.ts", "secret-b.ts", "visible.ts"])
    yield* Effect.promise(() => fs.writeFile(path.join(directory, file), "export const count = 2\n"))
  const source: ReviewLocalAdmission.Source = {
    sessionID: "ses_local_review_owner",
    directory: path.join(directory, "nested"),
    worktree: directory,
    permission: [{ permission: "*", pattern: "*", action: "allow" }],
  }
  const request: ReviewRun.Start = { requestID: "local_request_1", target: { kind: "working-tree", head } }
  return { directory, source, request }
})

function adapter() {
  const calls: RunInput[] = []
  const deps: LocalReviewDeps = {
    runReview: (input) =>
      Effect.sync(() => {
        calls.push(input)
        return {
          report: { summary: "", risk: "low", files: [], findings: [] },
          selection: selectFindings({
            findings: [],
            anchors: input.anchors,
            head: input.head,
            trust: input.trust,
            mode: input.mode,
            config: input.config,
            prior: [],
            knownPath: () => true,
          }),
          skipped: input.skipped,
          durationMs: 1,
          base: input.base,
          head: input.head,
          mode: input.mode,
          unreviewed: [],
          specialists: [{ name: "review", status: "ok", steps: 1 }],
          sessions: [],
          stats: { files: input.files.length, additions: 0, deletions: 0 },
          notes: [],
        }
      }),
    resolveModel: () =>
      Effect.succeed({
        providerID: ProviderV2.ID.make("local"),
        modelID: ModelV2.ID.make("review"),
        context: 100_000,
        costKind: "local",
      }),
    confirm: async () => false,
    stdout: async () => {},
    stderr: () => {},
    posting: async () => {
      throw new Error("A local review cannot publish")
    },
  }
  return { calls, deps }
}

describe("server-owned local review admission", () => {
  it.live("rejects authority and remote source fields instead of silently removing them", () =>
    Effect.gen(function* () {
      const repo = yield* fixture
      for (const field of [
        "directory",
        "parentID",
        "settingsRef",
        "readRoot",
        "readDenies",
        "model",
        "options",
        "trust",
        "post",
        "checks",
      ])
        expect(
          Exit.isFailure(
            yield* ReviewLocalAdmission.prepare({ ...repo.request, [field]: "forged" }, repo.source).pipe(Effect.exit),
          ),
        ).toBe(true)
      for (const target of [
        { kind: "pull-request", head: repo.request.target.head },
        { ...repo.request.target, base: repo.request.target.head },
        { ...repo.request.target, head: "HEAD" },
        { ...repo.request.target, instructions: "forged" },
      ])
        expect(
          Exit.isFailure(
            yield* ReviewLocalAdmission.prepare({ ...repo.request, target }, repo.source).pipe(Effect.exit),
          ),
        ).toBe(true)
      for (const maxCost of [0, -1, Infinity, NaN])
        expect(Option.isNone(Schema.decodeUnknownOption(ReviewRun.Start)({ ...repo.request, maxCost }))).toBe(true)
    }),
  )

  linux("runs nested local changes with inherited asks withheld and without GitHub authority", () =>
    Effect.gen(function* () {
      const repo = yield* fixture
      const admitted = yield* ReviewLocalAdmission.prepare(
        { ...repo.request, maxCost: 0.1 },
        {
          ...repo.source,
          permission: [...repo.source.permission, { permission: "read", pattern: "private.ts", action: "ask" }],
        },
      )
      expect(invocationProblems(admitted.invocation)).toEqual([])
      expect(admitted.invocation.parentID).toBe(repo.source.sessionID)
      expect(admitted.invocation.settingsRef).toBe(repo.request.target.head)
      expect(admitted.invocation.readRoot).toBe(repo.directory)
      expect(admitted.invocation.readDenies).toContain(path.join(repo.directory, "private.ts"))
      expect(admitted.invocation.readDenies).toContain(path.join(TRUNCATION_DIR, "*"))
      const run = adapter()
      const result = yield* ReviewService.execute(admitted.invocation, run.deps, admitted.placement)
      expect(run.calls).toHaveLength(1)
      expect(run.calls[0]!.identity).toBe("vectorscope")
      expect(run.calls[0]!.files.map((file) => file.path)).toEqual(["secret-a.ts", "secret-b.ts", "visible.ts"])
      expect(yield* Effect.promise(() => run.calls[0]!.knownPath("private.ts"))).toBe(false)
      expect(result.verdict.verdict).toBe("incomplete")
    }),
  )

  linux("retains admitted canonical paths and parent when async Git setup changes caller objects or a symlink", () =>
    Effect.gen(function* () {
      const repo = yield* fixture
      const link = path.join(repo.directory, "secret-link")
      yield* Effect.promise(() => fs.symlink("secret-a.ts", link))
      // The read port deliberately refuses untracked symlink capture. Keep this
      // positive authority-retarget case inside its supported tracked grammar.
      yield* git(repo.directory, "add", "secret-link")
      yield* git(repo.directory, "commit", "-qm", "tracked denial alias")
      const head = yield* git(repo.directory, "rev-parse", "HEAD")
      let mutated = false
      const permission = [{ permission: "read", pattern: "secret-link", action: "deny" as const }]
      const source: ReviewLocalAdmission.Source = {
        ...repo.source,
        get permission() {
          queueMicrotask(() => {
            if (mutated) return
            unlinkSync(link)
            symlinkSync("secret-b.ts", link)
            permission.length = 0
            source.sessionID = "ses_forged_late"
            mutated = true
          })
          return permission
        },
      }
      const admitted = yield* ReviewLocalAdmission.prepare(
        { ...repo.request, target: { ...repo.request.target, head } },
        source,
      )
      expect(mutated).toBe(true)
      expect(admitted.invocation.parentID).toBe("ses_local_review_owner")
      expect(admitted.invocation.readDenies).toContain(path.join(repo.directory, "secret-a.ts"))
      const run = adapter()
      const result = yield* ReviewService.execute(admitted.invocation, run.deps, admitted.placement)
      expect(result.error).toBeUndefined()
      expect(run.calls).toHaveLength(1)
      expect(run.calls[0]!.files.some((file) => file.path === "secret-a.ts")).toBe(false)
      expect(yield* Effect.promise(() => run.calls[0]!.knownPath("secret-a.ts"))).toBe(false)
      expect(result.verdict.verdict).toBe("incomplete")
    }),
  )

  it.live("refuses stale heads, unrelated placement, unsupported search restrictions and excess denials", () =>
    Effect.gen(function* () {
      const repo = yield* fixture
      expect(
        Exit.isFailure(
          yield* ReviewLocalAdmission.prepare(
            { ...repo.request, target: { ...repo.request.target, head: "a".repeat(40) } },
            repo.source,
          ).pipe(Effect.exit),
        ),
      ).toBe(true)
      const unrelated = yield* tmpdirScoped({ git: true })
      for (const source of [
        { ...repo.source, worktree: unrelated },
        { ...repo.source, worktree: "/" },
        { ...repo.source, directory: "relative" },
        { ...repo.source, permission: [{ permission: "grep", pattern: "*sensitive*", action: "ask" as const }] },
        {
          ...repo.source,
          permission: Array.from({ length: 1000 }, (_, n) => ({
            permission: "read",
            pattern: `private-${n}`,
            action: "deny" as const,
          })),
        },
      ])
        expect(Exit.isFailure(yield* ReviewLocalAdmission.prepare(repo.request, source).pipe(Effect.exit))).toBe(true)
    }),
  )

  windows(
    "Windows refuses genuine local admission before model setup or review",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const sessions = yield* Session.Service
        const parent = yield* sessions.create({ title: "Windows admission owner" }, "owner")
        const head = yield* git(test.directory, "rev-parse", "HEAD")
        const run = adapter()
        let resolutions = 0
        const result = yield* Effect.gen(function* () {
          const admitted = yield* ReviewLocalAdmission.prepare(
            { requestID: "windows_admission_refusal", target: { kind: "working-tree", head } },
            {
              sessionID: parent.id,
              directory: test.directory,
              worktree: test.directory,
              permission: [{ permission: "*", pattern: "*", action: "allow" }],
            },
          )
          return yield* ReviewService.execute(
            admitted.invocation,
            {
              ...run.deps,
              resolveModel: (input) =>
                Effect.gen(function* () {
                  resolutions++
                  return yield* run.deps.resolveModel(input)
                }),
            },
            admitted.placement,
          )
        }).pipe(Effect.result)
        expect(Result.isFailure(result)).toBe(true)
        if (Result.isFailure(result)) {
          expect(result.failure).toBeInstanceOf(ReviewLocalAdmission.Refused)
          if (result.failure instanceof ReviewLocalAdmission.Refused) {
            expect(result.failure.code).toBe("placement")
            expect(result.failure.message).toBe(
              "Read-only Git inspection is unavailable: this host has no pinned-directory adapter.",
            )
          }
        }
        expect(resolutions).toBe(0)
        expect(run.calls).toEqual([])
        expect((yield* sessions.get(parent.id)).id).toBe(parent.id)
      }),
    { git: true },
  )
})
