import { describe, expect, test } from "bun:test"
import {
  applyApprovalEvent,
  applyMessageEvent,
  applySessionEvent,
  computerLine,
  decodeDevices,
  decodeMessages,
  decodeProjects,
  fairUseLine,
  lastSeenLine,
  pairedCount,
  pairingLinkFromLocation,
  permissionView,
  phoneName,
  questionView,
  refusalText,
  relayAllowed,
  remoteNotice,
  sessionRows,
  spacedCode,
} from "./model"

// WP A42: what the phone's Remote pages show, from what the computer and Vector's API answer.

const ID = (seed: number) => Buffer.alloc(16, seed).toString("base64url")

describe("this phone", () => {
  test("is named by its kind only", () => {
    expect(phoneName({ userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X)" })).toBe("iPhone")
    expect(phoneName({ userAgent: "Mozilla/5.0 (Macintosh)", platform: "MacIntel", maxTouchPoints: 5 })).toBe("iPad")
    expect(phoneName({ userAgent: "Mozilla/5.0 (Linux; Android 15; Pixel 9) Mobile Safari" })).toBe("Android phone")
    expect(phoneName({ userAgent: "Mozilla/5.0 (Linux; Android 15; SM-X910)" })).toBe("Android tablet")
    expect(phoneName({})).toBe("Phone")
  })

  test("reads a pairing link only from the pairing page's fragment", () => {
    const origin = "https://remote.vectordev.ai"
    expect(pairingLinkFromLocation({ origin, pathname: "/phone/pair", hash: "#abc" })).toBe(`${origin}/phone/pair#abc`)
    expect(pairingLinkFromLocation({ origin, pathname: "/phone/pair/", hash: "#abc" })).toBe(`${origin}/phone/pair#abc`)
    expect(pairingLinkFromLocation({ origin, pathname: "/phone/pair", hash: "" })).toBeUndefined()
    expect(pairingLinkFromLocation({ origin, pathname: "/phone/devices", hash: "#abc" })).toBeUndefined()
  })

  test("opens only Vector's relay, over wss", () => {
    const origin = "https://remote.vectordev.ai"
    expect(relayAllowed(new URL("wss://relay.vectordev.ai/v1/connect"), origin)).toBe(true)
    expect(relayAllowed(new URL("ws://relay.vectordev.ai/v1/connect"), origin)).toBe(false)
    expect(relayAllowed(new URL("wss://relay.example.test/v1/connect"), origin)).toBe(false)
    expect(relayAllowed(new URL("ws://127.0.0.1:8787/v1/connect"), origin)).toBe(false)
    expect(relayAllowed(new URL("ws://127.0.0.1:8787/v1/connect"), "http://localhost:3000")).toBe(true)
  })

  test("shows the six digits in two groups", () => {
    expect(spacedCode("042117")).toBe("042 117")
    expect(spacedCode("12")).toBe("12")
  })
})

describe("the connection", () => {
  test("says what is wrong and offers what helps", () => {
    expect(remoteNotice({ state: "online" })).toBeUndefined()
    expect(remoteNotice({ state: "idle" })).toBeUndefined()
    expect(remoteNotice({ state: "idle-closed", message: "Disconnected." })).toEqual({
      text: "Disconnected.",
      action: "reconnect",
    })
    expect(remoteNotice({ state: "revoked", message: "Removed." })).toEqual({ text: "Removed.", action: "reset" })
    expect(remoteNotice({ state: "not-in-plan", message: "No." })).toEqual({ text: "No." })
    expect(remoteNotice({ state: "signed-out", message: "Sign in." })).toEqual({ text: "Sign in." })
  })

  test("describes each paired computer", () => {
    const base = { device: ID(1), name: "Studio Mac", pairedAt: 1 }
    expect(computerLine({ ...base, online: true, channel: "open" })).toBe("Connected")
    expect(computerLine({ ...base, online: false, channel: "offline" })).toContain("turn on Remote")
    expect(computerLine({ ...base, online: true, channel: "not-paired" })).toContain("Pair it again")
    expect(computerLine({ ...base, online: true, channel: "update-desktop" })).toContain("Update Vector on this computer")
  })
})

describe("devices", () => {
  test("decodes the account's devices leniently", () => {
    const decoded = decodeDevices({
      devices: [
        { device: ID(1), role: "computer", name: "Mac", pairedAt: 5, lastSeen: 6, online: true, overLimit: false },
        { device: ID(2), role: "phone", pairedAt: 7, lastSeen: 0, online: false, overLimit: true },
        { device: "nope", role: "computer" },
        { device: ID(3), role: "watch" },
      ],
      limits: { computers: 3, phones: 5 },
      fairUse: "viewer",
      available: true,
    })
    expect(decoded.devices.map((item) => [item.name, item.role, item.overLimit])).toEqual([
      ["Mac", "computer", false],
      ["Phone", "phone", true],
    ])
    expect(decoded.limits).toEqual({ computers: 3, phones: 5 })
    expect(fairUseLine(decoded.fairUse)).toContain("viewing time")
    expect(decodeDevices(undefined)).toEqual({ devices: [], limits: { computers: 0, phones: 0 }, fairUse: "ok", available: false })
  })

  test("the paired count comes from the status meter, else the device list", () => {
    expect(pairedCount({ computers: 1, limit: 3 })).toBe("1 of 3 computers paired.")
    expect(pairedCount({ computers: 1, limit: 1 })).toBe("1 of 1 computer paired.")
    const list = decodeDevices({
      devices: [{ device: ID(1), role: "computer", pairedAt: 1, lastSeen: 1, online: false, overLimit: false }],
      limits: { computers: 5, phones: 5 },
    })
    expect(pairedCount(undefined, list)).toBe("1 of 5 computers paired.")
    expect(pairedCount(undefined)).toBeUndefined()
  })

  test("says when a device was last seen", () => {
    const now = 10 * 86_400_000
    const at = (lastSeen: number, online = false) =>
      lastSeenLine({ device: ID(1), role: "phone", name: "x", pairedAt: 0, lastSeen, online, overLimit: false }, now)
    expect(at(now, true)).toBe("Connected now")
    expect(at(0)).toBe("Not seen yet")
    expect(at(now - 30_000)).toBe("Seen just now")
    expect(at(now - 20 * 60_000)).toBe("Seen 20 minutes ago")
    expect(at(now - 3 * 3_600_000)).toBe("Seen 3 hours ago")
    expect(at(now - 5 * 86_400_000)).toBe("Seen 5 days ago")
  })
})

const project = decodeProjects([
  { id: "prj_1", worktree: "/repo", sandboxes: ["/repo-sandbox"] },
  { id: "global", worktree: "/" },
])[0]!

describe("sessions", () => {
  test("lists projects without the global one, named by their folder", () => {
    expect(project).toEqual({ id: "prj_1", worktree: "/repo", name: "repo", sandboxes: ["/repo-sandbox"] })
  })

  test("lists top-level sessions, newest first, with what each is doing", () => {
    const rows = sessionRows(
      project,
      "/repo",
      [
        { id: "ses_a", title: "Old", time: { updated: 1 } },
        { id: "ses_b", title: "New", time: { updated: 5 } },
        { id: "ses_c", title: "Child", parentID: "ses_b", time: { updated: 9 } },
        { id: "ses_d", title: "Archived", time: { updated: 9, archived: 9 } },
        { id: "ses_e", title: "", internal: "judge", time: { updated: 9 } },
      ],
      { ses_b: { type: "busy" } },
    )
    expect(rows.map((row) => [row.id, row.title, row.status])).toEqual([
      ["ses_b", "New", "busy"],
      ["ses_a", "Old", "idle"],
    ])
  })

  test("follows session events without asking the computer", () => {
    const rows = sessionRows(project, "/repo", [{ id: "ses_a", title: "A", time: { updated: 1 } }], {})
    const busy = applySessionEvent(rows, [project], {
      directory: "/repo",
      type: "session.status",
      properties: { sessionID: "ses_a", status: { type: "busy" } },
    })
    expect(busy[0]!.status).toBe("busy")
    const added = applySessionEvent(busy, [project], {
      directory: "/repo",
      type: "session.created",
      properties: { sessionID: "ses_n", info: { id: "ses_n", title: "Fresh", time: { updated: 50 } } },
    })
    expect(added.map((row) => row.id)).toEqual(["ses_n", "ses_a"])
    const renamed = applySessionEvent(added, [project], {
      directory: "/repo",
      type: "session.updated",
      properties: { sessionID: "ses_a", info: { id: "ses_a", title: "Renamed", time: { updated: 60 } } },
    })
    expect(renamed[0]).toMatchObject({ id: "ses_a", title: "Renamed", status: "busy" })
    expect(
      applySessionEvent(renamed, [project], { directory: "/repo", type: "session.deleted", properties: { sessionID: "ses_n" } }),
    ).toHaveLength(1)
  })

  test("reads messages: text and tools shown, reasoning and synthetic text left out", () => {
    const messages = decodeMessages([
      {
        info: { id: "msg_2", role: "assistant", time: { created: 2 } },
        parts: [
          { id: "p1", type: "reasoning", text: "thinking" },
          { id: "p2", type: "text", text: "Done." },
          { id: "p3", type: "tool", tool: "bash", state: { status: "completed", title: "bun test" } },
        ],
      },
      {
        info: { id: "msg_1", role: "user", time: { created: 1 } },
        parts: [
          { id: "p0", type: "text", text: "Run the tests" },
          { id: "px", type: "text", text: "context", synthetic: true },
        ],
      },
    ])
    expect(messages.map((message) => message.id)).toEqual(["msg_1", "msg_2"])
    expect(messages[0]!.parts).toEqual([{ id: "p0", kind: "text", text: "Run the tests" }])
    expect(messages[1]!.parts).toEqual([
      { id: "p2", kind: "text", text: "Done." },
      { id: "p3", kind: "tool", tool: "bash", state: "completed", title: "bun test" },
    ])
  })

  test("applies streamed message events, and asks to load again when an event was cut short", () => {
    let messages = decodeMessages([{ info: { id: "msg_1", role: "assistant", time: { created: 1 } }, parts: [] }])
    const apply = (type: string, properties: unknown, truncated = false) => {
      const result = applyMessageEvent(messages, "ses_1", { directory: "/repo", type, properties, ...(truncated ? { truncated } : {}) })
      messages = result.messages
      return result.stale
    }
    expect(apply("message.part.updated", { part: { id: "p1", sessionID: "ses_1", messageID: "msg_1", type: "text", text: "Hel" } })).toBe(false)
    expect(apply("message.part.delta", { sessionID: "ses_1", messageID: "msg_1", partID: "p1", field: "text", delta: "lo" })).toBe(false)
    expect(messages[0]!.parts).toEqual([{ id: "p1", kind: "text", text: "Hello" }])
    expect(apply("message.updated", { info: { id: "msg_2", sessionID: "ses_1", role: "user", time: { created: 2 } } })).toBe(false)
    expect(messages.map((message) => message.id)).toEqual(["msg_1", "msg_2"])
    // Another session's event changes nothing.
    expect(apply("message.removed", { sessionID: "ses_9", messageID: "msg_1" })).toBe(false)
    expect(messages).toHaveLength(2)
    expect(apply("message.part.updated", { sessionID: "ses_1", messageID: "msg_1" }, true)).toBe(true)
    expect(apply("message.part.delta", { sessionID: "ses_1", messageID: "msg_7", partID: "p9", field: "text", delta: "x" })).toBe(true)
    expect(apply("message.removed", { sessionID: "ses_1", messageID: "msg_2" })).toBe(false)
    expect(messages.map((message) => message.id)).toEqual(["msg_1"])
  })
})

describe("approvals", () => {
  test("describes a permission request by what it would do", () => {
    expect(
      permissionView(
        { id: "per_1", sessionID: "ses_1", permission: "bash", patterns: ["bun test"], metadata: { command: "bun test --watch" } },
        "/repo",
      ),
    ).toEqual({ id: "per_1", sessionID: "ses_1", directory: "/repo", title: "Run a command", detail: "bun test --watch" })
    expect(permissionView({ id: "per_2", sessionID: "ses_1", permission: "edit", patterns: ["src/a.ts", "src/b.ts"] }, "/repo")).toMatchObject({
      title: "Edit files",
      detail: "src/a.ts\nsrc/b.ts",
    })
    expect(permissionView({ id: "per_3", sessionID: "ses_1", permission: "mcp_thing" }, "/repo")!.title).toBe("Use mcp_thing")
    expect(permissionView({ sessionID: "ses_1" }, "/repo")).toBeUndefined()
  })

  test("reads questions with their options", () => {
    expect(
      questionView(
        {
          id: "que_1",
          sessionID: "ses_1",
          questions: [{ header: "Branch", question: "Which branch?", options: [{ label: "main" }, { label: "dev" }], multiple: false }],
        },
        "/repo",
      ),
    ).toEqual({
      id: "que_1",
      sessionID: "ses_1",
      directory: "/repo",
      questions: [{ header: "Branch", question: "Which branch?", options: ["main", "dev"], multiple: false }],
    })
    expect(questionView({ id: "que_2", sessionID: "ses_1", questions: [] }, "/repo")).toBeUndefined()
  })

  test("follows asked and answered requests without asking the computer", () => {
    let lists = { permissions: [], questions: [] } as Parameters<typeof applyApprovalEvent>[0]
    const apply = (type: string, properties: unknown, truncated = false) => {
      const result = applyApprovalEvent(lists, { directory: "/repo", type, properties, ...(truncated ? { truncated } : {}) })
      lists = { permissions: result.permissions, questions: result.questions }
      return result.stale
    }
    apply("permission.asked", { id: "per_1", sessionID: "ses_1", permission: "bash", patterns: ["ls"] })
    apply("permission.asked", { id: "per_1", sessionID: "ses_1", permission: "bash", patterns: ["ls"] })
    apply("question.asked", { id: "que_1", sessionID: "ses_1", questions: [{ question: "Go?", options: [{ label: "Yes" }] }] })
    expect(lists.permissions.map((item) => item.id)).toEqual(["per_1"])
    expect(lists.questions.map((item) => item.id)).toEqual(["que_1"])
    apply("permission.replied", { sessionID: "ses_1", requestID: "per_1", reply: "once" })
    apply("question.rejected", { sessionID: "ses_1", requestID: "que_1" })
    expect(lists).toEqual({ permissions: [], questions: [] })
    expect(apply("permission.asked", { id: "per_2" }, true)).toBe(true)
  })

  test("puts a refusal in the computer's own words", () => {
    expect(refusalText({ status: 403, body: { error: { code: "REMOTE_ONCE_ONLY", message: "Once only." } } })).toBe("Once only.")
    expect(refusalText({ status: 404, body: null })).toBe("That was already answered.")
    expect(refusalText({ status: 500, body: "x" })).toBe("The computer did not do that.")
  })
})
