import { expect, test } from "bun:test"
import { handoffFindings } from "./handoff"
import { finding, reviewRun, sessionID } from "./test-fixture"

const input = () => ({
  sessionID,
  target: { kind: "uncommitted" as const },
  findings: [finding],
  selected: [finding.id],
  mode: "worktree" as const,
  owner: true,
})

test("saves findings before sending only their reference to the matching session", async () => {
  const calls: string[] = []
  await handoffFindings(input(), {
    register: async (request) => {
      expect(request).toEqual({ sessionID, target: input().target, findings: [finding] })
      calls.push("registered")
      return reviewRun()
    },
    send: async (request) => {
      expect(calls).toEqual(["registered"])
      expect(request.sessionID).toBe(sessionID)
      expect(request.text).toContain("cr_fixture")
      expect(request.text).not.toContain(finding.body)
      calls.push("sent")
    },
  })
  expect(calls).toEqual(["registered", "sent"])
})

test("a guest or an invalid selection makes no request", async () => {
  const calls: string[] = []
  const ports = {
    register: async () => {
      calls.push("registered")
      return reviewRun()
    },
    send: async () => {
      calls.push("sent")
    },
  }
  await expect(handoffFindings({ ...input(), owner: false }, ports)).rejects.toThrow("Only the owner")
  await expect(handoffFindings({ ...input(), selected: ["other"] }, ports)).rejects.toThrow("Select findings")
  await expect(handoffFindings({ ...input(), selected: [finding.id, finding.id] }, ports)).rejects.toThrow("once")
  expect(calls).toEqual([])
})

test("registration failure or a mismatched server session never sends a repair", async () => {
  let sent = 0
  await expect(
    handoffFindings(input(), {
      register: async () => {
        throw new Error("Save failed")
      },
      send: async () => {
        sent++
      },
    }),
  ).rejects.toThrow("Save failed")
  await expect(
    handoffFindings(input(), {
      register: async () => ({ ...reviewRun(), request: { ...reviewRun().request, requester: { kind: "user" } } }),
      send: async () => {
        sent++
      },
    }),
  ).rejects.toThrow("no longer available")
  expect(sent).toBe(0)
})
