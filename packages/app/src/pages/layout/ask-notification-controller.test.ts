import { expect, test } from "bun:test"
import type { Event, QuestionRequest } from "@vectordevai/sdk/v2/client"
import { createAskNotificationController } from "./ask-notification-controller"

const directory = "/fixture/project"
const sessionID = "ses_fixture"
const session = { id: sessionID, title: "Fixture conversation" }
function permission(id: string, permission = "computer_app"): { name: string; details: Event } {
  return {
    name: directory,
    details: {
      id: `evt_${id}`,
      type: "permission.asked",
      properties: { id, sessionID, permission, patterns: [], always: [], metadata: {} },
    },
  }
}
function question(id: string, kind?: "handoff" | "check_in"): { name: string; details: Event } {
  const metadata: QuestionRequest["metadata"] =
    kind === "handoff"
      ? { computer: { kind: "handoff", reason: "other" } }
      : kind === "check_in"
        ? { computer: { kind: "check_in", actions: 40, minutes: 5 } }
        : undefined
  return {
    name: directory,
    details: {
      id: `evt_${id}`,
      type: "question.asked",
      properties: {
        id,
        sessionID,
        questions: [],
        ...(metadata ? { metadata } : {}),
      },
    },
  }
}
function fixture() {
  const state = {
    now: 10_000,
    owned: true,
    viewed: true,
    auto: false as boolean | Promise<boolean>,
    session: session as (typeof session & { internal?: string }) | undefined,
    preferences: { agent: true, permissions: true, permissionSound: true },
    sounds: 0,
    notifications: [] as { title: string; href: string }[],
    toasts: [] as { kind: string; href: string }[],
    dismissed: [] as number[],
    phones: [] as string[],
  }
  const controller = createAskNotificationController({
    resolve: async () => state.session,
    autoResponds: () => state.auto,
    desktopOwns: () => state.owned,
    preferences: () => state.preferences,
    copy: (kind) => ({ title: kind, description: "Fixture alert" }),
    notify: (title, _description, href) => state.notifications.push({ title, href }),
    sound: () => {
      state.sounds++
    },
    phoneAlert: (session) => state.phones.push(session.id),
    viewed: () => state.viewed,
    toast(kind, _title, _description, href) {
      state.toasts.push({ kind, href })
      return state.toasts.length
    },
    dismissToast: (id) => {
      state.dismissed.push(id)
    },
    now: () => state.now,
  })
  return { controller, state }
}

test("the shared live dispatcher leaves Hands app asks and handoffs to main but notifies for check-ins and ordinary asks", async () => {
  const fake = fixture()
  await fake.controller.observe(permission("per_app"))
  fake.state.now += 5001
  await fake.controller.observe(question("que_handoff", "handoff"))
  expect(fake.state.notifications).toEqual([])
  expect(fake.state.sounds).toBe(1)
  fake.state.now += 5001
  await fake.controller.observe(question("que_check_in", "check_in"))
  fake.state.now += 5001
  await fake.controller.observe(permission("per_bash", "bash"))
  expect(fake.state.notifications.map((item) => item.title)).toEqual(["question", "permission"])
  expect(fake.state.notifications.every((item) => item.href.endsWith(`/session/${sessionID}`))).toBe(true)
  expect(fake.state.toasts).toEqual([])
  fake.controller.close()
})

test("a server whose Hands run is not desktop-owned retains its app-ask and handoff notifications", async () => {
  const fake = fixture()
  fake.state.owned = false
  await fake.controller.observe(permission("per_remote_app"))
  fake.state.now += 5001
  await fake.controller.observe(question("que_remote_handoff", "handoff"))
  expect(fake.state.notifications.map((item) => item.title)).toEqual(["permission", "question"])
  fake.controller.close()
})

test("preferences suppress OS alerts while replies and close dismiss the real in-app alert ownership", async () => {
  const fake = fixture()
  fake.state.viewed = false
  fake.state.preferences = { agent: false, permissions: false, permissionSound: false }
  await fake.controller.observe(question("que_muted", "check_in"))
  expect(fake.state.notifications).toEqual([])
  expect(fake.state.toasts).toHaveLength(1)
  await fake.controller.observe({
    name: directory,
    details: {
      id: "evt_replied",
      type: "question.replied",
      properties: { requestID: "que_muted", sessionID, answers: [["Keep going"]] },
    },
  })
  expect(fake.state.dismissed).toEqual([1])
  await fake.controller.observe(permission("per_muted", "bash"))
  expect(fake.state.toasts).toHaveLength(2)
  expect(fake.state.sounds).toBe(0)
  fake.controller.close()
  fake.controller.close()
  expect(fake.state.dismissed).toEqual([1, 2])
})

test("the five-second cooldown is shared by ask kinds within one conversation and keeps other directories independent", async () => {
  const fake = fixture()
  await fake.controller.observe(question("que_first"))
  fake.state.now += 4999
  await fake.controller.observe(permission("per_too_soon", "bash"))
  expect(fake.state.notifications).toHaveLength(1)
  fake.state.now++
  await fake.controller.observe(permission("per_next", "bash"))
  expect(fake.state.notifications).toHaveLength(2)
  await fake.controller.observe({ ...question("que_other_directory"), name: "/fixture/other" })
  expect(fake.state.notifications).toHaveLength(3)
  fake.controller.close()
})

test("closing a server subscription fences a late session lookup before any sound, OS alert or toast", async () => {
  const state = { alerts: 0 }
  const lookup = Promise.withResolvers<typeof session>()
  const controller = createAskNotificationController({
    resolve: () => lookup.promise,
    autoResponds: () => false,
    desktopOwns: () => false,
    preferences: () => ({ agent: true, permissions: true, permissionSound: true }),
    copy: () => ({ title: "Fixture", description: "Fixture" }),
    notify: () => {
      state.alerts++
    },
    sound: () => {
      state.alerts++
    },
    viewed: () => false,
    toast: () => {
      state.alerts++
      return 1
    },
    dismissToast() {},
    now: () => 10_000,
  })
  const pending = controller.observe(permission("per_late", "bash"))
  controller.close()
  lookup.resolve(session)
  await pending
  expect(state.alerts).toBe(0)
})

test("auto-answered permissions, absent conversations and internal helper sessions never alert", async () => {
  const fake = fixture()
  fake.state.auto = true
  await fake.controller.observe(permission("per_auto", "bash"))
  fake.state.auto = false
  fake.state.session = undefined
  await fake.controller.observe(question("que_missing"))
  fake.state.session = { ...session, internal: "vectorscope.review" }
  await fake.controller.observe(question("que_internal"))
  expect(fake.state.notifications).toEqual([])
  expect(fake.state.toasts).toEqual([])
  expect(fake.state.sounds).toBe(0)
  expect(fake.state.phones).toEqual([])
  fake.controller.close()
})

test("paired-phone alerts share the observed-ask cooldown without duplicating desktop-owned notifications", async () => {
  const fake = fixture()
  await fake.controller.observe(permission("per_phone"))
  await fake.controller.observe(question("que_cooldown"))
  expect(fake.state.phones).toEqual([sessionID])
  expect(fake.state.notifications).toEqual([])
  fake.state.now += 5000
  await fake.controller.observe(question("que_phone"))
  expect(fake.state.phones).toEqual([sessionID, sessionID])
  fake.controller.close()
  await fake.controller.observe(question("que_closed"))
  expect(fake.state.phones).toHaveLength(2)
})

test("the asynchronous phone-turn decision can retain an auto-accept request for a person", async () => {
  const fake = fixture()
  fake.state.auto = Promise.resolve(false)
  await fake.controller.observe(permission("per_phone_turn", "bash"))
  expect(fake.state.phones).toEqual([sessionID])
  fake.state.now += 5000
  fake.state.auto = Promise.resolve(true)
  await fake.controller.observe(permission("per_auto_turn", "bash"))
  expect(fake.state.phones).toHaveLength(1)
  fake.controller.close()
})

test("closing a server while the phone-turn check waits fences every later alert", async () => {
  const fake = fixture()
  const decision = Promise.withResolvers<boolean>()
  fake.state.auto = decision.promise
  const pending = fake.controller.observe(permission("per_waiting", "bash"))
  fake.controller.close()
  decision.resolve(false)
  await pending
  expect(fake.state.phones).toEqual([])
  expect(fake.state.notifications).toEqual([])
  expect(fake.state.toasts).toEqual([])
})
