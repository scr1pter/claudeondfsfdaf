import { $ } from "bun"
import { expect } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { Effect } from "effect"
import { Brain } from "@vectordevai/core/brain/brain"
import { Instruction } from "@/session/instruction"
import { LayerNode } from "@vectordevai/core/effect/layer-node"
import { ModelV2 } from "@vectordevai/core/model"
import { ProviderV2 } from "@vectordevai/core/provider"
import { selectFindings } from "@vectordevai/core/review/select"
import { decodeState, encodeState } from "@vectordevai/core/review/state"
import type { ReviewOutcome } from "@vectordevai/core/review/types"
import { SpendGuard } from "@vectordevai/core/spend-guard"
import { executeLocalReview, type LocalReviewDeps, type LocalReviewOptions } from "@/cli/cmd/review"
import { Config } from "@/config/config"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Git } from "@/git"
import { Permission } from "@/permission"
import { Provider } from "@/provider/provider"
import { Review } from "@/review/run"
import { SessionPrompt } from "@/session/prompt"
import { Session } from "@/session/session"
import { TestInstance, trustWorkspace } from "../fixture/fixture"
import { firstUserText } from "../fixture/projection"
import { testEffect } from "../lib/effect"
import { TestLLMServer, reply } from "../lib/llm-server"
import { testProviderConfig } from "../lib/test-provider"

const it = testEffect(
  LayerNode.compile(
    LayerNode.group([
      Config.node,
      Brain.node,
      Instruction.node,
      SessionPrompt.node,
      Session.node,
      SpendGuard.node,
      Permission.node,
      Provider.node,
      EventV2Bridge.node,
      Git.node,
      LayerNode.make({
        service: TestLLMServer,
        layer: TestLLMServer.loopback,
        deps: [],
      }),
    ]),
  ),
)
const selected = {
  providerID: ProviderV2.ID.make("lmstudio"),
  modelID: ModelV2.ID.make("test-model"),
  context: 100_000,
  costKind: "local",
} as const
const setup = Effect.gen(function* () {
  const { directory } = yield* TestInstance
  const llm = yield* TestLLMServer
  const git = (...args: string[]) =>
    $`git ${args}`
      .cwd(directory)
      .quiet()
      .text()
      .then((s) => s.trim())
  const cache = path.join(directory, ".git/vector/review/feature.json")
  const { base, head } = yield* Effect.promise(async () => {
    await fs.writeFile(path.join(directory, "vector.json"), JSON.stringify(testProviderConfig(llm.url)))
    await trustWorkspace(directory)
    await git("branch", "-M", "main")
    const base = await git("rev-parse", "HEAD")
    await git("checkout", "-qb", "feature")
    await fs.writeFile(path.join(directory, "one.ts"), "export const one = 1\n")
    await git("add", "one.ts")
    await git("commit", "-qm", "feature")
    return { base, head: await git("rev-parse", "HEAD") }
  })
  const invoke = <R>(
    runReview: LocalReviewDeps<R>["runReview"],
    input: Partial<LocalReviewOptions> = {},
    guardrail: "strict" | "off" | undefined = "strict",
  ) =>
    Effect.gen(function* () {
      const chunks: string[] = []
      const result = yield* executeLocalReview(
        {
          directory,
          base: "main",
          model: "lmstudio/test-model",
          json: true,
          env: {
            REVIEW_SECURITY: "off",
            REVIEW_VERIFY: "off",
            ...(guardrail === undefined ? {} : { REVIEW_GUARDRAIL: guardrail }),
          },
          ...input,
        },
        {
          runReview,
          resolveModel: () => Effect.succeed(selected),
          color: false,
          stdout: async (text) => {
            chunks.push(text)
          },
          stderr: () => {},
          confirm: async () => false,
          posting: async ({ parts }) => parts,
          now: () => 1_700_000_000_000,
        },
      )
      return { result, text: chunks.join("") }
    })
  return { directory, cache, git, base, head, invoke, llm }
})

it.instance(
  "the local JSON command runs a real strict reviewer and reprints its complete result for the same commit",
  () =>
    Effect.gen(function* () {
      const { head, invoke, llm, cache } = yield* setup
      yield* llm.respond((hit) => {
        if (firstUserText(hit.body).includes("You are Vector's code reviewer"))
          return reply().tool("StructuredOutput", {
            summary: "No blocking findings.",
            risk: "low",
            files: [],
            findings: [],
          })
      })
      const first = yield* invoke(Review.run)
      expect(first.result.error).toBeUndefined()
      const initial = JSON.parse(first.text)
      expect(initial.version).toBe(1)
      expect(initial.target.head).toBe(head)
      expect(initial.outcome.strict).toEqual({
        version: 1,
        head,
        complete: true,
        findings: [],
        dropped: [],
        fixUnchecked: 0,
      })
      const before = (yield* llm.hits).length
      expect(before).toBeGreaterThan(0)
      const again = yield* invoke(Review.run)
      expect(JSON.parse(again.text)).toMatchObject({
        cached: true,
        outcome: { strict: initial.outcome.strict },
      })
      expect((yield* llm.hits).length).toBe(before)
      const record = yield* Effect.promise(async () => JSON.parse(await fs.readFile(cache, "utf8")))
      expect(record.strictPolicy).toMatch(/^[a-f0-9]{64}$/)
    }),
  { git: true },
  90000,
)

function fixed(input: Review.RunInput): ReviewOutcome {
  const selection = selectFindings({
    findings: [],
    head: input.head,
    trust: input.trust,
    config: input.config,
    anchors: input.anchors,
    mode: input.mode,
    prior: input.prior,
  })
  const strict =
    input.config.guardrail === "strict"
      ? {
          version: 1 as const,
          head: input.head,
          complete: true,
          findings: [],
          dropped: [],
          fixUnchecked: 0,
        }
      : undefined
  return {
    base: input.base,
    head: input.head,
    mode: input.mode,
    report: {
      summary: "No new finding.",
      risk: "low",
      files: [],
      findings: [],
    },
    selection: {
      ...selection,
      ...(strict ? { strict: { complete: true, findingCount: 0, dropped: [] } } : {}),
    },
    ...(strict ? { strict } : {}),
    sessions: [],
    specialists: [{ name: "review", steps: 1, status: "ok" }],
    skipped: input.skipped,
    notes: [],
    unreviewed: [],
    stats: { files: input.files.length, additions: 1, deletions: 0 },
    durationMs: 0,
    cost: {
      model: "lmstudio/test-model",
      kind: "priced",
      costUsd: 0.125,
      input: 12,
      output: 4,
      reasoning: 0,
      cacheRead: 0,
      cacheWrite: 0,
    },
  }
}

it.instance(
  "strict cache binds mode, head, merge-base and policy; invalid records retain history and spend through a full retry",
  () =>
    Effect.gen(function* () {
      const { directory, head, base, cache, git, invoke } = yield* setup
      const calls: Review.RunInput[] = []
      const run = (input: Review.RunInput) =>
        Effect.sync(() => {
          calls.push(input)
          return fixed(input)
        })
      const read = () => Effect.promise(async () => JSON.parse(await fs.readFile(cache, "utf8")))
      const change = (edit: (record: any) => void) =>
        Effect.promise(async () => {
          const stored = JSON.parse(await fs.readFile(cache, "utf8"))
          edit(stored)
          await fs.writeFile(cache, JSON.stringify(stored))
        })
      const full = (extra?: Partial<LocalReviewOptions>) =>
        Effect.gen(function* () {
          const n = calls.length
          const { text, result } = yield* invoke(run, extra)
          expect(result.error).toBeUndefined()
          expect(JSON.parse(text).cached).toBeUndefined()
          expect(calls).toHaveLength(n + 1)
          expect(calls.at(-1)!.mode).toBe("full")
          return result
        })
      // Stable off output includes no strict property or new record field. Compare the complete JSON, including whitespace.
      const unset = yield* invoke(run, {
        full: true,
        env: { REVIEW_SECURITY: "off", REVIEW_VERIFY: "off" },
      })
      const off = yield* invoke(run, { full: true }, "off")
      expect(off.text).toBe(unset.text)
      expect(JSON.parse(off.text).outcome).not.toHaveProperty("strict")
      expect(yield* read()).not.toHaveProperty("strictPolicy")
      yield* change((record) => {
        const state = decodeState(record.state)!
        state.findings.push({
          id: "123456789abc",
          path: "one.ts",
          line: 1,
          side: "RIGHT",
          severity: "concern",
          category: "bug",
          title: "Earlier unresolved finding",
          sha: head.slice(0, 7),
          status: "open",
        })
        record.state = encodeState(state)
      })
      yield* full()
      expect(calls.at(-1)!.prior.map((finding) => finding.id)).toContain("123456789abc")
      const original = yield* read()
      expect(decodeState(original.state)!.findings.map((finding) => finding.id)).toContain("123456789abc")
      expect(decodeState(original.state)!.costUsd).toBe(0.25)
      expect(JSON.parse((yield* invoke(run)).text).cached).toBe(true)
      const settings = yield* Config.Service
      const configured = yield* settings.get()
      const withSettings = (patch: Partial<typeof configured>) =>
        Effect.provideService(Config.Service, { ...settings, get: () => Effect.succeed({ ...configured, ...patch }) })
      yield* full().pipe(withSettings({ permission: { read: "deny" } }))
      yield* full().pipe(withSettings({ instructions: ["local-review-notes.md"] }))
      yield* full().pipe(withSettings({ instructions: ["local-review-notes.md"] }))
      // Provider history can change between two invocations with no model selected in flags or settings.
      yield* full({ model: undefined })
      yield* full({ model: undefined })
      yield* full()
      const privateState = yield* Effect.promise(() => fs.readFile(cache, "utf8"))
      const restricted = yield* invoke(run, {
        context: {
          expectedHead: head,
          settingsRef: base,
          stateless: false,
          readDenies: [path.join(directory, "one.ts")],
        },
      })
      expect(restricted.result.exitCode).toBe(2)
      expect(restricted.result.outcome).toBeUndefined()
      expect(restricted.text).not.toContain("Earlier unresolved finding")
      expect(yield* Effect.promise(() => fs.readFile(cache, "utf8"))).toBe(privateState)
      yield* change((record) => {
        delete record.strictPolicy
      })
      yield* full()
      yield* change((record) => {
        delete record.outcome.strict
      })
      yield* full()
      yield* change((record) => {
        record.outcome.strict.complete = false
        record.outcome.strict.incomplete = ["unreviewed"]
      })
      yield* full()
      yield* change((record) => {
        record.outcome.strict.findings = [{ malformed: true }]
      })
      yield* full()
      yield* change((record) => {
        record.outcome.base = head
      })
      yield* full()
      // The caller may change a rule in the working tree without moving the immutable review target.
      yield* Effect.promise(async () => {
        await fs.mkdir(path.join(directory, ".vector"), { recursive: true })
        await fs.writeFile(path.join(directory, ".vector", "review.md"), "Always check for empty input.\n")
      })
      yield* full()
      yield* full({ maxComments: 1 })
      const advanced = yield* Effect.promise(async () => {
        await fs.writeFile(path.join(directory, "two.ts"), "export const two = 2\n")
        await git("add", "two.ts")
        await git("commit", "-qm", "advance")
        return git("rev-parse", "HEAD")
      })
      yield* full({ maxComments: 1 })
      expect(
        calls
          .at(-1)!
          .files.map((file) => file.path)
          .sort(),
      ).toEqual(["one.ts", "two.ts"])
      // The base ref moves independently of this head. A valid result for the previous base cannot certify the smaller range.
      yield* Effect.promise(() => git("update-ref", "refs/heads/main", head, base))
      yield* full({ maxComments: 1 })
      expect(calls.at(-1)!.files.map((file) => file.path)).toEqual(["two.ts"])
      const strictState = yield* read()
      expect(decodeState(strictState.state)!.head).toBe(advanced)
      // A damaged strict record may retain only its selection summary; it must not replay as an ordinary result.
      yield* change((record) => {
        delete record.strictPolicy
        delete record.outcome.strict
      })
      const count = calls.length
      const normal = yield* invoke(run, { maxComments: 1 }, "off")
      expect(JSON.parse(normal.text).outcome).not.toHaveProperty("strict")
      expect(calls).toHaveLength(count + 1)
      expect(calls.at(-1)!.mode).toBe("full")
      expect(yield* read()).not.toHaveProperty("strictPolicy")
      expect(decodeState((yield* read()).state)!.costUsd).toBe(decodeState(strictState.state)!.costUsd + 0.125)
    }),
  { git: true },
  90000,
)

it.instance(
  "same-head local review checks trusted rules afresh and cannot replay them after disabling the policy",
  () =>
    Effect.gen(function* () {
      const { directory, cache, invoke, git, base } = yield* setup
      const ownerRule = "Preserve input order."
      yield* Effect.promise(async () => {
        await fs.mkdir(path.join(directory, ".vector"), { recursive: true })
        await fs.writeFile(path.join(directory, "AGENTS.md"), ownerRule)
        await fs.writeFile(path.join(directory, ".vector/review.md"), "Preserve public exports.")
        await fs.writeFile(
          path.join(directory, ".vector/review.json"),
          JSON.stringify({
            ruleCheck: "strict",
            paths: [{ path: "*.ts", instructions: "Keep the existing call order." }],
          }),
        )
        await git("add", "AGENTS.md", ".vector/review.md", ".vector/review.json")
        await git("commit", "-qm", "rules in reviewed head")
      })
      const head = yield* Effect.promise(() => git("rev-parse", "HEAD"))
      const service = yield* Config.Service
      const global = yield* service.getGlobal()
      const calls: Review.RunInput[] = []
      const run = (input: Review.RunInput) =>
        Effect.sync(() => {
          calls.push(input)
          return fixed(input)
        })
      const review = (enabled: boolean, options: Partial<LocalReviewOptions> = {}) =>
        invoke(run, options, "off").pipe(
          Effect.provideService(Config.Service, {
            ...service,
            getGlobal: () =>
              Effect.succeed({ ...global, review: { ...global.review, ruleCheck: enabled ? "strict" : "off" } }),
          }),
        )
      expect((yield* review(false)).result.error).toBeUndefined()
      expect(JSON.parse((yield* review(false)).text).cached).toBe(true)
      for (const active of [true, true, false]) {
        const count = calls.length
        const result = yield* review(active)
        expect(result.result.error).toBeUndefined()
        expect(calls).toHaveLength(count + 1)
        expect(calls.at(-1)!.mode).toBe("full")
        const call = calls.at(-1)!
        expect(call.config.ruleCheck).toBe(active ? "strict" : undefined)
        if (active) {
          expect(call.context.instructions).toContain(ownerRule)
          expect(call.rules).toContain("Preserve public exports.")
          expect(call.rulesSource).toBe("working tree")
        }
        expect(JSON.parse(yield* Effect.promise(() => fs.readFile(cache, "utf8"))).checkedRules).toBe(
          active || undefined,
        )
      }
      expect(JSON.parse((yield* review(false)).text).cached).toBe(true)
      const pinned = (settingsRef: string) => ({ context: { expectedHead: head, settingsRef, stateless: true } })
      expect((yield* review(false, pinned(head))).result.error).toBeUndefined()
      expect(calls.at(-1)!.config.ruleCheck).toBeUndefined()
      expect((yield* review(true, pinned(head))).result.error).toBeUndefined()
      expect(calls.at(-1)!.rules).toBe("")
      expect(calls.at(-1)!.context.instructions).toBeUndefined()
      expect((yield* review(true, pinned(base))).result.error).toBeUndefined()
      expect(calls.at(-1)!.context.instructions ?? "").not.toContain(ownerRule)
      expect(calls.at(-1)!.rulesSource).toBe("base branch")
      if (process.platform !== "win32") {
        yield* Effect.promise(async () => {
          await fs.unlink(path.join(directory, "AGENTS.md"))
          await fs.symlink(path.join(directory, "one.ts"), path.join(directory, "AGENTS.md"))
        })
        expect((yield* review(true)).result.error).toBeUndefined()
        expect(calls.at(-1)!.context.instructions ?? "").not.toContain("export const one")
      }
    }),
  { git: true },
)

it.instance(
  "an edited working instruction invalidates the same-head strict result",
  () =>
    Effect.gen(function* () {
      const { directory, invoke, llm } = yield* setup
      const sentinel = "Check nulls in arithmetic. WORKTREE_INSTRUCTION_FIXTURE."
      yield* llm.respond((hit) => {
        if (firstUserText(hit.body).includes("You are Vector's code reviewer"))
          return reply().tool("StructuredOutput", {
            summary: "No blocking findings.",
            risk: "low",
            files: [],
            findings: [],
          })
      })
      const initial = yield* invoke(Review.run)
      expect(initial.result.outcome?.strict?.complete).toBe(true)
      const before = (yield* llm.hits).length
      expect(before).toBeGreaterThan(0)
      yield* Effect.promise(() => fs.writeFile(path.join(directory, "AGENTS.md"), sentinel))
      // A forced recheck establishes that the same command really does send this instruction to the same model.
      const cached = yield* invoke(Review.run)
      const hits = (yield* llm.hits).length
      const forced = yield* invoke(Review.run, { full: true })
      expect(forced.result.outcome?.strict?.complete).toBe(true)
      expect(JSON.stringify(yield* llm.inputs)).toContain(sentinel)
      expect(JSON.parse(cached.text).cached).toBeUndefined()
      expect(hits).toBeGreaterThan(before)
    }),
  { git: true },
  90_000,
)

it.instance(
  "same-head instruction authority changes force a full strict retry before range planning",
  () =>
    Effect.gen(function* () {
      const { directory, invoke, cache } = yield* setup
      const runs: string[] = []
      const run = (input: Review.RunInput) =>
        Effect.sync(() => {
          runs.push(input.mode)
          return fixed(input)
        })
      const current = () => invoke(run)
      const first = yield* current()
      expect(first.result.error).toBeUndefined()
      expect(JSON.parse((yield* current()).text).cached).toBe(true)
      for (const name of ["AGENTS.md", "CLAUDE.md", ".vector/RULES.md"]) {
        const sentinel = "Instruction fixture for " + name
        yield* Effect.promise(async () => {
          await fs.mkdir(path.join(directory, ".vector"), { recursive: true })
          await fs.writeFile(path.join(directory, name), sentinel)
        })
        const count = runs.length
        const fresh = yield* current()
        expect(fresh.result.error).toBeUndefined()
        expect(JSON.parse(fresh.text).cached).toBeUndefined()
        expect(runs.slice(count)).toEqual(["full"])
        expect(yield* Effect.promise(() => fs.readFile(cache, "utf8"))).not.toContain(sentinel)
        yield* Effect.promise(() => fs.unlink(path.join(directory, name)))
      }
      const instruction = yield* Instruction.Service
      const changedGlobal = yield* current().pipe(
        Effect.provideService(Instruction.Service, {
          ...instruction,
          contents: () => Effect.succeed({ work: [], private: ["Owner rule fixture"] }),
        }),
      )
      expect(JSON.parse(changedGlobal.text).cached).toBeUndefined()
      const unavailable = yield* current().pipe(Effect.provideService(Instruction.Service, {
        ...instruction, contents: () => Effect.die("instruction snapshot unavailable"),
      }))
      expect(unavailable.result.error).toBeUndefined()
      expect(JSON.parse(unavailable.text).cached).toBeUndefined()
    }),
  { git: true },
  90_000,
)
