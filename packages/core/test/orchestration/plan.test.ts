import { expect, test } from "bun:test"
import { WorkflowPlan } from "../../src/orchestration/plan"
import { examples } from "./examples"

const agents: WorkflowPlan.Agent[] = [
  { name: "general", allowed: true, writes: true, asks: ["edit"] },
  { name: "explore", allowed: true, writes: false },
  { name: "build", allowed: true, primary: true, writes: true },
  { name: "research", allowed: true, research: true, writes: false },
]
const base = { version: 1, title: "Review", stages: [{ id: "a", prompt: "Review" }] }
const build = (spec: unknown, options: Partial<WorkflowPlan.Options> = {}) =>
  WorkflowPlan.build(spec, { agents, cpus: 8, ...options })

test("real guide plans list source sizes, asks and serial or isolated writers", () => {
  for (const example of examples)
    expect(build(example.spec, { inputs: example.name === "research-sweep" ? { topic: "upgrade" } : {} }).ok).toBe(true)
  const result = build(base)
  expect(result.plan?.stages[0]).toMatchObject({
    items: 1,
    serial: true,
    writes: "in this checkout, one at a time",
    asks: ["edit"],
  })
  expect(build({ ...base, stages: [{ ...base.stages[0], owned_paths: [] }] }).plan?.stages[0].serial).toBe(true)
  expect(build({ ...base, stages: [{ ...base.stages[0], isolation: "worktree" }] }).plan?.stages[0].serial).toBe(false)
  expect(build(examples[0].spec).plan?.stages[0].items).toBe("dynamic")
})

test("unknown references, duplicate ids and explicit or template cycles fail before execution", () => {
  for (const stages of [
    [{ id: "a", prompt: "A", after: ["missing"] }],
    [
      { id: "a", prompt: "A" },
      { id: "a", prompt: "B" },
    ],
    [
      { id: "a", prompt: "A", after: ["b"] },
      { id: "b", prompt: "B", after: ["a"] },
    ],
    [
      { id: "a", prompt: "{{stages.b.output}}" },
      { id: "b", prompt: "{{stages.a.output}}" },
    ],
    [{ id: "a", prompt: "A", if: { path: "stages.a.done", gt: 0 } }],
  ])
    expect(build({ ...base, stages }).ok).toBe(false)
})

test("one nested level namespaces aggregate conditions and keeps input contexts separate", () => {
  const child = {
    ...base,
    inputs: { text: { required: true } },
    stages: [
      { id: "a", prompt: "{{inputs.text}}" },
      { id: "b", prompt: "{{stages.a.output}}", if: { path: "stages.a.done", gt: 0 } },
    ],
  }
  const result = build(
    {
      ...base,
      inputs: { text: { default: "outer" } },
      stages: [
        { id: "nested", workflow: "child", inputs: { text: "{{inputs.text}}" } },
        { id: "done", prompt: "{{stages.nested.outputs}}" },
      ],
    },
    { saved: { child } },
  )
  expect(result.ok).toBe(true)
  expect(result.stages?.[1].stage.if).toEqual({ path: "stages.nested.a.done", gt: 0 })
  expect(result.stages?.[1].dependencies).toContain("nested.a")
  expect(result.stages?.[2].dependencies).toEqual(["nested.a", "nested.b"])
  expect(result.stages?.[0].inputs.text).toBe("outer")
  expect(
    build(
      { ...base, stages: [{ id: "nested", workflow: "child" }] },
      { saved: { child: { ...base, stages: [{ id: "inner", workflow: "child" }] } } },
    ).ok,
  ).toBe(false)
})

test("agent, model, input and configured agent caps fail closed", () => {
  for (const agent of ["build", "research", "unknown"])
    expect(build({ ...base, stages: [{ ...base.stages[0], agent }] }).ok).toBe(false)
  expect(build({ ...base, stages: [{ ...base.stages[0], model: "paid/model" }] }).ok).toBe(false)
  expect(
    build({ ...base, stages: [{ ...base.stages[0], model: "paid/model" }] }, { modelAllowed: () => true }).ok,
  ).toBe(true)
  expect(build({ ...base, limits: { max_agents: 101 } }).ok).toBe(false)
  expect(build({ ...base, limits: { max_agents: 101 } }, { limits: { max_agents: 101 } }).ok).toBe(true)
  const spec = { ...base, inputs: { text: { required: true } } }
  expect(build(spec).ok).toBe(false)
  expect(build(spec, { inputs: { text: "x".repeat(8193) } }).ok).toBe(false)
  expect(build(spec, { inputs: { text: () => true } }).ok).toBe(false)
  expect(build(spec, { inputs: { text: "ok", unexpected: true } }).ok).toBe(false)
})

test("resume keys preserve property-order stability but track every execution input", () => {
  const key = { prompt: "work", settings: { model: "p/m", effort: "low" }, item: 1, round: 0, paths: ["src/a"] }
  expect(WorkflowPlan.key(key)).toBe(
    WorkflowPlan.key({
      paths: ["src/a"],
      round: 0,
      item: 1,
      settings: { effort: "low", model: "p/m" },
      prompt: "work",
    }),
  )
  for (const changed of [
    { ...key, prompt: "different" },
    { ...key, item: 2 },
    { ...key, round: 1 },
    { ...key, paths: ["src/b"] },
  ])
    expect(WorkflowPlan.key(changed)).not.toBe(WorkflowPlan.key(key))
})

test("aggregate paths and nested input references must resolve exactly", () => {
  expect(
    build({
      ...base,
      stages: [
        { id: "a", prompt: "A" },
        { id: "b", prompt: "B", if: { path: "stages.a.unknown.done", gt: 0 } },
      ],
    }).ok,
  ).toBe(false)
  expect(
    build(
      { ...base, stages: [{ id: "outer", workflow: "child", inputs: { value: "{{inputs.missing}}" } }] },
      {
        saved: { child: { ...base, inputs: { value: {} } } },
      },
    ).ok,
  ).toBe(false)
})

test("streaming edges belong to the graph but do not add completion barriers", () => {
  const result = build({
    ...base,
    stages: [
      { id: "a", prompt: "A" },
      { id: "b", prompt: "{{item}}", for_each: { from: "a" } },
      { id: "c", prompt: "{{stages.a.outputs}}" },
    ],
  })
  expect(result.ok).toBe(true)
  expect(result.stages?.[1].dependencies).toEqual(["a"])
  expect(result.stages?.[1].barriers).toEqual([])
  expect(result.stages?.[2].barriers).toEqual(["a"])
})

test("approval plans include verifier permissions and checkout serialization", () => {
  const stage = {
    id: "a",
    agent: "explore",
    prompt: "Read",
    verify: {
      agent: "general",
      prompt: "Verify {{output}}",
      output: { schema: { type: "object" } },
      until: { path: "approved", equals: true },
    },
  }
  const plan = build({ ...base, stages: [stage] }).plan?.stages[0]
  expect(plan).toMatchObject({
    serial: true,
    asks: ["edit"],
    writes: "read only; verifier: in this checkout, one at a time",
  })
  expect(
    build({ ...base, stages: [{ ...stage, verify: { ...stage.verify, isolation: "worktree" } }] }).plan?.stages[0]
      .serial,
  ).toBe(false)
})

test("nested limits stay attached to their group without limiting unrelated outer stages", () => {
  const result = build(
    {
      ...base,
      limits: { steps: 100 },
      stages: [
        { id: "nested", workflow: "child" },
        { id: "outer", prompt: "Work" },
      ],
    },
    {
      saved: { child: { ...base, limits: { steps: 3, usd: 0.2, max_agents: 2 } } },
    },
  )
  expect(result.ok).toBe(true)
  expect(result.groupLimits?.nested).toMatchObject({ steps: 3, usd: 0.2, maxAgents: 2 })
  expect(result.limits?.steps).toBe(100)
  expect(result.stages?.[0].group).toBe("nested")
  expect(result.stages?.[1].group).toBeUndefined()
})

test("nested result references are validated and selection is retained for group output", () => {
  const parent = { ...base, stages: [{ id: "nested", workflow: "child" }] }
  const invalid = build(parent, { saved: { child: { ...base, result: { stages: ["missing"] } } } })
  expect(invalid.ok).toBe(false)
  expect(invalid.issues).toContainEqual({
    path: "/stages/0/workflow/result/stages",
    message: "Unknown result stage: missing.",
  })
  const result = build(parent, {
    saved: { child: { ...base, result: { stages: ["a"], where: { path: "keep", equals: true }, max_items: 2 } } },
  })
  expect(result.ok).toBe(true)
  expect(result.groupResults?.nested).toEqual({
    stages: ["nested.a"],
    where: { path: "keep", equals: true },
    max_items: 2,
  })
})

test("an inherited model is also checked for the verifier agent", () => {
  const result = build(
    {
      ...base,
      stages: [
        {
          id: "a",
          agent: "explore",
          model: "paid/model",
          prompt: "Read",
          verify: {
            agent: "general",
            prompt: "Verify",
            output: { schema: { type: "object" } },
            until: { equals: true },
          },
        },
      ],
    },
    { modelAllowed: (_model, agent) => agent === "explore" },
  )
  expect(result.ok).toBe(false)
  expect(result.issues).toContainEqual({
    path: "/stages/0/verify/model",
    message: "Verifier model is not allowed: paid/model.",
  })
})
