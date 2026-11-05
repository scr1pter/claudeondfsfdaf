import { describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { Schema } from "effect"
import { ComputerSensitive } from "@vectordevai/core/computer/sensitive"
import { ComputerProgram } from "@vectordevai/core/computer/program"
import { Computer } from "@vectordevai/schema/computer"
import { ComputerApps } from "@vectordevai/schema/computer-apps"
import { createComputerGrants, type GrantScope } from "./computer-grants"
import { access, defaultPrefs, resolve, type AppGrants } from "./computer-settings"
import { defaultPolicy } from "./computer-policy"
import type { KeepAwakeEvent } from "./keep-awake"
import { manualClock } from "../../test/computer/fake-helper"

const APP: Computer.AppIdentity = {
  platform: "macos",
  bundleId: "com.example.Writer",
  teamId: "TEAM123456",
  apple: false,
  system: false,
  verified: true,
  name: "Writer",
  pid: 10,
  path: "/Applications/Writer.app",
}
const SCOPE: GrantScope = { rootSessionID: "ses_root", sessionID: "ses_root", directory: "/repo", lease: 1 }
const STEP: Computer.Step = { kind: "click", button: "left", count: 1, at: { x: 20, y: 30 }, modifiers: [] }
type WindowInspect = Exclude<Computer.InspectResult, { readonly scope: "app-menu" }>
type MenuInspect = Extract<Computer.InspectResult, { readonly scope: "app-menu" }>
const INSPECT: WindowInspect = {
  app: APP,
  category: "general",
  pid: 10,
  window: { id: "window-1" },
  element: { ref: "ui_1", role: "AXButton", label: "Send", secure: false, enabled: true, editable: false },
  clipboard: { agentOwned: true },
}
const MENU_STEP: Computer.Step = { ...STEP, at: { ref: "ui_1" } }
function menuInspect(menuPath: readonly string[] = ["File", "Send"]): MenuInspect {
  const value = Schema.decodeUnknownSync(Computer.InspectResult, { onExcessProperty: "error" })({
    scope: "app-menu",
    app: APP,
    category: "general",
    pid: 10,
    menuPath,
    element: {
      ref: "ui_1",
      elementId: "native-menu-1",
      role: "AXMenuItem",
      label: "Send",
      secure: false,
      enabled: true,
      editable: false,
    },
    clipboard: { agentOwned: true },
  })
  if (value.scope !== "app-menu") throw new Error("Expected a native menu observation")
  return value
}
const MENU_INSPECT = menuInspect()

function appMetadata(identity = APP, extra: Partial<Computer.AppAskMetadata> = {}): Computer.AppAskMetadata {
  if (identity.platform === "remote") throw new Error("No remote app fixture")
  return {
    action: "use_app",
    level: "interact",
    canAlways: true,
    target: {
      appName: identity.name,
      appKey: Computer.appKey(identity),
      platform: identity.platform,
      verified: identity.verified,
      category: ComputerApps.category(identity),
      ...(identity.pid ? { pid: identity.pid } : {}),
      ...(identity.platform === "macos" && identity.path ? { path: identity.path } : {}),
      ...(identity.platform === "windows" && identity.exe ? { path: identity.exe } : {}),
      ...(identity.platform === "macos" && identity.teamId ? { teamId: identity.teamId } : {}),
      ...(identity.platform === "macos" && identity.apple && identity.verified ? { publisher: "Apple Inc." } : {}),
      ...(identity.platform === "windows" && identity.publisher ? { publisher: identity.publisher } : {}),
    },
    ...extra,
  }
}

function sensitiveMetadata(extra: Partial<Computer.SensitiveAskMetadata> = {}): Computer.SensitiveAskMetadata {
  return {
    action: "click",
    why: "send",
    target: { appKey: Computer.appKey(APP), appName: APP.name, windowId: "window-1", pid: 10, ref: "ui_1" },
    targetName: "Send",
    frame: "frame-1",
    stepIndex: 0,
    stepDigest: ComputerSensitive.digest(STEP),
    ...extra,
  }
}

function menuMetadata(extra: Partial<Computer.SensitiveAskMetadata> = {}): Computer.SensitiveAskMetadata {
  return sensitiveMetadata({
    target: {
      scope: "app-menu",
      appKey: Computer.appKey(APP),
      appName: APP.name,
      pid: 10,
      ref: "ui_1",
      elementId: "native-menu-1",
      menuPath: ["File", "Send"],
    },
    frame: undefined,
    stepDigest: ComputerSensitive.digest(MENU_STEP),
    ...extra,
  })
}

function asked(
  id: string,
  metadata: Computer.AppAskMetadata | Computer.SensitiveAskMetadata,
  scope = SCOPE,
): KeepAwakeEvent {
  const app = metadata.action === "use_app"
  return {
    directory: scope.directory,
    payload: {
      type: "permission.asked",
      properties: {
        id,
        sessionID: scope.sessionID,
        permission: app ? "computer_app" : "computer_sensitive",
        patterns: [app ? metadata.target.appKey : `${metadata.target.appKey}:${metadata.why}`],
        always: app && metadata.canAlways ? [metadata.target.appKey] : [],
        metadata: JSON.parse(JSON.stringify(metadata)),
      },
    },
  }
}

function replied(id: string, reply: "once" | "always" | "reject", scope = SCOPE): KeepAwakeEvent {
  return {
    directory: scope.directory,
    payload: { type: "permission.replied", properties: { sessionID: scope.sessionID, requestID: id, reply } },
  }
}

function fixture(
  rootOf: (sessionID: string, directory: string) => Promise<string | undefined> = async (sessionID) =>
    sessionID === SCOPE.sessionID ? SCOPE.rootSessionID : undefined,
  options: Pick<Parameters<typeof createComputerGrants>[0], "replyTimeoutMs" | "timers"> = { replyTimeoutMs: 1 },
) {
  const state = {
    prefs: { ...defaultPrefs("darwin"), enabled: true, consentedAt: 1 },
    policy: defaultPolicy(),
    always: [] as Computer.AlwaysAllowed[],
    saves: [] as Computer.AppIdentity[],
    saveWait: undefined as Promise<void> | undefined,
    onSave: undefined as (() => void) | undefined,
  }
  const settings = {
    get: () => resolve(state.prefs, state.policy, state.always),
    access: (identity: Computer.AppIdentity, grants?: AppGrants) => access(identity, settings.get(), grants),
    async acceptAlways(identity: Computer.AppIdentity) {
      const verdict = settings.access(identity)
      if (verdict.verdict !== "ask" || !verdict.canAlways) return false
      state.saves.push(structuredClone(identity))
      state.onSave?.()
      if (state.saveWait) await state.saveWait
      state.always.push({
        key: Computer.appKey(identity),
        name: identity.name,
        addedAt: 1,
        ...(identity.platform === "macos" && identity.teamId ? { teamId: identity.teamId } : {}),
        ...(identity.platform === "windows" && identity.publisher ? { publisher: identity.publisher } : {}),
      })
      return true
    },
  }
  const manager = createComputerGrants({ settings, rootOf, ...options })
  manager.beginTask(SCOPE)
  const answerApp = async (
    id: string,
    reply: "once" | "always" | "reject" = "once",
    metadata = appMetadata(),
    scope = SCOPE,
  ) => {
    await manager.observe(asked(id, metadata, scope))
    await manager.observe(replied(id, reply, scope))
  }
  const answerSensitive = async (
    id: string,
    metadata = sensitiveMetadata(),
    reply: "once" | "always" | "reject" = "once",
    scope = SCOPE,
  ) => {
    await manager.observe(asked(id, metadata, scope))
    await manager.observe(replied(id, reply, scope))
  }
  return { manager, state, settings, answerApp, answerSensitive }
}

test("program launch consent is bound to a canonical artifact and handler, consumed once, and grants no app access", async () => {
  const fake = fixture()
  const descriptor = {
    platform: "macos" as const,
    path: "/virtual/run.script",
    name: "Run script",
    binding: "a".repeat(64),
  }
  const program = { ...descriptor, key: ComputerProgram.key(descriptor) }
  const metadata: Computer.SensitiveAskMetadata = {
    action: "open",
    why: "run_program",
    path: program.path,
    program,
    target: { appKey: program.key, appName: program.name },
    stepDigest: ComputerProgram.digest(program),
    stepIndex: 0,
  }
  await fake.answerSensitive("per_program", metadata)
  expect(fake.manager.consumeProgram("per_program", SCOPE, program, false)).toBe(true)
  expect(fake.manager.consumeProgram("per_program", { ...SCOPE, lease: 2 }, program)).toBe(false)
  for (const changed of [
    { ...program, name: "Different" },
    { ...program, path: "/virtual/other.script" },
    { ...program, binding: "b".repeat(64) },
  ])
    expect(fake.manager.consumeProgram("per_program", SCOPE, changed)).toBe(false)
  expect(fake.manager.grants(SCOPE).task.size).toBe(0)
  expect(fake.state.always).toEqual([])
  expect(fake.manager.consumeProgram("per_program", SCOPE, program)).toBe(true)
  expect(fake.manager.consumeProgram("per_program", SCOPE, program)).toBe(false)
  expect(fake.manager.grants(SCOPE).task.size).toBe(0)
  await fake.answerSensitive("always_program", metadata, "always")
  expect(fake.manager.consumeProgram("always_program", SCOPE, program)).toBe(false)
  await fake.answerSensitive("wrong_digest_program", { ...metadata, stepDigest: "0".repeat(64) })
  expect(fake.manager.consumeProgram("wrong_digest_program", SCOPE, program)).toBe(false)
  await fake.answerSensitive("previous_lease_program", metadata)
  fake.manager.beginTask({ ...SCOPE, lease: 2 })
  expect(fake.manager.consumeProgram("previous_lease_program", { ...SCOPE, lease: 2 }, program)).toBe(false)
})

describe("desktop-observed app consent", () => {
  test("a grant arriving on the bridge before its observed SSE Allow waits for that exact reply", async () => {
    const clock = manualClock()
    let waiting = false
    const fake = fixture(undefined, {
      timers: {
        setTimeout(callback, ms) {
          waiting = true
          return clock.setTimeout(callback, ms)
        },
        clearTimeout: clock.clearTimeout,
      },
    })
    await fake.manager.observe(asked("per_racing_reply", appMetadata()))
    let settled = false
    const pending = fake.manager.grant(SCOPE, APP, "interact", "per_racing_reply").then((result) => {
      settled = true
      return result
    })
    for (let count = 0; count < 100 && !waiting; count++) await Promise.resolve()
    expect(waiting).toBe(true)
    expect(settled).toBe(false)
    clock.advance(1999)
    expect(settled).toBe(false)
    await fake.manager.observe(replied("per_racing_reply", "once"))
    expect(await pending).toBe(true)
    expect(fake.manager.consumeApp("per_racing_reply", SCOPE, APP)).toBe(true)
  })

  test("waiting for a live ask's reply times out after two seconds and never invents Allow", async () => {
    const clock = manualClock()
    let waiting = false
    const fake = fixture(undefined, {
      timers: {
        setTimeout(callback, ms) {
          waiting = true
          return clock.setTimeout(callback, ms)
        },
        clearTimeout: clock.clearTimeout,
      },
    })
    await fake.manager.observe(asked("per_no_reply", appMetadata()))
    const pending = fake.manager.grant(SCOPE, APP, "interact", "per_no_reply")
    for (let count = 0; count < 100 && !waiting; count++) await Promise.resolve()
    expect(waiting).toBe(true)
    clock.advance(2000)
    expect(await pending).toBe(false)
    expect(fake.manager.grants(SCOPE).task.size).toBe(0)
  })

  test("task end and disconnect cancel reply waits before their timeout and cannot grant a successor", async () => {
    for (const close of ["task", "connection"]) {
      const clock = manualClock()
      let waiting = false
      const fake = fixture(undefined, {
        timers: {
          setTimeout(callback, ms) {
            waiting = true
            return clock.setTimeout(callback, ms)
          },
          clearTimeout: clock.clearTimeout,
        },
      })
      await fake.manager.observe(asked("per_cancel_wait", appMetadata()))
      const pending = fake.manager.grant(SCOPE, APP, "interact", "per_cancel_wait")
      for (let count = 0; count < 100 && !waiting; count++) await Promise.resolve()
      expect(waiting).toBe(true)
      if (close === "task") fake.manager.endTask(SCOPE.rootSessionID, SCOPE.directory)
      else fake.manager.disconnect()
      const successor = { ...SCOPE, lease: 2 }
      fake.manager.beginTask(successor)
      await fake.manager.observe(replied("per_cancel_wait", "once", successor))
      expect(await pending).toBe(false)
      expect(fake.manager.grants(successor).task.size).toBe(0)
      expect(clock.now()).toBe(0)
    }
  })

  test("crossing the seen-ID cap admits fresh ascending asks while old asks cannot be replayed", async () => {
    const fake = fixture()
    const id = (index: number) => `per_${index.toString(16).padStart(12, "0")}${"0".repeat(14)}`
    await fake.answerApp(id(0))
    expect(await fake.manager.grant(SCOPE, APP, "interact", id(0))).toBe(true)
    expect(fake.manager.consumeApp(id(0), SCOPE, APP)).toBe(true)
    // Malformed metadata is still remembered against replay but creates no proof. Fill the actual production
    // cap through that cheaper path; grants and one-use consumption need testing only at the two boundaries.
    for (let index = 1; index < 10002; index++)
      await fake.manager.observe({
        directory: SCOPE.directory,
        payload: {
          type: "permission.asked",
          properties: {
            id: id(index),
            sessionID: SCOPE.sessionID,
            permission: "computer_app",
            patterns: [Computer.appKey(APP)],
            always: [],
            metadata: {},
          },
        },
      })
    expect(fake.manager.isActive(SCOPE)).toBe(true)
    const successor = { ...SCOPE, lease: 2 }
    fake.manager.beginTask(successor)
    await fake.answerApp(id(0), "once", appMetadata(), successor)
    expect(await fake.manager.grant(successor, APP, "interact", id(0))).toBe(false)
    await fake.answerApp(id(10003), "once", appMetadata(), successor)
    expect(await fake.manager.grant(successor, APP, "interact", id(10003))).toBe(true)
  })

  test("deny-only root eviction admits new tasks without resurrecting existing or later saved Always", async () => {
    const fake = fixture(async (sessionID) => sessionID)
    fake.manager.endTask(SCOPE.rootSessionID, SCOPE.directory)
    fake.state.always.push({ key: Computer.appKey(APP), name: APP.name, teamId: "TEAM123456", addedAt: 1 })
    for (let index = 0; index < 1001; index++) {
      const scope = { ...SCOPE, rootSessionID: `ses_root_${index}`, sessionID: `ses_root_${index}`, lease: index + 1 }
      fake.manager.beginTask(scope)
      await fake.answerApp(`per_deny_${index}`, "reject", appMetadata(), scope)
      fake.manager.endTask(scope.rootSessionID, scope.directory)
    }
    const forgotten = { ...SCOPE, rootSessionID: "ses_root_0", sessionID: "ses_root_0", lease: 1002 }
    fake.manager.beginTask(forgotten)
    expect(fake.settings.access(APP, fake.manager.grants(forgotten)).verdict).toBe("denied")
    const later = { ...APP, bundleId: "com.example.Later", name: "Later", pid: 11 }
    fake.state.always.push({ key: Computer.appKey(later), name: later.name, teamId: "TEAM123456", addedAt: 2 })
    expect(fake.settings.access(later, fake.manager.grants(forgotten)).verdict).toBe("denied")
    await fake.answerApp("per_mention_after_eviction", "once", appMetadata(APP, { mentioned: true }), forgotten)
    expect(await fake.manager.grant(forgotten, APP, "interact", "per_mention_after_eviction")).toBe(true)
    expect(fake.settings.access(APP, fake.manager.grants(forgotten)).verdict).toBe("granted")
  })

  test("an authenticated root deletion forgets its Deny only in the matching directory", async () => {
    const fake = fixture()
    await fake.answerApp("per_deleted_root", "reject")
    fake.manager.endTask(SCOPE.rootSessionID, SCOPE.directory)
    await fake.manager.observe({
      directory: "/another",
      payload: {
        type: "session.deleted",
        properties: { info: { id: SCOPE.rootSessionID, directory: SCOPE.directory } },
      },
    })
    fake.manager.beginTask({ ...SCOPE, lease: 2 })
    expect(fake.settings.access(APP, fake.manager.grants({ ...SCOPE, lease: 2 })).verdict).toBe("denied")
    await fake.manager.observe({
      directory: SCOPE.directory,
      payload: {
        type: "session.deleted",
        properties: { info: { id: "ses_deleted_child", parentID: SCOPE.rootSessionID, directory: SCOPE.directory } },
      },
    })
    expect(fake.settings.access(APP, fake.manager.grants({ ...SCOPE, lease: 2 })).verdict).toBe("denied")
    await fake.manager.observe({
      directory: SCOPE.directory,
      payload: {
        type: "session.deleted",
        properties: { sessionID: "different", info: { id: SCOPE.rootSessionID, directory: SCOPE.directory } },
      },
    })
    expect(fake.settings.access(APP, fake.manager.grants({ ...SCOPE, lease: 2 })).verdict).toBe("denied")
    await fake.manager.observe({
      directory: SCOPE.directory,
      payload: {
        type: "session.deleted",
        properties: { info: { id: SCOPE.rootSessionID, directory: SCOPE.directory } },
      },
    })
    fake.manager.beginTask({ ...SCOPE, lease: 3 })
    expect(fake.settings.access(APP, fake.manager.grants({ ...SCOPE, lease: 3 })).verdict).toBe("ask")
  })

  test("an asserted request ID or an ask alone never grants an app", async () => {
    const fake = fixture()
    expect(await fake.manager.grant(SCOPE, APP, "interact", "per_missing")).toBe(false)
    await fake.manager.observe(asked("per_ask", appMetadata()))
    expect(await fake.manager.grant(SCOPE, APP, "interact", "per_ask")).toBe(false)
    await fake.manager.observe(replied("per_other", "once"))
    expect(await fake.manager.grant(SCOPE, APP, "interact", "per_ask")).toBe(false)
  })

  test("a reply received before its ask is not retained as consent", async () => {
    const fake = fixture()
    await fake.manager.observe(replied("per_order", "once"))
    await fake.manager.observe(asked("per_order", appMetadata()))
    expect(await fake.manager.grant(SCOPE, APP, "interact", "per_order")).toBe(false)
  })

  test("a matching observed reply grants once, then its act proof is consumed once", async () => {
    const fake = fixture()
    await fake.answerApp("per_once")
    expect(fake.manager.verify("per_once", "computer_app", Computer.appKey(APP), SCOPE)).toBe("once")
    expect(await fake.manager.grant(SCOPE, APP, "interact", "per_once")).toBe(true)
    expect(await fake.manager.grant(SCOPE, APP, "interact", "per_once")).toBe(false)
    expect(fake.settings.access(APP, fake.manager.grants(SCOPE))).toMatchObject({ verdict: "granted", via: "task" })
    expect(fake.manager.consumeApp("per_once", SCOPE, APP, false)).toBe(true)
    expect(fake.manager.consumeApp("per_once", SCOPE, APP, false)).toBe(true)
    expect(fake.manager.consumeApp("per_once", SCOPE, APP)).toBe(true)
    expect(fake.manager.consumeApp("per_once", SCOPE, APP)).toBe(false)
    expect(fake.state.saves).toEqual([])
  })

  test("a proof binds its permission, pattern, session, directory and active lease", async () => {
    const fake = fixture()
    await fake.answerApp("per_scope")
    expect(fake.manager.verify("per_scope", "computer_sensitive", Computer.appKey(APP), SCOPE)).toBeUndefined()
    expect(fake.manager.verify("per_scope", "computer_app", "app:macos:other", SCOPE)).toBeUndefined()
    for (const scope of [
      { ...SCOPE, lease: 2 },
      { ...SCOPE, directory: "/elsewhere" },
      { ...SCOPE, sessionID: "ses_other" },
      { ...SCOPE, rootSessionID: "ses_other" },
    ])
      expect(await fake.manager.grant(scope, APP, "interact", "per_scope")).toBe(false)
    expect(await fake.manager.grant(SCOPE, APP, "interact", "per_scope")).toBe(true)
  })

  test("wrong-session and wrong-directory replies do not answer the observed ask", async () => {
    const fake = fixture()
    await fake.manager.observe(asked("per_mismatch", appMetadata()))
    await fake.manager.observe(replied("per_mismatch", "once", { ...SCOPE, sessionID: "ses_other" }))
    await fake.manager.observe(replied("per_mismatch", "once", { ...SCOPE, directory: "/other" }))
    expect(await fake.manager.grant(SCOPE, APP, "interact", "per_mismatch")).toBe(false)
  })

  test("duplicate asks and replies cannot replace the original identity or escalate once to Always", async () => {
    const fake = fixture()
    const other = { ...APP, bundleId: "com.example.Other" }
    await fake.manager.observe(asked("per_duplicate", appMetadata()))
    await fake.manager.observe(asked("per_duplicate", appMetadata(other)))
    await fake.manager.observe(replied("per_duplicate", "once"))
    await fake.manager.observe(replied("per_duplicate", "always"))
    expect(await fake.manager.grant(SCOPE, other, "interact", "per_duplicate")).toBe(false)
    expect(await fake.manager.grant(SCOPE, APP, "interact", "per_duplicate")).toBe(true)
    expect(await fake.manager.remember(SCOPE, APP, "per_duplicate")).toBe(false)
    expect(fake.state.saves).toEqual([])
  })

  test("MCP-prefix lookalikes and V2 permission events cannot become Hands consent", async () => {
    const fake = fixture()
    for (const permission of [
      "computer_observe",
      "computer_use_click",
      "computer_app_extra",
      "computer_sensitive_extra",
    ]) {
      const event = asked(`per_${permission}`, appMetadata())
      ;(event.payload.properties as { permission: string }).permission = permission
      await fake.manager.observe(event)
      await fake.manager.observe(replied(`per_${permission}`, "once"))
      expect(await fake.manager.grant(SCOPE, APP, "interact", `per_${permission}`)).toBe(false)
    }
    const event = asked("per_v2", appMetadata())
    await fake.manager.observe({ ...event, payload: { ...event.payload, type: "permission.v2.asked" } })
    await fake.manager.observe(replied("per_v2", "once"))
    expect(await fake.manager.grant(SCOPE, APP, "interact", "per_v2")).toBe(false)
  })

  test("observe approval cannot become interaction, and signing changes cannot reuse app consent", async () => {
    const fake = fixture()
    await fake.answerApp("per_observe", "once", appMetadata(APP, { level: "observe" }))
    expect(await fake.manager.grant(SCOPE, APP, "interact", "per_observe")).toBe(false)
    expect(await fake.manager.grant(SCOPE, { ...APP, teamId: "OTHER12345" }, "observe", "per_observe")).toBe(false)
    expect(await fake.manager.grant(SCOPE, APP, "observe", "per_observe")).toBe(true)
    expect(fake.settings.access(APP, fake.manager.grants(SCOPE))).toMatchObject({
      verdict: "granted",
      level: "observe",
    })
  })

  test("unsigned task consent requires the observed positive PID and canonical path", async () => {
    const { teamId, ...withoutTeam } = APP
    const unsigned = { ...withoutTeam, verified: false }
    const fake = fixture()
    await fake.answerApp("per_unsigned", "once", appMetadata(unsigned, { canAlways: false }))
    expect(await fake.manager.grant(SCOPE, { ...unsigned, pid: 11 }, "interact", "per_unsigned")).toBe(false)
    expect(await fake.manager.grant(SCOPE, { ...unsigned, path: "/Other.app" }, "interact", "per_unsigned")).toBe(false)
    expect(await fake.manager.grant(SCOPE, unsigned, "interact", "per_unsigned")).toBe(true)
    const { pid, path, ...missing } = unsigned
    await fake.answerApp("per_missing_identity", "once", appMetadata(missing, { canAlways: false }))
    expect(await fake.manager.grant(SCOPE, missing, "interact", "per_missing_identity")).toBe(false)
  })

  test("current company or user restrictions win even after an observed allow", async () => {
    const fake = fixture()
    await fake.answerApp("per_policy")
    fake.state.policy.enabled = false
    expect(await fake.manager.grant(SCOPE, APP, "interact", "per_policy")).toBe(false)
    fake.state.policy.enabled = true
    fake.state.prefs.blocked.push({ key: Computer.appKey(APP), name: APP.name, addedAt: 1 })
    expect(await fake.manager.grant(SCOPE, APP, "interact", "per_policy")).toBe(false)
  })

  test("Always is persisted only through D15 after grant, using a separate one-use claim", async () => {
    const fake = fixture()
    await fake.answerApp("per_always", "always")
    expect(await fake.manager.remember(SCOPE, APP, "per_always")).toBe(false)
    expect(await fake.manager.grant(SCOPE, APP, "interact", "per_always")).toBe(true)
    expect(await fake.manager.remember(SCOPE, APP, "per_always")).toBe(true)
    expect(await fake.manager.remember(SCOPE, APP, "per_always")).toBe(false)
    expect(fake.state.saves).toEqual([APP])
    expect(fake.manager.consumeApp("per_always", SCOPE, APP)).toBe(true)
  })

  test("a forged Always reply or a newly disallowed Always save cannot persist", async () => {
    const fake = fixture()
    await fake.answerApp("per_not_offered", "always", appMetadata(APP, { canAlways: false }))
    expect(await fake.manager.grant(SCOPE, APP, "interact", "per_not_offered")).toBe(false)
    await fake.answerApp("per_changed_policy", "always")
    expect(await fake.manager.grant(SCOPE, APP, "interact", "per_changed_policy")).toBe(true)
    fake.state.policy.allowAlways = false
    expect(await fake.manager.remember(SCOPE, APP, "per_changed_policy")).toBe(false)
    expect(fake.state.saves).toEqual([])
  })

  test("the Always pattern must agree with the observed metadata", async () => {
    const fake = fixture()
    const event = asked("per_missing_always", appMetadata())
    ;(event.payload.properties as { always: string[] }).always = []
    await fake.manager.observe(event)
    await fake.manager.observe(replied("per_missing_always", "always"))
    expect(await fake.manager.grant(SCOPE, APP, "interact", "per_missing_always")).toBe(false)
  })

  test("an already claimed Always write may finish after task end without creating a new task grant", async () => {
    const fake = fixture()
    const wait = Promise.withResolvers<void>()
    const started = Promise.withResolvers<void>()
    fake.state.saveWait = wait.promise
    fake.state.onSave = () => started.resolve()
    await fake.answerApp("per_delayed_save", "always")
    await fake.manager.grant(SCOPE, APP, "interact", "per_delayed_save")
    const saved = fake.manager.remember(SCOPE, APP, "per_delayed_save")
    await started.promise
    expect(fake.state.saves).toHaveLength(1)
    fake.manager.endTask(SCOPE.rootSessionID, SCOPE.directory)
    wait.resolve()
    expect(await saved).toBe(true)
    expect(fake.manager.grants(SCOPE).task?.size).toBe(0)
    expect(fake.manager.consumeApp("per_delayed_save", SCOPE, APP)).toBe(false)
  })

  test("Deny survives task end and disconnect; lifting it only offers a new ask", async () => {
    const fake = fixture()
    await fake.answerApp("per_deny", "reject")
    fake.manager.endTask(SCOPE.rootSessionID, SCOPE.directory)
    fake.manager.disconnect()
    const next = { ...SCOPE, lease: 2 }
    fake.manager.beginTask(next)
    const grants = fake.manager.grants(next)
    expect(fake.settings.access(APP, grants)).toEqual({ verdict: "denied" })
    expect(fake.settings.access(APP, { ...grants, liftDeny: true })).toMatchObject({ verdict: "ask" })
    expect(fake.manager.consumeApp("per_deny", next, APP)).toBe(false)
    await fake.answerApp("per_mention", "once", appMetadata(APP, { mentioned: true }), next)
    expect(await fake.manager.grant(next, APP, "interact", "per_mention")).toBe(true)
  })

  test("a newer Deny invalidates an older mentioned Allow and unclaimed Always authority", async () => {
    const fake = fixture()
    await fake.answerApp("per_old_mentioned", "once", appMetadata(APP, { mentioned: true }))
    await fake.answerApp("per_old_always", "always")
    expect(await fake.manager.grant(SCOPE, APP, "interact", "per_old_always")).toBe(true)
    await fake.answerSensitive("per_old_sensitive")
    await fake.answerApp("per_new_deny", "reject")
    expect(await fake.manager.grant(SCOPE, APP, "interact", "per_old_mentioned")).toBe(false)
    expect(await fake.manager.remember(SCOPE, APP, "per_old_always")).toBe(false)
    expect(fake.manager.consumeSensitive("per_old_sensitive", SCOPE, STEP, INSPECT, "frame-1", "send")).toBe(false)
    expect(fake.settings.access(APP, fake.manager.grants(SCOPE))).toEqual({ verdict: "denied" })
    expect(fake.state.saves).toEqual([])
  })

  test("task end clears grants/proofs, and the same ID cannot bind a new lease", async () => {
    const fake = fixture()
    await fake.answerApp("per_old")
    await fake.manager.grant(SCOPE, APP, "interact", "per_old")
    expect(fake.manager.isActive(SCOPE)).toBe(true)
    fake.manager.endTask(SCOPE.rootSessionID, SCOPE.directory)
    expect(fake.manager.isActive(SCOPE)).toBe(false)
    expect(fake.manager.grants(SCOPE).task?.size).toBe(0)
    const next = { ...SCOPE, lease: 2 }
    fake.manager.beginTask(next)
    await fake.answerApp("per_old", "once", appMetadata(), next)
    expect(await fake.manager.grant(next, APP, "interact", "per_old")).toBe(false)
    expect(fake.manager.consumeApp("per_old", next, APP)).toBe(false)
  })

  test("a caller cannot mutate registered scope, observed metadata or returned task maps", async () => {
    const fake = fixture()
    const event = asked("per_snapshot", appMetadata())
    const observing = fake.manager.observe(event)
    ;(event.payload.properties as { metadata: Computer.AppAskMetadata }).metadata.target.appKey = "app:macos:other"
    await observing
    await fake.manager.observe(replied("per_snapshot", "once"))
    expect(await fake.manager.grant(SCOPE, APP, "interact", "per_snapshot")).toBe(true)
    const returned = fake.manager.grants(SCOPE)
    ;(returned.task as Map<string, unknown>).clear()
    expect(fake.manager.grants(SCOPE).task?.size).toBe(1)
  })

  test("a bound Deny survives an unavailable ancestry resolver without retaining older grants", async () => {
    const lookup = { unavailable: false, calls: 0 }
    const fake = fixture(async () => {
      lookup.calls++
      if (lookup.unavailable) throw new Error("The session read is unavailable")
      return SCOPE.rootSessionID
    })
    await fake.answerApp("per_before_lookup_failure")
    expect(await fake.manager.grant(SCOPE, APP, "interact", "per_before_lookup_failure")).toBe(true)
    await fake.manager.observe(asked("per_bound_deny", appMetadata()))
    const calls = lookup.calls
    lookup.unavailable = true
    await fake.manager.observe(replied("per_bound_deny", "reject"))
    expect(lookup.calls).toBe(calls)
    expect(fake.settings.access(APP, fake.manager.grants(SCOPE))).toEqual({ verdict: "denied" })
    expect(fake.manager.consumeApp("per_before_lookup_failure", SCOPE, APP)).toBe(false)
  })

  test("synchronize drains observations enqueued while the earlier ancestry read is pending", async () => {
    const first = Promise.withResolvers<string | undefined>()
    const second = Promise.withResolvers<string | undefined>()
    const secondStarted = Promise.withResolvers<void>()
    const lookup = { count: 0 }
    const fake = fixture(async () => {
      if (lookup.count++ === 0) return first.promise
      secondStarted.resolve()
      return second.promise
    })
    const askingFirst = fake.manager.observe(asked("per_first_pending", appMetadata()))
    const state = { synchronized: false }
    const synchronized = fake.manager.synchronize().then(() => {
      state.synchronized = true
    })
    const askingSecond = fake.manager.observe(asked("per_second_pending", appMetadata()))
    first.resolve(SCOPE.rootSessionID)
    await askingFirst
    await secondStarted.promise
    expect(state.synchronized).toBe(false)
    second.resolve(SCOPE.rootSessionID)
    await askingSecond
    await synchronized
    expect(state.synchronized).toBe(true)
  })

  test("an unresolved root is dropped, and ancestry work cannot bind a later task", async () => {
    const missing = fixture(async () => undefined)
    await missing.answerApp("per_unknown_root")
    expect(await missing.manager.grant(SCOPE, APP, "interact", "per_unknown_root")).toBe(false)
    const lookup = Promise.withResolvers<string | undefined>()
    const fake = fixture(() => lookup.promise)
    const observing = fake.manager.observe(asked("per_late", appMetadata()))
    await Promise.resolve()
    fake.manager.endTask(SCOPE.rootSessionID, SCOPE.directory)
    const next = { ...SCOPE, lease: 2 }
    fake.manager.beginTask(next)
    lookup.resolve(SCOPE.rootSessionID)
    await observing
    await fake.manager.observe(replied("per_late", "once", next))
    expect(await fake.manager.grant(next, APP, "interact", "per_late")).toBe(false)
  })

  test("no active task and disconnected evidence cannot grant", async () => {
    const fake = fixture()
    fake.manager.endTask(SCOPE.rootSessionID, SCOPE.directory)
    await fake.answerApp("per_idle")
    fake.manager.beginTask(SCOPE)
    expect(await fake.manager.grant(SCOPE, APP, "interact", "per_idle")).toBe(false)
    await fake.answerApp("per_before_disconnect")
    fake.manager.disconnect()
    expect(await fake.manager.grant(SCOPE, APP, "interact", "per_before_disconnect")).toBe(false)
  })

  test("a full observation queue ends the task rather than dropping a received Deny", async () => {
    const barrier = Promise.withResolvers<string | undefined>()
    const state = { blocked: false }
    const fake = fixture(async () => (state.blocked ? barrier.promise : SCOPE.rootSessionID))
    await fake.answerApp("per_cap_grant")
    await fake.manager.grant(SCOPE, APP, "interact", "per_cap_grant")
    await fake.manager.observe(asked("per_cap_deny", appMetadata()))
    state.blocked = true
    const pending = Array.from({ length: 1000 }, (_, index) =>
      fake.manager.observe(asked(`per_queued_${index}`, appMetadata())),
    )
    await fake.manager.observe({ directory: SCOPE.directory, payload: { type: "message.updated", properties: {} } })
    const unrelated = asked("per_unrelated", appMetadata())
    ;(unrelated.payload.properties as { permission: string }).permission = "bash"
    await fake.manager.observe(unrelated)
    expect(fake.manager.isActive(SCOPE)).toBe(true)
    await fake.manager.observe(replied("per_cap_deny", "reject"))
    expect(fake.manager.isActive(SCOPE)).toBe(false)
    expect(fake.manager.grants(SCOPE).task?.size).toBe(0)
    expect(fake.manager.consumeApp("per_cap_grant", SCOPE, APP)).toBe(false)
    barrier.resolve(SCOPE.rootSessionID)
    await Promise.all(pending)
  })
})

describe("once-only sensitive consent", () => {
  test("an observed menu element spends exact consent once without granting an app or needing a fabricated frame", async () => {
    const fake = fixture()
    await fake.answerSensitive("per_menu_once", menuMetadata())
    expect(
      fake.manager.consumeSensitive("per_menu_once", SCOPE, MENU_STEP, MENU_INSPECT, undefined, "send", false),
    ).toBe(true)
    expect(
      fake.manager.consumeSensitive("per_menu_once", SCOPE, MENU_STEP, MENU_INSPECT, undefined, "send", false),
    ).toBe(true)
    expect(fake.manager.grants(SCOPE).task.size).toBe(0)
    expect(fake.manager.consumeSensitive("per_menu_once", SCOPE, MENU_STEP, MENU_INSPECT, undefined, "send")).toBe(true)
    expect(fake.manager.consumeSensitive("per_menu_once", SCOPE, MENU_STEP, MENU_INSPECT, undefined, "send")).toBe(
      false,
    )
  })

  test("menu consent binds the actual PID reference element and complete parent path", async () => {
    const fake = fixture()
    await fake.answerSensitive("per_menu_identity", menuMetadata())
    for (const inspect of [
      { ...MENU_INSPECT, pid: 11, app: { ...MENU_INSPECT.app, pid: 11 } },
      { ...MENU_INSPECT, app: { ...MENU_INSPECT.app, pid: 11 } },
      { ...MENU_INSPECT, app: { ...MENU_INSPECT.app, bundleId: "com.example.Other" } },
      { ...MENU_INSPECT, element: { ...MENU_INSPECT.element, ref: "ui_2" } },
      { ...MENU_INSPECT, element: { ...MENU_INSPECT.element, elementId: "native-menu-2" } },
      { ...MENU_INSPECT, element: { ...MENU_INSPECT.element, label: "Delete" } },
      menuInspect(["Message", "Send"]),
      menuInspect(["Send"]),
      menuInspect(["File", "Send", "Other"]),
      menuInspect([]),
    ])
      expect(fake.manager.consumeSensitive("per_menu_identity", SCOPE, MENU_STEP, inspect, undefined, "send")).toBe(
        false,
      )
    expect(fake.manager.consumeSensitive("per_menu_identity", SCOPE, MENU_STEP, MENU_INSPECT, undefined, "send")).toBe(
      true,
    )
  })

  test("menu ancestry is byte-exact rather than a Unicode-normalized alias", async () => {
    const fake = fixture()
    const observed = menuInspect(["Café", "Send"])
    const metadata = menuMetadata()
    if (metadata.target.scope !== "app-menu") throw new Error("Expected menu consent")
    metadata.target.menuPath = ["Café", "Send"]
    await fake.answerSensitive("per_menu_unicode", metadata)
    expect(
      fake.manager.consumeSensitive(
        "per_menu_unicode",
        SCOPE,
        MENU_STEP,
        menuInspect(["Cafe\u0301", "Send"]),
        undefined,
        "send",
      ),
    ).toBe(false)
    expect(fake.manager.consumeSensitive("per_menu_unicode", SCOPE, MENU_STEP, observed, undefined, "send")).toBe(true)
  })

  test("menu consent also binds observed shortcut presence aliases order and every key", async () => {
    const fake = fixture(),
      metadata = menuMetadata()
    if (metadata.target.scope !== "app-menu") throw new Error("Expected menu consent")
    metadata.target.menuShortcut = ["Command", "s"]
    await fake.answerSensitive("per_menu_shortcut", metadata)
    for (const menuShortcut of [undefined, ["Meta", "s"], ["s", "Command"], ["Command", "r"]])
      expect(
        fake.manager.consumeSensitive(
          "per_menu_shortcut",
          SCOPE,
          MENU_STEP,
          { ...MENU_INSPECT, menuShortcut },
          undefined,
          "send",
        ),
      ).toBe(false)
    expect(
      fake.manager.consumeSensitive(
        "per_menu_shortcut",
        SCOPE,
        MENU_STEP,
        { ...MENU_INSPECT, menuShortcut: ["Command", "s"] },
        undefined,
        "send",
      ),
    ).toBe(true)
    await fake.answerSensitive("per_menu_no_shortcut", menuMetadata())
    expect(
      fake.manager.consumeSensitive(
        "per_menu_no_shortcut",
        SCOPE,
        MENU_STEP,
        { ...MENU_INSPECT, menuShortcut: ["Command", "s"] },
        undefined,
        "send",
      ),
    ).toBe(false)
    expect(
      fake.manager.consumeSensitive("per_menu_no_shortcut", SCOPE, MENU_STEP, MENU_INSPECT, undefined, "send"),
    ).toBe(true)
  })

  test("a menu proof retains the exact digest action frame reason and scope checks", async () => {
    const fake = fixture()
    await fake.answerSensitive("per_menu_step", menuMetadata({ frame: "observed-frame" }))
    expect(
      fake.manager.consumeSensitive(
        "per_menu_step",
        SCOPE,
        { ...MENU_STEP, count: 2 },
        MENU_INSPECT,
        "observed-frame",
        "send",
      ),
    ).toBe(false)
    expect(fake.manager.consumeSensitive("per_menu_step", SCOPE, MENU_STEP, MENU_INSPECT, undefined, "send")).toBe(
      false,
    )
    expect(
      fake.manager.consumeSensitive("per_menu_step", SCOPE, MENU_STEP, MENU_INSPECT, "observed-frame", "delete"),
    ).toBe(false)
    for (const scope of [
      { ...SCOPE, lease: 2 },
      { ...SCOPE, sessionID: "ses_child" },
      { ...SCOPE, rootSessionID: "ses_other" },
      { ...SCOPE, directory: "/other" },
    ])
      expect(
        fake.manager.consumeSensitive("per_menu_step", scope, MENU_STEP, MENU_INSPECT, "observed-frame", "send"),
      ).toBe(false)
    expect(
      fake.manager.consumeSensitive("per_menu_step", SCOPE, MENU_STEP, MENU_INSPECT, "observed-frame", "send"),
    ).toBe(true)
    await fake.answerSensitive("per_menu_wrong_action", menuMetadata({ action: "type" }))
    expect(
      fake.manager.consumeSensitive("per_menu_wrong_action", SCOPE, MENU_STEP, MENU_INSPECT, undefined, "send"),
    ).toBe(false)
  })

  test("window and menu approvals cannot migrate across scopes even when the native IDs match", async () => {
    const fake = fixture()
    const window = { ...INSPECT, element: { ...INSPECT.element!, elementId: "native-menu-1" } }
    await fake.answerSensitive(
      "per_window_to_menu",
      sensitiveMetadata({
        target: {
          appKey: Computer.appKey(APP),
          appName: APP.name,
          pid: 10,
          windowId: "window-1",
          ref: "ui_1",
          elementId: "native-menu-1",
        },
        frame: undefined,
        stepDigest: ComputerSensitive.digest(MENU_STEP),
      }),
    )
    expect(fake.manager.consumeSensitive("per_window_to_menu", SCOPE, MENU_STEP, MENU_INSPECT, undefined, "send")).toBe(
      false,
    )
    expect(fake.manager.consumeSensitive("per_window_to_menu", SCOPE, MENU_STEP, window, undefined, "send")).toBe(true)
    await fake.answerSensitive("per_menu_to_window", menuMetadata())
    expect(fake.manager.consumeSensitive("per_menu_to_window", SCOPE, MENU_STEP, window, undefined, "send")).toBe(false)
    expect(fake.manager.consumeSensitive("per_menu_to_window", SCOPE, MENU_STEP, MENU_INSPECT, undefined, "send")).toBe(
      true,
    )
  })

  test("menu Paste consent still binds the complete current clipboard", async () => {
    const fake = fixture(),
      original = "Shared prefix ".repeat(8) + "original"
    const metadata = menuMetadata({
      why: "paste",
      targetName: "Paste",
      clipboardHash: createHash("sha256").update(original).digest("hex"),
    })
    if (metadata.target.scope !== "app-menu") throw new Error("Expected menu consent")
    metadata.target.menuPath = ["Edit", "Paste"]
    const observed = { ...menuInspect(["Edit", "Paste"]), element: { ...MENU_INSPECT.element, label: "Paste" } }
    await fake.answerSensitive("per_menu_paste", metadata)
    for (const clipboard of [
      { agentOwned: false },
      { agentOwned: false, text: "Shared prefix ".repeat(8) + "changed" },
    ])
      expect(
        fake.manager.consumeSensitive(
          "per_menu_paste",
          SCOPE,
          MENU_STEP,
          { ...observed, clipboard },
          undefined,
          "paste",
        ),
      ).toBe(false)
    expect(
      fake.manager.consumeSensitive(
        "per_menu_paste",
        SCOPE,
        MENU_STEP,
        { ...observed, clipboard: { agentOwned: false, text: original } },
        undefined,
        "paste",
      ),
    ).toBe(true)
  })

  test("a projected menu path cannot mutate the stored proof and non-once replies never approve menus", async () => {
    const fake = fixture()
    await fake.answerSensitive("per_menu_copy", menuMetadata())
    const snapshot = fake.manager.peekSensitive("per_menu_copy", SCOPE)!
    if (snapshot.target.scope !== "app-menu") throw new Error("Expected menu consent")
    snapshot.target.menuPath = ["Changed", "Send"]
    expect(
      fake.manager.consumeSensitive(
        "per_menu_copy",
        SCOPE,
        MENU_STEP,
        menuInspect(["Changed", "Send"]),
        undefined,
        "send",
      ),
    ).toBe(false)
    expect(fake.manager.consumeSensitive("per_menu_copy", SCOPE, MENU_STEP, MENU_INSPECT, undefined, "send")).toBe(true)
    for (const reply of ["always", "reject"] as const) {
      await fake.answerSensitive(`per_menu_${reply}`, menuMetadata(), reply)
      expect(
        fake.manager.consumeSensitive(`per_menu_${reply}`, SCOPE, MENU_STEP, MENU_INSPECT, undefined, "send"),
      ).toBe(false)
    }
  })

  test("malformed root app-only hybrid and program-key menu asks never become proof records", async () => {
    const fake = fixture(),
      valid = menuMetadata()
    for (const [index, target] of [
      { ...valid.target, menuPath: [] },
      { ...valid.target, menuPath: [""] },
      { ...valid.target, pid: undefined },
      { ...valid.target, ref: undefined },
      { ...valid.target, elementId: undefined },
      { ...valid.target, menuPath: undefined },
      { ...valid.target, windowId: "window-1" },
      { ...valid.target, scope: undefined },
      { ...valid.target, appKey: "program:macos:" + "a".repeat(64) },
      { ...sensitiveMetadata().target, menuPath: ["File", "Send"] },
    ].entries()) {
      const id = `per_menu_malformed_${index}`,
        event = asked(id, valid)
      await fake.manager.observe({
        ...event,
        payload: {
          ...event.payload,
          properties: {
            ...(event.payload.properties as Record<string, unknown>),
            metadata: JSON.parse(JSON.stringify({ ...valid, target })),
          },
        },
      })
      await fake.manager.observe(replied(id, "once"))
      expect(fake.manager.peekSensitive(id, SCOPE)).toBeUndefined()
      expect(fake.manager.consumeSensitive(id, SCOPE, MENU_STEP, MENU_INSPECT, undefined, "send")).toBe(false)
    }
  })

  test("menu proofs cannot become legacy program launches or survive a reused task scope", async () => {
    const fake = fixture()
    await fake.answerSensitive(
      "per_menu_program",
      menuMetadata({ why: "run_program", path: "/Applications/Writer.app" }),
    )
    expect(
      fake.manager.consumeSensitive(
        "per_menu_program",
        SCOPE,
        MENU_STEP,
        { ...MENU_INSPECT, programPath: "/Applications/Writer.app" },
        undefined,
        "run_program",
      ),
    ).toBe(false)
    await fake.answerSensitive("per_menu_reused", menuMetadata())
    fake.manager.endTask(SCOPE.rootSessionID, SCOPE.directory)
    fake.manager.beginTask(SCOPE)
    expect(fake.manager.consumeSensitive("per_menu_reused", SCOPE, MENU_STEP, MENU_INSPECT, undefined, "send")).toBe(
      false,
    )
    await fake.answerSensitive("per_menu_reused", menuMetadata())
    expect(fake.manager.consumeSensitive("per_menu_reused", SCOPE, MENU_STEP, MENU_INSPECT, undefined, "send")).toBe(
      false,
    )
    await fake.answerSensitive("per_menu_fresh", menuMetadata())
    expect(fake.manager.consumeSensitive("per_menu_fresh", SCOPE, MENU_STEP, MENU_INSPECT, undefined, "send")).toBe(
      true,
    )
  })

  test("dry runs do not spend a proof; execution spends it exactly once", async () => {
    const fake = fixture()
    await fake.answerSensitive("per_sensitive")
    expect(fake.manager.consumeSensitive("per_sensitive", SCOPE, STEP, INSPECT, "frame-1", "send", false)).toBe(true)
    expect(fake.manager.consumeSensitive("per_sensitive", SCOPE, STEP, INSPECT, "frame-1", "send", false)).toBe(true)
    expect(fake.manager.consumeSensitive("per_sensitive", SCOPE, STEP, INSPECT, "frame-1", "send")).toBe(true)
    expect(fake.manager.consumeSensitive("per_sensitive", SCOPE, STEP, INSPECT, "frame-1", "send")).toBe(false)
  })

  test("changed digest, reason, frame, window, PID, element or label requires a new ask", async () => {
    const fake = fixture()
    await fake.answerSensitive("per_sensitive_target")
    expect(
      fake.manager.consumeSensitive("per_sensitive_target", SCOPE, { ...STEP, count: 2 }, INSPECT, "frame-1", "send"),
    ).toBe(false)
    expect(fake.manager.consumeSensitive("per_sensitive_target", SCOPE, STEP, INSPECT, "frame-1", "delete")).toBe(false)
    expect(fake.manager.consumeSensitive("per_sensitive_target", SCOPE, STEP, INSPECT, "frame-2", "send")).toBe(false)
    for (const inspect of [
      { ...INSPECT, pid: 11 },
      { ...INSPECT, window: { id: "window-2" } },
      { ...INSPECT, element: { ...INSPECT.element!, ref: "ui_2" } },
      { ...INSPECT, element: { ...INSPECT.element!, label: "Delete" } },
    ])
      expect(fake.manager.consumeSensitive("per_sensitive_target", SCOPE, STEP, inspect, "frame-1", "send")).toBe(false)
    expect(fake.manager.consumeSensitive("per_sensitive_target", SCOPE, STEP, INSPECT, "frame-1", "send")).toBe(true)
  })

  test("a same-label control replacement cannot reuse a stable native element ID", async () => {
    const fake = fixture()
    const metadata = sensitiveMetadata()
    metadata.target.elementId = "native-1"
    await fake.answerSensitive("per_native_element", metadata)
    expect(
      fake.manager.consumeSensitive(
        "per_native_element",
        SCOPE,
        STEP,
        { ...INSPECT, element: { ...INSPECT.element!, elementId: "native-2" } },
        "frame-1",
        "send",
      ),
    ).toBe(false)
    expect(
      fake.manager.consumeSensitive(
        "per_native_element",
        SCOPE,
        STEP,
        { ...INSPECT, element: { ...INSPECT.element!, elementId: "native-1" } },
        "frame-1",
        "send",
      ),
    ).toBe(true)
  })

  test("sensitive Always/reject and unknown app proof IDs never approve an input", async () => {
    const fake = fixture()
    for (const reply of ["always", "reject"] as const) {
      await fake.answerSensitive(`per_${reply}`, sensitiveMetadata(), reply)
      expect(fake.manager.consumeSensitive(`per_${reply}`, SCOPE, STEP, INSPECT, "frame-1", "send")).toBe(false)
    }
    expect(fake.manager.consumeSensitive("per_unknown", SCOPE, STEP, INSPECT, "frame-1", "send")).toBe(false)
    await fake.answerApp("per_wrong_kind")
    expect(fake.manager.consumeSensitive("per_wrong_kind", SCOPE, STEP, INSPECT, "frame-1", "send")).toBe(false)
  })

  test("input proofs without observed window/PID or a digest cannot execute", async () => {
    const fake = fixture()
    await fake.answerSensitive(
      "per_old_shape",
      sensitiveMetadata({ target: { appKey: Computer.appKey(APP), appName: APP.name } }),
    )
    expect(fake.manager.consumeSensitive("per_old_shape", SCOPE, STEP, INSPECT, "frame-1", "send")).toBe(false)
    await fake.answerSensitive("per_no_digest", sensitiveMetadata({ stepDigest: undefined }))
    expect(fake.manager.peekSensitive("per_no_digest", SCOPE)).toBeUndefined()
  })

  test("canonical program paths bind open consent even before a window exists", async () => {
    const fake = fixture()
    const step = { kind: "open", path: "/Applications/Writer.app" } as const
    await fake.answerSensitive(
      "per_open",
      sensitiveMetadata({
        action: "open",
        why: "run_program",
        target: { appKey: Computer.appKey(APP), appName: APP.name },
        path: step.path,
        frame: undefined,
        targetName: undefined,
        stepDigest: ComputerSensitive.digest(step),
      }),
    )
    expect(
      fake.manager.consumeSensitive(
        "per_open",
        SCOPE,
        { ...step, path: "/Other.app" },
        INSPECT,
        undefined,
        "run_program",
      ),
    ).toBe(false)
    expect(
      fake.manager.consumeSensitive(
        "per_open",
        SCOPE,
        step,
        { ...INSPECT, programPath: "/Other.app" },
        undefined,
        "run_program",
      ),
    ).toBe(false)
    expect(fake.manager.consumeSensitive("per_open", SCOPE, step, INSPECT, undefined, "run_program")).toBe(true)
  })

  test("a run-program click cannot reuse consent after the executable at the control changes", async () => {
    const fake = fixture()
    await fake.answerSensitive(
      "per_launch_click",
      sensitiveMetadata({ why: "run_program", path: "/Applications/First.app" }),
    )
    expect(
      fake.manager.consumeSensitive(
        "per_launch_click",
        SCOPE,
        STEP,
        { ...INSPECT, programPath: "/Applications/Other.app" },
        "frame-1",
        "run_program",
      ),
    ).toBe(false)
    expect(
      fake.manager.consumeSensitive(
        "per_launch_click",
        SCOPE,
        STEP,
        { ...INSPECT, programPath: "/Applications/First.app" },
        "frame-1",
        "run_program",
      ),
    ).toBe(true)
  })

  test("typed text is not retained in proof projections and snapshots cannot alter the digest", async () => {
    const fake = fixture()
    const step: Computer.Step = { kind: "type", text: "A private draft" }
    await fake.answerSensitive(
      "per_type",
      sensitiveMetadata({ action: "type", text: step.text, stepDigest: ComputerSensitive.digest(step) }),
    )
    const metadata = fake.manager.peekSensitive("per_type", SCOPE)!
    expect(metadata.text).toBeUndefined()
    metadata.stepDigest = ComputerSensitive.digest({ kind: "type", text: "Different text" })
    expect(
      fake.manager.consumeSensitive(
        "per_type",
        SCOPE,
        { kind: "type", text: "Different text" },
        INSPECT,
        "frame-1",
        "send",
      ),
    ).toBe(false)
    expect(fake.manager.consumeSensitive("per_type", SCOPE, step, INSPECT, "frame-1", "send")).toBe(true)
  })

  test("paste proofs bind all clipboard text, including changes beyond the displayed preview", async () => {
    const fake = fixture()
    const step: Computer.Step = { kind: "key", combo: ["Command", "v"], repeat: 1 }
    const original = "Shared prefix ".repeat(8) + "original"
    const changed = "Shared prefix ".repeat(8) + "changed"
    await fake.answerSensitive(
      "per_clipboard_hash",
      sensitiveMetadata({
        action: "key",
        why: "paste",
        text: original.slice(0, Computer.LIMITS.previewChars),
        clipboardHash: createHash("sha256").update(original).digest("hex"),
        stepDigest: ComputerSensitive.digest(step),
      }),
    )
    expect(fake.manager.peekSensitive("per_clipboard_hash", SCOPE)?.text).toBeUndefined()
    expect(
      fake.manager.consumeSensitive(
        "per_clipboard_hash",
        SCOPE,
        step,
        { ...INSPECT, clipboard: { agentOwned: false, text: changed } },
        "frame-1",
        "paste",
      ),
    ).toBe(false)
    expect(
      fake.manager.consumeSensitive(
        "per_clipboard_hash",
        SCOPE,
        step,
        { ...INSPECT, clipboard: { agentOwned: false, text: original } },
        "frame-1",
        "paste",
      ),
    ).toBe(true)
  })

  test("sensitive proofs expire with the task or connection", async () => {
    const fake = fixture()
    await fake.answerSensitive("per_expire")
    fake.manager.endTask(SCOPE.rootSessionID, SCOPE.directory)
    expect(fake.manager.consumeSensitive("per_expire", SCOPE, STEP, INSPECT, "frame-1", "send")).toBe(false)
    const next = { ...SCOPE, lease: 2 }
    fake.manager.beginTask(next)
    await fake.answerSensitive("per_disconnect", sensitiveMetadata(), "once", next)
    fake.manager.disconnect()
    expect(fake.manager.consumeSensitive("per_disconnect", next, STEP, INSPECT, "frame-1", "send")).toBe(false)
  })
})
