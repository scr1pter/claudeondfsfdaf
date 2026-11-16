import { afterEach, describe, expect } from "bun:test"
import { createHash } from "node:crypto"
import { mkdirSync, readdirSync, writeFileSync } from "node:fs"
import { lstat, readFile, rm, symlink, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Cause, Context, Effect, Exit, Layer } from "effect"
import { GIT_HARDENING, fetchRef, runnerGitEnvironment } from "@vectordevai/core/everywhere/git"
import { branchFor } from "@vectordevai/core/everywhere/publish"
import { LayerNode } from "@vectordevai/core/effect/layer-node"
import { FSUtil } from "@vectordevai/core/fs-util"
import { Global } from "@vectordevai/core/global"
import { AppProcess } from "@vectordevai/core/process"
import { createJobId } from "@vectordevai/schema/everywhere"
import { GlobalBus } from "../../src/bus/global"
import { InstanceState } from "../../src/effect/instance-state"
import { Git } from "../../src/git"
import { InstanceBootstrap } from "../../src/project/bootstrap"
import { InstanceStore } from "../../src/project/instance-store"
import { Project } from "../../src/project/project"
import { FileLock } from "../../src/tool/file-lock"
import { Worktree } from "../../src/worktree"
import { disposeAllInstances, provideInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

// EV-12: Vector everywhere's unattended checkout, against real git in a disposable repository that has a start script
// and committed hooks (as husky leaves them) which each write a marker. The process boundary is observed, not replaced.

interface Call {
  readonly command: string
  readonly args: readonly string[]
  readonly cwd?: string
  readonly env?: Record<string, string | undefined>
  readonly extendEnv?: boolean
  readonly marked: boolean
}
class Recorder extends Context.Service<
  Recorder,
  { readonly calls: Call[]; readonly before: ((call: Call) => void)[] }
>()("EverywhereWorktreeTest.Recorder") {}
// Set only around createUnattended, so its own commands are told apart from the instance's background git without
// assuming anything about the commands themselves.
const Marked = Context.Reference<boolean>("EverywhereWorktreeTest.Marked", { defaultValue: () => false })

const recorderLayer = Layer.sync(Recorder, () => ({ calls: [], before: [] }))
const recorderNode = LayerNode.make({ service: Recorder, layer: recorderLayer, deps: [] })
const observedProcess = Layer.effect(
  AppProcess.Service,
  Effect.gen(function* () {
    const original = yield* AppProcess.Service
    const recorder = yield* Recorder
    return AppProcess.Service.of({
      ...original,
      run: (command, options) =>
        Effect.gen(function* () {
          if (command._tag === "StandardCommand") {
            const call = {
              command: command.command,
              args: command.args,
              cwd: command.options.cwd,
              env: command.options.env,
              extendEnv: command.options.extendEnv,
              marked: yield* Marked,
            }
            recorder.calls.push(call)
            recorder.before.forEach((hook) => hook(call))
          }
          return yield* original.run(command, options)
        }),
    })
  }),
).pipe(Layer.provide(Layer.merge(recorderLayer, LayerNode.compile(AppProcess.node))))
const layer = LayerNode.compile(
  LayerNode.group([Worktree.node, FSUtil.node, Git.node, Project.node, InstanceStore.node, recorderNode]),
  [
    [InstanceStore.bootstrapNode, InstanceBootstrap.node],
    [AppProcess.node, observedProcess],
  ],
)
const it = testEffect(layer)

const sha256 = (file: string) => readFile(file).then((bytes) => createHash("sha256").update(bytes).digest("hex"))
const present = (file: string) =>
  lstat(file).then(
    () => true,
    () => false,
  )

// The fixture's own git runs with hooks off, so only the positive controls fire them.
const git = Effect.fn("EverywhereWorktreeTest.git")(function* (cwd: string, args: string[]) {
  const service = yield* Git.Service
  const result = yield* service.run(["-c", `core.hooksPath=${os.devNull}`, ...args], { cwd })
  if (result.exitCode !== 0) throw new Error(result.stderr.toString("utf8"))
  return result.text().trim()
})

const fixture = Effect.fn("EverywhereWorktreeTest.fixture")(function* () {
  const ctx = yield* InstanceState.context
  const fs = yield* FSUtil.Service
  const project = yield* Project.Service
  const markers = `${ctx.directory}-markers`
  const root = path.join(Global.Path.data, "everywhere-worktree", ctx.project.id)
  yield* Effect.addFinalizer(() =>
    Effect.promise(async () => {
      await rm(root, { recursive: true, force: true })
      await rm(markers, { recursive: true, force: true })
    }),
  )
  yield* fs.makeDirectory(markers, { recursive: true }).pipe(Effect.orDie)
  const hook = path.join(markers, "hook")
  const start = path.join(markers, "start")
  yield* git(ctx.directory, ["config", "core.autocrlf", "false"])
  // Each hook appends its name to the marker; Git for Windows' sh reads the path with forward slashes.
  for (const name of ["reference-transaction", "post-checkout", "post-index-change"])
    yield* fs
      .writeWithDirs(
        path.join(ctx.directory, ".husky", name),
        `#!/bin/sh\necho "$0 $PWD" >> '${hook.replaceAll("\\", "/")}'\n`,
        0o755,
      )
      .pipe(Effect.orDie)
  yield* fs.writeWithDirs(path.join(ctx.directory, "a.txt"), "base\n").pipe(Effect.orDie)
  yield* git(ctx.directory, ["add", "."])
  yield* git(ctx.directory, ["commit", "-m", "base"])
  const base = yield* git(ctx.directory, ["rev-parse", "HEAD"])
  yield* fs.writeWithDirs(path.join(ctx.directory, "a.txt"), "head\n").pipe(Effect.orDie)
  yield* git(ctx.directory, ["commit", "-am", "head"])
  const head = yield* git(ctx.directory, ["rev-parse", "HEAD"])
  // As husky's prepare script leaves a repository, and a project start script that would publish a marker.
  yield* git(ctx.directory, ["config", "core.hooksPath", ".husky"])
  yield* project
    .update({ projectID: ctx.project.id, commands: { start: `echo start>> "${start}"` } })
    .pipe(Effect.orDie)
  return { ctx, markers, root, hook, start, base, head }
})

// A job whose base the runner fetched: refs/vector-everywhere/<jid> names `fetched`, by default the base itself.
const job = Effect.fn("EverywhereWorktreeTest.job")(function* (base: string, fetched: string | undefined = base) {
  const ctx = yield* InstanceState.context
  const jid = createJobId(Date.now())
  if (fetched) yield* git(ctx.directory, ["update-ref", fetchRef(jid), fetched])
  return { directory: ctx.directory, jid, branch: branchFor(jid), base }
})

const create = (input: Worktree.UnattendedInput) =>
  Worktree.Service.use((service) => service.createUnattended(input)).pipe(Effect.provideService(Marked, true))

const refusal = Effect.fn("EverywhereWorktreeTest.refusal")(function* (input: Worktree.UnattendedInput) {
  const exit = yield* Effect.exit(create(input))
  if (Exit.isSuccess(exit)) throw new Error(`created ${exit.value.directory}`)
  const error = Cause.squash(exit.cause)
  expect(error).toBeInstanceOf(Worktree.CreateFailedError)
  return error instanceof Error ? error.message : String(error)
})

// Neither the job's branch nor its folder exists.
const untouched = Effect.fn("EverywhereWorktreeTest.untouched")(function* (input: Worktree.UnattendedInput) {
  const ctx = yield* InstanceState.context
  const service = yield* Git.Service
  const ref = yield* service.run(["show-ref", "--verify", "--quiet", `refs/heads/${input.branch}`], {
    cwd: ctx.directory,
  })
  expect(ref.exitCode).toBe(1)
  expect(
    yield* Effect.promise(() => present(path.join(Global.Path.data, "everywhere-worktree", ctx.project.id, input.jid))),
  ).toBe(false)
})

const INVALID = "Invalid unattended worktree request."
const OWN = "An unattended worktree starts only from the loaded project's own checkout."
const UNSAFE = "The repository's git configuration can run programs. No unattended worktree was created."
const BASE = "The base is not this job's fetched commit."
const RESERVED = "This job's branch or folder is already reserved."
const FAILED = "The unattended worktree could not be created. Its reservation is kept, so this job id is not reused."

describe("Worktree.createUnattended", () => {
  afterEach(() => disposeAllInstances())

  it.instance(
    "creates the job's branch at the exact base and registers its sandbox, running no hook, start script or other program",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture()
        const recorder = yield* Recorder
        const project = yield* Project.Service
        const store = yield* InstanceStore.Service
        const service = yield* Git.Service
        const input = yield* job(f.base)
        // Positive control: plain git in this repository fires its hooks.
        yield* service.run(["branch", "vector/control"], { cwd: f.ctx.directory })
        expect(yield* Effect.promise(() => present(f.hook))).toBe(true)
        yield* git(f.ctx.directory, ["branch", "-D", "vector/control"])
        yield* Effect.promise(() => rm(f.hook))
        const config = yield* Effect.promise(() => sha256(path.join(f.ctx.directory, ".git", "config")))
        const loaded = (yield* store.loaded()).map((value) => value.directory)
        const events: string[] = []
        const on = (event: { payload: { type: string } }) => events.push(event.payload.type)
        GlobalBus.on("event", on)
        yield* Effect.addFinalizer(() => Effect.sync(() => GlobalBus.off("event", on)))
        recorder.calls.length = 0

        const result = yield* create(input)
        const during = [...recorder.calls]

        const directory = FSUtil.realpath(path.join(f.root, input.jid))
        expect(result).toEqual({ directory, branch: input.branch, base: input.base })
        expect(result.base).toBe(f.base)
        expect(yield* Effect.promise(() => readFile(path.join(directory, "a.txt"), "utf8"))).toBe("base\n")
        expect(yield* git(directory, ["rev-parse", "HEAD"])).toBe(f.base)
        expect(yield* git(directory, ["symbolic-ref", "--short", "HEAD"])).toBe(input.branch)
        expect(yield* Effect.promise(() => present(f.hook))).toBe(false)
        expect(yield* Effect.promise(() => present(f.start))).toBe(false)
        expect(yield* Effect.promise(() => sha256(path.join(f.ctx.directory, ".git", "config")))).toBe(config)
        expect((yield* project.sandboxes(f.ctx.project.id)).map((item) => FileLock.key(item))).toContain(
          FileLock.key(directory),
        )
        expect((yield* store.loaded()).map((value) => value.directory)).toEqual(loaded)
        expect(events).not.toContain(Worktree.Event.Ready.type)
        expect(events).not.toContain(Worktree.Event.Failed.type)

        const own = during.filter((call) => call.marked)
        expect(own.some((call) => call.args.includes("worktree") && call.args.includes("add"))).toBe(true)
        expect(own.some((call) => call.args.includes("reset"))).toBe(true)
        const keys = [...Object.keys(runnerGitEnvironment()), "GIT_NO_LAZY_FETCH"].sort()
        for (const call of own) {
          expect(["git", "git.exe", "git.com"]).toContain(path.basename(call.command).toLowerCase())
          expect(call.args.slice(0, GIT_HARDENING.length)).toEqual([...GIT_HARDENING])
          expect(call.args).toContain(`core.hooksPath=${os.devNull}`)
          expect(call.args).toContain("protocol.allow=never")
          // A per-protocol setting beats protocol.allow, so each is pinned too.
          for (const name of ["ext", "file", "git", "http", "https", "ssh"])
            expect(call.args).toContain(`protocol.${name}.allow=never`)
          expect(call.extendEnv).toBe(false)
          expect(Object.keys(call.env ?? {}).sort()).toEqual(keys)
          expect(call.env).toMatchObject({
            GIT_CONFIG_NOSYSTEM: "1",
            GIT_CONFIG_GLOBAL: os.devNull,
            GIT_NO_LAZY_FETCH: "1",
          })
        }
        // Nothing else ran in the new checkout while it was made.
        expect(during.filter((call) => !call.marked && call.cwd && FSUtil.contains(directory, call.cwd))).toEqual([])

        // Jira keys keep their case in the branch (contract 3.5 step 4).
        const jira = yield* job(f.base)
        const branch = branchFor(jira.jid, { key: "ABC-12", platform: "jira" })
        expect((yield* create({ ...jira, branch })).branch).toBe(branch)
      }),
    { git: true },
  )

  it.instance(
    "refuses an existing branch, folder or link, and a folder reserved after the check, before creating anything",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture()
        const recorder = yield* Recorder
        const outside = path.join(f.markers, "outside")
        yield* Effect.promise(() => writeFile(path.join(f.markers, "keep.txt"), "untouched"))

        // The project's folder for jobs is a link out of Vector's data folder.
        const linked = yield* job(f.base)
        yield* FSUtil.Service.use((fs) => fs.makeDirectory(outside, { recursive: true })).pipe(Effect.orDie)
        yield* FSUtil.Service.use((fs) => fs.makeDirectory(path.dirname(f.root), { recursive: true })).pipe(
          Effect.orDie,
        )
        yield* Effect.promise(() => symlink(outside, f.root, process.platform === "win32" ? "junction" : "dir"))
        expect(yield* refusal(linked)).toBe(RESERVED)
        expect(readdirSync(outside)).toEqual([])
        yield* untouched(linked)
        yield* Effect.promise(() => rm(f.root, { recursive: true, force: true }))

        // The branch exists.
        const branched = yield* job(f.base)
        yield* git(f.ctx.directory, ["branch", branched.branch, f.base])
        expect(yield* refusal(branched)).toBe(RESERVED)
        expect(yield* Effect.promise(() => present(path.join(f.root, branched.jid)))).toBe(false)

        // An empty folder is already there.
        const folder = yield* job(f.base)
        yield* FSUtil.Service.use((fs) => fs.makeDirectory(path.join(f.root, folder.jid), { recursive: true })).pipe(
          Effect.orDie,
        )
        expect(yield* refusal(folder)).toBe(RESERVED)
        expect(readdirSync(path.join(f.root, folder.jid))).toEqual([])
        expect(
          (yield* Git.Service.use((service) =>
            service.run(["show-ref", "--verify", "--quiet", `refs/heads/${folder.branch}`], { cwd: f.ctx.directory }),
          )).exitCode,
        ).toBe(1)

        // A link is there, pointing out of the data folder.
        const link = yield* job(f.base)
        yield* Effect.promise(() =>
          symlink(f.markers, path.join(f.root, link.jid), process.platform === "win32" ? "junction" : "dir"),
        )
        expect(yield* refusal(link)).toBe(RESERVED)
        expect(yield* Effect.promise(() => readFile(path.join(f.markers, "keep.txt"), "utf8"))).toBe("untouched")
        expect(
          (yield* Git.Service.use((service) =>
            service.run(["show-ref", "--verify", "--quiet", `refs/heads/${link.branch}`], { cwd: f.ctx.directory }),
          )).exitCode,
        ).toBe(1)

        // Another process reserves the folder between the absence check and the exclusive mkdir.
        const raced = yield* job(f.base)
        const racedFolder = path.join(f.root, raced.jid)
        recorder.before.push((call) => {
          if (call.marked && call.args.includes(`refs/heads/${raced.branch}`))
            mkdirSync(racedFolder, { recursive: true })
        })
        recorder.calls.length = 0
        expect(yield* refusal(raced)).toBe(RESERVED)
        recorder.before.length = 0
        expect(readdirSync(racedFolder)).toEqual([])
        expect(recorder.calls.some((call) => call.marked && call.args.includes("worktree"))).toBe(false)

        // A second jid with the same last twelve characters names the same branch: the first job's is reserved.
        const first = yield* job(f.base)
        yield* create(first)
        const jid = `${first.jid.slice(0, 4)}0000000000${first.jid.slice(-12)}`
        yield* git(f.ctx.directory, ["update-ref", fetchRef(jid), f.base])
        const twin = { directory: f.ctx.directory, jid, branch: branchFor(jid), base: f.base }
        expect(twin.branch).toBe(first.branch)
        expect(yield* refusal(twin)).toBe(RESERVED)
        expect(yield* Effect.promise(() => present(path.join(f.root, jid)))).toBe(false)
      }),
    { git: true },
  )

  it.instance(
    "refuses a base that is unknown, moved, not a commit or not this job's fetched commit",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture()
        const unknown = "0123456789abcdef0123456789abcdef01234567"
        yield* git(f.ctx.directory, ["tag", "-a", "-m", "annotated", "annotated", f.base])
        const tag = yield* git(f.ctx.directory, ["rev-parse", "annotated"])
        expect(tag).not.toBe(f.base)

        // No fetch ref at all.
        const missing = yield* job(f.base, "")
        expect(yield* refusal(missing)).toBe(BASE)
        yield* untouched(missing)
        // The fetch ref moved to another commit.
        const moved = yield* job(f.base, f.head)
        expect(yield* refusal(moved)).toBe(BASE)
        yield* untouched(moved)
        // A base this repository does not have, with the fetch ref at a commit it does.
        const absent = yield* job(unknown, f.base)
        expect(yield* refusal(absent)).toBe(BASE)
        yield* untouched(absent)
        // The fetch ref names a commit this repository does not have (written as git would leave a loose ref).
        const dangling = yield* job(unknown, "")
        const loose = path.join(f.ctx.directory, ".git", ...fetchRef(dangling.jid).split("/"))
        yield* FSUtil.Service.use((fs) => fs.writeWithDirs(loose, `${unknown}\n`)).pipe(Effect.orDie)
        expect(yield* refusal(dangling)).toBe(BASE)
        yield* untouched(dangling)
        yield* Effect.promise(() => rm(loose))
        // The base and the fetch ref are an annotated tag, which only peels to the commit.
        const tagged = yield* job(tag)
        expect(yield* refusal(tagged)).toBe(BASE)
        yield* untouched(tagged)

        // Not an exact commit id.
        const exact = yield* job(f.base)
        for (const base of [f.base.slice(0, 12), f.base.toUpperCase(), "HEAD", "--orphan", `${f.base}\n`, ""]) {
          expect(yield* refusal({ ...exact, base })).toBe(INVALID)
          yield* untouched(exact)
        }
      }),
    { git: true },
  )

  it.instance(
    "refuses malformed ids, branches that are not the job's, and a directory other than the loaded checkout",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture()
        const input = yield* job(f.base)
        const other = createJobId(Date.now())
        for (const branch of ["vector/subagent/x", `vector/ve-${other.slice(-12)}`, "main", "vector/ve-../x"]) {
          expect(yield* refusal({ ...input, branch })).toBe(INVALID)
          yield* untouched(input)
        }
        expect(yield* refusal({ ...input, jid: "vej_short" })).toBe(INVALID)
        expect(yield* refusal({ ...input, directory: "relative/checkout" })).toBe(INVALID)

        const subfolder = path.join(f.ctx.directory, "sub")
        yield* FSUtil.Service.use((fs) => fs.makeDirectory(subfolder, { recursive: true })).pipe(Effect.orDie)
        expect(yield* refusal({ ...input, directory: subfolder })).toBe(OWN)
        const elsewhere = path.join(f.markers, "elsewhere")
        yield* FSUtil.Service.use((fs) => fs.makeDirectory(elsewhere, { recursive: true })).pipe(Effect.orDie)
        yield* git(elsewhere, ["init", "--quiet"])
        expect(yield* refusal({ ...input, directory: elsewhere })).toBe(OWN)
        yield* untouched(input)
        // core.worktree, which the config allowlist keeps, points git at another folder.
        const tree = path.join(f.markers, "tree")
        yield* FSUtil.Service.use((fs) => fs.makeDirectory(tree, { recursive: true })).pipe(Effect.orDie)
        yield* git(f.ctx.directory, ["config", "core.worktree", tree])
        expect(yield* refusal(input)).toBe(OWN)
        yield* git(f.ctx.directory, ["config", "--unset", "core.worktree"])
        yield* untouched(input)

        // A checkout Vector made never seeds another, even loaded as its own project folder.
        const made = yield* create(input)
        const next = yield* job(f.base)
        const seeded = { ...next, directory: made.directory }
        expect(yield* refusal(seeded).pipe(provideInstance(made.directory))).toBe(OWN)
        yield* untouched(next)
      }),
    { git: true },
  )

  it.instance(
    "refuses executable repository configuration in either scope before creating anything",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture()
        const filter = path.join(f.markers, "filter")
        yield* FSUtil.Service.use((fs) =>
          fs.writeWithDirs(path.join(f.ctx.directory, ".gitattributes"), "*.txt filter=mark\n"),
        ).pipe(Effect.orDie)
        yield* git(f.ctx.directory, ["add", ".gitattributes"])
        yield* git(f.ctx.directory, ["commit", "-m", "attributes"])
        const base = yield* git(f.ctx.directory, ["rev-parse", "HEAD"])
        yield* git(f.ctx.directory, [
          "config",
          "filter.mark.smudge",
          `echo x >> '${filter.replaceAll("\\", "/")}'; cat`,
        ])
        // Positive control: plain git runs the smudge filter.
        yield* git(f.ctx.directory, ["cat-file", "--filters", "HEAD:a.txt"])
        expect(yield* Effect.promise(() => present(filter))).toBe(true)
        yield* Effect.promise(() => rm(filter))

        const smudge = yield* job(base)
        expect(yield* refusal(smudge)).toBe(UNSAFE)
        expect(yield* Effect.promise(() => present(filter))).toBe(false)
        yield* untouched(smudge)
        yield* git(f.ctx.directory, ["config", "--unset", "filter.mark.smudge"])

        yield* Effect.promise(() => writeFile(path.join(f.markers, "included"), "[core]\n\tbare = false\n"))
        yield* git(f.ctx.directory, ["config", "include.path", path.join(f.markers, "included")])
        const included = yield* job(base)
        expect(yield* refusal(included)).toBe(UNSAFE)
        yield* untouched(included)
        yield* git(f.ctx.directory, ["config", "--unset", "include.path"])

        yield* git(f.ctx.directory, ["config", "extensions.worktreeConfig", "true"])
        yield* git(f.ctx.directory, ["config", "--worktree", "url.local-mirror.insteadOf", "upstream:"])
        const rewritten = yield* job(base)
        expect(yield* refusal(rewritten)).toBe(UNSAFE)
        yield* untouched(rewritten)
      }),
    { git: true },
  )

  it.instance(
    "two concurrent creates of one reservation give exactly one success",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture()
        const input = yield* job(f.base)
        const exits = yield* Effect.all([Effect.exit(create(input)), Effect.exit(create(input))], {
          concurrency: "unbounded",
        })
        expect(exits.filter(Exit.isSuccess)).toHaveLength(1)
        const lost = exits.filter(Exit.isFailure)
        expect(lost).toHaveLength(1)
        const loser = Cause.squash(lost[0]!.cause)
        expect(loser).toBeInstanceOf(Worktree.CreateFailedError)
        // The reservation decided the race: the loser never reached `worktree add`.
        expect((loser as Error).message).toBe(RESERVED)
        expect(readdirSync(path.join(f.ctx.directory, ".git", "worktrees"))).toEqual([input.jid])
        const directory = FileLock.key(path.join(f.root, input.jid))
        const listed = (yield* git(f.ctx.directory, ["worktree", "list", "--porcelain"]))
          .split("\n")
          .filter((line) => line.startsWith("worktree "))
          .map((line) => FileLock.key(line.slice("worktree ".length)))
        expect(listed.filter((item) => item === directory)).toHaveLength(1)
        expect(yield* git(f.ctx.directory, ["for-each-ref", "--format=%(refname)", `refs/heads/${input.branch}`])).toBe(
          `refs/heads/${input.branch}`,
        )
      }),
    { git: true },
  )

  it.instance("refuses a project that is not Git", () =>
    Effect.gen(function* () {
      const ctx = yield* InstanceState.context
      const jid = createJobId(Date.now())
      const input = { directory: ctx.directory, jid, branch: branchFor(jid), base: "0".repeat(40) }
      const exit = yield* Effect.exit(create(input))
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) expect(Cause.squash(exit.cause)).toBeInstanceOf(Worktree.NotGitError)
    }),
  )

  it.instance(
    "keeps the reservation when git fails after it, so the job id is never reused",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture()
        const recorder = yield* Recorder
        const project = yield* Project.Service
        const input = yield* job(f.base)
        const folder = path.join(f.root, input.jid)
        // Another writer takes the job's branch as createUnattended's own `worktree add` starts, after the mkdir.
        const loose = path.join(f.ctx.directory, ".git", "refs", "heads", ...input.branch.split("/"))
        recorder.before.push((call) => {
          if (!call.marked || !call.args.includes("worktree") || !call.args.includes("add")) return
          mkdirSync(path.dirname(loose), { recursive: true })
          writeFileSync(loose, `${f.base}\n`)
        })
        expect(yield* refusal(input)).toBe(FAILED)
        recorder.before.length = 0
        // The folder is kept, empty and unregistered.
        expect(readdirSync(folder)).toEqual([])
        expect((yield* project.sandboxes(f.ctx.project.id)).map((item) => FileLock.key(item))).not.toContain(
          FileLock.key(folder),
        )

        // With the branch gone again, the same job still cannot create: its folder stays reserved.
        yield* git(f.ctx.directory, ["update-ref", "-d", `refs/heads/${input.branch}`])
        recorder.calls.length = 0
        expect(yield* refusal(input)).toBe(RESERVED)
        expect(recorder.calls.some((call) => call.marked && call.args.includes("worktree"))).toBe(false)
        expect(readdirSync(folder)).toEqual([])
        const ref = yield* Git.Service.use((service) =>
          service.run(["show-ref", "--verify", "--quiet", `refs/heads/${input.branch}`], { cwd: f.ctx.directory }),
        )
        expect(ref.exitCode).toBe(1)
      }),
    { git: true },
  )
})
