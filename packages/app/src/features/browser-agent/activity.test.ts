import { describe, expect, test } from "bun:test"
import { activityLabel, applyActivity, stopBrowser, visibleActivity } from "./activity"
import type { BrowserAgentActivity } from "./types"

const event = (input: Partial<BrowserAgentActivity> & { contextId: string }): BrowserAgentActivity => ({
  url: "http://localhost:3000/",
  title: "",
  tabs: 1,
  busy: false,
  shown: false,
  closed: false,
  ...input,
})

const parents: Record<string, string> = { ses_helper: "ses_main", ses_nested: "ses_helper" }
const parentOf = (id: string) => parents[id]

describe("the browser indicator", () => {
  test("keeps each open browser by context and drops one once it closes", () => {
    let open = applyActivity(new Map(), event({ contextId: "ses_main", busy: true }))
    open = applyActivity(open, event({ contextId: "ses_main", title: "Dashboard" }))
    expect([...open.values()]).toEqual([event({ contextId: "ses_main", title: "Dashboard" })])
    expect(applyActivity(open, event({ contextId: "ses_main", closed: true, tabs: 0 })).size).toBe(0)
  })

  test("a session shows its own browser and its helpers', not other conversations', and none a Preview shows", () => {
    let open = new Map<string, BrowserAgentActivity>()
    for (const item of [
      event({ contextId: "ses_nested" }),
      event({ contextId: "ses_main" }),
      event({ contextId: "ses_other" }),
    ])
      open = applyActivity(open, item)
    expect(visibleActivity(open, "ses_main", parentOf).map((item) => [item.activity.contextId, item.own])).toEqual([
      ["ses_main", true],
      ["ses_nested", false],
    ])
    open = applyActivity(open, event({ contextId: "ses_main", shown: true }))
    expect(visibleActivity(open, "ses_main", parentOf).map((item) => item.activity.contextId)).toEqual(["ses_nested"])
    expect(visibleActivity(open, "ses_helper", parentOf).map((item) => item.own)).toEqual([false])
  })

  test("names a page by its title, else its host", () => {
    expect(activityLabel({ title: " Docs ", url: "https://example.com/a" })).toBe("Docs")
    expect(activityLabel({ title: "", url: "https://example.com/a" })).toBe("example.com")
    expect(activityLabel({ title: "", url: "" })).toBe("")
  })

  test("Stop closes that browser through the desktop, and a desktop that refuses leaves nothing thrown", async () => {
    const sent: unknown[] = []
    const api = {
      runBrowserAgent: async (input: unknown) => {
        sent.push(input)
        throw new Error("gone")
      },
    }
    await stopBrowser(api as never, "ses_helper")
    expect(sent).toEqual([{ contextId: "ses_helper", command: "closeBrowser" }])
    expect(await stopBrowser(undefined, "ses_helper")).toBeUndefined()
  })
})
