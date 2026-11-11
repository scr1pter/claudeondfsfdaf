import { afterEach, describe, expect, test } from "bun:test"
import { BrowserGuard, CdpPipe, GUARD_DOWN, GUARD_WORLD, guardView, type GuardOptions } from "../src/guard"

// WP A54: hostd's credential guard attaches to every page and frame while it waits for the debugger, puts its script in
// place and lets it run. A browser holds the commands meant for a waiting target's renderer while the target navigates,
// and the navigation can itself wait for the go-ahead, so the guard must send the go-ahead without first waiting for
// the answers to its setup. The stand-in browser below answers those commands only once the target runs.
//
// The guard fails closed: whenever it cannot answer for a page or frame (its setup is in flight, failed or timed out,
// its session went while the browser still lists it, the guard never attached to it, or the guard itself is not in
// place), the focused field counts as a credential field, so hostd refuses to type.

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
  // What the focused field in each guard world takes (by context id).
  const focus = { kind: (_context: number): string | null => "credential" }
  const listeners: ((message: Sent) => void)[] = []
  const reply = (message: unknown) => setTimeout(() => pipe.feed(JSON.stringify(message) + "\0"), 1)
  const answer = (message: Sent) => {
    if (options.silent?.(message)) return
    if (options.fail?.(message) || (message.sessionId && detached.has(message.sessionId)))
      return reply({ id: message.id, error: { message: GONE } })
    const result =
      message.method === "Page.getFrameTree"
        ? { frameTree: { frame: { id: "main" } } }
        : message.method === "Runtime.evaluate"
          ? { result: { value: { kind: focus.kind(message.params.contextId as number) } } }
          : {}
    reply({ id: message.id, result })
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
  /** The guard's world in a frame of the session. */
  const world = (sessionId: string, id: number) =>
    event("Runtime.executionContextCreated", { context: { id, name: GUARD_WORLD, auxData: { frameId: "main" } } }, sessionId)
  const until = async (done: () => boolean | Promise<boolean>) => {
    for (let i = 0; i < 200 && !(await done()); i++) await new Promise((resolve) => setTimeout(resolve, 5))
    expect(await done()).toBe(true)
  }
  const asked = (sessionId: string) => sent.some((message) => message.sessionId === sessionId && message.method === "Runtime.evaluate")
  return { pipe, sent, waiting, focus, listeners, attach, announce, destroy, detach, release, world, event, until, asked }
}

const settle = (ms = 25) => new Promise((resolve) => setTimeout(resolve, ms))

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

  test("while a page's setup is in flight, the focused field counts as a credential field", async () => {
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
    expect(await guard.focusedSecret()).toBe("credential")
    // Once the page runs and its setup is done, its guard world answers for it.
    browser.release("S4")
    browser.world("S4", 11)
    await browser.until(async () => (await guard.focusedSecret()) === undefined)
    expect(browser.asked("S4")).toBe(true)
  })

  test("a page whose setup fails still runs, and typing stays refused until it goes away", async () => {
    const { browser, guard } = await guarded({ fail: (message) => message.sessionId === "S2" && message.method === "Runtime.enable" })
    browser.announce("T2", "page")
    browser.attach("S2", "page", "T2")
    await browser.until(() => !browser.waiting.has("S2"))
    await settle()
    expect(await guard.focusedSecret()).toBe("credential")
    // Not dropped as if it were gone: even when a guard world turns up in it, the guard cannot vouch for that page, so
    // it neither takes its answer nor asks it for CAPTCHAs.
    browser.world("S2", 9)
    expect(await guard.focusedSecret()).toBe("credential")
    expect(await guard.captchas()).toEqual([])
    expect(browser.asked("S2")).toBe(false)
    // Once the browser says the page is gone, the guard answers for the pages left.
    browser.detach("S2", "T2")
    browser.destroy("T2")
    expect(await guard.focusedSecret()).toBeUndefined()
  })

  test("a page whose setup times out is held the same way", async () => {
    const { browser, guard } = await guarded(
      { silent: (message) => message.sessionId === "S3" && message.method === "Page.addScriptToEvaluateOnNewDocument" },
      { callMs: 80 },
    )
    browser.announce("T3", "page")
    browser.attach("S3", "page", "T3")
    await browser.until(() => !browser.waiting.has("S3"))
    expect(await guard.focusedSecret()).toBe("credential")
    // Past the guard's call timeout the setup has failed; typing is still refused.
    await settle(150)
    expect(await guard.focusedSecret()).toBe("credential")
    expect(browser.asked("S3")).toBe(false)
    browser.detach("S3", "T3")
    browser.destroy("T3")
    expect(await guard.focusedSecret()).toBeUndefined()
  })

  test("a page that detaches mid-setup while the browser still lists it stays refused until it is gone", async () => {
    const { browser, guard } = await guarded({ stall: (sessionId) => sessionId === "S5" })
    browser.announce("T5", "page")
    browser.attach("S5", "page", "T5")
    browser.detach("S5", "T5")
    await settle()
    // The held setup failed ("Session with given id not found"), and the guard has no hold on the page it still lists.
    expect(browser.sent.some((message) => message.sessionId === "S5" && message.method === "Runtime.runIfWaitingForDebugger")).toBe(true)
    expect(await guard.focusedSecret()).toBe("credential")
    browser.destroy("T5")
    expect(await guard.focusedSecret()).toBeUndefined()
  })

  test("pages and frames the guard never attached to (unknown targets) are refused", async () => {
    const { browser, guard } = await guarded()
    // A frame the browser lists that was never attached.
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
    const { browser, guard } = await guarded()
    browser.pipe.close()
    expect(await guard.focusedSecret()).toBe("credential")
  })

  test("hostd's view: nothing while no browser runs, GUARD_DOWN while the browser runs without its guard", async () => {
    expect(guardView(false, undefined)).toBeUndefined()
    const down = guardView(true, undefined)
    expect(down).toBe(GUARD_DOWN)
    expect(await down!.focusedSecret()).toBe("credential")
    expect(await down!.captchas()).toEqual([])
    const guard = new BrowserGuard(standIn().pipe, "")
    expect(guardView(true, guard)).toBe(guard)
    expect(guardView(false, guard)).toBeUndefined()
  })
})
