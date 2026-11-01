import path from "node:path"
import { createHash } from "node:crypto"
import { Option, Schema } from "effect"
import { ComputerSensitive } from "@vectordevai/core/computer/sensitive"
import { Computer } from "@vectordevai/schema/computer"
import { PermissionPolicy } from "@vectordevai/schema/permission-policy"
import { PermissionV1 } from "@vectordevai/schema/v1/permission"
import { ComputerError } from "./computer-bridge"
import type { AppGrants } from "./computer-settings"
import type { KeepAwakeEvent } from "./keep-awake"

export type GrantScope = Readonly<{
  rootSessionID: string
  sessionID: string
  directory: string
  lease: number
}>

type Settings = {
  get(): Computer.ResolvedComputerSettings
  access(identity: Computer.AppIdentity, grants?: AppGrants): Computer.AccessVerdict
  acceptAlways(identity: Computer.AppIdentity): Promise<boolean>
}
type Task = {
  scope: GrantScope
  waiting: Set<() => void>
  grants: Map<string, { identity: Computer.AppIdentity; level: Computer.AskLevel }>
}
type Root = { denied: Set<string>; denyAll: boolean; task?: Task }
type Reply = "once" | "always" | "reject"
type Proof = {
  task: Task
  pattern: string
  reply?: Reply
  grantUsed: boolean
  rememberUsed: boolean
  actUsed: boolean
  granted?: Computer.AppIdentity
} & (
  | { permission: "computer_app"; metadata: Computer.AppAskMetadata }
  | { permission: "computer_sensitive"; metadata: Computer.SensitiveAskMetadata }
)

const MAX_PROOFS = 1000
const MAX_SEEN = 10000
const MAX_ROOTS = 1000
const MAX_DENIED = 1000
const Replied = Schema.Struct({
  sessionID: Schema.String,
  requestID: Schema.String,
  reply: Schema.Literals(["once", "always", "reject"]),
})
const decodeReply = Schema.decodeUnknownOption(Replied, { onExcessProperty: "error" })

/** Consent evidence comes only from the local engine's observed ask/reply stream, never a bridge assertion. */
export function createComputerGrants(input: {
  settings: Settings
  rootOf: (sessionID: string, directory: string) => Promise<string | undefined>
}) {
  const roots = new Map<string, Root>()
  const proofs = new Map<string, Proof>()
  // IDs are never reused, including after task end or a dropped connection. At the cap, new asks fail closed.
  const seen = new Set<string>()
  const queuedAsks = new Set<string>()
  let observations: Promise<void> = Promise.resolve()
  const queued = { count: 0 }

  const rootKey = (root: string, directory: string) => JSON.stringify([root, directory])
  const current = (scope: GrantScope) => {
    const task = roots.get(rootKey(scope.rootSessionID, scope.directory))?.task
    return task && sameScope(task.scope, scope) ? task : undefined
  }
  const active = (task: Task) => current(task.scope) === task
  const record = (id: string, scope: GrantScope) => {
    const proof = proofs.get(id)
    return proof && proof.task === current(scope) ? proof : undefined
  }
  const clear = (task: Task) => {
    for (const cancel of task.waiting) cancel()
    task.grants.clear()
    for (const [id, proof] of proofs) if (proof.task === task) proofs.delete(id)
  }

  function endTask(rootSessionID: string, directory: string) {
    const key = rootKey(rootSessionID, directory)
    const root = roots.get(key)
    if (!root) return
    if (root.task) clear(root.task)
    root.task = undefined
    if (!root.denyAll && root.denied.size === 0) roots.delete(key)
  }

  function beginTask(scope: GrantScope) {
    if (
      ![scope.rootSessionID, scope.sessionID, scope.directory].every(
        (value) => typeof value === "string" && value.length > 0 && value.length <= 16384 && !value.includes("\0"),
      ) ||
      !Number.isSafeInteger(scope.lease) ||
      scope.lease <= 0
    )
      throw new ComputerError("failed", "The computer grant scope is invalid.")
    if (current(scope)) return
    const key = rootKey(scope.rootSessionID, scope.directory)
    const root = roots.get(key) ?? { denied: new Set<string>(), denyAll: false }
    if (!roots.has(key) && roots.size >= MAX_ROOTS)
      throw new ComputerError("unavailable", "Too many computer grant scopes are retained.")
    if (root.task) clear(root.task)
    const copied = Object.freeze({
      rootSessionID: scope.rootSessionID,
      sessionID: scope.sessionID,
      directory: scope.directory,
      lease: scope.lease,
    })
    root.task = { scope: copied, waiting: new Set(), grants: new Map() }
    roots.set(key, root)
  }

  function grants(scope: GrantScope): AppGrants {
    const root = roots.get(rootKey(scope.rootSessionID, scope.directory))
    const task = current(scope)
    return {
      task: new Map(
        [...(task?.grants ?? [])].map(([key, value]) => [key, { ...value, identity: structuredClone(value.identity) }]),
      ),
      denied: root?.denyAll ? new AllDenied(root.denied) : new Set(root?.denied),
    }
  }

  function verify(
    id: string,
    permission: "computer_app" | "computer_sensitive",
    pattern: string,
    scope: GrantScope,
  ): "once" | "always" | undefined {
    const proof = record(id, scope)
    if (!proof || proof.permission !== permission || proof.pattern !== pattern || proof.actUsed) return
    if (proof.reply !== "once" && proof.reply !== "always") return
    if (permission === "computer_sensitive") return proof.reply === "once" ? "once" : undefined
    if (proof.permission !== "computer_app") return
    if (proof.reply === "always" && !proof.metadata.canAlways) return
    return proof.reply
  }

  function observe(event: KeepAwakeEvent): Promise<void> {
    if (event.payload.type !== "permission.asked" && event.payload.type !== "permission.replied")
      return Promise.resolve()
    const asked =
      event.payload.type === "permission.asked"
        ? Schema.decodeUnknownOption(PermissionV1.Request)(event.payload.properties)
        : undefined
    const replied = event.payload.type === "permission.replied" ? decodeReply(event.payload.properties) : undefined
    const request = asked && Option.isSome(asked) ? asked.value : undefined
    const reply = replied && Option.isSome(replied) ? replied.value : undefined
    if ((!request && !reply) || !event.directory) return Promise.resolve()
    if (
      request &&
      (!PermissionPolicy.handsAsk(request.permission) ||
        request.id.length > 256 ||
        request.patterns.length !== 1 ||
        request.always.length > 1)
    )
      return Promise.resolve()
    const sessionID = request?.sessionID ?? reply!.sessionID
    // Capture registration now, before queued ancestry work. A late resolver/event cannot acquire a later lease.
    const task = [...roots.values()].find(
      (root) => root.task?.scope.sessionID === sessionID && root.task.scope.directory === event.directory,
    )?.task
    if (!task) return Promise.resolve()
    if (reply && !proofs.has(reply.requestID) && !queuedAsks.has(reply.requestID)) return Promise.resolve()
    if (queued.count >= MAX_PROOFS) {
      // Dropping a received Deny could leave an older grant usable. End this scope before discarding evidence.
      endTask(task.scope.rootSessionID, task.scope.directory)
      return Promise.resolve()
    }
    const app =
      request?.permission === "computer_app"
        ? Schema.decodeUnknownOption(Computer.AppAskMetadata)(request.metadata)
        : undefined
    const sensitive =
      request?.permission === "computer_sensitive"
        ? Schema.decodeUnknownOption(Computer.SensitiveAskMetadata)(request.metadata)
        : undefined
    const metadata =
      app && Option.isSome(app)
        ? structuredClone(app.value)
        : sensitive && Option.isSome(sensitive)
          ? withoutText(sensitive.value)
          : undefined
    const envelope = request
      ? { id: request.id, permission: request.permission, pattern: request.patterns[0]!, always: [...request.always] }
      : undefined
    if (envelope) queuedAsks.add(envelope.id)
    queued.count++
    const next = observations
      .then(async () => {
        if (!active(task)) return
        const resolved = envelope
          ? await new Promise<string | undefined>((resolve) => {
              const finish = (root?: string) => {
                task.waiting.delete(cancel)
                resolve(root)
              }
              const cancel = () => finish()
              task.waiting.add(cancel)
              Promise.resolve()
                .then(() => input.rootOf(sessionID, task.scope.directory))
                .then(finish, () => finish())
            })
          : task.scope.rootSessionID
        if (!active(task)) return
        if (resolved !== task.scope.rootSessionID) {
          endTask(task.scope.rootSessionID, task.scope.directory)
          return
        }
        // A reply is already bound by its observed ask and exact active scope. A second ancestry lookup could
        // fail and discard a real Deny while leaving older grants alive, so only new asks resolve ancestry.
        if (envelope) {
          if (seen.has(envelope.id)) return
          if (seen.size >= MAX_SEEN || proofs.size >= MAX_PROOFS) {
            endTask(task.scope.rootSessionID, task.scope.directory)
            return
          }
          seen.add(envelope.id)
          if (!metadata) return
          if (envelope.permission === "computer_app" && "canAlways" in metadata) {
            if (
              envelope.pattern !== metadata.target.appKey ||
              metadata.canAlways !== (envelope.always.length === 1 && envelope.always[0] === envelope.pattern)
            )
              return
            proofs.set(envelope.id, {
              task,
              pattern: envelope.pattern,
              permission: "computer_app",
              metadata,
              grantUsed: false,
              rememberUsed: false,
              actUsed: false,
            })
          }
          if (envelope.permission === "computer_sensitive" && "why" in metadata) {
            if (
              envelope.always.length ||
              envelope.pattern !== `${metadata.target.appKey}:${metadata.why}` ||
              !metadata.stepDigest
            )
              return
            proofs.set(envelope.id, {
              task,
              pattern: envelope.pattern,
              permission: "computer_sensitive",
              metadata,
              grantUsed: false,
              rememberUsed: false,
              actUsed: false,
            })
          }
          return
        }
        if (!reply) return
        const proof = record(reply.requestID, task.scope)
        if (!proof || proof.reply !== undefined) return
        proof.reply = reply.reply
        if (reply.reply !== "reject" || proof.permission !== "computer_app") return
        const root = roots.get(rootKey(task.scope.rootSessionID, task.scope.directory))!
        if (root.denied.size >= MAX_DENIED && !root.denied.has(proof.pattern)) root.denyAll = true
        else root.denied.add(proof.pattern)
        task.grants.delete(proof.pattern)
        // A newer Deny revokes earlier unspent authority, including any sensitive input for that app. A subsequent
        // mention may ask again, but cannot resurrect an older Allow or a not-yet-claimed Always save.
        for (const [id, older] of proofs)
          if (older !== proof && older.task === task && older.metadata.target.appKey === proof.pattern)
            proofs.delete(id)
      })
      .finally(() => {
        queued.count--
        if (envelope) queuedAsks.delete(envelope.id)
      })
    observations = next.catch(() => {})
    return next
  }

  async function synchronize() {
    while (true) {
      const pending = observations
      await pending
      if (pending === observations) return
    }
  }

  async function grant(scope: GrantScope, identity: Computer.AppIdentity, level: Computer.AskLevel, requestID: string) {
    await synchronize()
    const proof = record(requestID, scope)
    if (!proof || proof.permission !== "computer_app" || proof.grantUsed || !matchesApp(proof.metadata, identity))
      return false
    const reply = verify(requestID, "computer_app", Computer.appKey(identity), scope)
    if (
      !reply ||
      (level !== "observe" && level !== "interact") ||
      (level === "interact" && proof.metadata.level !== "interact")
    )
      return false
    const view = { ...grants(scope), ...(proof.metadata.mentioned ? { liftDeny: true } : {}) }
    const access = input.settings.access(identity, view)
    if (access.verdict !== "ask" && access.verdict !== "granted") return false
    if (reply === "always" && (access.verdict !== "ask" || !access.canAlways)) return false
    proof.grantUsed = true
    proof.granted = structuredClone(identity)
    const key = Computer.appKey(identity)
    const previous = proof.task.grants.get(key)
    proof.task.grants.set(key, {
      identity: structuredClone(identity),
      level:
        previous && sameIdentity(previous.identity, identity) && previous.level === "interact" ? "interact" : level,
    })
    roots.get(rootKey(scope.rootSessionID, scope.directory))!.denied.delete(key)
    return true
  }

  async function remember(scope: GrantScope, identity: Computer.AppIdentity, requestID: string) {
    await synchronize()
    const proof = record(requestID, scope)
    if (
      !proof ||
      proof.permission !== "computer_app" ||
      proof.rememberUsed ||
      !proof.grantUsed ||
      !proof.granted ||
      !sameIdentity(identity, proof.granted) ||
      !matchesApp(proof.metadata, identity) ||
      verify(requestID, "computer_app", Computer.appKey(identity), scope) !== "always" ||
      !proof.metadata.canAlways
    )
      return false
    const access = input.settings.access(identity)
    if (access.verdict !== "ask" || !access.canAlways || !input.settings.get().policy.allowAlways) return false
    // Claim before the asynchronous sealed-store operation. The user's Always decision outlives this task.
    proof.rememberUsed = true
    return input.settings.acceptAlways(structuredClone(identity))
  }

  function consumeApp(id: string, scope: GrantScope, identity: Computer.AppIdentity, consume = true) {
    const proof = record(id, scope)
    if (
      !proof ||
      proof.permission !== "computer_app" ||
      proof.actUsed ||
      !proof.grantUsed ||
      !proof.granted ||
      !sameIdentity(identity, proof.granted) ||
      !matchesApp(proof.metadata, identity) ||
      !verify(id, "computer_app", Computer.appKey(identity), scope)
    )
      return false
    if (consume) {
      proof.actUsed = true
      proofs.delete(id)
    }
    return true
  }

  function peekSensitive(id: string, scope: GrantScope) {
    const proof = record(id, scope)
    if (
      !proof ||
      proof.permission !== "computer_sensitive" ||
      proof.actUsed ||
      verify(id, "computer_sensitive", proof.pattern, scope) !== "once"
    )
      return
    return structuredClone(proof.metadata)
  }

  function consumeSensitive(
    id: string,
    scope: GrantScope,
    step: ComputerSensitive.Step,
    inspect: Computer.InspectResult,
    frame?: string,
    why?: Computer.SensitiveWhy,
    consume = true,
  ) {
    const metadata = peekSensitive(id, scope)
    if (
      !metadata ||
      metadata.target.appKey !== Computer.appKey(inspect.app) ||
      (why !== undefined && metadata.why !== why) ||
      metadata.stepDigest !== ComputerSensitive.digest(step) ||
      metadata.frame !== frame ||
      metadata.action !== actionOf(step)
    )
      return false
    if (step.kind === "open" || metadata.why === "run_program") {
      const canonical = inspect.programPath ?? (step.kind === "open" ? nativePath(inspect.app) : undefined)
      if (
        !canonical ||
        metadata.path !== canonical ||
        (step.kind === "open" && step.path !== canonical) ||
        (!path.posix.isAbsolute(canonical) && !path.win32.isAbsolute(canonical))
      )
        return false
    } else if (
      metadata.target.pid !== inspect.pid ||
      !metadata.target.windowId ||
      metadata.target.windowId !== inspect.window.id
    )
      return false
    if (metadata.target.ref !== undefined && metadata.target.ref !== inspect.element?.ref) return false
    if (metadata.target.elementId !== inspect.element?.elementId) return false
    if (
      metadata.why === "paste" &&
      (typeof inspect.clipboard.text !== "string" ||
        metadata.clipboardHash !== createHash("sha256").update(inspect.clipboard.text).digest("hex"))
    )
      return false
    if (
      metadata.targetName !== undefined &&
      metadata.targetName !== Computer.clean(inspect.element?.label ?? "", Computer.LIMITS.labelChars)
    )
      return false
    if (consume) {
      proofs.get(id)!.actUsed = true
      proofs.delete(id)
    }
    return true
  }

  return {
    synchronize,
    isActive: (scope: GrantScope) => current(scope) !== undefined,
    beginTask,
    endTask,
    forgetRoot(rootSessionID: string, directory: string) {
      endTask(rootSessionID, directory)
      roots.delete(rootKey(rootSessionID, directory))
    },
    disconnect() {
      for (const root of roots.values()) if (root.task) clear(root.task)
      for (const [key, root] of roots) {
        root.task = undefined
        if (!root.denyAll && root.denied.size === 0) roots.delete(key)
      }
      proofs.clear()
    },
    observe,
    verify,
    grant,
    remember,
    grants,
    peekSensitive,
    consumeSensitive,
    consumeApp,
  }
}

class AllDenied extends Set<string> {
  override has(_key: string) {
    return true
  }
}

function sameScope(a: GrantScope, b: GrantScope) {
  return (
    a.rootSessionID === b.rootSessionID &&
    a.sessionID === b.sessionID &&
    a.directory === b.directory &&
    a.lease === b.lease
  )
}

function nativePath(identity: Computer.AppIdentity) {
  return identity.platform === "macos" ? identity.path : identity.platform === "windows" ? identity.exe : undefined
}

function sameIdentity(a: Computer.AppIdentity, b: Computer.AppIdentity) {
  if (a.platform === "remote" || b.platform === "remote") return false
  if (Computer.appKey(a) !== Computer.appKey(b) || a.platform !== b.platform || a.verified !== b.verified) return false
  if (
    a.platform === "macos" &&
    b.platform === "macos" &&
    (a.apple !== b.apple || a.teamId?.toLowerCase() !== b.teamId?.toLowerCase())
  )
    return false
  if (a.platform === "windows" && b.platform === "windows" && a.publisher?.toLowerCase() !== b.publisher?.toLowerCase())
    return false
  return a.verified || Boolean(nativePath(a) && a.pid && nativePath(a) === nativePath(b) && a.pid === b.pid)
}

function matchesApp(metadata: Computer.AppAskMetadata, identity: Computer.AppIdentity) {
  if (
    !Schema.is(Computer.AppIdentity)(identity) ||
    identity.platform === "remote" ||
    metadata.target.appKey !== Computer.appKey(identity) ||
    metadata.target.platform !== identity.platform ||
    metadata.target.verified !== identity.verified
  )
    return false
  if (metadata.target.pid !== undefined && metadata.target.pid !== identity.pid) return false
  if (metadata.target.path !== undefined && metadata.target.path !== nativePath(identity)) return false
  if (!identity.verified && (!metadata.target.pid || !metadata.target.path || !identity.pid || !nativePath(identity)))
    return false
  if (identity.platform === "macos")
    return (
      metadata.target.teamId?.toLowerCase() === identity.teamId?.toLowerCase() &&
      (metadata.target.publisher ?? "").toLowerCase() === (identity.apple && identity.verified ? "apple inc." : "")
    )
  return (metadata.target.publisher ?? "").toLowerCase() === (identity.publisher ?? "").toLowerCase()
}

function withoutText(metadata: Computer.SensitiveAskMetadata): Computer.SensitiveAskMetadata {
  const { text, ...rest } = metadata
  return structuredClone(rest)
}

function actionOf(step: ComputerSensitive.Step): Computer.SensitiveAskMetadata["action"] {
  return step.kind === "open" || step.kind === "type" || step.kind === "key" || step.kind === "drag"
    ? step.kind
    : "click"
}
