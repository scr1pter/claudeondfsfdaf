import { expect, test } from "bun:test"
import { initialSessionTitle } from "./session-title"

test("uses the first nonempty typed line without copying the rest of the prompt", () => {
  expect(initialSessionTitle(" \n  Fix the login   redirect\nafter the session expires")).toBe("Fix the login redirect")
})

test("uses an attachment or comment label for a prompt with no typed text", () => {
  expect(initialSessionTitle(" \n ", ["", "diagram.png"])).toBe("diagram.png")
  expect(initialSessionTitle("", ["  Check this boundary\nprivate file context follows", "invoice.ts"])).toBe(
    "Check this boundary",
  )
  expect(initialSessionTitle("", [])).toBeUndefined()
})

test("keeps short titles intact and truncates long titles without splitting Unicode characters", () => {
  expect(initialSessionTitle("x".repeat(50))).toBe("x".repeat(50))
  expect(initialSessionTitle("x".repeat(51))).toBe(`${"x".repeat(50)}...`)
  expect(initialSessionTitle("🦊".repeat(51))).toBe(`${"🦊".repeat(50)}...`)
})
