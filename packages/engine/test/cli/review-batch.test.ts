import { $ } from "bun"
import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import { readFileSync } from "node:fs"
import path from "node:path"
import { Effect } from "effect"
import { Brain } from "@vectordevai/core/brain/brain"
import { LayerNode } from "@vectordevai/core/effect/layer-node"
import { CrossSpawnSpawner } from "@vectordevai/core/cross-spawn-spawner"
import { FSUtil } from "@vectordevai/core/fs-util"
import { ModelV2 } from "@vectordevai/core/model"
import { ProviderV2 } from "@vectordevai/core/provider"
import {
  batchCoverage,
  emptyState,
  advanceBatchCursor,
  startBatchCursor,
  decodeState,
  encodeState,
} from "@vectordevai/core/review/state"
import { SpendGuard } from "@vectordevai/core/spend-guard"
import { executeLocalReview, type LocalReviewDeps } from "@/cli/cmd/review"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Git } from "@/git"
import { Permission } from "@/permission"
import { Provider } from "@/provider/provider"
import { lockBatchFile, localBatchStore } from "@/review/batch-local"
import { Review } from "@/review/run"
import { planReviewBatches } from "@vectordevai/core/review/plan"
import { parseUnifiedDiff } from "@vectordevai/core/review/diff"
import { Instruction } from "@/session/instruction"
import { Session } from "@/session/session"
import { SessionPrompt } from "@/session/prompt"
import { TestInstance, tmpdir, trustWorkspace } from "../fixture/fixture"
import { firstUserText } from "../fixture/projection"
import { testEffect } from "../lib/effect"
import { TestLLMServer, reply } from "../lib/llm-server"
import { testProviderConfig } from "../lib/test-provider"

const it = testEffect(
  LayerNode.compile(
    LayerNode.group([
      Git.node,
      Brain.node,
      Instruction.node,
      SessionPrompt.node,
      Session.node,
      SpendGuard.node,
      Permission.node,
      Provider.node,
      EventV2Bridge.node,
      FSUtil.node,
      CrossSpawnSpawner.node,
      LayerNode.make({ service: TestLLMServer, layer: TestLLMServer.loopback, deps: [] }),
    ]),
  ),
)

it.instance(
  "the CLI resumes its owner-authored cursor under concurrent invocations and caches only after all batches",
  () =>
    Effect.gen(function* () {
      const { directory: dir } = yield* TestInstance
      const llm = yield* TestLLMServer
      const head = yield* Effect.promise(async () => {
        const provider = testProviderConfig(llm.url)
        provider.provider.lmstudio.models["test-model"].cost = { input: 0.1, output: 0.2 }
        await fs.writeFile(path.join(dir, "vector.json"), JSON.stringify(provider))
        await $`git branch -M main`.cwd(dir).quiet()
        await fs.mkdir(path.join(dir, ".vector"), { recursive: true })
        await fs.writeFile(
          path.join(dir, ".vector/review.json"),
          JSON.stringify({ largeChanges: "batch", maxFiles: 1, security: "off", verify: "off" }),
        )
        await $`git add .vector/review.json`.cwd(dir).quiet()
        await $`git commit -qm settings`.cwd(dir).quiet()
        await $`git checkout -qb feature`.cwd(dir).quiet()
        for (const name of ["a", "b", "c"])
          await fs.writeFile(path.join(dir, name + ".ts"), "export default 'CLI_BATCH_" + name + "'\n")
        await $`git add a.ts b.ts c.ts`.cwd(dir).quiet()
        await $`git commit -qm change`.cwd(dir).quiet()
        // Trust the final project configuration, including the review settings just authored.
        await trustWorkspace(dir)
        return (await $`git rev-parse HEAD`.cwd(dir).quiet().text()).trim()
      })
      const leaf = path.join(dir, ".git", "vector", "review", "feature.json")
      if (process.platform === "linux") {
        const probe = yield* Effect.promise(() => lockBatchFile(dir, leaf, head))
        yield* Effect.promise(probe.close)
      }
      const state = () => Effect.promise(async () => decodeState(JSON.parse(await fs.readFile(leaf, "utf8")).state)!)
      const journals: string[] = []
      for (let i = 0; i < 6; i++)
        yield* llm.pushMatch(
          (hit) => {
            if (!firstUserText(hit.body).includes("You are Vector's code reviewer")) return false
            journals.push(decodeState(JSON.parse(readFileSync(leaf, "utf8")).state)?.inflight?.run ?? "missing")
            return true
          },
          reply()
            .tool("StructuredOutput", {
              summary: "Examined the assigned patch.",
              risk: "low",
              files: [],
              findings: [],
            })
            .usage({ input: 50, output: 12 }),
        )
      let clock = Date.now()
      let beforeReview:
        | (() => Effect.Effect<void, never, Effect.Services<ReturnType<typeof Review.run>> | Git.Service>)
        | undefined
      const invoke = (cards?: LocalReviewDeps["cards"], pr?: number, full = false, env: Record<string, string> = {}) =>
        Effect.gen(function* () {
          const output: string[] = []
          const result = yield* executeLocalReview(
            { directory: dir, base: "main", env, json: true, full, ...(pr ? { pr } : {}) },
            {
              runReview: (input) =>
                Effect.gen(function* () {
                  const before = beforeReview
                  beforeReview = undefined
                  if (before) yield* before()
                  return yield* Review.run(input)
                }),
              now: () => clock,
              ...(cards ? { cards } : {}),
              resolveModel: () =>
                Effect.succeed({
                  providerID: ProviderV2.ID.make("lmstudio"),
                  modelID: ModelV2.ID.make("test-model"),
                  context: 128000,
                  costKind: "priced" as const,
                  price: { input: 0.1, output: 0.2 },
                }),
              stdout: async (value) => {
                output.push(value)
              },
              stderr: () => {},
              posting: async () => {
                throw new Error("unexpected upload")
              },
              confirm: async () => false,
              color: false,
            },
          )
          return { ...result, text: output.join("") }
        })
      if (process.platform === "linux") {
        const limited = yield* invoke(undefined, undefined, false, {
          REVIEW_MAX_COST_USD: "0",
          REVIEW_MAX_COST_USD_PER_MONTH: "0.000001",
        })
        expect(limited.exitCode).toBe(2)
        expect(limited.outcome?.partial).toBe("budget")
        expect(yield* llm.calls).toBe(0)
        expect((yield* state()).head).toBeUndefined()
      }
      const first = yield* invoke(undefined, undefined, true)
      expect(first.exitCode).toBe(2)
      if (process.platform !== "linux") {
        expect(first.outcome?.notes.join(" ")).toContain("trusted review-state store")
        expect(yield* llm.inputs).toEqual([])
        return
      }
      expect(first.outcome?.unreviewed, first.error).toEqual(["b.ts", "c.ts"])
      expect((yield* state()).head).toBeUndefined()
      expect((yield* state()).batch?.completed).toBe(1)
      const instructionPath = path.join(dir, "AGENTS.md")
      const sentinel = "Check every conversion against its calling convention."
      const beforeChange = yield* Effect.promise(() => fs.readFile(leaf, "utf8"))
      yield* Effect.promise(() => fs.writeFile(instructionPath, sentinel))
      const changedInstructions = yield* invoke()
      expect(changedInstructions.exitCode).toBe(2)
      expect(changedInstructions.outcome?.notes.join(" ")).toContain("saved batch plan no longer matches")
      expect(yield* Effect.promise(() => fs.readFile(leaf, "utf8"))).toBe(beforeChange)
      expect(journals).toHaveLength(1)
      yield* Effect.promise(() => fs.unlink(instructionPath))
      const next = yield* Effect.all([invoke(), invoke()], { concurrency: 2 })
      expect(next.map((x) => x.exitCode).sort()).toEqual([0, 2])
      expect((yield* state()).head).toBe(head)
      expect((yield* state()).batch).toBeUndefined()
      expect((yield* state()).inflight).toBeUndefined()
      expect((yield* state()).unreviewed).toEqual([])
      const cached = yield* invoke()
      expect(cached.exitCode).toBe(0)
      expect(JSON.parse(cached.text).cached).toBe(true)
      const bodies = (yield* llm.inputs)
        .map(firstUserText)
        .filter((text) => text.includes("You are Vector's code reviewer"))
      expect(journals).toHaveLength(3)
      expect(journals.every((run) => /^batch:[0-9a-f]{64}$/.test(run))).toBe(true)
      expect(bodies.map((text) => text.match(/CLI_BATCH_([abc])/)?.[1])).toEqual(["a", "b", "c"])
      expect(bodies.every((text) => (text.match(/CLI_BATCH_[abc]/g) ?? []).length >= 1)).toBe(true)
      const savedCost = (yield* state()).costUsd
      expect(savedCost).toBeGreaterThan(0)
      yield* Effect.promise(() => fs.writeFile(instructionPath, sentinel))
      const changedCache = yield* invoke()
      expect(changedCache.exitCode).toBe(2)
      expect(JSON.parse(changedCache.text).cached).toBeUndefined()
      expect(journals).toHaveLength(3)
      // An explicit full retry spends from the same accumulated allowance, beginning again with the first file.
      const restart = yield* invoke(undefined, undefined, true)
      expect(restart.exitCode, restart.error).toBe(2)
      expect(restart.outcome?.unreviewed).toEqual(["b.ts", "c.ts"])
      expect((yield* state()).costUsd).toBeGreaterThan(savedCost)
      expect((yield* state()).batch?.completed).toBe(1)
      expect((yield* llm.inputs).some((body) => JSON.stringify(body).includes(sentinel))).toBe(true)
      expect(yield* Effect.promise(() => fs.readFile(leaf, "utf8"))).not.toContain(sentinel)
      const resize = (maxFiles: number) =>
        Effect.promise(async () => {
          await fs.writeFile(
            path.join(dir, ".vector/review.json"),
            JSON.stringify({ largeChanges: "batch", maxFiles, security: "off", verify: "off" }),
          )
          await trustWorkspace(dir)
        })
      yield* resize(10)
      const requestsBeforeResize = journals.length
      const resized = yield* invoke()
      expect(resized.exitCode).toBe(2)
      expect(resized.outcome?.notes.join(" ")).toContain("saved batch plan no longer matches")
      expect(journals).toHaveLength(requestsBeforeResize)
      const beforeResize = yield* state()
      const oneBatch = yield* invoke(undefined, undefined, true)
      expect(oneBatch.exitCode, oneBatch.error).toBe(0)
      expect(journals).toHaveLength(requestsBeforeResize + 1)
      expect((yield* state()).costUsd).toBeGreaterThan(beforeResize.costUsd)
      expect((yield* state()).head).toBe(head)
      const checkpoint = yield* Effect.promise(async () => JSON.parse(await fs.readFile(leaf, "utf8")).batch)
      expect(checkpoint.cursor.completed).toBe(1)
      expect(checkpoint.initialCostUsd).toBe(0)
      yield* resize(1)
      yield* Effect.promise(async () => {
        await fs.unlink(instructionPath)
        await fs.writeFile(path.join(dir, "d.ts"), "export default 4\n")
        await $`git add d.ts`.cwd(dir).quiet()
        await $`git commit -qm next`.cwd(dir).quiet()
      })
      const changed = yield* invoke()
      expect(changed.exitCode).toBe(2)
      expect(changed.outcome?.unreviewed).toContain("d.ts")
      expect((yield* state()).batch?.completed).toBe(1)
      // A Brain-capable app uses its fresh per-review card selection. Its grant cannot reuse
      // even an owner-authored batch cursor, and no card/specialist output enters the record.
      const before = yield* Effect.promise(() => fs.readFile(leaf, "utf8"))
      const count = yield* llm.calls
      yield* Effect.promise(async () => {
        await fs.writeFile(
          path.join(dir, ".vector/review.json"),
          JSON.stringify({ largeChanges: "batch", maxFiles: 1, cards: "brain", security: "off", verify: "off" }),
        )
        await trustWorkspace(dir)
      })
      let lookedUp = false
      const privateRun = yield* invoke(() =>
        Effect.sync(() => {
          lookedUp = true
          return undefined
        }),
      )
      expect(lookedUp).toBe(true)
      expect(privateRun.exitCode).toBe(2)
      expect(privateRun.outcome?.notes.join(" ")).toContain("cannot reuse a review that uses Brain cards")
      expect(yield* llm.calls).toBe(count)
      expect(yield* Effect.promise(() => fs.readFile(leaf, "utf8"))).toBe(before)
      // The local --pr target fetches this fixture's pull ref into FETCH_HEAD only.
      // A pull cursor is separate even when the source branch names the very same commit.
      yield* Effect.promise(async () => {
        await $`git update-ref refs/pull/7/head HEAD`.cwd(dir).quiet()
        await $`git remote add origin .`.cwd(dir).quiet()
      })
      yield* llm.pushMatch(
        (hit) => firstUserText(hit.body).includes("You are Vector's code reviewer"),
        reply()
          .tool("StructuredOutput", { summary: "Reviewed this pull batch.", risk: "low", files: [], findings: [] })
          .usage({ input: 42, output: 13 }),
      )
      const remote = yield* invoke(undefined, 7)
      expect(remote.exitCode, remote.error).toBe(2)
      expect(remote.outcome?.notes.join(" ")).toContain("1 of 4 batches complete")
      const prState = yield* Effect.promise(async () =>
        decodeState(JSON.parse(await fs.readFile(path.join(path.dirname(leaf), "pr%3A7.json"), "utf8")).state),
      )
      expect(prState?.batch?.completed).toBe(1)
      expect(prState?.head).toBeUndefined()
      expect(yield* Effect.promise(() => fs.readFile(leaf, "utf8"))).toBe(before)
      // Journal A was written before midnight. A subsequent ordinary full review of head B
      // cannot know when the provider billed A, and must preserve that ambiguity for large head C.
      clock = Date.parse("2026-11-01T00:00:10Z")
      yield* Effect.promise(async () => {
        const row = JSON.parse(await fs.readFile(leaf, "utf8"))
        const previous = decodeState(row.state)!
        previous.inflight = {
          head: row.batch.cursor.head,
          run: "batch:" + row.batch.cursor.plan,
          at: Date.parse("2026-10-31T23:59:50Z"),
          costUsd: 0,
        }
        row.state = encodeState(previous)
        await fs.writeFile(leaf, JSON.stringify(row) + "\n")
        await fs.writeFile(
          path.join(dir, ".vector/review.json"),
          JSON.stringify({ largeChanges: "skip", maxFiles: 10, security: "off", verify: "off" }),
        )
        await trustWorkspace(dir)
        await $`git commit --allow-empty -qm ordinary`.cwd(dir).quiet()
      })
      const response = () =>
        llm.pushMatch(
          (hit) => firstUserText(hit.body).includes("You are Vector's code reviewer"),
          reply()
            .tool("StructuredOutput", { summary: "Reviewed the current patch.", risk: "low", files: [], findings: [] })
            .usage({ input: 70, output: 15 }),
        )
      yield* response()
      const ordinary = yield* invoke(undefined, undefined, true)
      expect(ordinary.exitCode, ordinary.error).toBe(0)
      const dormant = yield* Effect.promise(async () => JSON.parse(await fs.readFile(leaf, "utf8")))
      expect(dormant.batch).toBeUndefined()
      expect(dormant.batchUncertainMonth).toBe("2026-11")
      yield* resize(1)
      yield* Effect.promise(() => $`git commit --allow-empty -qm next-batch`.cwd(dir).quiet())
      const at = yield* llm.calls
      const monthly = {
        REVIEW_MAX_COST_USD: "0",
        REVIEW_MAX_COST_USD_PER_MONTH: "50",
        REVIEW_MAX_COST_USD_PER_PR: "0.000001",
      }
      const refused = yield* invoke(undefined, undefined, true, monthly)
      expect(refused.exitCode).toBe(2)
      expect(refused.outcome?.notes.join(" ")).toContain("prior spend could not be confirmed")
      expect(yield* llm.calls).toBe(at)
      clock = Date.parse("2026-12-01T00:00:05Z")
      yield* response()
      const resumed = yield* invoke(undefined, undefined, true, monthly)
      expect(resumed.outcome?.notes.join(" "), resumed.error).toContain("1 of 4 batches complete")
      expect(yield* llm.calls).toBe(at + 1)
      // An ordinary review takes its write lock only at the end. A later funded review of this
      // same target can publish first; the stale writer may add its charge but must preserve the newer review and cursor.
      const ordinaryConfig = { largeChanges: "skip", maxFiles: 10, security: "off", verify: "off" }
      yield* Effect.promise(async () => {
        await fs.writeFile(path.join(dir, ".vector/review.json"), JSON.stringify(ordinaryConfig))
        await trustWorkspace(dir)
      })
      let purchased: string | undefined
      beforeReview = () =>
        Effect.gen(function* () {
          yield* resize(1)
          yield* response()
          const funded = yield* invoke(undefined, undefined, true, monthly)
          expect(funded.outcome?.notes.join(" "), funded.error).toContain("1 of 4 batches complete")
          purchased = yield* Effect.promise(() => fs.readFile(leaf, "utf8"))
          yield* response()
        })
      const stale = yield* invoke(undefined, undefined, true)
      expect(stale.exitCode, stale.error).toBe(0)
      const committed = JSON.parse(purchased!)
      const committedState = decodeState(committed.state)!
      const reconciled = yield* Effect.promise(async () => JSON.parse(await fs.readFile(leaf, "utf8")))
      const combined = decodeState(reconciled.state)!
      expect(reconciled.batch).toEqual(committed.batch)
      expect(reconciled.outcome).toEqual(committed.outcome)
      expect(combined.batch).toEqual(committedState.batch)
      expect(combined.unreviewed).toEqual(committedState.unreviewed)
      expect(combined.reviews).toBe(committedState.reviews + 1)
      expect(combined.month?.costUsd).toBeCloseTo(committedState.month!.costUsd + stale.outcome!.cost!.costUsd, 6)

      // The ordinary invocation can record its billing instant just before the newer writer
      // publishes the next UTC month. The older settlement still counts against the lifetime total.
      yield* Effect.promise(async () => {
        await fs.writeFile(path.join(dir, ".vector/review.json"), JSON.stringify(ordinaryConfig))
        await trustWorkspace(dir)
      })
      const previousMonth = clock
      const nextMonth = Date.parse("2027-01-01T00:00:10Z")
      let laterState = combined
      beforeReview = () =>
        Effect.gen(function* () {
          yield* resize(1)
          clock = nextMonth
          yield* response()
          const later = yield* invoke(undefined, undefined, true, monthly)
          expect(later.outcome?.notes.join(" "), later.error).toContain("1 of 4 batches complete")
          laterState = yield* state()
          clock = previousMonth
          yield* response()
        })
      const delayed = yield* invoke(undefined, undefined, true)
      expect(delayed.exitCode, delayed.error).toBe(0)
      const afterMidnight = yield* state()
      expect(afterMidnight.month).toEqual(laterState.month)
      expect(afterMidnight.month!.key).toBe("2027-01")
      expect(afterMidnight.costUsd).toBeCloseTo(laterState.costUsd + delayed.outcome!.cost!.costUsd, 6)
      clock = nextMonth

      // A full ordinary review intentionally drops old findings, but a fresh target head must
      // still be billed against both the previously settled batch and the ordinary invocation.
      yield* Effect.promise(async () => {
        await fs.writeFile(path.join(dir, ".vector/review.json"), JSON.stringify(ordinaryConfig))
        await trustWorkspace(dir)
        await $`git commit --allow-empty -qm ordinary-known`.cwd(dir).quiet()
      })
      yield* response()
      const fresh = yield* invoke(undefined, undefined, true)
      expect(fresh.exitCode, fresh.error).toBe(0)
      const retained = yield* state()
      expect(retained.reviews).toBe(afterMidnight.reviews + 1)
      expect(retained.month!.costUsd).toBeCloseTo(afterMidnight.month!.costUsd + fresh.outcome!.cost!.costUsd, 6)
      expect(retained.costUsd).toBeCloseTo(afterMidnight.costUsd + fresh.outcome!.cost!.costUsd, 6)
      expect(retained.batch).toBeUndefined()
      yield* resize(1)
      yield* Effect.promise(() => $`git commit --allow-empty -qm funded-known`.cwd(dir).quiet())
      const requests = yield* llm.calls
      const over = yield* invoke(undefined, undefined, true, {
        ...monthly,
        REVIEW_MAX_COST_USD_PER_MONTH: String(afterMidnight.month!.costUsd),
      })
      expect(over.exitCode).toBe(2)
      expect(over.outcome?.notes.join(" "), over.error).toContain("remaining review budget is exhausted")
      expect(yield* llm.calls).toBe(requests)

      // This branch has never opted into batch settlement when its first ordinary review
      // begins. The first funded review arrives during that older run.
      yield* Effect.promise(async () => {
        await $`git checkout -qb first-batch-race`.cwd(dir).quiet()
        await fs.writeFile(path.join(dir, ".vector/review.json"), JSON.stringify(ordinaryConfig))
        await trustWorkspace(dir)
      })
      beforeReview = () =>
        Effect.gen(function* () {
          yield* resize(1)
          yield* response()
          const first = yield* invoke(undefined, undefined, false, monthly)
          expect(first.outcome?.notes.join(" "), first.error).toContain("1 of 4 batches complete")
          yield* response()
        })
      const untracked = yield* invoke(undefined, undefined, true)
      expect(untracked.exitCode, untracked.error).toBe(0)
      const newTarget = yield* Effect.promise(async () =>
        JSON.parse(await fs.readFile(path.join(path.dirname(leaf), "first-batch-race.json"), "utf8")),
      )
      expect(decodeState(newTarget.state)!.costUsd).toBeGreaterThan(untracked.outcome!.cost!.costUsd)
      expect(newTarget.batchUncertainMonth).toBe("2027-01")
      const beforeRetry = yield* llm.calls
      const unsafe = yield* invoke(undefined, undefined, false, monthly)
      expect(unsafe.outcome?.notes.join(" "), unsafe.error).toContain("prior spend could not be confirmed")
      expect(yield* llm.calls).toBe(beforeRetry)
    }),
  { git: true },
  90_000,
)

test("local cursor reads reject a linked directory, symlinked file, hard-linked file and foreign path", async () => {
  await using repo = await tmpdir({ git: true })
  const dir = repo.path
  const head = (await $`git rev-parse HEAD`.cwd(dir).quiet().text()).trim()
  const vector = path.join(dir, ".git", "vector")
  const leaf = path.join(vector, "review", "feature.json")
  if (process.platform !== "linux") {
    await expect(lockBatchFile(dir, leaf, head)).rejects.toBeDefined()
    return
  }
  await fs.mkdir(path.join(dir, "repo-content"))
  await fs.symlink(path.join(dir, "repo-content"), vector)
  await expect(lockBatchFile(dir, leaf, head)).rejects.toBeDefined()
  await fs.unlink(vector)
  await fs.mkdir(path.dirname(leaf), { mode: 0o700, recursive: true })
  const authored = path.join(dir, "repo-content", "cursor")
  await fs.writeFile(authored, "untrusted", { mode: 0o600 })
  await fs.symlink(authored, leaf)
  await expect(lockBatchFile(dir, leaf, head)).rejects.toBeDefined()
  await fs.unlink(leaf)
  await fs.link(authored, leaf)
  await expect(lockBatchFile(dir, leaf, head)).rejects.toBeDefined()
  await expect(lockBatchFile(dir, authored, head)).rejects.toBeDefined()
  expect(await fs.readFile(authored, "utf8")).toBe("untrusted")
  await fs.unlink(leaf)
  const valid = await lockBatchFile(dir, leaf, head)
  try {
    await valid.replace("first confirmed checkpoint")
    expect(await valid.read()).toBe("first confirmed checkpoint")
    await $`git commit --allow-empty -qm moved`.cwd(dir).quiet()
    await expect(valid.replace("stale checkpoint")).rejects.toBeDefined()
    expect(await fs.readFile(leaf, "utf8")).toBe("first confirmed checkpoint")
    await expect(valid.verify()).rejects.toBeDefined()
  } finally {
    await valid.close()
  }
})

test("changed policy cannot reuse coverage or reset previous spend on the same head; unknown usage remains unknown", () => {
  const base = "1".repeat(40),
    head = "2".repeat(40)
  const files = parseUnifiedDiff("diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-old\n+new")
  const plan = (policy: string, ref = head) =>
    planReviewBatches({
      base,
      head: ref,
      files,
      policy,
      limits: { maxFiles: 1, maxDiffChars: 500, maxChangedLines: 20 },
    })
  const first = plan("rules A"),
    second = plan("rules B")
  const start = startBatchCursor(first)
  const cursor = advanceBatchCursor(first, start, {
    head,
    id: first.batches[0]!.id,
    covered: first.batches[0]!.paths,
    complete: true,
  })!
  const previous = { ...emptyState(), costUsd: 8, batch: cursor }
  const metadata = { cursor, initialCostUsd: 5 }
  const { store } = localBatchStore(previous, metadata, "branch authority")
  expect(store.resume(second)).toBe("mismatch")
  expect(store.spent?.(second)).toBe(3)
  const legacy = localBatchStore({ ...emptyState(), head, reviews: 2, costUsd: 8 }, undefined, "branch authority")
  expect(legacy.store.spent?.(second)).toBeUndefined()
  expect(legacy.store.spent?.(plan("rules B", "3".repeat(40)))).toBe(0)
  expect(localBatchStore(previous, undefined, "branch authority").store.spent?.(second)).toBeUndefined()
  expect(
    localBatchStore(previous, { cursor: null, initialCostUsd: 5 }, "branch authority").store.spent?.(second),
  ).toBeUndefined()

  const restored = store.resume(first)
  expect(restored && restored !== "mismatch" && batchCoverage(first, restored)?.covered).toEqual(["a.ts"])
  expect(
    localBatchStore(previous, { ...metadata, usageMissing: true }, "branch authority").store.spent?.(second),
  ).toBeUndefined()
  const newer = plan("rules B", "3".repeat(40))
  expect(store.resume(newer)).toBeUndefined()
  expect(store.spent?.(newer)).toBe(0)
  const journal = { ...previous, inflight: { head, run: "batch:" + first.id, at: Date.now(), costUsd: 0 } }
  const interrupted = localBatchStore(journal, metadata, "branch authority")
  expect(interrupted.store.spent?.(first)).toBeUndefined()
  expect(interrupted.store.spent?.(newer, true)).toBeUndefined()
  expect(interrupted.store.spent?.(newer, false)).toBe(0)
  interrupted.store.record(first, cursor, undefined)
  const retried = localBatchStore(previous, interrupted.metadata, "branch authority")
  expect(retried.store.spent?.(first)).toBeUndefined()
  expect(retried.store.spent?.(newer, true)).toBeUndefined()

  // Known token counts don't give unpriced work an exact dollar value. A partially settled
  // priced run can likewise contain an exact charge and an additional unknown one.
  const settled = Date.parse("2026-10-31T23:59:40Z")
  for (const price of [{ kind: "unknown" as const }, { kind: "priced" as const, partial: true }]) {
    const source = localBatchStore(previous, metadata, "branch authority", true, undefined, { now: () => settled })
    source.store.record(first, cursor, {
      ...price,
      model: "fixture",
      costUsd: 2,
      input: 100,
      output: 15,
      cacheRead: 0,
      cacheWrite: 0,
      reasoning: 0,
    })
    expect(source.metadata?.usageMissing).toBe(true)
    expect(source.metadata?.uncertainMonth).toBe("2026-10")
    const knownLowerBound = { ...previous, costUsd: 10 }
    const current = localBatchStore(knownLowerBound, source.metadata, "branch authority", true, undefined, {
      now: () => settled,
    })
    expect(current.store.spent?.(first, true, false)).toBeUndefined()
    const following = localBatchStore(knownLowerBound, source.metadata, "branch authority", true, undefined, {
      now: () => Date.parse("2026-11-01T00:00:05Z"),
    })
    expect(following.store.spent?.(first, true, false)).toBe(0)
    expect(following.store.spent?.(first, false, true)).toBeUndefined()
    expect(following.store.spent?.(first, true, true)).toBeUndefined()
  }
})
