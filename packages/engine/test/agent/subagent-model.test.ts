import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { ModelV2 } from "@vectordevai/core/model"
import { ProviderV2 } from "@vectordevai/core/provider"
import type { Agent } from "../../src/agent/agent"
import { SubagentModel } from "../../src/agent/subagent-model"
import type { SubagentRecord } from "../../src/agent/subagent-kind"
import { ConfigAgent } from "../../src/config/agent"
import { Provider } from "@/provider/provider"
import { ProviderTransform } from "@/provider/transform"
import { ProviderTest } from "../fake/provider"

// Which model and effort a subagent runs with (multi-agent contract 5.E.1), against a fake catalog: the first rule that
// matches decides the model, then the brief's effort, a warm resume's or Thorough's high passed down.

const P = (id: string) => ProviderV2.ID.make(id)
const M = (id: string) => ModelV2.ID.make(id)

function model(providerID: string, id: string, extra: Partial<Provider.Model> = {}): Provider.Model {
  return ProviderTest.model({
    id: M(id),
    providerID: P(providerID),
    api: { id, url: "https://example.com", npm: "@ai-sdk/openai-compatible" },
    capabilities: { ...ProviderTest.model().capabilities, reasoning: true },
    cost: { input: 3, output: 15, cache: { read: 0, write: 0 } },
    variants: { low: {}, medium: {}, high: {}, xhigh: {} },
    ...extra,
  })
}

const price = (input: number, output: number, unpriced?: boolean) => ({
  input,
  output,
  cache: { read: 0, write: 0 },
  ...(unpriced ? { unpriced } : {}),
})

const big = model("acme", "big")
const catalog = [
  big,
  model("acme", "mid", { cost: price(1, 5) }),
  model("acme", "pricey", { cost: price(10, 50) }),
  model("acme", "unpriced", { cost: price(0, 0, true) }),
  model("acme", "notools", {
    cost: price(0.1, 0.2),
    capabilities: { ...ProviderTest.model().capabilities, toolcall: false },
  }),
  model("acme", "tiny", { cost: price(0.1, 0.4), variants: {} }),
  model("other", "cheap", { cost: price(0.5, 1) }),
  model("other", "pricey", { cost: price(20, 60) }),
  model("openrouter", "anthropic/claude-x", { cost: price(3, 15) }),
  model("openrouter", "openai/gpt-x", { cost: price(1, 2) }),
  model("openrouter", "vendor/trainer:free", {
    cost: price(0, 0),
    freeModel: { source: "openrouter", dataPolicy: "may-train" },
  }),
  model("openrouter", "acme/coder:free", { cost: price(0, 0), freeModel: { source: "openrouter" } }),
  model("budget", "lean", { cost: price(0.1, 0.3) }),
  model("budget", "tiny", { cost: price(0.75, 3.75) }),
  model("solo", "think", { variants: { medium: {}, high: {}, xhigh: {} } }),
  model("solo", "lowonly", { variants: { low: {}, xhigh: {} } }),
  model("openai", "gpt-5", {
    api: { id: "gpt-5", url: "https://example.com", npm: "@ai-sdk/openai" },
    variants: { minimal: {}, low: {}, medium: {}, high: {} },
  }),
  model("anthropic", "claude-sonnet", {
    api: { id: "claude-sonnet", url: "https://example.com", npm: "@ai-sdk/anthropic" },
    variants: { low: {}, medium: {}, high: {} },
  }),
]
// The small model each provider names; "solo" has none.
const smallOf: Record<string, string> = { acme: "tiny", budget: "tiny", openrouter: "openai/gpt-x" }

function layer(models: Provider.Model[] = catalog) {
  const providers = Object.fromEntries(
    [...new Set(models.map((item) => item.providerID))].map((id) => [
      id,
      ProviderTest.info(
        {
          id,
          models: Object.fromEntries(models.filter((item) => item.providerID === id).map((item) => [item.id, item])),
        },
        models.find((item) => item.providerID === id),
      ),
    ]),
  ) as Record<ProviderV2.ID, Provider.Info>
  const find = (providerID: string, modelID: string) => providers[P(providerID)]?.models[modelID]
  return ProviderTest.fake({
    list: () => Effect.succeed(providers),
    getModel: (providerID, modelID) => {
      const found = find(providerID, modelID)
      return found ? Effect.succeed(found) : Effect.fail(new Provider.ModelNotFoundError({ providerID, modelID }))
    },
    getSmallModel: (providerID) => {
      const id = smallOf[providerID]
      return Effect.succeed(id ? find(providerID, id) : undefined)
    },
  }).layer
}

function agent(name: string, extra: Partial<Agent.Info> = {}): Agent.Info {
  return { name, mode: "subagent", native: true, permission: [], options: {}, ...extra }
}

const ref = (providerID: string, modelID: string) => ({ providerID: P(providerID), modelID: M(modelID) })

type Input = Parameters<typeof SubagentModel.choose>[0]
function input(o: {
  parent?: Partial<SubagentModel.Parent>
  next?: Agent.Info
  ask?: Partial<SubagentModel.Ask>
  allow?: string[]
  local?: boolean
}): Input {
  return {
    parent: { model: ref("acme", "big"), free: false, learnedSmall: false, guest: false, ...o.parent },
    next: o.next ?? agent("general"),
    ask: { fork: false, ...o.ask },
    ...(o.allow ? { allow: o.allow } : {}),
    local: o.local ?? false,
  }
}

const choose = (i: Input, models?: Provider.Model[]) =>
  Effect.runPromise(SubagentModel.choose(i).pipe(Effect.provide(layer(models))))

// The refusal's message; a choice instead fails the test.
async function refused(i: Input, models?: Provider.Model[]) {
  const error = await Effect.runPromise(SubagentModel.choose(i).pipe(Effect.flip, Effect.provide(layer(models))))
  expect(error).toBeInstanceOf(SubagentModel.Refused)
  return error.message
}

function record(extra: Partial<SubagentRecord> = {}): SubagentRecord {
  return {
    kind: "subagent",
    agent: "general",
    custom: false,
    title: "Earlier",
    parentSessionID: "ses_parent",
    parentMessageID: "msg_parent",
    model: { providerID: "acme", modelID: "big" },
    background: true,
    status: "completed",
    startedAt: Date.now() - 60_000,
    completedAt: Date.now() - 1_000,
    ...extra,
  }
}

describe("SubagentModel.choose precedence", () => {
  test("a fork runs exactly as its parent and refuses another model or effort", async () => {
    const parent = { variant: "xhigh", sized: "high" as const }
    expect(await choose(input({ parent, ask: { fork: true } }))).toEqual({
      model: ref("acme", "big"),
      variant: "xhigh",
      recorded: "xhigh",
      effort: "high",
      source: "fork",
    })
    expect((await choose(input({ parent, ask: { fork: true, model: "acme/big", effort: "high" } }))).source).toBe(
      "fork",
    )
    expect(await refused(input({ parent, ask: { fork: true, model: "acme/mid" } }))).toBe(SubagentModel.FORK)
    expect(await refused(input({ parent, ask: { fork: true, effort: "low" } }))).toBe(SubagentModel.FORK)
  })

  test("research agents refuse a model or effort of their own and take no effort passed down", async () => {
    for (const name of ["research", "researcher", "research-judge"]) {
      expect(await refused(input({ next: agent(name), ask: { model: "acme/mid" } }))).toContain(
        "runs on the model and effort its research run sets",
      )
      expect(await refused(input({ next: agent(name), ask: { effort: "low" } }))).toContain("research run")
      const chosen = await choose(input({ next: agent(name), parent: { sized: "high" } }))
      expect(chosen.effort).toBeUndefined()
      expect(chosen.model).toEqual(ref("acme", "big"))
    }
  })

  test("an agent that pins a model refuses a brief's model", async () => {
    const reviewer = agent("reviewer", { model: ref("other", "cheap"), variant: "low" })
    expect(await refused(input({ next: reviewer, ask: { model: "acme/mid" } }))).toBe(
      "The reviewer agent sets its own model.",
    )
    // Today's rule: it runs on its own model, whose variant applies at session start.
    expect(await choose(input({ next: reviewer }))).toEqual({
      model: ref("other", "cheap"),
      recorded: "low",
      source: "agent",
    })
  })

  test("the free route keeps the parent's free model and refuses any other", async () => {
    const parent = { model: ref("openrouter", "acme/coder:free"), free: true, variant: "high" }
    expect(await refused(input({ parent, ask: { model: "openai/gpt-x" } }))).toContain("free model")
    const same = await choose(input({ parent, ask: { model: "acme/coder:free" } }))
    expect(same).toMatchObject({ model: parent.model, variant: "high", source: "parent" })
    // A pinned paid specialist stays on the free route too, as before.
    const paid = agent("paid", { model: ref("other", "pricey"), variant: "max" })
    expect(await choose(input({ parent, next: paid }))).toMatchObject({ model: parent.model, variant: "high" })
  })

  test("a model that may train on prompts is never chosen, even when listed exactly", async () => {
    const message = await refused(
      input({ ask: { model: "openrouter/vendor/trainer:free" }, allow: ["*", "openrouter/vendor/trainer:free"] }),
    )
    expect(message).toContain("may train on prompts")
  })

  test("with a guest in the tree only the parent's model or a strictly cheaper one", async () => {
    const parent = { guest: true }
    expect((await choose(input({ parent, ask: { model: "acme/mid" } }))).model).toEqual(ref("acme", "mid"))
    expect((await choose(input({ parent, ask: { model: "acme/big" } }))).model).toEqual(ref("acme", "big"))
    expect(await refused(input({ parent, ask: { model: "acme/pricey" }, allow: ["acme/pricey"] }))).toContain("guest")
    expect(await refused(input({ parent, ask: { model: "acme/unpriced" }, allow: ["acme/unpriced"] }))).toContain(
      "guest",
    )
  })

  test("under Vector Local only the parent's provider", async () => {
    expect(await refused(input({ local: true, ask: { model: "other/cheap" }, allow: ["*", "other/cheap"] }))).toContain(
      "Vector Local",
    )
    expect((await choose(input({ local: true, ask: { model: "acme/mid" } }))).model).toEqual(ref("acme", "mid"))
  })

  test("an unpriced model only when listed exactly", async () => {
    expect(await refused(input({ ask: { model: "acme/unpriced" } }))).toContain("no known price")
    expect(await refused(input({ ask: { model: "acme/unpriced" }, allow: ["acme/*", "*"] }))).toContain(
      "no known price",
    )
    expect((await choose(input({ ask: { model: "acme/unpriced" }, allow: ["acme/unpriced"] }))).model).toEqual(
      ref("acme", "unpriced"),
    )
  })

  test('"provider/*" and "*" only widen which providers count; the cost rule still applies', async () => {
    expect(await refused(input({ ask: { model: "other/cheap" } }))).toContain("not on your provider")
    for (const allow of [["other/*"], ["*"]]) {
      const chosen = await choose(input({ ask: { model: "other/cheap" }, allow }))
      expect(chosen).toMatchObject({ model: ref("other", "cheap"), source: "call" })
      expect(await refused(input({ ask: { model: "other/pricey" }, allow }))).toContain("costs more")
    }
  })

  test("an exact entry may cost more or sit on another provider", async () => {
    expect(await refused(input({ ask: { model: "acme/pricey" } }))).toContain("costs more")
    expect((await choose(input({ ask: { model: "acme/pricey" }, allow: ["acme/pricey"] }))).model).toEqual(
      ref("acme", "pricey"),
    )
    expect((await choose(input({ ask: { model: "other/pricey" }, allow: ["other/pricey"] }))).model).toEqual(
      ref("other", "pricey"),
    )
  })

  test('"small" is the provider\'s small model, at its default effort', async () => {
    const chosen = await choose(input({ parent: { variant: "xhigh", sized: "high" }, ask: { model: "small" } }))
    expect(chosen).toEqual({ model: ref("acme", "tiny"), source: "call" })
    expect(await refused(input({ parent: { model: ref("solo", "think") }, ask: { model: "small" } }))).toContain(
      "no small model",
    )
  })

  test("a model that cannot call tools is refused", async () => {
    expect(await refused(input({ ask: { model: "acme/notools" } }))).toContain("cannot call tools")
  })

  test("an ID with a slash is tried whole on the parent's provider before it is split", async () => {
    const parent = { model: ref("openrouter", "anthropic/claude-x") }
    expect((await choose(input({ parent, ask: { model: "openai/gpt-x" } }))).model).toEqual(
      ref("openrouter", "openai/gpt-x"),
    )
    expect((await choose(input({ parent, ask: { model: "openrouter/openai/gpt-x" } }))).model).toEqual(
      ref("openrouter", "openai/gpt-x"),
    )
    expect((await choose(input({ ask: { model: "mid" } }))).model).toEqual(ref("acme", "mid"))
    expect(await refused(input({ ask: { model: "nowhere/model" } }))).toContain("Unknown model nowhere/model")
  })

  test("a refusal lists at most 12 allowed models, the parent's provider first", async () => {
    const many = [
      ...catalog,
      ...Array.from({ length: 15 }, (_, at) => model("acme", `c${String(at).padStart(2, "0")}`, { cost: price(1, 1) })),
    ]
    const message = await refused(input({ ask: { model: "acme/pricey" } }), many)
    const listed = message.split("Allowed models: ")[1]!.split(", and ")[0]!.split(", ")
    expect(listed).toHaveLength(12)
    expect(listed.every((item) => item.startsWith("acme/"))).toBe(true)
    expect(message).toMatch(/, and \d+ more\.$/)
    expect(message).not.toContain("acme/pricey,")
  })
})

describe("SubagentModel effort", () => {
  test("the ceiling is the user's variant when set, else high under Thorough, else the model's default", () => {
    expect(SubagentModel.ceiling({ variant: "low", sized: "high" })).toBe("low")
    expect(SubagentModel.ceiling({ variant: "minimal" })).toBe("low")
    expect(SubagentModel.ceiling({ variant: "medium", sized: "high" })).toBe("medium")
    expect(SubagentModel.ceiling({ variant: "max" })).toBe("high")
    expect(SubagentModel.ceiling({ variant: "default", sized: "high" })).toBe("high")
    expect(SubagentModel.ceiling({ sized: "high" })).toBe("high")
    expect(SubagentModel.ceiling({ sized: "default" })).toBe("default")
  })

  test("variant low under a Thorough request caps a brief's effort at low", async () => {
    const parent = { variant: "low", sized: "high" as const }
    expect(await refused(input({ parent, ask: { effort: "medium" } }))).toContain("above your own (low)")
    expect(await choose(input({ parent, ask: { effort: "low" } }))).toEqual({
      model: ref("acme", "big"),
      variant: "low",
      recorded: "low",
      effort: "low",
      source: "parent",
    })
  })

  test("GPT-5's default maps to medium, so a Work child may still be lowered to low", async () => {
    const gpt5 = catalog.find((item) => item.id === "gpt-5")!
    expect(ProviderTransform.defaultEffort(gpt5)).toBe("medium")
    const parent = { model: ref("openai", "gpt-5"), sized: "default" as const }
    expect((await choose(input({ parent, ask: { effort: "low" } }))).variant).toBe("low")
    expect((await choose(input({ parent, ask: { effort: "medium" } }))).effort).toBe("medium")
    expect(await choose(input({ parent, ask: { effort: "default" } }))).toEqual({
      model: parent.model,
      effort: "default",
      source: "parent",
    })
    expect(await refused(input({ parent, ask: { effort: "high" } }))).toBe(
      "Effort high is above your own (medium). Use default, low, medium, or leave effort out.",
    )
  })

  test("Anthropic without thinking defaults to off, so no brief raises a child above it", async () => {
    const claude = catalog.find((item) => item.id === "claude-sonnet")!
    expect(ProviderTransform.defaultEffort(claude)).toBe("off")
    const parent = { model: ref("anthropic", "claude-sonnet"), sized: "default" as const }
    expect(await refused(input({ parent, ask: { effort: "low" } }))).toContain("above your own (off)")
    expect((await choose(input({ parent, ask: { effort: "default" } }))).effort).toBe("default")
  })

  test("a brief's effort must be one the child's model has", async () => {
    const parent = { model: ref("solo", "think"), sized: "high" as const }
    expect(await refused(input({ parent, ask: { effort: "low" } }))).toBe(
      "solo/think has no low effort. Use default, medium, high, or leave effort out.",
    )
  })

  test("Thorough passes high down through the sized path, to children nothing else sets an effort for", async () => {
    const thorough = { sized: "high" as const }
    expect(await choose(input({ parent: thorough }))).toEqual({
      model: ref("acme", "big"),
      effort: "high",
      source: "parent",
    })
    // Work, a user's variant, explore, an agent's own variant or reasoning option, and the small model take none.
    expect((await choose(input({ parent: { sized: "default" } }))).effort).toBeUndefined()
    expect(await choose(input({ parent: { ...thorough, variant: "medium" } }))).toEqual({
      model: ref("acme", "big"),
      variant: "medium",
      recorded: "medium",
      source: "parent",
    })
    expect((await choose(input({ parent: thorough, next: agent("explore") }))).effort).toBeUndefined()
    expect(
      (await choose(input({ parent: thorough, next: agent("review", { variant: "low" }) }))).effort,
    ).toBeUndefined()
    expect(
      (await choose(input({ parent: thorough, next: agent("review", { options: { reasoningEffort: "low" } }) })))
        .effort,
    ).toBeUndefined()
    expect((await choose(input({ parent: thorough, ask: { model: "small" } }))).effort).toBeUndefined()
    // A model the brief names takes it like any other.
    expect((await choose(input({ parent: thorough, ask: { model: "acme/mid" } }))).effort).toBe("high")
    // A Work request that still runs at high while a Thorough request's cache is warm passes nothing down; its own
    // high effort is still the ceiling for a brief's.
    const sticky = { sized: "high" as const, passdown: "default" as const }
    expect((await choose(input({ parent: sticky }))).effort).toBeUndefined()
    expect((await choose(input({ parent: sticky, ask: { effort: "high" } }))).effort).toBe("high")
  })

  test("a warm resume keeps the effort its child ran at; a cold one works it out again", async () => {
    const now = Date.now()
    const lifetime = ProviderTransform.cacheLifetime(big)
    const warmRecord = record({ effort: "high", completedAt: now - 1_000 })
    const coldRecord = record({ effort: "high", completedAt: now - lifetime - 1_000 })
    expect(SubagentModel.warm(warmRecord, big, now)).toBe(true)
    expect(SubagentModel.warm(coldRecord, big, now)).toBe(false)
    expect(SubagentModel.warm(record({ completedAt: undefined, status: "running" }), big, now)).toBe(true)
    expect(SubagentModel.warm(warmRecord, undefined, now)).toBe(false)

    // Passed down under Thorough; the request that resumes it is Work.
    const work = { sized: "default" as const }
    const kept = await choose(input({ parent: work, ask: { resume: { record: warmRecord, warm: true } } }))
    expect(kept).toEqual({ model: ref("acme", "big"), effort: "high", source: "parent" })
    const cold = await choose(input({ parent: work, ask: { resume: { record: coldRecord, warm: false } } }))
    expect(cold.effort).toBeUndefined()
    // A brief's low effort rode on the child's variant, and a warm resume keeps it there.
    const lowered = record({ effort: "low", model: { providerID: "acme", modelID: "big", variant: "low" } })
    expect(await choose(input({ parent: work, ask: { resume: { record: lowered, warm: true } } }))).toEqual({
      model: ref("acme", "big"),
      variant: "low",
      recorded: "low",
      effort: "low",
      source: "parent",
    })
    // A brief that names an effort on resume decides it.
    expect(
      (await choose(input({ parent: work, ask: { effort: "medium", resume: { record: lowered, warm: true } } })))
        .effort,
    ).toBe("medium")
  })
})

describe("SubagentModel resume", () => {
  test("a resume keeps the model its brief named while that model is still allowed", async () => {
    const resume = (model: SubagentRecord["model"]) => ({
      resume: { record: record({ modelSource: "call", model }), warm: false },
    })
    expect(await choose(input({ ask: resume({ providerID: "acme", modelID: "mid" }) }))).toEqual({
      model: ref("acme", "mid"),
      source: "call",
    })
    // An exact entry the user has since taken away: back to the routing it would get today.
    const pricey = resume({ providerID: "acme", modelID: "pricey" })
    expect((await choose(input({ ask: pricey, allow: ["acme/pricey"] }))).model).toEqual(ref("acme", "pricey"))
    expect(await choose(input({ ask: pricey }))).toEqual({ model: ref("acme", "big"), source: "parent" })
    // A model the resume names decides.
    expect((await choose(input({ ask: { ...pricey, model: "acme/tiny" } }))).model).toEqual(ref("acme", "tiny"))
    // A child the routing placed is placed again.
    const placed = { resume: { record: record({ modelSource: "parent" }), warm: false } }
    expect((await choose(input({ ask: placed, next: agent("explore") }))).model).toEqual(ref("acme", "tiny"))
  })
})

describe("SubagentModel routing without a brief's model", () => {
  test("explore runs on the provider's small model only when it costs less, at its default effort", async () => {
    expect(await choose(input({ parent: { variant: "xhigh" }, next: agent("explore") }))).toEqual({
      model: ref("acme", "tiny"),
      source: "small",
    })
    expect(await choose(input({ parent: { model: ref("budget", "lean") }, next: agent("explore") }))).toEqual({
      model: ref("budget", "lean"),
      source: "parent",
    })
  })

  test("explore on the parent's high-effort model stops at medium, or the lowest effort it has", async () => {
    const explore = agent("explore")
    expect(
      await choose(input({ parent: { model: ref("solo", "think"), variant: "xhigh" }, next: explore })),
    ).toMatchObject({ model: ref("solo", "think"), variant: "medium" })
    expect(
      await choose(input({ parent: { model: ref("solo", "lowonly"), variant: "xhigh" }, next: explore })),
    ).toMatchObject({ variant: "low" })
    // A variant configured for explore applies instead.
    expect(
      await choose(
        input({
          parent: { model: ref("solo", "think"), variant: "xhigh" },
          next: agent("explore", { variant: "high" }),
        }),
      ),
    ).toMatchObject({ variant: "high" })
  })

  test("a learned default moves general subagents to the cheaper small model; one with a variant keeps it", async () => {
    expect(await choose(input({ parent: { learnedSmall: true, sized: "high" } }))).toEqual({
      model: ref("acme", "tiny"),
      source: "learned",
    })
    expect(await choose(input({ parent: { learnedSmall: true }, next: agent("general", { variant: "low" }) }))).toEqual(
      { model: ref("acme", "big"), variant: "low", recorded: "low", source: "parent" },
    )
    expect(await choose(input({ parent: { variant: "xhigh" } }))).toEqual({
      model: ref("acme", "big"),
      variant: "xhigh",
      recorded: "xhigh",
      source: "parent",
    })
  })
})

describe("agent config", () => {
  test("an agent named fork is refused at load", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "vector-agent-fork-"))
    try {
      await fs.mkdir(path.join(dir, "agent"), { recursive: true })
      await fs.writeFile(path.join(dir, "agent", "fork.md"), "---\ndescription: forks\nmode: subagent\n---\nFork.\n")
      await expect(ConfigAgent.load(dir, () => true)).rejects.toThrow()
      await fs.rm(path.join(dir, "agent", "fork.md"))
      await fs.writeFile(path.join(dir, "agent", "helper.md"), "---\ndescription: helps\nmode: subagent\n---\nHelp.\n")
      expect(Object.keys(await ConfigAgent.load(dir, () => true))).toEqual(["helper"])
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })
})
