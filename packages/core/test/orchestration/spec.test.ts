import { readFile } from "node:fs/promises"
import { expect, test } from "bun:test"
import { WorkflowSpec } from "../../src/orchestration/spec"
import { examples } from "./examples"

const base = { version: 1, title: "Review", stages: [{ id: "review", prompt: "Review the change" }] }
const issues = (value: unknown, source: "model" | "saved" | "owner" = "owner") => {
  const result = WorkflowSpec.parse(value, { source })
  expect(result.ok).toBe(false)
  return result.issues
}

test("all three guide examples decode, including batches, projection and verification", () => {
  for (const example of examples) expect(WorkflowSpec.parse(example.spec).ok).toBe(true)
})

test("unknown fields name their exact nested path and suggest a nearby known key", () => {
  const result = issues({ ...base, stages: [{ ...base.stages[0], promt: "misspelled" }] })
  expect(result).toContainEqual({ path: "/stages/0/promt", message: 'Unknown key "promt". Did you mean "prompt"?' })
  expect(issues({ ...base, limits: { concurrent: 4 } }).some((item) => item.path === "/limits/concurrent")).toBe(true)
})

test("sources and predicates accept exactly one discriminator or comparison", () => {
  expect(
    issues({ ...base, stages: [{ ...base.stages[0], for_each: { items: [], from: "review" } }] }).length,
  ).toBeGreaterThan(0)
  expect(
    issues({ ...base, stages: [{ ...base.stages[0], when: { equals: 1, exists: true } }] }).length,
  ).toBeGreaterThan(0)
  expect(
    issues({ ...base, stages: [{ ...base.stages[0], when: { all: [{ not: { equals: 1 } }] } }] }).length,
  ).toBeGreaterThan(0)
})

test("file flags, stage condition and batch bounds survive decoding", () => {
  const spec = {
    ...base,
    stages: [
      { id: "files", prompt: "{{item}}", for_each: { files: { glob: "**/*", hidden: true } } },
      { id: "changed", prompt: "{{item}}", for_each: { changed_files: { include_deleted: true } } },
      {
        id: "batch",
        prompt: "{{item}}",
        for_each: { from: "files", batch: 100 },
        if: { path: "stages.changed.done", gt: 0 },
      },
    ],
  }
  const parsed = WorkflowSpec.parse(spec)
  expect(parsed.ok).toBe(true)
  if (parsed.ok) expect(parsed.spec.stages).toEqual(spec.stages)
  expect(
    issues({ ...base, stages: [{ ...base.stages[0], for_each: { from: "review", batch: 101 } }] }).length,
  ).toBeGreaterThan(0)
})

test("model literal lists stop at 200; saved lists stop at 1000", () => {
  const value = (count: number) => ({
    ...base,
    stages: [{ ...base.stages[0], for_each: { items: Array(count).fill(1) } }],
  })
  expect(WorkflowSpec.parse(value(200), { source: "model" }).ok).toBe(true)
  expect(issues(value(201), "model").some((item) => item.path === "/stages/0/for_each/items")).toBe(true)
  expect(WorkflowSpec.parse(value(1000), { source: "saved" }).ok).toBe(true)
  expect(issues(value(1001), "saved").length).toBeGreaterThan(0)
})

test("UTF-8 request and item limits are measured in bytes before traversal", () => {
  expect(issues(" ".repeat(32 * 1024) + JSON.stringify(base), "model")[0].message).toContain("32 KiB")
  expect(issues(" ".repeat(256 * 1024) + JSON.stringify(base), "saved")[0].message).toContain("256 KiB")
  expect(
    issues({ ...base, stages: [{ ...base.stages[0], for_each: { items: ["😀".repeat(1024)] } }] })[0].message,
  ).toContain("4 KiB")
  expect(issues({ ...base, stages: [{ ...base.stages[0], prompt: "😀".repeat(4097) }] })[0].message).toContain("16 KiB")
})

test("limits, stage count, identifiers and supported output schemas are enforced", () => {
  for (const limits of [{ max_agents: 1001 }, { concurrency: 0 }, { minutes: 1441 }, { steps: 1.5 }, { usd: 0 }])
    expect(issues({ ...base, limits }).length).toBeGreaterThan(0)
  expect(issues({ ...base, stages: [] }).length).toBeGreaterThan(0)
  expect(issues({ ...base, stages: Array(33).fill(base.stages[0]) }).length).toBeGreaterThan(0)
  expect(issues({ ...base, stages: [{ id: "nested", workflow: "UpperCase" }] }).length).toBeGreaterThan(0)
  expect(issues({ ...base, stages: [{ ...base.stages[0], output: { schema: { type: "string" } } }] })[0].path).toBe(
    "/stages/0/output/schema",
  )
})

test("every remaining bound refuses one past its limit at its exact path", () => {
  const stage = base.stages[0]
  const verify = {
    prompt: "Check {{output}}",
    output: { schema: { type: "object" } },
    until: { path: "ok", equals: true },
  }
  const ids = (count: number) => Array.from({ length: count }, (_, index) => `s${index}`)
  const cases: [unknown, string, string][] = [
    [{ ...base, title: "x".repeat(81) }, "/title", "at most 80"],
    [{ ...base, description: "x".repeat(501) }, "/description", "at most 500"],
    [{ ...base, inputs: Object.fromEntries(ids(17).map((id) => [id, {}])) }, "/inputs", "at most 16"],
    [{ ...base, stages: [{ ...stage, phase: "x".repeat(41) }] }, "/stages/0/phase", "at most 40"],
    [{ ...base, stages: [{ ...stage, title: "x".repeat(61) }] }, "/stages/0/title", "at most 60"],
    [
      { ...base, stages: [{ ...stage, owned_paths: ids(17).map((id) => `src/${id}.ts`) }] },
      "/stages/0/owned_paths",
      "at most 16",
    ],
    [
      { ...base, stages: [{ ...stage, success_criteria: Array(9).fill("done") }] },
      "/stages/0/success_criteria",
      "at most 8",
    ],
    [{ ...base, stages: [{ ...stage, retries: 3 }] }, "/stages/0/retries", "between 0 and 2"],
    [{ ...base, stages: [{ ...stage, retries: -1 }] }, "/stages/0/retries", "between 0 and 2"],
    [
      { ...base, stages: [{ ...stage, verify: { ...verify, max_rounds: 6 } }] },
      "/stages/0/verify/max_rounds",
      "between 1 and 5",
    ],
    [
      { ...base, stages: [{ ...stage, verify: { ...verify, max_rounds: 0 } }] },
      "/stages/0/verify/max_rounds",
      "between 1 and 5",
    ],
    [{ ...base, stages: [{ ...stage, after: ids(33) }] }, "/stages/0/after", "at most 32"],
    [{ ...base, stages: [{ ...stage, for_each: { from: ids(33) } }] }, "/stages/0/for_each/from", "at most 32"],
    [
      { ...base, stages: [{ ...stage, for_each: { from: "review", limit: 1001 } }] },
      "/stages/0/for_each/limit",
      "between 1 and 1000",
    ],
    [{ ...base, result: { max_items: 1001 } }, "/result/max_items", "between 1 and 1000"],
  ]
  for (const [value, path, bound] of cases)
    expect(
      issues(value).some((issue) => issue.path === path && issue.message.includes(bound)),
      path,
    ).toBe(true)
  // Each limit itself is accepted.
  expect(WorkflowSpec.parse({ ...base, title: "x".repeat(80), description: "x".repeat(500) }).ok).toBe(true)
  expect(
    WorkflowSpec.parse({ ...base, stages: [{ ...stage, retries: 2, verify: { ...verify, max_rounds: 5 } }] }).ok,
  ).toBe(true)
})

test("the guide embeds the same complete examples validated by the core", async () => {
  const guide = await readFile(new URL("../../../engine/src/orchestration/guide.txt", import.meta.url), "utf8")
  const specs = [...guide.matchAll(/```json\n([\s\S]*?)\n```/g)].map((match) => JSON.parse(match[1]))
  expect(specs).toEqual(examples.map((example) => example.spec))
  for (const spec of specs) expect(WorkflowSpec.parse(spec).ok).toBe(true)
})
