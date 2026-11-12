import { expect, test } from "bun:test"
import { randomUUID } from "node:crypto"
import { GithubAgents } from "@vectordevai/core/github-agents"
import { buildAgentsWorkflow, type AgentsWorkflowOptions } from "@vectordevai/core/review/workflow"
import { createGithubAgents } from "./github-agents"

function fixture(mode: "codium" | "own-key" = "codium") {
  const options: AgentsWorkflowOptions = {
    mode,
    provider: mode === "codium" ? "vector" : "anthropic",
    model: mode === "codium" ? "vector-plan" : "claude-example",
    keys: mode === "codium" ? [] : ["ANTHROPIC_API_KEY"],
    autoReview: false,
    version: GithubAgents.MIN_AGENTS_CLI,
  }
  const state = {
    content: buildAgentsWorkflow(options) as string | undefined,
    listed: true,
    bound: true,
    pollBound: true,
    vectorToken: "vector-only",
    githubToken: "github-only",
    repo: "repo",
    repositoryId: 41,
    private: false,
    failDispatch: false,
    revision: 0,
    generation: 1,
    authorityReads: 0,
    beforeUnbindAuthorityReads: 0,
    time: 1_800_000_000_000,
  }
  const hooks: {
    github?: (path: string) => Promise<void>
    vector?: (path: string) => Promise<void>
    access?: () => Promise<void>
  } = {}
  const calls: { host: string; path: string; method: string; token: string | null; body?: unknown }[] = []
  const connection = {
    repositoryId: "41",
    repository: "acme/repo",
    binder: { login: "owner" },
    boundAt: state.time,
    workflowVersion: GithubAgents.WORKFLOW_VERSION,
    codium: "ready",
  }
  const github = Bun.serve({
    port: 0,
    fetch: async (request) => {
      const url = new URL(request.url)
      const body = request.method === "GET" ? undefined : await request.json().catch(() => undefined)
      calls.push({
        host: "github",
        path: url.pathname,
        method: request.method,
        token: request.headers.get("authorization"),
        body,
      })
      await hooks.github?.(url.pathname)
      if (request.headers.get("authorization") !== "Bearer " + state.githubToken)
        return Response.json({ message: "Wrong credential domain" }, { status: 401 })
      if (url.pathname === "/repos/acme/" + state.repo)
        return Response.json(
          {
            id: state.repositoryId,
            full_name: "acme/" + state.repo,
            default_branch: "main",
            private: state.private,
            permissions: { push: true },
          },
          { headers: { "x-oauth-scopes": "repo,workflow" } },
        )
      if (url.pathname === "/user") return Response.json({ id: 7 })
      if (url.pathname === "/repos/acme/repo/contents/" + GithubAgents.WORKFLOW_FILE) {
        if (request.method === "PUT") return Response.json({ content: { sha: "c".repeat(40) } })
        return state.content === undefined
          ? Response.json({ message: "Not found" }, { status: 404 })
          : Response.json({
              encoding: "base64",
              content: Buffer.from(state.content).toString("base64"),
              sha: "a".repeat(40),
              html_url: "https://github.com/acme/repo/blob/main/" + GithubAgents.WORKFLOW_FILE,
            })
      }
      if (url.pathname.endsWith("/dispatches")) {
        if (state.failDispatch) return Response.json({ message: "Synthetic uncertain response" }, { status: 500 })
        if (
          body &&
          typeof body === "object" &&
          "inputs" in body &&
          body.inputs &&
          typeof body.inputs === "object" &&
          "mode" in body.inputs &&
          body.inputs.mode === "bind"
        )
          state.bound = state.pollBound
        return new Response(null, { status: 204 })
      }
      if (url.pathname.endsWith("/runs"))
        return Response.json({
          workflow_runs: [
            {
              id: 99,
              created_at: new Date(state.time).toISOString(),
              html_url: "https://github.com/acme/repo/actions/runs/99",
            },
          ],
        })
      if (url.pathname.endsWith("/git/ref/heads/main")) return Response.json({ object: { sha: "b".repeat(40) } })
      if (url.pathname.endsWith("/git/refs")) return Response.json({ ref: "created" }, { status: 201 })
      if (url.pathname.endsWith("/pulls"))
        return Response.json({ html_url: "https://github.com/acme/repo/pull/5" }, { status: 201 })
      return Response.json({ message: "Unexpected GitHub request" }, { status: 404 })
    },
  })
  const controller = createGithubAgents({
    version: GithubAgents.MIN_AGENTS_CLI,
    token: async () => state.vectorToken,
    authorityRevision: () => state.revision,
    access: async () => {
      state.authorityReads++
      await hooks.access?.()
      return { token: state.githubToken, source: "vector", apiUrl: github.url.origin }
    },
    repository: async () => ({ owner: "acme", name: state.repo }),
    now: () => state.time,
    sleep: async (milliseconds) => {
      state.time += milliseconds
    },
    fetch: async (input, init) => {
      const url = new URL(String(input))
      calls.push({
        host: url.origin,
        path: url.pathname,
        method: init?.method ?? "GET",
        token: new Headers(init?.headers).get("authorization"),
        ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}),
      })
      await hooks.vector?.(url.pathname)
      if (url.origin !== "https://vectordev.ai") throw new Error("Unexpected Vector host")
      if (url.pathname === "/api/model-plans/config")
        return Response.json({
          enabled: true,
          listed: state.listed ? ["github-agents", "scheduled", "github-no-secret"] : [],
        })
      if (url.pathname === "/api/github/installation") return Response.json({ available: false })
      if (new Headers(init?.headers).get("authorization") !== "Bearer " + state.vectorToken)
        return Response.json({}, { status: 401 })
      if (url.pathname === GithubAgents.ENDPOINT.bindings)
        return Response.json({ bindings: state.bound ? [{ ...connection, generation: state.generation }] : [] })
      if (url.pathname === GithubAgents.ENDPOINT.bindCode) {
        return Response.json({ code: "vbc_" + "a".repeat(43), expiresAt: state.time + 600_000 })
      }
      if (url.pathname === GithubAgents.ENDPOINT.unbind) {
        state.beforeUnbindAuthorityReads = state.authorityReads
        const body: unknown = init?.body ? JSON.parse(String(init.body)) : undefined
        if (
          !body ||
          typeof body !== "object" ||
          !("expectedGeneration" in body) ||
          body.expectedGeneration !== state.generation
        )
          return Response.json({ error: "Binding changed" }, { status: 409 })
        state.bound = false
        return Response.json({ ok: true })
      }
      if (url.pathname === GithubAgents.ENDPOINT.runs) return Response.json({ runs: [] })
      throw new Error("Unexpected Vector endpoint")
    },
  })
  return {
    state,
    calls,
    options,
    hooks,
    controller,
    scope: async () => {
      const current = await controller.status("/fixture")
      if (!current.authorityId || !current.repositoryId) throw new Error("Missing verified fixture authority")
      return { expectedRepositoryId: current.repositoryId, authorityId: current.authorityId, operationId: randomUUID() }
    },
    [Symbol.dispose]() {
      github.stop(true)
    },
  }
}

test("workflow status separates missing, old, current and an old actual CLI pin", async () => {
  using f = fixture()
  expect((await f.controller.status("/fixture")).workflow).toBe("current")
  f.state.content = undefined
  expect((await f.controller.status("/fixture")).workflow).toBe("missing")
  f.state.content = "name: previous-workflow\n"
  expect((await f.controller.status("/fixture")).workflow).toBe("old")
  f.state.content = buildAgentsWorkflow(f.options).replaceAll(
    "@vectordevai/cli@" + GithubAgents.MIN_AGENTS_CLI,
    "@vectordevai/cli@1.99.112",
  )
  expect((await f.controller.status("/fixture")).workflow).toBe("cli-too-old")
})

test("own-key run stays available when Codium is unlisted and never sends an account request", async () => {
  using f = fixture("own-key")
  f.state.listed = false
  const prompt = "Change a test.\n${{ secrets.DO_NOT_INTERPOLATE }}"
  expect((await f.controller.status("/fixture")).listed.agents).toBe(false)
  await f.controller.run({ cwd: "/fixture", prompt, ...(await f.scope()) })
  expect(f.calls.filter((call) => call.path.startsWith("/api/cloud-agents/"))).toEqual([])
  const dispatch = f.calls.find((call) => call.path.endsWith("/dispatches"))
  expect(dispatch?.body).toEqual({ ref: "main", inputs: { mode: "task", prompt } })
  expect(dispatch?.token).toBe("Bearer github-only")
  expect(f.calls.filter((call) => call.host === "https://vectordev.ai").every((call) => call.token === null)).toBe(true)
})

test("Codium preview is dark until listed and carries no provider or account secret", async () => {
  using f = fixture()
  f.state.listed = false
  await expect(f.controller.preview({ cwd: "/fixture", mode: "codium", autoReview: false })).rejects.toThrow(
    "not available",
  )
  f.state.listed = true
  const preview = await f.controller.preview({ cwd: "/fixture", mode: "codium", autoReview: false })
  expect(preview.secrets).toEqual([])
  expect(preview.content).not.toContain("VECTOR_CLI_TOKEN")
  expect(preview.content).not.toContain("ANTHROPIC_API_KEY")
  await expect(f.controller.preview({ cwd: "/fixture", mode: "codium", autoReview: true })).rejects.toThrow(
    "cannot share publicly",
  )
})

test("bind uses the trusted default branch, keeps token domains separate, and handles empty GitHub dispatch responses", async () => {
  using f = fixture()
  f.state.bound = false
  const result = await f.controller.bind({ cwd: "/fixture", ...(await f.scope()) })
  expect(result.state).toBe("bound")
  expect(f.calls.find((call) => call.path === GithubAgents.ENDPOINT.bindCode)?.body).toEqual({
    repository: "acme/repo",
    repositoryId: 41,
    githubUserId: 7,
    defaultRef: "refs/heads/main",
  })
  expect(f.calls.filter((call) => call.host === "github").every((call) => call.token === "Bearer github-only")).toBe(
    true,
  )
  expect(
    f.calls
      .filter((call) => call.path.startsWith("/api/cloud-agents/"))
      .every((call) => call.token === "Bearer vector-only"),
  ).toBe(true)
})

test("unsettled bind returns pending within its bounded polling window", async () => {
  using f = fixture()
  f.state.bound = false
  f.state.pollBound = false
  const started = f.state.time
  expect((await f.controller.bind({ cwd: "/fixture", ...(await f.scope()) })).state).toBe("pending")
  const dispatched = f.calls.findIndex((call) => call.path.endsWith("/dispatches"))
  expect(dispatched).toBeGreaterThan(-1)
  expect(f.calls.slice(dispatched + 1).filter((call) => call.path === GithubAgents.ENDPOINT.bindings)).toHaveLength(60)
  expect(f.state.time - started).toBe(120_000)
})

test("old workflow or unavailable attachment never falls back to a direct dispatch", async () => {
  using f = fixture()
  f.state.content = "name: old\n"
  await expect(f.controller.run({ cwd: "/fixture", prompt: "task", ...(await f.scope()) })).rejects.toThrow(
    "current Vector workflow",
  )
  await expect(
    f.controller.run({
      cwd: "/fixture",
      ...(await f.scope()),
      prompt: "task",
      brain: { previewId: "unavailable", approvedSha256: "0".repeat(64) },
    }),
  ).rejects.toThrow("attachments are not available")
  expect(f.calls.some((call) => call.path.endsWith("/dispatches"))).toBe(false)
})

test("schedule update re-renders only validated header options in a reviewable workflow PR", async () => {
  using f = fixture("own-key")
  const schedule = { id: "morning", cron: "7 8 * * 1-5", prompt: "Check repository tests" }
  expect((await f.controller.schedules({ cwd: "/fixture", schedules: [schedule], ...(await f.scope()) })).url).toBe(
    "https://github.com/acme/repo/pull/5",
  )
  const write = f.calls.find((call) => call.method === "PUT")?.body as { content: string }
  expect(Buffer.from(write.content, "base64").toString()).toContain("Check repository tests")
  expect(f.calls.some((call) => call.path.startsWith("/api/cloud-agents/"))).toBe(false)
})

test("every repository mutation refuses consent from the previous remote at the same directory", async () => {
  using f = fixture("own-key")
  const consent = await f.scope()
  f.state.repo = "another"
  f.state.repositoryId = 42
  const input = { cwd: "/fixture", ...consent }
  await expect(
    f.controller.setup({ ...input, mode: "own-key", model: "anthropic/claude-example", keys: [], autoReview: false }),
  ).rejects.toThrow("changed")
  await expect(f.controller.bind({ ...input, operationId: randomUUID() })).rejects.toThrow("changed")
  await expect(f.controller.run({ ...input, operationId: randomUUID(), prompt: "task" })).rejects.toThrow("changed")
  await expect(f.controller.schedules({ ...input, operationId: randomUUID(), schedules: [] })).rejects.toThrow(
    "changed",
  )
  expect(f.calls.filter((call) => call.method !== "GET")).toEqual([])
})

test("main retires delayed account results and old opaque approvals after an account switch", async () => {
  using f = fixture()
  const consent = await f.scope()
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  f.hooks.vector = async (path) => {
    if (path !== GithubAgents.ENDPOINT.bindings) return
    entered.resolve()
    await release.promise
  }
  const delayed = f.controller.status("/fixture")
  await entered.promise
  f.state.vectorToken = "vector-account-b"
  f.state.revision++
  release.resolve()
  await expect(delayed).rejects.toThrow("sign-in changed")
  f.hooks.vector = undefined
  await expect(f.controller.run({ cwd: "/fixture", prompt: "task", ...consent })).rejects.toThrow("changed")
  expect(f.calls.some((call) => call.path.endsWith("/dispatches"))).toBe(false)
})

test("main fences GitHub identity, visibility, and account A-to-B-to-A revision changes", async () => {
  using f = fixture("own-key")
  const consent = await f.scope()
  f.state.revision += 2
  await expect(f.controller.run({ cwd: "/fixture", prompt: "task", ...consent })).rejects.toThrow("changed")
  const current = await f.scope()
  f.state.githubToken = "different-github-owner"
  await expect(f.controller.run({ cwd: "/fixture", prompt: "task", ...current })).rejects.toThrow("changed")
  const visible = await f.scope()
  f.state.private = true
  await expect(f.controller.run({ cwd: "/fixture", prompt: "task", ...visible })).rejects.toThrow("changed")
  expect(f.calls.filter((call) => call.method !== "GET")).toEqual([])
})

test("one main operation receipt coalesces duplicate Start and blocks another dialog while dispatch is pending", async () => {
  using f = fixture("own-key")
  const input = { cwd: "/fixture", prompt: "task", ...(await f.scope()) }
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  f.hooks.github = async (path) => {
    if (!path.endsWith("/dispatches")) return
    entered.resolve()
    await release.promise
  }
  const first = f.controller.run(input)
  await entered.promise
  const retry = f.controller.run(input)
  await expect(f.controller.run({ ...input, operationId: randomUUID() })).rejects.toThrow("pending")
  release.resolve()
  expect(await retry).toEqual(await first)
  expect(f.calls.filter((call) => call.path.endsWith("/dispatches"))).toHaveLength(1)
  expect(await f.controller.run(input)).toEqual(await first)
  expect(f.calls.filter((call) => call.path.endsWith("/dispatches"))).toHaveLength(1)
})

test("an uncertain GitHub dispatch never retries automatically or through a fresh operation ID", async () => {
  using f = fixture("own-key")
  const input = { cwd: "/fixture", prompt: "task", ...(await f.scope()) }
  f.state.failDispatch = true
  await expect(f.controller.run(input)).rejects.toThrow("uncertain")
  f.state.failDispatch = false
  await expect(f.controller.run(input)).rejects.toThrow("uncertain")
  await expect(f.controller.run({ ...input, operationId: randomUUID() })).rejects.toThrow("uncertain")
  expect(f.calls.filter((call) => call.path.endsWith("/dispatches"))).toHaveLength(1)
})

test("a remote change during awaited status verification is refused before dispatch", async () => {
  using f = fixture("own-key")
  const input = { cwd: "/fixture", prompt: "task", ...(await f.scope()) }
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  f.hooks.vector = async (path) => {
    if (path !== "/api/github/installation") return
    entered.resolve()
    await release.promise
  }
  const operation = f.controller.run(input)
  await entered.promise
  f.state.repo = "another"
  f.state.repositoryId = 42
  release.resolve()
  await expect(operation).rejects.toThrow("changed")
  expect(f.calls.some((call) => call.path.endsWith("/dispatches"))).toBe(false)
})

test("unbind uses opaque displayed-row consent and sends only the exact fresh generation; duplicates delete once", async () => {
  using f = fixture()
  const row = (await f.controller.bindings())[0]!
  expect(row.authorityId).toMatch(/^[0-9a-f]{64}$/)
  expect(row).not.toHaveProperty("generation")
  const input = { repositoryId: row.repositoryId, authorityId: row.authorityId!, operationId: randomUUID() }
  await Promise.all([f.controller.unbind(input), f.controller.unbind(input)])
  await f.controller.unbind(input)
  const requests = f.calls.filter((call) => call.path === GithubAgents.ENDPOINT.unbind)
  expect(requests).toHaveLength(1)
  expect(requests[0]!.body).toEqual({ repositoryId: "41", expectedGeneration: 1 })
  expect(requests[0]!.token).toBe("Bearer vector-only")
})

test("unbind refuses previous account or binding-generation consent before sending any delete", async () => {
  using f = fixture()
  const row = (await f.controller.bindings())[0]!
  const input = { repositoryId: row.repositoryId, authorityId: row.authorityId!, operationId: randomUUID() }
  f.state.vectorToken = "account-b"
  f.state.revision++
  await expect(f.controller.unbind(input)).rejects.toThrow("changed")
  const current = (await f.controller.bindings())[0]!
  f.state.generation++
  await expect(
    f.controller.unbind({
      repositoryId: current.repositoryId,
      authorityId: current.authorityId!,
      operationId: randomUUID(),
    }),
  ).rejects.toThrow("changed")
  expect(f.calls.filter((call) => call.path === GithubAgents.ENDPOINT.unbind)).toEqual([])
})

test("unbind generation race is refused by server CAS and cannot be resent under a new operation ID", async () => {
  using f = fixture()
  const row = (await f.controller.bindings())[0]!
  const input = { repositoryId: row.repositoryId, authorityId: row.authorityId!, operationId: randomUUID() }
  f.hooks.vector = async (path) => {
    if (path === GithubAgents.ENDPOINT.unbind) f.state.generation++
  }
  await expect(f.controller.unbind(input)).rejects.toThrow("uncertain")
  expect(f.state.bound).toBe(true)
  f.hooks.vector = undefined
  const current = (await f.controller.bindings())[0]!
  await expect(
    f.controller.unbind({
      repositoryId: current.repositoryId,
      authorityId: current.authorityId!,
      operationId: randomUUID(),
    }),
  ).rejects.toThrow("uncertain")
  expect(f.calls.filter((call) => call.path === GithubAgents.ENDPOINT.unbind)).toHaveLength(1)
})

test("every awaited pre-delete credential resolution rejects a GitHub-only account switch before HTTP write", async () => {
  using control = fixture()
  const row = (await control.controller.bindings())[0]!
  control.state.authorityReads = 0
  await control.controller.unbind({
    repositoryId: row.repositoryId,
    authorityId: row.authorityId!,
    operationId: randomUUID(),
  })
  const beforeWrite = control.state.beforeUnbindAuthorityReads
  expect(beforeWrite).toBeGreaterThan(0)
  expect(beforeWrite).toBeLessThan(30)
  // Discover the real pre-write boundaries from the positive path; exercise each rather than assuming an internal call count.
  for (let boundary = 1; boundary <= beforeWrite; boundary++) {
    using f = fixture()
    const displayed = (await f.controller.bindings())[0]!
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    f.state.authorityReads = 0
    f.hooks.access = async () => {
      if (f.state.authorityReads !== boundary) return
      entered.resolve()
      await release.promise
    }
    const operation = f.controller.unbind({
      repositoryId: displayed.repositoryId,
      authorityId: displayed.authorityId!,
      operationId: randomUUID(),
    })
    await entered.promise
    f.state.githubToken = "different-github-identity"
    release.resolve()
    await expect(operation).rejects.toThrow()
    expect(f.calls.filter((call) => call.path === GithubAgents.ENDPOINT.unbind)).toEqual([])
    expect(f.state.bound).toBe(true)
  }
})

test("credential rotation and a fresh approval cannot escape a repository's uncertain dispatch fence", async () => {
  using f = fixture("own-key")
  const input = { cwd: "/fixture", prompt: "task", ...(await f.scope()) }
  f.state.failDispatch = true
  await expect(f.controller.run(input)).rejects.toThrow("uncertain")
  f.state.failDispatch = false
  f.state.githubToken = "rotated-github-credential"
  f.state.vectorToken = "rotated-vector-credential"
  f.state.revision++
  const refreshed = await f.scope()
  expect(refreshed.authorityId).not.toBe(input.authorityId)
  await expect(f.controller.run({ cwd: "/fixture", prompt: "task", ...refreshed })).rejects.toThrow("uncertain")
  expect(f.calls.filter((call) => call.path.endsWith("/dispatches"))).toHaveLength(1)
})
