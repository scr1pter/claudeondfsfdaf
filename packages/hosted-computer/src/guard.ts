import type { HandoffReason, Point, Rect } from "./actions"
import type { GuardView } from "./computer"

/*
 * hostd's hold on the computer's browser (contract WP A54): the browser's debugging pipe, which only hostd holds (the
 * browser is started with `--remote-debugging-pipe`, so there is no debugging port for the agent or a page to reach).
 * Over it hostd injects image/credential-guard.js into an isolated world of every frame, counts top-level page loads for
 * the fair-use meter (WP A53), and asks the guard, before each agent action, whether the focused field is a credential
 * field and where CAPTCHA challenges are. The guard fails closed: whenever it cannot answer for every page and frame in
 * time, the focused field counts as a credential field and typing is refused. It cannot answer while it is not in place
 * (not started, or its pipe closed), for a page or frame whose setup is still in flight or failed, for a page or frame
 * the browser announced that it never attached to (or whose session went while the browser still lists it), and for a
 * session it never attached to that reports a guard world.
 */

export const GUARD_WORLD = "vector-guard"
const CALL_MS = 5_000
const QUERY_MS = 1_500
/** How often the guard asks again when pages, frames or documents appeared while it was asking. */
const ROUNDS = 3
/** The targets the guard is put into; other targets (workers) are only let run. */
const GUARDED_TYPES = new Set(["page", "iframe"])

type Message = { id?: number; method?: string; params?: Record<string, unknown>; result?: unknown; error?: { message?: string }; sessionId?: string }

/** The browser's debugging protocol over its pipe: messages are JSON, each ended by a NUL byte. */
export class CdpPipe {
  private next = 1
  private buffer = ""
  private readonly pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>()
  private readonly listeners = new Set<(message: Message) => void>()
  private shut = false

  constructor(private readonly write: (chunk: string) => void) {}

  /** Whether the pipe is closed (the browser went away, or a message grew too large): nothing more goes through it. */
  get closed() {
    return this.shut
  }

  /** Bytes from the browser (its fd 4). */
  feed(chunk: string | Uint8Array) {
    this.buffer += typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk)
    // A single message is never allowed to grow without bound.
    if (this.buffer.length > 64 * 1024 * 1024) return this.close()
    let end = this.buffer.indexOf("\0")
    while (end >= 0) {
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

  send<T = Record<string, unknown>>(method: string, params: Record<string, unknown> = {}, sessionId?: string, timeoutMs = CALL_MS) {
    if (this.shut) return Promise.reject(new Error("browser pipe closed"))
    const id = this.next++
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`${method} timed out`))
      }, timeoutMs)
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timer })
      this.write(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }) + "\0")
    })
  }

  close() {
    this.shut = true
    for (const [, call] of this.pending) {
      clearTimeout(call.timer)
      call.reject(new Error("browser pipe closed"))
    }
    this.pending.clear()
  }
}

type Context = { id: number; sessionId: string; frameId: string }
/** A page or frame the guard attached to, and how far its setup got: only a finished setup lets the guard answer for it. */
type Session = { sessionId: string; targetId?: string; type: string; setup: "pending" | "done" | "failed"; mainFrame?: string }

export type GuardOptions = {
  /** How long the guard waits for each of its own commands (start and a page's setup). */
  callMs?: number
}

/** The guard's view of the browser: its sessions, the guard's world in each frame, and page loads. */
export class BrowserGuard {
  private readonly sessions = new Map<string, Session>()
  private readonly contexts = new Map<string, Context>()
  /** The pages and frames the browser announced (target discovery), until it says they are gone. */
  private readonly targets = new Set<string>()
  /** Sessions the guard never attached to that report a guard world, until they detach. */
  private readonly strangers = new Set<string>()
  private readonly callMs: number
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
    pipe.on((message) => void this.event(message))
  }

  /** Attaches to every page and frame, now and as they appear, each paused until the guard is in place. */
  async start() {
    await this.pipe.send("Target.setDiscoverTargets", { discover: true }, undefined, this.callMs)
    await this.pipe.send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: true, flatten: true }, undefined, this.callMs)
    this.ready = true
  }

  /** Top-level page loads since the browser started (the fair-use meter's page loads). */
  pageLoads() {
    return this.loads
  }

  private async event(message: Message) {
    const params = message.params ?? {}
    switch (message.method) {
      case "Target.targetCreated": {
        const info = (params.targetInfo ?? {}) as { targetId?: string; type?: string }
        if (!info.targetId || !GUARDED_TYPES.has(info.type ?? "")) return
        this.targets.add(info.targetId)
        this.changes++
        return
      }
      case "Target.targetDestroyed": {
        const targetId = params.targetId as string | undefined
        if (!targetId) return
        // The page or frame is gone, and with it anything to type into: its sessions go too.
        this.targets.delete(targetId)
        for (const session of [...this.sessions.values()]) if (session.targetId === targetId) this.forget(session.sessionId)
        this.changes++
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
        // Until its setup is done the guard cannot answer for this page or frame, so typing is refused meanwhile.
        const session: Session = { sessionId, type, setup: "pending", ...(info.targetId ? { targetId: info.targetId } : {}) }
        this.sessions.set(sessionId, session)
        this.changes++
        // The target waits for the debugger until it is told to run. The setup goes out first and the go-ahead right
        // behind it, without waiting for any answer in between: the browser handles one session's commands in order, so
        // the guard's script and the auto-attach are in place before the target runs. Waiting for each answer first can
        // stall the target: while it navigates, the browser holds commands meant for its renderer, and the navigation
        // can itself be held until the go-ahead, so the guard sat out its call timeout (the image check's Page.navigate
        // timed out behind it) and then gave up on the page.
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
        const run = this.pipe.send("Runtime.runIfWaitingForDebugger", {}, sessionId, this.callMs).catch(() => {})
        const [answers, frameTree] = await Promise.all([Promise.allSettled(setup), tree.catch(() => undefined)])
        await run
        // The session went meanwhile (it detached, or its target was destroyed): there is nothing left to set up.
        if (this.sessions.get(sessionId) !== session) return
        this.changes++
        if (answers.some((answer) => answer.status === "rejected")) {
          // The guard is not in place in this page or frame: a setup command failed ("Session with given id not found")
          // or timed out. It is kept as one the guard cannot answer for, so typing stays refused until it goes away;
          // nothing is thrown, since an event handler that threw would take hostd down with an unhandled rejection.
          session.setup = "failed"
          return
        }
        const frame = frameTree?.frameTree?.frame?.id
        if (frame) session.mainFrame = frame
        session.setup = "done"
        return
      }
      case "Target.detachedFromTarget": {
        // A page or frame the browser still lists stays one the guard cannot answer for until the browser says it is gone.
        this.forget(params.sessionId as string)
        return
      }
      case "Runtime.executionContextCreated": {
        const context = params.context as { id?: number; name?: string; auxData?: { frameId?: string } } | undefined
        if (!message.sessionId || !context || context.name !== GUARD_WORLD || typeof context.id !== "number") return
        if (!this.sessions.has(message.sessionId)) {
          // A guard world in a session the guard never attached to: it cannot answer for that page or frame.
          this.strangers.add(message.sessionId)
          this.changes++
          return
        }
        this.contexts.set(`${message.sessionId}:${context.id}`, {
          id: context.id,
          sessionId: message.sessionId,
          frameId: context.auxData?.frameId ?? "",
        })
        this.changes++
        return
      }
      case "Runtime.executionContextDestroyed": {
        if (message.sessionId) this.contexts.delete(`${message.sessionId}:${params.executionContextId as number}`)
        return
      }
      case "Runtime.executionContextsCleared": {
        for (const [key, context] of this.contexts) if (context.sessionId === message.sessionId) this.contexts.delete(key)
        return
      }
      case "Page.loadEventFired": {
        const session = message.sessionId ? this.sessions.get(message.sessionId) : undefined
        if (session?.type === "page") this.loads++
        return
      }
    }
  }

  private forget(sessionId: string) {
    this.sessions.delete(sessionId)
    this.strangers.delete(sessionId)
    for (const [key, context] of this.contexts) if (context.sessionId === sessionId) this.contexts.delete(key)
    this.changes++
  }

  /**
   * Whether the guard can answer for every page and frame there is: it is in place, every page and frame it attached
   * to or the browser announced has a session whose setup is done, and no session it never attached to reports a guard
   * world.
   */
  private vouches() {
    if (!this.ready || this.pipe.closed || this.strangers.size > 0) return false
    const guarded = new Set<string>()
    for (const session of this.sessions.values()) if (session.setup === "done") guarded.add(session.targetId ?? session.sessionId)
    for (const session of this.sessions.values()) if (!guarded.has(session.targetId ?? session.sessionId)) return false
    for (const target of this.targets) if (!guarded.has(target)) return false
    return true
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
   * The kind of secret the focused field takes, in any frame, or undefined. Fails closed: when the guard cannot answer
   * for every page and frame (see vouches()), or a frame does not answer, the answer is "credential".
   */
  async focusedSecret(): Promise<HandoffReason | undefined> {
    for (let round = 0; round < ROUNDS; round++) {
      if (!this.vouches()) return "credential"
      const changes = this.changes
      const answers = await Promise.allSettled(
        [...this.contexts.values()].map((context) => this.evaluate(context, "globalThis.__vectorGuard.focused()")),
      )
      for (const answer of answers) {
        if (answer.status === "rejected") return "credential"
        const kind = (answer.value as { kind?: unknown } | undefined)?.kind
        if (kind === "credential" || kind === "payment_details") return kind
      }
      // Pages, frames or documents that came while the guard was asking were not asked: then it asks again.
      if (changes === this.changes && this.vouches()) return undefined
    }
    return "credential"
  }

  /** CAPTCHA rectangles on the screen, from the top frame of each page the guard is in place in. */
  async captchas(): Promise<Rect[]> {
    const tops = [...this.contexts.values()].filter((context) => {
      const session = this.sessions.get(context.sessionId)
      return session?.type === "page" && session.setup === "done" && (!session.mainFrame || session.mainFrame === context.frameId)
    })
    const answers = await Promise.allSettled(tops.map((context) => this.evaluate(context, "globalThis.__vectorGuard.captchas()")))
    const rects: Rect[] = []
    for (const answer of answers)
      if (answer.status === "fulfilled" && Array.isArray(answer.value))
        for (const rect of answer.value as Rect[])
          if ([rect?.x, rect?.y, rect?.w, rect?.h].every((value) => typeof value === "number" && Number.isFinite(value))) rects.push(rect)
    return rects
  }
}

/** What a guard that is not in place answers: every focused field is a secret, and no CAPTCHA is known. */
export const GUARD_DOWN: GuardView = Object.freeze({
  focusedSecret: async (): Promise<HandoffReason | undefined> => "credential",
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
