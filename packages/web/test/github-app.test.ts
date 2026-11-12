import { expect, test } from "bun:test"
import { createPrivateKey } from "node:crypto"
import { createGithubApp, githubAppConfiguration, githubTokenPermissions } from "../../../api/_lib/github-app"
import { githubAppFixture } from "./github-app-fixture"
import type { RepoBinding } from "../../../api/_lib/cloud-agents-binding"

test("desktop attachment visibility comes from current repository metadata with a metadata-only revoked credential", async () => {
  await using fixture = await githubAppFixture()
  const binding: RepoBinding = {
    repositoryId: fixture.repositoryId,
    ownerId: "456",
    repository: "fixture-owner/project",
    account: "11111111-1111-4111-8111-111111111111",
    visibility: "private",
    defaultRef: "refs/heads/main",
    generation: 1,
    binder: { githubId: String(fixture.state.binder.id), login: fixture.state.binder.login },
    workflowVersion: "3",
    boundAt: Date.now(),
    installationId: "600",
  }
  expect(await fixture.app.attachmentRepository(binding)).toEqual({
    repositoryId: fixture.repositoryId,
    generation: 1,
    publicRepository: true,
  })
  fixture.state.repository.private = true
  expect((await fixture.app.attachmentRepository(binding)).publicRepository).toBe(false)
  expect(fixture.state.minted.map((item) => item.body.permissions)).toEqual([
    { metadata: "read" },
    { metadata: "read" },
  ])
  expect(fixture.tokens.size).toBe(0)
})

test.each(["binder-left", "default-moved", "owner-moved"] as const)(
  "desktop attachment metadata refuses %s and revokes its credential",
  async (change) => {
    await using fixture = await githubAppFixture()
    const binding: RepoBinding = {
      repositoryId: fixture.repositoryId,
      ownerId: "456",
      repository: "fixture-owner/project",
      account: "11111111-1111-4111-8111-111111111111",
      visibility: "private",
      defaultRef: "refs/heads/main",
      generation: 1,
      binder: { githubId: String(fixture.state.binder.id), login: fixture.state.binder.login },
      workflowVersion: "3",
      boundAt: Date.now(),
      installationId: "600",
    }
    if (change === "binder-left") fixture.state.binderPermission = "read"
    if (change === "default-moved") fixture.state.repository.default_branch = "new-default"
    if (change === "owner-moved") binding.ownerId = "999"
    await expect(fixture.app.attachmentRepository(binding)).rejects.toBeDefined()
    expect(fixture.tokens.size).toBe(0)
  },
)

test.each(["ok", "foreign-run", "wrong-name", "expired", "foreign-repo", "too-old", "permission-lost"] as const)(
  "completed owner artifact metadata enforces actual provenance without downloading payload: %s",
  async (change) => {
    await using fixture = await githubAppFixture()
    const now = Date.now()
    const binding: RepoBinding = {
      repositoryId: fixture.repositoryId,
      ownerId: "456",
      repository: "fixture-owner/project",
      account: "11111111-1111-4111-8111-111111111111",
      visibility: "private",
      defaultRef: "refs/heads/main",
      generation: 1,
      binder: { githubId: String(fixture.state.binder.id), login: fixture.state.binder.login },
      workflowVersion: "3",
      boundAt: now,
      installationId: "600",
    }
    fixture.state.run.event = "workflow_dispatch"
    fixture.state.artifact = {
      id: 55,
      name: "vector-session-dispatch-1000",
      expired: false,
      created_at: new Date(now - 5000).toISOString(),
      expires_at: new Date(now + 86_400_000).toISOString(),
      size_in_bytes: 500,
      workflow_run: {
        id: change === "foreign-run" ? 1001 : 1000,
        repository_id: Number(fixture.repositoryId),
        head_repository_id: change === "foreign-repo" ? 999 : Number(fixture.repositoryId),
      },
    }
    if (change === "wrong-name") fixture.state.artifact.name = "vector-session-17"
    if (change === "expired") fixture.state.artifact.expired = true
    if (change === "too-old") fixture.state.artifact.created_at = new Date(now - 8 * 86_400_000).toISOString()
    if (change === "permission-lost") {
      await fixture.app.attachmentRepository(binding)
      fixture.state.binderPermission = "read"
    }
    const read = fixture.app.ownerArtifact(
      binding,
      { runId: "1000", thread: "dispatch-1000", startedAt: now - 20_000, endedAt: now - 10_000 },
      "55",
    )
    if (change === "ok")
      expect(await read).toMatchObject({ repositoryId: fixture.repositoryId, generation: 1, publicRepository: true })
    else await expect(read).rejects.toBeDefined()
    expect(fixture.tokens.size).toBe(0)
    expect(fixture.state.requests.some((route) => route.includes("/zip") || route.includes("archive_download"))).toBe(
      false,
    )
    expect(fixture.state.minted.every((item) => !Object.hasOwn(item.body.permissions, "contents"))).toBe(true)
  },
)

test.each(["task", "review", "publish"] as const)(
  "issues a real-signed App request with exactly one repository and fixed %s permissions",
  async (purpose) => {
    await using fixture = await githubAppFixture()
    fixture.state.job.name =
      purpose === "task" ? "Vector task" : purpose === "publish" ? "Vector publish" : "Vector review"
    const result = await fixture.app.token(await fixture.identity(), purpose, 17, async () => {
      fixture.state.events.push("admission")
    })
    expect(result).toMatchObject({
      repositoryId: fixture.repositoryId,
      repository: "fixture-owner/project",
      permissions: githubTokenPermissions[purpose],
      bot: { id: 9000, login: "vector-fixture[bot]" },
    })
    expect(fixture.state.minted.map((item) => item.body.repository_ids)).toEqual([
      [Number(fixture.repositoryId)],
      [Number(fixture.repositoryId)],
    ])
    expect(fixture.state.minted.at(-1)?.body.permissions).toEqual(githubTokenPermissions[purpose])
    expect(fixture.state.events).toEqual([
      "mint:validation",
      "scope:validation",
      "revoke:validation",
      "admission",
      `mint:${purpose}`,
      `scope:${purpose}`,
    ])
    expect(fixture.tokens.size).toBe(1)
    expect(fixture.tokens.has(result.token)).toBe(true)
    expect(Date.parse(result.expiresAt)).toBeLessThanOrEqual(Date.now() + 3_600_000)
  },
)

test("disabled/missing installation returns only public configuration and signed repository status", async () => {
  await using fixture = await githubAppFixture()
  expect(fixture.app.configuration()).toEqual({
    available: true,
    installUrl: "https://github.com/apps/vector-fixture/installations/new",
  })
  fixture.state.installed = false
  expect(await fixture.app.installation(await fixture.identity())).toEqual({
    installed: false,
    repositoryId: fixture.repositoryId,
    installUrl: "https://github.com/apps/vector-fixture/installations/new",
    retryAfterSeconds: 10,
  })
  await expect(fixture.app.token(await fixture.identity(), "task", undefined, async () => {})).rejects.toMatchObject({
    code: "APP_NOT_INSTALLED",
  })
  expect(fixture.state.minted).toEqual([])
  fixture.state.enabled = false
  expect(fixture.app.configuration()).toEqual({ available: false })
  await expect(fixture.app.installation(await fixture.identity())).rejects.toMatchObject({
    code: "GITHUB_APP_NOT_CONFIGURED",
  })
})

test.each([
  "repository",
  "owner",
  "branch",
  "run",
  "attempt",
  "sha",
  "run-event",
  "run-head-repository",
  "workflow-path",
  "workflow-disabled",
  "job",
  "check-run",
  "job-status",
  "actor",
  "permission",
  "permission-id",
  "rerun-actor",
  "fork-pr",
  "fork-run-pr",
])("rejects changed %s policy and revokes the server validation credential", async (mode) => {
  await using fixture = await githubAppFixture()
  if (mode === "repository") fixture.state.repository.id++
  if (mode === "owner") fixture.state.repository.owner.id++
  if (mode === "branch") fixture.state.repository.default_branch = "other"
  if (mode === "run") fixture.state.run.id++
  if (mode === "attempt") fixture.state.run.run_attempt++
  if (mode === "sha") fixture.state.run.head_sha = "b".repeat(40)
  if (mode === "run-event") fixture.state.run.event = "pull_request"
  if (mode === "run-head-repository") fixture.state.run.head_repository = { ...fixture.state.repository, id: 991 }
  if (mode === "workflow-path") fixture.state.workflow.path = ".github/workflows/other.yml"
  if (mode === "workflow-disabled") fixture.state.workflow.state = "disabled_manually"
  if (mode === "job") fixture.state.job.name = "Untrusted job"
  if (mode === "check-run") fixture.state.job.check_run_url = "https://api.github.com/repos/other/repo/check-runs/1001"
  if (mode === "job-status") fixture.state.job.status = "completed"
  if (mode === "actor") fixture.state.run.actor = { ...fixture.state.run.actor, id: 991 }
  if (mode === "permission") fixture.state.permission = "read"
  if (mode === "permission-id") fixture.state.permissionUserId++
  if (mode === "rerun-actor") {
    fixture.state.run.triggering_actor = { id: 999, login: "rerun-person", type: "User" }
    fixture.state.triggeringPermission = "read"
  }
  if (mode === "fork-pr" || mode === "fork-run-pr") fixture.state.prHeadId = 998
  if (mode === "fork-run-pr") fixture.state.run.pull_requests = [{ number: 17 }]
  await expect(
    fixture.app.token(await fixture.identity(), "task", mode === "fork-pr" ? 17 : undefined, async () => {}),
  ).rejects.toBeDefined()
  expect(fixture.state.minted.every((item) => item.purpose === "validation")).toBe(true)
  expect(fixture.tokens.size).toBe(0)
})

test.each(["extra-permission", "expired", "too-long", "extra-repository"])(
  "rejects and revokes a malformed or broader final token: %s",
  async (mode) => {
    await using fixture = await githubAppFixture()
    fixture.state.mintMode = mode
    fixture.state.scopeExtra = mode === "extra-repository"
    await expect(fixture.app.token(await fixture.identity(), "task", undefined, async () => {})).rejects.toMatchObject({
      code: "GITHUB_UNAVAILABLE",
    })
    expect(fixture.state.events.at(-1)).toBe("revoke:task")
    expect(fixture.tokens.size).toBe(0)
  },
)

test("suspension, App identity mismatch, redirect and failed validation revocation never yield final credentials", async () => {
  for (const mode of ["suspended", "app-id", "app-slug", "redirect", "revocation"]) {
    await using fixture = await githubAppFixture()
    if (mode === "suspended") fixture.state.suspended = true
    if (mode === "app-id") fixture.state.appId++
    if (mode === "app-slug") fixture.state.appSlug = "another-app"
    if (mode === "redirect") fixture.state.redirectPath = "/repos/fixture-owner/project/actions/workflows/500"
    if (mode === "revocation") fixture.state.revokeFailure = true
    await expect(fixture.app.token(await fixture.identity(), "task", undefined, async () => {})).rejects.toBeDefined()
    expect(fixture.state.minted.every((item) => item.purpose === "validation")).toBe(true)
    expect(fixture.state.requests).not.toContain("/unexpected")
  }
})

test("configuration stays disabled in Vercel previews and accepts owner PKCS1 keys without exposing them", async () => {
  await using fixture = await githubAppFixture()
  const env = {
    VECTOR_GITHUB_APP_ENABLED: "true",
    VECTOR_GITHUB_APP_ID: fixture.config.id,
    VECTOR_GITHUB_APP_CLIENT_ID: fixture.config.clientId,
    VECTOR_GITHUB_APP_SLUG: fixture.config.slug,
    VECTOR_GITHUB_APP_PRIVATE_KEY: fixture.config.privateKey,
  }
  expect(githubAppConfiguration({ ...env, VERCEL_ENV: "preview" })).toBeUndefined()
  expect(githubAppConfiguration({ ...env, VECTOR_GITHUB_APP_ENABLED: "false" })).toBeUndefined()
  for (const change of [
    { VECTOR_GITHUB_APP_ID: "9007199254740992" },
    { VECTOR_GITHUB_APP_SLUG: "bad/slug" },
    { VECTOR_GITHUB_APP_PRIVATE_KEY: "not-a-key" },
  ])
    expect(() => githubAppConfiguration({ ...env, ...change })).toThrow()
  const privateKey = createPrivateKey(fixture.config.privateKey).export({ type: "pkcs1", format: "pem" }).toString()
  const app = createGithubApp({ configuration: () => ({ ...fixture.config, privateKey }), request: fixture.request })
  const status = await app.installation(await fixture.identity())
  expect(status.installed).toBe(true)
  expect(Object.keys(status).sort()).toEqual(["installUrl", "installed", "repositoryId"])
  expect(JSON.stringify(status)).not.toContain("PRIVATE KEY")
  expect(fixture.tokens.size).toBe(0)
})

async function runFixture(event = "issue_comment") {
  const fixture = await githubAppFixture()
  fixture.state.job.name = "Vector agent"
  fixture.state.run.event = event
  const options = {
    job: "agent" as const,
    thread: "17",
    commentId: 123,
    binder: { githubId: "790", login: "fixture-binder" },
    account: crypto.randomUUID(),
    defaultRef: "refs/heads/main",
    generation: 1,
  }
  const identity = () => fixture.makeToken("mint", { event_name: event }).then((token) => fixture.verify(token, "mint"))
  return { ...fixture, options, runIdentity: identity }
}

test.each(["Vector agent", "Vector bind"])("%s can never obtain an App token", async (job) => {
  await using fixture = await githubAppFixture()
  fixture.state.job.name = job
  for (const purpose of ["task", "review", "publish"] as const)
    await expect(fixture.app.token(await fixture.identity(), purpose, undefined, async () => {})).rejects.toMatchObject(
      { code: "WORKFLOW_NOT_TRUSTED" },
    )
  expect(fixture.state.minted.every((item) => item.purpose === "validation")).toBe(true)
  expect(fixture.tokens.size).toBe(0)
})

test("run verification revokes its only credential and caches only the current binder and generation", async () => {
  await using fixture = await runFixture()
  expect(await fixture.app.verifyRun(await fixture.runIdentity(), fixture.options)).toEqual({
    installed: true,
    binder: "ok",
  })
  expect(fixture.tokens.size).toBe(0)
  expect(fixture.state.minted.every((item) => item.purpose === "validation")).toBe(true)
  fixture.state.binderPermission = "read"
  expect(await fixture.app.verifyRun(await fixture.runIdentity(), fixture.options)).toEqual({
    installed: true,
    binder: "ok",
  })
  expect(fixture.state.requests.filter((x) => x === "/user/790")).toHaveLength(1)
  expect(await fixture.app.verifyRun(await fixture.runIdentity(), { ...fixture.options, generation: 2 })).toEqual({
    installed: true,
    binder: "binder-left",
  })
  fixture.state.clock += 3_600_000
  expect(await fixture.app.verifyRun(await fixture.runIdentity(), fixture.options)).toEqual({
    installed: true,
    binder: "binder-left",
  })
  expect(fixture.state.storeCommands.filter((x) => x[0] === "EVAL")).toHaveLength(1)
})

test("a cache for a former binder never authorizes a replacement binder", async () => {
  await using fixture = await runFixture()
  await fixture.app.verifyRun(await fixture.runIdentity(), fixture.options)
  fixture.state.binder.id = 791
  fixture.state.binderPermission = "read"
  expect(
    await fixture.app.verifyRun(await fixture.runIdentity(), {
      ...fixture.options,
      binder: { githubId: "791", login: "fixture-binder" },
    }),
  ).toEqual({ installed: true, binder: "binder-left" })
})

test("another account and an unattributable legacy cache require a fresh binder permission check", async () => {
  await using fixture = await runFixture()
  const identity = await fixture.runIdentity()
  await fixture.app.verifyRun(identity, fixture.options)
  fixture.state.binderPermission = "read"
  expect(await fixture.app.verifyRun(identity, { ...fixture.options, account: crypto.randomUUID() })).toEqual({
    installed: true,
    binder: "binder-left",
  })
  const key = `vector:cloud-agents:binder-ok:${fixture.repositoryId}`
  fixture.state.cache.set(key, {
    value: JSON.stringify({ githubId: "790", generation: 1 }),
    until: fixture.state.clock + 3_600_000,
  })
  expect(await fixture.app.verifyRun(identity, fixture.options)).toEqual({ installed: true, binder: "binder-left" })
  fixture.state.binderPermission = "write"
  expect(await fixture.app.verifyRun(identity, fixture.options)).toEqual({ installed: true, binder: "ok" })
  expect(JSON.parse(fixture.state.cache.get(key)!.value)).toEqual({
    account: fixture.options.account,
    githubId: "790",
    generation: 1,
  })
})

test.each(["author", "changed", "thread", "permission", "bot-author", "fork-without-body-pr"])(
  "comment verification refuses %s",
  async (mode) => {
    await using fixture = await runFixture()
    if (mode === "author") fixture.state.comment.user.id++
    if (mode === "changed") fixture.state.comment.body = "`/vector fix it`"
    if (mode === "thread")
      fixture.state.comment.issue_url = "https://api.github.com/repos/fixture-owner/project/issues/18"
    if (mode === "permission") fixture.state.permission = "read"
    if (mode === "bot-author") fixture.state.comment.user.type = "Bot"
    if (mode === "fork-without-body-pr") {
      fixture.state.issue.pull_request = { url: "https://api.github.com/repos/fixture-owner/project/pulls/17" }
      fixture.state.prHeadId = 998
    }
    const code =
      mode === "changed"
        ? "COMMENT_CHANGED"
        : ["thread", "fork-without-body-pr"].includes(mode)
          ? "EVENT_NOT_ALLOWED"
          : "ACTOR_NOT_ALLOWED"
    await expect(fixture.app.verifyRun(await fixture.runIdentity(), fixture.options)).rejects.toMatchObject({ code })
    expect(fixture.tokens.size).toBe(0)
    expect(fixture.state.storeCommands).toEqual([])
  },
)

test("issues require the actor's author identity and a current task", async () => {
  await using fixture = await runFixture("issues")
  expect(await fixture.app.verifyRun(await fixture.runIdentity(), fixture.options)).toEqual({
    installed: true,
    binder: "ok",
  })
  fixture.state.issue.user.id++
  await expect(fixture.app.verifyRun(await fixture.runIdentity(), fixture.options)).rejects.toMatchObject({
    code: "ACTOR_NOT_ALLOWED",
  })
  fixture.state.issue.user.id--
  fixture.state.issue.body = "/vector review"
  await expect(fixture.app.verifyRun(await fixture.runIdentity(), fixture.options)).rejects.toMatchObject({
    code: "COMMENT_CHANGED",
  })
  fixture.state.issue.title = "/vector fix the title bug"
  expect(await fixture.app.verifyRun(await fixture.runIdentity(), fixture.options)).toEqual({
    installed: true,
    binder: "ok",
  })
})

async function reviewFixture() {
  const fixture = await runFixture("pull_request_review_comment")
  fixture.state.run.head_sha = fixture.state.prSha
  fixture.state.job.head_sha = fixture.state.prSha
  fixture.state.run.head_branch = fixture.state.prRef
  fixture.state.job.head_branch = fixture.state.prRef
  const identity = () =>
    fixture
      .makeToken("mint", {
        event_name: "pull_request_review_comment",
        ref: "refs/pull/17/merge",
        sub: "repo:fixture-owner/project:pull_request",
        workflow_ref: "fixture-owner/project/.github/workflows/vector.yml@refs/pull/17/merge",
        head_ref: "fix",
        base_ref: "main",
      })
      .then((token) => fixture.verify(token, "mint"))
  return { ...fixture, options: { ...fixture.options, pullRequest: 17 }, runIdentity: identity }
}

test("a review comment with an unchanged workflow verifies the PR head instead of the default head", async () => {
  await using fixture = await reviewFixture()
  expect(await fixture.app.verifyRun(await fixture.runIdentity(), fixture.options)).toEqual({
    installed: true,
    binder: "ok",
  })
  expect(fixture.tokens.size).toBe(0)
})

test.each([
  "fork",
  "closed",
  "workflow",
  "head-sha",
  "head-ref",
  "job-sha",
  "job-ref",
  "merge-sha",
  "comment-pr",
  "default-ref",
])("review comment refuses changed %s", async (mode) => {
  await using fixture = await reviewFixture()
  if (mode === "fork") fixture.state.prHeadId = 998
  if (mode === "closed") fixture.state.prState = "closed"
  if (mode === "workflow") fixture.state.workflowBlob = "d".repeat(40)
  if (mode === "head-sha") fixture.state.run.head_sha = "d".repeat(40)
  if (mode === "head-ref") fixture.state.run.head_branch = "other"
  if (mode === "job-sha") fixture.state.job.head_sha = "d".repeat(40)
  if (mode === "job-ref") fixture.state.job.head_branch = "other"
  if (mode === "merge-sha") fixture.state.mergeSha = "d".repeat(40)
  if (mode === "comment-pr")
    fixture.state.comment.pull_request_url = "https://api.github.com/repos/fixture-owner/project/pulls/18"
  if (mode === "default-ref") fixture.options.defaultRef = "refs/heads/old"
  await expect(fixture.app.verifyRun(await fixture.runIdentity(), fixture.options)).rejects.toMatchObject({
    code: ["fork", "closed", "comment-pr"].includes(mode) ? "EVENT_NOT_ALLOWED" : "WORKFLOW_NOT_TRUSTED",
  })
  expect(fixture.tokens.size).toBe(0)
})

test.each(["issue_comment", "issues", "pull_request_review_comment", "workflow_dispatch", "schedule"])(
  "a Bot-type actor without the suffix is refused on %s",
  async (event) => {
    await using fixture = event === "pull_request_review_comment" ? await reviewFixture() : await runFixture(event)
    const identity = { ...(await fixture.runIdentity()), actor: "Copilot", actorIsBot: false }
    fixture.state.run.actor = { ...fixture.state.run.actor, login: "Copilot", type: "Bot" }
    fixture.state.run.triggering_actor = fixture.state.run.actor
    fixture.state.comment.user = { ...fixture.state.comment.user, login: "Copilot", type: "Bot" }
    fixture.state.issue.user = { ...fixture.state.issue.user, login: "Copilot", type: "Bot" }
    await expect(fixture.app.verifyRun(identity, fixture.options)).rejects.toMatchObject({ code: "ACTOR_NOT_ALLOWED" })
    expect(fixture.tokens.size).toBe(0)
  },
)

test("ticket-approved bot verification requires the configured App bot id", async () => {
  await using fixture = await runFixture("workflow_dispatch")
  fixture.state.run.actor = { id: 9000, login: "vector-fixture[bot]", type: "Bot" }
  fixture.state.run.triggering_actor = fixture.state.run.actor
  const identity = await fixture
    .makeToken("mint", { event_name: "workflow_dispatch", actor: "vector-fixture[bot]", actor_id: "9000" })
    .then((token) => fixture.verify(token, "mint"))
  await expect(fixture.app.verifyRun(identity, fixture.options)).rejects.toMatchObject({ code: "ACTOR_NOT_ALLOWED" })
  expect(await fixture.app.verifyRun(identity, { ...fixture.options, bot: true })).toEqual({
    installed: true,
    binder: "ok",
  })
  fixture.state.botId++
  await expect(fixture.app.verifyRun(identity, { ...fixture.options, bot: true })).rejects.toMatchObject({
    code: "ACTOR_NOT_ALLOWED",
  })
})

test("bind checks the dedicated job and current permission before granting admin takeover", async () => {
  await using fixture = await githubAppFixture()
  fixture.state.run.event = "workflow_dispatch"
  fixture.state.job.name = "Vector bind"
  const identity = await fixture
    .makeToken("bind", { event_name: "workflow_dispatch" })
    .then((token) => fixture.verify(token, "bind"))
  expect(await fixture.app.verifyBind(identity)).toEqual({
    installed: true,
    defaultRef: "refs/heads/main",
    installationId: "600",
    adminVerified: false,
  })
  fixture.state.permission = "admin"
  expect(await fixture.app.verifyBind(identity)).toEqual({
    installed: true,
    defaultRef: "refs/heads/main",
    installationId: "600",
    adminVerified: true,
  })
  fixture.state.permission = "read"
  await expect(fixture.app.verifyBind(identity)).rejects.toMatchObject({ code: "ACTOR_NOT_ALLOWED" })
  fixture.state.permission = "write"
  fixture.state.job.name = "Vector task"
  await expect(fixture.app.verifyBind(identity)).rejects.toMatchObject({ code: "WORKFLOW_NOT_TRUSTED" })
  expect(fixture.tokens.size).toBe(0)
})

test("missing installations grant no verification and cache failures fail closed", async () => {
  await using fixture = await runFixture()
  fixture.state.installed = false
  expect(await fixture.app.verifyRun(await fixture.runIdentity(), fixture.options)).toEqual({ installed: false })
  fixture.state.installed = true
  fixture.state.storeDown = true
  await expect(fixture.app.verifyRun(await fixture.runIdentity(), fixture.options)).rejects.toMatchObject({
    code: "PERSISTENT_STORE_UNAVAILABLE",
  })
  fixture.state.storeDown = false
  fixture.state.cache.set(`vector:cloud-agents:binder-ok:${fixture.repositoryId}`, { value: "1", until: Infinity })
  await expect(fixture.app.verifyRun(await fixture.runIdentity(), fixture.options)).rejects.toMatchObject({
    code: "PERSISTENT_STORE_UNAVAILABLE",
  })
  expect(fixture.tokens.size).toBe(0)
})

test("a warm binder cache never substitutes for current actor and rerun-actor write permission", async () => {
  await using fixture = await runFixture()
  await fixture.app.verifyRun(await fixture.runIdentity(), fixture.options)
  fixture.state.permission = "read"
  await expect(fixture.app.verifyRun(await fixture.runIdentity(), fixture.options)).rejects.toMatchObject({
    code: "ACTOR_NOT_ALLOWED",
  })
  fixture.state.permission = "write"
  fixture.state.run.triggering_actor = { id: 999, login: "rerun-person", type: "User" }
  fixture.state.triggeringPermission = "read"
  await expect(fixture.app.verifyRun(await fixture.runIdentity(), fixture.options)).rejects.toMatchObject({
    code: "ACTOR_NOT_ALLOWED",
  })
  expect(fixture.tokens.size).toBe(0)
  expect(fixture.state.storeCommands.filter((command) => command[0] === "GET")).toHaveLength(1)
})
