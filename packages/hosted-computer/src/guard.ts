import type { HandoffReason, Point, Rect } from "./actions"
import type { GuardView } from "./computer"

/*
 * hostd's hold on the computer's browser (contract WP A54): the browser's debugging pipe, which only hostd holds (the
 * browser is started with `--remote-debugging-pipe`, so there is no debugging port for the agent or a page to reach).
 * Over it hostd injects image/credential-guard.js into an isolated world of every frame, counts top-level page loads for
 * the fair-use meter (WP A53), and asks the guard, before each agent action, whether the focused field (or the field
 * under the pointer, for a paste or a drop) is a credential field and where CAPTCHA challenges are.
 *
 * The guard fails closed: whenever it cannot answer for every page in time, the field counts as a credential field and
 * the action is refused. It cannot answer while it is not in place (not started, or its pipe closed), for a page or
 * frame whose setup failed (or, until it answers, timed out on every try), while a session it never attached to reports
 * a guard world, and when the focus or the point is in a frame no guard world answers for. While a page or frame is
 * only on its way (its setup in flight, announced but not attached yet, or its top document's guard world not there
 * yet, as right after a navigation), a question waits for it, for at most `settleMs`, before it answers "credential".
 */

export const GUARD_WORLD = "vector-guard"
const CALL_MS = 5_000
/** The guard's first commands go out as the browser starts, so they wait for the whole start-up as well. */
const START_MS = 30_000
const QUERY_MS = 1_500
/** How often the guard asks again when pages, frames or documents appeared while it was asking. */
const ROUNDS = 3
/** How often a page's setup is sent before the guard stops waiting for it, when the page did not answer in time. */
const SETUP_TRIES = 3
/** The longest pause between later tries of a setup that timed out on every try. */
const RETRY_MAX_MS = 60_000
/** The largest single message the guard takes from the browser. */
const MAX_MESSAGE = 64 * 1024 * 1024
/** The targets the guard is put into; other targets (workers) are only let run. */
const GUARDED_TYPES = new Set(["page", "iframe"])

type Message = { id?: number; method?: string; params?: Record<string, unknown>; result?: unknown; error?: { message?: string }; sessionId?: string }

/** A command the browser did not answer in time (it may still carry it out). */
export class CdpTimeout extends Error {}

/** The browser's debugging protocol over its pipe: messages are JSON, each ended by a NUL byte. */
export class CdpPipe {
  private next = 1
  private buffer = ""
  private readonly pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>()
  private readonly listeners = new Set<(message: Message) => void>()
  private readonly closers = new Set<() => void>()
  private readonly maxMessage: number
  private shut = false

  constructor(
    private readonly write: (chunk: string) => void,
    options: { maxMessage?: number } = {},
  ) {
    this.maxMessage = options.maxMessage ?? MAX_MESSAGE
  }

  /** Whether the pipe is closed (the browser went away, or a message grew too large): nothing more goes through it. */
  get closed() {
    return this.shut
  }

  /** Characters held for a message not yet complete. */
  get buffered() {
    return this.buffer.length
  }

  /** Bytes from the browser (its fd 4). */
  feed(chunk: string | Uint8Array) {
    if (this.shut) return
    this.buffer += typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk)
    // A single message is never allowed to grow without bound.
    if (this.buffer.length > this.maxMessage) return this.close()
    let end = this.buffer.indexOf("\0")
    while (end >= 0 && !this.shut) {
      const raw = this.buffer.slice(0, end)
      this.buffer = this.buffer.slice(end + 1)
      end = this.buffer.indexOf("\0")
      let message: Message
      try {
        message = JSON.parse(raw) as Message
      } catch {
        continue
      }
      if (typeof message.id === "number" && this.pending.has(message.id)) {
        const call = this.pending.get(message.id)!
        this.pending.delete(message.id)
        clearTimeout(call.timer)
        if (message.error) call.reject(new Error(message.error.message ?? "browser error"))
        else call.resolve(message.result)
      } else if (message.method) for (const listener of this.listeners) listener(message)
    }
  }

  on(listener: (message: Message) => void) {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** Called once when the pipe closes (at once if it already has). */
  onClose(listener: () => void) {
    if (this.shut) {
      listener()
      return () => false
    }
    this.closers.add(listener)
    return () => this.closers.delete(listener)
  }

  send<T = Record<string, unknown>>(method: string, params: Record<string, unknown> = {}, sessionId?: string, timeoutMs = CALL_MS) {
    if (this.shut) return Promise.reject(new Error("browser pipe closed"))
    const id = this.next++
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new CdpTimeout(`${method} timed out`))
      }, timeoutMs)
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timer })
      this.write(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }) + "\0")
    })
  }

  close() {
    if (this.shut) return
    this.shut = true
    this.buffer = ""
    for (const [, call] of this.pending) {
      clearTimeout(call.timer)
      call.reject(new Error("browser pipe closed"))
    }
    this.pending.clear()
    const closers = [...this.closers]
    this.closers.clear()
    for (const listener of closers) listener()
  }
}

type Context = { id: number; sessionId: string; frameId: string }
/**
 * A page or frame the guard attached to, and how far its setup got: only a finished setup lets the guard answer for it.
 * "stalled" is a setup that timed out on every try and is still being sent; "failed" one the browser refused.
 */
type Session = { sessionId: string; targetId?: string; type: string; setup: "pending" | "done" | "stalled" | "failed"; mainFrame?: string }
/** What a guard world answers: the kind of secret, whether the focus or the point is in this frame, or in a child frame it cannot see into. */
type Answer = { kind?: unknown; here?: unknown; child?: unknown } | undefined

export type GuardOptions = {
  /** How long the guard waits for each of its own commands (a page's setup). */
  callMs?: number
  /** How long the guard waits for its first commands, which go out while the browser starts. */
  startMs?: number
  /** How long a question waits for pages and frames still on their way before it answers "credential". */
  settleMs?: number
}

const contextKey = (context: Context) => `${context.sessionId}:${context.id}`
const isSecret = (kind: unknown): kind is "credential" | "payment_details" => kind === "credential" || kind === "payment_details"

/** The guard's view of the browser: its sessions, the guard's world in each frame, and page loads. */
export class BrowserGuard {
  private readonly sessions = new Map<string, Session>()
  private readonly contexts = new Map<string, Context>()
  /** The pages and frames the browser announced (target discovery), until it says they are gone or detaches them. */
  private readonly targets = new Set<string>()
  /** Sessions the guard never attached to that report a guard world, until they detach. */
  private readonly strangers = new Set<string>()
  /** Questions waiting for a page or frame to come along. */
  private readonly waiters = new Set<() => void>()
  private readonly callMs: number
  private readonly startMs: number
  private readonly settleMs: number
  private loads = 0
  private ready = false
  /** Counts every page, frame, setup or guard world that came or went, so a question knows what it missed. */
  private changes = 0

  constructor(
    private readonly pipe: CdpPipe,
    private readonly source: string,
    options: GuardOptions = {},
  ) {
    this.callMs = options.callMs ?? CALL_MS
    this.startMs = options.startMs ?? START_MS
    this.settleMs = options.settleMs ?? this.callMs
    pipe.on((message) => void this.event(message))
  }

  /** Attaches to every page and frame, now and as they appear, each paused until the guard is in place. */
  async start() {
    await this.pipe.send("Target.setDiscoverTargets", { discover: true }, undefined, this.startMs)
    await this.pipe.send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: true, flatten: true }, undefined, this.startMs)
    this.ready = true
    this.changed()
  }

  /** Top-level page loads since the browser started (the fair-use meter's page loads). */
  pageLoads() {
    return this.loads
  }

  private changed() {
    this.changes++
    for (const waiter of [...this.waiters]) waiter()
  }

  /** Resolves on the next change, or after `ms`. */
  private change(ms: number) {
    return new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer)
        this.waiters.delete(done)
        resolve()
      }
      const timer = setTimeout(done, ms)
      this.waiters.add(done)
    })
  }

  private async event(message: Message) {
    const params = message.params ?? {}
    switch (message.method) {
      case "Target.targetCreated": {
        const info = (params.targetInfo ?? {}) as { targetId?: string; type?: string }
        if (!info.targetId || !GUARDED_TYPES.has(info.type ?? "")) return
        this.targets.add(info.targetId)
        this.changed()
        return
      }
      case "Target.targetDestroyed": {
        const targetId = params.targetId as string | undefined
        if (!targetId) return
        // The page or frame is gone, and with it anything to type into: its sessions go too.
        this.targets.delete(targetId)
        for (const session of [...this.sessions.values()]) if (session.targetId === targetId) this.forget(session.sessionId)
        this.changed()
        return
      }
      case "Target.attachedToTarget": {
        const sessionId = params.sessionId as string
        const info = (params.targetInfo ?? {}) as { targetId?: string; type?: string }
        const type = info.type ?? ""
        if (!GUARDED_TYPES.has(type)) {
          await this.pipe.send("Runtime.runIfWaitingForDebugger", {}, sessionId).catch(() => {})
          return
        }
        // Until its setup is done the guard cannot answer for this page or frame, so a question waits for it.
        const session: Session = { sessionId, type, setup: "pending", ...(info.targetId ? { targetId: info.targetId } : {}) }
        this.sessions.set(sessionId, session)
        this.changed()
        await this.setUp(session)
        return
      }
      case "Target.detachedFromTarget": {
        // The browser let go of the page or frame without destroying it: an out-of-process frame of a page that went into
        // the back/forward cache, or one that moved back into its parent's process. Nothing can be typed into it while it
        // is detached; should it come back, the browser attaches it again and its setup is waited for like a new one's.
        // (A frame without a guard world that still has the focus is caught anyway: its parent reports focus in a child
        // frame that no guard world answers for.)
        const sessionId = params.sessionId as string
        const session = this.sessions.get(sessionId)
        const targetId = (params.targetId as string | undefined) ?? session?.targetId
        if (session && targetId) this.targets.delete(targetId)
        this.forget(sessionId)
        return
      }
      case "Runtime.executionContextCreated": {
        const context = params.context as { id?: number; name?: string; auxData?: { frameId?: string } } | undefined
        if (!message.sessionId || !context || context.name !== GUARD_WORLD || typeof context.id !== "number") return
        if (!this.sessions.has(message.sessionId)) {
          // A guard world in a session the guard never attached to: it cannot answer for that page or frame.
          this.strangers.add(message.sessionId)
          this.changed()
          return
        }
        const recorded = { id: context.id, sessionId: message.sessionId, frameId: context.auxData?.frameId ?? "" }
        this.contexts.set(contextKey(recorded), recorded)
        this.changed()
        return
      }
      case "Runtime.executionContextDestroyed": {
        if (message.sessionId && this.contexts.delete(`${message.sessionId}:${params.executionContextId as number}`)) this.changed()
        return
      }
      case "Runtime.executionContextsCleared": {
        for (const [key, context] of this.contexts) if (context.sessionId === message.sessionId) this.contexts.delete(key)
        this.changed()
        return
      }
      case "Page.frameNavigated": {
        // A page's top frame (the one without a parent); its guard world is what a question waits for.
        const frame = params.frame as { id?: string; parentId?: string } | undefined
        const session = message.sessionId ? this.sessions.get(message.sessionId) : undefined
        if (session?.type === "page" && frame?.id && !frame.parentId && session.mainFrame !== frame.id) {
          session.mainFrame = frame.id
          this.changed()
        }
        return
      }
      case "Page.loadEventFired": {
        const session = message.sessionId ? this.sessions.get(message.sessionId) : undefined
        if (session?.type === "page") this.loads++
        return
      }
    }
  }

  /**
   * Puts the guard in place in a page or frame. The target waits for the debugger until it is told to run. The setup goes
   * out first and the go-ahead right behind it, without waiting for any answer in between: the browser handles one
   * session's commands in order, so the guard's script and the auto-attach are in place before the target runs. Waiting
   * for each answer first can stall the target: while it navigates, the browser holds commands meant for its renderer,
   * and the navigation can itself be held until the go-ahead.
   *
   * A setup that only timed out (a busy renderer) is sent again: the commands are harmless to repeat, and the script
   * keeps its first copy in a document. After `SETUP_TRIES` tries the page or frame is held like a failed one (typing is
   * refused without a wait), but its setup keeps going out, ever less often, while it is there, and it counts once its
   * renderer answers. One that the browser refused leaves the page or frame as one the guard cannot answer for until it
   * goes away. Nothing is thrown, since an event handler that threw would take hostd down with an unhandled rejection.
   */
  private async setUp(session: Session) {
    const { sessionId } = session
    for (let attempt = 1; ; attempt++) {
      const setup = [
        this.pipe.send("Page.enable", {}, sessionId, this.callMs),
        this.pipe.send("Runtime.enable", {}, sessionId, this.callMs),
        this.pipe.send(
          "Page.addScriptToEvaluateOnNewDocument",
          { source: this.source, worldName: GUARD_WORLD, runImmediately: true },
          sessionId,
          this.callMs,
        ),
        this.pipe.send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: true, flatten: true }, sessionId, this.callMs),
      ]
      const tree = this.pipe.send<{ frameTree?: { frame?: { id?: string } } }>("Page.getFrameTree", {}, sessionId, this.callMs)
      const run = attempt === 1 ? this.pipe.send("Runtime.runIfWaitingForDebugger", {}, sessionId, this.callMs).catch(() => {}) : undefined
      const answers = await Promise.allSettled([...setup, tree])
      await run
      // The session went meanwhile (it detached, or its target was destroyed): there is nothing left to set up.
      if (this.sessions.get(sessionId) !== session) return
      const errors = answers.flatMap((answer) => (answer.status === "rejected" ? [answer.reason as unknown] : []))
      if (!errors.length) {
        const frame = (answers[answers.length - 1] as PromiseFulfilledResult<{ frameTree?: { frame?: { id?: string } } }>).value
        const id = frame?.frameTree?.frame?.id
        if (id && !session.mainFrame) session.mainFrame = id
        session.setup = "done"
        this.changed()
        return
      }
      if (!errors.every((error) => error instanceof CdpTimeout)) {
        session.setup = "failed"
        this.changed()
        return
      }
      if (attempt < SETUP_TRIES) continue
      if (session.setup !== "stalled") {
        session.setup = "stalled"
        this.changed()
      }
      await new Promise((resolve) => setTimeout(resolve, Math.min(this.callMs * 2 ** (attempt - SETUP_TRIES), RETRY_MAX_MS)))
      if (this.sessions.get(sessionId) !== session || this.pipe.closed) return
    }
  }

  private forget(sessionId: string) {
    this.sessions.delete(sessionId)
    this.strangers.delete(sessionId)
    for (const [key, context] of this.contexts) if (context.sessionId === sessionId) this.contexts.delete(key)
    this.changed()
  }

  /** Whether a session's top frame has the guard's world. */
  private covered(session: Session) {
    if (!session.mainFrame) return false
    for (const context of this.contexts.values()) if (context.sessionId === session.sessionId && context.frameId === session.mainFrame) return true
    return false
  }

  /**
   * Whether the guard can answer for every page there is: "yes" when it is in place, every page and frame it attached to
   * or the browser announced has a session whose setup is done, every page's top document has the guard's world, and no
   * session it never attached to reports one. "wait" while some are only on their way (setup in flight, announced but
   * not attached yet, a top document's guard world not there yet); "no" when it cannot answer at all.
   */
  private vouch(): "yes" | "wait" | "no" {
    if (!this.ready || this.pipe.closed || this.strangers.size > 0) return "no"
    const guarded = new Set<string>()
    for (const session of this.sessions.values()) if (session.setup === "done") guarded.add(session.targetId ?? session.sessionId)
    let wait = false
    for (const session of this.sessions.values()) {
      if (guarded.has(session.targetId ?? session.sessionId)) continue
      if (session.setup === "failed" || session.setup === "stalled") return "no"
      wait = true
    }
    for (const target of this.targets) if (!guarded.has(target)) wait = true
    // Focus in a page's top document that has no guard world would go unseen (nothing above it reports it), so every
    // page's top document must have one.
    for (const session of this.sessions.values()) if (session.setup === "done" && session.type === "page" && !this.covered(session)) wait = true
    return wait ? "wait" : "yes"
  }

  /** Waits, until `deadline`, for the guard to vouch for every page; false when it cannot. */
  private async settle(deadline: number) {
    for (;;) {
      const state = this.vouch()
      if (state === "yes") return true
      const left = deadline - Date.now()
      if (state === "no" || left <= 0) return false
      await this.change(left)
    }
  }

  private async evaluate(context: Context, expression: string): Promise<unknown> {
    const answer = await this.pipe.send<{ result?: { value?: unknown }; exceptionDetails?: unknown }>(
      "Runtime.evaluate",
      { expression, contextId: context.id, returnByValue: true, awaitPromise: false, silent: true },
      context.sessionId,
      QUERY_MS,
    )
    if (answer.exceptionDetails) throw new Error("guard threw")
    return answer.result?.value
  }

  /**
   * Asks guard worlds. Undefined when one did not answer although it is still there (fail closed); a document that went
   * while it was asked (navigated or closed) is left out, and the change makes the question ask again.
   */
  private async ask(contexts: Context[], expression: string): Promise<Answer[] | undefined> {
    const answers = await Promise.allSettled(contexts.map((context) => this.evaluate(context, expression)))
    const values: Answer[] = []
    for (const [index, answer] of answers.entries()) {
      if (answer.status === "fulfilled") values.push(answer.value as Answer)
      else if (this.contexts.has(contextKey(contexts[index]!))) return undefined
    }
    return values
  }

  /** The guard worlds of the pages' top documents. */
  private tops() {
    return [...this.contexts.values()].filter((context) => {
      const session = this.sessions.get(context.sessionId)
      return session?.type === "page" && session.setup === "done" && (!session.mainFrame || session.mainFrame === context.frameId)
    })
  }

  /**
   * Asks until an answer covers every page and frame there was while it asked, for at most `ROUNDS` rounds and with
   * waits of at most `settleMs` in all. `round` answers a kind, undefined for no secret, or "again" when the field is in
   * a frame no guard world answers for: that may be a document whose guard world is only on its way, so the question
   * waits for a change before it asks again, and answers "credential" when none comes.
   */
  private async question(round: () => Promise<HandoffReason | undefined | "again">): Promise<HandoffReason | undefined> {
    const deadline = Date.now() + this.settleMs
    for (let i = 0; i < ROUNDS; i++) {
      if (!(await this.settle(deadline))) return "credential"
      const changes = this.changes
      const answer = await round()
      if (answer !== "again" && answer !== undefined) return answer
      // Pages, frames or documents that came or went while the guard was asking were not asked: then it asks again.
      if (changes !== this.changes || this.vouch() !== "yes") continue
      if (answer === undefined) return undefined
      const left = deadline - Date.now()
      if (left <= 0) return "credential"
      await this.change(left)
      if (changes === this.changes) return "credential"
    }
    return "credential"
  }

  /**
   * The kind of secret the focused field takes, in any frame, or undefined. Fails closed (see vouch()): when a frame does
   * not answer, or the focus is in a child frame and no guard world reports it as its own (a frame without the guard's
   * world: no script runs there, or its document is only on its way), the answer is "credential".
   */
  async focusedSecret(): Promise<HandoffReason | undefined> {
    return this.question(async () => {
      const answers = await this.ask([...this.contexts.values()], "globalThis.__vectorGuard.focused()")
      if (!answers) return "credential"
      let here = false
      let child = false
      for (const answer of answers) {
        if (isSecret(answer?.kind)) return answer.kind
        if (answer?.here === true) here = true
        if (answer?.child === true) child = true
      }
      return child && !here ? "again" : undefined
    })
  }

  /**
   * The kind of secret the field at a screen point takes, or undefined: what a paste or a drop there would go into (a
   * middle click pastes the selection, a right click opens a menu with Paste, a drag drops). Each page's top document
   * finds the field at the point, looking into its own frames. When the point is on a frame of another process, which
   * the top document cannot see into, every other frame is asked whether it holds a secret field anywhere, and every
   * out-of-process frame must have the guard's world. Fails closed like focusedSecret.
   */
  async pointedSecret(point: Point): Promise<HandoffReason | undefined> {
    const expression = `globalThis.__vectorGuard.pointed(${JSON.stringify(Number(point.x))}, ${JSON.stringify(Number(point.y))})`
    return this.question(async () => {
      const tops = this.tops()
      const answers = await this.ask(tops, expression)
      if (!answers) return "credential"
      let child = false
      for (const answer of answers) {
        if (isSecret(answer?.kind)) return answer.kind
        if (answer?.child === true) child = true
      }
      if (!child) return undefined
      for (const session of this.sessions.values()) if (session.type === "iframe" && !this.covered(session)) return "again"
      const asked = new Set(tops.map(contextKey))
      const frames = [...this.contexts.values()].filter((context) => !asked.has(contextKey(context)))
      const held = await this.ask(frames, "globalThis.__vectorGuard.secrets()")
      if (!held) return "credential"
      for (const answer of held) if (isSecret(answer?.kind)) return answer.kind
      return undefined
    })
  }

  /** CAPTCHA rectangles on the screen, from the top frame of each page the guard is in place in. */
  async captchas(): Promise<Rect[]> {
    const answers = await Promise.allSettled(this.tops().map((context) => this.evaluate(context, "globalThis.__vectorGuard.captchas()")))
    const rects: Rect[] = []
    for (const answer of answers)
      if (answer.status === "fulfilled" && Array.isArray(answer.value))
        for (const rect of answer.value as Rect[])
          if ([rect?.x, rect?.y, rect?.w, rect?.h].every((value) => typeof value === "number" && Number.isFinite(value))) rects.push(rect)
    return rects
  }
}

/** What a guard that is not in place answers: every field is a secret, and no CAPTCHA is known. */
export const GUARD_DOWN: GuardView = Object.freeze({
  focusedSecret: async (): Promise<HandoffReason | undefined> => "credential",
  pointedSecret: async (_point: Point): Promise<HandoffReason | undefined> => "credential",
  captchas: async (): Promise<Rect[]> => [],
})

/**
 * What hostd's computer asks before an action: nothing while no browser runs (there is nothing to guard), the browser's
 * guard once it is in place, and GUARD_DOWN while the browser runs without it (its guard is starting, or did not start).
 */
export function guardView(browserRunning: boolean, guard: BrowserGuard | undefined): GuardView | undefined {
  if (!browserRunning) return undefined
  return guard ?? GUARD_DOWN
}

/** Whether a point falls inside any of the rectangles. */
export function inside(point: Point, rects: readonly Rect[]) {
  return rects.some((rect) => point.x >= rect.x && point.y >= rect.y && point.x < rect.x + rect.w && point.y < rect.y + rect.h)
}
