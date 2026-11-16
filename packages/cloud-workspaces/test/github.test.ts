import { expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { snapshotDigest, type ExportWorkspaceSnapshot } from "../src/docker"
import { publishWorkspaceChanges, type PublishWorkspaceInput } from "../src/github"

const base = "b".repeat(40)
const tree = "d".repeat(40)
const commit = "c".repeat(40)
const workspaceId = "workspace_0123456789abcdef"
const token = "ghp_not_a_real_credential_for_local_tests"
const snapshot: ExportWorkspaceSnapshot = {
  baseCommit: base,
  changes: [{ path: "hello.txt", mode: "100644", content: Buffer.from("hello\n").toString("base64") }],
  diff: "diff --git a/hello.txt b/hello.txt\n+hello\n",
  digest: "",
}
snapshot.digest = snapshotDigest(snapshot)
const input: PublishWorkspaceInput = {
  repository: "acme/demo",
  baseBranch: "main",
  baseCommit: base,
  snapshot,
  token,
  workspaceId,
  title: "Add hello",
}
const trailer = `\n\nVector-Workspace: ${workspaceId}\nVector-Snapshot: ${snapshot.digest}`

function fixture() {
  const calls: { url: URL; method: string; init: RequestInit; body?: Record<string, unknown> }[] = []
  const state = {
    push: true,
    currentBase: base,
    branchCommit: "",
    refPosts: 0,
    commitPosts: 0,
    pullPosts: 0,
    lostRefReply: false,
    lostPullReply: false,
    advanceBeforeReference: false,
    moveHeadBeforePull: false,
    abortAfterBase: undefined as AbortController | undefined,
    savedCommit: {
      sha: commit,
      message: `Vector Cloud: Add hello${trailer}`,
      tree: { sha: tree },
      parents: [{ sha: base }],
    },
    pull: undefined as Record<string, unknown> | undefined,
  }
  const pull = (): Record<string, unknown> => ({
    html_url: "https://github.com/acme/demo/pull/12",
    draft: true,
    state: "open",
    head: { ref: `vector/${workspaceId}`, sha: commit, repo: { full_name: "acme/demo" } },
    base: { ref: "main", repo: { full_name: "acme/demo" } },
  })
  const fetcher: typeof fetch = Object.assign(
    async (value: string | URL | Request, init: RequestInit = {}) => {
      const url = new URL(String(value))
      const method = init.method ?? "GET"
      const body = typeof init.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : undefined
      calls.push({ url, method, init, ...(body ? { body } : {}) })
      const path = url.pathname.replace("/repos/acme/demo", "")
      if (method === "GET" && path === "")
        return Response.json({ full_name: "acme/demo", permissions: { push: state.push } })
      if (method === "GET" && path === "/git/ref/heads/main")
        return Response.json({ object: { type: "commit", sha: state.currentBase } })
      if (method === "GET" && path === `/git/commits/${base}`) {
        state.abortAfterBase?.abort(new Error("account closed"))
        return Response.json({ sha: base, tree: { sha: "a".repeat(40) } })
      }
      if (method === "POST" && path === "/git/blobs") {
        const bytes = Buffer.from(String(body!.content), "base64")
        return Response.json({
          sha: createHash("sha1").update(`blob ${bytes.byteLength}\0`).update(bytes).digest("hex"),
        })
      }
      if (method === "POST" && path === "/git/trees") {
        if (state.advanceBeforeReference) state.currentBase = "f".repeat(40)
        return Response.json({ sha: tree })
      }
      if (method === "GET" && path === `/git/ref/heads/vector/${workspaceId}`)
        return state.branchCommit
          ? Response.json({ object: { type: "commit", sha: state.branchCommit } })
          : new Response(null, { status: 404 })
      if (method === "POST" && path === "/git/commits") {
        state.commitPosts++
        return Response.json({ sha: commit })
      }
      if (method === "GET" && path === `/git/commits/${commit}`) return Response.json(state.savedCommit)
      if (method === "POST" && path === "/git/refs") {
        state.refPosts++
        state.branchCommit = String(body!.sha)
        if (state.lostRefReply) {
          state.lostRefReply = false
          throw new Error("simulated lost response")
        }
        return Response.json({ ref: `refs/heads/vector/${workspaceId}`, object: { type: "commit", sha: commit } })
      }
      if (method === "GET" && path === "/pulls") {
        if (state.moveHeadBeforePull) state.branchCommit = "e".repeat(40)
        return Response.json(state.pull ? [state.pull] : [])
      }
      if (method === "POST" && path === "/pulls") {
        state.pullPosts++
        state.pull = pull()
        if (state.lostPullReply) {
          state.lostPullReply = false
          throw new Error("simulated lost response")
        }
        return Response.json(state.pull)
      }
      throw new Error(`Unexpected fixture operation ${method} ${path}`)
    },
    { preconnect: fetch.preconnect },
  )
  return { calls, state, fetcher, pull }
}

test("publish creates only a vector branch and draft PR from exact reviewed bytes with one-shot server auth", async () => {
  const value = fixture()
  expect(await publishWorkspaceChanges(input, value.fetcher)).toEqual({
    url: "https://github.com/acme/demo/pull/12",
    branch: `vector/${workspaceId}`,
    commit,
  })
  for (const call of value.calls) {
    expect(call.url.origin).toBe("https://api.github.com")
    expect(call.init.redirect).toBe("error")
    expect(new Headers(call.init.headers).get("authorization")).toBe(`Bearer ${token}`)
    expect(call.url.href).not.toContain(token)
    expect(JSON.stringify(call.body ?? null)).not.toContain(token)
    expect(["GET", "POST"]).toContain(call.method)
    expect(call.url.pathname).not.toContain("/merge")
  }
  const reference = value.calls.find((call) => call.url.pathname.endsWith("/git/refs"))!
  expect(reference.body).toEqual({ ref: `refs/heads/vector/${workspaceId}`, sha: commit })
  const pull = value.calls.find((call) => call.method === "POST" && call.url.pathname.endsWith("/pulls"))!
  expect(pull.body).toMatchObject({ draft: true, head: `vector/${workspaceId}`, base: "main", title: "Add hello" })
  const built = value.calls.find((call) => call.url.pathname.endsWith("/git/trees"))!
  expect(built.body).toMatchObject({
    base_tree: "a".repeat(40),
    tree: [{ path: "hello.txt", mode: "100644", type: "blob" }],
  })
})

test("read-only token or moved original branch prevents any branch/PR publication", async () => {
  for (const change of ["permission", "moved-early", "moved-before-reference"]) {
    const value = fixture()
    if (change === "permission") value.state.push = false
    if (change === "moved-early") value.state.currentBase = "f".repeat(40)
    if (change === "moved-before-reference") value.state.advanceBeforeReference = true
    await expect(publishWorkspaceChanges(input, value.fetcher)).rejects.toThrow(
      change === "permission" ? "repository_access_denied" : "base_branch_changed",
    )
    expect(value.state.refPosts).toBe(0)
    expect(value.state.pullPosts).toBe(0)
  }
})

test("changed review digest, traversal and no changes fail before contacting GitHub", async () => {
  const empty = { baseCommit: base, changes: [], diff: "", digest: "" }
  empty.digest = snapshotDigest(empty)
  for (const request of [
    { ...input, snapshot: { ...snapshot, digest: "f".repeat(64) } },
    { ...input, snapshot: { ...snapshot, changes: [{ path: "../secret", mode: "100644" as const, content: "" }] } },
    { ...input, repository: "https://github.com/acme/demo" },
    { ...input, baseBranch: "main/../../other" },
    { ...input, snapshot: empty },
  ]) {
    const value = fixture()
    await expect(publishWorkspaceChanges(request, value.fetcher)).rejects.toThrow()
    expect(value.calls).toHaveLength(0)
  }
})

test("an existing deterministic branch is reusable only for the same parent, digest and actual tree", async () => {
  for (const mismatch of ["parent", "digest", "tree"]) {
    const value = fixture()
    value.state.branchCommit = commit
    if (mismatch === "parent") value.state.savedCommit.parents = [{ sha: "f".repeat(40) }]
    if (mismatch === "digest")
      value.state.savedCommit.message = `Vector Cloud: Add hello${trailer.replace(snapshot.digest, "f".repeat(64))}`
    if (mismatch === "tree") value.state.savedCommit.tree.sha = "f".repeat(40)
    await expect(publishWorkspaceChanges(input, value.fetcher)).rejects.toThrow("publication_conflict")
    expect(value.state.refPosts).toBe(0)
    expect(value.state.pullPosts).toBe(0)
    expect(value.calls.some((call) => call.method === "PATCH")).toBe(false)
  }
})

test("lost branch and PR replies resume idempotently without duplicate publication", async () => {
  for (const lost of ["ref", "pull"]) {
    const value = fixture()
    value.state.lostRefReply = lost === "ref"
    value.state.lostPullReply = lost === "pull"
    const first = await publishWorkspaceChanges(input, value.fetcher)
    const second = await publishWorkspaceChanges(input, value.fetcher)
    expect(second).toEqual(first)
    expect(value.state.refPosts).toBe(1)
    expect(value.state.commitPosts).toBe(1)
    expect(value.state.pullPosts).toBe(1)
  }
})

test("publication never reuses a foreign pull request or changes an already-open nondraft PR", async () => {
  const value = fixture()
  value.state.branchCommit = commit
  value.state.pull = { ...value.pull(), draft: false }
  await expect(publishWorkspaceChanges(input, value.fetcher)).rejects.toThrow("publication_conflict")
  expect(value.state.pullPosts).toBe(0)
})

test("a malicious pull-request URL is not returned to the UI", async () => {
  const value = fixture()
  value.state.branchCommit = commit
  value.state.pull = { ...value.pull(), html_url: "https://evil.test/collect" }
  await expect(publishWorkspaceChanges(input, value.fetcher)).rejects.toThrow("github_unavailable")
})

test("a destination branch moved by another writer is detected before creating the draft PR", async () => {
  const value = fixture()
  value.state.moveHeadBeforePull = true
  await expect(publishWorkspaceChanges(input, value.fetcher)).rejects.toThrow("publication_conflict")
  expect(value.state.refPosts).toBe(1)
  expect(value.state.pullPosts).toBe(0)
})

test("account cancellation before dispatch or after read-only planning prevents the next outbound mutation", async () => {
  for (const when of ["before", "after-base"]) {
    const value = fixture()
    const controller = new AbortController()
    if (when === "before") controller.abort(new Error("account closed"))
    else value.state.abortAfterBase = controller
    await expect(publishWorkspaceChanges({ ...input, signal: controller.signal }, value.fetcher)).rejects.toThrow(
      "account closed",
    )
    expect(value.calls.some((call) => call.method !== "GET")).toBe(false)
    expect(value.state.refPosts).toBe(0)
    expect(value.state.pullPosts).toBe(0)
    if (when === "before") expect(value.calls).toHaveLength(0)
  }
})
