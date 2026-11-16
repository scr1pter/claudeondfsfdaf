import { $ } from "bun"
import { afterAll, describe, expect, test } from "bun:test"
import { createHash, randomUUID } from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"
import { deflateSync } from "node:zlib"
import { eq, sql } from "drizzle-orm"
import { Deferred, Effect, Fiber, Layer, Result, Schema } from "effect"
import { BackgroundJobStore } from "@vectordevai/core/background-job-store"
import { BrainDatabase } from "@vectordevai/core/brain/database"
import { BrainReviewMemoryTable } from "@vectordevai/core/brain/sql"
import { Database } from "@vectordevai/core/database/database"
import { LayerNode } from "@vectordevai/core/effect/layer-node"
import { Project } from "@vectordevai/core/project"
import { decodeLocalResult } from "@vectordevai/core/review/local-result"
import { ReviewRequestStore } from "@vectordevai/core/review/request-store"
import { ReviewRequestTable } from "@vectordevai/core/review/request.sql"
import type { ReviewSourceBinding } from "@vectordevai/core/review/source-binding"
import { reviewVerdict } from "@vectordevai/core/review/verdict"
import type { Finding, Quote, ReviewOutcome } from "@vectordevai/core/review/types"
import { SessionTable } from "@vectordevai/core/session/sql"
import { EffectFlock } from "@vectordevai/core/util/effect-flock"
import { SessionID } from "@vectordevai/schema/session-id"
import type { ReviewRun } from "@vectordevai/schema/review-run"
import { ReviewGit } from "@/review/git"
import { ReviewLifecycle } from "@/review/lifecycle"
import { ReviewLocalRun } from "@/review/local-run"
import { ReviewMemoryErasure } from "@/review/memory-erasure"
import { ReviewMemoryOutcome } from "@/review/memory-outcome"
import { ReviewMemoryScope } from "@/review/memory-scope"
import { readAuthority, type ReadAuthority } from "@/review/read-authority"
import { tmpdir } from "../fixture/fixture"
import { awaitWithTimeout } from "../lib/effect"

// This file executes real pinned Git/positive filesystem identity and is CI-only
// under the current native qualification gate. No fake verified-view port exists.
const local = process.platform === "linux" ? test : test.skip
const parentID = SessionID.make("ses_outcome_evidence_parent")
const reviewID = SessionID.make("ses_outcome_evidence_review")
const repository = Project.ID.make("outcome-evidence")
const owner = BackgroundJobStore.open()
afterAll(() => BackgroundJobStore.close(owner))
const git = (cwd: string, ...args: string[]) =>
  Effect.promise(() => $`git ${args}`.cwd(cwd).quiet().text()).pipe(Effect.map((value) => value.trim()))
const code = "export const count = 1"
const source = { parentID, reviewID }
const files = ["evidence.ts", "other.ts", "crlf.ts", "missing.ts", "binary.bin", "link.ts", "large.txt"]
const selectors = () => ({ ...source, files: [...files] })
const quote = (patch: Partial<Quote> = {}): Quote => ({ path: "evidence.ts", line: 1, side: "RIGHT", code, ...patch })
function artifact(head: string, patch: Partial<Finding> = {}, summary = "Bounded fixture outcome") {
  const finding: Finding = {
    id: "fixture_finding",
    path: "evidence.ts",
    line: 1,
    side: "RIGHT",
    source: "review",
    severity: "blocking",
    category: "bug",
    title: "Explicitly selected fixture observation",
    body: "This data is not an accepted rule.",
    confidence: 1,
    quotes: [quote()],
    ...patch,
  }
  const outcome: ReviewOutcome = {
    report: { summary, risk: "high", files: [], findings: [finding] },
    selection: {
      inline: [],
      outsideDiff: [],
      elsewhere: [],
      nits: [],
      overflow: [finding],
      stillOpen: [],
      fixed: [],
      dismissed: [],
      reappeared: [],
      raised: [],
      dropped: [],
      risk: "high",
    },
    skipped: [],
    durationMs: 1,
    base: head,
    head,
    mode: "full",
    unreviewed: [],
    specialists: [{ name: "review", status: "ok", steps: 1 }],
    sessions: [],
    stats: { files: 1, additions: 1, deletions: 0 },
    notes: [],
  }
  const verdict = reviewVerdict({ kind: "outcome", outcome })
  const value = ReviewLocalRun.encodeArtifact({
    exitCode: verdict.verdict === "clean-complete" ? 0 : 1,
    target: { kind: "uncommitted", label: "uncommitted changes", baseRef: "HEAD", mergeBase: head, head },
    outcome,
    verdict,
  })
  if (!value) throw new Error("Missing canonical fixture artifact")
  return value
}
type Setup = {
  directory: string
  head: string
  reads: ReadAuthority
  requests: ReviewRequestStore.Interface
  db: Database.Interface["db"]
  brain: BrainDatabase.Database
  binding: ReviewSourceBinding.Info
  identity: { parentID: SessionID; runID: SessionID; requestID: string; ownerNonce: string }
  view: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E | ReviewGit.Refused, R>
}
async function run(
  body: (
    setup: Setup,
  ) => Effect.Effect<void, unknown, ReviewRequestStore.Service | ReviewLifecycle.Service | Database.Service>,
) {
  await using directory = await tmpdir({ git: true })
  await using storage = await tmpdir()
  await Effect.runPromise(
    Effect.gen(function* () {
      yield* Effect.promise(async () => {
        await fs.writeFile(path.join(directory.path, "evidence.ts"), `${code}\nreturn count\n`)
        await fs.writeFile(path.join(directory.path, "other.ts"), "export const other = 2\n")
        await fs.writeFile(path.join(directory.path, "crlf.ts"), "const value = 1\r\nreturn value\r\n")
        await fs.writeFile(path.join(directory.path, "binary.bin"), Buffer.from([65, 0, 66]))
        await fs.writeFile(path.join(directory.path, "large.txt"), "x".repeat(ReviewMemoryOutcome.LIMIT.blob + 1))
        await fs.symlink("evidence.ts", path.join(directory.path, "link.ts"))
      })
      yield* git(directory.path, "config", "core.autocrlf", "false")
      yield* git(directory.path, "add", ".")
      yield* git(directory.path, "commit", "--quiet", "-m", "Retained exact evidence")
      const physical = yield* ReviewMemoryScope.git(directory.path)
      const head = physical.metadata.head
      const database = yield* Database.Service
      const brain = yield* BrainDatabase.Service
      const requests = ReviewRequestStore.make(database.db)
      const eraser = ReviewMemoryErasure.make(requests, brain.db)
      const request: ReviewRun.Start = { requestID: "outcome_evidence_request", target: { kind: "working-tree", head } }
      yield* database.db.run(
        sql`INSERT INTO project (id, worktree, sandboxes, time_created, time_updated) VALUES (${repository}, ${directory.path}, '[]', 1, 1)`,
      )
      yield* database.db.run(
        sql`INSERT INTO session (id, project_id, slug, directory, title, version, time_created, time_updated) VALUES (${parentID}, ${repository}, 'parent', ${directory.path}, 'Owner', 'test', 1, 1)`,
      )
      yield* database.db
        .insert(SessionTable)
        .values({
          id: reviewID,
          project_id: repository,
          parent_id: parentID,
          internal: ReviewLocalRun.MARKER,
          slug: "review",
          directory: directory.path,
          title: "Review",
          version: "test",
          time_created: 1,
          time_updated: 1,
          metadata: {
            [ReviewLocalRun.FIELD]: {
              version: 1,
              parentID,
              request,
              directory: directory.path,
              status: "running",
              startedAt: 1,
            },
          },
        })
        .run()
      const identity = { parentID, runID: reviewID, requestID: request.requestID, ownerNonce: randomUUID() }
      const reserved = yield* requests.reserve({ ...identity, request, owner, sourceBinding: physical.binding })
      expect(reserved.claimed).toBe(true)
      if (!reserved.row.sourceBinding) throw new Error("Winning reservation did not retain its physical binding")
      expect(yield* requests.attach(identity)).toBe(true)
      expect(yield* requests.begin(identity)).toBe(true)
      expect(yield* requests.ready(identity)).toBe(false)
      yield* body({
        directory: directory.path,
        head,
        requests,
        db: database.db,
        brain: brain.db,
        binding: reserved.row.sourceBinding,
        identity,
        reads: readAuthority([], { directory: directory.path, worktree: directory.path }),
        view: (effect) =>
          ReviewGit.within(
            physical.metadata,
            head,
            effect.pipe(Effect.provideService(ReviewLifecycle.Current, identity.ownerNonce)),
          ),
      }).pipe(
        Effect.provide(
          ReviewLifecycle.layer.pipe(
            Layer.provide(
              Layer.mergeAll(
                Layer.succeed(ReviewRequestStore.Service, requests),
                Layer.succeed(ReviewMemoryErasure.Service, eraser),
                LayerNode.compile(EffectFlock.node),
              ),
            ),
          ),
        ),
        Effect.provideService(ReviewRequestStore.Service, requests),
      )
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          Database.layerFromPath(path.join(storage.path, "main.sqlite")),
          BrainDatabase.layerFor(path.join(storage.path, "brain.sqlite")),
        ),
      ),
      Effect.scoped,
    ),
  )
}
const failure = <A>(value: Result.Result<A, ReviewMemoryOutcome.Refused>) => {
  if (Result.isSuccess(value)) throw new Error("Unexpected evidence authority")
  return value.failure.code
}

describe("inactive exact committed-head outcome collector", () => {
  test("the canonical outcome fixture retains its resolved target and missing or changed targets refuse", () => {
    const head = "a".repeat(40)
    const expected = { kind: "working-tree" as const, head }
    const value = artifact(head)
    const decoded = decodeLocalResult(Schema.decodeUnknownSync(Schema.UnknownFromJsonString)(value.json), expected)
    expect(decoded?.outcome?.head).toBe(head)
    expect(decoded?.target).toMatchObject({ kind: "uncommitted", head, mergeBase: head })
    if (!decoded?.target || !decoded.outcome) throw new Error("Missing canonical fixture result")
    const { target, ...missing } = decoded
    expect(decodeLocalResult(missing, expected)).toBeUndefined()
    expect(decodeLocalResult({ ...decoded, target: { ...target, kind: "staged" } }, expected)).toBeUndefined()
    expect(decodeLocalResult({ ...decoded, target: { ...target, head: "b".repeat(40) } }, expected)).toBeUndefined()
  })

  local(
    "real pinned evidence binds source, physical scope, selected finding and full artifact without proposing memory",
    async () => {
      await run((setup) =>
        setup.view(
          Effect.gen(function* () {
            const collector = yield* ReviewMemoryOutcome.open(selectors(), setup.reads)
            expect(
              failure(
                yield* ReviewMemoryOutcome.open(selectors(), setup.reads).pipe(
                  Effect.provideService(ReviewLifecycle.Current, randomUUID()),
                  Effect.result,
                ),
              ),
            ).toBe("unavailable")
            const value = artifact(setup.head)
            const handle = yield* collector.capture(value, "fixture_finding")
            const evidence = yield* collector.inspect(handle, value)
            expect(evidence).toMatchObject({
              kind: "committed-head",
              source: { ...source, head: setup.head },
              scope: setup.binding.scope,
              artifact: { sha256: value.sha256, bytes: value.bytes },
              finding: { id: "fixture_finding", path: "evidence.ts", line: 1 },
              citations: [{ path: "evidence.ts", line: 1, head: setup.head, quote: code }],
            })
            expect(evidence.sourceBindingSha256).toBe(
              createHash("sha256").update(JSON.stringify(setup.binding)).digest("hex"),
            )
            expect(Object.isFrozen(evidence)).toBe(true)
            expect(Object.isFrozen(evidence.citations[0])).toBe(true)
            expect(yield* setup.brain.select().from(BrainReviewMemoryTable)).toEqual([])
            collector.release(handle)
            expect(failure(yield* collector.inspect(handle, value).pipe(Effect.result))).toBe("invalid")
          }),
        ),
      )
    },
    30_000,
  )

  local(
    "JSON flags and copied handles cannot manufacture an admitted view or recognized evidence",
    async () => {
      await run((setup) =>
        Effect.gen(function* () {
          expect(failure(yield* ReviewMemoryOutcome.open(selectors(), setup.reads).pipe(Effect.result))).toBe(
            "unavailable",
          )
          yield* setup.view(
            Effect.gen(function* () {
              for (const flag of [
                { verified: true },
                { owner: true },
                { scope: setup.binding.scope },
                { root: setup.directory },
              ])
                expect(
                  failure(
                    yield* ReviewMemoryOutcome.open({ ...selectors(), ...flag }, setup.reads).pipe(Effect.result),
                  ),
                ).toBe("invalid")
              const collector = yield* ReviewMemoryOutcome.open(selectors(), setup.reads)
              const value = artifact(setup.head)
              const handle = yield* collector.capture(value, "fixture_finding")
              expect(failure(yield* collector.inspect(structuredClone(handle), value).pipe(Effect.result))).toBe(
                "invalid",
              )
              expect(
                failure(yield* collector.capture({ ...value, verified: true }, "fixture_finding").pipe(Effect.result)),
              ).toBe("invalid")
            }),
          )
        }),
      )
    },
    30_000,
  )

  local(
    "running ownership is independent of attached-only readiness and a changed nonce retires the collector",
    async () => {
      await run((setup) =>
        setup.view(
          Effect.gen(function* () {
            expect(yield* setup.requests.ready(setup.identity)).toBe(false)
            expect((yield* setup.requests.sourceSnapshot(parentID, reviewID))?.phase).toBe("running")
            const collector = yield* ReviewMemoryOutcome.open(selectors(), setup.reads)
            const value = artifact(setup.head)
            const handle = yield* collector.capture(value, "fixture_finding")
            expect((yield* collector.inspect(handle, value)).source).toEqual({ ...source, head: setup.head })
            yield* setup.db
              .update(ReviewRequestTable)
              .set({ owner_nonce: randomUUID() })
              .where(eq(ReviewRequestTable.run_id, reviewID))
              .run()
            expect(failure(yield* collector.inspect(handle, value).pipe(Effect.result))).toBe("unavailable")
            expect(yield* setup.requests.ready(setup.identity)).toBe(false)
          }),
        ),
      )
    },
    30_000,
  )

  local(
    "LEFT, missing legacy quotes, wrong lines and partial or modified quotations refuse",
    async () => {
      await run((setup) =>
        setup.view(
          Effect.gen(function* () {
            const collector = yield* ReviewMemoryOutcome.open(selectors(), setup.reads)
            for (const patch of [
              { quotes: undefined },
              { side: "LEFT" as const },
              { quotes: [quote({ side: "LEFT" })] },
            ])
              expect(
                failure(yield* collector.capture(artifact(setup.head, patch), "fixture_finding").pipe(Effect.result)),
              ).toBe("unsupported")
            for (const selected of [
              quote({ code: "export const count = 2" }),
              quote({ code: "export" }),
              quote({ line: 2 }),
              quote({ line: 99 }),
            ])
              expect(
                failure(
                  yield* collector
                    .capture(artifact(setup.head, { verified: true, quotes: [selected] }), "fixture_finding")
                    .pipe(Effect.result),
                ),
              ).toBe("quote-mismatch")
            const trailing = artifact(setup.head, { quotes: [quote({ code: `${code}\n` })] })
            expect(
              (yield* collector.inspect(yield* collector.capture(trailing, "fixture_finding"), trailing)).citations[0]
                ?.quote,
            ).toBe(`${code}\n`)
          }),
        ),
      )
    },
    30_000,
  )

  local(
    "exact CRLF bytes remain intact and cannot be silently normalized",
    async () => {
      await run((setup) =>
        setup.view(
          Effect.gen(function* () {
            const collector = yield* ReviewMemoryOutcome.open(selectors(), setup.reads)
            const exact = artifact(setup.head, {
              path: "crlf.ts",
              quotes: [quote({ path: "crlf.ts", code: "const value = 1\r\n" })],
            })
            const handle = yield* collector.capture(exact, "fixture_finding")
            expect((yield* collector.inspect(handle, exact)).citations[0]?.quote).toBe("const value = 1\r\n")
            const normalized = artifact(setup.head, {
              path: "crlf.ts",
              quotes: [quote({ path: "crlf.ts", code: "const value = 1\n" })],
            })
            expect(failure(yield* collector.capture(normalized, "fixture_finding").pipe(Effect.result))).toBe(
              "quote-mismatch",
            )
          }),
        ),
      )
    },
    30_000,
  )

  local(
    "literal reviewed paths and actual read denies bound every quoted object",
    async () => {
      await run((setup) =>
        setup.view(
          Effect.gen(function* () {
            const denied = readAuthority(["other.ts"], { directory: setup.directory, worktree: setup.directory })
            const collector = yield* ReviewMemoryOutcome.open(selectors(), denied)
            for (const selected of [
              quote({ path: "../evidence.ts" }),
              quote({ path: "/evidence.ts" }),
              quote({ path: "src\\a.ts" }),
              quote({ path: "other.ts", code: "export const other = 2" }),
            ])
              expect(
                failure(
                  yield* collector
                    .capture(artifact(setup.head, { quotes: [selected] }), "fixture_finding")
                    .pipe(Effect.result),
                ),
              ).toBe("unavailable")
            const limited = yield* ReviewMemoryOutcome.open({ ...source, files: ["other.ts"] }, setup.reads)
            expect(failure(yield* limited.capture(artifact(setup.head), "fixture_finding").pipe(Effect.result))).toBe(
              "unavailable",
            )
          }),
        ),
      )
    },
    30_000,
  )

  local(
    "missing objects, symlinks, binary blobs and oversized objects cannot become code evidence",
    async () => {
      await run((setup) =>
        setup.view(
          Effect.gen(function* () {
            const collector = yield* ReviewMemoryOutcome.open(selectors(), setup.reads)
            for (const file of ["missing.ts", "link.ts", "binary.bin", "large.txt"])
              expect(
                failure(
                  yield* collector
                    .capture(artifact(setup.head, { quotes: [quote({ path: file })] }), "fixture_finding")
                    .pipe(Effect.result),
                ),
              ).toBe("unavailable")
          }),
        ),
      )
    },
    30_000,
  )

  local(
    "full artifact changes, invalid digests and another finding cannot reuse verification",
    async () => {
      await run((setup) =>
        setup.view(
          Effect.gen(function* () {
            const collector = yield* ReviewMemoryOutcome.open(selectors(), setup.reads)
            const value = artifact(setup.head)
            const handle = yield* collector.capture(value, "fixture_finding")
            expect(
              failure(
                yield* collector.inspect(handle, artifact(setup.head, {}, "Changed summary only")).pipe(Effect.result),
              ),
            ).toBe("invalid")
            for (const modified of [
              { ...value, sha256: "0".repeat(64) },
              { ...value, bytes: value.bytes + 1 },
              artifact("0".repeat(40)),
            ])
              expect(failure(yield* collector.capture(modified, "fixture_finding").pipe(Effect.result))).toBe("invalid")
            expect(failure(yield* collector.capture(value, "another_finding").pipe(Effect.result))).toBe("invalid")
          }),
        ),
      )
    },
    30_000,
  )

  local(
    "a real loose blob forged under another object ID is readable by cat-file but cannot attest evidence",
    async () => {
      await run((setup) =>
        Effect.gen(function* () {
          const objectID = yield* git(setup.directory, "rev-parse", `${setup.head}:evidence.ts`)
          const bytes = Buffer.from("FORGED_NAMED_OBJECT\n")
          const file = path.join(setup.directory, ".git", "objects", objectID.slice(0, 2), objectID.slice(2))
          yield* Effect.promise(async () => {
            await fs.chmod(file, 0o600)
            await fs.writeFile(file, deflateSync(Buffer.concat([Buffer.from(`blob ${bytes.byteLength}\0`), bytes])))
          })
          // Positive control: valid compression under the wrong filename is not
          // byte identity merely because ordinary cat-file returned success.
          expect(yield* git(setup.directory, "cat-file", "blob", `${setup.head}:evidence.ts`)).toBe(
            "FORGED_NAMED_OBJECT",
          )
          const privateView = yield* setup.view(Effect.succeed("unexpected verified view")).pipe(Effect.result)
          expect(Result.isFailure(privateView)).toBe(true)
          if (Result.isSuccess(privateView)) throw new Error("Forged object reached a private consumer")
          expect(privateView.failure).toBeInstanceOf(ReviewGit.Refused)
        }),
      )
    },
    30_000,
  )

  local(
    "expired actual private views refuse even if their old context object is supplied again",
    async () => {
      await run((setup) =>
        Effect.gen(function* () {
          let collector: ReviewMemoryOutcome.Interface | undefined
          let handle: ReviewMemoryOutcome.Handle | undefined
          let view: ReviewGit.View | undefined
          const value = artifact(setup.head)
          yield* setup.view(
            Effect.gen(function* () {
              view = yield* ReviewGit.Current
              collector = yield* ReviewMemoryOutcome.open(selectors(), setup.reads)
              handle = yield* collector.capture(value, "fixture_finding")
            }),
          )
          if (!collector || !handle || !view) throw new Error("Missing real capture fixture")
          expect(failure(yield* collector.inspect(handle, value).pipe(Effect.result))).toBe("unavailable")
          expect(
            failure(
              yield* collector
                .inspect(handle, value)
                .pipe(Effect.provideService(ReviewGit.Current, view), Effect.result),
            ),
          ).toBe("unavailable")
        }),
      )
    },
    30_000,
  )

  local(
    "release during the actual metadata await retires an already pending evidence inspection",
    async () => {
      await run((setup) =>
        setup.view(
          Effect.scoped(
            Effect.gen(function* () {
              const entered = yield* Deferred.make<void>()
              const proceed = yield* Deferred.make<void>()
              let pause = false
              // The wrapper pauses only AFTER the genuine SQLite source read succeeds;
              // every authority result, ready check, pinned view and lifecycle lock is real.
              const observed: ReviewRequestStore.Interface = {
                ...setup.requests,
                sourceSnapshot: (parent, review) =>
                  setup.requests.sourceSnapshot(parent, review).pipe(
                    Effect.tap(() => {
                      if (!pause) return Effect.void
                      pause = false
                      return Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(proceed)))
                    }),
                  ),
              }
              const collector = yield* ReviewMemoryOutcome.open(selectors(), setup.reads).pipe(
                Effect.provideService(ReviewRequestStore.Service, observed),
              )
              const value = artifact(setup.head)
              const handle = yield* collector.capture(value, "fixture_finding")
              pause = true
              yield* Effect.gen(function* () {
                const pending = yield* collector.inspect(handle, value).pipe(Effect.result, Effect.forkChild)
                yield* awaitWithTimeout(
                  Deferred.await(entered),
                  "Inspection did not reach the genuine source read",
                  "5 seconds",
                )
                collector.release(handle)
                yield* Deferred.succeed(proceed, undefined)
                expect(failure(yield* Fiber.join(pending))).toBe("invalid")
              }).pipe(Effect.ensuring(Deferred.succeed(proceed, undefined)))
            }),
          ),
        ),
      )
    },
    30_000,
  )

  local(
    "closing the actual private view during the genuine SQL await retires a pending inspection",
    async () => {
      await run((setup) =>
        setup.view(
          Effect.scoped(
            Effect.gen(function* () {
              const view = yield* ReviewGit.Current
              if (!view) throw new Error("Missing actual private view")
              const entered = yield* Deferred.make<void>()
              const proceed = yield* Deferred.make<void>()
              let pause = false
              const observed: ReviewRequestStore.Interface = {
                ...setup.requests,
                sourceSnapshot: (parent, review) =>
                  setup.requests.sourceSnapshot(parent, review).pipe(
                    Effect.tap(() => {
                      if (!pause) return Effect.void
                      pause = false
                      return Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(proceed)))
                    }),
                  ),
              }
              const collector = yield* ReviewMemoryOutcome.open(selectors(), setup.reads).pipe(
                Effect.provideService(ReviewRequestStore.Service, observed),
              )
              const value = artifact(setup.head)
              const handle = yield* collector.capture(value, "fixture_finding")
              pause = true
              yield* Effect.gen(function* () {
                const pending = yield* collector.inspect(handle, value).pipe(Effect.result, Effect.forkChild)
                yield* awaitWithTimeout(
                  Deferred.await(entered),
                  "Inspection did not reach the genuine source read",
                  "5 seconds",
                )
                const closing = view.repository.close()
                expect(view.repository.isOpen()).toBe(false)
                yield* Deferred.succeed(proceed, undefined)
                expect(
                  failure(
                    yield* awaitWithTimeout(Fiber.join(pending), "Closed inspection did not settle", "5 seconds"),
                  ),
                ).toBe("unavailable")
                yield* Effect.promise(() => closing)
              }).pipe(Effect.ensuring(Deferred.succeed(proceed, undefined)))
            }),
          ),
        ),
      )
    },
    30_000,
  )

  local(
    "closure in the final actual readability check prevents publication of a new handle",
    async () => {
      await run((setup) =>
        setup.view(
          Effect.gen(function* () {
            const view = yield* ReviewGit.Current
            if (!view) throw new Error("Missing actual private view")
            let checks = 0
            let closing: Promise<void> | undefined
            const reads: ReadAuthority = {
              ...setup.reads,
              denied: (file) => {
                const denied = setup.reads.denied(file)
                checks++
                // Finding + quote admission precede this last publication-policy check.
                if (checks === 3) closing = view.repository.close()
                return denied
              },
            }
            const collector = yield* ReviewMemoryOutcome.open(selectors(), reads)
            expect(failure(yield* collector.capture(artifact(setup.head), "fixture_finding").pipe(Effect.result))).toBe(
              "unavailable",
            )
            expect(checks).toBe(3)
            expect(view.repository.isOpen()).toBe(false)
            if (!closing) throw new Error("Final actual read-policy check did not close the view")
            const closed = closing
            yield* Effect.promise(() => closed)
          }),
        ),
      )
    },
    30_000,
  )

  local(
    "another real private view and a changed admission scope cannot retarget a capture",
    async () => {
      await using other = await tmpdir({ git: true })
      await run((setup) =>
        setup.view(
          Effect.gen(function* () {
            const collector = yield* ReviewMemoryOutcome.open(selectors(), setup.reads)
            const value = artifact(setup.head)
            const physical = yield* ReviewMemoryScope.git(other.path)
            const wrongView = yield* ReviewGit.within(
              physical.metadata,
              physical.metadata.head,
              collector.capture(value, "fixture_finding").pipe(Effect.result),
            )
            expect(failure(wrongView)).toBe("unavailable")
            yield* setup.db
              .update(ReviewRequestTable)
              .set({ source_binding: { ...setup.binding, scope: `vrs1_${"0".repeat(64)}` } })
              .where(eq(ReviewRequestTable.run_id, reviewID))
              .run()
            expect(failure(yield* collector.capture(value, "fixture_finding").pipe(Effect.result))).toBe("stale")
          }),
        ),
      )
    },
    30_000,
  )

  local(
    "live HEAD movement and settled legacy sources cannot acquire new evidence",
    async () => {
      await run((setup) =>
        setup.view(
          Effect.gen(function* () {
            const collector = yield* ReviewMemoryOutcome.open(selectors(), setup.reads)
            yield* git(setup.directory, "commit", "--quiet", "--allow-empty", "-m", "Moved after admission")
            expect(failure(yield* collector.capture(artifact(setup.head), "fixture_finding").pipe(Effect.result))).toBe(
              "unavailable",
            )
          }),
        ),
      )
      await run((setup) =>
        setup.view(
          Effect.gen(function* () {
            yield* setup.requests.finish(setup.identity)
            expect(failure(yield* ReviewMemoryOutcome.open(selectors(), setup.reads).pipe(Effect.result))).toBe(
              "unavailable",
            )
          }),
        ),
      )
      await run((setup) =>
        setup.view(
          Effect.gen(function* () {
            yield* setup.db
              .update(ReviewRequestTable)
              .set({ source_binding: null })
              .where(eq(ReviewRequestTable.run_id, reviewID))
              .run()
            expect(failure(yield* ReviewMemoryOutcome.open(selectors(), setup.reads).pipe(Effect.result))).toBe(
              "unavailable",
            )
          }),
        ),
      )
    },
    30_000,
  )

  local(
    "changed working-tree and staged contents are not borrowed as committed-head quotations",
    async () => {
      await run((setup) =>
        Effect.gen(function* () {
          yield* Effect.promise(() => fs.writeFile(path.join(setup.directory, "evidence.ts"), "WORKING_ONLY_CONTENT\n"))
          yield* setup.view(
            Effect.gen(function* () {
              const collector = yield* ReviewMemoryOutcome.open(selectors(), setup.reads)
              expect(
                failure(
                  yield* collector
                    .capture(
                      artifact(setup.head, { quotes: [quote({ code: "WORKING_ONLY_CONTENT" })] }),
                      "fixture_finding",
                    )
                    .pipe(Effect.result),
                ),
              ).toBe("quote-mismatch")
              const headArtifact = artifact(setup.head)
              expect(
                (yield* collector.inspect(yield* collector.capture(headArtifact, "fixture_finding"), headArtifact))
                  .citations[0]?.quote,
              ).toBe(code)
            }),
          )
          yield* git(setup.directory, "add", "evidence.ts")
          yield* setup.view(
            Effect.gen(function* () {
              const collector = yield* ReviewMemoryOutcome.open(selectors(), setup.reads)
              expect(
                failure(
                  yield* collector
                    .capture(
                      artifact(setup.head, { quotes: [quote({ code: "WORKING_ONLY_CONTENT" })] }),
                      "fixture_finding",
                    )
                    .pipe(Effect.result),
                ),
              ).toBe("quote-mismatch")
            }),
          )
        }),
      )
    },
    30_000,
  )

  local(
    "the real durable deletion fence retires captured evidence before physical source removal",
    async () => {
      await run((setup) =>
        setup.view(
          Effect.gen(function* () {
            const collector = yield* ReviewMemoryOutcome.open(selectors(), setup.reads)
            const value = artifact(setup.head)
            const handle = yield* collector.capture(value, "fixture_finding")
            const closing = yield* setup.requests.beginDelete({
              sessionID: parentID,
              ownerNonce: randomUUID(),
              owner,
              localNonces: new Set([setup.identity.ownerNonce]),
              insideReview: false,
            })
            expect(closing).toEqual([setup.identity.ownerNonce])
            expect(failure(yield* collector.inspect(handle, value).pipe(Effect.result))).toBe("unavailable")
            expect(yield* setup.brain.select().from(BrainReviewMemoryTable)).toEqual([])
          }),
        ),
      )
    },
    30_000,
  )

  local(
    "captures stay bounded and detach mutable caller artifacts after validation",
    async () => {
      await run((setup) =>
        setup.view(
          Effect.gen(function* () {
            const value = artifact(setup.head)
            const original = structuredClone(value)
            let changed = false
            const observing: ReadAuthority = {
              ...setup.reads,
              denied: (file) => {
                if (!changed) {
                  changed = true
                  Object.assign(value, artifact(setup.head, {}, "Caller changed during read"))
                }
                return setup.reads.denied(file)
              },
            }
            const collector = yield* ReviewMemoryOutcome.open(selectors(), observing)
            const handle = yield* collector.capture(value, "fixture_finding")
            expect((yield* collector.inspect(handle, original)).artifact.sha256).toBe(original.sha256)
            expect(failure(yield* collector.inspect(handle, value).pipe(Effect.result))).toBe("invalid")
            for (let i = 1; i < ReviewMemoryOutcome.LIMIT.captures; i++)
              yield* collector.capture(original, "fixture_finding")
            expect(failure(yield* collector.capture(original, "fixture_finding").pipe(Effect.result))).toBe("limit")
          }),
        ),
      )
    },
    30_000,
  )
})
