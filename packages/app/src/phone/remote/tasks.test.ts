import { expect, test } from "bun:test"
import { decodeTasks, taskStatus } from "./tasks"

test("the phone task projection includes helper attention and shell status without private payloads", () => {
  const rows = decodeTasks({ tasks: [{ id: "s1", title: "Check", status: "waiting_on_user", waiting: { kind: "question" }, usage: { tokens: 123 }, prompt: "secret" }],
    shells: [{ id: "shl_1", title: "Tests", status: "interrupted", interrupted: { at: 1 }, command: "private command", outputPath: "/private" }],
  })
  expect(rows).toHaveLength(2)
  expect(rows[0]?.detail).toContain("Approvals")
  expect(rows[1]?.detail).toContain("Interrupted")
  expect(JSON.stringify(rows)).not.toMatch(/secret|private|usage|123|tokens/)
  expect(taskStatus("waiting_on_user")).toBe("Waiting for you")
  expect(decodeTasks({ tasks: [{ id: "bad", title: "bad", status: "new-unknown" }] })).toEqual([])
})
