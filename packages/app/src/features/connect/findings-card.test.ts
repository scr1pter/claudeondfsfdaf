import { expect, test } from "bun:test"
import { actOnFindings } from "./findings-card-model"
import { finding, reviewRun, sessionID } from "./test-fixture"

test("fix actions reload the owned review and hand off identifiers without applying a patch", async () => {
  const calls: string[] = []
  await actOnFindings(
    { run: "cr_fixture", sessionID, action: "worktree" },
    {
      load: async () => {
        calls.push("load")
        return reviewRun()
      },
      send: (text) => {
        expect(calls).toEqual(["load"])
        expect(text).toContain("worktree")
        expect(text).not.toContain(finding.body)
        calls.push("send")
        return true
      },
      dismiss: async () => {
        throw new Error("A fix cannot dismiss findings")
      },
    },
  )
  expect(calls).toEqual(["load", "send"])
})

test("a composer that retains a draft never gets an alternate session or direct repair", async () => {
  let dismissals = 0
  await expect(
    actOnFindings(
      { run: "cr_fixture", sessionID, action: "fix" },
      {
        load: async () => reviewRun(),
        send: () => false,
        dismiss: async () => {
          dismissals++
          return reviewRun()
        },
      },
    ),
  ).rejects.toThrow("current draft")
  expect(dismissals).toBe(0)
})

test("a person dismisses through the owner endpoint without giving that operation to a model", async () => {
  let dismissed = 0
  await actOnFindings(
    { run: "cr_fixture", sessionID, action: "dismiss" },
    {
      load: async () => reviewRun(),
      send: () => {
        throw new Error("Dismissal must not start a model")
      },
      dismiss: async (run, input) => {
        expect(run).toBe("cr_fixture")
        expect(input).toEqual({ sessionID, findings: [finding.id] })
        dismissed++
        return reviewRun()
      },
    },
  )
  expect(dismissed).toBe(1)
})

test("stale, cross-session and forged selections cause no owner operation", async () => {
  let operations = 0
  const run = reviewRun()
  const ports = {
    load: async () => ({ ...run, result: { ...run.result!, findings: [{ ...finding, status: "fixed" as const }] } }),
    send: () => {
      operations++
      return true
    },
    dismiss: async () => {
      operations++
      return run
    },
  }
  await expect(actOnFindings({ run: run.id, sessionID, action: "fix" }, ports)).rejects.toThrow("no longer available")
  await expect(
    actOnFindings({ run: run.id, sessionID: "ses_other", action: "dismiss" }, { ...ports, load: async () => run }),
  ).rejects.toThrow("no longer available")
  await expect(
    actOnFindings(
      { run: run.id, sessionID, action: "fix", findings: [finding.id, finding.id] },
      { ...ports, load: async () => run },
    ),
  ).rejects.toThrow("once")
  expect(operations).toBe(0)
})

test("a fresh task review refuses both generic fixes before composer send, while owner dismissal remains available", async () => {
  const run = reviewRun()
  if (run.request.action !== "review") throw new Error("The fixture must be a review.")
  const task = { ...run, request: { ...run.request, target: { kind: "task" as const, task: sessionID } } }
  const sent: string[] = []
  const dismissed: string[] = []
  const ports = {
    load: async () => task,
    send: (text: string) => {
      sent.push(text)
      return true
    },
    dismiss: async (id: string) => {
      dismissed.push(id)
      return task
    },
  }
  for (const action of ["fix", "worktree"] as const)
    await expect(actOnFindings({ run: task.id, sessionID, action }, ports)).rejects.toThrow("isolated checkout")
  expect(sent).toEqual([])
  expect(dismissed).toEqual([])
  await actOnFindings({ run: task.id, sessionID, action: "dismiss" }, ports)
  expect(dismissed).toEqual([task.id])
})
