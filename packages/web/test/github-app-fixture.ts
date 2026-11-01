import { expect } from "bun:test"
import { exportJWK, exportPKCS8, generateKeyPair, jwtVerify, SignJWT } from "jose"
import { createGithubApp } from "../../../api/_lib/github-app"
import {
  createGithubOidcVerifier,
  githubOidcAudiences,
  githubOidcIssuer,
  githubOidcJwks,
  type GithubOidcPurpose,
} from "../../../api/_lib/github-oidc"
import { persistentStore } from "../../../api/_lib/persistent-store"
import type { GithubRequest } from "../../../api/_lib/github-http"

export async function githubAppFixture(input: { store?: typeof persistentStore } = {}) {
  const appKey = await generateKeyPair("RS256", { extractable: true })
  const oidcKey = await generateKeyPair("RS256")
  const jwk = { ...(await exportJWK(oidcKey.publicKey)), kid: "github-fixture-key", alg: "RS256", use: "sig" }
  const config = {
    id: "42",
    clientId: "Iv23fixture",
    slug: "vector-fixture",
    privateKey: await exportPKCS8(appKey.privateKey),
  }
  const repositoryId = String(100_000_000 + crypto.getRandomValues(new Uint32Array(1))[0]!)
  const owner = { id: 456, login: "fixture-owner", type: "Organization" }
  const person = { id: 789, login: "fixture-person", type: "User" }
  const repository = {
    id: Number(repositoryId),
    full_name: "fixture-owner/project",
    owner,
    default_branch: "main",
    archived: false,
    disabled: false,
  }
  const run = {
    id: 1000,
    run_attempt: 1,
    event: "issue_comment",
    head_sha: "a".repeat(40),
    head_branch: "main",
    status: "in_progress",
    repository,
    head_repository: repository,
    path: ".github/workflows/vector.yml",
    workflow_id: 500,
    actor: person,
    triggering_actor: person,
    pull_requests: [] as Array<{ number: number }>,
  }
  const job = {
    id: 2000,
    run_id: 1000,
    run_attempt: 1,
    status: "in_progress",
    name: "Vector task",
    head_sha: "a".repeat(40),
    head_branch: "main",
    check_run_url: "https://api.github.com/repos/fixture-owner/project/check-runs/1001",
  }
  const state = {
    enabled: true,
    installed: true,
    suspended: false,
    appId: 42,
    appSlug: config.slug,
    repository,
    run,
    job,
    workflow: { id: 500, path: ".github/workflows/vector.yml", state: "active" },
    permission: "write",
    binder: { id: 790, login: "fixture-binder", type: "User" },
    binderPermission: "write",
    binderMissing: false,
    comment: {
      id: 123,
      user: { ...person },
      body: "/vector fix it",
      issue_url: "https://api.github.com/repos/fixture-owner/project/issues/17",
      pull_request_url: "https://api.github.com/repos/fixture-owner/project/pulls/17",
    },
    issue: {
      number: 17,
      user: { ...person },
      title: "A bug",
      body: "/vector fix it",
      pull_request: undefined as { url: string } | undefined,
    },
    prState: "open",
    prSha: "b".repeat(40),
    prRef: "fix",
    mergeSha: "a".repeat(40),
    workflowBlob: "c".repeat(40),
    defaultWorkflowBlob: "c".repeat(40),
    botId: 9000,
    cache: new Map<string, { value: string; until: number }>(),
    clock: Date.now(),
    storeDown: false,
    storeCommands: [] as (readonly (string | number)[])[],
    triggeringPermission: "write",
    permissionUserId: 789,
    prHeadId: Number(repositoryId),
    prBaseId: Number(repositoryId),
    scopeExtra: false,
    mintMode: "valid",
    failFinalMint: false,
    revokeFailure: false,
    redirectPath: "",
    failPath: "",
    events: [] as string[],
    requests: [] as string[],
    minted: [] as Array<{
      token: string
      purpose: string
      body: { repository_ids: number[]; permissions: Record<string, string> }
    }>,
  }
  const tokens = new Map<string, { purpose: string; permissions: Record<string, string> }>()
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request): Promise<Response> {
      const route = new URL(request.url).pathname
      state.requests.push(route)
      if (route === "/jwks") return Response.json({ keys: [jwk] })
      if (route === state.redirectPath) return new Response(null, { status: 307, headers: { location: "/unexpected" } })
      if (route === state.failPath)
        return Response.json(
          { error: "fixture upstream failure", authorization: request.headers.get("authorization") },
          { status: 503 },
        )
      expect(request.headers.get("x-github-api-version")).toBe("2026-03-10")
      const authorization = request.headers.get("authorization")?.replace(/^Bearer /, "")
      if (route.startsWith("/users/")) {
        expect(authorization).toBeUndefined()
        return Response.json({ id: state.botId, login: `${config.slug}[bot]`, type: "Bot" })
      }
      if (route === "/app" || route.endsWith("/installation") || route.endsWith("/access_tokens")) {
        const signed = await jwtVerify(authorization!, appKey.publicKey, {
          issuer: config.clientId,
          algorithms: ["RS256"],
        })
        expect(signed.payload.exp! - signed.payload.iat!).toBe(360)
        expect(signed.payload.iat).toBeLessThanOrEqual(Math.floor(Date.now() / 1000) - 59)
        if (route === "/app") return Response.json({ id: state.appId, slug: state.appSlug })
        if (route.endsWith("/installation"))
          return state.installed
            ? Response.json({
                id: 600,
                app_id: state.appId,
                account: owner,
                suspended_at: state.suspended ? "2026-09-25T00:00:00Z" : null,
              })
            : new Response(null, { status: 404 })
        const body = (await request.json()) as { repository_ids: number[]; permissions: Record<string, string> }
        expect(body.repository_ids).toEqual([Number(repositoryId)])
        const purpose =
          body.permissions.actions === "read"
            ? "validation"
            : body.permissions.actions === "write"
              ? "task"
              : body.permissions.contents === "write"
                ? "publish"
                : "review"
        state.events.push(`mint:${purpose}`)
        if (state.failFinalMint && purpose !== "validation") return new Response(null, { status: 503 })
        const token = `ghs_fixture_${crypto.randomUUID().replaceAll("-", "")}`
        tokens.set(token, { purpose, permissions: body.permissions })
        state.minted.push({ token, purpose, body })
        const permissions =
          state.mintMode === "extra-permission" && purpose !== "validation"
            ? { ...body.permissions, administration: "write" }
            : body.permissions
        const expires =
          state.mintMode === "expired" && purpose !== "validation"
            ? -1000
            : state.mintMode === "too-long" && purpose !== "validation"
              ? 7_200_000
              : 3_599_000
        return Response.json({ token, expires_at: new Date(Date.now() + expires).toISOString(), permissions })
      }
      const token = tokens.get(authorization ?? "")
      if (!token) return new Response(null, { status: 401 })
      if (route === "/installation/token") {
        expect(request.method).toBe("DELETE")
        state.events.push(`revoke:${token.purpose}`)
        if (state.revokeFailure) return new Response(null, { status: 503 })
        tokens.delete(authorization!)
        return new Response(null, { status: 204 })
      }
      if (route === "/installation/repositories") {
        state.events.push(`scope:${token.purpose}`)
        return Response.json({
          total_count: state.scopeExtra && token.purpose !== "validation" ? 2 : 1,
          repositories: [state.repository],
        })
      }
      expect(token.purpose).toBe("validation")
      if (route === "/repos/fixture-owner/project") return Response.json(state.repository)
      if (route.endsWith("/attempts/1")) return Response.json(state.run)
      if (route.endsWith("/workflows/500")) return Response.json(state.workflow)
      if (route.endsWith("/jobs")) return Response.json({ total_count: 1, jobs: [state.job] })
      if (route.startsWith("/user/"))
        return state.binderMissing ? new Response(null, { status: 404 }) : Response.json(state.binder)
      if (route.endsWith("/issues/comments/123") || route.endsWith("/pulls/comments/123"))
        return Response.json(state.comment)
      if (route.endsWith("/issues/17")) return Response.json(state.issue)
      if (route.includes("/contents/"))
        return Response.json({
          type: "file",
          sha:
            new URL(request.url).searchParams.get("ref") === "refs/heads/main"
              ? state.defaultWorkflowBlob
              : state.workflowBlob,
        })
      if (route.includes("/collaborators/")) {
        const login = route.split("/").at(-2)!
        return Response.json({
          permission:
            login === state.binder.login
              ? state.binderPermission
              : login === person.login
                ? state.permission
                : state.triggeringPermission,
          user: {
            ...person,
            login,
            id:
              login === state.binder.login
                ? state.binder.id
                : login === person.login
                  ? state.permissionUserId
                  : state.run.triggering_actor.id,
          },
        })
      }
      if (route.includes("/pulls/"))
        return Response.json({
          number: Number(route.split("/").at(-1)),
          state: state.prState,
          merge_commit_sha: state.mergeSha,
          base: { repo: { id: state.prBaseId }, ref: "main" },
          head: { repo: { id: state.prHeadId }, sha: state.prSha, ref: state.prRef },
        })
      return new Response(null, { status: 404 })
    },
  })
  const request: GithubRequest = (url, init) => {
    if (url === githubOidcJwks) return fetch(new URL("/jwks", server.url), init)
    expect(new URL(url).origin).toBe("https://api.github.com")
    expect(init.redirect).toBe("error")
    return fetch(new URL(new URL(url).pathname + new URL(url).search, server.url), init)
  }
  const verify = createGithubOidcVerifier(request)
  const app = createGithubApp({
    configuration: () => (state.enabled ? config : undefined),
    request,
    store:
      input.store ??
      (async (command) => {
        state.storeCommands.push(command)
        if (state.storeDown) throw new Error("fixture store down")
        const key = String(command[1])
        if (command[0] === "GET") {
          const saved = state.cache.get(key)
          return saved && saved.until > state.clock ? saved.value : null
        }
        expect(command[0]).toBe("EVAL")
        expect(command[2]).toBe("2")
        expect(String(command[4]).startsWith("vector:cli-revoked:")).toBe(true)
        expect(command[6]).toBe(3600)
        state.cache.set(String(command[3]), { value: String(command[5]), until: state.clock + 3_600_000 })
        return "OK"
      }),
  })
  const makeToken = (purpose: GithubOidcPurpose = "token", change: Record<string, unknown> = {}) => {
    const now = Math.floor(Date.now() / 1000)
    return new SignJWT({
      iss: githubOidcIssuer,
      aud: githubOidcAudiences[purpose],
      sub: "repo:fixture-owner/project:ref:refs/heads/main",
      iat: now,
      nbf: now - 5,
      exp: now + 300,
      jti: crypto.randomUUID(),
      repository: "fixture-owner/project",
      repository_id: repositoryId,
      repository_owner: "fixture-owner",
      repository_owner_id: "456",
      actor: "fixture-person",
      actor_id: "789",
      run_id: "1000",
      run_attempt: "1",
      check_run_id: "1001",
      sha: "a".repeat(40),
      workflow_sha: "a".repeat(40),
      ref: "refs/heads/main",
      ref_type: "branch",
      workflow_ref: "fixture-owner/project/.github/workflows/vector.yml@refs/heads/main",
      event_name: "issue_comment",
      ...(purpose === "mint" ? { runner_environment: "github-hosted" } : {}),
      ...change,
    })
      .setProtectedHeader({ alg: "RS256", typ: "JWT", kid: jwk.kid })
      .sign(oidcKey.privateKey)
  }
  return {
    state,
    app,
    verify,
    makeToken,
    repositoryId,
    config,
    request,
    tokens,
    identity: () => makeToken().then((token) => verify(token, "token")),
    [Symbol.asyncDispose]: () => server.stop(true),
  }
}
