import { describe, expect, test } from "bun:test"
import { createHelperPhoneAlerts, helperPhoneAlert } from "./helper-phone-alert"
import { sessionNotificationAllowed } from "./notification-event-gate"
import type { PhoneAlert } from "./phone-alerts"

test("helper alerts name only fresh waiting or interrupted lifecycle states", () => {
  const child = { id: "child", parentID: "parent", metadata: { subagent: { rootSessionID: "root", waiting: { kind: "question", since: 1000, summary: "private" } } } }
  expect(helperPhoneAlert(child, 1100)).toMatchObject({ parent: "root", label: "A helper needs you" })
  expect(JSON.stringify(helperPhoneAlert(child, 1100))).not.toContain("private")
  expect(helperPhoneAlert(child, 1000 + 6 * 60_000)).toBeUndefined()
  expect(helperPhoneAlert({ ...child, metadata: { subagent: { interruption: { at: 1000, resumedAt: 1050 } } } }, 1100)).toBeUndefined()
  expect(helperPhoneAlert({ ...child, metadata: { subagent: { interruption: { at: 1000 } } } }, 1100)?.label).toBe("A helper was interrupted")
  expect(helperPhoneAlert({ id: "root", metadata: { subagent: {} } }, 1100)).toBeUndefined()
})

describe("createHelperPhoneAlerts", () => {
  const NOW = 1_000_000
  const ROOT = { title: "Fix the login" }
  const helper = (subagent: Record<string, unknown>, id = "ses_helper") => ({
    id,
    parentID: "ses_root",
    title: "Delete the build folder (@general subagent)",
    metadata: {
      subagent: { rootSessionID: "ses_root", status: "running", resultSummary: "report: rm -rf build", ...subagent },
    },
  })
  const waiting = (since: number, requestID = "per_1") =>
    helper({ waiting: { kind: "permission", requestID, since, summary: "edit rm -rf build" } })

  function fixture(state: { session?: Record<string, unknown>; viewed?: boolean; disposed?: boolean } = {}) {
    const sent: PhoneAlert[] = []
    const looked: string[] = []
    const options = { session: ROOT as Record<string, unknown> | undefined, viewed: false, disposed: false, ...state }
    const alerts = createHelperPhoneAlerts({
      lookup: async (_directory, sessionID) => {
        looked.push(sessionID)
        return sessionID === "ses_root" ? options.session : undefined
      },
      allowed: sessionNotificationAllowed,
      viewed: () => options.viewed,
      disposed: () => options.disposed,
      send: (alert) => sent.push(alert),
      now: () => NOW,
      settleMs: 5,
    })
    return { sent, looked, options, alerts }
  }

  test("a waiting helper alerts once, titled with its conversation, after its wait has stood", async () => {
    const { sent, alerts } = fixture()
    await Promise.all([1, 2, 3].map(() => alerts("/repo", waiting(NOW - 10))))
    expect(sent).toEqual([{ event: "needsYou", title: "A helper needs you: Fix the login", route: "sessions" }])
    expect(JSON.stringify(sent)).not.toContain("rm -rf")
    expect(JSON.stringify(sent)).not.toContain("report")
    expect(JSON.stringify(sent)).not.toContain("Delete the build folder")
  })

  test("a request answered before the settle, as auto-accept answers it, sends nothing", async () => {
    const { sent, alerts } = fixture()
    const pending = alerts("/repo", waiting(NOW - 10))
    // The engine clears the helper's `waiting` once the request is answered.
    void alerts("/repo", helper({}))
    await pending
    expect(sent).toEqual([])
  })

  test("a late update repeating a wait answered during the settle sends nothing", async () => {
    const { sent, alerts } = fixture()
    const pending = alerts("/repo", waiting(NOW - 10))
    void alerts("/repo", helper({}))
    // Replayed or out of order: the same wait, already answered.
    void alerts("/repo", waiting(NOW - 10))
    await pending
    expect(sent).toEqual([])
  })

  test("a wait that moves on to the helper's next request alerts once, for the request still waiting", async () => {
    const { sent, alerts } = fixture()
    const first = alerts("/repo", waiting(NOW - 20, "per_1"))
    const second = alerts("/repo", waiting(NOW - 10, "per_2"))
    await Promise.all([first, second])
    expect(sent.length).toBe(1)
  })

  test("an interruption alerts once per interruption, and not once resumed or dismissed", async () => {
    const { sent, alerts } = fixture()
    const interrupted = (at: number, extra: Record<string, unknown> = {}) =>
      helper({ status: "cancelled", interruption: { at, cause: "crash", ...extra } })
    await Promise.all([alerts("/repo", interrupted(NOW - 30)), alerts("/repo", interrupted(NOW - 30))])
    await alerts("/repo", interrupted(NOW - 30))
    expect(sent).toEqual([{ event: "needsYou", title: "A helper was interrupted: Fix the login", route: "sessions" }])
    await alerts("/repo", interrupted(NOW - 5))
    expect(sent.length).toBe(2)
    await alerts("/repo", interrupted(NOW - 4, { resumedAt: NOW - 1 }))
    await alerts("/repo", interrupted(NOW - 3, { dismissedAt: NOW - 1 }))
    expect(sent.length).toBe(2)
  })

  test("an interruption goes at once; only a wait waits for the settle", async () => {
    const sent: PhoneAlert[] = []
    const alerts = createHelperPhoneAlerts({
      lookup: async () => ROOT,
      allowed: () => true,
      viewed: () => false,
      disposed: () => false,
      send: (alert) => sent.push(alert),
      now: () => NOW,
      // Far longer than the test may take: an interruption that waited for it would time out.
      settleMs: 600_000,
    })
    await alerts("/repo", helper({ status: "cancelled", interruption: { at: NOW - 30, cause: "crash" } }))
    expect(sent).toEqual([{ event: "needsYou", title: "A helper was interrupted: Fix the login", route: "sessions" }])
  })

  test("a wait reaches the phone whoever looks at its conversation here; an interruption does not", async () => {
    // A helper's ask has no other phone push (ask-notification-controller.ts leaves it to this path), and an ask's push
    // never depended on what this computer shows: the person may be driving the conversation from the phone.
    const asked = fixture({ viewed: true })
    await asked.alerts("/repo", waiting(NOW - 10))
    expect(asked.sent).toEqual([{ event: "needsYou", title: "A helper needs you: Fix the login", route: "sessions" }])
    const interrupted = fixture({ viewed: true })
    await interrupted.alerts("/repo", helper({ status: "cancelled", interruption: { at: NOW - 30, cause: "crash" } }))
    expect(interrupted.sent).toEqual([])
  })

  test("nothing goes for a conversation that is internal, a helper or unknown, or once disposed", async () => {
    for (const state of [
      { session: { ...ROOT, internal: "vectorscope" } },
      { session: { ...ROOT, parentID: "ses_above" } },
      { session: undefined },
      { disposed: true },
    ]) {
      const { sent, alerts } = fixture(state)
      await alerts("/repo", waiting(NOW - 10))
      expect({ state, sent }).toEqual({ state, sent: [] })
    }
    const late = fixture()
    const pending = late.alerts("/repo", waiting(NOW - 10))
    late.options.disposed = true
    await pending
    expect(late.sent).toEqual([])
    expect(late.looked).toEqual([])
  })
})
