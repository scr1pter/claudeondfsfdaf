import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { Billing } from "../src/billing"
import { RunBudget } from "../src/run-budget"
import { Session } from "../src/session"
import { SessionEvent } from "../src/session-event"
import { SessionMessage } from "../src/session-message"
import { SessionStatusEvent } from "../src/session-status-event"
import { Task } from "../src/task"
import { SessionV1 } from "../src/v1/session"

const tokens = { input: 1000, output: 50, reasoning: 0, cache: { read: 0, write: 0 } } as const
const usage = { cost: 0, unpriced: true, tokens } as const

// Records as builds before the billing flag and the Codium counts wrote them.
const stepFinish = {
  id: "prt_step",
  sessionID: "ses_codium",
  messageID: "msg_assistant",
  type: "step-finish",
  reason: "stop",
  ...usage,
} as const
const assistant = {
  id: "msg_assistant",
  sessionID: "ses_codium",
  role: "assistant",
  time: { created: 1, completed: 2 },
  parentID: "msg_user",
  modelID: "vector/sonnet",
  providerID: Billing.CODIUM_PROVIDER_ID,
  mode: "build",
  agent: "build",
  path: { cwd: "/tmp/project", root: "/tmp/project" },
  ...usage,
} as const
const v1Session = {
  id: "ses_codium",
  slug: "codium",
  projectID: "prj_codium",
  directory: "/tmp/project",
  title: "Codium session",
  version: "1.99.112",
  time: { created: 1, updated: 2 },
  cost: 0.12,
  unpricedSteps: 3,
  subagentCost: 0,
  subagentUnpricedSteps: 1,
  tokens,
} as const
const session = {
  id: "ses_codium",
  projectID: "prj_codium",
  cost: 0.12,
  unpricedSteps: 3,
  subagentUnpricedSteps: 1,
  tokens,
  time: { created: 1, updated: 2 },
  title: "Codium session",
  location: { directory: "/tmp/project" },
} as const
const v2Assistant = {
  id: "msg_assistant",
  time: { created: 1 },
  type: "assistant",
  agent: "build",
  model: { id: "vector/sonnet", providerID: Billing.CODIUM_PROVIDER_ID },
  content: [],
  ...usage,
} as const
const compaction = {
  id: "msg_compaction",
  time: { created: 1 },
  type: "compaction",
  reason: "auto",
  summary: "What happened so far.",
  recent: "The last request.",
  ...usage,
} as const
const event = { timestamp: 1, sessionID: "ses_codium" } as const
const stepEnded = { ...event, assistantMessageID: "msg_assistant", finish: "stop", ...usage } as const
const compactionEnded = {
  ...event,
  messageID: "msg_compaction",
  reason: "auto",
  text: "Summary.",
  recent: "",
  ...usage,
} as const
const compactionFailed = { ...event, messageID: "msg_compaction", reason: "manual", ...usage } as const
const ancillary = {
  ...event,
  usageID: "evt_title",
  purpose: "title",
  model: { id: "vector/haiku", providerID: Billing.CODIUM_PROVIDER_ID },
  ...usage,
} as const
const snapshot = {
  sessionID: "ses_codium",
  state: "ok",
  budget: { usd: 1 },
  spentUsd: 0.12,
  steps: 41,
  unpricedSteps: 0,
  costKind: "priced",
} as const
const spend = {
  sessionID: "ses_codium",
  state: "ok",
  spentUsd: 0.12,
  capUsd: 1,
  steps: 41,
  unpricedSteps: 0,
  costKind: "priced",
} as const
const taskUsage = { cost: 0, tokens, total: 1050, toolUses: 2, steps: 3, unpricedSteps: 3 } as const
const budgetScope = {
  kind: "child",
  id: "task_codium",
  budget: { steps: 50 },
  spentUsd: 0,
  steps: 3,
  unpricedSteps: 0,
  costKind: "plan",
} as const
const taskInfo = {
  id: "task_codium",
  parentSessionID: "ses_codium",
  source: "subagent",
  title: "Read the code",
  status: "completed",
  startedAt: 1,
  elapsedMs: 10,
  usage: taskUsage,
  ownedPaths: [],
  dependsOn: [],
  resultAvailable: true,
  attempt: 1,
  controls: { inspect: true, message: false, stop: false },
} as const

// Every struct that gained a field, its record as older builds wrote it, and the new fields it may now carry.
const cases = [
  { name: "a V1 step-finish part", schema: SessionV1.StepFinishPart, old: stepFinish, fields: { billing: "codium" } },
  { name: "a V1 assistant message", schema: SessionV1.Assistant, old: assistant, fields: { billing: "codium" } },
  {
    name: "a V1 session",
    schema: SessionV1.SessionInfo,
    old: v1Session,
    fields: { codiumSteps: 2, subagentCodiumSteps: 1 },
  },
  { name: "a session", schema: Session.Info, old: session, fields: { codiumSteps: 2, subagentCodiumSteps: 1 } },
  { name: "an assistant message", schema: SessionMessage.Assistant, old: v2Assistant, fields: { billing: "codium" } },
  { name: "a compaction", schema: SessionMessage.Compaction, old: compaction, fields: { billing: "codium" } },
  { name: "a step's end", schema: SessionEvent.Step.Ended.data, old: stepEnded, fields: { billing: "codium" } },
  {
    name: "a compaction's end",
    schema: SessionEvent.Compaction.Ended.data,
    old: compactionEnded,
    fields: { billing: "codium" },
  },
  {
    name: "a failed compaction",
    schema: SessionEvent.Compaction.Failed.data,
    old: compactionFailed,
    fields: { billing: "codium" },
  },
  {
    name: "ancillary usage",
    schema: SessionEvent.AncillaryUsage.data,
    old: { ...ancillary, purpose: "memory" },
    fields: { billing: "codium" },
  },
  {
    name: "title usage written before version 2",
    schema: SessionEvent.AncillaryUsageV1.data,
    old: ancillary,
    fields: { billing: "codium" },
  },
  { name: "a spend snapshot", schema: RunBudget.Snapshot, old: snapshot, fields: { codiumSteps: 41 } },
  { name: "a spend event", schema: SessionStatusEvent.Spend.data, old: spend, fields: { codiumSteps: 41 } },
  { name: "a task's usage", schema: Task.Usage, old: taskUsage, fields: { codiumSteps: 3 } },
  { name: "a task budget scope", schema: Task.BudgetScope, old: budgetScope, fields: { codiumSteps: 3 } },
] as const

const decode = (schema: Schema.Codec<unknown, unknown>, value: unknown) => Schema.decodeUnknownSync(schema)(value)
const roundTrip = (schema: Schema.Codec<unknown, unknown>, value: unknown) =>
  Schema.encodeSync(schema)(decode(schema, value))

describe("Billing.of", () => {
  test("the flag marks Codium work, and without it the Codium provider id does", () => {
    expect(Billing.of({ billing: "codium" })).toBe("codium")
    // A flagged record is Codium whatever provider it names.
    expect(Billing.of({ billing: "codium", providerID: "openrouter" })).toBe("codium")
    // A V1 record written before the flag, and a V2 one that names its model.
    expect(Billing.of({ providerID: Billing.CODIUM_PROVIDER_ID })).toBe("codium")
    expect(Billing.of({ model: { providerID: Billing.CODIUM_PROVIDER_ID } })).toBe("codium")
  })

  test("other work, Vector's own free models and an unknown flag are not Codium", () => {
    expect(Billing.of({})).toBeUndefined()
    expect(Billing.of({ providerID: "openrouter" })).toBeUndefined()
    expect(Billing.of({ model: { providerID: "vector" } })).toBeUndefined()
    expect(Billing.of({ billing: "plan", providerID: "openai" })).toBeUndefined()
    expect(Billing.isCodium(undefined)).toBe(false)
    expect(Billing.isCodium("vector")).toBe(false)
    expect(Billing.isCodium(Billing.CODIUM_PROVIDER_ID)).toBe(true)
  })

  test("decoded records read as Codium from the flag, or from the model when they name one", () => {
    // Records from before the flag: the V1 message and the V2 message name the Codium provider.
    expect(Billing.of(decode(SessionV1.Assistant, assistant) as SessionV1.Assistant)).toBe("codium")
    expect(Billing.of(decode(SessionMessage.Assistant, v2Assistant) as SessionMessage.Assistant)).toBe("codium")
    // A compaction row names no model, so only its flag says the summary ran on Codium.
    expect(Billing.of(decode(SessionMessage.Compaction, compaction) as SessionMessage.Compaction)).toBeUndefined()
    expect(
      Billing.of(decode(SessionMessage.Compaction, { ...compaction, billing: "codium" }) as SessionMessage.Compaction),
    ).toBe("codium")
  })
})

describe("the Codium contract fields", () => {
  for (const item of cases) {
    test(`${item.name} written before them still decodes, without them`, () => {
      const decoded = decode(item.schema, item.old) as Record<string, unknown>
      for (const key of Object.keys(item.fields)) expect(key in decoded).toBe(false)
      expect(roundTrip(item.schema, item.old)).toStrictEqual(item.old)
    })

    test(`${item.name} keeps them through decode and encode`, () => {
      const value = { ...item.old, ...item.fields }
      expect(roundTrip(item.schema, value)).toStrictEqual(value)
    })
  }

  test("an unset flag or count is left out of the encoded record", () => {
    const part = decode(SessionV1.StepFinishPart, stepFinish) as SessionV1.StepFinishPart
    expect(Schema.encodeSync(SessionV1.StepFinishPart)({ ...part, billing: undefined })).toStrictEqual(stepFinish)
    const ended = decode(SessionEvent.Step.Ended.data, stepEnded) as SessionEvent.Step.Ended["data"]
    expect(Schema.encodeSync(SessionEvent.Step.Ended.data)({ ...ended, billing: undefined })).toStrictEqual(stepEnded)
    const info = decode(SessionV1.SessionInfo, v1Session) as SessionV1.SessionInfo
    expect(
      Schema.encodeSync(SessionV1.SessionInfo)({ ...info, codiumSteps: undefined, subagentCodiumSteps: undefined }),
    ).toStrictEqual(v1Session)
  })

  test("a billing value other than codium is refused", () => {
    for (const [schema, value] of [
      [SessionV1.StepFinishPart, stepFinish],
      [SessionV1.Assistant, assistant],
      [SessionMessage.Assistant, v2Assistant],
      [SessionMessage.Compaction, compaction],
      [SessionEvent.Step.Ended.data, stepEnded],
      [SessionEvent.AncillaryUsage.data, ancillary],
    ] as const)
      expect(() => decode(schema, { ...value, billing: "plan" })).toThrow()
  })

  test("a negative or fractional Codium count is refused where step counts are whole numbers", () => {
    for (const count of [-1, 1.5]) {
      expect(() => decode(SessionV1.SessionInfo, { ...v1Session, codiumSteps: count })).toThrow()
      expect(() => decode(SessionV1.SessionInfo, { ...v1Session, subagentCodiumSteps: count })).toThrow()
      expect(() => decode(RunBudget.Snapshot, { ...snapshot, codiumSteps: count })).toThrow()
      expect(() => decode(SessionStatusEvent.Spend.data, { ...spend, codiumSteps: count })).toThrow()
    }
  })

  test("the guard's cost kind can be codium wherever a cost kind is stored", () => {
    expect(RunBudget.CostKind.literals).toContain("codium")
    const scope = { ...budgetScope, costKind: "codium", codiumSteps: 41 }
    const task = { ...taskInfo, costKind: "codium", budgetScopes: [budgetScope, scope] }
    expect(roundTrip(Task.Info, task)).toStrictEqual(task)
    for (const [schema, value] of [
      [RunBudget.Snapshot, snapshot],
      [SessionStatusEvent.Spend.data, spend],
      [Task.BudgetScope, budgetScope],
    ] as const) {
      const codium = { ...value, costKind: "codium" }
      expect(roundTrip(schema, codium)).toStrictEqual(codium)
    }
    // A persisted task from before the change, with no Codium fields, still decodes with its scopes.
    const old = { ...taskInfo, budgetScopes: [budgetScope] }
    expect(roundTrip(Task.Info, old)).toStrictEqual(old)
  })

  test("a spend-guard stop keeps its Codium step count on the assistant message", () => {
    const stopped = {
      ...assistant,
      error: {
        name: "BudgetStopError",
        data: { reason: "steps", message: "Stopped after 50 steps.", spentUsd: 0, unpricedSteps: 0, codiumSteps: 50 },
      },
    }
    expect(roundTrip(SessionV1.Assistant, stopped)).toStrictEqual(stopped)
    const before = { ...stopped, error: { name: "BudgetStopError", data: { reason: "loop", message: "Paused." } } }
    expect(roundTrip(SessionV1.Assistant, before)).toStrictEqual(before)
  })

  test("the new optional keys need no new durable event version", () => {
    expect(SessionEvent.Step.Ended.durable?.version).toBe(2)
    expect(SessionEvent.Compaction.Ended.durable?.version).toBe(1)
    expect(SessionEvent.Compaction.Failed.durable?.version).toBe(1)
    expect(SessionEvent.AncillaryUsage.durable?.version).toBe(2)
    expect(SessionEvent.AncillaryUsageV1.durable?.version).toBe(1)
  })
})
