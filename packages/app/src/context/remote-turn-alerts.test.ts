import { beforeEach, describe, expect, test } from "bun:test"
import type { Event, PermissionRequest } from "@vectordevai/sdk/v2/client"
import type { ModelPlanStatus } from "@vectordevai/core/model-plan-status"
import { createAskNotificationController } from "@/pages/layout/ask-notification-controller"
import { createHelperPhoneAlerts } from "./helper-phone-alert"
import { sessionNotificationAllowed } from "./notification-event-gate"
import { autoRespondsPermission, directoryAcceptKey, phoneTurnAllows, sessionLineage } from "./permission-auto-respond"
import { resetPhoneAlerts, sendPhoneAlert, type PhoneAlert } from "./phone-alerts"
import type { Platform } from "./platform"

// Track B B09: a turn a paired phone started stays with a person, with the real auto-accept rules, Hands' ask alerts
// (pages/layout/ask-notification-controller.ts, read only here) and Codium's helper alerts all listening, and a helper's
// wait reaches the phone once, from helper-phone-alert.ts. `isPhoneTurn` stands in for the desktop's RemoteTurns
// (packages/desktop/src/main/remote-routes-combined.test.ts covers that side). The provider's own wiring of these rules,
// permission.tsx's willAutoRespond, is pinned by the source guard in permission-auto-respond.test.ts.

const DIRECTORY = "/repo"
const NOW = 1_000_000
const ROOT = { id: "ses_root", title: "Fix the login" }
// The engine's lifecycle record for a running helper, as sync.session.resolve returns it to the ask controller.
const HELPER = {
  id: "ses_helper",
  parentID: "ses_root",
  title: "Delete the build folder (@general subagent)",
  metadata: { subagent: { rootSessionID: ROOT.id, parentSessionID: ROOT.id, status: "running" } },
}
const SESSIONS = [ROOT, HELPER]
const listed = {
  signedIn: true,
  enabled: true,
  access: true,
  listed: ["alerts"],
  entitlements: { rank: 1 },
  purchased: { bought: false },
  empty: false,
  low: false,
} as unknown as ModelPlanStatus.Status

beforeEach(() => resetPhoneAlerts())

// `viewing` is the conversation open here, as the app checks it: the ask controller counts its helpers as viewed too
// (ask-notifications.ts), and the helper path checks the conversation itself (notification.tsx).
function fixture(isPhoneTurn: (ids: string[]) => Promise<boolean>, viewing?: string) {
  const sent: PhoneAlert[] = []
  const desktop: string[] = []
  const decisions: boolean[] = []
  const platform = {
    platform: "desktop",
    vectorAccount: { codium: async () => listed },
    phoneAlerts: { send: async (alert: PhoneAlert) => void sent.push(alert) },
  } as unknown as Platform
  const choices = { event: () => true, quietHours: () => null }
  const autoAccept = { [directoryAcceptKey(DIRECTORY)]: true }
  // What the permission provider decides: auto-accept's settings, then the desktop's phone-turn check (fails closed).
  const autoResponds = async (request: PermissionRequest, directory: string) =>
    autoRespondsPermission(autoAccept, SESSIONS, request, directory) &&
    (await phoneTurnAllows(isPhoneTurn, sessionLineage(SESSIONS, request.sessionID)))
  const asks = createAskNotificationController({
    resolve: async (id) => SESSIONS.find((session) => session.id === id),
    autoResponds,
    desktopOwns: () => false,
    preferences: () => ({ permissions: true, agent: true, permissionSound: false }),
    copy: (kind) => ({ title: kind, description: "" }),
    notify: (title) => desktop.push(title),
    sound: () => {},
    // Hands' own phone alert for an ask (its wording is Hands', pages/layout/ask-notifications.ts).
    phoneAlert: () => sendPhoneAlert(platform, choices, { event: "needsYou", title: "ask", route: "approvals" }),
    viewed: (session) => !!viewing && (session.id === viewing || session.parentID === viewing),
    toast: () => 1,
    dismissToast: () => {},
    now: () => NOW,
  })
  const helpers = createHelperPhoneAlerts({
    lookup: async (_directory, id) => SESSIONS.find((session) => session.id === id),
    allowed: sessionNotificationAllowed,
    viewed: (_directory, id) => id === viewing,
    disposed: () => false,
    send: (alert) => sendPhoneAlert(platform, choices, alert),
    now: () => NOW,
    settleMs: 10,
  })
  const helperInfo = (subagent: Record<string, unknown>) => ({
    ...HELPER,
    metadata: { subagent: { rootSessionID: ROOT.id, status: "running", ...subagent } },
  })

  /**
   * The engine publishes the ask, and its attention tracker records the helper's wait; the provider decides, and an
   * answer it sends clears the wait. Every listener sees the same events, each delivered `times` over.
   */
  async function ask(request: PermissionRequest, times = 1) {
    const event: { name: string; details: Event } = {
      name: DIRECTORY,
      details: { id: `evt_${request.id}`, type: "permission.asked", properties: request } as Event,
    }
    const waiting = helperInfo({ waiting: { kind: "permission", requestID: request.id, since: NOW - 10 } })
    const pending = Array.from({ length: times }, () => [
      asks.observe(event),
      request.sessionID === HELPER.id ? helpers(DIRECTORY, waiting) : helpers(DIRECTORY, { ...ROOT, metadata: {} }),
    ]).flat()
    const answered = await autoResponds(request, DIRECTORY)
    decisions.push(answered)
    if (answered) pending.push(helpers(DIRECTORY, helperInfo({})))
    await Promise.all(pending)
  }

  const codium = () => sent.filter((alert) => alert.route === "sessions")
  return { sent, desktop, decisions, ask, helpers, helperInfo, codium }
}

const edit = (sessionID = HELPER.id, id = "per_1"): PermissionRequest =>
  ({ id, sessionID, permission: "edit", patterns: ["src/login.ts"], always: [], metadata: {} }) as PermissionRequest

describe("a phone's turn with every listener on", () => {
  test("a helper's request inside a phone's turn is left to a person; Codium's helper path alerts the phone once", async () => {
    const marked = new Set([ROOT.id])
    const env = fixture(async (ids) => ids.some((id) => marked.has(id)))
    await env.ask(edit(), 2)
    expect(env.decisions).toEqual([false])
    // The ask alerts on this computer once, whoever else listens.
    expect(env.desktop).toEqual(["permission"])
    // The phone gets one push for this one ask, from the helper path, titled with the conversation.
    expect(env.sent).toEqual([{ event: "needsYou", title: "A helper needs you: Fix the login", route: "sessions" }])
    expect(JSON.stringify(env.sent)).not.toContain(HELPER.title)
  })

  test("a helper's request in a phone's turn reaches the phone once while its conversation is open here", async () => {
    // The desktop left open on the conversation while the person drives it from the phone: an ask's push never
    // depended on who is looking here.
    const env = fixture(async (ids) => ids.includes(ROOT.id), ROOT.id)
    await env.ask(edit(), 2)
    expect(env.decisions).toEqual([false])
    expect(env.sent).toEqual([{ event: "needsYou", title: "A helper needs you: Fix the login", route: "sessions" }])
  })

  test("the same request outside a phone's turn is answered by auto-accept, and no one is alerted", async () => {
    const env = fixture(async () => false)
    await env.ask(edit(), 2)
    expect(env.decisions).toEqual([true])
    expect(env.desktop).toEqual([])
    expect(env.sent).toEqual([])
  })

  test("a phone-turn check that fails holds the request for a person (fails closed)", async () => {
    const env = fixture(async () => Promise.reject(new Error("main process gone")))
    await env.ask(edit())
    expect(env.decisions).toEqual([false])
    expect(env.desktop).toEqual(["permission"])
    expect(env.codium().length).toBe(1)
  })

  test("Hands' own ask in a phone's turn is held, and the helper alerts add nothing for the conversation's own ask", async () => {
    const env = fixture(async (ids) => ids.includes(ROOT.id))
    await env.ask(
      {
        id: "per_hands",
        sessionID: ROOT.id,
        permission: "computer_app",
        patterns: [],
        always: [],
        metadata: {},
      } as PermissionRequest,
      2,
    )
    expect(env.decisions).toEqual([false])
    expect(env.codium()).toEqual([])
    expect(env.sent).toEqual([{ event: "needsYou", title: "ask", route: "approvals" }])
  })

  test("an interrupted helper alerts once, with no report, prompt, command or helper title in it", async () => {
    const env = fixture(async () => true)
    const interrupted = env.helperInfo({
      status: "cancelled",
      interruption: { at: NOW - 30, cause: "crash", reason: "rm -rf build was running" },
      resultSummary: "report: removed the build folder",
      notification: "report ready",
    })
    await Promise.all([1, 2, 3].map(() => env.helpers(DIRECTORY, interrupted)))
    expect(env.sent).toEqual([
      { event: "needsYou", title: "A helper was interrupted: Fix the login", route: "sessions" },
    ])
    for (const text of ["rm -rf", "report", HELPER.title]) expect(JSON.stringify(env.sent)).not.toContain(text)
    expect(env.desktop).toEqual([])
  })

  test("the notification provider sends helper alerts only through createHelperPhoneAlerts", async () => {
    const source = await Bun.file(new URL("./notification.tsx", import.meta.url)).text()
    expect(source.match(/createHelperPhoneAlerts\(/g)?.length).toBe(1)
    expect(source).not.toContain("helperPhoneAlert(")
  })
})
