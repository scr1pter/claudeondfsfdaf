import { DiagnosticCatalog } from "../../src/review/diagnostic-adapter"
import { parseUnifiedDiff } from "@vectordevai/core/review/diff"
import { afterEach, describe, expect } from "bun:test"
import { createHash, randomUUID } from "node:crypto"
import { readdirSync, readFileSync } from "node:fs"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Cause, Deferred, Effect, Exit, Fiber, Layer, Schema, Stream } from "effect"
import { AppNodeBuilder } from "@vectordevai/core/effect/app-node-builder"
import { BackgroundJobStore } from "@vectordevai/core/background-job-store"
import { CrossSpawnSpawner } from "@vectordevai/core/cross-spawn-spawner"
import { Database } from "@vectordevai/core/database/database"
import { LayerNode } from "@vectordevai/core/effect/layer-node"
import { Global } from "@vectordevai/core/global"
import { LocationServiceMap, locationServiceMapLayer } from "@vectordevai/core/location-services"
import { Npm } from "@vectordevai/core/npm"
import { createFixConsentPolicy, type FixConsent } from "@vectordevai/core/review/fix-proposal"
import { SessionAudience } from "@vectordevai/core/session/audience"
import { Auth } from "@/auth"
import { Agent } from "@/agent/agent"
import { BackgroundJob } from "@/background/job"
import { Config } from "@/config/config"
import { InstanceState } from "@/effect/instance-state"
import { Git } from "@/git"
import { InstanceBootstrap } from "@/project/bootstrap-service"
import type { InstanceContext } from "@/project/instance-context"
import { InstanceStore } from "@/project/instance-store"
import { ReviewFix } from "@/review/fix"
import { Session } from "@/session/session"
import { SessionRunState } from "@/session/run-state"
import { TaskClaims } from "@/task/claims"
import { TaskIsolation } from "@/task/isolation"
import { TaskPlace } from "@/task/place"
import { FileLock } from "@/tool/file-lock"
import { Worktree } from "@/worktree"
import { AuthTest } from "../fake/auth"
import { NpmTest } from "../fake/npm"
import { disposeAllInstances } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

// VS-12a (SF-07). Real Git, real fix placements in the test data folder, no model and no package installation. The
// layer is isolation.test.ts's plus ReviewFix.
const bootstrap = Layer.succeed(InstanceBootstrap.Service, { run: Effect.void })
const locations = LayerNode.make({ service: LocationServiceMap.Service, layer: locationServiceMapLayer, deps: [] })
const layer = AppNodeBuilder.build(
  LayerNode.group([
    ReviewFix.node,
    TaskIsolation.node,
    locations,
    Worktree.node,
    InstanceStore.node,
    Session.node,
    SessionRunState.node,
    BackgroundJob.node,
    Git.node,
    Agent.node,
    Config.node,
    CrossSpawnSpawner.node,
    SessionAudience.node,
    Database.node,
  ]),
  [
    [InstanceStore.bootstrapNode, bootstrap],
    [Auth.node, AuthTest.empty],
    [Npm.node, NpmTest.noop],
  ],
)
const it = testEffect(layer)
afterEach(() => disposeAllInstances())

const ACTOR = "owner@local"
const linux = process.platform === "linux"

const run = Effect.fn("FixTest.run")(function* (
  cwd: string,
  args: string[],
  options: { env?: Record<string, string>; input?: string } = {},
) {
  const service = yield* Git.Service
  return yield* service.run(args, {
    cwd,
    ...(options.env ? { env: options.env } : {}),
    ...(options.input === undefined ? {} : { stdin: Stream.make(Buffer.from(options.input)) }),
  })
})
const git = (cwd: string, args: string[], options: { env?: Record<string, string>; input?: string } = {}) =>
  run(cwd, args, options).pipe(
    Effect.map((result) => {
      if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr.toString()}`)
      return result.text().trim()
    }),
  )
const write = (directory: string, file: string, content: string | Uint8Array) =>
  Effect.promise(async () => {
    await fs.mkdir(path.dirname(path.join(directory, file)), { recursive: true })
    await fs.writeFile(path.join(directory, file), content)
  })
const read = (directory: string, file: string) => Effect.promise(() => fs.readFile(path.join(directory, file), "utf8"))
const exists = (file: string) =>
  Effect.promise(() =>
    fs.lstat(file).then(
      () => true,
      () => false,
    ),
  )
const digest = (content: string | Uint8Array) => `sha256:${createHash("sha256").update(content).digest("hex")}`
const commit = Effect.fn("FixTest.commit")(function* (
  directory: string,
  files: Record<string, string | Uint8Array>,
  message: string,
) {
  for (const [file, content] of Object.entries(files)) yield* write(directory, file, content)
  yield* git(directory, ["add", "-A", "--", ...Object.keys(files)])
  yield* git(directory, ["commit", "-q", "-m", message])
  return yield* git(directory, ["rev-parse", "HEAD"])
})
const refused = <A, E, R>(effect: Effect.Effect<A, E, R>, reason: ReviewFix.Reason, message?: string) =>
  Effect.gen(function* () {
    const exit = yield* Effect.exit(effect)
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit))
      expect(Cause.squash(exit.cause)).toMatchObject({
        _tag: "ReviewFix.Refused",
        reason,
        ...(message ? { message } : {}),
      })
  })
const fails = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    expect(Exit.isFailure(yield* Effect.exit(effect))).toBe(true)
  })

/** The exact patch Git writes from `head` to the head's tree with these files replaced (null deletes). */
const patchFor = Effect.fn("FixTest.patch")(function* (
  directory: string,
  head: string,
  changes: Record<string, string | null>,
) {
  const env = { GIT_INDEX_FILE: path.join(directory, ".git", `fix-test-index-${randomUUID()}`) }
  yield* git(directory, ["read-tree", head], { env })
  for (const [file, content] of Object.entries(changes)) {
    if (content === null) yield* git(directory, ["update-index", "--force-remove", "--", file], { env })
    else
      yield* git(
        directory,
        [
          "update-index",
          "--add",
          "--cacheinfo",
          `100644,${yield* git(directory, ["hash-object", "-w", "--stdin"], { input: content })},${file}`,
        ],
        { env },
      )
  }
  const tree = yield* git(directory, ["write-tree"], { env })
  yield* Effect.promise(() => fs.rm(env.GIT_INDEX_FILE, { force: true }))
  return (yield* run(directory, [
    "-c",
    "diff.noprefix=false",
    "diff",
    "--no-color",
    "--no-renames",
    "--no-ext-diff",
    "--no-textconv",
    head,
    tree,
  ])).text()
})

/** The user's checkout as these tests compare it: index bytes, HEAD, every ref, and the named files' bytes. */
const snapshot = Effect.fn("FixTest.snapshot")(function* (directory: string, files: readonly string[]) {
  const index = path.resolve(directory, yield* git(directory, ["rev-parse", "--git-path", "index"]))
  return {
    index: digest(yield* Effect.promise(() => fs.readFile(index))),
    head: yield* git(directory, ["rev-parse", "HEAD"]),
    branch: (yield* run(directory, ["symbolic-ref", "-q", "HEAD"])).text().trim(),
    refs: yield* git(directory, ["for-each-ref", "--format=%(refname) %(objectname)"]),
    files: Object.fromEntries(
      yield* Effect.forEach(files, (file) =>
        Effect.promise(() =>
          fs.readFile(path.join(directory, file)).then(
            (bytes) => [file, digest(bytes)] as const,
            () => [file, "absent"] as const,
          ),
        ),
      ),
    ),
  }
})
const changedIn = (directory: string) =>
  run(directory, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]).pipe(
    Effect.map((result) =>
      result
        .text()
        .split("\0")
        .filter(Boolean)
        .map((line) => line.slice(3))
        .toSorted((a, b) => a.localeCompare(b)),
    ),
  )

// Every fix placement a test leaves, retained ones included, is removed with its project's test.
const cleanup = (home: InstanceContext) =>
  Effect.addFinalizer(() =>
    Effect.gen(function* () {
      const worktrees = path.join(Global.Path.data, "task-worktree", home.project.id, ".fix")
      const registry = path.join(Global.Path.data, "task-isolation", home.project.id, ".fix")
      const names = [
        ...(yield* Effect.promise(() => fs.readdir(worktrees).catch(() => [] as string[]))),
        ...(yield* Effect.promise(() => fs.readdir(registry).catch(() => [] as string[]))),
      ]
      for (const name of names) {
        yield* run(home.directory, ["worktree", "remove", "--force", path.join(worktrees, name)])
        TaskClaims.unprotect(name)
      }
      yield* Effect.promise(() =>
        Promise.all([
          fs.rm(worktrees, { recursive: true, force: true }),
          fs.rm(registry, { recursive: true, force: true }),
        ]),
      )
      yield* run(home.directory, ["worktree", "prune"])
    }).pipe(Effect.orDie),
  )

/** A repository on `feature` (head) from `main` (base), the services, and a consent policy with a test clock. */
const fixture = Effect.fn("FixTest.fixture")(function* (files: Record<string, string | Uint8Array>) {
  const home = yield* InstanceState.context
  yield* cleanup(home)
  yield* git(home.directory, ["config", "core.autocrlf", "false"])
  yield* git(home.directory, ["branch", "-M", "main"])
  const base = yield* commit(home.directory, { "README.md": "base\n" }, "base")
  yield* git(home.directory, ["checkout", "-q", "-b", "feature"])
  const head = yield* commit(home.directory, files, "feature")
  const fix = yield* ReviewFix.Service
  const isolation = yield* TaskIsolation.Service
  const clock = { now: 1_000 }
  const policy = createFixConsentPolicy(() => clock.now)
  const proposalFor = (
    placement: ReviewFix.Placement,
    patch: string,
    changed: { path: string; before: string | Uint8Array | null; after: string | null }[],
  ) => ({
    version: 1,
    scope: {
      kind: "local",
      repository: placement.repository,
      worktree: placement.worktree,
      sourceBranch: "feature",
      baseBranch: "main",
      destinationBranch: "vector/fix-1",
    },
    base,
    head: placement.head,
    findings: ["finding-1"],
    files: changed.map((item) => ({
      path: item.path,
      preimage: item.before === null ? null : digest(item.before),
      postimage: item.after === null ? null : digest(item.after),
    })),
    patch,
  })
  /** Reserves a placement at `at.head` and builds Git's own patch for these changes against `at.contents`. */
  const place = Effect.fn("FixTest.place")(function* (
    changes: Record<string, string | null>,
    at: { head: string; contents: Record<string, string | Uint8Array> } = { head, contents: files },
  ) {
    const placement = yield* fix.reserve({ head: at.head })
    const patch = yield* patchFor(home.directory, at.head, changes)
    const proposal = proposalFor(
      placement,
      patch,
      Object.entries(changes).map(([file, after]) => ({ path: file, before: at.contents[file] ?? null, after })),
    )
    return { placement, proposal, fixID: placement.fixID }
  })
  const approve = (proposal: unknown, actor = ACTOR, lifetime = 60_000) =>
    Effect.promise(() => policy.approve(proposal, { kind: "apply" }, actor, lifetime)).pipe(
      Effect.map((result) => {
        if (!result.ok) throw new Error(`approval refused: ${result.reason}`)
        return result.consent
      }),
    )
  return {
    home,
    directory: home.directory,
    base,
    head,
    files,
    fix,
    isolation,
    clock,
    policy,
    proposalFor,
    place,
    approve,
  }
})

describe.skipIf(!linux)("review fix executor (VS-12a)", () => {
  it.instance(
    "applies an approved patch only in its detached worktree and leaves a dirty checkout untouched",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture({ "src/a.ts": "one\ntwo\nthree\n", "src/b.ts": "keep\n" })
        yield* write(f.directory, "src/a.ts", "one\nuser edit\nthree\n")
        yield* write(f.directory, "src/b.ts", "staged\n")
        yield* git(f.directory, ["add", "src/b.ts"])
        yield* write(f.directory, "notes.txt", "untracked\n")
        const files = ["src/a.ts", "src/b.ts", "notes.txt", "src/new/c.ts"]
        const before = yield* snapshot(f.directory, files)
        const worktrees = yield* git(f.directory, ["worktree", "list", "--porcelain"])
        const fix = yield* f.place({ "src/a.ts": "one\n2\nthree\n", "src/new/c.ts": "new\n" })
        const preview = yield* f.fix.preview(fix)
        expect(preview.files).toEqual([
          { path: "src/a.ts", status: "modified", additions: 1, deletions: 1 },
          { path: "src/new/c.ts", status: "added", additions: 1, deletions: 0 },
        ])
        expect(preview).toMatchObject({ fixID: fix.fixID, head: f.head, base: f.base, sourceBranch: "feature" })
        expect(yield* git(fix.placement.worktree, ["rev-parse", "HEAD"])).toBe(f.head)
        expect((yield* run(fix.placement.worktree, ["symbolic-ref", "-q", "HEAD"])).exitCode).not.toBe(0)
        expect(yield* read(fix.placement.worktree, "src/a.ts")).toBe("one\ntwo\nthree\n")
        expect(yield* f.fix.state(fix.fixID)).toBe("preview")

        const consent = yield* f.approve(fix.proposal)
        const applied = yield* f.fix.apply({ ...fix, consent, policy: f.policy, actor: ACTOR })
        expect(applied).toMatchObject({ fixID: fix.fixID, digest: preview.digest, actor: ACTOR, files: preview.files })
        expect(yield* read(fix.placement.worktree, "src/a.ts")).toBe("one\n2\nthree\n")
        expect(yield* read(fix.placement.worktree, "src/new/c.ts")).toBe("new\n")
        expect(yield* changedIn(fix.placement.worktree)).toEqual(["src/a.ts", "src/new/c.ts"])
        expect(yield* snapshot(f.directory, files)).toEqual(before)
        expect(yield* f.fix.state(fix.fixID)).toBe("applied")
        expect((yield* f.fix.placements()).map((item) => [item.fixID, item.state, item.applied?.digest])).toEqual([
          [fix.fixID, "applied", preview.digest],
        ])

        expect(yield* f.fix.cancel(fix.fixID)).toEqual({ fixID: fix.fixID, removed: true })
        expect(yield* exists(fix.placement.worktree)).toBe(false)
        expect(yield* git(f.directory, ["worktree", "list", "--porcelain"])).toBe(worktrees)
        expect(yield* f.fix.placements()).toEqual([])
        // A fix whose placement is removed is forgotten.
        expect(yield* f.fix.state(fix.fixID)).toBeUndefined()
        expect(yield* snapshot(f.directory, files)).toEqual(before)
      }),
    { git: true },
    60_000,
  )

  it.instance(
    "refuses traversal, absolute and .git paths, and a head that is not a commit, before creating anything",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture({ "src/a.ts": "a\n" })
        const placement = yield* f.fix.reserve({ head: f.head })
        for (const file of [
          "../escape.ts",
          "/abs.ts",
          ".git/config",
          "src/../../x.ts",
          "src/.git/hooks/x",
          "a\\b.ts",
        ]) {
          const patch = `diff --git a/${file} b/${file}\nnew file mode 100644\n--- /dev/null\n+++ b/${file}\n@@ -0,0 +1 @@\n+x\n`
          const proposal = f.proposalFor(placement, patch, [{ path: file, before: null, after: "x\n" }])
          yield* refused(f.fix.preview({ fixID: placement.fixID, proposal }), "proposal")
        }
        expect(yield* exists(placement.worktree)).toBe(false)
        expect(yield* exists(path.resolve(placement.worktree, "..", "escape.ts"))).toBe(false)
        expect(yield* exists(path.join(f.directory, "escape.ts"))).toBe(false)
        yield* refused(f.fix.reserve({ head: "HEAD" }), "head")
        yield* refused(f.fix.reserve({ head: "--output=/tmp/x" }), "head")
        yield* refused(f.fix.reserve({ head: "0".repeat(40) }), "head")
        expect((yield* f.fix.placements()).map((item) => item.fixID)).toEqual([placement.fixID])
        expect(yield* f.fix.cancel(placement.fixID)).toEqual({ fixID: placement.fixID, removed: true })
      }),
    { git: true },
    60_000,
  )

  it.instance(
    "refuses a symlinked target and a symlinked parent folder",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture({ "src/a.ts": "a\n" })
        yield* Effect.promise(() => fs.symlink("../outside", path.join(f.directory, "out")))
        yield* Effect.promise(() => fs.symlink("../../x", path.join(f.directory, "link.ts")))
        yield* git(f.directory, ["add", "out", "link.ts"])
        yield* git(f.directory, ["commit", "-q", "-m", "links"])
        const head = yield* git(f.directory, ["rev-parse", "HEAD"])
        const placement = yield* f.fix.reserve({ head })
        const outside = path.resolve(placement.worktree, "..", "outside")
        yield* Effect.promise(() => fs.mkdir(outside, { recursive: true }))
        const parent = f.proposalFor(
          placement,
          "diff --git a/out/x.ts b/out/x.ts\nnew file mode 100644\n--- /dev/null\n+++ b/out/x.ts\n@@ -0,0 +1 @@\n+pwned\n",
          [{ path: "out/x.ts", before: null, after: "pwned\n" }],
        )
        yield* refused(f.fix.preview({ fixID: placement.fixID, proposal: parent }), "symlink")
        const target = f.proposalFor(
          placement,
          "diff --git a/link.ts b/link.ts\n--- a/link.ts\n+++ b/link.ts\n@@ -1 +1 @@\n-../../x\n\\ No newline at end of file\n+changed\n",
          [{ path: "link.ts", before: "../../x", after: "changed\n" }],
        )
        yield* refused(f.fix.preview({ fixID: placement.fixID, proposal: target }), "symlink")
        expect(yield* Effect.promise(() => fs.readdir(outside))).toEqual([])
        expect(yield* changedIn(placement.worktree)).toEqual([])
        expect(yield* f.fix.cancel(placement.fixID)).toEqual({ fixID: placement.fixID, removed: true })
      }),
    { git: true },
    60_000,
  )

  it.instance(
    "refuses a moved head and leaves the consent unspent",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture({ "src/a.ts": "one\n" })
        const first = yield* f.place({ "src/a.ts": "two\n" })
        yield* f.fix.preview(first)
        const consent = yield* f.approve(first.proposal)
        const moved = yield* commit(f.directory, { "src/other.ts": "x\n" }, "moved")
        yield* refused(f.fix.apply({ ...first, consent, policy: f.policy, actor: ACTOR }), "head")
        expect(yield* read(first.placement.worktree, "src/a.ts")).toBe("one\n")
        expect(f.policy.revoke(consent)).toEqual({ ok: true })
        expect(yield* f.fix.cancel(first.fixID)).toMatchObject({ removed: true })

        const second = yield* f.place({ "src/a.ts": "two\n" }, { head: moved, contents: { "src/a.ts": "one\n" } })
        yield* f.fix.preview(second)
        const again = yield* f.approve(second.proposal)
        yield* git(second.placement.worktree, ["checkout", "-q", "--detach", "HEAD~1"])
        yield* refused(f.fix.apply({ ...second, consent: again, policy: f.policy, actor: ACTOR }), "head")
        expect(yield* read(second.placement.worktree, "src/a.ts")).toBe("one\n")
        expect(f.policy.revoke(again)).toEqual({ ok: true })
        expect(yield* f.fix.cancel(second.fixID)).toMatchObject({ removed: true })
      }),
    { git: true },
    60_000,
  )

  it.instance(
    "refuses a changed digest, preimage, postimage or patch",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture({ "src/a.ts": "one\n", "src/b.ts": "bee\n" })
        const fix = yield* f.place({ "src/a.ts": "two\n" })
        yield* f.fix.preview(fix)
        const other = f.proposalFor(fix.placement, yield* patchFor(f.directory, f.head, { "src/a.ts": "three\n" }), [
          { path: "src/a.ts", before: "one\n", after: "three\n" },
        ])
        const consent = yield* f.approve(fix.proposal)
        yield* refused(f.fix.apply({ ...fix, proposal: other, consent, policy: f.policy, actor: ACTOR }), "digest")
        const elsewhere = yield* f.approve({ ...fix.proposal, findings: ["finding-2"] })
        yield* refused(f.fix.apply({ ...fix, consent: elsewhere, policy: f.policy, actor: ACTOR }), "mismatch")
        yield* refused(f.fix.apply({ ...fix, consent, policy: f.policy, actor: "someone-else" }), "mismatch")
        yield* write(fix.placement.worktree, "src/a.ts", "edited\n")
        yield* refused(f.fix.apply({ ...fix, consent, policy: f.policy, actor: ACTOR }), "worktree")
        yield* git(fix.placement.worktree, ["checkout", "-q", "--", "src/a.ts"])
        const wrong = { ...fix.proposal, files: [{ ...fix.proposal.files[0], postimage: digest("wrong\n") }] }
        yield* refused(f.fix.preview({ fixID: fix.fixID, proposal: wrong }), "postimage")
        const context = f.proposalFor(
          fix.placement,
          "diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-uno\n+two\n",
          [{ path: "src/a.ts", before: "one\n", after: "two\n" }],
        )
        yield* refused(f.fix.preview({ fixID: fix.fixID, proposal: context }), "patch")
        expect(yield* read(fix.placement.worktree, "src/a.ts")).toBe("one\n")
        expect(yield* f.fix.state(fix.fixID)).toBe("preview")
        expect(f.policy.revoke(consent)).toEqual({ ok: true })
        expect(yield* f.fix.cancel(fix.fixID)).toMatchObject({ removed: true })

        // A file changed between the plan and its write is refused at its write, and the earlier write is undone.
        const both = yield* f.place({ "src/a.ts": "two\n", "src/b.ts": "B\n" })
        yield* f.fix.preview(both)
        const spent = yield* f.approve(both.proposal)
        yield* refused(
          f.fix.apply({
            ...both,
            consent: spent,
            policy: f.policy,
            actor: ACTOR,
            observe: (event) =>
              event.type === "wrote" && event.file === "src/a.ts"
                ? Effect.promise(() => fs.writeFile(path.join(both.placement.worktree, "src/b.ts"), "raced\n"))
                : Effect.void,
          }),
          "preimage",
        )
        expect(yield* f.fix.state(both.fixID)).toBeUndefined()
        expect(yield* exists(both.placement.worktree)).toBe(false)
        expect(f.policy.revoke(spent)).toEqual({ ok: false, reason: "used" })
        expect(yield* f.fix.placements()).toEqual([])
      }),
    { git: true },
    60_000,
  )

  it.instance(
    "refuses revoked, expired and reused consent, and a second apply",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture({ "src/a.ts": "one\n" })
        const fix = yield* f.place({ "src/a.ts": "two\n" })
        yield* f.fix.preview(fix)
        const apply = (consent: FixConsent) => f.fix.apply({ ...fix, consent, policy: f.policy, actor: ACTOR })
        const revoked = yield* f.approve(fix.proposal)
        expect(f.policy.revoke(revoked)).toEqual({ ok: true })
        yield* refused(apply(revoked), "revoked")
        const expired = yield* f.approve(fix.proposal, ACTOR, 1_000)
        f.clock.now += 2_000
        yield* refused(apply(expired), "expiry")
        const used = yield* f.approve(fix.proposal)
        expect((yield* Effect.promise(() => f.policy.consume(used, fix.proposal, { kind: "apply" }, ACTOR))).ok).toBe(
          true,
        )
        yield* refused(apply(used), "used")
        expect(yield* read(fix.placement.worktree, "src/a.ts")).toBe("one\n")
        expect(yield* f.fix.state(fix.fixID)).toBe("preview")
        yield* apply(yield* f.approve(fix.proposal))
        expect(yield* read(fix.placement.worktree, "src/a.ts")).toBe("two\n")
        yield* refused(apply(yield* f.approve(fix.proposal)), "state")
        expect(yield* f.fix.cancel(fix.fixID)).toMatchObject({ removed: true })
      }),
    { git: true },
    60_000,
  )

  it.instance(
    "cancellation mid-apply rolls back and removes the worktree, also while a write is in flight",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture({ "src/a.ts": "one\n", "src/b.ts": "bee\n" })
        const before = yield* snapshot(f.directory, ["src/a.ts", "src/b.ts"])

        const fix = yield* f.place({ "src/a.ts": "two\n", "src/b.ts": "B\n" })
        yield* f.fix.preview(fix)
        const consent = yield* f.approve(fix.proposal)
        const wrote = yield* Deferred.make<void>()
        const fiber = yield* f.fix
          .apply({
            ...fix,
            consent,
            policy: f.policy,
            actor: ACTOR,
            observe: (event) =>
              event.type === "wrote"
                ? Deferred.succeed(wrote, undefined).pipe(Effect.andThen(Effect.never))
                : Effect.void,
          })
          .pipe(Effect.forkScoped({ startImmediately: true }))
        yield* Deferred.await(wrote)
        expect(yield* read(fix.placement.worktree, "src/a.ts")).toBe("two\n")
        yield* Fiber.interrupt(fiber)
        const exit = yield* Fiber.await(fiber)
        expect(Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)).toBe(true)
        expect(yield* f.fix.state(fix.fixID)).toBeUndefined()
        expect(yield* exists(fix.placement.worktree)).toBe(false)
        expect(yield* exists(path.join(Global.Path.data, "task-isolation", f.home.project.id, ".fix", fix.fixID))).toBe(
          false,
        )
        expect(yield* f.fix.placements()).toEqual([])
        expect(f.policy.revoke(consent)).toEqual({ ok: false, reason: "used" })

        // An interrupt requested while a write step runs waits for that step: the hook inside it is not interrupted,
        // the write lands, and the rollback is then certain (an uncertain one would keep the checkout).
        const second = yield* f.place({ "src/a.ts": "two\n", "src/b.ts": "B\n" })
        yield* f.fix.preview(second)
        const writing = yield* Deferred.make<void>()
        const release = yield* Deferred.make<void>()
        const events: string[] = []
        const inFlight = yield* f.fix
          .apply({
            ...second,
            consent: yield* f.approve(second.proposal),
            policy: f.policy,
            actor: ACTOR,
            observe: (event) =>
              Effect.gen(function* () {
                events.push(`${event.type} ${event.file}`)
                if (event.type !== "writing" || event.file !== "src/b.ts") return
                yield* Deferred.succeed(writing, undefined)
                yield* Deferred.await(release)
                events.push("released src/b.ts")
              }),
          })
          .pipe(Effect.forkScoped({ startImmediately: true }))
        yield* Deferred.await(writing)
        yield* Fiber.interrupt(inFlight).pipe(Effect.forkScoped({ startImmediately: true }))
        yield* Deferred.succeed(release, undefined)
        const stopped = yield* Fiber.await(inFlight)
        expect(Exit.isFailure(stopped) && Cause.hasInterrupts(stopped.cause)).toBe(true)
        expect(events.slice(0, 4)).toEqual([
          "writing src/a.ts",
          "wrote src/a.ts",
          "writing src/b.ts",
          "released src/b.ts",
        ])
        expect(yield* f.fix.state(second.fixID)).toBeUndefined()
        expect(yield* exists(second.placement.worktree)).toBe(false)
        expect(yield* f.fix.placements()).toEqual([])
        expect(yield* snapshot(f.directory, ["src/a.ts", "src/b.ts"])).toEqual(before)
        expect(
          (yield* Effect.promise(() => fs.readdir(path.join(f.directory, "src")))).filter((name) =>
            name.startsWith(".vector-merge-"),
          ),
        ).toEqual([])

        // The files' locks are taken before the consent is spent. An interrupt while another writer holds one spends
        // and writes nothing and leaves the fix in preview; the same consent then applies, spent only once the lock is
        // free.
        const third = yield* f.place({ "src/a.ts": "two\n", "src/b.ts": "B\n" })
        yield* f.fix.preview(third)
        const unspent = yield* f.approve(third.proposal)
        const held = yield* Deferred.make<void>()
        const free = yield* Deferred.make<void>()
        yield* FileLock.withFiles([path.join(third.placement.worktree, "src/b.ts")])(
          Deferred.succeed(held, undefined).pipe(Effect.andThen(Deferred.await(free))),
        ).pipe(Effect.forkScoped({ startImmediately: true }))
        yield* Deferred.await(held)
        const consumed: string[] = []
        const counted: ReviewFix.Policy = {
          ...f.policy,
          consume: (...args) => {
            consumed.push(third.fixID)
            return f.policy.consume(...args)
          },
        }
        const waiting = yield* f.fix
          .apply({ ...third, consent: unspent, policy: counted, actor: ACTOR })
          .pipe(Effect.forkScoped({ startImmediately: true }))
        yield* Effect.sleep("1 second")
        yield* Fiber.interrupt(waiting)
        const waited = yield* Fiber.await(waiting)
        expect(Exit.isFailure(waited) && Cause.hasInterrupts(waited.cause)).toBe(true)
        expect(consumed).toEqual([])
        expect(yield* f.fix.state(third.fixID)).toBe("preview")
        expect(yield* read(third.placement.worktree, "src/a.ts")).toBe("one\n")
        expect(yield* changedIn(third.placement.worktree)).toEqual([])
        const later = yield* f.fix
          .apply({ ...third, consent: unspent, policy: counted, actor: ACTOR })
          .pipe(Effect.forkScoped({ startImmediately: true }))
        yield* Effect.sleep("1 second")
        expect(consumed).toEqual([])
        yield* Deferred.succeed(free, undefined)
        yield* Fiber.join(later)
        expect(consumed).toEqual([third.fixID])
        expect(yield* read(third.placement.worktree, "src/a.ts")).toBe("two\n")
        expect(f.policy.revoke(unspent)).toEqual({ ok: false, reason: "used" })
        expect(yield* f.fix.cancel(third.fixID)).toEqual({ fixID: third.fixID, removed: true })
      }),
    { git: true },
    60_000,
  )

  it.instance(
    "a failure after writes rolls every file back; a checkout whose binding changed is retained and reported",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture({ "src/a.ts": "one\n", "src/b.ts": "bee\n" })
        const service = yield* Git.Service
        const fix = yield* f.place({ "src/a.ts": "two\n", "src/b.ts": "B\n" })
        yield* f.fix.preview(fix)
        yield* refused(
          f.fix.apply({
            ...fix,
            consent: yield* f.approve(fix.proposal),
            policy: f.policy,
            actor: ACTOR,
            observe: (event) =>
              event.type === "wrote" && event.file === "src/a.ts"
                ? service
                    .run(["checkout", "-q", "-b", "vector-test-attached"], { cwd: fix.placement.worktree })
                    .pipe(Effect.asVoid)
                : Effect.void,
          }),
          "worktree",
        )
        expect(yield* f.fix.state(fix.fixID)).toBe("failed")
        expect(yield* read(fix.placement.worktree, "src/a.ts")).toBe("one\n")
        expect(yield* read(fix.placement.worktree, "src/b.ts")).toBe("bee\n")
        const kept = yield* f.fix.placements()
        expect(kept.map((item) => [item.fixID, item.state])).toEqual([[fix.fixID, "retained"]])
        expect(kept[0]?.error).toContain("kept")
        expect(TaskClaims.protectedConflict("ses_test", path.join(fix.placement.worktree, "src/a.ts"))).toBeDefined()
        expect(yield* f.fix.cancel(fix.fixID)).toMatchObject({ fixID: fix.fixID, removed: false })
        expect(yield* exists(fix.placement.worktree)).toBe(true)

        // The owner puts the checkout back as it was placed; then it is removed.
        yield* git(fix.placement.worktree, ["checkout", "-q", "--detach"])
        yield* git(f.directory, ["branch", "-D", "vector-test-attached"])
        expect(yield* f.fix.cancel(fix.fixID)).toEqual({ fixID: fix.fixID, removed: true })
        expect(yield* exists(fix.placement.worktree)).toBe(false)
        expect(yield* f.fix.state(fix.fixID)).toBeUndefined()
      }),
    { git: true },
    60_000,
  )

  it.instance(
    "files added in one new folder share it: each folder is created once and removed by the rollback",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture({ "src/a.ts": "one\n" })
        const service = yield* Git.Service
        const added = { "src/new/c.ts": "c\n", "src/new/d.ts": "d\n", "src/new/deep/e.ts": "e\n" }
        const fix = yield* f.place(added)
        expect((yield* f.fix.preview(fix)).files.map((item) => [item.path, item.status])).toEqual([
          ["src/new/c.ts", "added"],
          ["src/new/d.ts", "added"],
          ["src/new/deep/e.ts", "added"],
        ])
        yield* f.fix.apply({ ...fix, consent: yield* f.approve(fix.proposal), policy: f.policy, actor: ACTOR })
        expect(yield* read(fix.placement.worktree, "src/new/d.ts")).toBe("d\n")
        expect(yield* read(fix.placement.worktree, "src/new/deep/e.ts")).toBe("e\n")
        expect(yield* changedIn(fix.placement.worktree)).toEqual(["src/new/c.ts", "src/new/d.ts", "src/new/deep/e.ts"])
        expect(yield* f.fix.cancel(fix.fixID)).toEqual({ fixID: fix.fixID, removed: true })

        // A failure after every write (the checkout attached to a branch in the last hook): all three files and both
        // folders go, and the checkout, kept because its binding changed, is clean.
        const again = yield* f.place(added)
        yield* f.fix.preview(again)
        yield* refused(
          f.fix.apply({
            ...again,
            consent: yield* f.approve(again.proposal),
            policy: f.policy,
            actor: ACTOR,
            observe: (event) =>
              event.type === "wrote" && event.file === "src/new/deep/e.ts"
                ? service
                    .run(["checkout", "-q", "-b", "vector-test-folders"], { cwd: again.placement.worktree })
                    .pipe(Effect.asVoid)
                : Effect.void,
          }),
          "worktree",
        )
        expect(yield* f.fix.state(again.fixID)).toBe("failed")
        expect(yield* exists(path.join(again.placement.worktree, "src/new"))).toBe(false)
        expect(yield* Effect.promise(() => fs.readdir(path.join(again.placement.worktree, "src")))).toEqual(["a.ts"])
        expect(yield* changedIn(again.placement.worktree)).toEqual([])
        expect((yield* f.fix.placements()).map((item) => [item.fixID, item.state])).toEqual([[again.fixID, "retained"]])
        yield* git(again.placement.worktree, ["checkout", "-q", "--detach"])
        yield* git(f.directory, ["branch", "-D", "vector-test-folders"])
        expect(yield* f.fix.cancel(again.fixID)).toEqual({ fixID: again.fixID, removed: true })

        // A file where another file needs a folder could never be written, so it is refused before any consent.
        const placement = yield* f.fix.reserve({ head: f.head })
        const conflict = f.proposalFor(
          placement,
          "diff --git a/src/new b/src/new\nnew file mode 100644\n--- /dev/null\n+++ b/src/new\n@@ -0,0 +1 @@\n+x\n" +
            "diff --git a/src/new/x.ts b/src/new/x.ts\nnew file mode 100644\n--- /dev/null\n+++ b/src/new/x.ts\n@@ -0,0 +1 @@\n+y\n",
          [
            { path: "src/new", before: null, after: "x\n" },
            { path: "src/new/x.ts", before: null, after: "y\n" },
          ],
        )
        yield* refused(f.fix.preview({ fixID: placement.fixID, proposal: conflict }), "path")
        expect(yield* changedIn(placement.worktree)).toEqual([])
        expect(yield* f.fix.cancel(placement.fixID)).toMatchObject({ removed: true })
      }),
    { git: true },
    60_000,
  )

  it.instance(
    "a deletion applies, its rollback restores the file's bytes and mode, and a wrong preimage or mode is refused",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture({ "src/a.ts": "one\n", "src/b.ts": "bee\n" })
        const service = yield* Git.Service
        const changes = { "src/a.ts": "two\n", "src/b.ts": null }
        const fix = yield* f.place(changes)
        expect((yield* f.fix.preview(fix)).files).toEqual([
          { path: "src/a.ts", status: "modified", additions: 1, deletions: 1 },
          { path: "src/b.ts", status: "deleted", additions: 0, deletions: 1 },
        ])
        // A mode Git does not record, so only the rollback's own copy of it can bring it back.
        const deleted = path.join(fix.placement.worktree, "src/b.ts")
        yield* Effect.promise(() => fs.chmod(deleted, 0o640))
        const consent = yield* f.approve(fix.proposal)
        const wrote = yield* Deferred.make<void>()
        const fiber = yield* f.fix
          .apply({
            ...fix,
            consent,
            policy: f.policy,
            actor: ACTOR,
            observe: (event) =>
              event.type === "wrote" && event.file === "src/b.ts"
                ? service
                    .run(["checkout", "-q", "-b", "vector-test-deleted"], { cwd: fix.placement.worktree })
                    .pipe(Effect.andThen(Deferred.succeed(wrote, undefined)), Effect.andThen(Effect.never))
                : Effect.void,
          })
          .pipe(Effect.forkScoped({ startImmediately: true }))
        yield* Deferred.await(wrote)
        expect(yield* exists(deleted)).toBe(false)
        yield* Fiber.interrupt(fiber)
        const exit = yield* Fiber.await(fiber)
        expect(Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)).toBe(true)
        // The rollback was certain; the checkout is kept only because the hook attached it to a branch.
        expect(yield* f.fix.state(fix.fixID)).toBe("cancelled")
        expect(yield* read(fix.placement.worktree, "src/b.ts")).toBe("bee\n")
        expect((yield* Effect.promise(() => fs.stat(deleted))).mode & 0o777).toBe(0o640)
        expect(yield* read(fix.placement.worktree, "src/a.ts")).toBe("one\n")
        expect(yield* changedIn(fix.placement.worktree)).toEqual([])
        expect((yield* f.fix.placements()).map((item) => [item.fixID, item.state])).toEqual([[fix.fixID, "retained"]])
        expect(f.policy.revoke(consent)).toEqual({ ok: false, reason: "used" })
        yield* git(fix.placement.worktree, ["checkout", "-q", "--detach"])
        yield* git(f.directory, ["branch", "-D", "vector-test-deleted"])
        expect(yield* f.fix.cancel(fix.fixID)).toEqual({ fixID: fix.fixID, removed: true })

        // Applied in full, the deletion is what Git sees.
        const full = yield* f.place(changes)
        yield* f.fix.preview(full)
        yield* f.fix.apply({ ...full, consent: yield* f.approve(full.proposal), policy: f.policy, actor: ACTOR })
        expect(yield* exists(path.join(full.placement.worktree, "src/b.ts"))).toBe(false)
        expect(yield* changedIn(full.placement.worktree)).toEqual(["src/a.ts", "src/b.ts"])
        expect(yield* f.fix.cancel(full.fixID)).toEqual({ fixID: full.fixID, removed: true })

        // An exact patch whose approved preimage digest names other bytes.
        const exact = yield* f.place({ "src/a.ts": "two\n" })
        const wrong = { ...exact.proposal, files: [{ ...exact.proposal.files[0], preimage: digest("other\n") }] }
        yield* refused(
          f.fix.preview({ fixID: exact.fixID, proposal: wrong }),
          "preimage",
          "This file differs from the approved preimage.",
        )
        expect(yield* f.fix.cancel(exact.fixID)).toMatchObject({ removed: true })

        // Only a 100644 file is deleted. The core grammar admits a deletion without its mode line, so the executor
        // reads the mode from the head.
        yield* write(f.directory, "run.sh", "echo hi\n")
        yield* Effect.promise(() => fs.chmod(path.join(f.directory, "run.sh"), 0o755))
        yield* git(f.directory, ["add", "run.sh"])
        yield* git(f.directory, ["commit", "-q", "-m", "script"])
        const placement = yield* f.fix.reserve({ head: yield* git(f.directory, ["rev-parse", "HEAD"]) })
        const executable = f.proposalFor(
          placement,
          "diff --git a/run.sh b/run.sh\n--- a/run.sh\n+++ /dev/null\n@@ -1 +0,0 @@\n-echo hi\n",
          [{ path: "run.sh", before: "echo hi\n", after: null }],
        )
        yield* refused(
          f.fix.preview({ fixID: placement.fixID, proposal: executable }),
          "path",
          "Only regular text files are changed.",
        )
        expect(yield* exists(path.join(placement.worktree, "run.sh"))).toBe(true)
        expect(yield* f.fix.cancel(placement.fixID)).toMatchObject({ removed: true })
      }),
    { git: true },
    60_000,
  )

  it.instance(
    "the base branch, other refs, another worktree and ignored files stay intact",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture({ "src/a.ts": "one\n", ".gitignore": "*.log\n" })
        yield* git(f.directory, ["tag", "v1", f.base])
        yield* git(f.directory, ["branch", "other", f.base])
        const scratch = yield* Effect.promise(() => fs.mkdtemp(path.join(os.tmpdir(), "vector-fix-linked-")))
        const linked = path.join(scratch, "linked")
        yield* Effect.addFinalizer(() =>
          run(f.directory, ["worktree", "remove", "--force", linked]).pipe(
            Effect.andThen(Effect.promise(() => fs.rm(scratch, { recursive: true, force: true }))),
            Effect.orDie,
          ),
        )
        yield* git(f.directory, ["worktree", "add", "-q", linked, "other"])
        yield* write(linked, "README.md", "linked edit\n")
        yield* write(linked, "linked.txt", "linked untracked\n")
        yield* write(f.directory, "debug.log", "ignored\n")
        const main = () => snapshot(f.directory, ["debug.log", "src/a.ts", ".gitignore"])
        const other = () => snapshot(linked, ["README.md", "linked.txt"])
        const before = { main: yield* main(), other: yield* other() }
        const branches = yield* git(f.directory, ["branch", "--list", "--format=%(refname:short) %(objectname)"])

        const fix = yield* f.place({ "src/a.ts": "two\n" })
        yield* f.fix.preview(fix)
        yield* f.fix.apply({ ...fix, consent: yield* f.approve(fix.proposal), policy: f.policy, actor: ACTOR })
        expect({ main: yield* main(), other: yield* other() }).toEqual(before)
        expect(yield* git(f.directory, ["branch", "--list", "--format=%(refname:short) %(objectname)"])).toBe(branches)
        expect(yield* git(f.directory, ["rev-parse", "main", "v1", "other"])).toBe([f.base, f.base, f.base].join("\n"))
        expect(yield* f.fix.cancel(fix.fixID)).toMatchObject({ removed: true })
        expect({ main: yield* main(), other: yield* other() }).toEqual(before)
        expect(yield* git(f.directory, ["branch", "--list", "--format=%(refname:short) %(objectname)"])).toBe(branches)

        // An added file Git ignores would not show in Git's view of the checkout, so the apply could never confirm it.
        // It is refused before any consent.
        const ignored = yield* f.place({ "x.log": "x\n" })
        yield* refused(f.fix.preview(ignored), "path", "The proposal adds a file Git ignores.")
        expect(yield* exists(path.join(ignored.placement.worktree, "x.log"))).toBe(false)
        expect(yield* f.fix.cancel(ignored.fixID)).toMatchObject({ removed: true })
      }),
    { git: true },
    60_000,
  )

  it.instance(
    "binary, over-limit and checkout-converted files are refused",
    () =>
      Effect.gen(function* () {
        const nul = new Uint8Array([0x61, 0x00, 0x62, 0x0a])
        const invalid = new Uint8Array([0xff, 0x0a])
        const f = yield* fixture({
          "bin.dat": nul,
          "bad.txt": invalid,
          "big.txt": `${"x".repeat(100)}\n`,
          ".gitattributes": "crlf.txt text eol=crlf\n",
          "crlf.txt": "a\n",
        })
        const placement = yield* f.fix.reserve({ head: f.head })
        const text = (file: string, before: Uint8Array) =>
          f.proposalFor(
            placement,
            `diff --git a/${file} b/${file}\n--- a/${file}\n+++ b/${file}\n@@ -1 +1 @@\n-a\n+b\n`,
            [{ path: file, before, after: "b\n" }],
          )
        yield* refused(f.fix.preview({ fixID: placement.fixID, proposal: text("bin.dat", nul) }), "binary")
        yield* refused(f.fix.preview({ fixID: placement.fixID, proposal: text("bad.txt", invalid) }), "binary")
        const big = f.proposalFor(placement, yield* patchFor(f.directory, f.head, { "big.txt": "small\n" }), [
          { path: "big.txt", before: `${"x".repeat(100)}\n`, after: "small\n" },
        ])
        yield* refused(
          f.fix.preview({ fixID: placement.fixID, proposal: big }).pipe(
            Effect.provideService(TaskIsolation.Limits, {
              fileBytes: 100,
              minFreeBytes: 0,
              copyBytes: 1024 * 1024,
              copyFiles: 20_000,
              patchBytes: 256 * 1024,
            }),
          ),
          "limit",
        )
        const binary = f.proposalFor(
          placement,
          "diff --git a/bin.dat b/bin.dat\nindex 1234567..89abcde 100644\nGIT binary patch\nliteral 4\nLcmZ?d00001\n\nliteral 4\nLcmZ?d00001\n\n",
          [{ path: "bin.dat", before: nul, after: "b\n" }],
        )
        yield* refused(f.fix.preview({ fixID: placement.fixID, proposal: binary }), "proposal")
        // Git checks crlf.txt out as CRLF. A proposal whose preimage is those bytes still differs from the committed
        // blob, so the conversion fails closed instead of being written back through.
        expect(yield* read(placement.worktree, "crlf.txt")).toBe("a\r\n")
        const converted = f.proposalFor(
          placement,
          "diff --git a/crlf.txt b/crlf.txt\n--- a/crlf.txt\n+++ b/crlf.txt\n@@ -1 +1 @@\n-a\r\n+b\r\n",
          [{ path: "crlf.txt", before: "a\r\n", after: "b\r\n" }],
        )
        yield* refused(f.fix.preview({ fixID: placement.fixID, proposal: converted }), "preimage")
        expect(yield* changedIn(placement.worktree)).toEqual([])
        expect(yield* f.fix.cancel(placement.fixID)).toMatchObject({ removed: true })
      }),
    { git: true },
    60_000,
  )

  it.instance(
    "a GitHub-scoped proposal is refused",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture({ "src/a.ts": "one\n" })
        const fix = yield* f.place({ "src/a.ts": "two\n" })
        const proposal = {
          ...fix.proposal,
          scope: {
            kind: "github",
            repositoryID: 1,
            owner: "octo",
            repository: "repo",
            pullRequest: 7,
            sourceBranch: "feature",
            baseBranch: "main",
            destinationBranch: "vector/fix-1",
          },
        }
        yield* refused(f.fix.preview({ fixID: fix.fixID, proposal }), "scope")
        const elsewhere = { ...fix.proposal, scope: { ...fix.proposal.scope, worktree: path.join(f.directory, "fix") } }
        yield* refused(f.fix.preview({ fixID: fix.fixID, proposal: elsewhere }), "scope")
        expect(yield* exists(fix.placement.worktree)).toBe(false)
        expect(yield* f.fix.cancel(fix.fixID)).toMatchObject({ removed: true })
      }),
    { git: true },
    60_000,
  )

  it.instance(
    "fix checkouts are protected from conversations and invisible to every task path",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture({ "src/a.ts": "one\n" })
        const fix = yield* f.place({ "src/a.ts": "two\n" })
        yield* f.fix.preview(fix)
        const worktree = fix.placement.worktree
        const registry = path.join(Global.Path.data, "task-isolation", f.home.project.id, ".fix", fix.fixID)
        expect(TaskClaims.protectedConflict("ses_other", path.join(worktree, "src/a.ts"))).toBeDefined()
        expect(TaskClaims.protectedConflict("ses_other", path.join(registry, "fix.json"))).toBeDefined()
        expect(TaskClaims.protectedConflict(fix.fixID, path.join(worktree, ".git"))).toBeDefined()
        expect(TaskClaims.protectedConflict(fix.fixID, path.join(worktree, "src/a.ts"))).toBeUndefined()
        // Protecting the placements again never narrows a protection already held, even when a record cannot be read.
        const gitDirectory = (yield* f.isolation.verifyFix(fix.fixID)).gitDirectory
        const saved = yield* read(registry, "fix.json")
        yield* Effect.promise(() => fs.writeFile(path.join(registry, "fix.json"), "{"))
        expect(yield* f.fix.placements()).toEqual([])
        expect(TaskClaims.protectedConflict("ses_other", path.join(gitDirectory, "HEAD"))).toBeDefined()
        yield* Effect.promise(() => fs.writeFile(path.join(registry, "fix.json"), saved))
        expect(TaskPlace.isTaskDirectory(worktree)).toBe(false)
        expect(yield* f.isolation.records()).toEqual([])
        const record = JSON.parse(yield* read(registry, "fix.json"))
        expect(() => Schema.decodeUnknownSync(TaskIsolation.Record)(record)).toThrow()

        // Every task entry point treats the fix ID as no task of its own.
        const agents = yield* Agent.Service
        const agent = yield* agents.get("general")
        expect(yield* f.isolation.find(fix.fixID)).toBeUndefined()
        yield* fails(f.isolation.get(fix.fixID))
        yield* fails(f.isolation.start(fix.fixID))
        yield* fails(f.isolation.settle({ taskID: fix.fixID, attempt: 1 }))
        yield* fails(f.isolation.changes({ taskID: fix.fixID, diff: true }))
        yield* fails(f.isolation.merge({ taskID: fix.fixID, by: { kind: "owner" } }))
        yield* fails(f.isolation.discard({ taskID: fix.fixID, by: { kind: "owner" } }))
        yield* fails(f.isolation.resume({ taskID: fix.fixID, attempt: 2, agent }))
        yield* fails(f.isolation.reconcile(fix.fixID))
        yield* fails(f.isolation.enqueue(fix.fixID))
        yield* fails(f.isolation.review({ taskID: fix.fixID, parentSessionID: "ses_other" }, () => Effect.void))
        expect(yield* f.isolation.markSettling(fix.fixID, 1)).toBeUndefined()
        yield* f.isolation.admit(fix.fixID)
        const worktrees = yield* Worktree.Service
        yield* fails(
          worktrees.removeForTask({ name: fix.fixID, directory: worktree, branch: `vector/subagent/${fix.fixID}` }),
        )
        expect(yield* f.isolation.sweep({ force: true })).toEqual([])

        // None of that touched the placement, which Worktree.list still shows (worktree/index.ts is unchanged).
        expect((yield* f.isolation.verifyFix(fix.fixID)).state).toBe("ready")
        expect((yield* f.fix.placements()).map((item) => item.fixID)).toEqual([fix.fixID])
        expect(yield* read(worktree, "src/a.ts")).toBe("one\n")
        expect((yield* worktrees.list()).map((item) => item.directory)).toContain(
          yield* Effect.promise(() => fs.realpath(worktree)),
        )
        expect(yield* f.fix.cancel(fix.fixID)).toMatchObject({ removed: true })
      }),
    { git: true },
    60_000,
  )

  it.instance(
    "a fix checkout removed through the worktree service is refused at apply without spending the consent",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture({ "src/a.ts": "one\n" })
        const fix = yield* f.place({ "src/a.ts": "two\n" })
        yield* f.fix.preview(fix)
        const consent = yield* f.approve(fix.proposal)
        const worktrees = yield* Worktree.Service
        expect(yield* worktrees.remove({ directory: fix.placement.worktree })).toBe(true)
        expect(yield* exists(fix.placement.worktree)).toBe(false)
        yield* refused(f.fix.apply({ ...fix, consent, policy: f.policy, actor: ACTOR }), "worktree")
        expect(f.policy.revoke(consent)).toEqual({ ok: true })
        expect(yield* f.fix.cancel(fix.fixID)).toEqual({ fixID: fix.fixID, removed: true })
        expect(yield* f.fix.placements()).toEqual([])
      }),
    { git: true },
    60_000,
  )

  it.instance(
    "the sweep removes a placement whose process is gone, keeps an unverifiable one, and protects both first",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture({ "src/a.ts": "one\n" })
        const live = yield* f.place({ "src/a.ts": "two\n" })
        yield* f.fix.preview(live)
        const gone = yield* f.place({ "src/a.ts": "two\n" })
        yield* f.fix.preview(gone)
        const broken = yield* f.place({ "src/a.ts": "two\n" })
        yield* f.fix.preview(broken)
        yield* git(broken.placement.worktree, ["checkout", "-q", "-b", "vector-test-broken"])
        // An earlier process: its lease is closed and its in-memory protection is gone.
        for (const item of [gone, broken]) {
          BackgroundJobStore.close((yield* f.isolation.getFix(item.fixID)).owner)
          TaskClaims.unprotect(item.fixID)
          expect(
            TaskClaims.protectedConflict("ses_other", path.join(item.placement.worktree, "src/a.ts")),
          ).toBeUndefined()
        }
        expect(yield* f.isolation.sweep({ force: true })).toEqual([])
        expect(yield* exists(gone.placement.worktree)).toBe(false)
        expect(Object.fromEntries((yield* f.fix.placements()).map((item) => [item.fixID, item.state]))).toEqual({
          [live.fixID]: "ready",
          [broken.fixID]: "retained",
        })
        expect(
          TaskClaims.protectedConflict("ses_other", path.join(broken.placement.worktree, "src/a.ts")),
        ).toBeDefined()
        expect(yield* read(live.placement.worktree, "src/a.ts")).toBe("one\n")
        yield* git(broken.placement.worktree, ["checkout", "-q", "--detach"])
        yield* git(f.directory, ["branch", "-D", "vector-test-broken"])
        expect(yield* f.fix.cancel(broken.fixID)).toMatchObject({ removed: true })
        expect(yield* f.fix.cancel(live.fixID)).toMatchObject({ removed: true })
      }),
    { git: true },
    90_000,
  )
})

// VS-12b (SF-08): checks, commit and push. The checks run real `bun test` commands in the real sandbox where one works
// here (bubblewrap with user namespaces: verify.yml's air-gap job, and a root container); test.yml's runners have
// none, so there only the refusals before the sandbox run, and the case that the real sandbox refuses. Nothing here
// reaches a network: the one push goes to a bare repository on this computer.
const IDENTITY = { name: "Vector", email: "bot@vectordev.ai" }
const bwrap = linux ? Bun.which("bwrap") : null
const sandboxed =
  !!bwrap &&
  Bun.spawnSync(
    [bwrap, "--die-with-parent", "--cap-drop", "ALL", "--unshare-ipc", "--unshare-uts"]
      .concat(["--unshare-pid", "--unshare-net", "--ro-bind", "/", "/", "--dev", "/dev", "--proc", "/proc"])
      .concat(["--tmpfs", "/tmp", "true"]),
    { stdout: "ignore", stderr: "ignore" },
  ).exitCode === 0
// The variables a check may see: the executor's own (fix.ts `environment`), what /bin/sh and bun test add, and the
// floor every untrusted child of a process running agents gets (child-environment.ts).
const ALLOWED = [
  "PATH",
  "HOME",
  "TMPDIR",
  "XDG_CACHE_HOME",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "LANG",
  "LC_ALL",
  "TZ",
  "TERM",
  "CI",
  "NO_COLOR",
  "CARGO_NET_OFFLINE",
  "GOPROXY",
  "GOTOOLCHAIN",
  "npm_config_offline",
  "PIP_NO_INDEX",
  "PYTHONDONTWRITEBYTECODE",
  "BUN_RUNTIME_TRANSPILER_CACHE_PATH",
  "PWD",
  "OLDPWD",
  "SHLVL",
  "_",
  "NODE_ENV",
  "VECTOR_LOCAL",
  "VECTOR_LOCAL_WEB",
  "VECTOR_AGENT_SESSION",
]
const BASE = {
  "package.json": '{"name":"fixture","private":true}\n',
  ".gitignore": "out/\nnode_modules/\n",
  "src/a.ts": "one\n",
}
const checksOp = (
  commands: readonly { argv: readonly string[]; cwd?: string }[],
  bounds: { timeoutMs: number; outputBytes: number } = { timeoutMs: 60_000, outputBytes: 8_192 },
) => ({
  kind: "checks",
  commands: commands.map((command) => ({ argv: [...command.argv], cwd: command.cwd ?? "." })),
  network: "off",
  ...bounds,
})
/** Whether a process whose command line holds `token` is alive, read from /proc without starting anything. */
const runningWith = (token: string) =>
  Effect.promise(async () => {
    const names = (await fs.readdir("/proc")).filter((name) => /^\d+$/.test(name) && Number(name) !== process.pid)
    const lines = await Promise.all(
      names.map((name) =>
        fs.readFile(path.join("/proc", name, "cmdline"), "utf8").then(
          (text) => text,
          () => "",
        ),
      ),
    )
    return lines.some((line) => line.includes(token))
  })
const settles = (token: string) =>
  Effect.gen(function* () {
    for (const _ of Array.from({ length: 50 })) {
      if (!(yield* runningWith(token))) return true
      yield* Effect.sleep("100 millis")
    }
    return false
  })
const starts = (token: string) =>
  Effect.gen(function* () {
    for (const _ of Array.from({ length: 300 })) {
      if (yield* runningWith(token)) return true
      yield* Effect.sleep("100 millis")
    }
    return false
  })
/**
 * The processes whose command line holds `token`, from /proc/<pid>/stat (the fields after the command name: state,
 * parent, process group, session, terminal), read synchronously so a poll sees bwrap within a millisecond of its exec.
 */
const processesWith = (token: string) =>
  readdirSync("/proc").flatMap((name) => {
    if (!/^\d+$/.test(name) || Number(name) === process.pid) return []
    try {
      if (!readFileSync(path.join("/proc", name, "cmdline"), "utf8").includes(token)) return []
      const stat = readFileSync(path.join("/proc", name, "stat"), "utf8")
      const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ")
      return [
        {
          pid: Number(name),
          parent: Number(fields[1]),
          group: Number(fields[2]),
          session: Number(fields[3]),
          terminal: Number(fields[4]),
        },
      ]
    } catch {
      return []
    }
  })
/** Polls without sleeping until a process with `token` exists: the outer bwrap, as soon as it is exec'd. */
const appears = (token: string) =>
  Effect.gen(function* () {
    const deadline = Date.now() + 30_000
    while (Date.now() < deadline) {
      const found = processesWith(token)
      if (found.length) return found
      yield* Effect.yieldNow
    }
    return []
  })

/** Moves the user's reviewed branch (the checkout is on it) by one commit. */
const move = (directory: string) => commit(directory, { [`moved-${randomUUID()}.txt`]: "x\n" }, "moved")

/** The SF-07 fixture with a package and its ignores, plus helpers that take a fix through its consented steps. */
const steps = Effect.fn("FixTest.steps")(function* (files: Record<string, string> = {}) {
  const f = yield* fixture({ ...BASE, ...files })
  const approveOp = (proposal: unknown, operation: unknown, actor = ACTOR, lifetime = 60_000) =>
    Effect.promise(() => f.policy.approve(proposal, operation, actor, lifetime)).pipe(
      Effect.map((result) => {
        if (!result.ok) throw new Error(`approval refused: ${result.reason}`)
        return result.consent
      }),
    )
  const applied = Effect.fn("FixTest.applied")(function* (
    changes: Record<string, string | null> = { "src/a.ts": "two\n" },
  ) {
    const fix = yield* f.place(changes)
    yield* f.fix.preview(fix)
    yield* f.fix.apply({ ...fix, consent: yield* f.approve(fix.proposal), policy: f.policy, actor: ACTOR })
    return fix
  })
  const committed = Effect.fn("FixTest.committed")(function* (message = "fix: two\n") {
    const fix = yield* applied()
    const operation = { kind: "commit", message }
    const made = yield* f.fix.commit({
      ...fix,
      operation,
      consent: yield* approveOp(fix.proposal, operation),
      policy: f.policy,
      actor: ACTOR,
      identity: IDENTITY,
    })
    return { ...fix, made }
  })
  /** A bare repository outside the project and the data folder, holding the user's main and feature. */
  const bare = Effect.fn("FixTest.bare")(function* () {
    const scratch = yield* Effect.promise(() => fs.mkdtemp(path.join(os.tmpdir(), "vector-fix-remote-")))
    yield* Effect.addFinalizer(() => Effect.promise(() => fs.rm(scratch, { recursive: true, force: true })))
    const directory = path.join(scratch, "remote.git")
    yield* git(scratch, ["init", "-q", "--bare", directory])
    yield* git(f.directory, ["push", "-q", directory, "main", "feature"])
    return { directory, url: `file://${directory}` }
  })
  // CI sets CI=true, which the real context refuses, so these cases run checks as on a developer's computer; case 1
  // checks the context gate itself through `service`, the executor as it is.
  const local = (request: Parameters<typeof f.fix.checks>[0]) =>
    f.fix.checks(request).pipe(Effect.provideService(ReviewFix.RunnerContext, () => undefined))
  return { ...f, fix: { ...f.fix, checks: local }, service: f.fix, approveOp, applied, committed, bare }
})

describe.skipIf(!linux)("review fix checks, commit and push (VS-12b)", () => {
  it.instance(
    "a check is refused before its consent is spent: state, argv, flags, coverage, folders and context",
    () =>
      Effect.gen(function* () {
        const marker = `marker-${randomUUID()}`
        const f = yield* steps({
          ".gitignore": "out/\nnode_modules/\nlinked\n",
          [`test/${marker}.test.ts`]: `import { test } from "bun:test"\nimport fs from "node:fs"\ntest("m", () => fs.writeFileSync("${marker}", "ran"))\n`,
        })
        const good = checksOp([{ argv: ["bun", "test", `test/${marker}.test.ts`] }])
        const fix = yield* f.place({ "src/a.ts": "two\n" })
        yield* f.fix.preview(fix)
        const consent = yield* f.approveOp(fix.proposal, good)
        const checks = (operation: unknown) =>
          f.fix.checks({ ...fix, operation, consent, policy: f.policy, actor: ACTOR })
        // Not applied yet.
        yield* refused(checks(good), "state")
        yield* f.fix.apply({ ...fix, consent: yield* f.approve(fix.proposal), policy: f.policy, actor: ACTOR })
        // Core refuses these at approve; the executor refuses them before it spends a consent.
        for (const argv of [
          ["bun", "test", "--preload", "x.ts"],
          ["sh", "-c", `touch ${marker}`],
          ["bun", "x", "anything"],
          ["bun", "test", "../outside.test.ts"],
          ["bun", "test", ".git/hooks"],
        ])
          yield* refused(checks(checksOp([{ argv }])), "operation")
        // VS-30's coverage command: the core contract admits it; the executor does not while VS-30 is unapplied.
        const coverage = checksOp([{ argv: ["bun", "test", "--coverage", "--coverage-reporter=lcov"] }])
        expect((yield* Effect.promise(() => f.policy.approve(fix.proposal, coverage, ACTOR, 60_000))).ok).toBe(true)
        yield* refused(checks(coverage), "operation")
        yield* refused(checks({ ...good, network: "on" }), "operation")
        yield* refused(checks({ ...good, timeoutMs: 120_001 }), "operation")
        yield* refused(checks({ ...good, outputBytes: 80 * 1024 + 1 }), "operation")
        yield* refused(checks({ ...good, extra: true }), "operation")
        yield* refused(checks(checksOp(Array.from({ length: 17 }, () => good.commands[0]))), "operation")
        // Folders: outside, missing, a file, a link.
        yield* refused(checks(checksOp([{ argv: good.commands[0].argv, cwd: "../x" }])), "operation")
        yield* refused(checks(checksOp([{ argv: good.commands[0].argv, cwd: "missing" }])), "path")
        yield* refused(checks(checksOp([{ argv: good.commands[0].argv, cwd: "src/a.ts" }])), "path")
        yield* Effect.promise(() => fs.symlink("src", path.join(fix.placement.worktree, "linked")))
        yield* refused(checks(checksOp([{ argv: good.commands[0].argv, cwd: "linked" }])), "symlink")
        yield* Effect.promise(() => fs.unlink(path.join(fix.placement.worktree, "linked")))
        // Never in a CI job, a GitHub run or on Actions.
        const raw = (operation: unknown) =>
          f.service.checks({ ...fix, operation, consent, policy: f.policy, actor: ACTOR })
        yield* refused(
          raw(good).pipe(Effect.provideService(ReviewFix.RunnerContext, () => "Checks not run: a GitHub run.")),
          "context",
          "Checks not run: a GitHub run.",
        )
        const ci =
          "Checks not run: checks never run in a CI job or a GitHub run, which may hold secrets or write tokens."
        yield* refused(
          raw(good).pipe(
            Effect.provideService(ReviewFix.RunnerContext, () =>
              ReviewFix.runnerContext({ PATH: "/usr/bin", CI: "1" }),
            ),
          ),
          "context",
          ci,
        )
        for (const env of [
          { CI: "1" },
          { CI: "true" },
          { CI: " TRUE " },
          { GITHUB_ACTIONS: "true" },
          { GITLAB_CI: "true" },
          { JENKINS_URL: "http://jenkins" },
          { TF_BUILD: "True" },
          { BUILDKITE: "true" },
        ])
          expect(ReviewFix.runnerContext(env)).toBe(ci)
        for (const env of [{}, { CI: "" }, { CI: "0" }, { CI: "false" }, { GITHUB_ACTIONS: "false", CI: "False" }])
          expect(ReviewFix.runnerContext(env)).toBeUndefined()
        // A proposal other than the applied one.
        const other = f.proposalFor(fix.placement, yield* patchFor(f.directory, f.head, { "src/a.ts": "three\n" }), [
          { path: "src/a.ts", before: "one\n", after: "three\n" },
        ])
        yield* refused(
          f.fix.checks({ ...fix, proposal: other, operation: good, consent, policy: f.policy, actor: ACTOR }),
          "digest",
        )
        expect(yield* exists(path.join(fix.placement.worktree, marker))).toBe(false)
        expect(f.policy.revoke(consent)).toEqual({ ok: true })
        expect(yield* f.fix.state(fix.fixID)).toBe("applied")
        expect(yield* f.fix.cancel(fix.fixID)).toEqual({ fixID: fix.fixID, removed: true })
      }),
    { git: true },
    60_000,
  )

  it.instance(
    "checks report unavailable dependencies, a missing program and no sandbox before the consent is spent",
    () =>
      Effect.gen(function* () {
        const crate = '[package]\nname = "c"\nversion = "0.1.0"\n\n[dependencies]\nserde = "1" # a registry package\n'
        const module = "module example.com/m\n\ngo 1.22\n\nrequire (\n\texample.com/dep v1.0.0 // indirect\n)\n"
        const f = yield* steps({
          "package.json": '{"name":"fixture","private":true,"devDependencies":{"left-pad":"1.3.0"}}\n',
          "test/a.test.ts": 'import { test } from "bun:test"\ntest("a", () => {})\n',
          "crate/Cargo.toml": crate,
          "locked/Cargo.toml": '[package]\nname = "l"\nversion = "0.1.0"\n',
          "locked/Cargo.lock":
            'version = 3\n\n[[package]]\nname = "serde"\nversion = "1.0.0"\nsource = "registry+https://github.com/rust-lang/crates.io-index"\n',
          "local/Cargo.toml":
            '[package]\nname = "p"\nversion = "0.1.0"\n\n[dependencies]\nsibling = { path = "../sibling" }\n\n[[bin]]\nname = "x"\n',
          "vendored/Cargo.toml": crate,
          "vendored/.cargo/config.toml":
            '[source.crates-io]\nreplace-with = "vendored-sources"\n\n[source.vendored-sources]\ndirectory = "vendor"\n',
          "gomod/go.mod": module,
          "govendor/go.mod": module,
          "govendor/vendor/modules.txt": "# example.com/dep v1.0.0\n## explicit\n",
          "goplain/go.mod": "module example.com/p\n\ngo 1.22\n",
        })
        const fix = yield* f.applied()
        const operation = checksOp([{ argv: ["bun", "test", "test/a.test.ts"] }])
        const consent = yield* f.approveOp(fix.proposal, operation)
        const checks = (input: unknown = operation) =>
          f.fix.checks({ ...fix, operation: input, consent, policy: f.policy, actor: ACTOR })
        const exit = yield* Effect.exit(checks())
        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isFailure(exit))
          expect(Cause.squash(exit.cause)).toMatchObject({
            reason: "dependencies",
            message: expect.stringMatching(/^Checks not run: dependencies unavailable \(package\.json declares/),
          })
        // pytest is allowed; a program that is not on the check's PATH is the same refusal. PATH holds only Git here
        // for this one call, which the steps before the dependencies need.
        const only = yield* Effect.promise(() => fs.mkdtemp(path.join(os.tmpdir(), "vector-fix-path-")))
        yield* Effect.addFinalizer(() => Effect.promise(() => fs.rm(only, { recursive: true, force: true })))
        yield* Effect.promise(() => fs.symlink(Bun.which("git") ?? "/usr/bin/git", path.join(only, "git")))
        const saved = process.env.PATH
        yield* Effect.sync(() => {
          process.env.PATH = only
        })
        yield* refused(checks(checksOp([{ argv: ["pytest"] }])), "dependencies").pipe(
          Effect.ensuring(
            Effect.sync(() => {
              process.env.PATH = saved
            }),
          ),
        )
        // Cargo and Go: what they build from must be in the checkout, since a check sees no package cache, module cache
        // or network. Programs that only fail stand for the toolchains, beside Git (the steps before need it); none runs.
        const tools = yield* Effect.promise(() => fs.mkdtemp(path.join(os.tmpdir(), "vector-fix-tools-")))
        yield* Effect.addFinalizer(() => Effect.promise(() => fs.rm(tools, { recursive: true, force: true })))
        const plain = path.join(tools, "plain")
        const proxied = path.join(tools, "proxied")
        for (const folder of [plain, proxied]) {
          yield* Effect.promise(() => fs.mkdir(folder))
          yield* Effect.promise(() => fs.symlink(Bun.which("git") ?? "/usr/bin/git", path.join(folder, "git")))
        }
        for (const file of [path.join(plain, "cargo"), path.join(plain, "go"), path.join(proxied, "rustup")])
          yield* Effect.promise(() => fs.writeFile(file, "#!/bin/sh\nexit 1\n", { mode: 0o755 }))
        // rustup installs its proxies as hard links (or links) to itself.
        yield* Effect.promise(() => fs.link(path.join(proxied, "rustup"), path.join(proxied, "cargo")))
        // Each gate with PATH set to one folder for that call; a platform with no sandbox stops what passes it.
        const gate = (argv: string[], cwd: string, folder = plain) =>
          Effect.acquireUseRelease(
            Effect.sync(() => {
              const before = process.env.PATH
              process.env.PATH = folder
              return before
            }),
            () =>
              Effect.exit(
                checks(checksOp([{ argv, cwd }])).pipe(Effect.provideService(ReviewFix.SandboxPlatform, "freebsd")),
              ),
            (before) =>
              Effect.sync(() => {
                process.env.PATH = before
              }),
          ).pipe(Effect.map((exit) => (Exit.isFailure(exit) ? Cause.squash(exit.cause) : exit.value)))
        const dependencies = (detail: string) => ({
          reason: "dependencies",
          message: `Checks not run: dependencies unavailable (${detail}).`,
        })
        const vendor = "names registry or git packages, and the checkout does not vendor them"
        expect(yield* gate(["cargo", "test"], "crate")).toMatchObject(dependencies(`crate/Cargo.toml ${vendor}`))
        expect(yield* gate(["cargo", "test"], "locked")).toMatchObject(dependencies(`locked/Cargo.lock ${vendor}`))
        expect(yield* gate(["cargo", "test"], "local")).toMatchObject({ reason: "sandbox" })
        expect(yield* gate(["cargo", "test"], "vendored")).toMatchObject({ reason: "sandbox" })
        expect(yield* gate(["cargo", "test"], "local", proxied)).toMatchObject(
          dependencies(
            "cargo here is rustup's proxy, and the toolchains rustup keeps in your home folder are not visible to checks",
          ),
        )
        expect(yield* gate(["go", "test", "./..."], "gomod")).toMatchObject(
          dependencies("gomod/go.mod requires modules, and the checkout does not vendor them"),
        )
        expect(yield* gate(["go", "test", "./..."], "govendor")).toMatchObject({ reason: "sandbox" })
        expect(yield* gate(["go", "test"], "goplain")).toMatchObject({ reason: "sandbox" })
        // Installed (node_modules is ignored, so the checkout still holds exactly the patch), the next stage decides:
        // here a platform with no sandbox to run in, and one where commands are not network-filtered.
        yield* Effect.promise(() => fs.mkdir(path.join(fix.placement.worktree, "node_modules")))
        for (const platform of ["win32", "freebsd"] as const) {
          const refusedHere = yield* Effect.exit(
            checks().pipe(Effect.provideService(ReviewFix.SandboxPlatform, platform)),
          )
          expect(Exit.isFailure(refusedHere)).toBe(true)
          if (Exit.isFailure(refusedHere))
            expect(Cause.squash(refusedHere.cause)).toMatchObject({
              reason: "sandbox",
              message: expect.stringMatching(/^Checks not run: /),
            })
        }
        expect(f.policy.revoke(consent)).toEqual({ ok: true })
        expect(yield* f.fix.cancel(fix.fixID)).toMatchObject({ removed: true })
      }),
    { git: true },
    60_000,
  )

  it.instance(
    "cancelling while a check is being prepared stops it at once and spends nothing",
    () =>
      Effect.gen(function* () {
        const f = yield* steps({ "test/a.test.ts": 'import { test } from "bun:test"\ntest("a", () => {})\n' })
        const fix = yield* f.applied()
        const operation = checksOp([{ argv: ["bun", "test", "test/a.test.ts"] }])
        const consent = yield* f.approveOp(fix.proposal, operation)
        const probing = yield* Deferred.make<void>()
        const fiber = yield* f.fix
          .checks({
            ...fix,
            operation,
            consent,
            policy: f.policy,
            actor: ACTOR,
            observe: (event) =>
              event.type === "probe"
                ? Deferred.succeed(probing, undefined).pipe(Effect.andThen(Effect.never))
                : Effect.void,
          })
          .pipe(Effect.forkScoped({ startImmediately: true }))
        yield* Deferred.await(probing)
        const started = Date.now()
        expect(yield* f.fix.cancel(fix.fixID)).toEqual({ fixID: fix.fixID, removed: true })
        expect(Date.now() - started).toBeLessThan(10_000)
        const exit = yield* Fiber.await(fiber)
        expect(Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)).toBe(true)
        expect(yield* exists(fix.placement.worktree)).toBe(false)
        expect(f.policy.revoke(consent)).toEqual({ ok: true })
      }),
    { git: true },
    60_000,
  )

  it.instance(
    "a commit needs its own consent and lands the approved postimages on a new destination branch, without hooks",
    () =>
      Effect.gen(function* () {
        const f = yield* steps({ "src/b.ts": "bee\n", "run.sh": "echo hi\n" })
        yield* Effect.promise(() => fs.chmod(path.join(f.directory, "run.sh"), 0o755))
        yield* git(f.directory, ["add", "run.sh"])
        yield* git(f.directory, ["commit", "-q", "-m", "mode"])
        const head = yield* git(f.directory, ["rev-parse", "HEAD"])
        // patchFor writes every file as 100644, so the executable's section is written by hand (no mode change).
        const placement = yield* f.fix.reserve({ head })
        const patch =
          (yield* patchFor(f.directory, head, { "src/a.ts": "two\n", "src/b.ts": null, "src/new/c.ts": "new\n" })) +
          "diff --git a/run.sh b/run.sh\n--- a/run.sh\n+++ b/run.sh\n@@ -1 +1 @@\n-echo hi\n+echo bye\n"
        const fix = {
          placement,
          fixID: placement.fixID,
          proposal: f.proposalFor(placement, patch, [
            { path: "run.sh", before: "echo hi\n", after: "echo bye\n" },
            { path: "src/a.ts", before: "one\n", after: "two\n" },
            { path: "src/b.ts", before: "bee\n", after: null },
            { path: "src/new/c.ts", before: null, after: "new\n" },
          ]),
        }
        yield* f.fix.preview(fix)
        yield* f.fix.apply({ ...fix, consent: yield* f.approve(fix.proposal), policy: f.policy, actor: ACTOR })
        const message = "fix: apply the review fix\n\nfinding-1\n# kept verbatim\n"
        const operation = { kind: "commit", message }
        const commit = (consent: FixConsent, input: unknown = operation, policy = f.policy) =>
          f.fix.commit({ ...fix, operation: input, consent, policy, actor: ACTOR, identity: IDENTITY })
        const files = ["src/a.ts", "src/b.ts", "run.sh"]
        const before = yield* snapshot(f.directory, files)
        const unspent = yield* f.approve(fix.proposal)
        yield* refused(commit(unspent), "mismatch")
        const checks = yield* f.approveOp(fix.proposal, checksOp([{ argv: ["bun", "test"] }]))
        yield* refused(commit(checks), "mismatch")
        const elsewhere = createFixConsentPolicy(() => 1_000)
        const foreign = yield* Effect.promise(() => elsewhere.approve(fix.proposal, operation, ACTOR, 60_000))
        if (!foreign.ok) throw new Error(foreign.reason)
        yield* refused(commit(foreign.consent), "unknown")
        const consent = yield* f.approveOp(fix.proposal, operation)
        yield* refused(commit(consent, { kind: "commit", message: "fix: another message\n" }), "mismatch")
        expect(
          (yield* run(f.directory, ["rev-parse", "--verify", "--quiet", "refs/heads/vector/fix-1"])).exitCode,
        ).not.toBe(0)
        // Hooks in the user's repository, which nothing below may run.
        const hooks = path.resolve(f.directory, yield* git(f.directory, ["rev-parse", "--git-path", "hooks"]))
        const ran = path.join(f.home.directory, `hook-${randomUUID()}`)
        for (const name of ["reference-transaction", "post-commit", "pre-commit", "commit-msg"]) {
          yield* Effect.promise(() =>
            fs.writeFile(path.join(hooks, name), `#!/bin/sh\ntouch "${ran}"\n`, { mode: 0o755 }),
          )
        }
        const made = yield* commit(consent)
        expect(yield* exists(ran)).toBe(false)
        for (const name of ["reference-transaction", "post-commit", "pre-commit", "commit-msg"])
          yield* Effect.promise(() => fs.rm(path.join(hooks, name)))
        expect(made).toMatchObject({ fixID: fix.fixID, head, branch: "vector/fix-1", author: IDENTITY, actor: ACTOR })
        expect(yield* git(f.directory, ["rev-parse", "refs/heads/vector/fix-1"])).toBe(made.commit)
        expect(yield* git(f.directory, ["log", "-1", "--format=%an <%ae>|%cn <%ce>|%P|%T", made.commit])).toBe(
          `Vector <bot@vectordev.ai>|Vector <bot@vectordev.ai>|${head}|${made.tree}`,
        )
        const raw = yield* git(f.directory, ["cat-file", "commit", made.commit])
        expect(
          (yield* run(f.directory, ["cat-file", "commit", made.commit])).text().split("\n\n").slice(1).join("\n\n"),
        ).toBe(message)
        expect(raw).toContain("author Vector <bot@vectordev.ai>")
        expect(
          (yield* git(f.directory, ["diff-tree", "-r", "--no-renames", "--name-status", head, made.commit])).split(
            "\n",
          ),
        ).toEqual(["M\trun.sh", "M\tsrc/a.ts", "D\tsrc/b.ts", "A\tsrc/new/c.ts"])
        expect(yield* git(f.directory, ["show", `${made.commit}:src/a.ts`])).toBe("two")
        expect(yield* git(f.directory, ["show", `${made.commit}:src/new/c.ts`])).toBe("new")
        // The head's mode is kept for a modified file.
        expect(yield* git(f.directory, ["ls-tree", made.commit, "run.sh"])).toStartWith("100755 blob ")
        // The user's checkout is as it was, but for the new branch; the fix checkout is still detached at the head.
        const after = yield* snapshot(f.directory, files)
        expect({ ...after, refs: "" }).toEqual({ ...before, refs: "" })
        expect(after.refs.split("\n").filter((line) => !before.refs.split("\n").includes(line))).toEqual([
          `refs/heads/vector/fix-1 ${made.commit}`,
        ])
        expect(yield* git(fix.placement.worktree, ["rev-parse", "HEAD"])).toBe(head)
        expect((yield* run(fix.placement.worktree, ["symbolic-ref", "-q", "HEAD"])).exitCode).not.toBe(0)
        expect(yield* f.fix.state(fix.fixID)).toBe("committed")
        const listed = yield* f.fix.placements()
        expect(listed.map((item) => [item.state, item.commit?.sha, item.commit?.branch])).toEqual([
          ["committed", made.commit, "vector/fix-1"],
        ])
        // The private index is gone with the build.
        for (const item of listed) expect(yield* exists(TaskIsolation.fixCommitIndex(item))).toBe(false)
        yield* refused(commit(yield* f.approveOp(fix.proposal, operation)), "state")
        expect(f.policy.revoke(unspent)).toEqual({ ok: true })
        expect(f.policy.revoke(checks)).toEqual({ ok: true })
        // Cancel removes the placement and keeps the branch.
        expect(yield* f.fix.cancel(fix.fixID)).toEqual({ fixID: fix.fixID, removed: true })
        expect(yield* git(f.directory, ["rev-parse", "refs/heads/vector/fix-1"])).toBe(made.commit)
      }),
    { git: true },
    60_000,
  )

  it.instance(
    "a commit is refused before its consent is spent when the checkout or the destination is not as approved",
    () =>
      Effect.gen(function* () {
        const f = yield* steps()
        const fix = yield* f.applied()
        const operation = { kind: "commit", message: "fix: two\n" }
        const consent = yield* f.approveOp(fix.proposal, operation)
        const commit = (identity: ReviewFix.Identity = IDENTITY) =>
          f.fix.commit({
            ...fix,
            operation,
            consent,
            policy: f.policy,
            actor: ACTOR,
            identity,
          })
        const target = path.join(fix.placement.worktree, "src/a.ts")
        for (const identity of [
          { name: "Vector", email: "nobody" },
          { name: "Vector <x>", email: "bot@vectordev.ai" },
          { name: "Vector\n", email: "bot@vectordev.ai" },
          { name: "Vector", email: "bot@vectordev.ai", extra: 1 },
        ])
          yield* refused(commit(identity), "operation")
        yield* refused(
          f.fix.commit({
            ...fix,
            operation: { kind: "commit", message: "a\0b" },
            consent,
            policy: f.policy,
            actor: ACTOR,
            identity: IDENTITY,
          }),
          "operation",
        )
        // A stray file, then an edit to the fixed file.
        yield* write(fix.placement.worktree, "stray.txt", "x\n")
        yield* refused(
          commit(),
          "worktree",
          "The fix checkout holds other changes than the approved patch, such as files a check left. Cancel the fix and apply it again.",
        )
        yield* Effect.promise(() => fs.rm(path.join(fix.placement.worktree, "stray.txt")))
        yield* write(fix.placement.worktree, "src/a.ts", "edited\n")
        yield* refused(commit(), "postimage")
        // What a check could leave at the fixed path: a FIFO and a link are refused at once, never opened.
        yield* Effect.promise(() => fs.rm(target))
        expect(Bun.spawnSync(["mkfifo", target]).exitCode).toBe(0)
        const started = Date.now()
        yield* refused(commit(), "path")
        expect(Date.now() - started).toBeLessThan(10_000)
        yield* Effect.promise(() => fs.rm(target))
        yield* Effect.promise(() => fs.symlink("/dev/zero", target))
        yield* refused(commit(), "symlink")
        yield* Effect.promise(() => fs.rm(target))
        yield* Effect.promise(() => fs.mkdir(path.join(f.home.directory, "elsewhere"), { recursive: true }))
        yield* Effect.promise(() =>
          fs.rename(path.join(fix.placement.worktree, "src"), path.join(f.home.directory, "elsewhere", "src")),
        )
        yield* Effect.promise(() =>
          fs.symlink(path.join(f.home.directory, "elsewhere", "src"), path.join(fix.placement.worktree, "src")),
        )
        yield* write(path.join(f.home.directory, "elsewhere"), "src/a.ts", "two\n")
        yield* refused(commit(), "worktree")
        yield* Effect.promise(() => fs.rm(path.join(fix.placement.worktree, "src")))
        yield* Effect.promise(() =>
          fs.rename(path.join(f.home.directory, "elsewhere", "src"), path.join(fix.placement.worktree, "src")),
        )
        yield* write(fix.placement.worktree, "src/a.ts", "two\n")
        // The destination branch exists, then the reviewed branch moved.
        yield* git(f.directory, ["branch", "vector/fix-1", f.base])
        yield* refused(commit(), "destination")
        yield* git(f.directory, ["branch", "-D", "vector/fix-1"])
        yield* move(f.directory)
        yield* refused(commit(), "head")
        expect(f.policy.revoke(consent)).toEqual({ ok: true })
        expect(yield* f.fix.state(fix.fixID)).toBe("applied")
        expect(
          (yield* run(f.directory, ["rev-parse", "--verify", "--quiet", "refs/heads/vector/fix-1"])).exitCode,
        ).not.toBe(0)
        expect(yield* f.fix.cancel(fix.fixID)).toMatchObject({ removed: true })
      }),
    { git: true },
    60_000,
  )

  it.instance(
    "a push needs its own consent and sends only the commit, only to the approved local bare repository, as a new branch",
    () =>
      Effect.gen(function* () {
        const f = yield* steps()
        const remote = yield* f.bare()
        yield* git(f.directory, ["config", "push.followTags", "true"])
        yield* git(f.directory, ["tag", "-a", "v-fix", "-m", "tag", f.head])
        const fix = yield* f.committed()
        const operation = { kind: "push", remote: remote.url, commit: fix.made.commit, mode: "draft-pr" }
        const push = (consent: FixConsent, input: unknown = operation) =>
          f.fix.push({ ...fix, operation: input, consent, policy: f.policy, actor: ACTOR })
        const remoteRefs = () =>
          git(f.directory, ["--git-dir", remote.directory, "for-each-ref", "--format=%(refname) %(objectname)"])
        const before = yield* remoteRefs()
        // Another step's consent, and a consent for another remote.
        const commitConsent = yield* f.approveOp(fix.proposal, { kind: "commit", message: "fix: two\n" })
        yield* refused(push(commitConsent), "mismatch")
        const other = yield* f.approveOp(fix.proposal, { ...operation, remote: `file://${remote.directory}x` })
        yield* refused(push(other), "mismatch")
        yield* refused(push(yield* f.approveOp(fix.proposal, operation), { ...operation, commit: f.head }), "operation")
        // A remote Git would rewrite, the user's own repository, and remotes whose default or existing branch is the
        // destination: each refused before the consent is spent.
        const consent = yield* f.approveOp(fix.proposal, operation)
        // The decoy is a valid remote of its own, so only the rewrite check stands between it and the real one.
        const decoy = yield* f.bare()
        const alias = { ...operation, remote: decoy.url }
        yield* git(f.directory, ["config", `url.${remote.url}.insteadOf`, alias.remote])
        yield* refused(
          push(yield* f.approveOp(fix.proposal, alias), alias),
          "remote",
          "Git would push to another address than the approved remote (a url rewrite).",
        )
        yield* git(f.directory, ["config", "--unset", `url.${remote.url}.insteadOf`])
        yield* git(f.directory, ["config", `url.${remote.url}.pushInsteadOf`, alias.remote])
        yield* refused(
          push(yield* f.approveOp(fix.proposal, alias), alias),
          "remote",
          "Git would push to another address than the approved remote (a push rewrite).",
        )
        yield* git(f.directory, ["config", "--unset", `url.${remote.url}.pushInsteadOf`])
        // A rewrite whose url has a space in it, which a line split at its first space would not read.
        yield* git(f.directory, ["config", "url.file:///nowhere with space/.pushInsteadOf", alias.remote])
        yield* refused(
          push(yield* f.approveOp(fix.proposal, alias), alias),
          "remote",
          "Git would push to another address than the approved remote (a push rewrite).",
        )
        yield* git(f.directory, ["config", "--remove-section", "url.file:///nowhere with space/"])
        // A configured remote named like the address: Git would push to its pushurl instead.
        yield* git(f.directory, ["config", `remote.${alias.remote}.pushurl`, remote.url])
        yield* refused(
          push(yield* f.approveOp(fix.proposal, alias), alias),
          "remote",
          "A Git remote of this repository is named like the approved address, so Git could push elsewhere.",
        )
        yield* git(f.directory, ["config", "--remove-section", `remote.${alias.remote}`])
        const own = { ...operation, remote: `file://${path.join(f.directory, ".git")}` }
        yield* refused(push(yield* f.approveOp(fix.proposal, own), own), "remote")
        const plain = { ...operation, remote: `file://${f.home.directory}` }
        yield* refused(push(yield* f.approveOp(fix.proposal, plain), plain), "remote")
        const defaults = yield* f.bare()
        yield* git(f.directory, ["--git-dir", defaults.directory, "symbolic-ref", "HEAD", "refs/heads/vector/fix-1"])
        const named = { ...operation, remote: defaults.url }
        yield* refused(push(yield* f.approveOp(fix.proposal, named), named), "destination")
        const taken = yield* f.bare()
        yield* git(f.directory, ["push", "-q", taken.directory, `${f.base}:refs/heads/vector/fix-1`])
        const occupied = { ...operation, remote: taken.url }
        yield* refused(push(yield* f.approveOp(fix.proposal, occupied), occupied), "destination")
        expect(yield* git(f.directory, ["--git-dir", taken.directory, "rev-parse", "refs/heads/vector/fix-1"])).toBe(
          f.base,
        )
        // The local destination branch moved, then the reviewed branch.
        yield* git(f.directory, ["branch", "-f", "vector/fix-1", f.head])
        yield* refused(push(consent), "destination")
        yield* git(f.directory, ["branch", "-f", "vector/fix-1", fix.made.commit])
        yield* move(f.directory)
        yield* refused(push(consent), "head")
        yield* git(f.directory, ["reset", "-q", "--hard", f.head])
        expect(yield* remoteRefs()).toBe(before)
        expect(yield* f.fix.state(fix.fixID)).toBe("committed")

        // The remote's own receive hooks, which the push must not run: they would run with this process's environment.
        const hooked = path.join(f.home.directory, `remote-hook-${randomUUID()}`)
        for (const name of ["pre-receive", "update", "post-receive", "post-update", "reference-transaction"])
          yield* Effect.promise(() =>
            fs.writeFile(path.join(remote.directory, "hooks", name), `#!/bin/sh\ntouch "${hooked}"\ncat >/dev/null\n`, {
              mode: 0o755,
            }),
          )
        const pushed = yield* push(consent)
        expect(yield* exists(hooked)).toBe(false)
        expect(pushed).toEqual({
          fixID: fix.fixID,
          commit: fix.made.commit,
          remote: remote.url,
          ref: "refs/heads/vector/fix-1",
          mode: "draft-pr",
          actor: ACTOR,
          consumedAt: expect.any(Number),
        })
        const after = (yield* remoteRefs()).split("\n")
        expect(after.filter((line) => !before.split("\n").includes(line))).toEqual([
          `refs/heads/vector/fix-1 ${fix.made.commit}`,
        ])
        expect(yield* git(f.directory, ["--git-dir", remote.directory, "tag", "-l"])).toBe("")
        expect(yield* git(f.directory, ["--git-dir", remote.directory, "rev-parse", "main", "feature"])).toBe(
          [f.base, f.head].join("\n"),
        )
        expect(yield* f.fix.state(fix.fixID)).toBe("pushed")
        const listed = yield* f.fix.placements()
        expect(listed.map((item) => [item.state, item.push?.remote, item.push?.ref, item.push?.mode])).toEqual([
          ["pushed", remote.url, "refs/heads/vector/fix-1", "draft-pr"],
        ])
        yield* refused(push(yield* f.approveOp(fix.proposal, operation)), "state")
        for (const item of [commitConsent, other]) expect(f.policy.revoke(item)).toEqual({ ok: true })
        // The base branch can never be a destination: the proposal itself is refused.
        const placement = yield* f.fix.reserve({ head: f.head })
        const base = {
          ...f.proposalFor(placement, yield* patchFor(f.directory, f.head, { "src/a.ts": "two\n" }), [
            { path: "src/a.ts", before: "one\n", after: "two\n" },
          ]),
        }
        yield* refused(
          f.fix.preview({
            fixID: placement.fixID,
            proposal: { ...base, scope: { ...base.scope, destinationBranch: "main" } },
          }),
          "proposal",
        )
        expect(yield* f.fix.cancel(placement.fixID)).toMatchObject({ removed: true })
        // Cancel removes the placement; the local and the remote branch stay.
        expect(yield* f.fix.cancel(fix.fixID)).toEqual({ fixID: fix.fixID, removed: true })
        expect(yield* exists(fix.placement.worktree)).toBe(false)
        expect(yield* git(f.directory, ["rev-parse", "refs/heads/vector/fix-1"])).toBe(fix.made.commit)
        expect(yield* git(f.directory, ["--git-dir", remote.directory, "rev-parse", "refs/heads/vector/fix-1"])).toBe(
          fix.made.commit,
        )
      }),
    { git: true },
    90_000,
  )

  it.instance(
    "committed and pushed fix records stay invisible to every task path and are swept when their process is gone",
    () =>
      Effect.gen(function* () {
        const f = yield* steps()
        const remote = yield* f.bare()
        const fix = yield* f.committed()
        const registry = path.join(Global.Path.data, "task-isolation", f.home.project.id, ".fix", fix.fixID)
        const committed = JSON.parse(yield* read(registry, "fix.json"))
        expect(committed.state).toBe("committed")
        expect(() => Schema.decodeUnknownSync(TaskIsolation.Record)(committed)).toThrow()
        expect(yield* f.isolation.records()).toEqual([])
        expect(yield* f.isolation.find(fix.fixID)).toBeUndefined()
        yield* fails(f.isolation.start(fix.fixID))
        const operation = { kind: "push", remote: remote.url, commit: fix.made.commit, mode: "branch" }
        yield* f.fix.push({
          ...fix,
          operation,
          consent: yield* f.approveOp(fix.proposal, operation),
          policy: f.policy,
          actor: ACTOR,
        })
        const pushed = yield* read(registry, "fix.json")
        expect(JSON.parse(pushed)).toMatchObject({
          state: "pushed",
          commit: { sha: fix.made.commit },
          push: { remote: remote.url, mode: "branch" },
        })
        expect(() => Schema.decodeUnknownSync(TaskIsolation.Record)(JSON.parse(pushed))).toThrow()
        expect(yield* f.isolation.records()).toEqual([])
        yield* fails(f.isolation.get(fix.fixID))
        yield* fails(f.isolation.settle({ taskID: fix.fixID, attempt: 1 }))
        expect(TaskPlace.isTaskDirectory(fix.placement.worktree)).toBe(false)
        // An earlier process's pushed placement is removed by the sweep; its branches stay.
        BackgroundJobStore.close((yield* f.isolation.getFix(fix.fixID)).owner)
        TaskClaims.unprotect(fix.fixID)
        expect(yield* f.isolation.sweep({ force: true })).toEqual([])
        expect(yield* exists(fix.placement.worktree)).toBe(false)
        expect(yield* f.fix.placements()).toEqual([])
        expect(yield* git(f.directory, ["rev-parse", "refs/heads/vector/fix-1"])).toBe(fix.made.commit)
      }),
    { git: true },
    60_000,
  )
  ;(sandboxed ? it.instance.skip : it.instance)(
    "without a working sandbox, a consented check is refused as checks not run and nothing runs",
    () =>
      Effect.gen(function* () {
        const marker = `marker-${randomUUID()}`
        const f = yield* steps({
          [`test/${marker}.test.ts`]: `import { test } from "bun:test"\nimport fs from "node:fs"\ntest("m", () => fs.writeFileSync("${marker}", "ran"))\n`,
        })
        const fix = yield* f.applied()
        const operation = checksOp([{ argv: ["bun", "test", `test/${marker}.test.ts`] }])
        const consent = yield* f.approveOp(fix.proposal, operation)
        const exit = yield* Effect.exit(f.fix.checks({ ...fix, operation, consent, policy: f.policy, actor: ACTOR }))
        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isFailure(exit))
          expect(Cause.squash(exit.cause)).toMatchObject({
            reason: "sandbox",
            message: expect.stringMatching(/^Checks not run: /),
          })
        expect(yield* exists(path.join(fix.placement.worktree, marker))).toBe(false)
        expect(f.policy.revoke(consent)).toEqual({ ok: true })
        expect(yield* f.fix.cancel(fix.fixID)).toMatchObject({ removed: true })
      }),
    { git: true },
    60_000,
  )
})

describe.skipIf(!sandboxed)("review fix checks in the sandbox (VS-12b)", () => {
  it.instance(
    "a pinned diagnostic sees only redacted changes, never the host listener, key fixture, shell or project config",
    () =>
      Effect.gen(function* () {
        const { directory } = yield* InstanceState.context
        const fix = yield* ReviewFix.Service
        const host = yield* Effect.acquireRelease(
          Effect.sync(() => Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("fixture") })),
          (server) => Effect.promise(() => server.stop(true)),
        )
        const secret = "ghp_" + "adP8".repeat(9)
        // This fixture's own program is compiled from this literal, never from the repository under review.
        // Compilation is local; the resulting static executable is only ever run by the isolated SF-08 process owner.
        const source = String.raw`
        #include <arpa/inet.h>
        #include <fcntl.h>
        #include <stdio.h>
        #include <stdlib.h>
        #include <string.h>
        #include <sys/socket.h>
        #include <unistd.h>
        int main(int argc, char **argv) {
          if (argc != 4 || getenv("HOME") || getenv("PATH") || access(argv[1], R_OK) == 0 ||
              access(argv[2], R_OK) == 0 || access("/bin/sh", X_OK) == 0 ||
              access("/proc/self/environ", R_OK) == 0 || open("/input/change.json", O_WRONLY) >= 0) return 1;
          int sock = socket(AF_INET, SOCK_STREAM, 0);
          struct sockaddr_in addr = {.sin_family=AF_INET, .sin_port=htons(atoi(argv[3]))};
          inet_pton(AF_INET, "127.0.0.1", &addr.sin_addr);
          if (sock >= 0 && connect(sock,(struct sockaddr*)&addr,sizeof(addr)) == 0) return 2;
          FILE *input = fopen("/input/change.json", "r"); char bytes[2048] = {0};
          if (!input || !fread(bytes, 1, sizeof(bytes)-1, input) || !strstr(bytes, "[redacted]")) return 3;
          puts("isolated fixture"); return 0;
        }`
        const key = path.join(directory, "synthetic-private.txt")
        const config = path.join(directory, "fixture-tool.config")
        yield* Effect.promise(() =>
          Promise.all([fs.writeFile(key, "synthetic-key-fixture"), fs.writeFile(config, "never load this fixture")]),
        )
        const binary = path.join(directory, "pinned-fixture")
        const compiled = Bun.spawnSync(["/usr/bin/cc", "-static", "-O2", "-x", "c", "-", "-o", binary], {
          cwd: directory,
          env: { PATH: "/usr/bin:/bin" },
          stdin: Buffer.from(source),
          stdout: "pipe",
          stderr: "pipe",
        })
        expect(compiled.exitCode).toBe(0)
        const executable = yield* Effect.promise(() => fs.readFile(binary))
        const pin = {
          id: "test-fixture",
          version: "1.0.0",
          sha256: createHash("sha256").update(executable).digest("hex"),
          executable,
          argv: [key, config, String(host.port)],
        }
        const input = {
          adapter: pin.id,
          head: "a".repeat(40),
          files: parseUnifiedDiff(
            [
              "diff --git a/source.ts b/source.ts",
              "--- a/source.ts",
              "+++ b/source.ts",
              "@@ -1 +1 @@",
              "-const value = null",
              '+const value = "' + secret + '"',
            ].join("\n"),
          ),
        }
        const result = yield* fix.diagnostics.preview(input).pipe(Effect.provideService(DiagnosticCatalog, [pin]))
        if (result.status !== "ready") throw Error("fixture pin did not produce a preview")
        const consent = fix.diagnostics.approve(result.preview, ACTOR)!
        const ran = yield* fix.diagnostics.run({ preview: result.preview, actor: ACTOR, consent })
        expect(ran).toEqual({ status: "ran", adapter: pin.id, version: pin.version, output: "isolated fixture\n" })
        expect((yield* fix.diagnostics.run({ preview: result.preview, actor: ACTOR, consent })).status).toBe("not-run")
      }),
    { git: true },
    30000,
  )

  it.instance(
    "an unconsented check runs nothing",
    () =>
      Effect.gen(function* () {
        const marker = `marker-${randomUUID()}`
        const f = yield* steps({
          [`test/${marker}.test.ts`]: `import { test } from "bun:test"\nimport fs from "node:fs"\ntest("m", () => fs.writeFileSync("out-${marker}", "ran"))\n`,
        })
        const fix = yield* f.applied()
        const operation = checksOp([{ argv: ["bun", "test", `test/${marker}.test.ts`] }])
        const checks = (consent: FixConsent, policy = f.policy) =>
          f.fix.checks({ ...fix, operation, consent, policy, actor: ACTOR })
        yield* refused(checks(yield* f.approve(fix.proposal)), "mismatch")
        const elsewhere = createFixConsentPolicy(() => 1_000)
        const foreign = yield* Effect.promise(() => elsewhere.approve(fix.proposal, operation, ACTOR, 60_000))
        if (!foreign.ok) throw new Error(foreign.reason)
        yield* refused(checks(foreign.consent), "unknown")
        const revoked = yield* f.approveOp(fix.proposal, operation)
        expect(f.policy.revoke(revoked)).toEqual({ ok: true })
        yield* refused(checks(revoked), "revoked")
        const once = yield* f.approveOp(fix.proposal, operation)
        const first = yield* checks(once)
        expect(first.results.map((item) => item.exitCode)).toEqual([0])
        expect(yield* exists(path.join(fix.placement.worktree, `out-${marker}`))).toBe(true)
        // A file the check left (not ignored) is named, and blocks the commit until the fix is applied again.
        expect(first.leftovers).toEqual([`out-${marker}`])
        const commitOp = { kind: "commit", message: "fix: two\n" }
        yield* refused(
          f.fix.commit({
            ...fix,
            operation: commitOp,
            consent: yield* f.approveOp(fix.proposal, commitOp),
            policy: f.policy,
            actor: ACTOR,
            identity: IDENTITY,
          }),
          "worktree",
          "The fix checkout holds other changes than the approved patch, such as files a check left. Cancel the fix and apply it again.",
        )
        yield* Effect.promise(() => fs.rm(path.join(fix.placement.worktree, `out-${marker}`)))
        yield* refused(checks(once), "used")
        expect(yield* exists(path.join(fix.placement.worktree, `out-${marker}`))).toBe(false)
        expect(yield* f.fix.cancel(fix.fixID)).toMatchObject({ removed: true })
      }),
    { git: true },
    60_000,
  )

  it.instance(
    "a check sees only its clean environment and writes only inside the checkout",
    () =>
      Effect.gen(function* () {
        const token = randomUUID()
        // The CI network namespace can retain sudo's HOME after dropping privileges.
        const home = os.userInfo().homedir
        const hostPathExists = (file: string) =>
          Effect.promise(() =>
            fs.lstat(file).then(
              () => true,
              (error) => {
                if (error.code === "ENOENT") return false
                throw error
              },
            ),
          )
        const targets = [
          path.join(os.tmpdir(), `vector-fix-escape-${token}`),
          path.join(home, `vector-fix-escape-${token}`),
          ...((yield* hostPathExists(path.join(home, ".cache")))
            ? [path.join(home, ".cache", `vector-fix-escape-${token}`)]
            : []),
          path.join(Global.Path.data, `vector-fix-escape-${token}`),
        ]
        yield* Effect.addFinalizer(() =>
          Effect.promise(() => Promise.all(targets.map((target) => fs.rm(target, { force: true })))),
        )
        // Vector's data folder outside the checkout (other projects' checkouts, stores, logs) is hidden from a check.
        const planted = path.join(Global.Path.data, `vector-fix-planted-${token}`)
        yield* write(Global.Path.data, path.basename(planted), "planted\n")
        yield* Effect.addFinalizer(() => Effect.promise(() => fs.rm(planted, { force: true })))
        // A host permission failure would also look like the sandbox blocked the write.
        yield* Effect.promise(() =>
          Promise.all(targets.map((target) => fs.access(path.dirname(target), fs.constants.W_OK | fs.constants.X_OK))),
        )
        const f = yield* steps({
          "test/env.test.ts": [
            'import { test } from "bun:test"',
            'import fs from "node:fs"',
            `const allowed = new Set(${JSON.stringify(ALLOWED)})`,
            'test("env", () => {',
            `  try { console.log("DATA " + fs.readFileSync(${JSON.stringify(planted)}, "utf8").trim()) } catch { console.log("DATA hidden") }`,
            "  const keys = Object.keys(process.env)",
            '  console.log("ENV extra=" + keys.filter((key) => !allowed.has(key)).length + " secret=" + keys.filter((key) => /KEY|TOKEN|SECRET|PASSWORD/i.test(key)).length + " ci=" + process.env.CI + " canary=" + (process.env.FIX_CANARY_PROVIDER_KEY === undefined ? "absent" : "present"))',
            '  fs.mkdirSync("out", { recursive: true })',
            '  fs.writeFileSync("out/probe.txt", "written")',
            `  for (const target of [...${JSON.stringify(targets)}, process.env.HOME + "/home-${token}"]) {`,
            '    try { fs.writeFileSync(target, "escaped"); console.log("WROTE " + (target.startsWith("/tmp/") ? "tmp" : "host")) } catch { console.log("DENIED") }',
            "  }",
            "})",
            "",
          ].join("\n"),
        })
        // Something that must never reach a check, set in this process only for the run.
        const saved = process.env.FIX_CANARY_PROVIDER_KEY
        process.env.FIX_CANARY_PROVIDER_KEY = "canary"
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            if (saved === undefined) delete process.env.FIX_CANARY_PROVIDER_KEY
            else process.env.FIX_CANARY_PROVIDER_KEY = saved
          }),
        )
        const fix = yield* f.applied()
        const operation = checksOp([{ argv: ["bun", "test", "test/env.test.ts"] }])
        const checked = yield* f.fix.checks({
          ...fix,
          operation,
          consent: yield* f.approveOp(fix.proposal, operation),
          policy: f.policy,
          actor: ACTOR,
        })
        const output = checked.results[0]?.output ?? ""
        expect(checked.results.map((item) => item.exitCode)).toEqual([0])
        expect(output).toContain("ENV extra=0 secret=0 ci=1 canary=absent")
        expect(output).toContain("DATA hidden")
        expect(output).not.toContain("DATA planted")
        expect(output).not.toContain("WROTE host")
        expect(yield* read(fix.placement.worktree, "out/probe.txt")).toBe("written")
        for (const target of targets) expect(yield* hostPathExists(target)).toBe(false)
        expect(yield* hostPathExists(path.join(os.tmpdir(), `home-${token}`))).toBe(false)
        // An ignored output leaves the checkout holding exactly the patch.
        expect(yield* f.fix.state(fix.fixID)).toBe("applied")
        expect(checked).toMatchObject({ passed: true, actor: ACTOR, operation: expect.stringMatching(/^sha256:/) })
        // The record keeps the run but never its output.
        const record = yield* read(
          path.join(Global.Path.data, "task-isolation", f.home.project.id, ".fix", fix.fixID),
          "fix.json",
        )
        expect(JSON.parse(record).checks).toEqual([
          {
            operation: checked.operation,
            at: checked.consumedAt,
            results: [
              {
                argv: ["bun", "test", "test/env.test.ts"],
                cwd: ".",
                exitCode: 0,
                timedOut: false,
                truncated: false,
                durationMs: expect.any(Number),
              },
            ],
          },
        ])
        expect(record).not.toContain("ENV extra")
        expect(yield* f.fix.cancel(fix.fixID)).toMatchObject({ removed: true })
      }),
    { git: true },
    60_000,
  )

  it.instance(
    "the network is off: neither this computer's TCP servers nor its sockets in hidden folders are reachable",
    () =>
      Effect.gen(function* () {
        const hits = { count: 0 }
        const server = Bun.serve({
          hostname: "127.0.0.1",
          port: 0,
          fetch: () => {
            hits.count++
            return new Response("reached")
          },
        })
        yield* Effect.addFinalizer(() => Effect.promise(() => server.stop(true)))
        const net = yield* Effect.promise(() => import("node:net"))
        const folders = [os.tmpdir(), `/run/user/${process.getuid?.() ?? 0}`, "/run"]
        const writable = yield* Effect.forEach(folders, (folder) =>
          Effect.promise(() =>
            fs.access(folder, fs.constants.W_OK).then(
              () => [folder],
              () => [],
            ),
          ),
        )
        const sockets = writable.flat().map((folder) => path.join(folder, `vector-fix-${randomUUID()}.sock`))
        for (const file of sockets) {
          const listener = net.createServer((socket) => {
            hits.count++
            socket.destroy()
          })
          yield* Effect.promise(() => new Promise<void>((resolve) => listener.listen(file, () => resolve())))
          yield* Effect.addFinalizer(() =>
            Effect.promise(() => new Promise<void>((resolve) => listener.close(() => resolve()))).pipe(
              Effect.andThen(Effect.promise(() => fs.rm(file, { force: true }))),
            ),
          )
        }
        const f = yield* steps({
          "test/net.test.ts": [
            'import { test } from "bun:test"',
            'import net from "node:net"',
            "const attempt = (connect: () => net.Socket) => new Promise<string>((resolve) => {",
            "  const socket = connect()",
            "  const done = (value: string) => { socket.destroy(); resolve(value) }",
            '  socket.once("connect", () => done("reached"))',
            '  socket.once("error", () => done("blocked"))',
            '  setTimeout(() => done("blocked"), 3000)',
            "})",
            'test("network", async () => {',
            `  console.log("NETWORK " + await attempt(() => net.createConnection({ host: "127.0.0.1", port: ${server.port} })))`,
            `  for (const file of ${JSON.stringify(sockets)}) console.log("SOCKET " + await attempt(() => net.createConnection(file)))`,
            "}, 30000)",
            "",
          ].join("\n"),
        })
        const fix = yield* f.applied()
        const operation = checksOp([{ argv: ["bun", "test", "test/net.test.ts"] }])
        const checked = yield* f.fix.checks({
          ...fix,
          operation,
          consent: yield* f.approveOp(fix.proposal, operation),
          policy: f.policy,
          actor: ACTOR,
        })
        const output = checked.results[0]?.output ?? ""
        expect(checked.results.map((item) => item.exitCode)).toEqual([0])
        expect(output).toContain("NETWORK blocked")
        expect(output.match(/SOCKET blocked/g)?.length).toBe(sockets.length)
        expect(output).not.toContain("reached")
        expect(hits.count).toBe(0)
        expect(yield* f.fix.cancel(fix.fixID)).toMatchObject({ removed: true })
      }),
    { git: true },
    60_000,
  )

  it.instance(
    "output is capped and a command over its time is stopped, with nothing of it left running",
    () =>
      Effect.gen(function* () {
        const token = randomUUID()
        const f = yield* steps({
          "test/loud.test.ts":
            'import { test } from "bun:test"\ntest("loud", () => { process.stdout.write("x".repeat(300_000)) })\n',
          [`test/slow-${token}.test.ts`]: `import { test } from "bun:test"\nconsole.log("SLOW started")\ntest("slow", async () => { await Bun.sleep(600_000) }, 1_000_000)\n`,
        })
        const fix = yield* f.applied()
        const operation = checksOp(
          [{ argv: ["bun", "test", "test/loud.test.ts"] }, { argv: ["bun", "test", `test/slow-${token}.test.ts`] }],
          { timeoutMs: 8_000, outputBytes: 4_096 },
        )
        const checked = yield* f.fix.checks({
          ...fix,
          operation,
          consent: yield* f.approveOp(fix.proposal, operation),
          policy: f.policy,
          actor: ACTOR,
        })
        const loud = checked.results[0]
        const slow = checked.results[1]
        expect(loud).toMatchObject({ exitCode: 0, timedOut: false, truncated: true })
        expect(Buffer.byteLength(loud.output)).toBeLessThanOrEqual(4_096)
        expect(slow).toMatchObject({ exitCode: null, timedOut: true })
        expect(slow.output).toContain("SLOW started")
        expect(slow.durationMs).toBeGreaterThanOrEqual(8_000)
        expect(slow.durationMs).toBeLessThan(8_000 + 3_000 + 10_000)
        expect(checked.passed).toBe(false)
        expect(yield* settles(token)).toBe(true)
        expect(yield* f.fix.cancel(fix.fixID)).toMatchObject({ removed: true })
      }),
    { git: true },
    90_000,
  )

  it.instance(
    "a failing check authorizes nothing, and a head that moves between commands stops the run",
    () =>
      Effect.gen(function* () {
        const f = yield* steps({
          "test/fail.test.ts": 'import { test } from "bun:test"\ntest("fail", () => { throw new Error("fails") })\n',
          "test/pass.test.ts": 'import { test } from "bun:test"\ntest("pass", () => {})\n',
        })
        const fix = yield* f.applied()
        const failing = checksOp([{ argv: ["bun", "test", "test/fail.test.ts"] }])
        const consent = yield* f.approveOp(fix.proposal, failing)
        const checked = yield* f.fix.checks({ ...fix, operation: failing, consent, policy: f.policy, actor: ACTOR })
        expect(checked.results.map((item) => item.exitCode)).toEqual([1])
        expect(checked.passed).toBe(false)
        expect(yield* f.fix.state(fix.fixID)).toBe("applied")
        expect(yield* changedIn(fix.placement.worktree)).toEqual(["src/a.ts"])
        // Its consent does not commit.
        yield* refused(
          f.fix.commit({
            ...fix,
            operation: { kind: "commit", message: "x\n" },
            consent,
            policy: f.policy,
            actor: ACTOR,
            identity: IDENTITY,
          }),
          "used",
        )
        const both = checksOp([
          { argv: ["bun", "test", "test/pass.test.ts"] },
          { argv: ["bun", "test", "test/fail.test.ts"] },
        ])
        const service = yield* Git.Service
        const moved = yield* f.fix.checks({
          ...fix,
          operation: both,
          consent: yield* f.approveOp(fix.proposal, both),
          policy: f.policy,
          actor: ACTOR,
          observe: (event) =>
            event.type === "finished" && event.index === 0
              ? move(f.directory).pipe(Effect.provideService(Git.Service, service), Effect.asVoid)
              : Effect.void,
        })
        expect(moved.results.length).toBe(1)
        expect(moved.aborted).toBe("head")
        expect(moved.passed).toBe(false)
        const operation = { kind: "commit", message: "x\n" }
        yield* refused(
          f.fix.commit({
            ...fix,
            operation,
            consent: yield* f.approveOp(fix.proposal, operation),
            policy: f.policy,
            actor: ACTOR,
            identity: IDENTITY,
          }),
          "head",
        )
        const recorded = JSON.parse(
          yield* read(path.join(Global.Path.data, "task-isolation", f.home.project.id, ".fix", fix.fixID), "fix.json"),
        )
        expect(
          recorded.checks.map((item: { aborted?: string; results: unknown[] }) => [item.results.length, item.aborted]),
        ).toEqual([
          [1, undefined],
          [1, "head"],
        ])
        expect(yield* f.fix.cancel(fix.fixID)).toMatchObject({ removed: true })
      }),
    { git: true },
    60_000,
  )

  it.instance(
    "cancel stops a running check and removes the checkout; an interrupt stops it and keeps the fix applied",
    () =>
      Effect.gen(function* () {
        const token = randomUUID()
        const f = yield* steps({
          [`test/slow-${token}.test.ts`]: `import { test } from "bun:test"\ntest("slow", async () => { await Bun.sleep(600_000) }, 1_000_000)\n`,
        })
        const operation = checksOp([{ argv: ["bun", "test", `test/slow-${token}.test.ts`] }], {
          timeoutMs: 120_000,
          outputBytes: 4_096,
        })
        const fix = yield* f.applied()
        const consent = yield* f.approveOp(fix.proposal, operation)
        const fiber = yield* f.fix
          .checks({ ...fix, operation, consent, policy: f.policy, actor: ACTOR })
          .pipe(Effect.forkScoped({ startImmediately: true }))
        expect(yield* starts(token)).toBe(true)
        const started = Date.now()
        expect(yield* f.fix.cancel(fix.fixID)).toEqual({ fixID: fix.fixID, removed: true })
        expect(Date.now() - started).toBeLessThan(20_000)
        const exit = yield* Fiber.await(fiber)
        expect(Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)).toBe(true)
        expect(yield* settles(token)).toBe(true)
        expect(yield* exists(fix.placement.worktree)).toBe(false)
        expect(f.policy.revoke(consent)).toEqual({ ok: false, reason: "used" })

        const again = yield* f.applied()
        const second = yield* f.fix
          .checks({
            ...again,
            operation,
            consent: yield* f.approveOp(again.proposal, operation),
            policy: f.policy,
            actor: ACTOR,
          })
          .pipe(Effect.forkScoped({ startImmediately: true }))
        expect(yield* starts(token)).toBe(true)
        yield* Fiber.interrupt(second)
        expect(yield* settles(token)).toBe(true)
        expect(yield* f.fix.state(again.fixID)).toBe("applied")
        const listed = yield* f.fix.placements()
        expect(listed.map((item) => item.checks?.map((run) => run.aborted))).toEqual([["cancelled"]])
        expect(yield* f.fix.cancel(again.fixID)).toEqual({ fixID: again.fixID, removed: true })
      }),
    { git: true },
    90_000,
  )

  it.instance(
    "an interrupt while bubblewrap is still starting leaves nothing of the sandbox running",
    () =>
      Effect.gen(function* () {
        const token = randomUUID()
        const f = yield* steps({
          [`test/slow-${token}.test.ts`]: `import { test } from "bun:test"\ntest("slow", async () => { await Bun.sleep(600_000) }, 1_000_000)\n`,
        })
        const operation = checksOp([{ argv: ["bun", "test", `test/slow-${token}.test.ts`] }], {
          timeoutMs: 120_000,
          outputBytes: 4_096,
        })
        const fix = yield* f.applied()
        const rounds = 8
        for (const _ of Array.from({ length: rounds })) {
          const fiber = yield* f.fix
            .checks({
              ...fix,
              operation,
              consent: yield* f.approveOp(fix.proposal, operation),
              policy: f.policy,
              actor: ACTOR,
            })
            .pipe(Effect.forkScoped({ startImmediately: true }))
          // The first sight of the outer bwrap, usually before its namespace init has tied its life to bwrap's.
          const seen = yield* appears(token)
          yield* Fiber.interrupt(fiber)
          const outer = seen.find((item) => item.parent === process.pid)
          expect(outer).toBeDefined()
          // bwrap leads a session of its own with no terminal, and every process of the sandbox is in its group.
          expect(outer).toMatchObject({ session: outer?.pid, group: outer?.pid, terminal: 0 })
          for (const item of seen) expect(item.group).toBe(outer?.pid ?? -1)
          expect(yield* settles(token)).toBe(true)
        }
        expect(yield* f.fix.state(fix.fixID)).toBe("applied")
        const listed = yield* f.fix.placements()
        expect(listed.flatMap((item) => item.checks?.map((run) => run.aborted) ?? [])).toEqual(
          Array.from({ length: rounds }, () => "cancelled"),
        )
        expect(yield* f.fix.cancel(fix.fixID)).toEqual({ fixID: fix.fixID, removed: true })
      }),
    { git: true },
    120_000,
  )
})

// verify.yml's air-gap job sets this where the sandbox must work, so the cases above cannot all skip unnoticed there.
;(process.env.VECTOR_FIX_SANDBOX_CI === "1" ? it.instance : it.instance.skip)(
  "this run requires a working sandbox",
  () =>
    Effect.sync(() => {
      expect(sandboxed).toBe(true)
    }),
)

// Runs on the Windows legs of CI only: test.yml has no macOS engine leg.
;(linux ? it.instance.skip : it.instance)(
  "other platforms refuse as unavailable before any effect",
  () =>
    Effect.gen(function* () {
      const home = yield* InstanceState.context
      const fix = yield* ReviewFix.Service
      const head = yield* git(home.directory, ["rev-parse", "HEAD"])
      const policy = createFixConsentPolicy(() => 1_000)
      const proposal = {
        version: 1,
        scope: {
          kind: "local",
          repository: "/repository",
          worktree: "/fix",
          sourceBranch: "feature",
          baseBranch: "main",
          destinationBranch: "vector/fix-1",
        },
        base: head,
        head,
        findings: ["finding-1"],
        files: [{ path: "a.ts", preimage: null, postimage: digest("x\n") }],
        patch: "diff --git a/a.ts b/a.ts\nnew file mode 100644\n--- /dev/null\n+++ b/a.ts\n@@ -0,0 +1 @@\n+x\n",
      }
      const approved = yield* Effect.promise(() => policy.approve(proposal, { kind: "apply" }, ACTOR, 60_000))
      if (!approved.ok) throw new Error(approved.reason)
      yield* refused(fix.reserve({ head }), "unavailable")
      yield* refused(fix.preview({ fixID: "fix_x", proposal }), "unavailable")
      yield* refused(
        fix.apply({ fixID: "fix_x", proposal, consent: approved.consent, policy, actor: ACTOR }),
        "unavailable",
      )
      const operation = {
        kind: "checks",
        commands: [{ argv: ["bun", "test"], cwd: "." }],
        network: "off",
        timeoutMs: 1_000,
        outputBytes: 1_000,
      }
      yield* refused(
        fix.checks({ fixID: "fix_x", proposal, operation, consent: approved.consent, policy, actor: ACTOR }),
        "unavailable",
      )
      yield* refused(
        fix.commit({
          fixID: "fix_x",
          proposal,
          operation: { kind: "commit", message: "x\n" },
          consent: approved.consent,
          policy,
          actor: ACTOR,
          identity: { name: "Vector", email: "bot@vectordev.ai" },
        }),
        "unavailable",
      )
      yield* refused(
        fix.push({
          fixID: "fix_x",
          proposal,
          operation: { kind: "push", remote: "file:///remote.git", commit: head, mode: "branch" },
          consent: approved.consent,
          policy,
          actor: ACTOR,
        }),
        "unavailable",
      )
      yield* refused(fix.cancel("fix_x"), "unavailable")
      yield* refused(fix.state("fix_x"), "unavailable")
      yield* refused(fix.placements(), "unavailable")
      expect(yield* exists(path.join(Global.Path.data, "task-isolation", home.project.id, ".fix"))).toBe(false)
      expect(yield* exists(path.join(Global.Path.data, "task-worktree", home.project.id, ".fix"))).toBe(false)
      expect(policy.revoke(approved.consent)).toEqual({ ok: true })
    }),
  { git: true },
)
