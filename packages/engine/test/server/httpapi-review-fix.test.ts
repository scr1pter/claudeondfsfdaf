import { $ } from "bun"
import { afterEach, describe, expect, test } from "bun:test"
import { createHash, randomUUID } from "node:crypto"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { ConfigProvider, Effect, Layer, Schema } from "effect"
import { HttpServer } from "effect/unstable/http"
import { GUEST_REQUEST_HEADER } from "@vectordevai/core/free-model-guests"
import { Global } from "@vectordevai/core/global"
import { LayerNode } from "@vectordevai/core/effect/layer-node"
import { FIX_LIMITS } from "@vectordevai/core/review/fix-proposal"
import { ReviewFixControl } from "@vectordevai/schema/review-fix"
import { Config } from "@/config/config"
import { AppNodeBuilderV1 } from "@/effect/app-node-builder-v1"
import { InstanceState } from "@/effect/instance-state"
import { Git } from "@/git"
import { InstanceHooks } from "@/project/instance-hooks"
import { InstanceStore } from "@/project/instance-store"
import { ReviewFix } from "@/review/fix"
import { ReviewFixOwner } from "@/review/fix-owner"
import { ReviewOwner } from "@/review/owner"
import { Session } from "@/session/session"
import { SessionID } from "@/session/schema"
import { disposeAllInstances, tmpdirScoped } from "../fixture/fixture"
import { resetDatabase } from "../fixture/db"
import { testEffect } from "../lib/effect"
import { TestLLMServer } from "../lib/llm-server"
import { testProviderConfig } from "../lib/test-provider"
import { httpApiLayer } from "./httpapi-layer"

const parentID = SessionID.make("ses_local_fix_http_parent")
const auth = (user: string, password: string) => `Basic ${Buffer.from(`${user}:${password}`).toString("base64")}`
const owner = { authorization: auth("vector", "owner-secret") }
const guest = { authorization: auth("guest", "guest-secret") }
const forwarded = { ...owner, [GUEST_REQUEST_HEADER]: "1" }
const serverConfig = ConfigProvider.layer(
  ConfigProvider.fromUnknown({
    VECTOR_SERVER_USERNAME: "vector",
    VECTOR_SERVER_PASSWORD: "owner-secret",
    VECTOR_SERVER_GUEST_USERNAME: "guest",
    VECTOR_SERVER_GUEST_PASSWORD: "guest-secret",
    VECTOR_SERVER_GUEST_SESSIONS: parentID,
    VECTOR_DISABLE_DEFAULT_PLUGINS: true,
  }),
)
// CI sets CI=true on every runner, which the fix API refuses as the CLI's apply step does. The server here runs as on
// a developer's computer; one case checks the context gate itself.
const developer = Layer.succeed(ReviewFix.RunnerContext)(() => undefined)
const testLayer = Layer.mergeAll(
  httpApiLayer.pipe(Layer.provide(serverConfig), Layer.provide(developer)),
  TestLLMServer.layer,
  AppNodeBuilderV1.build(
    LayerNode.group([InstanceHooks.node, InstanceStore.node, Session.node, ReviewOwner.node, ReviewFix.node, Git.node]),
  ),
)
const it = testEffect(testLayer)
const linuxLive = process.platform === "linux" ? it.live : it.live.skip
const nonLinuxLive = process.platform === "linux" ? it.live.skip : it.live
const call = <A>(run: () => Promise<A>) => Effect.promise(run)
const git = (cwd: string, ...args: string[]) =>
  call(() => $`git ${args}`.cwd(cwd).quiet().text()).pipe(Effect.map((text) => text.trim()))
const write = (directory: string, files: Record<string, string>) =>
  call(() =>
    Promise.all(
      Object.entries(files).map(async (entry) => {
        await fs.mkdir(path.dirname(path.join(directory, entry[0])), { recursive: true })
        await fs.writeFile(path.join(directory, entry[0]), entry[1])
      }),
    ),
  )
const digest = (text: string) => `sha256:${createHash("sha256").update(text).digest("hex")}`
const root = `/experimental/session/${parentID}/review/fix`
const HEAD_A = "export const a = 2\n"
const FIXED_A = "export const a = 3\n"
const DIRTY_B = "export const b = 'USER_DIRTY_WORK'\n"
const PATCH = `diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-${HEAD_A}+${FIXED_A}`

const fixture = Effect.fn("ReviewFixHttpTest.fixture")(function* (enabled = true) {
  const llm = yield* TestLLMServer
  const directory = yield* tmpdirScoped({
    git: true,
    trusted: true,
    config: { ...testProviderConfig(llm.url), experimental: { vectorscope: true } },
    init: (directory) =>
      Effect.gen(function* () {
        yield* write(directory, {
          "src/a.ts": "export const a = 1\n",
          "src/b.ts": "export const b = 1\n",
          // Checks need its dependencies installed, and a fresh fix checkout has none.
          "package.json": JSON.stringify({ name: "fix-fixture", devDependencies: { "left-pad": "1.3.0" } }),
        })
        yield* git(directory, "config", "core.autocrlf", "false")
        yield* git(directory, "add", ".")
        yield* git(directory, "commit", "-qm", "fix base")
        yield* git(directory, "branch", "-M", "main")
        yield* git(directory, "switch", "-qc", "feature")
        yield* write(directory, { "src/a.ts": HEAD_A })
        // Someone else's commit: a check would run their code.
        yield* git(directory, "commit", "-qam", "fix head", "--author", "Other Author <other@vector.test>")
      }),
  })
  const base = yield* git(directory, "rev-parse", "main")
  const head = yield* git(directory, "rev-parse", "HEAD")
  // The user's own uncommitted work, which no fix step may change or copy.
  yield* write(directory, { "src/b.ts": DIRTY_B, "notes.txt": "USER_UNTRACKED\n" })
  const status = yield* git(directory, "status", "--porcelain")
  const server = yield* HttpServer.HttpServer
  const baseUrl = HttpServer.formatAddress(server.address)
  const raw = (method: string, route: string, headers: Record<string, string> = owner, body?: unknown) =>
    call(() =>
      fetch(new URL(route, baseUrl), {
        method,
        headers: { "x-vector-directory": directory, ...headers, "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    )
  const configure = (body: unknown) =>
    raw("PATCH", "/global/config", owner, body).pipe(Effect.map((response) => expect(response.status).toBe(200)))
  const file = path.join(Global.Path.config, "vector.json")
  const previous = yield* call(() =>
    fs.readFile(file).catch((error: unknown) => {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return undefined
      throw error
    }),
  )
  yield* Effect.addFinalizer(() =>
    call(async () => {
      if (previous === undefined) await fs.rm(file, { force: true })
      else await fs.writeFile(file, previous)
      Config.refreshLocal()
      Config.confirmLocal()
    }),
  )
  yield* configure({
    experimental: { vectorscope: enabled },
    agent: { vectorscope: { model: "lmstudio/test-model", disable: false } },
  })
  const created = yield* call(() =>
    fetch(new URL("/api/session", baseUrl), {
      method: "POST",
      headers: { ...owner, "content-type": "application/json" },
      body: JSON.stringify({ id: parentID, title: "Local fix owner", location: { directory } }),
    }),
  )
  expect(created.status, yield* call(() => created.text())).toBe(200)
  // Cancels whatever a case left open, so the engine's per-project fix limit never carries over.
  yield* Effect.addFinalizer(() =>
    Effect.gen(function* () {
      const listed = yield* raw("GET", root)
      if (listed.status !== 200) return
      const body = (yield* call(() => listed.json())) as { fixes: { fixID: string }[] }
      yield* Effect.forEach(body.fixes, (item) => raw("POST", `${root}/${item.fixID}/cancel`), { discard: true })
    }).pipe(Effect.ignore),
  )
  const prepare: ReviewFixControl.Prepare = {
    source: { kind: "client" },
    head,
    base,
    baseBranch: "main",
    findings: ["finding-1"],
    files: [{ path: "src/a.ts", preimage: digest(HEAD_A), postimage: digest(FIXED_A) }],
    patch: PATCH,
  }
  return { directory, raw, configure, prepare, head, base, status, llm }
})
type Fixture = Effect.Success<ReturnType<typeof fixture>>

function data<S extends Schema.Top>(response: Response, schema: S) {
  return call(() => response.text()).pipe(
    Effect.tap((text) => Effect.sync(() => expect(response.status, text).toBe(200))),
    Effect.flatMap((text) => Schema.decodeUnknownEffect(schema)(JSON.parse(text))),
  )
}
/** A refusal's code and message (the review group's typed 400). */
const refused = (response: Response) =>
  call(() => response.json()).pipe(
    Effect.map((body) => {
      expect(response.status, JSON.stringify(body)).toBe(400)
      return body as { code?: string; message?: string }
    }),
  )
const prepared = (f: Fixture, body: unknown = f.prepare) =>
  f.raw("POST", root, owner, body).pipe(Effect.flatMap((response) => data(response, ReviewFixControl.Preview)))
const offered = (f: Fixture, fixID: string, request: unknown) =>
  f
    .raw("POST", `${root}/${fixID}/preview`, owner, request)
    .pipe(Effect.flatMap((response) => data(response, ReviewFixControl.Offer)))
const echo = (offer: ReviewFixControl.Offer) => ({
  offerID: offer.offerID,
  head: offer.head,
  patchDigest: offer.patchDigest,
  operationDigest: offer.operationDigest,
})
const execute = (f: Fixture, offer: ReviewFixControl.Offer, headers: Record<string, string> = owner) =>
  f.raw("POST", `${root}/${offer.fixID}/execute`, headers, echo(offer))
const executed = (f: Fixture, offer: ReviewFixControl.Offer) =>
  execute(f, offer).pipe(Effect.flatMap((response) => data(response, ReviewFixControl.Result)))
const listed = (f: Fixture) =>
  f.raw("GET", root).pipe(Effect.flatMap((response) => data(response, ReviewFixControl.List)))
const worktrees = (directory: string) =>
  git(directory, "worktree", "list", "--porcelain").pipe(
    Effect.map((text) => text.split("\n").filter((line) => line.startsWith("worktree ")).length),
  )
const vectorRefs = (directory: string) => git(directory, "for-each-ref", "--format=%(refname)", "refs/heads/vector/")
/** Every fix route, each with a body of the right shape, under `base`. */
const routes = (f: Fixture, base = root, fixID = "fix_guessed") =>
  [
    ["GET", base, undefined],
    ["POST", base, f.prepare],
    ["POST", `${base}/${fixID}/preview`, { kind: "apply" }],
    [
      "POST",
      `${base}/${fixID}/execute`,
      { offerID: randomUUID(), head: f.head, patchDigest: digest("patch"), operationDigest: digest("operation") },
    ],
    ["POST", `${base}/${fixID}/cancel`, undefined],
  ] as const

afterEach(async () => {
  await disposeAllInstances()
  await resetDatabase()
})

describe("owner local fix HTTP boundary (SF-10a)", () => {
  test("the wire bounds are the core contract's, and an approval stands for less than a consent may", () => {
    for (const key of [
      "patchBytes",
      "files",
      "findings",
      "pathBytes",
      "commands",
      "arguments",
      "messageBytes",
      "outputBytes",
    ] as const)
      expect(ReviewFixControl.LIMIT[key]).toBe(FIX_LIMITS[key])
    expect(ReviewFixOwner.LIMIT.approvalMs).toBeLessThan(FIX_LIMITS.consentMs)
    expect(ReviewFixOwner.LIMIT.fixes).toBe(ReviewFixControl.LIMIT.fixes)
  })

  it.live("owner credentials are required on every fix route, and the routes are advertised", () =>
    Effect.gen(function* () {
      const f = yield* fixture()
      for (const headers of [{}, { authorization: auth("vector", "wrong-secret") }] as Record<string, string>[])
        for (const [method, route, body] of routes(f))
          expect((yield* f.raw(method, route, headers, body)).status).toBe(401)
      expect(yield* worktrees(f.directory)).toBe(1)
      const capabilities = yield* f.raw("GET", "/experimental/capabilities")
      expect(yield* call(() => capabilities.json())).toMatchObject({ vectorscopeLocalFixes: true })
      expect(yield* f.llm.calls).toBe(0)
    }),
  )

  it.live("guests and forwarded guests are refused every fix route, even on a conversation the guest may use", () =>
    Effect.gen(function* () {
      const f = yield* fixture()
      for (const headers of [guest, forwarded])
        for (const [method, route, body] of routes(f))
          expect((yield* f.raw(method, route, headers, body)).status).toBe(403)
      expect(yield* worktrees(f.directory)).toBe(1)
      expect(yield* f.llm.calls).toBe(0)
    }),
  )

  linuxLive("a guest cannot execute or spend the owner's offer", () =>
    Effect.gen(function* () {
      const f = yield* fixture()
      const preview = yield* prepared(f)
      const offer = yield* offered(f, preview.fixID, { kind: "apply" })
      for (const headers of [guest, forwarded]) expect((yield* execute(f, offer, headers)).status).toBe(403)
      expect((yield* executed(f, offer)).kind).toBe("apply")
      expect(yield* f.llm.calls).toBe(0)
    }),
  )

  linuxLive(
    "only the global setting turns new fixes on; turning it off keeps cancel and list, and leaves an offer unspent",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture(false)
        // The repository's own vector.json turns experimental.vectorscope on; that is not the owner's setting.
        expect((yield* refused(yield* f.raw("POST", root, owner, f.prepare))).code).toBe("disabled")
        yield* f.configure({ experimental: { vectorscope: true }, agent: { vectorscope: { disable: true } } })
        expect((yield* refused(yield* f.raw("POST", root, owner, f.prepare))).code).toBe("disabled")
        expect(yield* worktrees(f.directory)).toBe(1)
        yield* f.configure({ agent: { vectorscope: { disable: false } } })
        const preview = yield* prepared(f)
        const offer = yield* offered(f, preview.fixID, { kind: "apply" })
        yield* f.configure({ experimental: { vectorscope: false } })
        expect(
          (yield* refused(yield* f.raw("POST", `${root}/${preview.fixID}/preview`, owner, { kind: "apply" }))).code,
        ).toBe("disabled")
        expect((yield* refused(yield* execute(f, offer))).code).toBe("disabled")
        yield* f.configure({ experimental: { vectorscope: true } })
        // The disabled execute did not spend the offer.
        expect((yield* executed(f, offer)).kind).toBe("apply")
        yield* f.configure({ experimental: { vectorscope: false } })
        expect((yield* listed(f)).fixes.map((item) => [item.fixID, item.state])).toEqual([[preview.fixID, "applied"]])
        const cleanup = yield* f
          .raw("POST", `${root}/${preview.fixID}/cancel`)
          .pipe(Effect.flatMap((response) => data(response, ReviewFixControl.Cleanup)))
        expect(cleanup).toEqual({ fixID: preview.fixID, removed: true })
        expect(yield* worktrees(f.directory)).toBe(1)
        expect((yield* listed(f)).fixes).toEqual([])
        expect(yield* f.llm.calls).toBe(0)
      }),
    30_000,
  )

  linuxLive(
    "requests cannot carry authority: placement, branches, actor, consent, identity and operations are the engine's",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture()
        for (const field of [
          "scope",
          "repository",
          "worktree",
          "sourceBranch",
          "destinationBranch",
          "actor",
          "consent",
          "policy",
          "identity",
          "version",
        ]) {
          const response = yield* f.raw("POST", root, owner, { ...f.prepare, [field]: "forged" })
          expect(response.status).toBe(400)
          expect((yield* call(() => response.json())).code).toBeUndefined()
        }
        expect((yield* f.raw("POST", root, owner, { ...f.prepare, source: { kind: "review" } })).status).toBe(400)
        expect(yield* worktrees(f.directory)).toBe(1)
        // A patch the executor refuses after placing its checkout (a preimage that is not the head's) leaves none.
        const wrong = yield* refused(
          yield* f.raw("POST", root, owner, {
            ...f.prepare,
            files: [{ path: "src/a.ts", preimage: digest("not the head\n"), postimage: digest(FIXED_A) }],
          }),
        )
        expect(wrong.code).toBe("invalid")
        expect(yield* worktrees(f.directory)).toBe(1)
        expect((yield* listed(f)).fixes).toEqual([])
        const preview = yield* prepared(f)
        expect(preview.source).toEqual({ kind: "client" })
        expect(preview.findingsVerified).toBe(false)
        expect(preview.notes.join(" ")).toContain("did not verify the findings")
        expect(preview.sourceBranch).toBe("feature")
        expect(preview.destinationBranch).toBe(`vector/fix-${preview.fixID.slice(4, 12)}`)
        for (const request of [
          { kind: "commit", message: "forged" },
          { kind: "commit", identity: { name: "Forged", email: "forged@vector.test" } },
          { kind: "push", remote: "file:///tmp/x", mode: "branch", commit: f.head },
          { kind: "checks", commands: [{ argv: ["bun", "test"], cwd: "." }], network: "on" },
          { kind: "checks", commands: [{ argv: ["bun", "test"], cwd: "." }], timeoutMs: 1 },
          { kind: "apply", actor: "forged" },
        ]) {
          const response = yield* f.raw("POST", `${root}/${preview.fixID}/preview`, owner, request)
          expect(response.status).toBe(400)
          expect((yield* call(() => response.json())).code).toBeUndefined()
        }
        const offer = yield* offered(f, preview.fixID, { kind: "apply" })
        for (const extra of [{ actor: "forged" }, { operation: { kind: "apply" } }, { consent: true }])
          expect(
            (yield* f.raw("POST", `${root}/${preview.fixID}/execute`, owner, { ...echo(offer), ...extra })).status,
          ).toBe(400)
        // None of those spent the offer or changed the fix.
        expect((yield* listed(f)).fixes.map((item) => item.state)).toEqual(["preview"])
        expect((yield* executed(f, offer)).kind).toBe("apply")
        expect(yield* f.llm.calls).toBe(0)
      }),
    30_000,
  )

  linuxLive(
    "a stale head is refused before anything is written, and every execute that reaches an offer spends it",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture()
        const early = yield* refused(yield* f.raw("POST", root, owner, { ...f.prepare, head: f.base }))
        expect(early.code).toBe("stale")
        expect(early.message).toContain("no longer at the commit this fix was made for")
        expect(yield* worktrees(f.directory)).toBe(1)
        const preview = yield* prepared(f)
        const offer = yield* offered(f, preview.fixID, { kind: "apply" })
        yield* git(f.directory, "commit", "--allow-empty", "-qm", "the user moves on")
        const moved = yield* git(f.directory, "rev-parse", "HEAD")
        const late = yield* refused(yield* execute(f, offer))
        expect(late.code).toBe("stale")
        expect(late.message).toBe("The reviewed branch moved since the review. Nothing was changed.")
        expect(yield* call(() => fs.readFile(path.join(preview.worktree, "src/a.ts"), "utf8"))).toBe(HEAD_A)
        expect(yield* vectorRefs(f.directory)).toBe("")
        expect(yield* git(f.directory, "rev-parse", "feature")).toBe(moved)
        const again = yield* refused(yield* f.raw("POST", `${root}/${preview.fixID}/preview`, owner, { kind: "apply" }))
        expect(again.code).toBe("stale")
        expect(again.message).toContain("moved since this fix was prepared")
        // A fix for the moved head; each wrong echo is stale and spends its offer, so the right echo after it is refused.
        const fresh = yield* prepared(f, {
          ...f.prepare,
          head: moved,
          files: [{ path: "src/a.ts", preimage: digest(HEAD_A), postimage: digest(FIXED_A) }],
        })
        for (const wrong of [
          { head: f.base },
          { patchDigest: `sha256:${"0".repeat(64)}` },
          { operationDigest: `sha256:${"0".repeat(64)}` },
        ]) {
          const shown = yield* offered(f, fresh.fixID, { kind: "apply" })
          expect(
            (yield* refused(
              yield* f.raw("POST", `${root}/${fresh.fixID}/execute`, owner, { ...echo(shown), ...wrong }),
            )).code,
          ).toBe("stale")
          expect((yield* refused(yield* execute(f, shown))).code).toBe("permissions")
        }
        expect(yield* call(() => fs.readFile(path.join(fresh.worktree, "src/a.ts"), "utf8"))).toBe(HEAD_A)
        expect(yield* f.llm.calls).toBe(0)
      }),
    30_000,
  )

  linuxLive(
    "apply, commit and push are separate single-use approvals; the user's checkout, branch and remote stay as they were",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture()
        const remote = yield* call(() => fs.mkdtemp(path.join(os.tmpdir(), "vector-fix-http-remote-")))
        yield* Effect.addFinalizer(() => call(() => fs.rm(remote, { recursive: true, force: true })))
        const bare = path.join(remote, "origin.git")
        yield* git(remote, "init", "-q", "--bare", bare)
        const preview = yield* prepared(f)
        expect(preview.files).toEqual([{ path: "src/a.ts", status: "modified", additions: 1, deletions: 1 }])
        expect(preview.patch).toBe(PATCH)
        // Only the step a fix waits for is offered.
        for (const request of [{ kind: "commit" }, { kind: "push", remote: `file://${bare}`, mode: "branch" }])
          expect((yield* refused(yield* f.raw("POST", `${root}/${preview.fixID}/preview`, owner, request))).code).toBe(
            "conflict",
          )
        const apply = yield* offered(f, preview.fixID, { kind: "apply" })
        expect(apply.operation).toEqual({ kind: "apply" })
        expect(apply.notes.join(" ")).toContain("Commands: none")
        expect(apply.expiresAt).toBeGreaterThan(Date.now())
        const applied = yield* executed(f, apply)
        expect(applied).toMatchObject({ kind: "apply", fixID: preview.fixID, head: f.head, digest: preview.digest })
        expect(yield* call(() => fs.readFile(path.join(preview.worktree, "src/a.ts"), "utf8"))).toBe(FIXED_A)
        expect(yield* call(() => fs.readFile(path.join(f.directory, "src/a.ts"), "utf8"))).toBe(HEAD_A)
        expect(yield* call(() => fs.readFile(path.join(f.directory, "src/b.ts"), "utf8"))).toBe(DIRTY_B)
        expect(yield* git(f.directory, "status", "--porcelain")).toBe(f.status)
        expect(yield* git(f.directory, "diff", "--cached", "--name-only")).toBe("")
        expect(yield* vectorRefs(f.directory)).toBe("")
        // The approval is spent.
        expect((yield* refused(yield* execute(f, apply))).code).toBe("permissions")

        // Two executes of one offer: exactly one runs.
        const second = yield* prepared(f)
        const raced = yield* offered(f, second.fixID, { kind: "apply" })
        const responses = yield* Effect.all([execute(f, raced), execute(f, raced)], { concurrency: "unbounded" })
        expect(responses.map((response) => response.status).sort()).toEqual([200, 400])
        expect((yield* refused(responses.find((response) => response.status === 400)!)).code).toBe("permissions")

        // A new offer replaces the one before it.
        const first = yield* offered(f, preview.fixID, { kind: "commit" })
        const commit = yield* offered(f, preview.fixID, { kind: "commit" })
        expect((yield* refused(yield* execute(f, first))).code).toBe("permissions")
        expect(commit.identity).toEqual({ name: "Test", email: "test@vector.test" })
        expect(commit.operation.kind).toBe("commit")
        const message = commit.operation.kind === "commit" ? commit.operation.message : ""
        expect(message).toContain(`Reviewed commit: ${f.head}`)
        expect(message).toContain(`Proposal: ${preview.digest}`)
        expect(message).toContain("- finding-1")
        expect(message.toLowerCase()).not.toContain("verified")
        // The identity shown is the identity committed, whatever the repository says afterwards.
        yield* git(f.directory, "config", "user.email", "changed@vector.test")
        const committed = yield* executed(f, commit)
        if (committed.kind !== "commit") throw new Error("expected a commit")
        expect(committed.branch).toBe(preview.destinationBranch)
        expect(committed.author).toEqual({ name: "Test", email: "test@vector.test" })
        expect(yield* git(f.directory, "log", "-1", "--format=%an <%ae>|%cn <%ce>|%P", committed.branch)).toBe(
          `Test <test@vector.test>|Test <test@vector.test>|${f.head}`,
        )
        expect(yield* git(f.directory, "show", `${committed.branch}:src/a.ts`)).toBe(FIXED_A.trim())
        expect(yield* git(f.directory, "rev-parse", "feature")).toBe(f.head)
        expect(yield* git(f.directory, "status", "--porcelain")).toBe(f.status)
        expect(yield* git(remote, "--git-dir", bare, "for-each-ref")).toBe("")
        // The commit is read from the fix's branch, not from the request that made it.
        expect((yield* listed(f)).fixes.find((item) => item.fixID === preview.fixID)?.commit).toBe(committed.commit)

        // A push only to a remote this repository has, or one on this computer.
        expect(
          (yield* refused(
            yield* f.raw("POST", `${root}/${preview.fixID}/preview`, owner, {
              kind: "push",
              remote: "https://example.invalid/owner/repository.git",
              mode: "branch",
            }),
          )).code,
        ).toBe("invalid")
        // A long remote is shown in the operation, never in a note (each note is at most 512 characters).
        const far = `file://${bare}/${"r".repeat(600)}`
        const long = yield* offered(f, preview.fixID, { kind: "push", remote: far, mode: "branch" })
        expect(long.operation).toMatchObject({ kind: "push", remote: far })
        expect(long.notes.join(" ")).not.toContain(far)
        const push = yield* offered(f, preview.fixID, { kind: "push", remote: `file://${bare}`, mode: "branch" })
        expect(push.operation).toEqual({
          kind: "push",
          remote: `file://${bare}`,
          commit: committed.commit,
          mode: "branch",
        })
        expect(push.notes.join(" ")).toContain("its hooks do not run")
        const pushed = yield* executed(f, push)
        expect(pushed).toMatchObject({ kind: "push", commit: committed.commit, ref: `refs/heads/${committed.branch}` })
        expect(yield* git(remote, "--git-dir", bare, "for-each-ref", "--format=%(refname) %(objectname)")).toBe(
          `refs/heads/${committed.branch} ${committed.commit}`,
        )

        // Cancel removes the fix checkout and keeps the commit's branch.
        const cleanup = yield* f
          .raw("POST", `${root}/${preview.fixID}/cancel`)
          .pipe(Effect.flatMap((response) => data(response, ReviewFixControl.Cleanup)))
        expect(cleanup).toEqual({ fixID: preview.fixID, removed: true })
        expect(
          yield* call(() =>
            fs.stat(preview.worktree).then(
              () => true,
              () => false,
            ),
          ),
        ).toBe(false)
        expect(yield* git(f.directory, "rev-parse", committed.branch)).toBe(committed.commit)
        expect((yield* listed(f)).fixes.map((item) => item.fixID)).toEqual([second.fixID])
        expect(
          (yield* refused(yield* f.raw("POST", `${root}/${preview.fixID}/preview`, owner, { kind: "apply" }))).code,
        ).toBe("not_found")
        expect(yield* f.llm.calls).toBe(0)
      }),
    60_000,
  )

  linuxLive(
    "checks are offered only as the project's own commands without flags, network off, and warn of others' commits",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture()
        const preview = yield* prepared(f)
        expect(
          (yield* refused(
            yield* f.raw("POST", `${root}/${preview.fixID}/preview`, owner, {
              kind: "checks",
              commands: [{ argv: ["bun", "test"], cwd: "." }],
            }),
          )).code,
        ).toBe("conflict")
        yield* executed(f, yield* offered(f, preview.fixID, { kind: "apply" }))
        for (const command of [
          { argv: ["sh", "-c", "true"], cwd: "." },
          { argv: ["bun", "test", "--bail"], cwd: "." },
          { argv: ["bun", "test"], cwd: "../x" },
        ])
          expect(
            (yield* refused(
              yield* f.raw("POST", `${root}/${preview.fixID}/preview`, owner, { kind: "checks", commands: [command] }),
            )).code,
          ).toBe("invalid")
        const checks = yield* offered(f, preview.fixID, {
          kind: "checks",
          commands: [{ argv: ["bun", "test"], cwd: "." }],
        })
        expect(checks.operation).toEqual({
          kind: "checks",
          commands: [{ argv: ["bun", "test"], cwd: "." }],
          network: "off",
          timeoutMs: FIX_LIMITS.commandMs,
          outputBytes: FIX_LIMITS.outputBytes,
        })
        const notes = checks.notes.join(" ")
        expect(notes).toContain("network off")
        expect(notes).toContain("your home folder")
        expect(notes).toContain("1 of the 1 commits between the base and the head are by other authors")
        // The executor refuses before it runs anything (no dependencies are installed in a fix checkout); the offer is
        // spent all the same, and the fix stays applied.
        const run = yield* refused(yield* execute(f, checks))
        expect(run.code).toBe("unavailable")
        expect(run.message).toContain("dependencies unavailable")
        expect((yield* refused(yield* execute(f, checks))).code).toBe("permissions")
        expect((yield* listed(f)).fixes.map((item) => item.state)).toEqual(["applied"])
        // The base comes from the client: one that is not an earlier commit of the head (here the head itself) is
        // said to be uncounted, never an empty range with no warning.
        const same = yield* prepared(f, { ...f.prepare, base: f.head })
        yield* executed(f, yield* offered(f, same.fixID, { kind: "apply" }))
        const uncounted = yield* offered(f, same.fixID, {
          kind: "checks",
          commands: [{ argv: ["bun", "test"], cwd: "." }],
        })
        expect(uncounted.notes.join(" ")).toContain(
          "The base this fix names is not an earlier commit of the head, so Vector did not count who wrote the commits a check runs.",
        )
        expect(uncounted.notes.join(" ")).not.toContain("other authors")
        expect(yield* f.llm.calls).toBe(0)
      }),
    30_000,
  )

  linuxLive(
    "client text reaches a commit only as plain finding IDs within the message limit, and identities stay out of notes",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture()
        const header = (count: number, digest: string) =>
          `Apply a Vector fix for ${count} review findings\n\nReviewed commit: ${f.head}\nProposal: ${digest}\n`
        // One reference that is not a plain ID leaves the whole list out.
        const odd = yield* prepared(f, { ...f.prepare, findings: ["finding-2", "see/finding#1"] })
        yield* executed(f, yield* offered(f, odd.fixID, { kind: "apply" }))
        // An identity near the executor's bound (256 bytes a field) would not fit a 512-character note.
        const identity = { name: "N".repeat(250), email: `${"e".repeat(240)}@vector.test` }
        yield* git(f.directory, "config", "user.name", identity.name)
        yield* git(f.directory, "config", "user.email", identity.email)
        const commit = yield* offered(f, odd.fixID, { kind: "commit" })
        expect(commit.identity).toEqual(identity)
        expect(commit.notes.join(" ")).not.toContain(identity.name)
        expect(commit.notes.join(" ")).not.toContain(identity.email)
        expect(commit.operation).toEqual({ kind: "commit", message: header(2, odd.digest) })
        // Plain IDs over the message's byte limit leave the list out too.
        const many = Array.from({ length: FIX_LIMITS.findings }, (_, index) => `${index}`.padStart(64, "f"))
        const long = yield* prepared(f, { ...f.prepare, findings: many })
        yield* executed(f, yield* offered(f, long.fixID, { kind: "apply" }))
        const big = yield* offered(f, long.fixID, { kind: "commit" })
        expect(big.operation).toEqual({ kind: "commit", message: header(FIX_LIMITS.findings, long.digest) })
        expect(yield* f.llm.calls).toBe(0)
      }),
    30_000,
  )

  linuxLive(
    "at most LIMIT.fixes fixes are open in a project, and fixes no request can reach again free their slots",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture()
        const instances = yield* InstanceStore.Service
        const limit = ReviewFixOwner.LIMIT.fixes
        yield* instances.provide(
          { directory: f.directory },
          Effect.gen(function* () {
            const service = yield* ReviewFixOwner.make()
            const fix = yield* ReviewFix.Service
            const sessions = yield* Session.Service
            const place = (sessionID: SessionID) =>
              service
                .prepare(sessionID, "http-owner:a", f.prepare)
                .pipe(Effect.provideService(ReviewFix.RunnerContext, () => undefined))
            const exists = (directory: string) =>
              call(() =>
                fs.stat(directory).then(
                  () => true,
                  () => false,
                ),
              )
            const deleted = yield* sessions.create({ title: "A conversation that is deleted" })
            const archived = yield* sessions.create({ title: "A conversation that is archived" })
            const gone = yield* place(deleted.id)
            const shelved = yield* place(archived.id)
            const mine = yield* Effect.forEach(Array.from({ length: limit - 2 }), () => place(parentID))
            expect(yield* worktrees(f.directory)).toBe(1 + limit)
            const full = yield* place(parentID).pipe(Effect.flip)
            expect(full.code).toBe("conflict")
            expect(full.message).toBe(`At most ${limit} fixes are open in a project at once. Cancel one first.`)
            expect(yield* worktrees(f.directory)).toBe(1 + limit)
            // A fix the executor no longer holds is forgotten.
            yield* fix.cancel(mine[0].fixID)
            yield* place(parentID)
            expect(yield* worktrees(f.directory)).toBe(1 + limit)
            // At the limit, a deleted conversation's fix, and then an archived one's, is cancelled to make room.
            yield* sessions.remove(deleted.id)
            yield* place(parentID)
            expect(yield* fix.state(gone.fixID)).toBeUndefined()
            expect(yield* exists(gone.worktree)).toBe(false)
            expect(yield* fix.state(shelved.fixID)).toBe("preview")
            yield* sessions.setArchived({ sessionID: archived.id, time: Date.now() })
            yield* place(parentID)
            expect(yield* fix.state(shelved.fixID)).toBeUndefined()
            expect(yield* exists(shelved.worktree)).toBe(false)
            expect(yield* worktrees(f.directory)).toBe(1 + limit)
            // Every open fix can still be reached, so the limit holds.
            expect((yield* place(parentID).pipe(Effect.flip)).code).toBe("conflict")
            expect((yield* service.list(parentID)).fixes).toHaveLength(limit)
          }).pipe(
            Effect.ensuring(
              Effect.gen(function* () {
                const service = yield* ReviewFix.Service
                const placements = yield* service.placements()
                yield* Effect.forEach(placements, (item) => service.cancel(item.fixID), { discard: true })
              }).pipe(Effect.ignore),
            ),
          ),
        )
        expect(yield* worktrees(f.directory)).toBe(1)
        expect(yield* f.llm.calls).toBe(0)
      }),
    60_000,
  )

  linuxLive("an approval is bound to its owner and expires, and a CI job places nothing", () =>
    Effect.gen(function* () {
      const f = yield* fixture()
      const instances = yield* InstanceStore.Service
      const time = { now: 1_000_000 }
      yield* instances.provide(
        { directory: f.directory },
        Effect.gen(function* () {
          const service = yield* ReviewFixOwner.make({ clock: () => time.now })
          const fix = yield* ReviewFix.Service
          const developerRun = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
            effect.pipe(Effect.provideService(ReviewFix.RunnerContext, () => undefined))
          const ci = yield* service.prepare(parentID, "http-owner:a", f.prepare).pipe(
            Effect.provideService(ReviewFix.RunnerContext, () => "a CI job"),
            Effect.flip,
          )
          expect(ci.code).toBe("unavailable")
          expect(yield* worktrees(f.directory)).toBe(1)
          const preview = yield* developerRun(service.prepare(parentID, "http-owner:a", f.prepare))
          expect(
            (yield* developerRun(service.preview(parentID, "http-owner:b", preview.fixID, { kind: "apply" })).pipe(
              Effect.flip,
            )).code,
          ).toBe("permissions")
          const other = yield* developerRun(service.preview(parentID, "http-owner:a", preview.fixID, { kind: "apply" }))
          expect(
            (yield* developerRun(service.execute(parentID, "http-owner:b", preview.fixID, echo(other))).pipe(
              Effect.flip,
            )).code,
          ).toBe("permissions")
          const late = yield* developerRun(service.preview(parentID, "http-owner:a", preview.fixID, { kind: "apply" }))
          expect(late.expiresAt).toBe(time.now + ReviewFixOwner.LIMIT.approvalMs)
          time.now += ReviewFixOwner.LIMIT.approvalMs
          const expired = yield* developerRun(
            service.execute(parentID, "http-owner:a", preview.fixID, echo(late)),
          ).pipe(Effect.flip)
          expect(expired.code).toBe("stale")
          expect(expired.message).toContain("expired")
          expect(yield* fix.state(preview.fixID)).toBe("preview")
          expect(yield* call(() => fs.readFile(path.join(preview.worktree, "src/a.ts"), "utf8"))).toBe(HEAD_A)
          expect(yield* service.cancel(parentID, preview.fixID)).toEqual({ fixID: preview.fixID, removed: true })
          expect((yield* InstanceState.context).directory).toBe(f.directory)
        }),
      )
      expect(yield* worktrees(f.directory)).toBe(1)
      expect(yield* f.llm.calls).toBe(0)
    }),
  )

  it.live("a missing conversation is not found on every fix route and bootstraps nothing", () =>
    Effect.gen(function* () {
      const boots: string[] = []
      const hooks = yield* InstanceHooks.Service
      yield* hooks.register(
        "review-fix-http-parent-placement",
        Effect.gen(function* () {
          boots.push((yield* InstanceState.context).directory)
        }),
      )
      const f = yield* fixture()
      expect((yield* f.raw("GET", "/vcs")).status).toBe(200)
      expect(boots).toContain(f.directory)
      boots.length = 0
      const elsewhere = yield* tmpdirScoped({ git: true })
      for (const [method, route, body] of routes(f, "/experimental/session/ses_missing_fix_parent/review/fix"))
        expect(
          (yield* refused(yield* f.raw(method, route, { ...owner, "x-vector-directory": elsewhere }, body))).code,
        ).toBe("not_found")
      expect(boots).toEqual([])
      expect(yield* f.llm.calls).toBe(0)
    }),
  )

  linuxLive("another conversation in the same folder cannot see, approve, run or cancel this one's fix", () =>
    Effect.gen(function* () {
      const f = yield* fixture()
      const preview = yield* prepared(f)
      const offer = yield* offered(f, preview.fixID, { kind: "apply" })
      const created = yield* f.raw("POST", "/session", owner, { title: "Another owner conversation" })
      expect(created.status).toBe(200)
      const other = (yield* call(() => created.json())) as { id: string; directory: string }
      expect(other.id).not.toBe(parentID)
      expect(other.directory).toBe(f.directory)
      const elsewhere = `/experimental/session/${other.id}/review/fix`
      expect(
        (yield* f.raw("GET", elsewhere).pipe(Effect.flatMap((response) => data(response, ReviewFixControl.List))))
          .fixes,
      ).toEqual([])
      for (const [route, body] of [
        [`${elsewhere}/${preview.fixID}/preview`, { kind: "apply" }],
        [`${elsewhere}/${preview.fixID}/execute`, echo(offer)],
        [`${elsewhere}/${preview.fixID}/cancel`, undefined],
      ] as const)
        expect((yield* refused(yield* f.raw("POST", route, owner, body))).code).toBe("not_found")
      // None of that spent the offer or removed the fix.
      expect((yield* executed(f, offer)).kind).toBe("apply")
      expect(yield* f.llm.calls).toBe(0)
    }),
  )

  nonLinuxLive("off Linux a fix is refused before anything is placed", () =>
    Effect.gen(function* () {
      const f = yield* fixture()
      const response = yield* refused(yield* f.raw("POST", root, owner, f.prepare))
      expect(response.code).toBe("unavailable")
      expect(response.message).toContain("Linux only")
      expect(yield* worktrees(f.directory)).toBe(1)
      expect((yield* listed(f)).fixes).toEqual([])
      expect(yield* f.llm.calls).toBe(0)
    }),
  )
})
