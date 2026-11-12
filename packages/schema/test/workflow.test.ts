import { expect, test } from "bun:test"
import { Schema } from "effect"
import { Workflow } from "../src/workflow"

test("workflow owner inputs omit absent values on the wire", () => {
  expect(Schema.encodeSync(Workflow.StartInput)({ spec: undefined, name: "review", quiet: undefined })).toEqual({
    name: "review",
  })
  expect(
    Schema.decodeUnknownSync(Workflow.StartInput)({ name: "review", inputs: { files: ["src/a.ts"], strict: true } }),
  ).toEqual({ name: "review", inputs: { files: ["src/a.ts"], strict: true } })
  expect(() => Schema.decodeUnknownSync(Workflow.StartInput)({ inputs: { code: () => true } })).toThrow()
})

test("workflow node status preserves future values while bounding displayed text", () => {
  const value = { key: "a", stage: "check", phase: "review", item: "0", status: "future-state" }
  expect(Schema.decodeUnknownSync(Workflow.Node)(value)).toEqual(value)
  expect(() => Schema.decodeUnknownSync(Workflow.Node)({ ...value, error: "x".repeat(1025) })).toThrow()
  expect(() => Schema.decodeUnknownSync(Workflow.Node)({ ...value, preview: "x".repeat(2049) })).toThrow()
  expect(() => Schema.decodeUnknownSync(Workflow.Node)({ ...value, round: -1 })).toThrow()
})

test("workflow plans distinguish dynamic sources from a literal empty stage", () => {
  const stage = { id: "check", title: "Check", phase: "", agent: "general", serial: false, writes: "none", asks: [] }
  expect(Schema.decodeUnknownSync(Workflow.PlanStage)({ ...stage, items: "dynamic" }).items).toBe("dynamic")
  expect(Schema.decodeUnknownSync(Workflow.PlanStage)({ ...stage, items: 0 }).items).toBe(0)
  expect(() => Schema.decodeUnknownSync(Workflow.PlanStage)({ ...stage, items: -1 })).toThrow()
})

test("workflow public identifiers remain unique", () => {
  const contracts = [
    Workflow.Issue,
    Workflow.PlanStage,
    Workflow.Plan,
    Workflow.Saved,
    Workflow.SavedList,
    Workflow.ValidateInput,
    Workflow.Validation,
    Workflow.StartInput,
    Workflow.ResumeInput,
    Workflow.Started,
    Workflow.Node,
    Workflow.RunList,
    Workflow.RunDetail,
  ]
  const identifiers = contracts.map((contract) => contract.ast.annotations?.identifier)
  expect(identifiers.every((identifier) => typeof identifier === "string" && identifier.startsWith("Workflow."))).toBe(
    true,
  )
  expect(new Set(identifiers).size).toBe(contracts.length)
})

test("workflow text bounds count UTF-8 bytes", () => {
  const value = { key: "a", stage: "check", phase: "", item: "0", status: "failed" }
  expect(() => Schema.decodeUnknownSync(Workflow.Node)({ ...value, error: "界".repeat(342) })).toThrow()
  expect(() => Schema.decodeUnknownSync(Workflow.Node)({ ...value, preview: "界".repeat(683) })).toThrow()
  expect(Schema.decodeUnknownSync(Workflow.Node)({ ...value, error: "界".repeat(341) }).error).toHaveLength(341)
})
