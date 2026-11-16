import { describe, expect, test } from "bun:test"
import {
  appendWorkflowRequest,
  busyMessage,
  ceilingsLine,
  inputFields,
  parseInputs,
  readPlan,
  readWorkflowAsk,
  reasonLine,
  savedEntries,
  savedRequest,
  stageLine,
  startRequest,
  validateRequest,
  workflowFailure,
  workflowOpen,
  workflowSlash,
  type Saved,
  type PlanStage,
  type WorkflowClient,
} from "./workflow-model"

const plan = {
  title: "Review changes",
  stages: [
    {
      id: "files",
      title: "Review each file",
      phase: "review",
      agent: "review",
      effort: "high",
      items: "dynamic",
      serial: false,
      writes: "read only",
      asks: ["bash"],
      verify: { agent: "judge", maxRounds: 2 },
    },
    {
      id: "fix",
      title: "Fix",
      phase: "fix",
      agent: "general",
      model: "anthropic/claude-haiku",
      items: 1,
      serial: true,
      writes: "in this checkout, one at a time",
      asks: [],
    },
  ],
  maxAgents: 100,
  concurrency: 8,
  steps: 4000,
  perAgentSteps: 60,
  minutes: 120,
}

const saved: Saved = {
  name: "review-changes",
  title: "Review changes",
  source: "repository",
  inputs: [
    { name: "base", description: "Branch to compare with", required: true },
    { name: "limit", required: false, default: 20 },
    { name: "focus", required: true, default: "security" },
  ],
}

function httpError(status: number, body: unknown) {
  return new Error(`refused ${status}`, { cause: { status, body } })
}

describe("the plan", () => {
  test("connected plans name the declared action without inventing an agent, model or available execution", () => {
    const connect: PlanStage = {
      id: "review",
      title: "Review changes",
      phase: "",
      kind: "connect",
      connect: { to: "vectorscope", action: "review" },
      items: 1,
      serial: false,
      writes: "read only; execution unavailable",
      asks: ["connect", "connect_model when required"],
    }
    const checked = readPlan({ ...plan, stages: [connect] })
    expect(checked?.stages[0]).toEqual(connect)
    expect(stageLine(checked!.stages[0])).toBe(
      "Review changes · vectorscope.review · 1 item · read only; execution unavailable · asks: connect, connect_model when required",
    )
    for (const extra of [
      { agent: "general" },
      { model: "provider/model" },
      { kind: "unknown" },
      { connect: undefined },
    ])
      expect(readPlan({ ...plan, stages: [{ ...connect, ...extra }] })).toBeUndefined()
  })
  test("reads a plan field by field and refuses anything else", () => {
    expect(readPlan(plan)?.stages.map((stage) => stage.id)).toEqual(["files", "fix"])
    expect(readPlan({ ...plan, delegated: { usd: 25 }, models: {} })?.title).toBe("Review changes")
    expect(readPlan(undefined)).toBeUndefined()
    expect(readPlan({ ...plan, stages: [{ id: "x" }] })).toBeUndefined()
    expect(readPlan({ ...plan, maxAgents: "100" })).toBeUndefined()
    expect(readPlan({ ...plan, stages: "none" })).toBeUndefined()
  })

  test("a stage line names the agent, model, effort, items, where it writes and what it asks", () => {
    const [files, fix] = readPlan(plan)!.stages
    expect(stageLine(files!)).toBe(
      "Review each file · review · high · items found while it runs · read only · checked by judge, up to 2 rounds · asks: bash",
    )
    expect(stageLine(fix!)).toBe("Fix · general · anthropic/claude-haiku · 1 item · in this checkout, one at a time")
  })

  test("the ceilings line names every limit and the subagent ceiling it shares", () => {
    expect(ceilingsLine(readPlan(plan)!)).toBe(
      "Up to 100 agents · 8 at once · 4,000 steps · 60 steps per agent · 120 minutes",
    )
    expect(ceilingsLine(readPlan({ ...plan, usd: 5, tokens: 2_000_000 })!, { usd: 25 })).toBe(
      "Up to 100 agents · 8 at once · 4,000 steps · 60 steps per agent · 120 minutes · 2,000,000 tokens · $5.00 for this run · shares the $25.00 subagent ceiling",
    )
  })
})

describe("the workflow ask", () => {
  test("a plan within the defaults may be allowed always", () => {
    const ask = readWorkflowAsk({
      permission: "workflow",
      patterns: ["run"],
      always: ["run"],
      metadata: { ...plan, delegated: { usd: 25 } },
    })
    expect(ask).toMatchObject({ elevated: false, canAlways: true, delegated: { usd: 25 } })
    expect(ask?.plan?.title).toBe("Review changes")
    expect(reasonLine(ask!)).toBeUndefined()
  })

  test("a non-run pattern hides Always allow and says why", () => {
    for (const reason of ["web", "mcp", "agent", "large"] as const) {
      const ask = readWorkflowAsk({
        permission: "workflow",
        patterns: [`after-web workflow:${reason}`],
        always: [],
        metadata: plan,
      })!
      expect(ask).toMatchObject({ reason, elevated: true, canAlways: false })
      expect(reasonLine(ask)).toContain("cannot be allowed always")
    }
    // Even if an engine marked it always-able, a non-run pattern is never offered Always (I15).
    expect(
      readWorkflowAsk({ permission: "workflow", patterns: ["after-web workflow:web"], always: ["run"], metadata: plan })
        ?.canAlways,
    ).toBe(false)
    expect(readWorkflowAsk({ permission: "workflow", patterns: ["something"], always: [] })).toMatchObject({
      elevated: true,
      canAlways: false,
    })
  })

  test("other permissions are not workflow asks", () => {
    expect(readWorkflowAsk({ permission: "bash", patterns: ["ls"], always: ["ls"] })).toBeUndefined()
  })

  test("a malformed plan still reads as an elevated ask without a plan", () => {
    expect(
      readWorkflowAsk({ permission: "workflow", patterns: ["after-web workflow:large"], always: [], metadata: {} }),
    ).toMatchObject({ plan: undefined, reason: "large", elevated: true })
  })
})

describe("the /workflow form", () => {
  test("/workflow and /workflow <name> open the form", () => {
    expect(workflowSlash("/workflow")).toEqual({})
    expect(workflowSlash("  /workflow review-changes ")).toEqual({ name: "review-changes" })
    expect(workflowSlash("/workflow Not A Name")).toBeUndefined()
    expect(workflowSlash("/workflow ../etc")).toEqual({})
    expect(workflowSlash("/workflows")).toBeUndefined()
    expect(workflowSlash("run /workflow")).toBeUndefined()
  })

  test("a submitted /workflow opens the form only where it can start one", () => {
    const base = {
      text: "/workflow review-changes",
      mode: "normal" as const,
      sessionID: "ses_root",
      commands: [{ name: "review" }],
      workflows: true,
      attachments: 0,
    }
    expect(workflowOpen(base)).toEqual({ sessionID: "ses_root", name: "review-changes" })
    expect(workflowOpen({ ...base, text: "/workflow" })).toEqual({ sessionID: "ses_root" })
    // A new session, shell mode, an older engine, attachments, or a user's own /workflow command: sent as before.
    expect(workflowOpen({ ...base, sessionID: undefined })).toBeUndefined()
    expect(workflowOpen({ ...base, mode: "shell" })).toBeUndefined()
    expect(workflowOpen({ ...base, workflows: false })).toBeUndefined()
    expect(workflowOpen({ ...base, attachments: 1 })).toBeUndefined()
    expect(workflowOpen({ ...base, commands: [{ name: "workflow" }] })).toBeUndefined()
    expect(workflowOpen({ ...base, text: "run the workflow" })).toBeUndefined()
  })

  test("fields: required only without a default; the default is the placeholder", () => {
    expect(inputFields(saved)).toEqual([
      { name: "base", description: "Branch to compare with", required: true, placeholder: "" },
      { name: "limit", required: false, placeholder: "20" },
      { name: "focus", required: false, placeholder: "security" },
    ])
  })

  test("inputs: blanks use the default, a required blank is an issue, JSON where the default is not text", () => {
    expect(parseInputs(saved, { base: "main", limit: "", focus: "" })).toEqual({ ok: true, inputs: { base: "main" } })
    expect(parseInputs(saved, { base: "main", limit: "5", focus: "perf" })).toEqual({
      ok: true,
      inputs: { base: "main", limit: 5, focus: "perf" },
    })
    expect(parseInputs(saved, { base: "", limit: "" })).toEqual({
      ok: false,
      issues: [{ path: "base", message: "base is required." }],
    })
    expect(parseInputs(saved, { base: "main", limit: "five" })).toMatchObject({ ok: false })
    // A JSON object or list typed into a text input is read as JSON; text that only looks like it stays text.
    expect(parseInputs(saved, { base: '{"ref":"main"}' })).toEqual({ ok: true, inputs: { base: { ref: "main" } } })
    expect(parseInputs(saved, { base: "[wip] branch" })).toEqual({ ok: true, inputs: { base: "[wip] branch" } })
    expect(parseInputs(saved, { base: "x".repeat(9000) })).toMatchObject({ ok: false })
  })

  test("busy: the composer gets a message asking the agent to run it", () => {
    expect(busyMessage("review-changes", { base: "main" })).toBe(
      'Run the saved workflow "review-changes" with {"base":"main"}.',
    )
    expect(busyMessage("review-changes", {})).toBe('Run the saved workflow "review-changes" with its default inputs.')
  })

  test("the busy message goes after the draft, attachments kept", () => {
    expect(appendWorkflowRequest([{ type: "text", content: "", start: 0, end: 0 }], "Run it.")).toEqual([
      { type: "text", content: "", start: 0, end: 0 },
      { type: "text", content: "Run it.", start: 0, end: 7 },
    ])
    expect(appendWorkflowRequest([{ type: "text", content: "Also", start: 0, end: 4 }], "Run it.").at(-1)).toEqual({
      type: "text",
      content: "\n\nRun it.",
      start: 4,
      end: 13,
    })
  })

  test("saved workflows list valid ones first, invalid ones kept with their issues", () => {
    const list = savedEntries([
      { ...saved, name: "zeta", title: "Zeta" },
      { ...saved, name: "broken", title: "Broken", issues: [{ path: "/stages", message: "bad" }] },
      { ...saved, name: "alpha", title: "Alpha" },
    ])
    expect(list.map((item) => item.name)).toEqual(["alpha", "zeta", "broken"])
  })
})

describe("owner routes", () => {
  function client(handlers: Partial<Record<"saved" | "validate" | "start", (...args: any[]) => Promise<unknown>>>) {
    const calls: { route: string; args: unknown[] }[] = []
    const wrap =
      (route: "saved" | "validate" | "start") =>
      (...args: unknown[]) => {
        calls.push({ route, args })
        return handlers[route]!(...args)
      }
    return {
      calls,
      client: {
        experimental: { workflow: { saved: wrap("saved"), validate: wrap("validate"), start: wrap("start") } },
      } as unknown as WorkflowClient,
    }
  }

  test("route 7 lists, route 8 validates with the name and inputs", async () => {
    const fake = client({
      saved: async () => ({ data: { workflows: [saved] } }),
      validate: async () => ({ data: { ok: true, issues: [], warnings: [], plan } }),
    })
    expect(await savedRequest(fake.client)).toEqual([saved])
    const validation = await validateRequest({ client: fake.client, name: "review-changes", inputs: { base: "main" } })
    expect(validation.ok).toBe(true)
    expect(fake.calls[1]).toEqual({
      route: "validate",
      args: [{ workflowValidateInput: { name: "review-changes", inputs: { base: "main" } } }, { throwOnError: true }],
    })
  })

  test("route 9 starts in the session and answers the run", async () => {
    const fake = client({ start: async () => ({ data: { runID: "ses_run", title: "Review changes", plan } }) })
    expect(
      await startRequest({ client: fake.client, sessionID: "ses_root", name: "review-changes", inputs: {} }),
    ).toEqual({ ok: true, runID: "ses_run", title: "Review changes" })
    expect(fake.calls[0]?.args[0]).toEqual({
      sessionID: "ses_root",
      workflowStartInput: { name: "review-changes", inputs: {} },
    })
  })

  test("busy, owner-only and invalid starts are told apart", async () => {
    const busy = client({
      start: async () => {
        throw httpError(400, { code: "busy", message: "The session is working." })
      },
    })
    expect(await startRequest({ client: busy.client, sessionID: "s", name: "n", inputs: {} })).toMatchObject({
      ok: false,
      kind: "busy",
    })
    expect(workflowFailure(httpError(403, { name: "ForbiddenError" })).kind).toBe("owner")
    expect(
      workflowFailure(httpError(400, { code: "invalid", message: "Bad", issues: [{ path: "/x", message: "no" }] })),
    ).toEqual({ kind: "invalid", message: "Bad", issues: [{ path: "/x", message: "no" }] })
    expect(workflowFailure(httpError(400, { code: "disabled", message: "Off" })).kind).toBe("disabled")
    expect(workflowFailure(new Error("network")).kind).toBe("other")
  })
})
