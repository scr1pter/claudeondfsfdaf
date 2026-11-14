import { expect, test } from "bun:test"
import { helperPhoneAlert } from "./helper-phone-alert"

test("helper alerts name only fresh waiting or interrupted lifecycle states", () => {
  const child = { id: "child", parentID: "parent", metadata: { subagent: { rootSessionID: "root", waiting: { kind: "question", since: 1000, summary: "private" } } } }
  expect(helperPhoneAlert(child, 1100)).toMatchObject({ parent: "root", label: "A helper needs you" })
  expect(JSON.stringify(helperPhoneAlert(child, 1100))).not.toContain("private")
  expect(helperPhoneAlert(child, 1000 + 6 * 60_000)).toBeUndefined()
  expect(helperPhoneAlert({ ...child, metadata: { subagent: { interruption: { at: 1000, resumedAt: 1050 } } } }, 1100)).toBeUndefined()
  expect(helperPhoneAlert({ ...child, metadata: { subagent: { interruption: { at: 1000 } } } }, 1100)?.label).toBe("A helper was interrupted")
  expect(helperPhoneAlert({ id: "root", metadata: { subagent: {} } }, 1100)).toBeUndefined()
})
