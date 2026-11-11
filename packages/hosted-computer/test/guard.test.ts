import { afterEach, describe, expect, test } from "bun:test"
import { BrowserGuard, CdpPipe, GUARD_DOWN, GUARD_WORLD, guardView, type GuardOptions } from "../src/guard"

// WP A54: hostd's credential guard attaches to every page and frame while it waits for the debugger, puts its script in
// place and lets it run. A browser holds the commands meant for a waiting target's renderer while the target navigates,
// and the navigation can itself wait for the go-ahead, so the guard must send the go-ahead without first waiting for
// the answers to its setup. The stand-in browser below answers those commands only once the target runs.
//
// The guard fails closed: whenever it cannot answer for a page or frame (its setup failed or timed out on every try, a
// session it never attached to reports a guard world, the focus or the point is in a frame no guard world answers for,
// or the guard itself is not in place), the field counts as a credential field, so hostd refuses to type. A page or
// frame that is only on its way (setup in flight, announced but not attached yet, its top document's guard world not
// there yet) is waited for, for a bounded time, before the guard answers.

const RENDERER = new Set(["Page.enable", "Runtime.enable", "Page.addScriptToEvaluateOnNewDocument", "Page.getFrameTree", "Runtime.evaluate"])
const GONE = "Session with given id not found."

type Sent = { id: number; method: string; params: Record<string, unknown>; sessionId?: string }
type Options = {
  /** Commands the browser answers with an error. */
  fail?: (message: Sent) => boolean
  /** Commands the browser never answers. */
  silent?: (message: Sent) => boolean
  /** Sessions whose target does not run on the go-ahead, only on release(). */
  stall?: (sessionId: string) => boolean
  /** How long the browser takes to answer a command (default 1 ms). */
  delay?: (message: Sent) => number
}

const pipes: CdpPipe[] = []
afterEach(() => {
  for (const pipe of pipes.splice(0)) pipe.close()
})

function standIn(options: Options = {}) {
  const sent: Sent[] = []
  const waiting = new Set<string>()
  const detached = new Set<string>()
  const held: Sent[] = []
  // What each guard world answers (by context id): by default, what its focused field takes.
  const focus = {
    kind: (_context: number): string | null => "credential",
    value: undefined as ((context: number, expression: string) => unknown) | undefined,
  }
  const listeners: ((message: Sent) => void)[] = []
  const reply = (message: Sent, body: Record<string, unknown>) =>
    setTimeout(() => pipe.feed(JSON.stringify({ id: message.id, ...body }) + "\0"), options.delay?.(message) ?? 1)
  const answer = (message: Sent) => {
    if (options.silent?.(message)) return
    if (options.fail?.(message) || (message.sessionId && detached.has(message.sessionId))) return reply(message, { error: { message: GONE } })
    const context = message.params.contextId as number
    const expression = message.params.expression as string
    const result =
      message.method === "Page.getFrameTree"
        ? { frameTree: { frame: { id: "main" } } }
        : message.method === "Runtime.evaluate"
          ? { result: { value: focus.value ? focus.value(context, expression) : { kind: focus.kind(context) } } }
          : {}
    reply(message, { result })
  }
  const release = (sessionId: string) => {
    waiting.delete(sessionId)
    for (const message of held.filter((later) => later.sessionId === sessionId)) {
      held.splice(held.indexOf(message), 1)
      answer(message)
    }
  }
  const pipe = new CdpPipe((chunk) => {
    for (const raw of chunk.split("\0").filter(Boolean)) {
      const message = JSON.parse(raw) as Sent
      sent.push(message)
      for (const listener of listeners) listener(message)
      const session = message.sessionId
      const run = message.method === "Runtime.runIfWaitingForDebugger"
      if (session && waiting.has(session) && (run ? options.stall?.(session) : RENDERER.has(message.method))) held.push(message)
      else if (run && session) {
        answer(message)
        release(session)
      } else answer(message)
    }
  })
  pipes.push(pipe)
  const event = (method: string, params: Record<string, unknown>, sessionId?: string) =>
    pipe.feed(JSON.stringify({ method, params, ...(sessionId ? { sessionId } : {}) }) + "\0")
  const attach = (sessionId: string, type: string, targetId?: string) => {
    waiting.add(sessionId)
    event("Target.attachedToTarget", { sessionId, targetInfo: { type, ...(targetId ? { targetId } : {}) }, waitingForDebugger: true })
  }
  /** The browser lists a new target (target discovery). */
  const announce = (targetId: string, type: string) => event("Target.targetCreated", { targetInfo: { targetId, type } })
  /** The browser says a target is gone. */
  const destroy = (targetId: string) => event("Target.targetDestroyed", { targetId })
  /** The session goes: whatever the browser still held for it fails, as every later command does. */
  const detach = (sessionId: string, targetId?: string) => {
    detached.add(sessionId)
    event("Target.detachedFromTarget", { sessionId, ...(targetId ? { targetId } : {}) })
    release(sessionId)
  }
  /** The guard's world in a frame of the session (its top frame unless told otherwise). */
  const world = (sessionId: string, id: number, frameId = "main") =>
    event("Runtime.executionContextCreated", { context: { id, name: GUARD_WORLD, auxData: { frameId } } }, sessionId)
  const until = async (done: () => boolean | Promise<boolean>) => {
    for (let i = 0; i < 200 && !(await done()); i++) await new Promise((resolve) => setTimeout(resolve, 5))
    expect(await done()).toBe(true)
  }
  const asked = (sessionId: string) => sent.some((message) => message.sessionId === sessionId && message.method === "Runtime.evaluate")
  const count = (sessionId: string, method: string) => sent.filter((message) => message.sessionId === sessionId && message.method === method).length
  return { pipe, sent, waiting, focus, listeners, attach, announce, destroy, detach, release, world, event, until, asked, count }
}

const settle = (ms = 25) => new Promise((resolve) => setTimeout(resolve, ms))

/** Whether a promise is still unsettled after `ms`. */
async function open(promise: Promise<unknown>, ms = 40) {
  let done = false
  void promise.then(
    () => (done = true),
    () => (done = true),
  )
  await settle(ms)
  return !done
}

/** A started guard with one page it is in place in, whose focused field is an ordinary one. */
async function guarded(options: Options = {}, guardOptions: GuardOptions = {}) {
  const browser = standIn(options)
  const guard = new BrowserGuard(browser.pipe, "/* guard */", guardOptions)
  await guard.start()
  browser.focus.kind = () => null
  browser.announce("T1", "page")
  browser.attach("S1", "page", "T1")
  browser.world("S1", 7)
  await browser.until(async () => (await guard.focusedSecret()) === undefined)
  return { browser, guard }
}

describe("the credential guard", () => {
  test("lets a waiting page run right behind its setup, without waiting for the answers in between", async () => {
    const browser = standIn()
    const guard = new BrowserGuard(browser.pipe, "/* guard */")
    await guard.start()
    const started = Date.now()
    browser.attach("S1", "page")
    await browser.until(() => !browser.waiting.has("S1"))
    const page = browser.sent.filter((message) => message.sessionId === "S1").map((message) => message.method)
    expect(page).toEqual([
      "Page.enable",
      "Runtime.enable",
      "Page.addScriptToEvaluateOnNewDocument",
      "Target.setAutoAttach",
      "Page.getFrameTree",
      "Runtime.runIfWaitingForDebugger",
    ])
    expect(browser.sent.find((message) => message.method === "Page.addScriptToEvaluateOnNewDocument")?.params).toEqual({
      source: "/* guard */",
      worldName: GUARD_WORLD,
      runImmediately: true,
    })
    expect(browser.sent.find((message) => message.sessionId === "S1" && message.method === "Target.setAutoAttach")?.params).toEqual({
      autoAttach: true,
      waitForDebuggerOnStart: true,
      flatten: true,
    })
    // The guard is in place: its world answers for the page, well inside the guard's own call timeout.
    browser.world("S1", 7)
    await browser.until(async () => (await guard.focusedSecret()) === "credential" && browser.asked("S1"))
    expect(Date.now() - started).toBeLessThan(1_000)
  })

  test("other targets (workers) are only let run, and do not count as pages it must answer for", async () => {
    const { browser, guard } = await guarded()
    browser.announce("W1", "service_worker")
    browser.attach("W1S", "service_worker", "W1")
    await browser.until(() => !browser.waiting.has("W1S"))
    expect(browser.sent.filter((message) => message.sessionId === "W1S").map((message) => message.method)).toEqual(["Runtime.runIfWaitingForDebugger"])
    expect(await guard.focusedSecret()).toBeUndefined()
  })

  test("while a page's setup is in flight, a question waits for it and answers once it is in place", async () => {
    const { browser, guard } = await guarded({ stall: (sessionId) => sessionId === "S4" })
    browser.announce("T4", "page")
    browser.attach("S4", "page", "T4")
    // The go-ahead went out right behind the setup; nothing has been answered yet.
    expect(browser.sent.filter((message) => message.sessionId === "S4").map((message) => message.method)).toEqual([
      "Page.enable",
      "Runtime.enable",
      "Page.addScriptToEvaluateOnNewDocument",
      "Target.setAutoAttach",
      "Page.getFrameTree",
      "Runtime.runIfWaitingForDebugger",
    ])
    // A page that is only loading does not make the question answer "credential": it waits for the page's setup.
    const question = guard.focusedSecret()
    expect(await open(question)).toBe(true)
    browser.release("S4")
    browser.world("S4", 11)
    expect(await question).toBeUndefined()
    expect(browser.asked("S4")).toBe(true)
  })

  test("a page whose setup is still in flight when the wait runs out counts as a credential field", async () => {
    const { browser, guard } = await guarded({ stall: (sessionId) => sessionId === "S4" }, { settleMs: 60 })
    browser.announce("T4", "page")
    browser.attach("S4", "page", "T4")
    expect(await guard.focusedSecret()).toBe("credential")
    expect(await guard.pointedSecret({ x: 10, y: 10 })).toBe("credential")
  })

  test("a page whose setup fails still runs, and typing stays refused until it goes away", async () => {
    const { browser, guard } = await guarded({ fail: (message) => message.sessionId === "S2" && message.method === "Runtime.enable" })
    browser.announce("T2", "page")
    browser.attach("S2", "page", "T2")
    await browser.until(() => !browser.waiting.has("S2"))
    await settle()
    // A failed setup is not waited for: the answer comes at once.
    const started = Date.now()
    expect(await guard.focusedSecret()).toBe("credential")
    expect(Date.now() - started).toBeLessThan(500)
    // Not dropped as if it were gone: even when a guard world turns up in it, the guard cannot vouch for that page, so
    // it neither takes its answer nor asks it for CAPTCHAs.
    browser.world("S2", 9)
    expect(await guard.focusedSecret()).toBe("credential")
    expect(await guard.captchas()).toEqual([])
    expect(browser.asked("S2")).toBe(false)
    // Once the browser says the page is gone, the guard answers for the pages left.
    browser.destroy("T2")
    expect(await guard.focusedSecret()).toBeUndefined()
  })

  test("a setup that only timed out is sent again, and the page counts once it answers", async () => {
    let first = true
    const { browser, guard } = await guarded(
      {
        silent: (message) => {
          if (message.sessionId !== "S3" || message.method !== "Page.addScriptToEvaluateOnNewDocument" || !first) return false
          first = false
          return true
        },
      },
      { callMs: 80, settleMs: 1_000 },
    )
    browser.announce("T3", "page")
    browser.attach("S3", "page", "T3")
    browser.world("S3", 13)
    // The question waits through the slow setup and its second try instead of answering "credential".
    expect(await guard.focusedSecret()).toBeUndefined()
    expect(browser.asked("S3")).toBe(true)
    expect(browser.count("S3", "Page.addScriptToEvaluateOnNewDocument")).toBe(2)
    expect(browser.count("S3", "Runtime.runIfWaitingForDebugger")).toBe(1)
  })

  test("a setup that times out on every try is held like a failed one", async () => {
    const { browser, guard } = await guarded(
      { silent: (message) => message.sessionId === "S3" && message.method === "Page.addScriptToEvaluateOnNewDocument" },
      { callMs: 50 },
    )
    browser.announce("T3", "page")
    browser.attach("S3", "page", "T3")
    await browser.until(() => !browser.waiting.has("S3"))
    expect(await guard.focusedSecret()).toBe("credential")
    // Past its tries the setup has failed; typing is still refused, now without waiting.
    await settle(200)
    expect(browser.count("S3", "Page.addScriptToEvaluateOnNewDocument")).toBe(3)
    expect(await guard.focusedSecret()).toBe("credential")
    expect(browser.asked("S3")).toBe(false)
    browser.destroy("T3")
    expect(await guard.focusedSecret()).toBeUndefined()
  })

  test("a page or frame the browser detaches without destroying it stops counting", async () => {
    // An out-of-process frame of a page that went into the back/forward cache: the browser detaches it and destroys it
    // only when the cache lets the page go, minutes later.
    const { browser, guard } = await guarded()
    browser.announce("T5", "iframe")
    browser.attach("S5", "iframe", "T5")
    browser.world("S5", 21)
    await browser.until(async () => (await guard.focusedSecret()) === undefined && browser.asked("S5"))
    browser.detach("S5", "T5")
    const started = Date.now()
    expect(await guard.focusedSecret()).toBeUndefined()
    expect(Date.now() - started).toBeLessThan(500)
    // The same for one that detaches mid-setup.
    const stalled = await guarded({ stall: (sessionId) => sessionId === "S6" })
    stalled.browser.announce("T6", "iframe")
    stalled.browser.attach("S6", "iframe", "T6")
    stalled.browser.detach("S6", "T6")
    await settle()
    expect(stalled.browser.count("S6", "Runtime.runIfWaitingForDebugger")).toBe(1)
    expect(await stalled.guard.focusedSecret()).toBeUndefined()
    // Should the frame come back, the browser attaches it again and its setup is waited for like a new one's.
    stalled.browser.attach("S6b", "iframe", "T6")
    stalled.browser.world("S6b", 22)
    expect(await stalled.guard.focusedSecret()).toBeUndefined()
    expect(stalled.browser.asked("S6b")).toBe(true)
  })

  test("pages and frames the guard never attached to (unknown targets) are refused", async () => {
    const { browser, guard } = await guarded({}, { settleMs: 60 })
    // A frame the browser lists that was never attached: waited for, then refused.
    browser.announce("T6", "iframe")
    expect(await guard.focusedSecret()).toBe("credential")
    browser.destroy("T6")
    expect(await guard.focusedSecret()).toBeUndefined()
    // A page the browser lists that was never attached.
    browser.announce("T8", "page")
    expect(await guard.focusedSecret()).toBe("credential")
    browser.destroy("T8")
    expect(await guard.focusedSecret()).toBeUndefined()
    // A guard world reported by a session the guard never attached to: its answer is not taken.
    browser.world("S404", 3)
    expect(await guard.focusedSecret()).toBe("credential")
    expect(browser.asked("S404")).toBe(false)
    browser.detach("S404")
    expect(await guard.focusedSecret()).toBeUndefined()
  })

  test("a page announced while the guard is asked is waited for until it is attached and set up", async () => {
    const { browser, guard } = await guarded()
    // A new tab (ctrl+t), then typing into its address bar right away.
    browser.announce("T9", "page")
    const question = guard.focusedSecret()
    expect(await open(question)).toBe(true)
    browser.attach("S9", "page", "T9")
    browser.world("S9", 31)
    expect(await question).toBeUndefined()
  })

  test("a page's top document without the guard's world is waited for (a navigation), then refused", async () => {
    const { browser, guard } = await guarded({}, { settleMs: 80 })
    // The old document went; the new one's guard world is not there yet.
    browser.event("Runtime.executionContextsCleared", {}, "S1")
    const question = guard.focusedSecret()
    expect(await open(question, 20)).toBe(true)
    browser.world("S1", 8)
    expect(await question).toBeUndefined()
    // A document where no script runs (scripting off) never gets the guard's world: refused once the wait runs out.
    browser.event("Runtime.executionContextDestroyed", { executionContextId: 8 }, "S1")
    expect(await guard.focusedSecret()).toBe("credential")
    // The top frame is what counts: a guard world of a child frame does not stand in for it.
    browser.world("S1", 9, "child")
    expect(await guard.focusedSecret()).toBe("credential")
    browser.world("S1", 10)
    expect(await guard.focusedSecret()).toBeUndefined()
    // A page whose top frame changes waits for the new top frame's guard world.
    browser.event("Page.frameNavigated", { frame: { id: "main2" } }, "S1")
    expect(await guard.focusedSecret()).toBe("credential")
    browser.world("S1", 11, "main2")
    expect(await guard.focusedSecret()).toBeUndefined()
  })

  test("focus in a child frame that no guard world answers for counts as a credential field", async () => {
    const { browser, guard } = await guarded({}, { settleMs: 80 })
    // The top document's focus is on a frame of another process.
    browser.focus.value = (context) => (context === 7 ? { kind: null, child: true } : { kind: null })
    expect(await guard.focusedSecret()).toBe("credential")
    // Once that frame's own guard world says the focus is its own, its answer is the answer.
    browser.announce("T10", "iframe")
    browser.attach("S10", "iframe", "T10")
    browser.world("S10", 41)
    browser.focus.value = (context) => (context === 7 ? { kind: null, child: true } : context === 41 ? { kind: null, here: true } : { kind: null })
    expect(await guard.focusedSecret()).toBeUndefined()
    browser.focus.value = (context) => (context === 7 ? { kind: null, child: true } : context === 41 ? { kind: "credential", here: true } : { kind: null })
    expect(await guard.focusedSecret()).toBe("credential")
    browser.focus.value = (context) => (context === 41 ? { kind: null, here: true } : { kind: null })
    expect(await guard.focusedSecret()).toBeUndefined()
  })

  test("a world that does not answer fails closed; one whose document went while it was asked is left out", async () => {
    let broken = 0
    const { browser, guard } = await guarded({
      fail: (message) => message.method === "Runtime.evaluate" && message.params.contextId === broken,
    })
    browser.world("S1", 14, "child")
    broken = 14
    expect(await guard.focusedSecret()).toBe("credential")
    // The child frame navigates while it is asked: its old world goes, and the question asks the worlds there are.
    browser.listeners.push((message) => {
      if (message.method === "Runtime.evaluate" && message.params.contextId === 14)
        browser.event("Runtime.executionContextDestroyed", { executionContextId: 14 }, "S1")
    })
    expect(await guard.focusedSecret()).toBeUndefined()
  })

  test("the field at a point: asked of the pages' top documents, and of every frame when it is on another process's frame", async () => {
    const { browser, guard } = await guarded({}, { settleMs: 80 })
    const expressions: string[] = []
    browser.focus.value = (_context, expression) => {
      expressions.push(expression)
      return expression.includes("pointed") ? { kind: "credential", here: true } : { kind: null }
    }
    expect(await guard.pointedSecret({ x: 100, y: 200 })).toBe("credential")
    expect(expressions).toContain("globalThis.__vectorGuard.pointed(100, 200)")
    browser.focus.value = () => ({ kind: null, here: true })
    expect(await guard.pointedSecret({ x: 100, y: 200 })).toBeUndefined()
    // On a frame of another process: every other frame says whether it holds a secret field anywhere.
    browser.announce("T11", "iframe")
    browser.attach("S11", "iframe", "T11")
    browser.world("S11", 51)
    let held: string | null = null
    browser.focus.value = (context, expression) =>
      expression.includes("pointed") ? (context === 7 ? { kind: null, child: true } : { kind: null }) : { kind: held }
    expect(await guard.pointedSecret({ x: 5, y: 5 })).toBeUndefined()
    expect(browser.sent.some((message) => message.sessionId === "S11" && String(message.params.expression).includes("secrets()"))).toBe(true)
    held = "payment_details"
    expect(await guard.pointedSecret({ x: 5, y: 5 })).toBe("payment_details")
    // An out-of-process frame without the guard's world cannot say: refused.
    held = null
    browser.event("Runtime.executionContextDestroyed", { executionContextId: 51 }, "S11")
    expect(await guard.pointedSecret({ x: 5, y: 5 })).toBe("credential")
  })

  test("a document that appears while the guard is asking is asked too", async () => {
    const { browser, guard } = await guarded()
    // A new document with a focused password field comes up in the page while the guard asks the old one.
    browser.focus.kind = (context) => (context === 12 ? "credential" : null)
    let once = true
    browser.listeners.push((message) => {
      if (message.method !== "Runtime.evaluate" || !once) return
      once = false
      browser.world("S1", 12)
    })
    expect(await guard.focusedSecret()).toBe("credential")
  })

  test("a guard that is down refuses typing: not started, failed to start, or its pipe closed", async () => {
    // Not started.
    const idle = standIn()
    expect(await new BrowserGuard(idle.pipe, "").focusedSecret()).toBe("credential")
    expect(idle.sent.some((message) => message.method === "Runtime.evaluate")).toBe(false)

    // Failed to start.
    const refusing = standIn({ fail: (message) => message.method === "Target.setAutoAttach" && !message.sessionId })
    const failed = new BrowserGuard(refusing.pipe, "")
    await expect(failed.start()).rejects.toThrow()
    expect(await failed.focusedSecret()).toBe("credential")

    // The browser's pipe closed after the guard was in place: with no guard world left to ask, as with pages in it.
    const empty = standIn()
    const bare = new BrowserGuard(empty.pipe, "")
    await bare.start()
    expect(await bare.focusedSecret()).toBeUndefined()
    empty.pipe.close()
    expect(await bare.focusedSecret()).toBe("credential")
    expect(await bare.pointedSecret({ x: 1, y: 1 })).toBe("credential")
    const { browser, guard } = await guarded()
    browser.pipe.close()
    expect(await guard.focusedSecret()).toBe("credential")
  })

  test("the first commands wait for the browser's start-up, not a page's call timeout", async () => {
    const slow = (message: Sent) => (message.method === "Target.setDiscoverTargets" ? 150 : 1)
    const patient = new BrowserGuard(standIn({ delay: slow }).pipe, "", { callMs: 40, startMs: 2_000 })
    await patient.start()
    expect(await patient.focusedSecret()).toBeUndefined()
    const hasty = new BrowserGuard(standIn({ delay: slow }).pipe, "", { callMs: 40, startMs: 40 })
    await expect(hasty.start()).rejects.toThrow("timed out")
  })

  test("hostd's view: nothing while no browser runs, GUARD_DOWN while the browser runs without its guard", async () => {
    expect(guardView(false, undefined)).toBeUndefined()
    const down = guardView(true, undefined)
    expect(down).toBe(GUARD_DOWN)
    expect(await down!.focusedSecret()).toBe("credential")
    expect(await down!.pointedSecret({ x: 1, y: 1 })).toBe("credential")
    expect(await down!.captchas()).toEqual([])
    const guard = new BrowserGuard(standIn().pipe, "")
    expect(guardView(true, guard)).toBe(guard)
    expect(guardView(false, guard)).toBeUndefined()
  })
})

describe("the browser's pipe", () => {
  test("a message that grows too large closes the pipe for good, keeps nothing and says so once", async () => {
    let closed = 0
    const pipe = new CdpPipe(() => {}, { maxMessage: 64 })
    pipe.onClose(() => closed++)
    const call = pipe.send("Browser.getVersion")
    pipe.feed("x".repeat(65))
    expect(pipe.closed).toBe(true)
    expect(pipe.buffered).toBe(0)
    expect(closed).toBe(1)
    await expect(call).rejects.toThrow("browser pipe closed")
    // The browser may keep writing: nothing more is kept.
    pipe.feed("y".repeat(1_000))
    expect(pipe.buffered).toBe(0)
    pipe.close()
    expect(closed).toBe(1)
    let late = 0
    pipe.onClose(() => late++)
    expect(late).toBe(1)
  })

  test("messages are split on NUL bytes and answers matched to their calls", async () => {
    const pipe = new CdpPipe(() => {})
    const events: string[] = []
    pipe.on((message) => events.push(message.method!))
    const call = pipe.send<{ product: string }>("Browser.getVersion")
    pipe.feed('{"method":"Target.targetCreated","params":{}}\0{"id":1,"result":{"product":"x"}}')
    pipe.feed("\0")
    expect(await call).toEqual({ product: "x" })
    expect(events).toEqual(["Target.targetCreated"])
  })
})
