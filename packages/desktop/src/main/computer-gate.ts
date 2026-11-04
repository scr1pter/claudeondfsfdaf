import { ComputerCredential } from "@vectordevai/core/computer/credential"
import { ComputerKeys } from "@vectordevai/core/computer/keys"
import { ComputerSensitive } from "@vectordevai/core/computer/sensitive"
import { Computer } from "@vectordevai/schema/computer"
import { ComputerApps } from "@vectordevai/schema/computer-apps"
import type { GrantScope, createComputerGrants } from "./computer-grants"
import type { AppGrants } from "./computer-settings"

export type GateContext = {
  scope: GrantScope
  backend: Pick<Computer.ComputerBackend, "hitTest" | "focused" | "apps" | "input">
  settings: { access(identity: Computer.AppIdentity, grants?: AppGrants): Computer.AccessVerdict }
  grants: ReturnType<typeof createComputerGrants>
  index: number
  allowedApps?: readonly string[]
  approvals?: readonly { index: number; requestID: string }[]
  frame?: Computer.Frame
  /** Main's capture registry checks the live native geometry, not a model-provided timestamp. */
  frameCurrent?: (frame: Computer.Frame, hit: Computer.HitResult) => Promise<boolean>
  resolveRef?: (ref: string) => Promise<Computer.HitResult>
  uiRef?: (hit: Computer.HitResult) => string | undefined
  /** A verified default point for coordinate-less scrolling; never an invented cursor position. */
  point?: Computer.Point
  clipboard?: () => Promise<{ text: string; agentOwned: boolean }>
  canonicalPath: (file: string) => Promise<string | undefined>
  protectedPaths: readonly string[]
  protectedDirectories: readonly string[]
  documentProtected?: (file: string) => boolean
  signals?: (hit: Computer.HitResult) => ComputerApps.Signals | undefined
  /** Synchronous physical-input quiet barrier, before consuming any once-only proof. */
  beforeInput?: (hit: Computer.HitResult) => void
}

export type GateResult =
  | { verdict: "ok"; waiting: true }
  | {
      verdict: "ok"
      waiting?: false
      inspect: Computer.InspectResult
      hit: Computer.HitResult
      hits: Computer.HitResult[]
      point?: Computer.Point
    }
  | { verdict: "refuse"; code: Computer.ComputerErrorCode }
  | { verdict: "pending"; kind: "app" | "sensitive"; why?: Computer.SensitiveWhy; inspect: Computer.InspectResult }

/** Called for each step, after the preceding step has finished. No inspection supplied by the engine is authoritative. */
export async function checkStep(step: Computer.Step, ctx: GateContext): Promise<GateResult> {
  await ctx.grants.synchronize()
  if (!ctx.grants.isActive(ctx.scope)) return refuse("stopped")
  const approvals = ctx.approvals?.filter((item) => item.index === ctx.index) ?? []
  if (new Set(approvals.map((item) => item.requestID)).size !== approvals.length) return refuse("not_granted")
  // Waiting changes no app, so it neither needs an owner nor spends authority for a later input step.
  if (step.kind === "wait") return approvals.length ? refuse("not_granted") : { verdict: "ok", waiting: true }
  for (const approval of approvals) {
    if (!(await ctx.grants.waitForReply(approval.requestID, ctx.scope))) return refuse("not_granted")
    if (!ctx.grants.isActive(ctx.scope)) return refuse("stopped")
  }
  if (step.kind === "down" || step.kind === "up") return refuse("unsupported_action")
  const ref = step.kind === "type" ? step.ref : step.kind === "click" && "ref" in step.at ? step.at.ref : undefined
  const points =
    step.kind === "drag"
      ? step.path
      : step.kind === "move" || (step.kind === "click" && !ref)
        ? [step.at as Computer.Point]
        : step.kind === "scroll"
          ? [step.at ?? ctx.point]
          : []
  if (points.some((point) => !point) || (points.length && !ctx.frame)) return refuse("stale_frame")
  if (ref && !ctx.resolveRef) return refuse("stale_ref")
  const hits = ref
    ? [await ctx.resolveRef!(ref)]
    : points.length
      ? await Promise.all(points.map((point) => ctx.backend.hitTest(ctx.frame!.id, point!.x, point!.y)))
      : [await ctx.backend.focused()]
  await ctx.grants.synchronize()
  if (!ctx.grants.isActive(ctx.scope)) return refuse("stopped")
  const inspections: Computer.InspectResult[] = []
  for (const hit of hits) {
    const signals = { ...ctx.signals?.(hit), ...hit.signals }
    const category = ComputerApps.category(hit.owner, signals)
    if (category === "security" || category === "system-ui") return refuse("protected")
    if (ComputerApps.isNever(category)) return refuse("blocked")
    if (hit.elevated) return refuse("elevated")
    if (hit.owner.platform === "remote" || !hit.owner.pid || !Number.isSafeInteger(hit.owner.pid))
      return refuse("changed")
    const access = ctx.settings.access(hit.owner, { ...ctx.grants.grants(ctx.scope), signals })
    if (["never", "blocked", "company-deny"].includes(access.verdict)) return refuse("blocked")
    if (access.verdict === "denied") return refuse("not_granted")
    if (
      !ctx.allowedApps?.includes(Computer.appKey(hit.owner)) ||
      access.verdict !== "granted" ||
      access.level !== "interact"
    )
      return pending("app", {
        app: hit.owner,
        category,
        pid: hit.owner.pid,
        window: { id: String(hit.windowId) },
        element: { role: hit.role, secure: hit.secure, enabled: hit.enabled === true, editable: hit.editable === true },
        clipboard: { agentOwned: false },
      })
    const uiRef = ctx.uiRef?.(hit)
    if (ref && uiRef !== ref) return refuse("stale_ref")
    let inspect: Computer.InspectResult = {
      app: hit.owner,
      category,
      pid: hit.owner.pid,
      window: { id: String(hit.windowId) },
      element: {
        role: hit.role,
        secure: hit.secure,
        enabled: hit.enabled === true,
        editable: hit.editable === true,
        ...(uiRef ? { ref: uiRef } : {}),
        ...(hit.elementId ? { elementId: hit.elementId } : {}),
        ...(hit.name === undefined ? {} : { label: hit.name }),
      },
      clipboard: { agentOwned: false },
      ...(hit.document ? { document: hit.document } : {}),
      ...(hit.documentStatus ? { documentStatus: hit.documentStatus } : {}),
      ...(hit.programPath ? { programPath: hit.programPath } : {}),
      ...(hit.layout ? { layout: hit.layout } : {}),
      ...(hit.focusedMenuShortcuts ? { focusedMenuShortcuts: hit.focusedMenuShortcuts } : {}),
      ...(hit.elevated ? { elevated: true } : {}),
    }
    if (ComputerCredential.field(inspect.element) || (step.kind === "type" && ComputerCredential.secret(step.text)))
      return refuse("secure_field")
    if (step.kind === "type" && (!hit.elementId || !hit.ref || hit.enabled !== true || hit.editable === undefined))
      return refuse("blocked")
    if (
      step.kind === "key" &&
      (!inspect.layout ||
        inspect.focusedMenuShortcuts === undefined ||
        inspect.layout.platform !== hit.owner.platform ||
        !ComputerKeys.allowedCombo(step.combo, inspect.focusedMenuShortcuts, inspect.layout))
    )
      return refuse("blocked")
    if (points.length && (!ctx.frameCurrent || !(await ctx.frameCurrent(ctx.frame!, hit)))) return refuse("stale_frame")
    if (inspect.document) {
      const canonical = await ctx.canonicalPath(inspect.document)
      if (!canonical) return refuse("blocked")
      inspect = { ...inspect, document: canonical }
    }
    if (inspect.programPath) {
      const canonical = await ctx.canonicalPath(inspect.programPath)
      if (!canonical) return refuse("blocked")
      inspect = { ...inspect, programPath: canonical }
    }
    // File editors without a resolvable document cannot establish that an edit avoids protected instructions.
    if (
      (category === "office" || category === "files") &&
      editsText(step, inspect) &&
      !inspect.document &&
      hit.documentStatus !== "none"
    )
      return refuse("blocked")
    inspections.push(inspect)
  }
  let inspect = inspections.at(-1)!
  // A drag must pass every owner gate. Its final target is authoritative for dropping into Trash, for example.
  if (step.kind === "key" || step.kind === "type") {
    // Reference-based text changes still require the actual focused field to agree.
    const focus = await ctx.backend.focused()
    if (!sameTarget(inspect, focus)) return refuse("changed")
  }
  const apps = await ctx.backend.apps()
  const title =
    hits.at(-1)!.windowTitle ??
    apps.flatMap((app) => app.windows).find((window) => String(window.windowId) === inspect.window.id)?.title
  if (title !== undefined) inspect = { ...inspect, window: { ...inspect.window, title } }
  if (isPaste(step, inspect)) {
    if (!ctx.clipboard) return refuse("blocked")
    const clipboard = await ctx.clipboard()
    if (ComputerCredential.secret(clipboard.text)) return refuse("secure_field")
    inspect = {
      ...inspect,
      clipboard: {
        agentOwned: clipboard.agentOwned,
        ...(clipboard.text.length <= Computer.LIMITS.typeTextChars ? { text: clipboard.text } : {}),
      },
    }
    if (clipboard.text.length > Computer.LIMITS.typeTextChars) return refuse("blocked")
  }
  const local = ComputerSensitive.classify(step, inspect, {
    layout: inspect.layout,
    focusedMenuShortcuts: inspect.focusedMenuShortcuts,
    protectedPaths: ctx.protectedPaths,
    protectedDirectories: ctx.protectedDirectories,
    resolvedDocument: inspect.document,
    programPath: inspect.programPath,
    clipboardText: inspect.clipboard.text,
    documentProtected: !!inspect.document && ctx.documentProtected?.(inspect.document),
  })
  if (local?.kind === "refuse") return refuse(local.code)
  const sensitive: { requestID: string; why: Computer.SensitiveWhy }[] = []
  const app: string[] = []
  for (const approval of approvals) {
    const proof = ctx.grants.peekSensitive(approval.requestID, ctx.scope)
    if (proof) {
      if (!ctx.grants.consumeSensitive(approval.requestID, ctx.scope, step, inspect, ctx.frame?.id, proof.why, false))
        return pending("sensitive", inspect, local?.why ?? proof.why)
      sensitive.push({ requestID: approval.requestID, why: proof.why })
    } else if (ctx.grants.consumeApp(approval.requestID, ctx.scope, inspect.app, false)) app.push(approval.requestID)
    else return refuse("not_granted")
  }
  if (local?.kind === "ask" && !sensitive.some((proof) => proof.why === local.why))
    return pending("sensitive", inspect, local.why)
  const final = ref
    ? await ctx.resolveRef!(ref)
    : points.length
      ? await ctx.backend.hitTest(ctx.frame!.id, points.at(-1)!.x, points.at(-1)!.y)
      : await ctx.backend.focused()
  const previous = hits.at(-1)!
  if (
    !sameTarget(inspect, final) ||
    final.elementId !== previous.elementId ||
    final.name !== previous.name ||
    final.secure !== previous.secure ||
    final.role !== previous.role ||
    final.enabled !== previous.enabled ||
    final.editable !== previous.editable ||
    final.windowTitle !== previous.windowTitle ||
    JSON.stringify(final.signals) !== JSON.stringify(previous.signals) ||
    final.document !== previous.document ||
    final.documentStatus !== previous.documentStatus ||
    final.programPath !== previous.programPath ||
    JSON.stringify(final.layout) !== JSON.stringify(previous.layout) ||
    JSON.stringify(final.focusedMenuShortcuts) !== JSON.stringify(previous.focusedMenuShortcuts)
  )
    return refuse("changed")
  if (isPaste(step, inspect)) {
    const clipboard = await ctx.clipboard!()
    if (clipboard.text !== inspect.clipboard.text || clipboard.agentOwned !== inspect.clipboard.agentOwned)
      return refuse("changed")
  }
  await ctx.grants.synchronize()
  if (!ctx.grants.isActive(ctx.scope)) return refuse("stopped")
  const access = ctx.settings.access(final.owner, {
    ...ctx.grants.grants(ctx.scope),
    signals: { ...ctx.signals?.(final), ...final.signals },
  })
  if (access.verdict !== "granted" || access.level !== "interact") return refuse("not_granted")
  for (const hit of hits) {
    const access = ctx.settings.access(hit.owner, {
      ...ctx.grants.grants(ctx.scope),
      signals: { ...ctx.signals?.(hit), ...hit.signals },
    })
    if (access.verdict !== "granted" || access.level !== "interact") return refuse("not_granted")
  }
  if (!ctx.grants.isActive(ctx.scope)) return refuse("stopped")
  // Validate all proofs first: a second missing ask must not burn a still-needed first approval.
  ctx.beforeInput?.(final)
  if (!ctx.grants.isActive(ctx.scope)) return refuse("stopped")
  for (const proof of sensitive)
    if (!ctx.grants.consumeSensitive(proof.requestID, ctx.scope, step, inspect, ctx.frame?.id, proof.why))
      return refuse("not_granted")
  for (const id of app) if (!ctx.grants.consumeApp(id, ctx.scope, inspect.app)) return refuse("not_granted")
  return {
    verdict: "ok",
    inspect,
    hit: final,
    hits: [...hits.slice(0, -1), final],
    ...(points.length === 1 ? { point: points[0]! } : {}),
  }
}

/** The whole text was classified/approved once; each native chunk still rechecks the live owner, policy and field. */
export async function typeChecked(
  step: Extract<Computer.Step, { kind: "type" }>,
  ctx: GateContext,
  send: (text: string, inspect: Computer.InspectResult, hit: Computer.HitResult) => Promise<void>,
  chunkSize = 64,
): Promise<GateResult> {
  if (!Number.isSafeInteger(chunkSize) || chunkSize < 1 || chunkSize > 1024) return refuse("blocked")
  const checked = await checkStep(step, ctx)
  if (checked.verdict !== "ok" || checked.waiting) return checked
  const characters = [...step.text]
  for (let offset = 0; offset < characters.length; offset += chunkSize) {
    await ctx.grants.synchronize()
    const hit = await ctx.backend.focused()
    if (
      !ctx.grants.isActive(ctx.scope) ||
      !sameTarget(checked.inspect, hit) ||
      !hit.ref ||
      hit.elementId !== checked.hit.elementId
    )
      return refuse("changed")
    const access = ctx.settings.access(hit.owner, {
      ...ctx.grants.grants(ctx.scope),
      signals: { ...ctx.signals?.(hit), ...hit.signals },
    })
    if (access.verdict !== "granted" || access.level !== "interact") return refuse("changed")
    if (ComputerCredential.field({ ...checked.inspect.element!, role: hit.role, label: hit.name, secure: hit.secure }))
      return refuse("secure_field")
    if (
      hit.role !== checked.hit.role ||
      hit.name !== checked.hit.name ||
      hit.editable !== checked.hit.editable ||
      hit.enabled !== true ||
      hit.documentStatus !== checked.hit.documentStatus ||
      hit.windowTitle !== checked.hit.windowTitle
    )
      return refuse("changed")
    const document = hit.document ? await ctx.canonicalPath(hit.document) : undefined
    if (
      document !== checked.inspect.document ||
      (hit.document && !document) ||
      (document && ctx.documentProtected?.(document))
    )
      return refuse("changed")
    await ctx.grants.synchronize()
    if (!ctx.grants.isActive(ctx.scope)) return refuse("changed")
    const currentAccess = ctx.settings.access(hit.owner, {
      ...ctx.grants.grants(ctx.scope),
      signals: { ...ctx.signals?.(hit), ...hit.signals },
    })
    if (currentAccess.verdict !== "granted" || currentAccess.level !== "interact") return refuse("changed")
    ctx.beforeInput?.(hit)
    if (!ctx.grants.isActive(ctx.scope)) return refuse("changed")
    await send(characters.slice(offset, offset + chunkSize).join(""), checked.inspect, hit)
  }
  return checked
}

function sameTarget(inspect: Computer.InspectResult, hit: Computer.HitResult) {
  return (
    hit.owner.platform !== "remote" &&
    hit.owner.pid === inspect.pid &&
    Computer.appKey(hit.owner) === Computer.appKey(inspect.app) &&
    String(hit.windowId) === inspect.window.id &&
    !hit.elevated
  )
}
function isPaste(step: Computer.Step, inspect: Computer.InspectResult) {
  const key = step.kind === "key" ? ComputerKeys.resolve(step.combo, inspect.layout) : undefined
  const menu =
    key &&
    inspect.focusedMenuShortcuts?.find((item) => {
      const candidate = ComputerKeys.resolve(item.combo, inspect.layout)
      return candidate?.key === key.key && candidate.modifiers.join("+") === key.modifiers.join("+")
    })
  return (
    !!(
      key &&
      ((key.key === "v" && key.modifiers.some((value) => value === "control" || value === "meta")) ||
        (key.key === "insert" && key.modifiers.includes("shift")))
    ) ||
    !!(
      (step.kind === "click" || menu || key?.key === "enter" || key?.key === "space") &&
      /^paste\b/i.test(menu?.label ?? inspect.element?.label ?? "")
    )
  )
}
function editsText(step: Computer.Step, inspect: Computer.InspectResult) {
  if (step.kind === "type" || isPaste(step, inspect)) return true
  if (step.kind !== "key") return false
  const key = ComputerKeys.resolve(step.combo, inspect.layout)
  return !key || ["enter", "backspace", "delete"].includes(key.key) || [...key.key].length === 1
}
function refuse(code: Computer.ComputerErrorCode): GateResult {
  return { verdict: "refuse", code }
}
function pending(kind: "app" | "sensitive", inspect: Computer.InspectResult, why?: Computer.SensitiveWhy): GateResult {
  return { verdict: "pending", kind, inspect, ...(why ? { why } : {}) }
}
