/** @jsxImportSource @opentui/solid */
import { describe, expect, test } from "bun:test"
import { tmpdir } from "../../../fixture/fixture"
import { directory, json, mount, wait } from "./sync-fixture"
import { useConnected } from "../../../../src/component/use-connected"
import type { GlobalEvent, PermissionRequest } from "@vectordevai/sdk/v2"

function branchEvent(branch: string, workspace?: string): GlobalEvent {
  return {
    directory: "/tmp/other",
    project: "proj_test",
    workspace,
    payload: {
      id: `evt_vcs_${branch}`,
      type: "vcs.branch.updated",
      properties: { branch },
    },
  }
}

describe("tui sync", () => {
  test("bootstrap hydrates provider and configuration data without hosted console requests", async () => {
    await using tmp = await tmpdir()
    await Bun.write(`${tmp.path}/kv.json`, "{}")
    const requests: string[] = []
    const provider = {
      id: "custom-gateway",
      name: "Custom gateway",
      source: "config" as const,
      env: [],
      options: {},
      models: {},
    }
    const agent = { name: "build", mode: "primary" as const, options: {}, permission: [] }
    const { app, sync } = await mount((url) => {
      requests.push(url.pathname)
      if (url.pathname === "/provider") return json({ all: [provider], connected: [provider.id], default: {} })
      if (url.pathname === "/config/providers") return json({ providers: [provider], default: {} })
      if (url.pathname === "/provider/auth") return json({ [provider.id]: [{ type: "api", label: "API key" }] })
      if (url.pathname === "/agent") return json([agent])
      if (url.pathname === "/config") return json({ model: "custom-gateway/model" })
      if (url.pathname === "/experimental/capabilities") return json({ backgroundSubagents: true })
    }, tmp.path)
    try {
      expect(sync.data.provider_next.connected).toEqual([provider.id])
      expect(sync.data.provider).toEqual([provider])
      expect(sync.data.provider_auth[provider.id]).toEqual([{ type: "api", label: "API key" }])
      expect(sync.data.agent).toEqual([agent])
      expect(sync.data.config.model).toBe("custom-gateway/model")
      expect(sync.data.capabilities.experimentalBackgroundSubagents).toBe(true)
      expect(requests.some((request) => request.startsWith("/experimental/console"))).toBe(false)
      expect("console_state" in sync.data).toBe(false)
    } finally {
      app.renderer.destroy()
    }
  })

  // I30: every capability flag is synced, and a missing flag or an answer that is not a JSON object reads as false.
  test("bootstrap syncs every capability flag and reads an HTML answer as unsupported", async () => {
    const flags = {
      backgroundSubagents: true,
      workDelegation: true,
      subagentLimits: true,
      sessionStop: true,
      taskPromote: true,
      taskResume: true,
      taskAttention: true,
      taskIsolation: true,
      workflows: true,
      backgroundShells: true,
    }
    {
      await using tmp = await tmpdir()
      await Bun.write(`${tmp.path}/kv.json`, "{}")
      const { app, sync } = await mount((url) => {
        if (url.pathname === "/experimental/capabilities")
          return json({ ...flags, taskPromote: false, workflows: "yes" })
      }, tmp.path)
      try {
        expect(sync.data.capabilities).toEqual({
          experimentalBackgroundSubagents: true,
          workDelegation: true,
          subagentLimits: true,
          sessionStop: true,
          taskPromote: false,
          taskResume: true,
          taskAttention: true,
          taskIsolation: true,
          workflows: false,
          backgroundShells: true,
          connections: false,
        })
      } finally {
        app.renderer.destroy()
      }
    }
    {
      await using tmp = await tmpdir()
      await Bun.write(`${tmp.path}/kv.json`, "{}")
      const { app, sync } = await mount((url) => {
        if (url.pathname === "/experimental/capabilities")
          return new Response("<!doctype html><html><body>proxy</body></html>", {
            headers: { "content-type": "text/html" },
          })
      }, tmp.path)
      try {
        expect(Object.values(sync.data.capabilities).every((value) => value === false)).toBe(true)
      } finally {
        app.renderer.destroy()
      }
    }
  })

  test("reading the providers again lists Vector Codium once a slow first catalog read answers", async () => {
    await using tmp = await tmpdir()
    await Bun.write(`${tmp.path}/kv.json`, "{}")
    const codium = {
      id: "vector-plan",
      name: "Vector Codium",
      source: "custom" as const,
      env: [],
      options: {},
      models: {},
    }
    // The engine's first answer came before vectordev.ai did, so Codium was not listed yet.
    const engine = { providers: [] as (typeof codium)[] }
    const { app, sync } = await mount((url) => {
      if (url.pathname === "/config/providers")
        return json({ providers: engine.providers, default: engine.providers.length ? { [codium.id]: "coder" } : {} })
      if (url.pathname === "/provider")
        return json({ all: engine.providers, connected: engine.providers.map((item) => item.id), default: {} })
    }, tmp.path)
    try {
      expect(sync.data.provider).toEqual([])
      engine.providers = [codium]
      await sync.refreshProviders()
      expect(sync.data.provider).toEqual([codium])
      expect(sync.data.provider_default).toEqual({ [codium.id]: "coder" })
      expect(sync.data.provider_next.connected).toEqual([codium.id])
    } finally {
      app.renderer.destroy()
    }
  })

  test("refresh scopes sessions by default and lists project sessions when disabled", async () => {
    await using tmp = await tmpdir()
    await Bun.write(`${tmp.path}/kv.json`, "{}")
    const { app, kv, sync, session } = await mount(undefined, tmp.path)

    try {
      expect(kv.get("session_directory_filter_enabled", true)).toBe(true)
      expect(session.at(-1)?.searchParams.get("roots")).toBeNull()
      expect(session.at(-1)?.searchParams.get("scope")).toBeNull()
      expect(session.at(-1)?.searchParams.get("path")).toBe("packages/tui")

      kv.set("session_directory_filter_enabled", false)
      await sync.session.refresh()

      expect(session.at(-1)?.searchParams.get("scope")).toBe("project")
      expect(session.at(-1)?.searchParams.get("path")).toBeNull()
      expect(session.at(-1)?.searchParams.get("roots")).toBeNull()
    } finally {
      app.renderer.destroy()
    }
  })

  test("lists the user's sessions but never Vector's helper sessions", async () => {
    await using tmp = await tmpdir()
    await Bun.write(`${tmp.path}/kv.json`, "{}")
    const { app, emit, sync } = await mount(undefined, tmp.path)
    const info = (id: string, extra: Record<string, unknown> = {}) => ({
      id,
      slug: id,
      projectID: "proj_test",
      directory: tmp.path,
      title: id,
      version: "test",
      time: { created: 1, updated: 1 },
      ...extra,
    })
    const updated = (session: ReturnType<typeof info>): GlobalEvent =>
      ({
        directory: tmp.path,
        project: "proj_test",
        payload: {
          id: `evt_${session.id}`,
          type: "session.updated",
          properties: { sessionID: session.id, info: session },
        },
      }) as GlobalEvent

    try {
      emit(updated(info("ses_review", { internal: "vectorscope.review", parentID: "ses_own" })))
      emit(updated(info("ses_own")))
      await wait(() => sync.data.session.some((session) => session.id === "ses_own"))
      expect(sync.data.session.map((session) => session.id)).not.toContain("ses_review")
    } finally {
      app.renderer.destroy()
    }
  })

  test("knows the helpers of an engine without the helper marker by the titles Vector gave them", async () => {
    await using tmp = await tmpdir()
    await Bun.write(`${tmp.path}/kv.json`, "{}")
    const info = (id: string, title = id) => ({
      id,
      slug: id,
      projectID: "proj_test",
      directory: tmp.path,
      title,
      version: "test",
      time: { created: 1, updated: 1 },
    })
    const listed = [
      info("ses_own"),
      info("ses_autocomplete", "Vector Tool · Autocomplete"),
      info("ses_early", "Vector review · #12 · review"),
    ]
    const { app, emit, sync } = await mount((url) => (url.pathname === "/session" ? json(listed) : undefined), tmp.path)
    const updated = (session: ReturnType<typeof info>): GlobalEvent =>
      ({
        directory: tmp.path,
        project: "proj_test",
        payload: {
          id: `evt_${session.id}`,
          type: "session.updated",
          properties: { sessionID: session.id, info: session },
        },
      }) as GlobalEvent

    try {
      await wait(() => sync.data.session.some((session) => session.id === "ses_own"))
      emit(updated(info("ses_review", "Vectorscope review · 1a2b3c4 · review")))
      emit(updated(info("ses_next")))
      await wait(() => sync.data.session.some((session) => session.id === "ses_next"))
      expect(sync.data.session.map((session) => session.id)).toEqual(["ses_next", "ses_own"])
    } finally {
      app.renderer.destroy()
    }
  })

  test("vcs branch updates only apply for the active workspace", async () => {
    await using tmp = await tmpdir()
    await Bun.write(`${tmp.path}/kv.json`, "{}")
    const { app, emit, project, sync } = await mount(undefined, tmp.path)

    try {
      expect(sync.data.vcs?.branch).toBe("main")

      project.workspace.set("ws_a")
      emit(branchEvent("other", "ws_b"))
      await Bun.sleep(30)

      expect(sync.data.vcs?.branch).toBe("main")

      emit(branchEvent("feature", "ws_a"))
      await wait(() => sync.data.vcs?.branch === "feature")

      expect(sync.data.vcs?.branch).toBe("feature")
    } finally {
      app.renderer.destroy()
    }
  })
})

function permissionEvent(id: string, permission: string): GlobalEvent {
  const request: PermissionRequest = {
    id,
    sessionID: "ses_test",
    permission,
    patterns: [],
    metadata: {},
    always: [],
  }
  return {
    directory,
    project: "proj_test",
    payload: { id: `evt_${id}`, type: "permission.asked", properties: request },
  }
}

test("auto mode approves ordinary requests but leaves doom_loop for a person", async () => {
  await using tmp = await tmpdir()
  await Bun.write(`${tmp.path}/kv.json`, "{}")
  const replies: string[] = []
  const { app, emit, sync } = await mount(
    (url) => {
      if (!url.pathname.startsWith("/permission/")) return
      replies.push(url.pathname)
      return json(true)
    },
    tmp.path,
    undefined,
    true,
  )
  try {
    emit(permissionEvent("per_edit", "edit"))
    await wait(() => replies.length === 1)
    emit(permissionEvent("per_loop", "doom_loop"))
    await wait(() => (sync.data.permission.ses_test ?? []).length === 1)
    await Bun.sleep(30)

    expect(replies).toEqual(["/permission/per_edit/reply"])
    expect(sync.data.permission.ses_test.map((request) => request.id)).toEqual(["per_loop"])
  } finally {
    app.renderer.destroy()
  }
})

test.each([
  { providers: [], expected: false },
  { providers: ["unlisted-service"], expected: false },
  { providers: ["unlisted-service", "anthropic"], expected: true },
])("connected state follows supported providers: $providers", async ({ providers, expected }) => {
  await using tmp = await tmpdir()
  await Bun.write(`${tmp.path}/kv.json`, "{}")
  let connected!: ReturnType<typeof useConnected>
  const { app } = await mount(
    (url) =>
      url.pathname === "/config/providers"
        ? json({ providers: providers.map((id) => ({ id, name: id, models: {} })), default: {} })
        : undefined,
    tmp.path,
    () => {
      connected = useConnected()
    },
  )
  try {
    expect(connected()).toBe(expected)
  } finally {
    app.renderer.destroy()
  }
})
