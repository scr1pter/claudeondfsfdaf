import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { Connect } from "../src/connect"
import { EventManifest } from "../src/event-manifest"
import { SessionID } from "../src/session-id"

const session = SessionID.create()
const helper = SessionID.create()

const member = {
  id: "vectorscope",
  kind: "agent",
  title: "VectorScope",
  summary: "Reviews your changes on your own models.",
  owner: "main",
  place: "local",
  sendsTo: "model-server:127.0.0.1:11434",
  state: "ready",
  reach: "connect",
  actions: [
    { id: "review", title: "Review changes", effects: ["read"], background: true, result: "review" },
    { id: "fix", title: "Fix findings", effects: ["write"], background: false, result: "fix" },
  ],
  activity: { running: 1, lastRunAt: 1_700_000_000_000 },
}

// Optional keys are left out, not set to undefined: the wire never carries an undefined value.
function without(value: Record<string, unknown>, ...keys: string[]) {
  return Object.fromEntries(Object.entries(value).filter(([key]) => !keys.includes(key)))
}

const finding = (index: number, overrides: Record<string, unknown> = {}) => ({
  id: `f${index}`,
  severity: "concern",
  category: "bug",
  path: `src/file-${index}.ts`,
  line: index + 1,
  side: "RIGHT",
  title: `Finding ${index}`,
  body: "The loop never ends when the list is empty.",
  source: "review",
  verified: true,
  bucket: "inline",
  status: "open",
  ...overrides,
})

const runID = Connect.RunID.create()

const reviewRequest = {
  id: runID,
  to: "vectorscope",
  action: "review",
  requester: { kind: "agent", sessionID: session, agent: "build" },
  requestID: "msg_0001",
  directory: "/work/repo",
  background: false,
  budget: { maxCostUsd: 1.5, timeoutMinutes: 20 },
  target: { kind: "branch", base: "main" },
  security: true,
}

const result = {
  state: "completed",
  verdict: "findings",
  summary: "VectorScope found 2 concerns in 3 files.",
  findings: [finding(0), finding(1, { bucket: "overflow", severity: "nit", category: "style" })],
  sendsTo: "provider:anthropic",
  cached: false,
  cost: { kind: "priced", usd: 0.12 },
  sessions: [helper],
  notes: ["3 files skipped: generated"],
  target: { kind: "branch", base: "main" },
  head: "0123456789abcdef0123456789abcdef01234567",
  base: "fedcba9876543210fedcba9876543210fedcba98",
}

const run = {
  id: runID,
  request: reviewRequest,
  status: "done",
  progress: { pass: "review", message: "Reviewing 3 files", at: 1_700_000_000_500 },
  result,
  time: { created: 1_700_000_000_000, started: 1_700_000_000_100, ended: 1_700_000_001_000 },
}

const consent = {
  permission: "connect_model",
  patterns: ["anthropic/claude"],
  always: ["anthropic/claude"],
  message: "Review with anthropic/claude? The diff goes to the provider anthropic. Cap: $2.00.",
  model: "anthropic/claude",
  sendsTo: "provider:anthropic",
  maxCostUsd: 2,
}

function roundTrip<S extends Schema.Codec<unknown, unknown>>(schema: S, value: unknown) {
  const decoded = Schema.decodeUnknownSync(schema)(value)
  const encoded = Schema.encodeSync(schema)(decoded)
  expect(encoded).toEqual(value)
  expect(Schema.decodeUnknownSync(schema)(encoded)).toEqual(decoded)
  return decoded
}

function refuses(schema: Schema.Codec<unknown, unknown>, value: unknown) {
  expect(() => Schema.decodeUnknownSync(schema)(value)).toThrow()
}

describe("connect contracts round-trip", () => {
  test("member, request, result, run, consent and progress decode and encode unchanged", () => {
    roundTrip(Connect.Member, member)
    roundTrip(Connect.Request, reviewRequest)
    roundTrip(Connect.Request, {
      id: Connect.RunID.create(),
      to: "vectorscope",
      action: "fix",
      requester: { kind: "agent", sessionID: session },
      requestID: "msg_0001",
      directory: "/work/repo",
      background: false,
      run: runID,
      findings: ["f0", "f1"],
      mode: "worktree",
    })
    roundTrip(Connect.Request, {
      id: Connect.RunID.create(),
      to: "vectorscope",
      action: "review",
      requester: { kind: "user" },
      requestID: "cr_desktop",
      directory: "/work/workspace-a",
      background: true,
      target: { kind: "uncommitted" },
      since: runID,
    })
    roundTrip(Connect.Result, result)
    roundTrip(Connect.Run, run)
    roundTrip(Connect.Consent, consent)
    roundTrip(Connect.Progress, { message: "Queued", at: 0 })
    roundTrip(Connect.Finding, without(finding(3, { body: "", bucket: "still-open", status: "still-open" }), "line"))
  })

  test("list-only members, targets and refusals round-trip", () => {
    roundTrip(Connect.Member, {
      id: "computer",
      kind: "tool",
      title: "Vector Hands",
      summary: "",
      owner: "hands",
      place: "local",
      state: "not-installed",
      reason: "Not in this build.",
      reach: "computer",
    })
    roundTrip(Connect.Member, {
      id: "mcp:github",
      kind: "mcp",
      title: "github",
      summary: "MCP server",
      owner: "user",
      place: "your-cloud",
      sendsTo: "provider:github",
      state: "off",
      reason: "Off in Vector Local",
      reach: "none",
    })
    roundTrip(Connect.Target, { kind: "task", task: session })
    roundTrip(Connect.Request, { ...reviewRequest, target: { kind: "task", task: session } })
    roundTrip(Connect.Target, { kind: "staged" })
    roundTrip(Connect.Target, { kind: "branch" })
    const refusal = new Connect.Refusal({
      code: "read-rule",
      message: "A file matches .kube/*, which you keep private.",
    })
    const encoded = Schema.encodeSync(Connect.Refusal)(refusal)
    expect(encoded).toEqual({ _tag: "Connect.Refusal", code: "read-rule", message: refusal.message })
    const decoded = Schema.decodeUnknownSync(Connect.Refusal)(encoded)
    expect(decoded).toBeInstanceOf(Connect.Refusal)
    expect(decoded.code).toBe("read-rule")
  })

  test("the run event is defined, scoped to the requester's session, and included in the manifest", () => {
    expect(Connect.Event.RunUpdated.type).toBe("connect.run.updated")
    expect(Connect.Event.Definitions).toEqual([Connect.Event.RunUpdated])
    const payload = { id: "evt_0001", type: "connect.run.updated", data: { sessionID: session, run } }
    roundTrip(Connect.Event.RunUpdated, payload)
    roundTrip(Connect.Event.RunUpdated, { ...payload, data: { run } })
    refuses(Connect.Event.RunUpdated, { ...payload, type: "connect.run.changed" })
    expect(EventManifest.Latest.has("connect.run.updated")).toBe(true)
  })

  test("run ids are cr_ ids that sort by creation", () => {
    const ids = Array.from({ length: 20 }, () => Connect.RunID.create())
    expect(ids.every((id) => id.startsWith("cr_"))).toBe(true)
    expect([...ids].sort()).toEqual(ids)
    refuses(Connect.RunID, "ses_0001")
    refuses(Connect.RunID, "cr_")
  })
})

describe("connect contracts refuse unknown literals", () => {
  test("an effect other than read or write is refused", () => {
    for (const effect of ["run", "network", "post", "screen", "cloud", "READ", ""]) {
      refuses(Connect.Effect, effect)
      refuses(Connect.Action, { ...member.actions[0], effects: ["read", effect] })
    }
    refuses(Connect.Action, { ...member.actions[0], effects: [] })
    refuses(Connect.Action, { ...member.actions[0], effects: ["read", "read"] })
  })

  test("member literals are closed", () => {
    refuses(Connect.Member, { ...member, kind: "subagent" })
    refuses(Connect.Member, { ...member, owner: "someone" })
    refuses(Connect.Member, { ...member, place: "cloud" })
    refuses(Connect.Member, { ...member, state: "maybe", reason: "?" })
    refuses(Connect.Member, { ...member, sendsTo: "somewhere" })
    refuses(Connect.Member, { ...member, sendsTo: "model-server:" })
    refuses(Connect.Member, { ...member, sendsTo: "provider:open ai" })
    refuses(Connect.Member, { ...member, reach: "two words" })
    refuses(Connect.Member, { ...member, actions: [{ ...member.actions[0], id: "ask" }] })
    refuses(Connect.Member, { ...member, actions: [{ ...member.actions[0], result: "report" }] })
  })

  test("request literals are closed and a member is never a requester", () => {
    refuses(Connect.Request, { ...reviewRequest, action: "ask" })
    refuses(Connect.Request, { ...reviewRequest, requester: { kind: "member", sessionID: session } })
    refuses(Connect.Request, { ...reviewRequest, target: { kind: "task", task: "tsk_1" } })
    refuses(Connect.Request, { ...reviewRequest, target: "uncommitted" })
    refuses(Connect.Request, {
      ...reviewRequest,
      action: "fix",
      run: runID,
      findings: ["f0"],
      mode: "elsewhere",
    })
  })

  test("result, finding, consent and refusal literals are closed", () => {
    refuses(Connect.Result, { ...result, state: "done" })
    refuses(Connect.Result, { ...result, verdict: "approved" })
    refuses(Connect.Result, { ...result, cost: { kind: "codium" } })
    refuses(Connect.Result, { ...result, refusal: "because" })
    refuses(Connect.Finding, finding(0, { severity: "critical" }))
    refuses(Connect.Finding, finding(0, { category: "naming" }))
    refuses(Connect.Finding, finding(0, { side: "right" }))
    refuses(Connect.Finding, finding(0, { source: "judge" }))
    refuses(Connect.Finding, finding(0, { bucket: "outsideDiff" }))
    refuses(Connect.Finding, finding(0, { status: "resolved" }))
    refuses(Connect.Consent, { ...consent, permission: "connect_cloud" })
    refuses(Connect.Run, { ...run, status: "lost" })
    refuses(Connect.Refusal, { _tag: "Connect.Refusal", code: "nope", message: "x" })
  })
})

describe("connect contracts enforce size limits", () => {
  test("a summary holds at most 2,000 characters", () => {
    expect(Schema.decodeUnknownSync(Connect.Result)({ ...result, summary: "s".repeat(2_000) }).summary).toHaveLength(
      2_000,
    )
    refuses(Connect.Result, { ...result, summary: "s".repeat(2_001) })
    expect(Connect.MAX_SUMMARY).toBe(2_000)
  })

  test("a finding body holds at most 4,000 characters", () => {
    expect(Schema.decodeUnknownSync(Connect.Finding)(finding(0, { body: "b".repeat(4_000) })).body).toHaveLength(4_000)
    refuses(Connect.Finding, finding(0, { body: "b".repeat(4_001) }))
    refuses(Connect.Finding, finding(0, { suggestion: "s".repeat(4_001) }))
    refuses(Connect.Result, { ...result, findings: [finding(0, { body: "b".repeat(4_001) })] })
    expect(Connect.MAX_BODY).toBe(4_000)
  })

  test("a result carries at most 200 findings", () => {
    const many = (count: number) => Array.from({ length: count }, (_, index) => finding(index))
    expect(Schema.decodeUnknownSync(Connect.Result)({ ...result, findings: many(200) }).findings).toHaveLength(200)
    refuses(Connect.Result, { ...result, findings: many(201) })
    expect(Connect.MAX_FINDINGS).toBe(200)
  })

  test("other text and lists are bounded", () => {
    refuses(Connect.Result, { ...result, sessions: Array.from({ length: 201 }, () => helper) })
    refuses(Connect.Result, { ...result, notes: ["n".repeat(1_001)] })
    refuses(Connect.Progress, { message: "m".repeat(501), at: 0 })
    refuses(Connect.Member, { ...member, title: "" })
    refuses(Connect.Member, { ...member, summary: "s".repeat(501) })
    refuses(Connect.Refusal, { _tag: "Connect.Refusal", code: "input", message: "m".repeat(2_001) })
    refuses(Connect.Request, {
      ...reviewRequest,
      action: "fix",
      run: runID,
      findings: Array.from({ length: 201 }, (_, index) => `f${index}`),
      mode: "here",
    })
  })
})

describe("connect contracts hold their invariants", () => {
  test("a review that is not completed is never clean", () => {
    for (const state of ["partial", "refused", "failed", "cancelled"])
      refuses(Connect.Result, { ...result, state, verdict: "clean", findings: [] })
    expect(Schema.decodeUnknownSync(Connect.Result)({ ...result, verdict: "clean", findings: [] }).verdict).toBe(
      "clean",
    )
    expect(
      Schema.decodeUnknownSync(Connect.Result)({ ...result, state: "partial", verdict: "incomplete" }).verdict,
    ).toBe("incomplete")
  })

  test("a clean review has no open blocking or concern finding", () => {
    refuses(Connect.Result, { ...result, verdict: "clean", findings: [finding(0, { severity: "blocking" })] })
    refuses(Connect.Result, { ...result, verdict: "clean", findings: [finding(0, { bucket: "still-open" })] })
    const clean = Schema.decodeUnknownSync(Connect.Result)({
      ...result,
      verdict: "clean",
      findings: [finding(0, { severity: "nit" }), finding(1, { severity: "blocking", status: "fixed" })],
    })
    expect(clean.findings).toHaveLength(2)
  })

  test("Vector Codium never shows dollars", () => {
    refuses(Connect.Result, { ...result, sendsTo: "vector-codium", cost: { kind: "plan", usd: 0.4 } })
    roundTrip(Connect.Result, { ...result, sendsTo: "vector-codium", cost: { kind: "plan" } })
  })

  test("a member that is not ready says why, and only connect members list actions", () => {
    for (const state of ["busy", "unavailable", "off", "not-installed"] as const) {
      refuses(Connect.Member, { ...member, state })
      expect(Schema.decodeUnknownSync(Connect.Member)({ ...member, state, reason: "Why" }).state).toBe(state)
    }
    refuses(Connect.Member, without(member, "actions"))
    refuses(Connect.Member, { ...member, actions: [] })
    refuses(Connect.Member, { ...member, reach: "research" })
    refuses(Connect.Member, { ...member, actions: [member.actions[0], member.actions[0]] })
  })

  test("only a person may ask without a session", () => {
    for (const kind of ["agent", "workflow"]) refuses(Connect.Request, { ...reviewRequest, requester: { kind } })
    expect(
      Schema.decodeUnknownSync(Connect.Request)({ ...reviewRequest, requester: { kind: "user" } }).requester.sessionID,
    ).toBeUndefined()
  })

  test("budgets only lower limits: 0 is refused, never read as no cap", () => {
    refuses(Connect.Request, { ...reviewRequest, budget: { maxCostUsd: 0 } })
    refuses(Connect.Request, { ...reviewRequest, budget: { maxCostUsd: -1 } })
    refuses(Connect.Request, { ...reviewRequest, budget: { timeoutMinutes: 0 } })
    refuses(Connect.Consent, { ...consent, maxCostUsd: 0 })
    refuses(Connect.Result, { ...result, cost: { kind: "priced", usd: -0.01 } })
  })

  test("a branch base never reads as an option", () => {
    refuses(Connect.Target, { kind: "branch", base: "--output=/tmp/x" })
    refuses(Connect.Target, { kind: "branch", base: "main branch" })
    refuses(Connect.Target, { kind: "branch", base: "" })
    expect(Schema.decodeUnknownSync(Connect.Target)({ kind: "branch", base: "origin/main~2" })).toEqual({
      kind: "branch",
      base: "origin/main~2",
    })
  })

  test("connect_write is never saved and connect_model names the model and where the diff goes", () => {
    refuses(Connect.Consent, {
      permission: "connect_write",
      patterns: ["*"],
      always: ["*"],
      message: "Apply fixes for 2 findings?",
      findings: ["f0", "f1"],
    })
    roundTrip(Connect.Consent, {
      permission: "connect_write",
      patterns: ["*"],
      always: [],
      message: "Apply fixes for 2 findings?",
      findings: ["f0", "f1"],
    })
    refuses(Connect.Consent, without(consent, "model"))
    refuses(Connect.Consent, without(consent, "sendsTo"))
    refuses(Connect.Consent, { ...consent, patterns: [] })
  })

  test("a run has a result exactly when it is done, and carries its own request", () => {
    refuses(Connect.Run, { ...run, status: "running" })
    refuses(Connect.Run, without(run, "result"))
    refuses(Connect.Run, { ...run, id: Connect.RunID.create() })
    const queued = Schema.decodeUnknownSync(Connect.Run)({
      ...without(run, "progress", "result"),
      status: "queued",
      time: { created: 1 },
    })
    expect(queued.status).toBe("queued")
  })

  test("a fix names each finding once", () => {
    refuses(Connect.Request, { ...reviewRequest, action: "fix", run: runID, findings: [], mode: "here" })
    refuses(Connect.Request, { ...reviewRequest, action: "fix", run: runID, findings: ["f0", "f0"], mode: "here" })
  })

  test("only this computer and a model server count as local", () => {
    expect(Connect.isLocal("this-computer")).toBe(true)
    expect(Connect.isLocal("model-server:192.168.1.20:8080")).toBe(true)
    expect(Connect.isLocal("provider:ollama")).toBe(false)
    expect(Connect.isLocal("vector-codium")).toBe(false)
    expect(Connect.isLocal(undefined)).toBe(false)
  })
})

test("connect public identifiers are unique and namespaced", () => {
  const contracts = [
    Connect.Effect,
    Connect.Place,
    Connect.SendsTo,
    Connect.Kind,
    Connect.Owner,
    Connect.State,
    Connect.Reach,
    Connect.ActionID,
    Connect.ResultKind,
    Connect.Action,
    Connect.Activity,
    Connect.Member,
    Connect.Requester,
    Connect.Budget,
    Connect.Target,
    Connect.FixMode,
    Connect.ReviewRequest,
    Connect.ReviewInput,
    Connect.DirectoryRequestKey,
    Connect.DirectoryReviewInput,
    Connect.FixRequest,
    Connect.Request,
    Connect.Severity,
    Connect.Category,
    Connect.Side,
    Connect.Bucket,
    Connect.FindingStatus,
    Connect.Finding,
    Connect.ResultState,
    Connect.Verdict,
    Connect.CostKind,
    Connect.Cost,
    Connect.RefusalCode,
    Connect.Result,
    Connect.RunStatus,
    Connect.Progress,
    Connect.ConsentPermission,
    Connect.Consent,
    Connect.Run,
  ]
  const identifiers = contracts.map((contract) => contract.ast.annotations?.identifier)
  expect(identifiers.every((identifier) => typeof identifier === "string" && identifier.startsWith("Connect."))).toBe(
    true,
  )
  expect(new Set(identifiers).size).toBe(contracts.length)
  expect(Connect.ConnectFinding).toBe(Connect.Finding)
})

test("directory starts require a bounded stable UUID while conversation starts retain their existing input", () => {
  const input = {
    requestKey: "0196aa50-50d0-4f17-9c1d-85eff018e829",
    target: { kind: "branch", base: "0123456789abcdef0123456789abcdef01234567" },
    background: true,
    budget: { maxCostUsd: 0.25 },
  }
  roundTrip(Connect.DirectoryReviewInput, input)
  roundTrip(Connect.DirectoryReviewInput, { ...input, requestKey: input.requestKey.toUpperCase() })
  refuses(Connect.DirectoryReviewInput, without(input, "requestKey"))
  for (const requestKey of [
    "",
    "../request",
    "a".repeat(1_000),
    "0196aa50-50d0-1f17-9c1d-85eff018e829",
    "0196aa50-50d0-4f17-0c1d-85eff018e829",
  ])
    refuses(Connect.DirectoryReviewInput, { ...input, requestKey })
  roundTrip(Connect.ReviewInput, { target: input.target, background: true })
})

test("the directory UUID JSON schema preserves uppercase wire validation and UUID format", () => {
  const document = Schema.toJsonSchemaDocument(Connect.DirectoryRequestKey)
  const schema = document.definitions["Connect.DirectoryRequestKey"] ?? document.schema
  const members = (value: unknown): Record<string, unknown>[] => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return []
    const own = Object.fromEntries(Object.entries(value))
    return [own, ...(Array.isArray(own.allOf) ? own.allOf.flatMap(members) : [])]
  }
  const clauses = members(schema)
  const uuid = clauses.find((clause) => clause.format === "uuid" && typeof clause.pattern === "string")
  if (!uuid || typeof uuid.pattern !== "string")
    throw new Error("The directory UUID JSON schema has no explicit pattern")
  expect(clauses.some((clause) => clause.minLength === 36)).toBe(true)
  expect(clauses.some((clause) => clause.maxLength === 36)).toBe(true)
  const pattern = new RegExp(uuid.pattern)
  const value = "0196aa50-50d0-4f17-9c1d-85eff018e829"
  expect(pattern.test(value)).toBe(true)
  expect(pattern.test(value.toUpperCase())).toBe(true)
  expect(pattern.test(value.replace("4f17", "1f17"))).toBe(false)
  expect(pattern.test(value.replace("9c1d", "0c1d"))).toBe(false)
})
