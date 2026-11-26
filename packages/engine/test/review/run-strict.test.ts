import { $ } from "bun"
import { expect } from "bun:test"
import path from "node:path"
import { Effect } from "effect"
import { CrossSpawnSpawner } from "@vectordevai/core/cross-spawn-spawner"
import { LayerNode } from "@vectordevai/core/effect/layer-node"
import { FSUtil } from "@vectordevai/core/fs-util"
import { ModelV2 } from "@vectordevai/core/model"
import { ProviderV2 } from "@vectordevai/core/provider"
import { parseUnifiedDiff } from "@vectordevai/core/review/diff"
import { buildInlineBody, buildSummaryBody } from "@vectordevai/core/review/format"
import { INTRODUCED_SCOPE } from "@vectordevai/core/review/prompt"
import { strictResultJsonSchema } from "@vectordevai/core/review/schema"
import {
  DEFAULT_REVIEW_CONFIG,
  FAILURE_CLASSES,
  type ModelFinding,
  type ModelReport,
  type ReviewOutcome,
} from "@vectordevai/core/review/types"
import { reviewVerdict } from "@vectordevai/core/review/verdict"
import { SpendGuard } from "@vectordevai/core/spend-guard"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Git } from "@/git"
import { Permission } from "@/permission"
import { Provider } from "@/provider/provider"
import { MCP } from "@/mcp"
import { ReviewMcp } from "@/review/mcp"
import { ReviewMcpSnapshot as Snap } from "@/review/mcp-snapshot"
import { Review } from "@/review/run"
import { ReviewSource } from "@/review/source"
import { ReviewTrivial } from "@/review/trivial"
import { SessionPrompt } from "@/session/prompt"
import { SessionID } from "@/session/schema"
import { Session } from "@/session/session"
import { TestInstance, tmpdirScoped, trustWorkspace } from "../fixture/fixture"
import { firstUserText, projectionVerdicts } from "../fixture/projection"
import { testEffect } from "../lib/effect"
import { TestLLMServer, httpError, reply } from "../lib/llm-server"
import { testProviderConfig } from "../lib/test-provider"
import { violations } from "../../../core/test/review/fixtures/json-schema"

const it = testEffect(
  LayerNode.compile(
    LayerNode.group([
      SessionPrompt.node,
      MCP.node,
      Session.node,
      SpendGuard.node,
      Permission.node,
      Provider.node,
      EventV2Bridge.node,
      Git.node,
      FSUtil.node,
      CrossSpawnSpawner.node,
      LayerNode.make({ service: TestLLMServer, layer: TestLLMServer.loopback, deps: [] }),
    ]),
  ),
)

const file = "src/last.ts"
const original = "  return values[values.length - 1]"
const changed = "  return values[values.length].toUpperCase()"
const dirty = '  return "working tree only"'
const source = (line: string) => `export function last(values: string[]) {\n${line}\n}\n`
const finding: ModelFinding = {
  path: file,
  line: 2,
  side: "RIGHT",
  severity: "blocking",
  category: "bug",
  title: "Reading past the array throws",
  body: "A nonempty array has no item at its length. Fix: read the prior element instead.",
  confidence: 0.98,
  suggestion: original,
  failure: {
    class: "crash",
    mechanism: "logic",
    trigger: "Call last with a nonempty array.",
    impact: "The call throws before returning a string.",
  },
  quotes: [
    { path: file, line: 2, side: "RIGHT", code: changed },
    { path: file, line: 2, side: "LEFT", code: original },
  ],
}

const git = (cwd: string, ...args: string[]) =>
  Effect.promise(() => $`git ${args}`.cwd(cwd).quiet().text()).pipe(Effect.map((out) => out.trimEnd()))
const strict = { guardrail: "strict" } as const
const config = { ...DEFAULT_REVIEW_CONFIG, security: "off", verify: "off", minSeverity: "nit", nits: true } as const

const checkoutWith = Effect.fnUntraced(function* (helper = false) {
  const { directory } = yield* TestInstance
  const fs = yield* FSUtil.Service
  const llm = yield* TestLLMServer
  yield* fs.writeWithDirs(path.join(directory, "vector.json"), JSON.stringify(testProviderConfig(llm.url)))
  yield* Effect.promise(() => trustWorkspace(directory))
  const write = (text: string) => fs.writeWithDirs(path.join(directory, file), source(text))
  yield* write(original)
  if (helper) {
    yield* fs.writeWithDirs(path.join(directory, "src/old-helper.ts"), "export const oldHelper = () => null\n")
    // Only the base version is invalid UTF-8. Its distant comment leaves the head quote on line 1 unchanged.
    yield* Effect.promise(() =>
      Bun.write(
        path.join(directory, "src/old-history.ts"),
        Buffer.concat([
          Buffer.from("export const history = () => null\n\n\n\n// "),
          Buffer.from([255]),
          Buffer.from("\n"),
        ]),
      ),
    )
    yield* git(directory, "add", "src/old-helper.ts", "src/old-history.ts")
  }
  yield* git(directory, "add", file)
  yield* git(directory, "commit", "-qm", "base")
  const base = yield* git(directory, "rev-parse", "HEAD")
  yield* write(changed)
  if (helper) {
    yield* fs.writeWithDirs(
      path.join(directory, "src/old-history.ts"),
      "export const history = () => null\n\n\n\n// updated\n",
    )
    yield* git(directory, "add", "src/old-history.ts")
  }
  yield* git(directory, "add", file)
  yield* git(directory, "commit", "-qm", "change last")
  const head = yield* git(directory, "rev-parse", "HEAD")
  const files = parseUnifiedDiff(yield* git(directory, "diff", "--no-color", "--no-ext-diff", base, head))
  yield* git(directory, "checkout", "--detach", base)
  yield* write(dirty)
  const input: Review.RunInput = {
    directory,
    trigger: "command",
    trust: "untrusted",
    base,
    head,
    mode: "full",
    files,
    anchors: files,
    skipped: [],
    context: {},
    prior: [],
    rules: "",
    config,
    model: {
      providerID: ProviderV2.ID.make("lmstudio"),
      modelID: ModelV2.ID.make("test-model"),
      context: 100_000,
      costKind: "local",
    },
    knownPath: async (candidate) => candidate === file,
  }
  const run = (
    findings: (Omit<ModelFinding, "rule"> & { rule?: unknown })[],
    overrides: Partial<Review.RunInput> = {},
    verdicts: ((prompt: string) => unknown[]) | "unavailable" = projectionVerdicts,
    priorStatus?: ModelReport["priorStatus"],
  ) =>
    Effect.gen(function* () {
      yield* llm.reset
      yield* llm.respond((hit) => {
        const prompt = firstUserText(hit.body)
        if (prompt.includes("You are checking candidate findings")) {
          if (verdicts === "unavailable") return httpError(400, { error: { message: "Checker unavailable" } })
          return reply().tool("StructuredOutput", { results: verdicts(prompt) })
        }
        if (prompt.includes("You are Vector's code reviewer"))
          return reply().tool("StructuredOutput", {
            summary: "Reviews the indexing change.",
            risk: "high",
            files: [],
            findings,
            ...(priorStatus ? { priorStatus } : {}),
          })
      })
      const outcome = yield* Review.run({ ...input, ...overrides })
      const hits = (yield* llm.hits).filter((hit) => !hit.text.includes("Generate a title for this conversation"))
      const { durationMs, sessions: ids, ...stable } = outcome
      expect(durationMs).toBeGreaterThanOrEqual(0)
      const sessions = yield* Session.Service
      const permissions = yield* Effect.forEach(ids, (id) =>
        sessions.get(SessionID.make(id)).pipe(Effect.map((session) => session.permission)),
      )
      const summary = buildSummaryBody({
        head: outcome.head,
        baseRef: "main",
        mode: outcome.mode,
        report: outcome.report,
        selection: outcome.selection,
        strict: outcome.strict,
        trivial: outcome.trivial,
        skipped: outcome.skipped,
        notes: outcome.notes,
      })
      return { outcome, hits, summary, parity: { bodies: hits.map((hit) => hit.text), permissions, stable, summary } }
    })
  return { input, run }
})

const checkout = checkoutWith()

const listed = (outcome: ReviewOutcome) =>
  [
    ...outcome.selection.inline,
    ...outcome.selection.outsideDiff,
    ...outcome.selection.elsewhere,
    ...outcome.selection.nits,
    ...outcome.selection.overflow,
  ].map((item) => item.title)

function checked(outcome: ReviewOutcome) {
  const encoded = JSON.parse(JSON.stringify(outcome)).strict
  const schema = strictResultJsonSchema(strict)!
  expect(violations(schema, encoded)).toEqual([])
  expect(violations(schema, { ...encoded, version: 2 })).toHaveLength(1)
  expect(violations(schema, { ...encoded, version: "1" })).toHaveLength(1)
  expect(encoded).toEqual(outcome.strict)
  return outcome.strict!
}

it.instance(
  "takes owner-fixed MCP snapshots before the first model request and exposes them only as untrusted context",
  () =>
    Effect.gen(function* () {
      const { input, run } = yield* checkout
      const owner = { owner: "owner", repository: "repository", server: "handbook" }
      const uri = "docs://handbook/fixed"
      const identity = {
        serverIdentity: "handbook",
        endpointHash: ReviewMcp.digest(["endpoint"]),
        capabilitiesHash: ReviewMcp.digest(["capabilities"]),
      }
      const capability = { kind: "resource" as const, id: uri, schemaHash: ReviewMcp.digest(["schema"]) }
      const seen: string[] = []
      const generation = { id: Symbol() }
      const mcp = yield* MCP.Service
      const authority: Snap.Authority = {
        directory: input.directory,
        selections: [{ context: owner, uri }],
        grants: () => [{ ...owner, ...identity, selected: [{ ...capability, access: "read" }] }],
        reader: () => ({
          identity,
          schemaHash: capability.schemaHash,
          readOnce: async (request) => {
            seen.push(request.uri)
            return {
              uri,
              bytes: (async function* () {
                yield new TextEncoder().encode("scope owner context")
              })(),
            }
          },
        }),
      }
      const trigger = { pr: { title: "MODEL_QUERY", body: "CURSOR", commits: ["FOLLOW_REDIRECT"] } }
      const out = yield* run([], trigger).pipe(
        Effect.provideService(Snap.Trusted, authority),
        Effect.provideService(MCP.Service, { ...mcp, reviewSnapshotGeneration: () => Effect.succeed(generation) }),
      )
      expect(out.hits).toHaveLength(1)
      expect(firstUserText(out.hits[0]!.body)).toContain(
        "<untrusted_mcp_snapshot>\nscope owner context\n</untrusted_mcp_snapshot>",
      )
      expect(seen).toEqual([uri])
      const unavailable = yield* run([], trigger).pipe(Effect.provideService(Snap.Trusted, authority))
      expect(unavailable.outcome.notes).toContain(Snap.unavailable)
      expect(firstUserText(unavailable.hits[0]!.body)).not.toContain("<untrusted_mcp_snapshot>")
      const stopped = yield* run([], { ...trigger, config: { ...config, maxInputTokens: 1 } }).pipe(
        Effect.provideService(Snap.Trusted, authority),
      )
      expect(stopped.hits).toHaveLength(0)
      expect(stopped.outcome.partial).toBe("budget-estimate")
      expect(stopped.outcome.notes).toContain(Snap.unavailable)

      // Both checkouts have the same immutable commits. Even matching SHAs cannot give one the other's connector.
      const other = yield* tmpdirScoped()
      yield* git(other, "clone", "--local", "--no-hardlinks", "--", input.directory, ".")
      let probes = 0
      for (const selected of [input.directory, other]) {
        const mismatch = yield* run([], { ...trigger, directory: other }).pipe(
          Effect.provideService(Snap.Trusted, { ...authority, directory: selected }),
          Effect.provideService(MCP.Service, {
            ...mcp,
            reviewSnapshotGeneration: () =>
              Effect.sync(() => {
                probes++
                return generation
              }),
          }),
        )
        expect(mismatch.outcome.notes).toContain(Snap.unavailable)
        expect(firstUserText(mismatch.hits[0]!.body)).not.toContain("<untrusted_mcp_snapshot>")
      }
      expect(probes).toBe(0)
      expect(seen).toEqual([uri])
    }),
  { git: true },
  90_000,
)

const native = process.platform === "linux" ? it.instance : it.instance.skip

it.instance(
  "scope wire D3 keeps ordinary and strict requests stable until both keys are on",
  () =>
    Effect.gen(function* () {
      const { run } = yield* checkout
      const labelled = { ...finding, scope: "pre-existing" as const }
      const ordinary = yield* run([labelled])
      const ignored = yield* run([labelled], { config: { ...config, scopeGate: "introduced" } })
      expect(ignored.parity).toEqual(ordinary.parity)
      const plain = yield* run([labelled], { config: { ...config, ...strict } })
      const off = yield* run([labelled], { config: { ...config, ...strict, scopeGate: "off" } })
      expect(off.parity).toEqual(plain.parity)
      const enabled = yield* run([labelled], { config: { ...config, ...strict, scopeGate: "introduced" } })
      for (const hit of enabled.hits) expect(firstUserText(hit.body)).toContain(INTRODUCED_SCOPE)
      expect(enabled.hits).toHaveLength(2)
      const schema = (enabled.hits[0]!.body.tools as { function?: { name?: string; parameters?: unknown } }[]).find(
        (tool) => tool.function?.name === "StructuredOutput",
      )?.function?.parameters
      expect(schema).toMatchObject({
        properties: {
          findings: { items: { properties: { scope: { enum: ["introduced", "exacerbated", "pre-existing"] } } } },
        },
      })
      expect(firstUserText(enabled.hits[1]!.body)).toContain("Claimed scope: pre-existing")
      for (const hit of [...plain.hits, ...ordinary.hits]) {
        expect(firstUserText(hit.body)).not.toContain(INTRODUCED_SCOPE)
        expect(hit.text).not.toContain("Required on blocking findings. Does this change")
      }
    }),
  { git: true },
  90_000,
)

native(
  "fork checkout applies S9 from immutable base and head without publishing dropped finding details",
  () =>
    Effect.gen(function* () {
      const { input, run } = yield* checkoutWith(true)
      const old = {
        ...finding,
        title: "The helper already fails",
        scope: "introduced" as const,
        quotes: [
          { path: "src/old-helper.ts", line: 1, side: "RIGHT" as const, code: "export const oldHelper = () => null" },
        ],
      }
      const worse = { ...finding, scope: "exacerbated" as const }
      const labelled = {
        ...finding,
        title: "The model calls this pre-existing",
        scope: "pre-existing" as const,
        quotes: [{ path: file, line: 2, side: "RIGHT" as const, code: changed }],
      }
      const events: Review.Observation[] = []
      const result = yield* run([old, worse, labelled], {
        config: { ...config, ...strict, scopeGate: "introduced" },
        observe: (event) => events.push(event),
      })
      expect(listed(result.outcome)).toEqual([worse.title])
      expect(result.outcome.strict?.dropped).toEqual([{ reason: "pre-existing", count: 2 }])
      const id = Review.normalizeFindings([old], "review", input.anchors)[0]!.id
      expect(events.filter((event) => event.type === "scope-drops")).toEqual([
        {
          type: "scope-drops",
          base: input.base,
          drops: [{ path: "src/old-helper.ts", start: 1, end: 1, class: "bug", fingerprint: id }],
        },
      ])
      expect(result.summary).toContain("2 pre-existing")
      for (const hidden of [old.title, labelled.title, id]) {
        expect(result.summary).not.toContain(hidden)
        expect(JSON.stringify(result.outcome)).not.toContain(hidden)
      }
      const retained = {
        ...old,
        quotes: [
          { path: "src/old-history.ts", line: 1, side: "RIGHT" as const, code: "export const history = () => null" },
        ],
      }
      const unknown = yield* run([retained], { config: { ...config, ...strict, scopeGate: "introduced" } })
      expect(listed(unknown.outcome)).toEqual([old.title])
      expect(unknown.outcome.strict?.dropped).toEqual([])
      expect(unknown.outcome.notes.join(" ")).toContain("merge-base evidence was unavailable for 1 retained finding")
    }),
  { git: true },
  90_000,
)

native(
  "strict sends its schema and verify-all policy, then posts only findings supported by immutable head and base quotes",
  () =>
    Effect.gen(function* () {
      const { input, run } = yield* checkout
      const forged: ModelFinding = {
        ...finding,
        title: "Only the dirty worktree has this claim",
        quotes: [{ path: file, line: 2, side: "RIGHT", code: dirty }],
      }
      const concern: ModelFinding = { ...finding, severity: "concern", title: "A concern cannot become blocking" }
      const nit: ModelFinding = { ...finding, severity: "nit", title: "Suggestion-only nit" }
      const candidates = [finding, forged, concern, nit]
      const result = yield* run(candidates, { config: { ...config, ...strict } })
      expect(result.outcome.specialists.map((item) => [item.name, item.status])).toEqual([
        ["review", "ok"],
        ["verify", "ok"],
      ])
      expect(result.hits).toHaveLength(2)
      const review = result.hits[0]!
      for (const value of FAILURE_CLASSES) expect(firstUserText(review.body)).toContain(value)
      const schema = (review.body.tools as { function?: { name?: string; parameters?: unknown } }[]).find(
        (tool) => tool.function?.name === "StructuredOutput",
      )?.function?.parameters
      expect(schema).toMatchObject({
        properties: {
          findings: {
            items: {
              properties: {
                failure: { properties: { class: { enum: [...FAILURE_CLASSES] } } },
                quotes: { items: { properties: { side: { enum: ["RIGHT", "LEFT"] } } } },
                patch: { type: "string" },
              },
            },
          },
        },
      })
      const requested = projectionVerdicts(firstUserText(result.hits[1]!.body)).map((item) => item.id)
      expect(requested.toSorted()).toEqual(
        Review.normalizeFindings(candidates, "review", input.anchors)
          .map((item) => item.id)
          .toSorted(),
      )
      const decision = checked(result.outcome)
      expect(decision).toMatchObject({
        version: 1,
        head: input.head,
        complete: true,
        findings: [
          { title: finding.title, quotes: finding.quotes, verifiedBy: "model", verifier: "lmstudio/test-model" },
        ],
      })
      expect(decision.dropped).toEqual(
        expect.arrayContaining([
          { reason: "not-blocking", count: 2 },
          { reason: "quote-mismatch", count: 1 },
        ]),
      )
      expect(listed(result.outcome)).toEqual([finding.title])
      for (const title of [forged.title, concern.title, nit.title]) expect(result.summary).not.toContain(title)
    }),
  { git: true },
  90_000,
)

it.instance(
  "unanswered or contradictory verify verdicts and an unreadable head fail closed",
  () =>
    Effect.gen(function* () {
      const { run } = yield* checkout
      const options = { config: { ...config, ...strict } }
      for (const verdicts of [
        () => [],
        (prompt: string) => projectionVerdicts(prompt).flatMap((yes) => [{ ...yes, verdict: "rejected" }, yes]),
      ]) {
        const result = yield* run([finding], options, verdicts)
        expect(result.hits).toHaveLength(2)
        expect(checked(result.outcome)).toMatchObject({
          complete: false,
          incomplete: expect.arrayContaining(["verdict-unreadable"]),
          findings: [],
          dropped: [{ reason: "verdict-unreadable", count: 1 }],
        })
        expect(listed(result.outcome)).toEqual([])
        expect(result.summary).toContain("Review incomplete")
        expect(result.summary).not.toContain("No verified production-breaking issues")
        expect(reviewVerdict({ kind: "outcome", outcome: result.outcome }).causes).toContain("strict-incomplete")
      }
      const result = yield* run([{ ...finding, quotes: [finding.quotes![0]!] }], { ...options, head: "f".repeat(40) })
      expect(result.hits).toHaveLength(2)
      expect(checked(result.outcome)).toMatchObject({
        complete: false,
        incomplete: expect.arrayContaining(["blob-unreadable"]),
        findings: [],
      })
      expect(listed(result.outcome)).toEqual([])
      expect(result.summary).toContain("Review incomplete")
    }),
  { git: true },
  90_000,
)

it.instance(
  "a staged diff cannot use matching committed blobs as quote evidence",
  () =>
    Effect.gen(function* () {
      const { run, input } = yield* checkout
      const fs = yield* FSUtil.Service
      yield* fs.writeWithDirs(path.join(input.directory, file), source(changed))
      yield* git(input.directory, "add", file)
      const staged = parseUnifiedDiff(yield* git(input.directory, "diff", "--cached", "--no-color", "--no-ext-diff"))
      expect(staged).toEqual(input.files)
      yield* fs.writeWithDirs(path.join(input.directory, file), source(dirty))
      const result = yield* run([finding], {
        config: { ...config, ...strict },
        uncommittedDiff: true,
        files: staged,
        anchors: staged,
      })
      expect(result.hits).toHaveLength(2)
      expect(result.outcome.specialists.at(-1)).toMatchObject({ name: "verify", status: "ok" })
      expect(checked(result.outcome)).toMatchObject({
        head: input.head,
        complete: false,
        incomplete: expect.arrayContaining(["blob-unreadable"]),
        findings: [],
      })
      expect(listed(result.outcome)).toEqual([])
      expect(result.summary).toContain("Review incomplete")
    }),
  { git: true },
  90_000,
)

native(
  "a proven whitespace-only strict review remains a zero-attempt policy skip",
  () =>
    Effect.gen(function* () {
      const { input, run } = yield* checkout
      const fs = yield* FSUtil.Service
      yield* fs.writeWithDirs(path.join(input.directory, file), source(original + "  "))
      yield* git(input.directory, "add", file)
      yield* git(input.directory, "commit", "-qm", "whitespace only")
      const head = yield* git(input.directory, "rev-parse", "HEAD")
      const files = yield* ReviewSource.prDiff({ directory: input.directory, mergeBase: input.base, head })
      const settings = { ...config, ...strict, trivial: "skip" } as const
      const proof = yield* ReviewTrivial.prove({
        directory: input.directory,
        base: input.base,
        head,
        files,
        config: settings,
        instructions: [],
      })
      expect(proof).toBeDefined()
      const events: Review.Observation[] = []
      const result = yield* run([], {
        trust: "trusted",
        trigger: "auto",
        head,
        files,
        anchors: files,
        config: settings,
        trivialProof: proof,
        observe: (event) => events.push(event),
      })
      expect(result.outcome).toMatchObject({ trivial: true, sessions: [], specialists: [], unreviewed: [] })
      expect(checked(result.outcome)).toMatchObject({
        head,
        complete: false,
        findings: [],
        incomplete: ["no-reviewer"],
      })
      expect(result.hits).toEqual([])
      expect(events.filter((event) => event.type === "attempt")).toEqual([])
      expect(result.summary).toContain("Not reviewed")
      expect(result.summary).not.toContain("No verified production-breaking issues")
    }),
  { git: true },
  90_000,
)

native(
  "an applying patch must leave the committed file parseable before the review labels it checked",
  () =>
    Effect.gen(function* () {
      const { run, input } = yield* checkout
      for (const [replacement, kind, label] of [
        [original, "patch", "Checked patch"],
        ["  return (]", "unchecked", "Unchecked fix"],
      ] as const) {
        const patch = [`--- a/${file}`, `+++ b/${file}`, "@@ -2 +2 @@", "-" + changed, "+" + replacement].join("\n")
        const result = yield* run([{ ...finding, suggestion: undefined, patch }], { config: { ...config, ...strict } })
        expect(result.hits).toHaveLength(2)
        const decision = checked(result.outcome)
        expect(decision).toMatchObject({
          complete: true,
          findings: [{ fix: { kind, text: patch } }],
          fixUnchecked: kind === "unchecked" ? 1 : 0,
        })
        expect(result.outcome.selection.inline).toHaveLength(1)
        const body = buildInlineBody(result.outcome.selection.inline[0]!, { head: input.head, trust: input.trust })
        expect(body).toContain(label)
        expect(body).toContain(patch)
        expect(body).not.toContain("```suggestion")
      }
    }),
  { git: true },
  90_000,
)

native(
  "a shared fingerprint cannot transfer a verdict to a candidate the verifier never saw",
  () =>
    Effect.gen(function* () {
      const { run, input } = yield* checkout
      const unseen = { ...finding, body: "UNSEEN_CLAIM" }
      const sent = {
        ...finding,
        body: "CHECKED_CLAIM",
        quotes: [{ path: file, line: 2, side: "RIGHT" as const, code: dirty }],
      }
      const ids = Review.normalizeFindings([unseen, sent], "review", input.anchors).map((candidate) => candidate.id)
      expect(ids[0]).toBe(ids[1])
      const result = yield* run([unseen, sent], { config: { ...config, ...strict } })
      expect(result.hits).toHaveLength(2)
      const prompt = firstUserText(result.hits[1]!.body)
      expect(projectionVerdicts(prompt).map((entry) => entry.id)).toEqual([ids[0]!])
      expect(prompt).toContain(sent.body)
      expect(prompt).not.toContain(unseen.body)
      expect(checked(result.outcome)).toMatchObject({
        complete: true,
        findings: [],
        dropped: [
          { reason: "unverified", count: 1 },
          { reason: "quote-mismatch", count: 1 },
        ],
      })
      expect(listed(result.outcome)).toEqual([])
    }),
  { git: true },
  90_000,
)

it.instance(
  "read-denied priors stay open and a forbidden patch cannot reach a checker, candidate record or review output",
  () =>
    Effect.gen(function* () {
      const { input, run } = yield* checkout
      const prior = {
        id: "prior_opaque_fixture",
        where: "inline",
        path: "private/archived.ts",
        line: 2,
        side: "RIGHT",
        severity: "blocking",
        category: "bug",
        title: "WITHHELD_PRIOR_TITLE",
        sha: input.base,
        status: "open",
      } as const
      const events: Review.Observation[] = []
      const blocked = {
        ...finding,
        title: "Withheld change to a private file",
        suggestion: undefined,
        patch: [
          "--- a/private/denied.ts",
          "+++ b/private/denied.ts",
          "@@ -1 +1 @@",
          "-PRIVATE_PATCH_SOURCE",
          "+PRIVATE_PATCH_REPAIR",
        ].join("\n"),
      }
      const result = yield* run(
        [
          { ...finding, evidence: [file + ":2"] },
          blocked,
          { ...finding, title: "Forbidden evidence-only claim", evidence: ["private/denied.ts:4-8"] },
        ],
        {
          config: { ...config, ...strict },
          prior: [prior],
          readDenies: [prior.path, "private/denied.ts"],
          observe: (event) => events.push(event),
        },
        projectionVerdicts,
        [{ id: prior.id, status: "fixed", reason: "Claimed fixed without seeing it." }],
      )
      expect(result.hits).toHaveLength(2)
      for (const hit of result.hits) {
        expect(hit.text).not.toContain(prior.path)
        expect(hit.text).not.toContain(prior.title)
        expect(hit.text).not.toContain("Forbidden evidence-only claim")
        expect(hit.text).not.toContain("private/denied.ts")
        for (const text of [blocked.title, "PRIVATE_PATCH_SOURCE", "PRIVATE_PATCH_REPAIR"])
          expect(hit.text).not.toContain(text)
      }
      const observations = events.filter((event) => event.type === "strict-candidates")
      expect(observations).toHaveLength(1)
      expect(observations[0]!.findings.map((entry) => entry.title)).toEqual([finding.title])
      for (const text of ["PRIVATE_PATCH_SOURCE", "PRIVATE_PATCH_REPAIR"])
        expect(JSON.stringify([result.outcome, observations])).not.toContain(text)
      if (process.platform === "linux") expect(listed(result.outcome)).toEqual([finding.title])
      expect(result.outcome.report.priorStatus ?? []).not.toContainEqual(
        expect.objectContaining({ id: prior.id, status: "fixed" }),
      )
      expect(result.outcome.selection.stillOpen).toContainEqual(prior)
      expect(result.outcome.selection.fixed).toEqual([])
    }),
  { git: true },
  90_000,
)

it.instance(
  "a failed verifier or skipped source file leaves the strict review incomplete",
  () =>
    Effect.gen(function* () {
      const { run } = yield* checkout
      const options = { config: { ...config, ...strict } }
      const failed = yield* run([finding], options, "unavailable")
      expect(failed.outcome.specialists.find((item) => item.name === "verify")?.status).toBe("failed")
      expect(checked(failed.outcome)).toMatchObject({
        complete: false,
        incomplete: expect.arrayContaining(["specialist", "verdict-unreadable"]),
        findings: [],
      })
      expect(listed(failed.outcome)).toEqual([])
      expect(failed.summary).toContain("Review incomplete")
      const partial = yield* run([], { ...options, skipped: [{ path: "src/larger.ts", reason: "size-limit" }] })
      expect(partial.hits).toHaveLength(1)
      expect(checked(partial.outcome)).toMatchObject({
        complete: false,
        incomplete: expect.arrayContaining(["size-limit"]),
        findings: [],
      })
      expect(partial.summary).toContain("Review incomplete")
    }),
  { git: true },
  90_000,
)

it.instance(
  "unset and explicit off preserve complete wire requests, permissions, outcome, and summary",
  () =>
    Effect.gen(function* () {
      const { run } = yield* checkout
      const unset = yield* run([finding])
      const off = yield* run([finding], { config: { ...config, guardrail: "off" } })
      expect(unset.hits).toHaveLength(1)
      expect(unset.outcome.strict).toBeUndefined()
      expect(unset.parity.permissions[0]?.length).toBeGreaterThan(0)
      expect(listed(unset.outcome)).toEqual([finding.title])
      expect(off.parity).toEqual(unset.parity)
      expect(unset.summary).not.toContain("No verified production-breaking issues")
      expect(unset.hits[0]!.text).not.toContain("Required on every blocking finding")
      const empty = yield* run([], { config: { ...config, ...strict } })
      expect(checked(empty.outcome)).toMatchObject({ complete: true, findings: [], dropped: [] })
      expect(empty.summary).toContain("No verified production-breaking issues")
    }),
  { git: true },
  90_000,
)

native(
  "SF-22 attaches only verified rule provenance to a strict production failure",
  () =>
    Effect.gen(function* () {
      const { run } = yield* checkout
      const quote = "Keep array indexes within bounds."
      const options = {
        config: { ...config, ...strict, ruleCheck: "strict" as const },
        rules: quote,
        ruleParts: [{ from: "global" as const, text: quote }],
      }
      for (const [claim, valid] of [
        [quote, true],
        ["Invented rule", false],
      ] as const) {
        const result = yield* run([{ ...finding, rule: { source: "review_rules", quote: claim } }], options)
        expect({ specialists: result.outcome.specialists, strict: result.outcome.strict }).toMatchObject({
          specialists: [
            { name: "review", status: "ok" },
            { name: "verify", status: "ok" },
          ],
          strict: { complete: true, findings: [{ title: finding.title }] },
        })
        const item = result.outcome.strict!.findings[0]!
        if (valid) {
          expect(item.linkedRule).toEqual({ source: "review_rules", quote, rulesSource: "base branch" })
          expect(result.outcome.selection.inline[0]).toMatchObject({ rule: quote, rulesSource: "base branch" })
        } else {
          expect(item).not.toHaveProperty("linkedRule")
          expect(JSON.stringify(result.outcome)).not.toContain(claim)
        }
        expect(violations(strictResultJsonSchema(options.config)!, result.outcome.strict)).toEqual([])
      }
    }),
  { git: true },
  90_000,
)

native(
  "certificate verification reads a fork's pinned blobs, hides the reviewer's prose and admits one batched checker",
  () =>
    Effect.gen(function* () {
      const { run } = yield* checkout
      const opts = { ...config, ...strict, verifyEvidence: "certificate" } as const
      const events: Review.Observation[] = []
      const trace = [
        { path: file, side: "LEFT" as const, line: 2, code: original },
        { path: file, side: "RIGHT" as const, line: 2, code: changed },
      ]
      const candidate = {
        ...finding,
        body: "ONLY_REVIEWER_BODY",
        suggestion: "ONLY_REVIEWER_SUGGESTION",
        evidence: ["src/context.ts:91"],
      }
      const result = yield* run([candidate], { config: opts, observe: (event) => events.push(event) }, (prompt) =>
        projectionVerdicts(prompt).map((row) => ({
          ...row,
          trace,
          guards: [
            { path: file, side: "RIGHT", line: 1, code: "export function last(values: string[]) {" },
            { path: file, side: "RIGHT", line: 2, code: dirty },
          ],
          reach: "caller-shown",
        })),
      )
      expect(result.hits).toHaveLength(2)
      const verify = result.hits[1]!
      const prompt = firstUserText(verify.body)
      for (const field of [candidate.body, candidate.suggestion, finding.title, changed, original])
        expect(prompt).not.toContain(field)
      for (const field of [
        candidate.failure!.trigger,
        candidate.failure!.impact,
        "src/context.ts:91",
        `LEFT ${file}:2`,
      ])
        expect(prompt).toContain(field)
      const output = (verify.body.tools as { function?: { name?: string; parameters?: unknown } }[]).find(
        (tool) => tool.function?.name === "StructuredOutput",
      )
      expect(output?.function?.parameters).toMatchObject({
        properties: {
          results: {
            items: {
              properties: {
                verdict: { enum: ["confirmed", "rejected", "unsure"] },
                trace: { type: "array" },
                guards: { type: "array" },
                reach: { enum: ["caller-shown", "entry-point", "assumed"] },
              },
            },
          },
        },
      })
      expect(events.filter((event) => event.type === "attempt" && event.pass === "verify")).toMatchObject([
        { admitted: true, phase: "turn" },
      ])
      expect(result.outcome.strict?.complete).toBe(true)
      expect(result.outcome.strict?.findings.map((row) => row.certificate)).toEqual([
        {
          trace,
          guards: [{ path: file, side: "RIGHT", line: 1, code: "export function last(values: string[]) {" }],
          reach: "caller-shown",
        },
      ])
      expect(violations(strictResultJsonSchema(opts)!, result.outcome.strict)).toEqual([])
      expect(listed(result.outcome)).toEqual([finding.title])
      // The checkout is detached at base and the working file differs from both commits.
      for (const [why, fields] of [
        ["worktree", { trace: [{ ...trace[1], code: dirty }], reach: "entry-point" }],
        ["wrong side", { trace: [{ ...trace[1], code: original }], reach: "entry-point" }],
        ["assumed", { trace, reach: "assumed" }],
        ["unsure", { verdict: "unsure" }],
      ] as const) {
        const dropped = yield* run([candidate], { config: opts }, (text) =>
          projectionVerdicts(text).map((row) => ({ ...row, ...fields })),
        )
        expect(dropped.outcome.strict, why).toMatchObject({
          complete: true,
          findings: [],
          dropped: [{ reason: why === "unsure" ? "verdict-unsure" : "certificate-mismatch", count: 1 }],
        })
        expect(listed(dropped.outcome)).toEqual([])
      }
    }),
  { git: true },
  90_000,
)

it.instance(
  "missing, malformed and duplicate certificates leave paths unreviewed; an explicit off key preserves the full wire",
  () =>
    Effect.gen(function* () {
      const { run } = yield* checkout
      const opts = { ...config, ...strict, verifyEvidence: "certificate" } as const
      for (const [why, answers] of [
        ["missing", () => []],
        [
          "malformed",
          (prompt: string) =>
            projectionVerdicts(prompt).map((row) => ({
              ...row,
              trace: [{ path: "../private", line: 1, side: "RIGHT", code: "line" }],
              reach: "entry-point",
            })),
        ],
        [
          "conflicting",
          (prompt: string) => projectionVerdicts(prompt).flatMap((row) => [row, { ...row, verdict: "unsure" }]),
        ],
        ["failed", "unavailable"],
      ] as const) {
        const result = yield* run([finding], { config: opts }, answers)
        expect(result.outcome.strict, why).toMatchObject({
          complete: false,
          findings: [],
          dropped: [{ reason: "verdict-unreadable", count: 1 }],
        })
        expect(result.outcome.strict?.incomplete).toContain("verdict-unreadable")
        expect(result.outcome.unreviewed).toContain(file)
      }
      for (const settings of [config, { ...config, ...strict }]) {
        const unset = yield* run([finding], { config: settings })
        const ignored = yield* run([finding], {
          config: { ...settings, verifyEvidence: settings.guardrail === "strict" ? "off" : "certificate" },
        })
        expect(ignored.parity).toEqual(unset.parity)
        expect(ignored.hits.at(-1)?.text).not.toContain("from the trigger to the failure, in that order")
      }
    }),
  { git: true },
  90_000,
)
