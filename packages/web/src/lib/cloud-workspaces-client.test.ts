import { describe, expect, test } from "bun:test"
import {
  cloudWorkspaceLocation,
  cloudWorkspacePath,
  cloudWorkspacesClient,
  normalizeCloudRepository,
  readCloudMessages,
  readCloudChanges,
  readCloudModels,
  readCloudPermissions,
  readCloudQuestions,
  readCloudPullRequest,
  readCloudSessions,
  readCloudSessionStatuses,
  readCloudWorkspace,
} from "./cloud-workspaces-client"

const workspace = {
  id: "095f49dd-c5a0-4d90-ad7c-36314f95d6c5",
  repository: "vector/example",
  branch: "main",
  title: "Example",
  state: "running" as const,
  createdAt: 100,
  updatedAt: 200,
  revision: 1,
}

describe("account cloud workspace gateway", () => {
  test("uses the same-origin authenticated endpoint and keeps engine selectors inside the command", async () => {
    const requests: Request[] = []
    const client = cloudWorkspacesClient("account-test-token", async (input, init) => {
      requests.push(new Request(new URL(String(input), "https://vectordev.ai"), init))
      return Response.json([{ id: "ses_123", title: "Saved", time: { updated: 200 } }])
    })
    const sessions = readCloudSessions(
      await client.engine("095f49dd-c5a0-4d90-ad7c-36314f95d6c5", "/session?roots=true&limit=50"),
    )
    expect(sessions[0].title).toBe("Saved")
    expect(requests[0].url).toBe("https://vectordev.ai/api/cloud-workspaces")
    expect(requests[0].headers.get("authorization")).toBe("Bearer account-test-token")
    expect(requests[0].redirect).toBe("error")
    expect(requests[0].cache).toBe("no-store")
    expect(await requests[0].json()).toEqual({
      action: "engine",
      workspaceId: "095f49dd-c5a0-4d90-ad7c-36314f95d6c5",
      path: "/session?roots=true&limit=50",
      method: "GET",
    })
  })

  test("sends a create identity and optional private-clone credential only in the request body", async () => {
    const requests: Request[] = []
    const client = cloudWorkspacesClient("test-token", async (input, init) => {
      requests.push(new Request(new URL(String(input), "https://vectordev.ai"), init))
      return Response.json({ workspace })
    })
    expect(
      await client.create({
        repository: "vector/example",
        idempotencyKey: "same-create-id",
        githubToken: "fixture_github_token_for_client",
      }),
    ).toEqual(workspace)
    expect(requests[0].url).not.toContain("token")
    expect(await requests[0].json()).toEqual({
      action: "create",
      repository: "vector/example",
      idempotencyKey: "same-create-id",
      githubToken: "fixture_github_token_for_client",
    })
  })

  test("preserves explicit disabled state without inventing a workspace", async () => {
    const client = cloudWorkspacesClient("test-token", async () => Response.json({ enabled: false, workspaces: [] }))
    expect(await client.list()).toEqual({ enabled: false, workspaces: [] })
  })

  test("treats an actual accepted 204 as no content and never retries a prompt", async () => {
    let calls = 0
    const client = cloudWorkspacesClient("test-token", async () => {
      calls++
      return new Response(null, { status: 204 })
    })
    expect(
      await client.engine("095f49dd-c5a0-4d90-ad7c-36314f95d6c5", "/session/ses_123/prompt_async", "POST", {
        messageID: "msg_stable",
      }),
    ).toBeNull()
    expect(calls).toBe(1)
  })

  test("allocates the canonical server message ID with the caller's stable request identity", async () => {
    const commands: unknown[] = []
    const messageID = `msg_${"0".repeat(25)}1`
    const requestID = "4ea2f733-1d82-4587-a749-5b54c9bf5628"
    const client = cloudWorkspacesClient("test-token", async (_input, init) => {
      commands.push(JSON.parse(String(init?.body)))
      return Response.json({ messageID })
    })
    expect(await client.allocateMessageId(workspace.id, "ses_123", requestID)).toBe(messageID)
    expect(await client.allocateMessageId(workspace.id, "ses_123", requestID)).toBe(messageID)
    expect(commands).toEqual(
      Array.from({ length: 2 }, () => ({
        action: "engine",
        workspaceId: workspace.id,
        path: "/session/ses_123/message_id",
        method: "POST",
        body: { requestID },
      })),
    )
  })

  test("does not retry a lost allocation response and rejects client-invented ID shapes", async () => {
    let calls = 0
    const lost = cloudWorkspacesClient("test-token", async () => {
      calls++
      throw new Error("Allocation response lost")
    })
    await expect(
      lost.allocateMessageId(workspace.id, "ses_123", "4ea2f733-1d82-4587-a749-5b54c9bf5628"),
    ).rejects.toThrow("Allocation response lost")
    expect(calls).toBe(1)
    for (const messageID of [
      "msg_" + crypto.randomUUID().replaceAll("-", ""),
      "msg_short",
      "msg_" + "0".repeat(27),
      "other_" + "0".repeat(26),
      123,
      undefined,
    ]) {
      const invalid = cloudWorkspacesClient("test-token", async () => Response.json({ messageID }))
      await expect(
        invalid.allocateMessageId(workspace.id, "ses_123", "4ea2f733-1d82-4587-a749-5b54c9bf5628"),
      ).rejects.toThrow("prepare a message identifier")
    }
  })

  test("keeps an unavailable service honest, including HTML platform fallbacks", async () => {
    const client = cloudWorkspacesClient(
      "test-token",
      async () => new Response("<title>Unavailable</title>", { status: 503, headers: { "content-type": "text/html" } }),
    )
    await expect(client.list()).rejects.toThrow("Vector could not reach your cloud workspace")
    const denied = cloudWorkspacesClient("test-token", async () =>
      Response.json({ error: { message: "Cloud workspaces are disabled." } }, { status: 503 }),
    )
    await expect(denied.list()).rejects.toThrow("Cloud workspaces are disabled.")
  })

  test("does not claim deletion from a merely successful HTTP status", async () => {
    const client = cloudWorkspacesClient("test-token", async () => Response.json({ deleted: false }))
    await expect(client.remove("095f49dd-c5a0-4d90-ad7c-36314f95d6c5")).rejects.toThrow("confirm workspace deletion")
  })

  test("binds publishing to the returned paused review digest and confirms actual PR metadata", async () => {
    const requests: Record<string, unknown>[] = []
    const changes = { digest: "a".repeat(64), diff: "+export const ready = true\n", files: ["src/index.ts"] }
    const pullRequest = {
      url: "https://github.com/vector/example/pull/37",
      branch: "vector/workspace-changes",
      commit: "b".repeat(40),
    }
    const client = cloudWorkspacesClient("test-token", async (_input, init) => {
      const command = JSON.parse(String(init?.body)) as Record<string, unknown>
      requests.push(command)
      return command.action === "changes"
        ? Response.json({ workspace: { ...workspace, state: "stopped" }, changes })
        : Response.json({ workspace: { ...workspace, state: "stopped" }, pullRequest })
    })
    const reviewed = await client.changes(workspace.id)
    expect(reviewed.workspace.state).toBe("stopped")
    expect(reviewed.changes).toEqual(changes)
    const published = await client.publish({
      workspaceId: workspace.id,
      digest: reviewed.changes.digest,
      githubToken: "fixture_github_token_for_client",
      title: "Fix repository",
    })
    expect(published.pullRequest).toEqual(pullRequest)
    expect(requests).toEqual([
      { action: "changes", workspaceId: workspace.id },
      {
        action: "publish",
        workspaceId: workspace.id,
        digest: changes.digest,
        githubToken: "fixture_github_token_for_client",
        title: "Fix repository",
      },
    ])
  })

  test("never treats incomplete publication or a stale-review response as a pull request", async () => {
    const incomplete = cloudWorkspacesClient("test-token", async () =>
      Response.json({ workspace: { ...workspace, state: "stopped" } }),
    )
    await expect(
      incomplete.publish({
        workspaceId: workspace.id,
        digest: "a".repeat(64),
        githubToken: "fixture_github_token_for_client",
        title: "Fix repository",
      }),
    ).rejects.toThrow("confirm the draft pull request")
    const stale = cloudWorkspacesClient("test-token", async () =>
      Response.json({ error: { message: "Changes have changed. Review again." } }, { status: 409 }),
    )
    await expect(
      stale.publish({
        workspaceId: workspace.id,
        digest: "a".repeat(64),
        githubToken: "fixture_github_token_for_client",
        title: "Fix repository",
      }),
    ).rejects.toThrow("Changes have changed. Review again.")
  })
})

describe("cloud workspace projections", () => {
  test("requires a real review digest and a bounded GitHub pull-request destination", () => {
    expect(readCloudChanges({ digest: "a".repeat(64), diff: "", files: [] })).toEqual({
      digest: "a".repeat(64),
      diff: "",
      files: [],
    })
    expect(() => readCloudChanges({ digest: "old", diff: "", files: [] })).toThrow()
    const pullRequest = {
      url: "https://github.com/vector/example/pull/37",
      branch: "vector/workspace-changes",
      commit: "b".repeat(40),
    }
    expect(readCloudPullRequest(pullRequest)).toEqual(pullRequest)
    for (const url of [
      "https://attacker.example/vector/example/pull/37",
      "javascript:alert(1)",
      "https://github.com/vector/example/pull/37?token=private",
      "https://user@github.com/vector/example/pull/37",
      "https://github.com/vector/example/issues/37",
    ])
      expect(() => readCloudPullRequest({ ...pullRequest, url })).toThrow()
    expect(() => readCloudPullRequest({ ...pullRequest, commit: "not-confirmed" })).toThrow()
  })
  test("requires actual state and strips internal infrastructure fields", () => {
    expect(readCloudWorkspace({ ...workspace, engineUrl: "https://private.example", engineToken: "private" })).toEqual(
      workspace,
    )
    expect(() => readCloudWorkspace({ ...workspace, state: "success" })).toThrow()
    expect(() => readCloudWorkspace({ ...workspace, revision: undefined })).toThrow()
    expect(() => readCloudWorkspace({ ...workspace, createdAt: "today" })).toThrow()
  })

  test("only offers models that the workspace reports connected", () => {
    expect(
      readCloudModels({
        connected: ["vector-cloud"],
        default: { "vector-cloud": "ready" },
        all: [
          {
            id: "vector-cloud",
            name: "Cloud",
            key: "never-projected",
            models: { ready: { name: "Ready model" }, old: { name: "Old model", status: "deprecated" } },
          },
          { id: "not-connected", name: "Unconfigured", models: { hidden: { name: "Do not offer" } } },
        ],
      }),
    ).toEqual([
      { providerID: "vector-cloud", modelID: "ready", name: "Ready model", provider: "Cloud", preferred: true },
    ])
  })

  test("shows saved assistant text and real tool outcomes without manufacturing completion", () => {
    const input = [
      {
        info: { id: "msg_reply", role: "assistant", time: { created: 300 } },
        parts: [
          { id: "prt_text", type: "text", text: "Working on the repository." },
          {
            id: "prt_tool",
            type: "tool",
            tool: "bash",
            state: { status: "running", title: "Run tests", input: { secret: "not-projected" } },
          },
          { id: "prt_hidden", type: "text", ignored: true, text: "Hidden internal text" },
          { id: "prt_unknown", type: "unknown", privateMetadata: "not-projected" },
        ],
      },
    ]
    expect(readCloudMessages(input)).toEqual([
      {
        id: "msg_reply",
        role: "assistant",
        createdAt: 300,
        completed: false,
        parts: [
          { id: "prt_text", type: "text", text: "Working on the repository." },
          { id: "prt_tool", type: "tool", name: "bash", status: "running", title: "Run tests" },
        ],
      },
    ])
    expect(
      readCloudMessages([{ ...input[0], info: { ...input[0].info, time: { created: 300, completed: 400 } } }])[0]
        .completed,
    ).toBe(true)
    expect(() => readCloudMessages([{ info: { role: "assistant" }, parts: [] }])).toThrow()
  })

  test("retains engine error and retry states instead of treating an accepted request as a reply", () => {
    expect(
      readCloudMessages([
        {
          info: {
            id: "msg_fail",
            role: "assistant",
            time: { created: 300, completed: 400 },
            error: { data: { message: "Provider unavailable" } },
          },
          parts: [],
        },
      ])[0].error,
    ).toBe("Provider unavailable")
    expect(
      readCloudSessionStatuses({ ses_123: { type: "retry", attempt: 1, message: "Waiting for model", next: 100 } }),
    ).toEqual({ ses_123: { type: "retry", message: "Waiting for model" } })
    expect(() => readCloudSessionStatuses({ ses_123: { type: "completed" } })).toThrow()
  })

  test("projects pending approvals and structured questions from the engine", () => {
    expect(
      readCloudPermissions([
        {
          id: "per_123",
          sessionID: "ses_123",
          permission: "bash",
          patterns: ["bun test"],
          always: ["*"],
          metadata: { secret: "not-projected" },
        },
      ]),
    ).toEqual([{ id: "per_123", sessionID: "ses_123", permission: "bash", patterns: ["bun test"] }])
    expect(
      readCloudQuestions([
        {
          id: "que_123",
          sessionID: "ses_123",
          questions: [
            {
              header: "Scope",
              question: "Which change?",
              options: [{ label: "Fix", description: "Fix the issue" }],
              custom: false,
            },
          ],
        },
      ]),
    ).toEqual([
      {
        id: "que_123",
        sessionID: "ses_123",
        questions: [
          {
            header: "Scope",
            question: "Which change?",
            options: [{ label: "Fix", description: "Fix the issue" }],
            multiple: false,
            custom: false,
          },
        ],
      },
    ])
    expect(() =>
      readCloudPermissions([{ id: "per_123", sessionID: "ses_123", permission: "bash", patterns: [1] }]),
    ).toThrow()
    expect(() =>
      readCloudQuestions([{ id: "que_123", sessionID: "ses_123", questions: [{ question: "Which?", options: [] }] }]),
    ).toThrow()
  })
})

describe("saved cloud chat links and repository input", () => {
  test("keeps only workspace/session identity in the link", () => {
    expect(cloudWorkspacePath("ws_one", "ses_saved")).toBe("/workspaces?workspace=ws_one&session=ses_saved")
    expect(cloudWorkspaceLocation("?workspace=ws_one&session=ses_saved&token=ignored")).toEqual({
      workspace: "ws_one",
      session: "ses_saved",
    })
    expect(cloudWorkspacePath("", "ses_orphan")).toBe("/workspaces")
  })

  test("accepts GitHub owner/repo and HTTPS clone URLs, rejecting other destinations and credentials", () => {
    expect(normalizeCloudRepository(" vector/example ")).toBe("vector/example")
    expect(normalizeCloudRepository("https://github.com/vector/example.git")).toBe("vector/example")
    for (const value of [
      "https://attacker.example/vector/example",
      "https://token@github.com/vector/example",
      "vector/example?token=private",
      "vector/..",
      "../example",
      "vector/example/extra",
    ])
      expect(() => normalizeCloudRepository(value)).toThrow()
  })
})
