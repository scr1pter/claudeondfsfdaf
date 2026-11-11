import { describe, expect, test } from "bun:test"
import { BrowserGuard, CdpPipe, GUARD_WORLD } from "../src/guard"

// WP A54: hostd's credential guard attaches to every page and frame while it waits for the debugger, puts its script in
// place and lets it run. A browser holds the commands meant for a waiting target's renderer while the target navigates,
// and the navigation can itself wait for the go-ahead, so the guard must send the go-ahead without first waiting for
// the answers to its setup. The stand-in browser below answers those commands only once the target runs.

const RENDERER = new Set(["Page.enable", "Runtime.enable", "Page.addScriptToEvaluateOnNewDocument", "Page.getFrameTree", "Runtime.evaluate"])

type Sent = { id: number; method: string; params: Record<string, unknown>; sessionId?: string }

function standIn(options: { fail?: string } = {}) {
  const sent: Sent[] = []
  const waiting = new Set<string>()
  const held: Sent[] = []
  const answer = (message: Sent) => {
    if (message.method === options.fail) return reply({ id: message.id, error: { message: "Session with given id not found." } })
    const result =
      message.method === "Page.getFrameTree"
        ? { frameTree: { frame: { id: "main" } } }
        : message.method === "Runtime.evaluate"
          ? { result: { value: { kind: "credential" } } }
          : {}
    reply({ id: message.id, result })
  }
  const reply = (message: unknown) => setTimeout(() => pipe.feed(JSON.stringify(message) + "\0"), 1)
  const pipe = new CdpPipe((chunk) => {
    for (const raw of chunk.split("\0").filter(Boolean)) {
      const message = JSON.parse(raw) as Sent
      sent.push(message)
      if (message.method === "Runtime.runIfWaitingForDebugger" && message.sessionId) {
        waiting.delete(message.sessionId)
        answer(message)
        for (const later of held.splice(0)) answer(later)
      } else if (message.sessionId && waiting.has(message.sessionId) && RENDERER.has(message.method)) held.push(message)
      else answer(message)
    }
  })
  const attach = (sessionId: string, type: string) => {
    waiting.add(sessionId)
    pipe.feed(JSON.stringify({ method: "Target.attachedToTarget", params: { sessionId, targetInfo: { type }, waitingForDebugger: true } }) + "\0")
  }
  const event = (method: string, params: Record<string, unknown>, sessionId?: string) =>
    pipe.feed(JSON.stringify({ method, params, ...(sessionId ? { sessionId } : {}) }) + "\0")
  const until = async (done: () => boolean) => {
    for (let i = 0; i < 200 && !done(); i++) await new Promise((resolve) => setTimeout(resolve, 5))
    expect(done()).toBe(true)
  }
  return { pipe, sent, waiting, attach, event, until }
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
    browser.event("Runtime.executionContextCreated", { context: { id: 7, name: GUARD_WORLD, auxData: { frameId: "main" } } }, "S1")
    expect(await guard.focusedSecret()).toBe("credential")
    expect(Date.now() - started).toBeLessThan(1_000)
  })

  test("other targets (workers) are only let run", async () => {
    const browser = standIn()
    const guard = new BrowserGuard(browser.pipe, "")
    await guard.start()
    browser.attach("W1", "service_worker")
    await browser.until(() => !browser.waiting.has("W1"))
    expect(browser.sent.filter((message) => message.sessionId === "W1").map((message) => message.method)).toEqual(["Runtime.runIfWaitingForDebugger"])
  })

  test("a page whose setup fails still runs, and is dropped rather than taking hostd down", async () => {
    const browser = standIn({ fail: "Runtime.enable" })
    const guard = new BrowserGuard(browser.pipe, "")
    await guard.start()
    browser.attach("S2", "page")
    await browser.until(() => !browser.waiting.has("S2"))
    await new Promise((resolve) => setTimeout(resolve, 20))
    // Dropped: the guard no longer counts it as one of its pages, so it does not ask it for CAPTCHAs.
    browser.event("Runtime.executionContextCreated", { context: { id: 9, name: GUARD_WORLD, auxData: { frameId: "main" } } }, "S2")
    expect(await guard.captchas()).toEqual([])
    expect(browser.sent.some((message) => message.sessionId === "S2" && message.method === "Runtime.evaluate")).toBe(false)
  })
})
