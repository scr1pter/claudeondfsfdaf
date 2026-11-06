import type { HandoffReason, Point, Rect } from "./actions"

/*
 * hostd's hold on the computer's browser (contract WP A54): the browser's debugging pipe, which only hostd holds (the
 * browser is started with `--remote-debugging-pipe`, so there is no debugging port for the agent or a page to reach).
 * Over it hostd injects image/credential-guard.js into an isolated world of every frame, counts top-level page loads for
 * the fair-use meter (WP A53), and asks the guard, before each agent action, whether the focused field is a credential
 * field and where CAPTCHA challenges are. When the guard cannot answer in time, typing is refused: the guard fails
 * closed.
 */

export const GUARD_WORLD = "vector-guard"
const CALL_MS = 5_000
const QUERY_MS = 1_500

type Message = { id?: number; method?: string; params?: Record<string, unknown>; result?: unknown; error?: { message?: string }; sessionId?: string }

/** The browser's debugging protocol over its pipe: messages are JSON, each ended by a NUL byte. */
export class CdpPipe {
  private next = 1
  private buffer = ""
  private readonly pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>()
  private readonly listeners = new Set<(message: Message) => void>()
  private closed = false

  constructor(private readonly write: (chunk: string) => void) {}

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
    if (this.closed) return Promise.reject(new Error("browser pipe closed"))
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
    this.closed = true
    for (const [, call] of this.pending) {
      clearTimeout(call.timer)
      call.reject(new Error("browser pipe closed"))
    }
    this.pending.clear()
  }
}

type Context = { id: number; sessionId: string; frameId: string }
type Session = { sessionId: string; type: string; mainFrame?: string }

/** The guard's view of the browser: its sessions, the guard's world in each frame, and page loads. */
export class BrowserGuard {
  private readonly sessions = new Map<string, Session>()
  private readonly contexts = new Map<string, Context>()
  private loads = 0
  private ready = false

  constructor(
    private readonly pipe: CdpPipe,
    private readonly source: string,
  ) {
    pipe.on((message) => void this.event(message))
  }

  /** Attaches to every page and frame, now and as they appear, each paused until the guard is in place. */
  async start() {
    await this.pipe.send("Target.setDiscoverTargets", { discover: true })
    await this.pipe.send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: true, flatten: true })
    this.ready = true
  }

  /** Top-level page loads since the browser started (the fair-use meter's page loads). */
  pageLoads() {
    return this.loads
  }

  private async event(message: Message) {
    const params = message.params ?? {}
    switch (message.method) {
      case "Target.attachedToTarget": {
        const sessionId = params.sessionId as string
        const info = (params.targetInfo ?? {}) as { type?: string }
        const type = info.type ?? ""
        if (type !== "page" && type !== "iframe") {
          await this.pipe.send("Runtime.runIfWaitingForDebugger", {}, sessionId).catch(() => {})
          return
        }
        this.sessions.set(sessionId, { sessionId, type })
        try {
          await this.pipe.send("Page.enable", {}, sessionId)
          await this.pipe.send("Runtime.enable", {}, sessionId)
          await this.pipe.send(
            "Page.addScriptToEvaluateOnNewDocument",
            { source: this.source, worldName: GUARD_WORLD, runImmediately: true },
            sessionId,
          )
          await this.pipe.send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: true, flatten: true }, sessionId)
          const tree = await this.pipe.send<{ frameTree?: { frame?: { id?: string } } }>("Page.getFrameTree", {}, sessionId)
          const session = this.sessions.get(sessionId)
          if (session && tree.frameTree?.frame?.id) session.mainFrame = tree.frameTree.frame.id
        } finally {
          await this.pipe.send("Runtime.runIfWaitingForDebugger", {}, sessionId).catch(() => {})
        }
        return
      }
      case "Target.detachedFromTarget": {
        const sessionId = params.sessionId as string
        this.sessions.delete(sessionId)
        for (const [key, context] of this.contexts) if (context.sessionId === sessionId) this.contexts.delete(key)
        return
      }
      case "Runtime.executionContextCreated": {
        const context = params.context as { id?: number; name?: string; auxData?: { frameId?: string } } | undefined
        if (!message.sessionId || !context || context.name !== GUARD_WORLD || typeof context.id !== "number") return
        this.contexts.set(`${message.sessionId}:${context.id}`, {
          id: context.id,
          sessionId: message.sessionId,
          frameId: context.auxData?.frameId ?? "",
        })
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
   * The kind of secret the focused field takes, in any frame, or undefined. Fails closed: when the guard is not in
   * place or a frame does not answer, the answer is "credential".
   */
  async focusedSecret(): Promise<HandoffReason | undefined> {
    if (!this.ready) return "credential"
    const answers = await Promise.allSettled(
      [...this.contexts.values()].map((context) => this.evaluate(context, "globalThis.__vectorGuard.focused()")),
    )
    for (const answer of answers) {
      if (answer.status === "rejected") return "credential"
      const kind = (answer.value as { kind?: unknown } | undefined)?.kind
      if (kind === "credential" || kind === "payment_details") return kind
    }
    return undefined
  }

  /** CAPTCHA rectangles on the screen, from the top frame of each page. */
  async captchas(): Promise<Rect[]> {
    const tops = [...this.contexts.values()].filter((context) => {
      const session = this.sessions.get(context.sessionId)
      return session?.type === "page" && (!session.mainFrame || session.mainFrame === context.frameId)
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

/** Whether a point falls inside any of the rectangles. */
export function inside(point: Point, rects: readonly Rect[]) {
  return rects.some((rect) => point.x >= rect.x && point.y >= rect.y && point.x < rect.x + rect.w && point.y < rect.y + rect.h)
}
