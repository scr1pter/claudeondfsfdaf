import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { SessionCleanup } from "../../src/session/cleanup"
import type { Session } from "../../src/session/session"
// The browser tool registers its cleanup when it loads, as the registry loads it.
import "../../src/tool/browser"
import { BrowserBridge } from "../../src/tool/browser-bridge"
import { FakeBridge } from "../lib/fake-bridge"

const deleted = (id: string) => ({ id, directory: "/tmp/project" }) as unknown as Session.Info

describe("the agent browser's lifetime", () => {
  test("deleting a session closes its browser through the desktop's bridge", async () => {
    const bridge = FakeBridge.start(() => ({ ok: true }))
    try {
      await Effect.runPromise(FakeBridge.within(bridge, SessionCleanup.run(deleted("ses_gone"))))
      expect(FakeBridge.sent(bridge)).toContainEqual({ contextId: "ses_gone", command: "closeBrowser" })
    } finally {
      await bridge.close()
    }
  })

  test("a desktop that refuses or is gone fails nothing, and outside the desktop nothing is sent", async () => {
    // An answer that is no report: the command never reached a page.
    const bridge = FakeBridge.start(() => ({ error: "refused" }))
    try {
      await Effect.runPromise(FakeBridge.within(bridge, BrowserBridge.close(["ses_a", "ses_b"])))
      expect(FakeBridge.sent(bridge).map((body) => String(body.contextId)).toSorted()).toEqual(["ses_a", "ses_b"])
    } finally {
      await bridge.close()
    }
    expect(BrowserBridge.available()).toBe(false)
    await Effect.runPromise(BrowserBridge.close(["ses_a"]))
  })
})
