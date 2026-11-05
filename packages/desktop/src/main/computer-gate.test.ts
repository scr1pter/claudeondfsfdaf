import { describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { ComputerSensitive } from "@vectordevai/core/computer/sensitive"
import { Computer } from "@vectordevai/schema/computer"
import { ComputerApps } from "@vectordevai/schema/computer-apps"
import { checkStep, inspectHit, typeChecked, type GateContext } from "./computer-gate"
import { createComputerGrants, type GrantScope } from "./computer-grants"
import { access, defaultPrefs, resolve, type AppGrants } from "./computer-settings"
import { defaultPolicy } from "./computer-policy"

const APP: Computer.MacIdentity = {
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
const CLICK: Computer.Step = { kind: "click", at: { x: 20, y: 30 }, button: "left", count: 1, modifiers: [] }
const FRAME: Computer.Frame = {
  id: "frame-1",
  scope: "window",
  display: "display-1",
  windowId: "window-1",
  bounds: { x: 0, y: 0, w: 100, h: 100 },
  scale: 1,
  image: { w: 100, h: 100 },
  at: 1,
  hash: "0123456789abcdef",
}

async function fixture() {
  const state = {
    hit: {
      owner: APP,
      windowId: "window-1",
      ref: "ui_1",
      elementId: "native-1",
      role: "AXButton",
      name: "Details",
      secure: false,
      enabled: true,
      editable: false,
      layout: { platform: "macos" },
      focusedMenuShortcuts: [],
    } as Computer.HitResult,
    prefs: { ...defaultPrefs("darwin"), enabled: true, consentedAt: 1 },
    policy: defaultPolicy(),
    inputs: [] as Computer.InputOp[],
    calls: [] as { op: string; frame?: string; x?: number; y?: number }[],
    fresh: true,
    title: "Document",
    clipboard: { text: "A harmless sentence", agentOwned: false },
    canonical: (file: string): string | undefined => file,
    beforeHit: undefined as (() => Promise<void>) | undefined,
    beforeApps: undefined as (() => Promise<void>) | undefined,
    rootWait: undefined as Promise<string | undefined> | undefined,
  }
  const settings = {
    get: () => resolve(state.prefs, state.policy),
    access: (identity: Computer.AppIdentity, grants?: AppGrants) => access(identity, settings.get(), grants),
    acceptAlways: async () => false,
  }
  const grants = createComputerGrants({
    settings,
    rootOf: async (sessionID, directory) =>
      state.rootWait ??
      (sessionID === SCOPE.sessionID && directory === SCOPE.directory ? SCOPE.rootSessionID : undefined),
  })
  grants.beginTask(SCOPE)
  const backend: GateContext["backend"] = {
    hitTest: async (frame, x, y) => {
      state.calls.push({ op: "hitTest", frame, x, y })
      await state.beforeHit?.()
      return structuredClone(state.hit)
    },
    focused: async () => {
      state.calls.push({ op: "focused" })
      return structuredClone(state.hit)
    },
    apps: async () => {
      state.calls.push({ op: "apps" })
      await state.beforeApps?.()
      return [
        {
          identity: state.hit.owner,
          active: true,
          windows: [
            {
              windowId: state.hit.windowId,
              title: state.title,
              bounds: FRAME.bounds,
              minimized: false,
              onScreen: true,
            },
          ],
        },
      ]
    },
    input: async (input) => {
      state.inputs.push(structuredClone(input))
    },
  }
  const ctx: GateContext = {
    scope: SCOPE,
    backend,
    settings,
    grants,
    index: 0,
    allowedApps: [Computer.appKey(APP)],
    frame: FRAME,
    frameCurrent: async () => state.fresh,
    resolveRef: async () => structuredClone(state.hit),
    uiRef: (hit) => hit.ref,
    clipboard: async () => ({ ...state.clipboard }),
    canonicalPath: async (file) => state.canonical(file),
    protectedPaths: [],
    protectedDirectories: [],
  }
  const askApp = async (id: string, identity: Computer.AppIdentity = APP) => {
    if (identity.platform === "remote") throw new Error("No remote app fixture")
    const verdict = settings.access(identity)
    const canAlways = verdict.verdict === "ask" && verdict.canAlways
    const metadata: Computer.AppAskMetadata = {
      action: "use_app",
      level: "interact",
      canAlways,
      target: {
        appKey: Computer.appKey(identity),
        appName: identity.name,
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
    }
    await grants.observe({
      directory: SCOPE.directory,
      payload: {
        type: "permission.asked",
        properties: {
          id,
          sessionID: SCOPE.sessionID,
          permission: "computer_app",
          patterns: [metadata.target.appKey],
          always: canAlways ? [metadata.target.appKey] : [],
          metadata,
        },
      },
    })
  }
  const appAsk = async (id: string, identity: Computer.AppIdentity = APP) => {
    await askApp(id, identity)
    await grants.observe({
      directory: SCOPE.directory,
      payload: {
        type: "permission.replied",
        properties: {
          requestID: id,
          sessionID: SCOPE.sessionID,
          reply: "once",
        },
      },
    })
    expect(await grants.grant(SCOPE, identity, "interact", id)).toBe(true)
  }
  const sensitive = async (
    id: string,
    step: Computer.Step,
    why: Computer.SensitiveWhy,
    extra: Partial<Computer.SensitiveAskMetadata> = {},
  ) => {
    const hit = state.hit
    const metadata: Computer.SensitiveAskMetadata = {
      action: step.kind === "type" || step.kind === "key" || step.kind === "drag" ? step.kind : "click",
      why,
      target:
        hit.scope === "app-menu"
          ? {
              scope: "app-menu",
              appName: hit.owner.name,
              appKey: Computer.appKey(hit.owner),
              pid: hit.pid,
              ref: hit.ref,
              elementId: hit.elementId,
              menuPath: hit.menuPath,
              ...(hit.menuShortcut ? { menuShortcut: hit.menuShortcut } : {}),
            }
          : {
              appName: hit.owner.name,
              appKey: Computer.appKey(hit.owner),
              windowId: hit.windowId,
              pid: hit.owner.pid,
              ...(hit.ref ? { ref: hit.ref } : {}),
              ...(hit.elementId ? { elementId: hit.elementId } : {}),
            },
      ...(hit.name ? { targetName: Computer.clean(hit.name, Computer.LIMITS.labelChars) } : {}),
      ...(ctx.frame ? { frame: ctx.frame.id } : {}),
      ...(why === "paste" ? { clipboardHash: createHash("sha256").update(state.clipboard.text).digest("hex") } : {}),
      stepDigest: ComputerSensitive.digest(step),
      stepIndex: ctx.index,
      ...extra,
    }
    await grants.observe({
      directory: SCOPE.directory,
      payload: {
        type: "permission.asked",
        properties: {
          id,
          sessionID: SCOPE.sessionID,
          permission: "computer_sensitive",
          patterns: [`${metadata.target.appKey}:${why}`],
          always: [],
          metadata,
        },
      },
    })
    await grants.observe({
      directory: SCOPE.directory,
      payload: {
        type: "permission.replied",
        properties: {
          requestID: id,
          sessionID: SCOPE.sessionID,
          reply: "once",
        },
      },
    })
  }
  await appAsk("per_gate_app")
  return { state, ctx, grants, backend, askApp, appAsk, sensitive }
}

describe("live desktop step gate", () => {
  test("a wait while a never-listed app has focus uses no helper target or input", async () => {
    const fake = await fixture()
    fake.state.hit.owner = { ...APP, bundleId: "com.apple.Terminal", name: "Terminal", pid: 99 }
    fake.state.calls.length = 0
    fake.ctx.uiRef = () => {
      throw new Error("A wait must not mint a reference")
    }
    expect(await checkStep({ kind: "wait", ms: 500 }, fake.ctx)).toEqual({ verdict: "ok", waiting: true })
    expect(fake.state.calls).toEqual([])
    expect(fake.state.inputs).toEqual([])
    expect(
      await checkStep({ kind: "wait", ms: 500 }, { ...fake.ctx, approvals: [{ index: 0, requestID: "per_gate_app" }] }),
    ).toEqual({ verdict: "refuse", code: "not_granted" })
    expect(fake.grants.consumeApp("per_gate_app", SCOPE, APP, false)).toBe(true)
    fake.grants.endTask(SCOPE.rootSessionID, SCOPE.directory)
    expect(await checkStep({ kind: "wait", ms: 500 }, fake.ctx)).toEqual({ verdict: "refuse", code: "stopped" })
    expect(fake.state.calls).toEqual([])
  })

  test("an ungranted app inspection exposes only identity and structural flags and mints no ref", async () => {
    const fake = await fixture()
    const other = { ...APP, bundleId: "com.example.Other", name: "Other", pid: 11 }
    fake.state.hit = {
      ...fake.state.hit,
      owner: other,
      name: "PRIVATE DOCUMENT CONTENT",
      document: "/private/customer-draft.txt",
      documentStatus: "known",
      programPath: "/private/customer-script",
      focusedMenuShortcuts: [{ combo: ["Command", "k"], label: "PRIVATE MENU ITEM" }],
    }
    fake.ctx.allowedApps = [Computer.appKey(other)]
    fake.ctx.uiRef = () => {
      throw new Error("An ungranted hit must not mint a reference")
    }
    const result = await checkStep(CLICK, fake.ctx)
    expect(result).toEqual({
      verdict: "pending",
      kind: "app",
      inspect: {
        app: other,
        category: "general",
        pid: 11,
        window: { id: "window-1" },
        element: { role: "AXButton", secure: false, enabled: true, editable: false },
        clipboard: { agentOwned: false },
      },
    })
    expect(JSON.stringify(result)).not.toContain("PRIVATE")
    expect(JSON.stringify(result)).not.toContain("/private")
    expect(fake.state.inputs).toEqual([])
  })

  test("a granted app uses the actual hit-test owner, never the requested app's approval", async () => {
    const fake = await fixture()
    expect(await checkStep(CLICK, fake.ctx)).toMatchObject({ verdict: "ok" })
    expect(fake.state.calls[0]).toEqual({ op: "hitTest", frame: FRAME.id, x: 20, y: 30 })
    fake.state.hit = {
      ...fake.state.hit,
      owner: { ...APP, bundleId: "com.apple.Terminal", apple: true, system: true, name: "Terminal" },
    }
    expect(await checkStep(CLICK, fake.ctx)).toEqual({ verdict: "refuse", code: "blocked" })
    expect(fake.state.inputs).toEqual([])
  })

  test("an observed child shell blocks an otherwise granted generic app", async () => {
    const fake = await fixture()
    fake.state.hit = { ...fake.state.hit, signals: { childShell: true } }
    expect(await checkStep(CLICK, fake.ctx)).toEqual({ verdict: "refuse", code: "blocked" })
    expect(fake.state.inputs).toEqual([])
  })

  test("Vector/overlay and security UI are refused, and elevated windows hand off", async () => {
    const fake = await fixture()
    fake.state.hit = { ...fake.state.hit, owner: { ...APP, bundleId: "ai.vector.app", name: "Vector" } }
    expect(await checkStep(CLICK, fake.ctx)).toEqual({ verdict: "refuse", code: "blocked" })
    fake.state.hit = {
      ...fake.state.hit,
      owner: { ...APP, bundleId: "com.apple.systempreferences", apple: true, system: true },
    }
    expect(await checkStep(CLICK, fake.ctx)).toEqual({ verdict: "refuse", code: "protected" })
    fake.state.hit = { ...fake.state.hit, owner: APP, elevated: true }
    expect(await checkStep(CLICK, fake.ctx)).toEqual({ verdict: "refuse", code: "elevated" })
    expect(fake.state.inputs).toEqual([])
  })

  test("missing or empty allowedApps requires an app ask despite an existing task grant", async () => {
    const fake = await fixture()
    for (const allowedApps of [undefined, []]) {
      expect(await checkStep(CLICK, { ...fake.ctx, allowedApps })).toMatchObject({ verdict: "pending", kind: "app" })
      expect(fake.grants.consumeApp("per_gate_app", SCOPE, APP, false)).toBe(true)
    }
  })

  test("a newly hit app needs its own consent even when the engine included its key", async () => {
    const fake = await fixture()
    const other = { ...APP, bundleId: "com.example.Other", pid: 11 }
    fake.state.hit = { ...fake.state.hit, owner: other }
    expect(await checkStep(CLICK, { ...fake.ctx, allowedApps: [Computer.appKey(other)] })).toMatchObject({
      verdict: "pending",
      kind: "app",
    })
    expect(fake.state.inputs).toEqual([])
  })

  test("company and user blocks take effect before the next input", async () => {
    const fake = await fixture()
    fake.state.policy.enabled = false
    expect(await checkStep(CLICK, fake.ctx)).toEqual({ verdict: "refuse", code: "blocked" })
    fake.state.policy.enabled = true
    fake.state.prefs.blocked.push({ key: Computer.appKey(APP), name: APP.name, addedAt: 1 })
    expect(await checkStep(CLICK, fake.ctx)).toEqual({ verdict: "refuse", code: "blocked" })
  })

  test("an already received Deny finishes ancestry verification before the next step releases", async () => {
    const fake = await fixture()
    const ancestry = Promise.withResolvers<string | undefined>()
    fake.state.rootWait = ancestry.promise
    const asking = fake.askApp("per_pending_deny")
    const denying = fake.grants.observe({
      directory: SCOPE.directory,
      payload: {
        type: "permission.replied",
        properties: {
          requestID: "per_pending_deny",
          sessionID: SCOPE.sessionID,
          reply: "reject",
        },
      },
    })
    const state = { settled: false }
    const checking = checkStep(CLICK, fake.ctx).then((result) => {
      state.settled = true
      return result
    })
    await Promise.resolve()
    await Promise.resolve()
    expect(state.settled).toBe(false)
    expect(fake.state.inputs).toEqual([])
    ancestry.resolve(SCOPE.rootSessionID)
    await asking
    await denying
    expect(await checking).toEqual({ verdict: "refuse", code: "not_granted" })
  })

  test("a frame whose geometry is no longer current is refused", async () => {
    const fake = await fixture()
    fake.state.fresh = false
    expect(await checkStep(CLICK, fake.ctx)).toEqual({ verdict: "refuse", code: "stale_frame" })
    expect(await checkStep(CLICK, { ...fake.ctx, frameCurrent: undefined })).toEqual({
      verdict: "refuse",
      code: "stale_frame",
    })
    expect(fake.state.inputs).toEqual([])
  })

  test("batch step two is classified after step one opened a Delete control", async () => {
    const fake = await fixture()
    expect(await checkStep(CLICK, fake.ctx)).toMatchObject({ verdict: "ok" })
    fake.state.hit = { ...fake.state.hit, name: "Delete", ref: "ui_2", elementId: "delete-2" }
    expect(await checkStep(CLICK, { ...fake.ctx, index: 1 })).toMatchObject({
      verdict: "pending",
      kind: "sensitive",
      why: "delete",
    })
  })

  test("a drag gates every intersected owner, allowing approved apps but refusing a protected destination", async () => {
    const fake = await fixture()
    const destination: Computer.MacIdentity = {
      ...APP,
      bundleId: "com.example.Other",
      path: "/Applications/Other.app",
      pid: 11,
    }
    await fake.appAsk("per_drag_destination", destination)
    const sourceHit = structuredClone(fake.state.hit)
    let target: Computer.HitResult = {
      ...sourceHit,
      owner: destination,
      windowId: "window-2",
      ref: "ui_2",
      elementId: "native-2",
      name: "Drop area",
    }
    const { windowId, ...displayFrame } = FRAME
    fake.ctx.frame = { ...displayFrame, scope: "display" }
    fake.ctx.allowedApps = [Computer.appKey(APP), Computer.appKey(destination)]
    fake.backend.hitTest = async (_frame, x) => structuredClone(x < 50 ? sourceHit : target)
    const step: Computer.Step = {
      kind: "drag",
      path: [
        { x: 20, y: 30 },
        { x: 70, y: 30 },
      ],
      modifiers: [],
    }
    expect(await checkStep(step, fake.ctx)).toMatchObject({ verdict: "ok" })
    target = {
      ...target,
      owner: { ...destination, bundleId: "com.apple.Terminal", apple: true, system: true, name: "Terminal" },
    }
    expect(await checkStep(step, fake.ctx)).toEqual({ verdict: "refuse", code: "blocked" })
    expect(fake.state.inputs).toEqual([])
  })

  test("engine-only sensitive proofs are checked and consumed even when the local classifier is quiet", async () => {
    const fake = await fixture()
    expect(await checkStep(CLICK, { ...fake.ctx, approvals: [{ index: 0, requestID: "per_unknown" }] })).toEqual({
      verdict: "refuse",
      code: "not_granted",
    })
    await fake.sensitive("per_engine", CLICK, "new_destination", { destination: "https://example.test/approved" })
    const ctx = { ...fake.ctx, approvals: [{ index: 0, requestID: "per_engine" }] }
    expect(await checkStep(CLICK, ctx)).toMatchObject({ verdict: "ok" })
    expect(fake.grants.peekSensitive("per_engine", SCOPE)).toBeUndefined()
    expect(await checkStep(CLICK, ctx)).toEqual({ verdict: "refuse", code: "not_granted" })
  })

  test("all supplied proofs remain unspent while another local sensitive ask is missing", async () => {
    const fake = await fixture()
    fake.state.hit = { ...fake.state.hit, name: "Delete" }
    await fake.sensitive("per_provider", CLICK, "provider_check", {
      providerCheck: { provider: "OpenAI", code: "review", message: "Review the target" },
    })
    fake.ctx.approvals = [
      { index: 0, requestID: "per_gate_app" },
      { index: 0, requestID: "per_provider" },
    ]
    expect(await checkStep(CLICK, fake.ctx)).toMatchObject({ verdict: "pending", kind: "sensitive", why: "delete" })
    expect(fake.grants.peekSensitive("per_provider", SCOPE)).toBeDefined()
    expect(fake.grants.consumeApp("per_gate_app", SCOPE, APP, false)).toBe(true)
    await fake.sensitive("per_delete", CLICK, "delete")
    fake.ctx.approvals = [...fake.ctx.approvals, { index: 0, requestID: "per_delete" }]
    expect(await checkStep(CLICK, fake.ctx)).toMatchObject({ verdict: "ok" })
    expect(fake.grants.peekSensitive("per_provider", SCOPE)).toBeUndefined()
    expect(fake.grants.peekSensitive("per_delete", SCOPE)).toBeUndefined()
    expect(fake.grants.consumeApp("per_gate_app", SCOPE, APP, false)).toBe(false)
  })

  test("a later unknown proof cannot burn an earlier valid proof", async () => {
    const fake = await fixture()
    await fake.sensitive("per_valid", CLICK, "provider_check")
    expect(
      await checkStep(CLICK, {
        ...fake.ctx,
        approvals: [
          { index: 0, requestID: "per_valid" },
          { index: 0, requestID: "per_missing" },
        ],
      }),
    ).toEqual({ verdict: "refuse", code: "not_granted" })
    expect(fake.grants.peekSensitive("per_valid", SCOPE)).toBeDefined()
  })

  test("a remapped suffix index still accepts its original batch step's exact proof", async () => {
    const fake = await fixture()
    fake.state.hit = { ...fake.state.hit, name: "Delete" }
    await fake.sensitive("per_suffix", CLICK, "delete", { stepIndex: 4 })
    expect(
      await checkStep(CLICK, { ...fake.ctx, index: 0, approvals: [{ index: 0, requestID: "per_suffix" }] }),
    ).toMatchObject({ verdict: "ok" })
  })

  test("same-label native control replacement asks again before reusing consent", async () => {
    const fake = await fixture()
    fake.state.hit = { ...fake.state.hit, name: "Delete" }
    await fake.sensitive("per_old_control", CLICK, "delete")
    fake.state.hit = { ...fake.state.hit, elementId: "replacement" }
    expect(
      await checkStep(CLICK, { ...fake.ctx, approvals: [{ index: 0, requestID: "per_old_control" }] }),
    ).toMatchObject({ verdict: "pending", kind: "sensitive", why: "delete" })
    expect(fake.grants.peekSensitive("per_old_control", SCOPE)).toBeDefined()
  })

  test("secure fields and recognizable credentials never reach input", async () => {
    const fake = await fixture()
    fake.state.hit = { ...fake.state.hit, role: "AXTextField", editable: true, name: "Password" }
    expect(await checkStep({ kind: "type", text: "notes" }, fake.ctx)).toEqual({
      verdict: "refuse",
      code: "secure_field",
    })
    fake.state.hit = { ...fake.state.hit, name: "Body" }
    expect(await checkStep({ kind: "type", text: "sk-" + "a".repeat(24) }, fake.ctx)).toEqual({
      verdict: "refuse",
      code: "secure_field",
    })
    expect(fake.state.inputs).toEqual([])
  })

  test("pasting a secret is refused, while user clipboard text requires its own one-time ask", async () => {
    const fake = await fixture()
    const step: Computer.Step = { kind: "key", combo: ["Command", "v"], repeat: 1 }
    fake.state.hit = { ...fake.state.hit, role: "AXTextArea", name: "Body", editable: true }
    fake.state.clipboard.text = "sk-" + "a".repeat(24)
    expect(await checkStep(step, fake.ctx)).toEqual({ verdict: "refuse", code: "secure_field" })
    fake.state.clipboard.text = "A harmless sentence"
    expect(await checkStep(step, fake.ctx)).toMatchObject({ verdict: "pending", kind: "sensitive", why: "paste" })
    await fake.sensitive("per_paste", step, "paste")
    expect(await checkStep(step, { ...fake.ctx, approvals: [{ index: 0, requestID: "per_paste" }] })).toMatchObject({
      verdict: "ok",
    })
    expect(fake.state.inputs).toEqual([])
  })

  test("an observed custom Paste menu shortcut still reads and refuses a secret clipboard", async () => {
    const fake = await fixture()
    fake.state.hit = {
      ...fake.state.hit,
      role: "AXTextArea",
      name: "Body",
      editable: true,
      focusedMenuShortcuts: [{ combo: ["Command", "k"], label: "Paste" }],
    }
    fake.state.clipboard.text = "sk-" + "a".repeat(24)
    expect(await checkStep({ kind: "key", combo: ["Command", "k"], repeat: 1 }, fake.ctx)).toEqual({
      verdict: "refuse",
      code: "secure_field",
    })
    expect(fake.state.inputs).toEqual([])
  })

  test("paste consent for an earlier clipboard value cannot approve a later nonsecret value", async () => {
    const fake = await fixture()
    fake.state.hit = { ...fake.state.hit, role: "AXTextArea", name: "Body", editable: true }
    const step: Computer.Step = { kind: "key", combo: ["Command", "v"], repeat: 1 }
    await fake.sensitive("per_clipboard_A", step, "paste")
    fake.state.clipboard.text = "A different harmless sentence"
    expect(
      await checkStep(step, { ...fake.ctx, approvals: [{ index: 0, requestID: "per_clipboard_A" }] }),
    ).toMatchObject({ verdict: "pending", kind: "sensitive", why: "paste" })
    expect(fake.grants.peekSensitive("per_clipboard_A", SCOPE)).toBeDefined()
    await fake.sensitive("per_clipboard_B", step, "paste")
    expect(
      await checkStep(step, { ...fake.ctx, approvals: [{ index: 0, requestID: "per_clipboard_B" }] }),
    ).toMatchObject({ verdict: "ok" })
    expect(fake.state.inputs).toEqual([])
  })

  test("clipboard content that changes after classification is refused before input", async () => {
    const fake = await fixture()
    fake.state.hit = { ...fake.state.hit, role: "AXTextArea", name: "Body", editable: true }
    const reads = { count: 0 }
    fake.ctx.clipboard = async () => ({
      text: reads.count++ === 0 ? "First sentence" : "Changed sentence",
      agentOwned: true,
    })
    expect(await checkStep({ kind: "key", combo: ["Command", "v"], repeat: 1 }, fake.ctx)).toEqual({
      verdict: "refuse",
      code: "changed",
    })
    expect(fake.state.inputs).toEqual([])
  })

  test("a document alias resolving to Vector's protected config cannot be edited", async () => {
    const fake = await fixture()
    fake.state.hit = {
      ...fake.state.hit,
      role: "AXTextArea",
      name: "Body",
      editable: true,
      document: "/Documents/link.txt",
    }
    fake.state.canonical = () => "/Vector/config.json"
    fake.ctx.protectedPaths = ["/Vector/config.json"]
    expect(await checkStep({ kind: "type", text: "notes" }, fake.ctx)).toEqual({ verdict: "refuse", code: "blocked" })
    fake.state.canonical = () => undefined
    expect(await checkStep({ kind: "type", text: "notes" }, fake.ctx)).toEqual({ verdict: "refuse", code: "blocked" })
  })

  test("developer apps remain click-only for text even after app consent", async () => {
    const fake = await fixture()
    const developer: Computer.MacIdentity = { ...APP, bundleId: "com.microsoft.VSCode", name: "Code", pid: 12 }
    await fake.appAsk("per_developer", developer)
    fake.state.hit = {
      ...fake.state.hit,
      owner: developer,
      role: "AXTextArea",
      name: "Editor",
      editable: true,
      document: "/repo/app.ts",
    }
    expect(
      await checkStep(
        { kind: "type", text: "changed code" },
        { ...fake.ctx, allowedApps: [Computer.appKey(developer)] },
      ),
    ).toEqual({ verdict: "refuse", code: "blocked" })
  })

  test("an expired lease refuses before inspection and after an asynchronous lookup", async () => {
    const fake = await fixture()
    fake.grants.endTask(SCOPE.rootSessionID, SCOPE.directory)
    expect(await checkStep(CLICK, fake.ctx)).toEqual({ verdict: "refuse", code: "stopped" })
    expect(fake.state.calls).toEqual([])
    const waiting = await fixture()
    waiting.state.beforeHit = async () => waiting.grants.endTask(SCOPE.rootSessionID, SCOPE.directory)
    expect(await checkStep(CLICK, waiting.ctx)).toEqual({ verdict: "refuse", code: "stopped" })
    expect(waiting.state.inputs).toEqual([])
  })
})

describe("text chunk live ownership", () => {
  test("focus moves to another app between type chunks: the remaining chunks are not sent", async () => {
    const fake = await fixture()
    fake.state.hit = { ...fake.state.hit, role: "AXTextArea", name: "Body", editable: true }
    const result = await typeChecked(
      { kind: "type", text: "abcdefgh" },
      fake.ctx,
      async (text) => {
        await fake.backend.input({ op: "input.type", pid: 10, text }, 10000)
        fake.state.hit = {
          ...fake.state.hit,
          owner: { ...APP, bundleId: "com.example.Other", name: "Other", pid: 99 },
          windowId: "other-window",
        }
      },
      4,
    )
    expect(result).toEqual({ verdict: "refuse", code: "changed" })
    expect(fake.state.inputs).toEqual([{ op: "input.type", pid: APP.pid, text: "abcd" }])
  })

  test("the same app/PID/window with a different field stops before the next chunk", async () => {
    const fake = await fixture()
    fake.state.hit = { ...fake.state.hit, role: "AXTextArea", name: "Body", editable: true }
    const result = await typeChecked(
      { kind: "type", text: "abcdefgh" },
      fake.ctx,
      async (text) => {
        await fake.backend.input({ op: "input.type", pid: 10, text }, 10000)
        fake.state.hit = { ...fake.state.hit, elementId: "another-field", ref: "ui_2" }
      },
      4,
    )
    expect(result).toEqual({ verdict: "refuse", code: "changed" })
    expect(fake.state.inputs).toEqual([{ op: "input.type", pid: 10, text: "abcd" }])
  })

  test("Stop after one chunk leaves the remainder unsent", async () => {
    const fake = await fixture()
    fake.state.hit = { ...fake.state.hit, role: "AXTextArea", name: "Body", editable: true }
    const result = await typeChecked(
      { kind: "type", text: "abcdefgh" },
      fake.ctx,
      async (text) => {
        await fake.backend.input({ op: "input.type", pid: 10, text }, 10000)
        fake.grants.endTask(SCOPE.rootSessionID, SCOPE.directory)
      },
      4,
    )
    expect(result.verdict).toBe("refuse")
    expect(fake.state.inputs).toEqual([{ op: "input.type", pid: 10, text: "abcd" }])
  })

  test("a changed role or label stops text even when the stable native element ID stays the same", async () => {
    for (const change of [{ role: "AXTextField" }, { name: "Subject" }]) {
      const fake = await fixture()
      fake.state.hit = { ...fake.state.hit, role: "AXTextArea", name: "Body", editable: true }
      const result = await typeChecked(
        { kind: "type", text: "abcdefgh" },
        fake.ctx,
        async (text) => {
          await fake.backend.input({ op: "input.type", pid: 10, text }, 10000)
          fake.state.hit = { ...fake.state.hit, ...change }
        },
        4,
      )
      expect(fake.state.hit.elementId).toBe("native-1")
      expect(result).toEqual({ verdict: "refuse", code: "changed" })
      expect(fake.state.inputs).toEqual([{ op: "input.type", pid: 10, text: "abcd" }])
    }
  })

  test("a company restriction arriving during canonical-path resolution stops the next chunk", async () => {
    const fake = await fixture()
    fake.state.hit = {
      ...fake.state.hit,
      role: "AXTextArea",
      name: "Body",
      editable: true,
      document: "/Documents/report.txt",
    }
    fake.ctx.canonicalPath = async (file) => {
      await Promise.resolve()
      if (fake.state.inputs.length) fake.state.policy.enabled = false
      return file
    }
    const result = await typeChecked(
      { kind: "type", text: "abcdefgh" },
      fake.ctx,
      async (text) => {
        await fake.backend.input({ op: "input.type", pid: 10, text }, 10000)
      },
      4,
    )
    expect(result).toEqual({ verdict: "refuse", code: "changed" })
    expect(fake.state.inputs).toEqual([{ op: "input.type", pid: 10, text: "abcd" }])
  })

  test("a received Deny during canonical-path resolution stops the next chunk", async () => {
    const fake = await fixture()
    await fake.askApp("per_chunk_deny")
    fake.state.hit = {
      ...fake.state.hit,
      role: "AXTextArea",
      name: "Body",
      editable: true,
      document: "/Documents/report.txt",
    }
    fake.ctx.canonicalPath = async (file) => {
      if (fake.state.inputs.length)
        await fake.grants.observe({
          directory: SCOPE.directory,
          payload: {
            type: "permission.replied",
            properties: {
              sessionID: SCOPE.sessionID,
              requestID: "per_chunk_deny",
              reply: "reject",
            },
          },
        })
      return file
    }
    const result = await typeChecked(
      { kind: "type", text: "abcdefgh" },
      fake.ctx,
      async (text) => {
        await fake.backend.input({ op: "input.type", pid: 10, text }, 10000)
      },
      4,
    )
    expect(result).toEqual({ verdict: "refuse", code: "changed" })
    expect(fake.state.inputs).toEqual([{ op: "input.type", pid: 10, text: "abcd" }])
  })

  test("Unicode chunks stay whole when native references rotate for the same stable element", async () => {
    const fake = await fixture()
    fake.state.hit = { ...fake.state.hit, role: "AXTextArea", name: "Body", editable: true }
    const refs: string[] = []
    const result = await typeChecked(
      { kind: "type", text: "🌻中a" },
      fake.ctx,
      async (text, inspect, hit) => {
        refs.push(hit.ref!)
        await fake.backend.input({ op: "input.type", pid: 10, text }, 10000)
        fake.state.hit = { ...fake.state.hit, ref: `ui_${refs.length + 1}` }
      },
      2,
    )
    expect(result.verdict).toBe("ok")
    expect(refs).toEqual(["ui_1", "ui_2"])
    expect(fake.state.inputs).toEqual([
      { op: "input.type", pid: 10, text: "🌻中" },
      { op: "input.type", pid: 10, text: "a" },
    ])
  })
})

test("a background quiet barrier runs before consuming a sensitive approval", async () => {
  const fake = await fixture()
  fake.state.hit = { ...fake.state.hit, name: "Delete" }
  await fake.sensitive("per_quiet", CLICK, "delete")
  fake.ctx.approvals = [{ index: 0, requestID: "per_quiet" }]
  const busy = new Error("The physical target is still receiving user keys")
  fake.ctx.beforeInput = (hit) => {
    expect(hit.owner.pid).toBe(APP.pid)
    throw busy
  }
  await expect(checkStep(CLICK, fake.ctx)).rejects.toBe(busy)
  expect(fake.grants.peekSensitive("per_quiet", SCOPE)).toBeDefined()
  expect(fake.state.inputs).toEqual([])
  fake.ctx.beforeInput = undefined
  expect(await checkStep(CLICK, fake.ctx)).toMatchObject({ verdict: "ok" })
  expect(fake.grants.peekSensitive("per_quiet", SCOPE)).toBeUndefined()
})

const MENU: Computer.HitResult = {
  scope: "app-menu",
  owner: APP,
  pid: 10,
  ref: "ui_99",
  elementId: "menu_element",
  role: "AXMenuItem",
  name: "New",
  menuPath: ["File", "New"],
  enabled: true,
  editable: false,
  secure: false,
}
const MENU_CLICK: Computer.Step = { kind: "click", at: { ref: "ui_99" }, button: "left", count: 1, modifiers: [] }

test("a windowless menu uses its real owner and never borrows a window or globally focused target", async () => {
  const fake = await fixture()
  fake.state.hit = MENU
  fake.ctx.background = true
  fake.ctx.frame = undefined
  const result = await checkStep(MENU_CLICK, fake.ctx)
  expect(result).toMatchObject({ verdict: "ok", inspect: { scope: "app-menu", pid: 10, menuPath: ["File", "New"] } })
  if (result.verdict !== "ok" || result.waiting) throw new Error("Missing menu inspection")
  expect(Object.hasOwn(result.inspect, "window")).toBe(false)
  expect(fake.state.calls).toEqual([])
  expect(inspectHit({ ...MENU, windowId: "borrowed" } as Computer.HitResult, "general", "public_ref")).toBeUndefined()
})

test("menu roots stay read-only and localized unsafe shortcuts cannot be pressed", async () => {
  const fake = await fixture()
  fake.state.hit = { ...MENU, role: "AXMenuBar", name: "", menuPath: [] }
  expect(await checkStep(MENU_CLICK, fake.ctx)).toMatchObject({ verdict: "refuse", code: "blocked" })
  fake.state.hit = {
    ...MENU,
    name: "Inspecteur Web",
    menuPath: ["Développement", "Inspecteur Web"],
    menuShortcut: ["Command", "Option", "i"],
  }
  expect(await checkStep(MENU_CLICK, fake.ctx)).toMatchObject({ verdict: "refuse", code: "blocked" })
})

test("localized paste reads the actual clipboard and binds its menu consent", async () => {
  const fake = await fixture()
  fake.state.hit = { ...MENU, name: "Coller", menuPath: ["Édition", "Coller"], menuShortcut: ["Command", "v"] }
  expect(await checkStep(MENU_CLICK, fake.ctx)).toMatchObject({
    verdict: "pending",
    why: "paste",
    inspect: { clipboard: { text: fake.state.clipboard.text } },
  })
  await fake.sensitive("per_menu_paste", MENU_CLICK, "paste")
  expect(fake.grants.peekSensitive("per_menu_paste", SCOPE)).toBeDefined()
  fake.ctx.approvals = [{ index: 0, requestID: "per_menu_paste" }]
  expect(await checkStep(MENU_CLICK, fake.ctx)).toMatchObject({ verdict: "ok" })
  expect(fake.grants.peekSensitive("per_menu_paste", SCOPE)).toBeUndefined()
})

test("background text sends one complete insertion and does not consult global focus", async () => {
  const fake = await fixture()
  fake.state.hit = { ...fake.state.hit, role: "AXTextArea", name: "Body", editable: true }
  fake.ctx.background = true
  const text = "🙂e\u0301".repeat(40)
  const sent: string[] = []
  expect(
    await typeChecked(
      { kind: "type", ref: "ui_1", text },
      fake.ctx,
      async (part) => {
        sent.push(part)
      },
      2,
    ),
  ).toMatchObject({ verdict: "ok" })
  expect(sent).toEqual([text])
  expect(fake.state.calls.filter((call) => call.op === "focused")).toEqual([])
})
