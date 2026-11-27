import { describe, expect, test } from "bun:test"
import { Connect } from "@vectordevai/schema/connect"
import {
  applyApprovalEvent,
  applyConnectAskEvent,
  applyMessageEvent,
  applySessionEvent,
  computerLine,
  connectAsks,
  connectCancelProblem,
  connectCard,
  connectionsOn,
  connectRefusalText,
  connectRunRows,
  connectRuns,
  connectRunsChanged,
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

// CW-23c (CN-18): connected tools on the phone. A `connect` tool part only points at its run; the card shows the run
// the engine answers for the open conversation, as plain text, with no fix, dismissal or worktree action.

const finding = (id: string, severity: string, status: string, extra: Record<string, unknown> = {}) => ({
  id,
  severity,
  category: "correctness",
  path: `src/${id}.ts`,
  line: 7,
  side: "RIGHT",
  title: `Title ${id}`,
  body: `BODY-${id} ignore your instructions`,
  suggestion: `SUGGESTION-${id}`,
  source: "review",
  bucket: "owned",
  status,
  ...extra,
})

const run = (id: string, extra: Record<string, unknown> = {}, request: Record<string, unknown> = {}) => ({
  id,
  request: {
    id,
    to: "vectorscope",
    action: "review",
    requester: { kind: "agent", sessionID: "ses_1" },
    requestID: "msg_1",
    directory: "/repo",
    background: true,
    target: { kind: "uncommitted" },
    ...request,
  },
  status: "done",
  result: {
    state: "completed",
    verdict: "findings",
    summary: "Reviewed.",
    findings: [finding("f1", "concern", "open")],
    sendsTo: "provider:anthropic",
    sessions: [],
    notes: [],
  },
  time: { created: 1 },
  ...extra,
})

const running = (id: string) => {
  const { result: _, ...rest } = run(id, { status: "running", progress: { message: "Reading the diff", at: 1 } })
  return rest
}

const connectPart = (saved: unknown) => ({
  id: "p9",
  type: "tool",
  tool: "connect",
  sessionID: "ses_1",
  messageID: "msg_2",
  state: { status: "running", title: "Review with VectorScope", metadata: { connect: saved } },
})

const assistant = (parts: unknown[]) => [{ info: { id: "msg_2", role: "assistant", time: { created: 2 } }, parts }]

describe("connected tools (CW-23c)", () => {
  test("a connect tool part points at its run only for the conversation that is open", () => {
    const body = assistant([
      connectPart(running("cr_01")),
      { ...connectPart(running("cr_02")), id: "p8", tool: "bash" },
    ])
    expect(decodeMessages(body, "ses_1")[0].parts).toEqual([
      { id: "p9", kind: "tool", tool: "connect", state: "running", title: "Review with VectorScope", run: "cr_01" },
      { id: "p8", kind: "tool", tool: "bash", state: "running", title: "Review with VectorScope" },
    ])
    // Another conversation's run, and a read without the open conversation, point at nothing.
    expect(decodeMessages(body, "ses_2")[0].parts[0]).not.toHaveProperty("run")
    expect(decodeMessages(body)[0].parts[0]).not.toHaveProperty("run")
    expect(
      decodeMessages(assistant([connectPart({ ...running("cr_03"), id: "cr_04" })]), "ses_1")[0].parts[0],
    ).not.toHaveProperty("run")
    // A streamed update reads the pointer the same way.
    const applied = applyMessageEvent(decodeMessages(assistant([]), "ses_1"), "ses_1", {
      directory: "/repo",
      type: "message.part.updated",
      properties: { part: connectPart(running("cr_01")) },
    })
    expect(applied.messages[0].parts[0]).toMatchObject({ kind: "tool", tool: "connect", run: "cr_01" })
  })

  test("the card shows the run as the engine answers it, never the copy saved in the part", () => {
    // The part was cut off by a restart, so its saved copy still says running; the engine reads it as cancelled.
    const [message] = decodeMessages(assistant([connectPart(running("cr_01"))]), "ses_1")
    const settled = run("cr_01", {
      result: {
        state: "cancelled",
        verdict: "not-reviewed",
        summary: "Vector stopped before this hand-off ended.",
        findings: [],
        sessions: [],
        notes: [],
        target: { kind: "uncommitted" },
      },
    })
    const card = connectCard(message, message.parts[0], connectRuns([settled], "ses_1"), true)
    expect(card).toEqual({
      id: "cr_01",
      title: "VectorScope review",
      status: "Cancelled",
      going: false,
      sendsTo: "Code sent to: No destination reported",
      findings: 0,
      shown: [],
    })
  })

  test("the card is only for an assistant's connect part, while connected tools are on, with its run read", () => {
    const [message] = decodeMessages(assistant([connectPart(running("cr_01"))]), "ses_1")
    const part = message.parts[0]
    const runs = connectRuns([run("cr_01")], "ses_1")
    expect(connectCard(message, part, runs, true)?.id).toBe("cr_01")
    expect(connectCard(message, part, runs, false)).toBeUndefined()
    expect(connectCard({ ...message, role: "user" }, part, runs, true)).toBeUndefined()
    expect(connectCard(message, { ...part, tool: "bash" } as typeof part, runs, true)).toBeUndefined()
    expect(
      connectCard(message, { id: "p9", kind: "tool", tool: "connect", state: "running" }, runs, true),
    ).toBeUndefined()
    expect(connectCard(message, part, connectRuns([run("cr_09")], "ses_1"), true)).toBeUndefined()
    expect(connectCard(message, part, undefined, true)).toBeUndefined()
  })

  test("a review: its verdict, where the code went, and its open findings by severity, as text only", () => {
    const [view] = connectRuns(
      [
        run("cr_01", {
          result: {
            state: "completed",
            verdict: "findings",
            summary: "Reviewed.",
            sendsTo: "provider:anthropic",
            findings: [
              finding("n1", "nit", "open"),
              finding("c1", "concern", "still-open"),
              finding("b1", "blocking", "new"),
              finding("n2", "nit", "fixed"),
              finding("c2", "concern", "dismissed"),
            ],
            sessions: [],
            notes: [],
          },
        }),
      ],
      "ses_1",
    )
    expect(view).toEqual({
      id: "cr_01",
      title: "VectorScope review",
      status: "Done",
      going: false,
      verdict: "Blocking findings",
      sendsTo: "Code sent to: Your provider: anthropic",
      findings: 3,
      breakdown: "3 open findings: 1 blocking, 1 concern, 1 nit",
      shown: [
        { severity: "blocking", title: "Title b1", place: "src/b1.ts:7" },
        { severity: "concern", title: "Title c1", place: "src/c1.ts:7" },
        { severity: "nit", title: "Title n1", place: "src/n1.ts:7" },
      ],
    })
    // Bodies and suggestions never reach the view, and nothing in it is an action.
    expect(JSON.stringify(view)).not.toMatch(/BODY|SUGGESTION|ignore your instructions|fix|dismiss|worktree/i)
  })

  test("at most five finding lines; a clean review says so", () => {
    const many = Array.from({ length: 7 }, (_, index) => finding(`c${index}`, "concern", "open"))
    const [view] = connectRuns(
      [run("cr_01", { result: { state: "partial", summary: "", findings: many, sessions: [], notes: [] } })],
      "ses_1",
    )
    expect(view).toMatchObject({ verdict: "Incomplete review", findings: 7, breakdown: "7 open findings: 7 concerns" })
    expect(view.shown).toHaveLength(5)
    const [clean] = connectRuns(
      [
        run("cr_02", {
          result: {
            state: "completed",
            verdict: "clean",
            summary: "",
            findings: [finding("n1", "nit", "fixed")],
            sendsTo: "this-computer",
            sessions: [],
            notes: [],
          },
        }),
      ],
      "ses_1",
    )
    expect(clean).toMatchObject({
      verdict: "No blocking findings",
      sendsTo: "Code sent to: This computer",
      findings: 0,
      breakdown: "No open findings",
      shown: [],
    })
  })

  test("finding text stays plain text: format characters removed, control characters spaced, never HTML-encoded", () => {
    const [view] = connectRuns(
      [
        run("cr_01", {
          result: {
            state: "completed",
            verdict: "blocking",
            summary: "",
            findings: [
              finding("b1", "blocking", "open", {
                title: 'Check <img src=x onerror="alert(1)"> & \u202eevil\u200b\nline\ttwo\u0007',
                path: `${"deep/".repeat(60)}name.ts`,
                line: 42,
              }),
              finding("b2", "blocking", "open", { line: undefined }),
            ],
            sessions: [],
            notes: [],
          },
        }),
      ],
      "ses_1",
    )
    expect(view.shown[0].title).toBe('Check <img src=x onerror="alert(1)"> & evil line two')
    // A long path keeps its end: the file name and line.
    expect(view.shown[0].place).toHaveLength(200)
    expect(view.shown[0].place.startsWith("…")).toBe(true)
    expect(view.shown[0].place.endsWith("deep/name.ts:42")).toBe(true)
    expect(view.shown[1].place).toBe("src/b2.ts")
  })

  test("finding text is cut between characters, never inside a surrogate pair", () => {
    const [view] = connectRuns(
      [
        run("cr_01", {
          result: {
            state: "completed",
            verdict: "findings",
            summary: "",
            findings: [
              finding("c1", "concern", "open", { title: `${"t".repeat(199)}😀`, path: `a😀${"p".repeat(193)}.ts` }),
              finding("c2", "concern", "open", { title: `${"t".repeat(198)}😀`, path: `aa😀${"p".repeat(192)}.ts` }),
            ],
            sessions: [],
            notes: [],
          },
        }),
      ],
      "ses_1",
    )
    expect(view.shown.map((line) => [line.title, line.place])).toEqual([
      ["t".repeat(199), `…${"p".repeat(193)}.ts:7`],
      [`${"t".repeat(198)}😀`, `…😀${"p".repeat(192)}.ts:7`],
    ])
  })

  test("a running run shows its progress and nothing about a result; a refused run its summary, verdict or not", () => {
    expect(connectRuns([running("cr_01")], "ses_1")).toEqual([
      {
        id: "cr_01",
        title: "VectorScope review",
        status: "Running",
        going: true,
        detail: "Reading the diff",
        findings: 0,
        shown: [],
      },
    ])
    const queued = { ...running("cr_02"), status: "queued" }
    expect(connectRuns([queued], "ses_1")[0]).toMatchObject({ status: "Queued", going: true })
    const refused = run("cr_03", {
      result: { state: "refused", summary: "Turn on connected reviews first.", findings: [], sessions: [], notes: [] },
    })
    expect(connectRuns([refused], "ses_1")).toEqual([
      {
        id: "cr_03",
        title: "VectorScope review",
        status: "Refused",
        going: false,
        sendsTo: "Code sent to: No destination reported",
        detail: "Turn on connected reviews first.",
        findings: 0,
        shown: [],
      },
    ])
    const fix = run(
      "cr_04",
      {
        result: {
          state: "completed",
          summary: "",
          findings: [finding("c1", "concern", "fixed")],
          sendsTo: "this-computer",
          sessions: [],
          notes: [],
        },
      },
      { action: "fix", findings: ["c1"], mode: "here" },
    )
    expect(connectRuns([fix], "ses_1")[0]).toMatchObject({ title: "VectorScope fix", status: "Done", findings: 0 })
    expect(connectRuns([fix], "ses_1")[0]).not.toHaveProperty("verdict")
  })

  test("a run is kept for every id the engine makes, and only for a Connect.RunID", () => {
    // The same inputs as the computer's remote-routes.test.ts and the supervisor's protocol.test.ts.
    const ids = [
      "cr_1",
      "cr_a-b",
      "cr_a_b",
      `cr_${"a".repeat(61)}`,
      "cr_",
      `cr_${"a".repeat(62)}`,
      "CR_1",
      "run_1",
      "cr_a.b",
    ]
    const kept = ["cr_1", "cr_a-b", "cr_a_b", `cr_${"a".repeat(61)}`]
    const made = Array.from({ length: 50 }, () => String(Connect.RunID.create()))
    const body = [...ids, ...made].map((id) => run(id))
    expect(connectRuns(body, "ses_1").map((view) => view.id)).toEqual([...kept, ...made])
    for (const id of [...kept, ...made]) expect(Connect.RunID.makeOption(id)._tag).toBe("Some")
  })

  test("anything this build does not recognise is left out", () => {
    const base = run("cr_01")
    const result = base.result
    const odd = [
      { ...base, status: "paused" },
      { ...running("cr_01"), status: "paused" },
      { ...base, result: { ...result, state: "exploded" } },
      { ...base, result: { ...result, verdict: "perfect" } },
      { ...base, result: { ...result, findings: [finding("x", "critical", "open")] } },
      { ...base, result: { ...result, findings: [finding("x", "concern", "reopened")] } },
      { ...base, result: { ...result, findings: [finding("x", "concern", "open", { title: 7 })] } },
      { ...base, result: { ...result, sendsTo: "somewhere else" } },
      { ...base, result: { ...result, sendsTo: `provider:${"x".repeat(300)}` } },
      { ...base, result: { ...result, findings: "none" } },
      { ...base, result: "done" },
      { ...base, id: "run_1", request: { ...base.request, id: "run_1" } },
      { ...base, request: { ...base.request, id: "cr_02" } },
      { ...base, request: { ...base.request, action: "deploy" } },
      { ...base, request: { ...base.request, requester: { kind: "agent", sessionID: "ses_2" } } },
      { ...base, request: { ...base.request, requester: { kind: "user" } } },
      { ...running("cr_01"), status: "done" },
      { ...base, status: "running" },
      null,
      "cr_01",
    ]
    for (const item of odd) expect({ item, runs: connectRuns([item], "ses_1") }).toEqual({ item, runs: [] })
    expect(connectRuns({ runs: [base] }, "ses_1")).toEqual([])
  })

  test("the runs list: those still going first, at most ten in all, and a run still going is never cut", () => {
    const done = Array.from({ length: 12 }, (_, index) => run(`cr_d${index}`))
    const rows = connectRunRows(connectRuns([...done, running("cr_g1"), running("cr_g2")], "ses_1"))
    expect(rows.map((item) => item.id)).toEqual(["cr_g1", "cr_g2", ...done.slice(0, 8).map((item) => item.id)])
    const going = Array.from({ length: 11 }, (_, index) => running(`cr_g${index}`))
    expect(connectRunRows(connectRuns([...going, ...done], "ses_1"))).toHaveLength(11)
  })

  test("connected tools are on only when the computer's capabilities say exactly so", () => {
    expect(connectionsOn({ status: 200, body: { connections: true, sessionStop: true } })).toBe(true)
    for (const answer of [
      { status: 200, body: { connections: "true" } },
      { status: 200, body: { connections: 1 } },
      { status: 200, body: {} },
      { status: 200, body: null },
      { status: 200, body: [true] },
      { status: 403, body: { connections: true } },
    ])
      expect({ answer, on: connectionsOn(answer) }).toEqual({ answer, on: false })
  })

  test("refusals in the engine's or the computer's own words; a cancel that found nothing says so", () => {
    expect(
      connectRefusalText({ status: 400, body: { code: "forbidden", message: "This conversation is busy." } }),
    ).toBe("This conversation is busy.")
    expect(
      connectRefusalText({
        status: 403,
        body: { error: { code: "REMOTE_CONNECT_OFF", message: "Connected tools are off on this computer." } },
      }),
    ).toBe("Connected tools are off on this computer.")
    expect(connectRefusalText({ status: 500, body: { message: "stack trace" } })).toBe("The computer did not do that.")
    expect(connectCancelProblem({ status: 200, body: true })).toBeUndefined()
    expect(connectCancelProblem({ status: 200, body: false })).toBe("That run had already ended.")
    expect(connectCancelProblem({ status: 400, body: { code: "not_found", message: "No such run." } })).toBe(
      "No such run.",
    )
  })

  test("a connected-tools approval is described in the hub's own words; a fix's approval shows its change as text", () => {
    const ask = (permission: string, metadata: Record<string, unknown>) =>
      permissionView({ id: "per_1", sessionID: "ses_1", permission, patterns: ["anthropic/claude"], metadata }, "/repo")
    const description = "Review with anthropic/claude: the diff goes to Your provider: anthropic, capped at $2.00."
    expect(ask("connect_model", { runID: "cr_01", description })).toEqual({
      id: "per_1",
      sessionID: "ses_1",
      directory: "/repo",
      title: "Send code to a review model",
      detail: description,
    })
    expect(ask("connect", { runID: "cr_01", description: "Hand this review to VectorScope." })).toMatchObject({
      title: "Hand work to a connected tool",
      detail: "Hand this review to VectorScope.",
    })
    // Not the hub's ask: no run, so the patterns are shown, never the description.
    expect(ask("connect_model", { description })).toMatchObject({ detail: "anthropic/claude" })
    const fix = "Apply VectorScope's fix for 1 finding."
    const diff = "--- a/src/a.ts\n+++ b/src/a.ts\n-old\n+new <b>bold</b>"
    expect(ask("connect_write", { runID: "cr_01", description: fix, diff })).toMatchObject({
      title: "Change files with a connected tool's fix",
      detail: `${fix}\n\n${diff}`,
    })
    const long = ask("connect_write", { runID: "cr_01", description: fix, diff: "+".repeat(20_000) })!
    expect(long.detail!.startsWith(`${fix}\n\n${"+".repeat(12_000)}\n\n`)).toBe(true)
    expect(long.detail!.endsWith("The rest of this change is shown only in Vector on your computer.")).toBe(true)
    expect(long.denyOnly).toBe(true)
    expect(ask("connect_write", { runID: "cr_01", description: fix })!.detail).toBe(
      `${fix}\n\nThe change itself is shown only in Vector on your computer.`,
    )
    // Format characters in the change show as their code point, still as text, so the code reads as it applies.
    expect(
      ask("connect_write", { runID: "cr_01", description: fix, diff: "+ok = 1\u202e\u2066 // x\u200b\n+\u{e0041}<i>" })!
        .detail,
    ).toBe(`${fix}\n\n+ok = 1[U+202E][U+2066] // x[U+200B]\n+[U+E0041]<i>`)
    // A cut change never ends in half of a surrogate pair, and keeps a whole pair that fits; it is marked after the cut.
    const rest = "\n\nThe rest of this change is shown only in Vector on your computer."
    const split = ask("connect_write", { runID: "cr_01", description: fix, diff: `\u200b${"+".repeat(11_998)}😀+` })!
    expect(split.detail).toBe(`${fix}\n\n[U+200B]${"+".repeat(11_998)}${rest}`)
    const whole = ask("connect_write", { runID: "cr_01", description: fix, diff: `${"+".repeat(11_998)}😀+` })!
    expect(whole.detail).toBe(`${fix}\n\n${"+".repeat(11_998)}😀${rest}`)
    // connect_cloud's presentation stays held (CN-14): it reads as any unknown permission.
    expect(ask("connect_cloud", { runID: "cr_01", description: "Send to Vector's cloud." })).toMatchObject({
      title: "Use connect_cloud",
      detail: "anthropic/claude",
      denyOnly: true,
    })
    expect(ask("connect_write", { runID: "cr_01", description: fix, diff: "" })).toMatchObject({ denyOnly: true })
    expect(ask("connect_write", { runID: "cr_01", description: fix, diff })?.denyOnly).toBeUndefined()
  })

  test("the open conversation's connected-tools asks: read once, then followed through events", () => {
    const pending = [
      {
        id: "per_1",
        sessionID: "ses_1",
        permission: "connect_model",
        patterns: ["a/b"],
        metadata: { runID: "cr_01", description: "Send it." },
      },
      {
        id: "per_2",
        sessionID: "ses_2",
        permission: "connect_model",
        patterns: ["a/b"],
        metadata: { runID: "cr_02", description: "Send it." },
      },
      { id: "per_3", sessionID: "ses_1", permission: "bash", patterns: ["ls"], metadata: {} },
      { id: "per_4", sessionID: "ses_1", permission: "connect", patterns: ["vectorscope.review"], metadata: {} },
    ]
    const asks = connectAsks(pending, "/repo", "ses_1")
    expect(asks.map((item) => [item.id, item.title, item.detail])).toEqual([
      ["per_1", "Send code to a review model", "Send it."],
    ])
    expect(connectAsks({ items: pending }, "/repo", "ses_1")).toEqual([])
    const event = (type: string, properties: unknown, truncated = false) =>
      applyConnectAskEvent(asks, "ses_1", { directory: "/repo", type, properties, ...(truncated ? { truncated } : {}) })
    expect(event("permission.asked", { ...pending[0], id: "per_5" }).asks.map((item) => item.id)).toEqual([
      "per_1",
      "per_5",
    ])
    expect(event("permission.asked", pending[0]).asks).toHaveLength(1)
    expect(event("permission.asked", pending[1])).toEqual({ asks, stale: false })
    expect(event("permission.asked", pending[2])).toEqual({ asks, stale: false })
    expect(event("permission.asked", { sessionID: "ses_1", id: "per_6" }, true)).toEqual({ asks, stale: true })
    expect(event("permission.asked", { sessionID: "ses_2", id: "per_6" }, true)).toEqual({ asks, stale: false })
    expect(event("question.asked", { sessionID: "ses_1", id: "que_1" }, true)).toEqual({ asks, stale: false })
    expect(event("permission.replied", { sessionID: "ses_1", requestID: "per_1", reply: "once" })).toEqual({
      asks: [],
      stale: false,
    })
  })

  test("runs are read again when this conversation's turn ends, one of its connect parts changes or a run does", () => {
    const changed = (type: string, properties: unknown, truncated = false) =>
      connectRunsChanged({ directory: "/repo", type, properties, ...(truncated ? { truncated } : {}) }, "ses_1")
    expect(changed("session.idle", { sessionID: "ses_1" })).toBe(true)
    expect(changed("session.status", { sessionID: "ses_1", status: { type: "busy" } })).toBe(true)
    expect(changed("session.error", { sessionID: "ses_1" })).toBe(true)
    expect(changed("session.idle", { sessionID: "ses_2" })).toBe(false)
    // Once the computer streams it, a run's own update also counts, which a review started from the phone needs.
    expect(changed("connect.run.updated", { sessionID: "ses_1", run: running("cr_01") })).toBe(true)
    expect(changed("connect.run.updated", { sessionID: "ses_1" }, true)).toBe(true)
    expect(changed("connect.run.updated", { sessionID: "ses_2", run: running("cr_01") })).toBe(false)
    expect(changed("connect.run.updated", { run: running("cr_01") })).toBe(false)
    expect(changed("message.part.updated", { part: connectPart(running("cr_01")) })).toBe(true)
    expect(changed("message.part.updated", { part: { ...connectPart(running("cr_01")), tool: "bash" } })).toBe(false)
    // A part too large to stream arrives without its tool name: read again to be sure.
    expect(changed("message.part.updated", { sessionID: "ses_1", messageID: "msg_2", partID: "p9" }, true)).toBe(true)
    expect(changed("message.part.updated", { sessionID: "ses_2", messageID: "msg_2", partID: "p9" }, true)).toBe(false)
    expect(changed("message.part.delta", { sessionID: "ses_1" })).toBe(false)
  })
})
