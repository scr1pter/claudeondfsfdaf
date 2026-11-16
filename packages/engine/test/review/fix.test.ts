import { afterEach, describe, expect } from "bun:test"
import { createHash, randomUUID } from "node:crypto"
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
      yield* refused(fix.cancel("fix_x"), "unavailable")
      yield* refused(fix.state("fix_x"), "unavailable")
      yield* refused(fix.placements(), "unavailable")
      expect(yield* exists(path.join(Global.Path.data, "task-isolation", home.project.id, ".fix"))).toBe(false)
      expect(yield* exists(path.join(Global.Path.data, "task-worktree", home.project.id, ".fix"))).toBe(false)
      expect(policy.revoke(approved.consent)).toEqual({ ok: true })
    }),
  { git: true },
)
