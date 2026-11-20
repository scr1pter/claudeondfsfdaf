import { describe, expect, test } from "bun:test"
import { PlaybookCheck } from "@vectordevai/core/playbooks/check"

// WP A36 and B07: the saved-workflow part of the playbook check. A playbook runs on the plan of whoever installs it, so
// it names a model only as a Codium role (`codium:floor`, `codium:default` or `codium:ceiling`, which the engine
// resolves per plan) or leaves the model to the runner, and it nests only other Vector Playbooks.

const verify = (extra: Record<string, unknown> = {}) => ({
  prompt: "Check the producer's result.",
  output: {
    schema: {
      type: "object",
      properties: { approved: { type: "boolean" } },
      required: ["approved"],
      additionalProperties: false,
    },
  },
  until: { path: "approved", equals: true },
  ...extra,
})
const playbook = (stage: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) => ({
  version: 1,
  title: "Flaky test hunt",
  stages: [{ id: "hunt", prompt: "Run `bun test`.", ...stage }],
  ...extra,
})
const issues = (value: unknown) => {
  const result = PlaybookCheck.validate({
    name: "vector-flaky-tests",
    bytes: new TextEncoder().encode(JSON.stringify(value)),
    env: {},
  })
  return result.ok ? [] : result.issues
}

describe("the saved-workflow check", () => {
  test("a playbook names a model only as a Codium role, or leaves it to the runner", () => {
    expect(issues(playbook())).toEqual([])
    expect(issues(playbook({ verify: verify() }))).toEqual([])
    for (const model of ["codium:floor", "codium:default", "codium:ceiling"]) {
      expect(issues(playbook({ model }))).toEqual([])
      expect(issues(playbook({}, { defaults: { model } }))).toEqual([])
      expect(issues(playbook({ verify: verify({ model }) }))).toEqual([])
    }
  })

  test("any other model is refused where it is named", () => {
    const message = expect.stringContaining("only as a Codium role")
    for (const model of [
      "lmstudio/test-model",
      "vector-plan/some-model",
      "codium:max",
      "codium:",
      "Codium:default",
      "codium:default ",
      "codium:floor:x",
      "{{inputs.model}}",
    ]) {
      expect({ model, issues: issues(playbook({ model })) }).toEqual({
        model,
        issues: [{ path: "/stages/0/model", message }],
      })
      expect({ model, issues: issues(playbook({}, { defaults: { model } })) }).toEqual({
        model,
        issues: [{ path: "/defaults/model", message }],
      })
      expect({ model, issues: issues(playbook({ verify: verify({ model }) })) }).toEqual({
        model,
        issues: [{ path: "/stages/0/verify/model", message }],
      })
    }
    expect(
      issues(
        playbook(
          { model: "lmstudio/test-model", verify: verify({ model: "codium:max" }) },
          { defaults: { model: "vector-plan/some-model" } },
        ),
      ).map((issue) => issue.path),
    ).toEqual(["/defaults/model", "/stages/0/model", "/stages/0/verify/model"])
  })

  test("a playbook nests only other Vector Playbooks", () => {
    const nested = (workflow: string) => ({
      version: 1,
      title: "Docs pass",
      stages: [
        { id: "hunt", prompt: "Run `bun test`." },
        { id: "docs", workflow, after: ["hunt"] },
      ],
    })
    expect(issues(nested("vector-docs-drift"))).toEqual([])
    expect(issues(nested("my-own-flow"))).toEqual([
      { path: "/stages", message: "A Vector Playbook may nest only other personal Vector Playbooks." },
    ])
  })
})
