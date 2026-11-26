import { expect, test } from "bun:test"
import { taskMessageNote } from "./task-continue-copy"

// A finished task's own session refuses prompts, so "Open its session to continue" sent people in a loop.

test("a finished task that takes no more messages points to the conversation, never to its session", () => {
  const note = taskMessageNote(false)
  expect(note).not.toContain("Open its session")
  expect(note).toContain("takes no more messages")
  expect(note).toContain("Ask in your conversation to continue its work")
  expect(note).toContain("your draft is kept")
})

test("a running task's note is unchanged", () => {
  expect(taskMessageNote(true)).toBe("Delivered at the next safe step. Your conversation stays open.")
})

test("the pane shows this note and no longer sends people to the task's session", async () => {
  const pane = await Bun.file(new URL("./background-tasks-pane.tsx", import.meta.url)).text()
  expect(pane).toContain("taskMessageNote(editable())")
  expect(pane).not.toContain("Open its session")
})
