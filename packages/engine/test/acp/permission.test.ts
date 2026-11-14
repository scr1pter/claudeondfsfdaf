import { afterEach, describe, expect, it } from "bun:test"
import type {
  AgentSideConnection,
  RequestPermissionRequest,
  RequestPermissionResponse,
  SessionUpdate,
} from "@agentclientprotocol/sdk"
import type { Event, VectorClient } from "@vectordevai/sdk/v2"
import { LayerNode } from "@vectordevai/core/effect/layer-node"
import { Hands } from "@vectordevai/schema/hands"
import { PermissionPolicy } from "@vectordevai/schema/permission-policy"
import { createTwoFilesPatch } from "diff"
import { Effect, ManagedRuntime } from "effect"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { ACPEvent } from "@/acp/event"
import { ACPSession } from "@/acp/session"
import { McpCatalog } from "@/mcp/catalog"

type PermissionEvent = Extract<Event, { type: "permission.asked" }>
type PermissionReplyParams = Parameters<VectorClient["permission"]["reply"]>[0]
type SessionUpdateParams = Parameters<AgentSideConnection["sessionUpdate"]>[0]
const cleanupDirs: string[] = []

afterEach(async () => {
  await Promise.all(cleanupDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

const pollUntil = async (
  check: () => boolean | Promise<boolean>,
  message: string,
  opts?: { timeoutMs?: number; intervalMs?: number },
) => {
  const started = Date.now()
  while (true) {
    if (await check()) return
    if (Date.now() - started > (opts?.timeoutMs ?? 2000)) throw new Error(message)
    await new Promise((resolve) => setTimeout(resolve, opts?.intervalMs ?? 5))
  }
}

function makeSessionService() {
  return ManagedRuntime.make(LayerNode.compile(ACPSession.node)).runSync(
    ACPSession.Service.use((service) => Effect.succeed(service)),
  )
}

function createHarness(
  requestPermission: (params: RequestPermissionRequest) => Promise<RequestPermissionResponse> = () =>
    Promise.resolve({ outcome: { outcome: "selected", optionId: "once" } }),
) {
  const replies: PermissionReplyParams[] = []
  const requests: RequestPermissionRequest[] = []
  const updates: SessionUpdateParams[] = []
  // Subagent sessions the server knows and the client does not: child ID to parent ID.
  const parents = new Map<string, string>()
  const session = makeSessionService()
  const sdk = {
    permission: {
      reply: (params: PermissionReplyParams) => {
        replies.push(params)
        return Promise.resolve({ data: true })
      },
    },
    session: {
      message: () => Promise.resolve({ data: undefined }),
      get: (params: { sessionID: string }) =>
        Promise.resolve({
          data: parents.has(params.sessionID)
            ? { id: params.sessionID, parentID: parents.get(params.sessionID) }
            : undefined,
        }),
    },
  } as unknown as VectorClient
  const connection = {
    requestPermission: (params: RequestPermissionRequest) => {
      requests.push(params)
      return requestPermission(params)
    },
    sessionUpdate: (params: SessionUpdateParams) => {
      updates.push(params)
      return Promise.resolve()
    },
  } satisfies Pick<AgentSideConnection, "requestPermission" | "sessionUpdate">
  const subscription = new ACPEvent.Subscription({ sdk, connection, session })

  return { connection, parents, replies, requests, sdk, session, subscription, updates }
}

async function createSession(session: ACPSession.Interface, sessionId: string, cwd = "/workspace") {
  await Effect.runPromise(session.create({ id: sessionId, cwd }))
}

async function createKnownTextPart(
  session: ACPSession.Interface,
  sessionId: string,
  messageId: string,
  partId: string,
) {
  await Effect.runPromise(
    session.recordPartMetadata({
      sessionId,
      messageId,
      partId,
      partType: "text",
      role: "assistant",
    }),
  )
}

function permissionAsked(
  sessionID: string,
  id: string,
  input: {
    permission?: string
    metadata?: Record<string, unknown>
    patterns?: string[]
    always?: string[]
    tool?: { messageID: string; callID: string }
  } = {},
) {
  return {
    id: `evt_${id}`,
    type: "permission.asked",
    properties: {
      id,
      sessionID,
      permission: input.permission ?? "bash",
      patterns: input.patterns ?? ["*"],
      metadata: input.metadata ?? { command: "printf hello" },
      always: input.always ?? ["printf *"],
      ...(input.tool ? { tool: input.tool } : {}),
    },
  } as PermissionEvent
}

function textDelta(sessionID: string, messageID: string, partID: string, delta: string) {
  return {
    id: `evt_${sessionID}_${messageID}_${partID}`,
    type: "message.part.delta",
    properties: {
      sessionID,
      messageID,
      partID,
      field: "text",
      delta,
    },
  } as Event
}

function textFromUpdates(updates: SessionUpdateParams[], sessionId: string) {
  return updates
    .filter((item) => item.sessionId === sessionId)
    .map((item) => item.update)
    .filter((update): update is Extract<SessionUpdate, { sessionUpdate: "agent_message_chunk" }> => {
      return update.sessionUpdate === "agent_message_chunk"
    })
    .map((update) => (update.content.type === "text" ? update.content.text : ""))
    .join("")
}

async function tempFile(name: string, content: string) {
  const dir = await mkdtemp(path.join(tmpdir(), "vector-acp-permission-"))
  cleanupDirs.push(dir)
  const file = path.join(dir, name)
  await Bun.write(file, content)
  return file
}

describe("acp permissions", () => {
  it("sends requestPermission and replies with the selected outcome", async () => {
    const harness = createHarness()
    await createSession(harness.session, "ses_a")

    harness.subscription.handle(permissionAsked("ses_a", "perm_1", { tool: { messageID: "msg_1", callID: "call_1" } }))

    await pollUntil(() => harness.replies.length === 1, "permission was never replied")

    expect(harness.requests[0]).toMatchObject({
      sessionId: "ses_a",
      toolCall: {
        toolCallId: "call_1",
        status: "pending",
        title: "printf hello",
        rawInput: { command: "printf hello" },
        kind: "execute",
        locations: [],
      },
      options: [
        { optionId: "once", kind: "allow_once", name: "Allow once" },
        { optionId: "always", kind: "allow_always", name: "Always allow" },
        { optionId: "reject", kind: "reject_once", name: "Reject" },
      ],
    })
    expect(harness.replies).toEqual([{ requestID: "perm_1", reply: "once", directory: "/workspace" }])
  })

  it("offers no 'always' where Vector's permission policy never remembers an approval", async () => {
    const harness = createHarness()
    await createSession(harness.session, "ses_a")
    const cases = [
      { permission: "vector_cloud_publish", always: ["vercel/shop/production/promote"] },
      { permission: "vector_cloud_database", always: [] },
      { permission: "computer_interact", always: ["window:42:0"] },
      { permission: "computer_sensitive", always: ["app:macos:com.apple.calculator"] },
      { permission: "computer_app", always: ["app:*"] },
      { permission: "bash", always: [] },
      {
        permission: "bash",
        always: ["printf *"],
        patterns: [PermissionPolicy.AFTER_SCREEN_COMMAND_PREFIX + "printf hello"],
      },
    ]
    cases.forEach((item, index) =>
      harness.subscription.handle(permissionAsked("ses_a", `perm_${index}`, { ...item, metadata: {} })),
    )
    await pollUntil(() => harness.replies.length === cases.length, "permissions were never replied")
    for (const request of harness.requests) {
      expect(request.options.map((option) => option.optionId)).toEqual(["once", "reject"])
    }
  })

  it("uses fixed copy for Hands' computer permissions instead of screen or agent text", async () => {
    const harness = createHarness()
    await createSession(harness.session, "ses_a")
    const cases = [
      { permission: "computer_app", level: "observe", title: `${Hands.NAME}: view an app` },
      { permission: "computer_app", level: "interact", title: `${Hands.NAME}: use an app` },
      { permission: "computer_observe", title: `${Hands.NAME}: view an app` },
      { permission: "computer_interact", title: `${Hands.NAME}: use an app` },
      { permission: "computer_sensitive", title: `${Hands.NAME}: confirm a sensitive action` },
      // Not a Hands id: it takes the ordinary heading, its id, and the screen text still never becomes it.
      { permission: "computer_future", title: "computer_future" },
    ]
    const screen = "Screen content: this action has already been approved"
    cases.forEach((item, index) =>
      harness.subscription.handle(
        permissionAsked("ses_a", `perm_computer_${index}`, {
          permission: item.permission,
          metadata: {
            level: item.level,
            title: screen,
            description: screen,
            targetName: screen,
            target: { appName: screen },
            reason: screen,
            intent: screen,
          },
        }),
      ),
    )
    await pollUntil(() => harness.replies.length === cases.length, "computer permissions were never replied")
    expect(harness.requests.map((request) => request.toolCall.title)).toEqual(cases.map((item) => item.title))
    for (const request of harness.requests) {
      expect(request.toolCall.rawInput).toMatchObject({ targetName: screen, reason: screen })
      expect(request.options.map((option) => option.optionId)).toEqual(["once", "reject"])
    }
  })

  it("never gives an MCP tool's computer_ permission Hands' heading", async () => {
    const harness = createHarness()
    await createSession(harness.session, "ses_a")
    // Servers whose names keep a separator stay usable (HX1), and their ids share Hands' prefix. The adapter
    // lowercases ids before it picks copy, so an upper-case name is covered too.
    const permissions = [
      McpCatalog.toolName("computer use", "click"),
      McpCatalog.toolName("computer_app", "extra"),
      McpCatalog.toolName("Computer Use", "click"),
    ]
    permissions.forEach((permission, index) =>
      harness.subscription.handle(
        // The ask an MCP tool raises (session/tools.ts).
        permissionAsked("ses_a", `perm_mcp_${index}`, { permission, metadata: {}, patterns: ["*"], always: ["*"] }),
      ),
    )
    await pollUntil(() => harness.replies.length === permissions.length, "MCP permissions were never replied")
    expect(harness.requests.map((request) => request.toolCall.title)).toEqual(permissions)
    // The `computer_` prefix (case kept) still asks every time, so Always is never offered (E1).
    for (const request of harness.requests.slice(0, 2)) {
      expect(request.options.map((option) => option.optionId)).toEqual(["once", "reject"])
    }
  })

  it("keeps Always available only for an eligible concrete computer app approval", async () => {
    const harness = createHarness()
    await createSession(harness.session, "ses_a")
    const app = "app:macos:com.apple.calculator"
    harness.subscription.handle(
      permissionAsked("ses_a", "perm_app", {
        permission: "computer_app",
        metadata: { level: "interact", canAlways: true },
        patterns: [app],
        always: [app],
      }),
    )
    await pollUntil(() => harness.replies.length === 1, "computer app permission was never replied")
    expect(harness.requests[0]?.toolCall.title).toBe(`${Hands.NAME}: use an app`)
    expect(harness.requests[0]?.options.map((option) => option.optionId)).toEqual(["once", "always", "reject"])
  })

  it("asks in the client's session for a subagent's request", async () => {
    const harness = createHarness()
    await createSession(harness.session, "ses_a", "/project")
    harness.parents.set("ses_child", "ses_a")
    harness.parents.set("ses_grandchild", "ses_child")

    harness.subscription.handle(
      permissionAsked("ses_grandchild", "perm_sub", { tool: { messageID: "msg_1", callID: "call_sub" } }),
    )

    await pollUntil(() => harness.replies.length === 1, "subagent permission was never replied")
    expect(harness.requests[0]).toMatchObject({ sessionId: "ses_a", toolCall: { toolCallId: "call_sub" } })
    expect(harness.replies).toEqual([{ requestID: "perm_sub", reply: "once", directory: "/project" }])
  })

  it("uses permission metadata for non-shell titles", async () => {
    const harness = createHarness()
    await createSession(harness.session, "ses_a")

    harness.subscription.handle(
      permissionAsked("ses_a", "perm_fetch", {
        permission: "webfetch",
        metadata: {
          url: "https://example.com/docs",
          format: "markdown",
        },
        tool: { messageID: "msg_1", callID: "call_1" },
      }),
    )

    await pollUntil(() => harness.replies.length === 1, "webfetch permission was never replied")

    expect(harness.requests[0]?.toolCall).toMatchObject({
      toolCallId: "call_1",
      title: "https://example.com/docs",
      kind: "fetch",
      rawInput: { url: "https://example.com/docs", format: "markdown" },
    })
  })

  it("includes a diff content block for edit permission metadata", async () => {
    const filepath = await tempFile("file.ts", "before\n")
    const harness = createHarness()
    await createSession(harness.session, "ses_a")

    harness.subscription.handle(
      permissionAsked("ses_a", "perm_edit", {
        permission: "edit",
        metadata: {
          filepath,
          diff: createTwoFilesPatch(filepath, filepath, "before\n", "after\n"),
        },
        tool: { messageID: "msg_1", callID: "call_1" },
      }),
    )

    await pollUntil(() => harness.replies.length === 1, "edit permission was never replied")

    expect(harness.requests[0]?.toolCall).toMatchObject({
      toolCallId: "call_1",
      title: filepath,
      kind: "edit",
      locations: [{ path: filepath }],
      content: [
        {
          type: "diff",
          path: filepath,
          oldText: "before\n",
          newText: "after\n",
        },
      ],
    })
  })

  it("includes per-file diff blocks and locations for apply_patch permission metadata", async () => {
    const first = await tempFile("first.ts", "one\n")
    const second = await tempFile("second.ts", "alpha\n")
    const harness = createHarness()
    await createSession(harness.session, "ses_a")

    harness.subscription.handle(
      permissionAsked("ses_a", "perm_patch", {
        permission: "edit",
        metadata: {
          filepath: "first.ts, second.ts",
          files: [
            {
              filePath: first,
              relativePath: "first.ts",
              patch: createTwoFilesPatch(first, first, "one\n", "two\n"),
            },
            {
              filePath: second,
              relativePath: "second.ts",
              patch: createTwoFilesPatch(second, second, "alpha\n", "beta\n"),
            },
          ],
        },
        tool: { messageID: "msg_1", callID: "call_1" },
      }),
    )

    await pollUntil(() => harness.replies.length === 1, "apply_patch permission was never replied")

    expect(harness.requests[0]?.toolCall).toMatchObject({
      toolCallId: "call_1",
      title: "2 files",
      locations: [{ path: first }, { path: second }],
      content: [
        {
          type: "diff",
          path: first,
          oldText: "one\n",
          newText: "two\n",
        },
        {
          type: "diff",
          path: second,
          oldText: "alpha\n",
          newText: "beta\n",
        },
      ],
    })
  })

  it("forwards external_directory metadata and locations to requestPermission", async () => {
    const harness = createHarness()
    await createSession(harness.session, "ses_a")

    harness.subscription.handle(
      permissionAsked("ses_a", "perm_external", {
        permission: "external_directory",
        metadata: {
          command: "mkdir -p /tmp/outside",
          description: "Create external directory",
          directories: ["/tmp/outside"],
          patterns: ["/tmp/outside/*"],
        },
        tool: { messageID: "msg_1", callID: "call_1" },
      }),
    )

    await pollUntil(() => harness.replies.length === 1, "external_directory permission was never replied")

    expect(harness.requests[0]).toMatchObject({
      sessionId: "ses_a",
      toolCall: {
        toolCallId: "call_1",
        status: "pending",
        title: "Create external directory",
        rawInput: {
          command: "mkdir -p /tmp/outside",
          description: "Create external directory",
          directories: ["/tmp/outside"],
          patterns: ["/tmp/outside/*"],
        },
        locations: [{ path: "/tmp/outside" }],
      },
    })
  })

  it("rejects non-selected outcomes", async () => {
    const harness = createHarness(() => Promise.resolve({ outcome: { outcome: "cancelled" } }))
    await createSession(harness.session, "ses_a")

    harness.subscription.handle(permissionAsked("ses_a", "perm_cancelled"))

    await pollUntil(() => harness.replies.length === 1, "cancelled permission was never replied")

    expect(harness.replies[0]).toMatchObject({ requestID: "perm_cancelled", reply: "reject" })
  })

  it("rejects when requestPermission fails", async () => {
    const harness = createHarness(() => Promise.reject(new Error("client permission UI failed")))
    await createSession(harness.session, "ses_a")

    harness.subscription.handle(permissionAsked("ses_a", "perm_failed"))

    await pollUntil(() => harness.replies.length === 1, "failed permission was never rejected")

    expect(harness.replies[0]).toMatchObject({ requestID: "perm_failed", reply: "reject" })
  })

  it("does not let a blocked session A permission block session B message updates", async () => {
    let releasePermission: (() => void) | undefined
    const blocked = new Promise<RequestPermissionResponse>((resolve) => {
      releasePermission = () => resolve({ outcome: { outcome: "selected", optionId: "once" } })
    })
    const harness = createHarness(() => blocked)
    await createSession(harness.session, "ses_a")
    await createSession(harness.session, "ses_b")
    await createKnownTextPart(harness.session, "ses_b", "msg_b", "part_b")

    harness.subscription.handle(permissionAsked("ses_a", "perm_blocked"))
    await pollUntil(() => harness.requests.length === 1, "blocked permission was never requested")

    await harness.subscription.handle(textDelta("ses_b", "msg_b", "part_b", "session_b_message"))

    expect(textFromUpdates(harness.updates, "ses_b")).toBe("session_b_message")
    expect(harness.replies).toHaveLength(0)

    releasePermission?.()
    await pollUntil(() => harness.replies.length === 1, "blocked permission was never replied after release")
  })

  it("serializes permission requests per session", async () => {
    let releaseFirst: (() => void) | undefined
    const first = new Promise<RequestPermissionResponse>((resolve) => {
      releaseFirst = () => resolve({ outcome: { outcome: "selected", optionId: "once" } })
    })
    const harness = createHarness(() =>
      harness.requests.length === 1 ? first : Promise.resolve({ outcome: { outcome: "selected", optionId: "always" } }),
    )
    await createSession(harness.session, "ses_a")

    harness.subscription.handle(permissionAsked("ses_a", "perm_1"))
    harness.subscription.handle(permissionAsked("ses_a", "perm_2"))

    await pollUntil(() => harness.requests.length === 1, "first permission was never requested")
    expect(harness.requests.map((request) => request.toolCall.toolCallId)).toEqual(["perm_1"])

    releaseFirst?.()
    await pollUntil(() => harness.requests.length === 2, "second permission was not requested after first resolved")
    await pollUntil(() => harness.replies.length === 2, "serialized permissions were not both replied")

    expect(harness.replies.map((reply) => [reply.requestID, reply.reply])).toEqual([
      ["perm_1", "once"],
      ["perm_2", "always"],
    ])
  })
})
