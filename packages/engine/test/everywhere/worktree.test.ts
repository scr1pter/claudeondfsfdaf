import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test"
import { $ } from "bun"
import { createHash } from "node:crypto"
import { mkdirSync, readdirSync, writeFileSync } from "node:fs"
import { lstat, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Cause, ConfigProvider, Context, Effect, Exit, Layer, Scope } from "effect"
import { HttpRouter } from "effect/unstable/http"
import { ConfigManaged } from "@vectordevai/core/config/managed"
import { GUEST_REQUEST_HEADER } from "@vectordevai/core/free-model-guests"
import { GIT_HARDENING, fetchRef, runnerGitEnvironment } from "@vectordevai/core/everywhere/git"
import { branchFor } from "@vectordevai/core/everywhere/publish"
import { LayerNode } from "@vectordevai/core/effect/layer-node"
import { FSUtil } from "@vectordevai/core/fs-util"
import { Global } from "@vectordevai/core/global"
import { AppProcess } from "@vectordevai/core/process"
import { createJobId } from "@vectordevai/schema/everywhere"
import { GlobalBus } from "../../src/bus/global"
import { Config } from "../../src/config/config"
import { EverywherePreferences } from "../../src/config/everywhere-preferences"
import { AppLayer } from "../../src/effect/app-runtime"
import { InstanceState } from "../../src/effect/instance-state"
import { Git } from "../../src/git"
import { InstanceBootstrap } from "../../src/project/bootstrap"
import { InstanceStore } from "../../src/project/instance-store"
import { Project } from "../../src/project/project"
import { Event } from "../../src/server/event"
import { HttpApiApp } from "../../src/server/routes/instance/httpapi/server"
import { FileLock } from "../../src/tool/file-lock"
import { Worktree } from "../../src/worktree"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances, provideInstance, tmpdir } from "../fixture/fixture"
import { useManagedPolicyFixture } from "../fixture/managed-policy"
import { testEffect } from "../lib/effect"
import { waitGlobalBusEvent } from "../server/global-bus"

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
const receiptRoot = path.join(Global.Path.state, "everywhere-worktree-reservations")
const receiptFor = (jid: string) => path.join(receiptRoot, `${jid}.json`)
const present = (file: string) =>
  lstat(file).then(
    () => true,
    () => false,
  )
// Windows will not remove a folder while a process has it open or as its working folder, and git that an instance
// started there can outlive the test by a moment. Retry as Worktree.remove's cleanDirectory does (50 times, 100 ms
// apart, on win32 only); elsewhere, and for any other error, the first failure stands.
const removeFolder = (target: string, left = 50): Promise<void> =>
  rm(target, { recursive: true, force: true }).catch(async (error: NodeJS.ErrnoException) => {
    if (process.platform !== "win32" || left <= 1 || (error.code !== "EBUSY" && error.code !== "EPERM")) throw error
    await Bun.sleep(100)
    return removeFolder(target, left - 1)
  })

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
      await removeFolder(root)
      await removeFolder(markers)
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
        const receipt = receiptFor(input.jid)
        expect(yield* Effect.promise(() => readFile(receipt, "utf8").then(JSON.parse))).toEqual({
          version: 1,
          jid: input.jid,
          project: f.ctx.project.id,
          branch: input.branch,
          base: input.base,
        })
        if (process.platform !== "win32") {
          expect((yield* Effect.promise(() => lstat(receiptRoot))).mode & 0o077).toBe(0)
          expect((yield* Effect.promise(() => lstat(receipt))).mode & 0o077).toBe(0)
        }
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
            // Not os.devNull: Git for Windows refuses \\.\nul as a config file, and reads "/dev/null" as the device.
            GIT_CONFIG_GLOBAL: "/dev/null",
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
        expect(yield* Effect.promise(() => present(receiptFor(branched.jid)))).toBe(false)

        // An empty folder is already there.
        const folder = yield* job(f.base)
        yield* FSUtil.Service.use((fs) => fs.makeDirectory(path.join(f.root, folder.jid), { recursive: true })).pipe(
          Effect.orDie,
        )
        expect(yield* refusal(folder)).toBe(RESERVED)
        expect(readdirSync(path.join(f.root, folder.jid))).toEqual([])
        expect(yield* Effect.promise(() => present(receiptFor(folder.jid)))).toBe(false)
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
        expect(yield* Effect.promise(() => present(receiptFor(smudge.jid)))).toBe(false)
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
    "rechecks config and checkout identity after reservation and stops before mutating Git",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture()
        const recorder = yield* Recorder
        const file = path.join(f.ctx.directory, ".git", "config")
        const original = yield* Effect.promise(() => readFile(file, "utf8"))
        const redirected = JSON.stringify(f.markers.replaceAll("\\", "/"))
        for (const [change, reason] of [
          ['[filter "late"]\n\tsmudge = cat\n', UNSAFE],
          [`[core]\n\tworktree = ${redirected}\n`, OWN],
        ] as const) {
          const input = yield* job(f.base)
          const receipt = receiptFor(input.jid)
          recorder.calls.length = 0
          recorder.before.push((call) => {
            // The final read before the durable reservation, after the original config and checkout checks.
            if (call.marked && call.args.includes(`refs/heads/${input.branch}`))
              writeFileSync(file, `${original}\n${change}`)
          })
          const result = yield* refusal(input).pipe(
            Effect.ensuring(
              Effect.promise(async () => {
                recorder.before.length = 0
                await writeFile(file, original)
              }),
            ),
          )
          expect(result).toBe(reason)
          expect(
            recorder.calls.some(
              (call) => call.marked && (call.args.includes("worktree") || call.args.includes("reset")),
            ),
          ).toBe(false)
          expect(readdirSync(path.join(f.root, input.jid))).toEqual([])
          expect(yield* Effect.promise(() => readFile(receipt, "utf8").then(JSON.parse))).toMatchObject({
            version: 1,
            jid: input.jid,
            project: f.ctx.project.id,
          })
        }
      }),
    { git: true },
  )

  it.instance(
    "names git's own reason, at most 2 KB of it, when git cannot read the repository",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture()
        const input = yield* job(f.base)
        const file = path.join(f.ctx.directory, ".git", "config")
        const config = yield* Effect.promise(() => readFile(file))
        // An out-of-range repository format version: git exits 128 reading it, with about 3 KB of stderr.
        yield* Effect.promise(() => writeFile(file, `[core]\n\trepositoryformatversion = ${"9".repeat(3000)}\n`))
        const message = yield* refusal(input).pipe(Effect.ensuring(Effect.promise(() => writeFile(file, config))))
        const prefix = "The unattended worktree could not be created. git: "
        expect(message).toStartWith(`${prefix}fatal: bad numeric config value`)
        expect(Buffer.byteLength(message)).toBeLessThanOrEqual(Buffer.byteLength(prefix) + 2048)
        yield* untouched(input)
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
    "keeps a reservation after git fails, even when the folder and branch are lost and the service restarts",
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

        yield* Effect.promise(() => removeFolder(folder))
        yield* git(f.ctx.directory, ["worktree", "prune", "--expire", "now"])
        const receipt = receiptFor(input.jid)
        expect(yield* refusal(input).pipe(Effect.provide(Layer.fresh(layer)))).toBe(RESERVED)
        yield* untouched(input)
        expect(yield* Effect.promise(() => readFile(receipt, "utf8").then(JSON.parse))).toEqual({
          version: 1,
          jid: input.jid,
          project: f.ctx.project.id,
          branch: input.branch,
          base: input.base,
        })
      }),
    { git: true },
  )

  it.instance(
    "a partial receipt blocks the same job with a new base and leaves that receipt untouched",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture()
        const input = yield* job(f.base, f.head)
        const receipt = receiptFor(input.jid)
        yield* Effect.promise(async () => {
          await mkdir(receiptRoot, { mode: 0o700, recursive: true })
          await writeFile(receipt, '{"version":', { flag: "wx", mode: 0o600 })
        })
        const replay = { ...input, base: f.head }
        expect(yield* refusal(replay)).toBe(RESERVED)
        yield* untouched(replay)
        expect(yield* Effect.promise(() => readFile(receipt, "utf8"))).toBe('{"version":')
        const independent = yield* job(f.head)
        expect((yield* create(independent)).base).toBe(f.head)
      }),
    { git: true },
  )
})

describe("ordinary worktree mutations preserve unattended reservations", () => {
  afterEach(() => disposeAllInstances())

  it.instance(
    "refuses to remove a job checkout through an alias or its unregistered parent",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture()
        const input = yield* job(f.base)
        const checkout = yield* create(input)
        const alias = path.join(f.markers, "checkout-alias")
        const receiptAlias = path.join(f.markers, "receipt-alias")
        const service = yield* Worktree.Service
        const linkType = process.platform === "win32" ? "junction" : "dir"
        yield* Effect.promise(async () => {
          await symlink(checkout.directory, alias, linkType)
          await symlink(receiptRoot, receiptAlias, linkType)
        })

        for (const directory of [alias, f.root, receiptAlias, Global.Path.state]) {
          const error = yield* Effect.flip(service.remove({ directory }))
          expect(error).toBeInstanceOf(Worktree.RemoveFailedError)
          expect(error.message).toBe("Cannot remove a Vector Everywhere worktree through this command.")
        }

        const nearby = `${alias}-nearby`
        yield* git(f.ctx.directory, ["worktree", "add", "--detach", "--", nearby, f.base])
        expect(yield* service.remove({ directory: nearby })).toBe(true)
        expect(yield* Effect.promise(() => present(nearby))).toBe(false)
        expect(yield* Effect.promise(() => present(receiptFor(input.jid)))).toBe(true)
        expect(yield* git(checkout.directory, ["rev-parse", "HEAD"])).toBe(f.base)
        expect(yield* git(checkout.directory, ["symbolic-ref", "--short", "HEAD"])).toBe(input.branch)
      }),
    { git: true },
  )

  it.instance(
    "refuses to reset a job checkout and preserves its staged and untracked files",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture()
        const checkout = yield* create(yield* job(f.base))
        const staged = path.join(checkout.directory, "a.txt")
        const untracked = path.join(checkout.directory, "notes.txt")
        const service = yield* Worktree.Service
        yield* Effect.promise(() => writeFile(staged, "updated\n"))
        yield* git(checkout.directory, ["add", "a.txt"])
        yield* Effect.promise(() => writeFile(untracked, "unfinished\n"))

        const error = yield* Effect.flip(service.reset({ directory: checkout.directory }))
        expect(error).toBeInstanceOf(Worktree.ResetFailedError)
        expect(error.message).toBe("Cannot reset a Vector Everywhere worktree through this command.")
        expect(yield* git(checkout.directory, ["show", ":a.txt"])).toBe("updated")
        expect(yield* Effect.promise(() => readFile(untracked, "utf8"))).toBe("unfinished\n")
        expect(yield* git(checkout.directory, ["rev-parse", "HEAD"])).toBe(f.base)
      }),
    { git: true },
  )
})

// EV-13: the same service through the real HTTP API, with the owner's and a guest's credentials. The route must refuse
// a guest, a folder the user's own config does not allow (checked before anything looks for an instance), a project
// the owner has not opened and an untrusted one, and it must never load an instance itself. The server's own
// InstanceStore is observed through the memo map the handler shares.
describe("POST /experimental/worktree/unattended (EV-13)", () => {
  const ROUTE = "/experimental/worktree/unattended"
  const OWNER_PASSWORD = "ev13-owner-secret"
  const GUEST_PASSWORD = "ev13-guest-secret"
  const TASK = "EV13-TASK-MARKER"
  const OFF = "Vector everywhere is off for this folder."
  const CLOSED = "This project is not open in Vector. No unattended worktree was created."
  const UNTRUSTED = "This project is not trusted. No unattended worktree was created."
  const UNAVAILABLE = "The allowed folder is not available."
  const basic = (username: string, password: string) =>
    `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`
  const owner = { authorization: basic("vector", OWNER_PASSWORD) }
  const guest = { authorization: basic("guest", GUEST_PASSWORD) }
  const forwarded = { ...owner, [GUEST_REQUEST_HEADER]: "1" }
  const managedDirectory = process.env.VECTOR_TEST_MANAGED_CONFIG_DIR!
  const preferencesPath = path.join(Global.Path.state, "everywhere-preferences.fixture.json")
  const globalFiles = () =>
    ["config.json", "vector.json", "vector.jsonc"].map((name) => path.join(Global.Path.config, name))

  const memo = Layer.makeMemoMapUnsafe()
  const web = HttpRouter.toWebHandler(
    HttpApiApp.createRoutes(undefined, preferencesPath).pipe(
      Layer.provide(
        ConfigProvider.layer(
          ConfigProvider.fromUnknown({
            VECTOR_SERVER_USERNAME: "vector",
            VECTOR_SERVER_PASSWORD: OWNER_PASSWORD,
            VECTOR_SERVER_GUEST_USERNAME: "guest",
            VECTOR_SERVER_GUEST_PASSWORD: GUEST_PASSWORD,
            VECTOR_DISABLE_DEFAULT_PLUGINS: true,
          }),
        ),
      ),
    ),
    { disableLogger: true, memoMap: memo },
  )
  const scope = Scope.makeUnsafe()
  const services: { app?: Promise<Context.Context<Layer.Success<typeof AppLayer>>> } = {}
  const run = <A, E>(effect: Effect.Effect<A, E, Layer.Success<typeof AppLayer>>) =>
    (services.app ??= Effect.runPromise(Layer.buildWithMemoMap(AppLayer, memo, scope))).then((app) =>
      Effect.runPromise(effect.pipe(Effect.provide(app))),
    )
  const loaded = () =>
    run(InstanceStore.Service.use((store) => store.loaded())).then((items) =>
      items.map((item) => FileLock.key(item.directory)),
    )

  const call = async (route: string, init: { method?: string; headers?: object; body?: unknown } = {}) => {
    const response = await web.handler(
      new Request(new URL(route, "http://localhost"), {
        method: init.method ?? "GET",
        headers: {
          ...(init.body === undefined ? {} : { "content-type": "application/json" }),
          ...init.headers,
        },
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
      }),
      HttpApiApp.context,
    )
    const text = await response.text()
    return { status: response.status, text, body: text ? JSON.parse(text) : undefined }
  }
  const post = (body: unknown, headers: object = owner) => call(ROUTE, { method: "POST", headers, body })
  // How the app opens a project: any instance route with the folder selected.
  const open = async (directory: string) => {
    const response = await call("/project/current", { headers: { ...owner, "x-vector-directory": directory } })
    expect(response.status).toBe(200)
    return response.body as { id: string }
  }
  // The user's own vector.json, written by hand. A Vector file with settings in it also keeps the loader from importing
  // config.json into vector.jsonc, which would then shadow the next edit.
  const writeGlobal = (config: object) =>
    writeFile(
      path.join(Global.Path.config, "vector.json"),
      JSON.stringify({ $schema: "https://vectordev.ai/config.json", ...config }),
    )
  const allow = (directories: string[], enabled = true) =>
    writeGlobal({
      everywhere: { enabled, projects: directories.map((directory) => ({ directory, repository: "acme/widgets" })) },
    })

  // The fixture's own git runs with hooks off, so only the positive control fires them.
  const git = async (cwd: string, ...args: string[]) => {
    const result = await $`git -c core.hooksPath=${os.devNull} ${args}`.cwd(cwd).quiet().nothrow()
    if (result.exitCode !== 0) throw new Error(result.stderr.toString())
    return result.stdout.toString().trim()
  }
  const disposables: AsyncDisposable[] = []
  const cleanup: string[] = []
  // A repository with committed hooks (as husky leaves them) and a start script that each write a marker, and one
  // job whose base the runner fetched.
  const repository = async (trusted: boolean, settings = true) => {
    const tmp = await tmpdir({ git: true, trusted, config: settings ? { formatter: false, lsp: false } : undefined })
    disposables.push(tmp)
    const repo = tmp.path
    const markers = `${repo}-markers`
    cleanup.push(markers)
    await mkdir(markers, { recursive: true })
    const hook = path.join(markers, "hook")
    const start = path.join(markers, "start")
    await git(repo, "config", "core.autocrlf", "false")
    for (const name of ["reference-transaction", "post-checkout", "post-index-change"]) {
      await mkdir(path.join(repo, ".husky"), { recursive: true })
      await writeFile(
        path.join(repo, ".husky", name),
        `#!/bin/sh\necho "$0 $PWD" >> '${hook.replaceAll("\\", "/")}'\n`,
        { mode: 0o755 },
      )
    }
    await writeFile(path.join(repo, "a.txt"), "base\n")
    await git(repo, "add", ".")
    await git(repo, "commit", "-m", "base")
    const base = await git(repo, "rev-parse", "HEAD")
    await writeFile(path.join(repo, "a.txt"), "head\n")
    await git(repo, "commit", "-am", "head")
    await git(repo, "config", "core.hooksPath", ".husky")
    const id = await run(
      Effect.gen(function* () {
        const project = yield* Project.Service
        const found = yield* project.fromDirectory(repo)
        yield* project
          .update({ projectID: found.project.id, commands: { start: `echo start>> "${start}"` } })
          .pipe(Effect.orDie)
        return found.project.id
      }),
    )
    const root = path.join(Global.Path.data, "everywhere-worktree", id)
    cleanup.push(root)
    const jid = createJobId(Date.now())
    await git(repo, "update-ref", fetchRef(jid), base)
    return { repo, markers, hook, start, base, id, root, input: { directory: repo, jid, branch: branchFor(jid), base } }
  }
  // Neither the job's branch nor its folder exists.
  const untouched = async (f: Awaited<ReturnType<typeof repository>>, input = f.input) => {
    const ref = await $`git show-ref --verify --quiet ${`refs/heads/${input.branch}`}`.cwd(f.repo).quiet().nothrow()
    expect(ref.exitCode).toBe(1)
    expect(await present(path.join(f.root, input.jid))).toBe(false)
  }
  const refusedWith = (response: { status: number; body: unknown }, status: number, message: string) => {
    expect(response.status).toBe(status)
    const body = response.body as { _tag?: string; message?: string; name?: string; data?: { message?: string } }
    expect(status === 403 ? body.message : body.data?.message).toBe(message)
  }

  const originals: (string | undefined)[] = []
  beforeEach(async () => {
    originals.length = 0
    for (const file of globalFiles()) originals.push((await present(file)) ? await readFile(file, "utf8") : undefined)
  })
  afterEach(async () => {
    await rm(preferencesPath, { force: true, recursive: true })
    await Promise.all(
      globalFiles().map((file, index) => {
        const original = originals[index]
        return original === undefined ? rm(file, { force: true }) : writeFile(file, original)
      }),
    )
    await run(
      Effect.gen(function* () {
        const config = yield* Config.Service
        const store = yield* InstanceStore.Service
        yield* config.invalidate()
        yield* store.disposeAll()
      }),
    )
    for (const item of disposables.splice(0)) await item[Symbol.asyncDispose]()
    for (const item of cleanup.splice(0)) await removeFolder(item)
    await resetDatabase()
  })
  afterAll(async () => {
    await web.dispose()
    await Effect.runPromise(Scope.close(scope, Exit.void))
  })

  test("the probe answers unattended-v1 to the owner only", async () => {
    const answer = await call(ROUTE, { headers: owner })
    expect(answer.status).toBe(200)
    expect(answer.body).toEqual({ policy: "unattended-v1" })
    expect((await call(ROUTE, { headers: guest })).status).toBe(403)
    expect((await call(ROUTE, { headers: forwarded })).status).toBe(403)
    expect((await call(ROUTE)).status).toBe(401)
  }, 30_000)

  test("the owner's create makes the job's worktree, runs no hook or start script, and answers only directory, branch and base", async () => {
    const f = await repository(true)
    // The write the settings page makes; it reloads every instance.
    const disposed = Effect.runPromise(
      waitGlobalBusEvent({ predicate: (event) => event.payload.type === Event.Disposed.type }),
    )
    const saved = await call("/global/config", {
      method: "PATCH",
      headers: owner,
      body: { everywhere: { enabled: true, projects: [{ directory: f.repo, repository: "acme/widgets" }] } },
    })
    expect(saved.status).toBe(200)
    await disposed
    await run(InstanceStore.Service.use((store) => store.disposeAll()))
    expect(await loaded()).not.toContain(FileLock.key(f.repo))
    // Positive control for the observation: opening the project through the app's own route shows up here.
    expect((await open(f.repo)).id).toBe(f.id)
    expect(await loaded()).toContain(FileLock.key(f.repo))
    const before = (await loaded()).sort()
    // Positive control: plain git in this repository fires its hooks.
    await $`git branch vector/control`.cwd(f.repo).quiet()
    expect(await present(f.hook)).toBe(true)
    await git(f.repo, "branch", "-D", "vector/control")
    await rm(f.hook)

    const events: string[] = []
    const on = (event: { payload: { type: string } }) => events.push(event.payload.type)
    GlobalBus.on("event", on)
    const created = await post({ ...f.input, task: TASK }).finally(() => GlobalBus.off("event", on))

    expect(created.status).toBe(200)
    const directory = FSUtil.realpath(path.join(f.root, f.input.jid))
    expect(Object.keys(created.body).sort()).toEqual(["base", "branch", "directory"])
    expect(created.body).toEqual({ directory, branch: f.input.branch, base: f.base })
    expect(created.text).not.toContain(TASK)
    expect(await git(directory, "rev-parse", "HEAD")).toBe(f.base)
    expect(await git(directory, "symbolic-ref", "--short", "HEAD")).toBe(f.input.branch)
    expect(await readFile(path.join(directory, "a.txt"), "utf8")).toBe("base\n")
    expect(await present(f.hook)).toBe(false)
    expect(await present(f.start)).toBe(false)
    expect(events).not.toContain(Worktree.Event.Ready.type)
    expect(events).not.toContain(Worktree.Event.Failed.type)
    // The route loaded nothing, not even the new checkout.
    expect((await loaded()).sort()).toEqual(before)
    const listed = await call("/experimental/worktree", { headers: { ...owner, "x-vector-directory": f.repo } })
    expect(listed.status).toBe(200)
    expect((listed.body as string[]).map((item) => FileLock.key(item))).toContain(FileLock.key(directory))
  }, 30_000)

  test("a guest or a guest-marked request is refused before anything exists", async () => {
    const f = await repository(true)
    await allow([f.repo])
    await open(f.repo)
    for (const headers of [guest, forwarded]) {
      expect((await post(f.input, headers)).status).toBe(403)
      await untouched(f)
    }
  }, 30_000)

  test("a folder the user's own config does not allow is refused and never gets an instance", async () => {
    const f = await repository(true)
    const other = await repository(true)
    // The engine's copy of the global config, which the route's own reads must leave alone.
    expect((await call("/global/config", { headers: owner })).status).toBe(200)
    const cases: (() => Promise<unknown>)[] = [
      () => writeGlobal({}),
      () => allow([f.repo], false),
      () => allow([other.repo]),
      // A key the schema does not have makes the loader throw: the refusal must not carry its message or the path.
      () =>
        writeGlobal({
          everywhere: { enabled: true, pushh: true, projects: [{ directory: f.repo, repository: "acme/widgets" }] },
        }),
    ]
    for (const write of cases) {
      await write()
      expect(await loaded()).not.toContain(FileLock.key(f.repo))
      const refused = await post(f.input)
      refusedWith(refused, 403, OFF)
      // As written and as JSON escapes it, since a Windows path's backslashes never appear raw in a JSON body.
      for (const leak of [Global.Path.config, f.repo]) {
        expect(refused.text).not.toContain(leak)
        expect(refused.text).not.toContain(JSON.stringify(leak).slice(1, -1))
      }
      expect(await loaded()).not.toContain(FileLock.key(f.repo))
      await untouched(f)
    }
    // The invalid file failed the route's read only: the rest of the engine keeps its last good copy.
    expect((await call("/global/config", { headers: owner })).status).toBe(200)
  }, 30_000)

  test("turning it off by hand applies to the next request, with the project open and trusted", async () => {
    const f = await repository(true)
    await allow([f.repo])
    await open(f.repo)
    // Read once while allowed, so a cached copy would still say yes.
    refusedWith(await post({ ...f.input, base: "0".repeat(40) }), 400, "The base is not this job's fetched commit.")
    await allow([f.repo], false)
    refusedWith(await post(f.input), 403, OFF)
    await untouched(f)
  }, 30_000)

  test("the sidecar's versioned preferences take precedence without changing global config", async () => {
    const f = await repository(true)
    await allow([f.repo])
    await open(f.repo)
    // No sidecar preference means the legacy allowlist applies, as shown by a refusal at a later check.
    const wrongBase = { ...f.input, base: "0".repeat(40) }
    const baseError = "The base is not this job's fetched commit."
    refusedWith(await post(wrongBase), 400, baseError)
    const block = { enabled: true, projects: [{ directory: f.repo, repository: "acme/widgets" }] }
    for (const value of [
      { version: 1, revision: 1, settings: { enabled: false } },
      { version: 2, revision: 1, settings: block },
      { version: 1, revision: 0, settings: block },
      { version: 1, revision: 1, settings: { ...block, pushh: true } },
    ]) {
      await writeFile(preferencesPath, JSON.stringify(value))
      refusedWith(await post(f.input), 403, OFF)
      await untouched(f)
    }
    await writeFile(preferencesPath, "{invalid json")
    refusedWith(await post(f.input), 403, OFF)
    await rm(preferencesPath)
    await mkdir(preferencesPath)
    refusedWith(await post(f.input), 403, OFF)
    await rm(preferencesPath, { recursive: true })
    // A supported preference can admit the folder only after the owner and project checks.
    await allow([f.repo], false)
    const file = path.join(Global.Path.config, "vector.json")
    const original = await readFile(file, "utf8")
    await run(Config.Service.use((config) => config.invalidate()))
    await writeFile(preferencesPath, JSON.stringify({ version: 1, revision: 2, settings: block }))
    for (const headers of [guest, forwarded]) expect((await post(f.input, headers)).status).toBe(403)
    refusedWith(await post(wrongBase), 400, baseError)
    expect(await readFile(file, "utf8")).toBe(original)
    expect((await call("/global/config", { headers: owner })).body.everywhere).toEqual({ ...block, enabled: false })
    // Apply the managed-policy wire independently of this machine's native file ownership.
    const agent = process.env.VECTOR_AGENT_SESSION
    delete process.env.VECTOR_AGENT_SESSION
    ConfigManaged.useTestPolicies([
      { source: "fixture policy", text: JSON.stringify({ local: { lock: true, locked_keys: ["everywhere"] } }) },
    ])
    try {
      Config.refreshLocal()
      Config.confirmLocal()
      expect(Config.lockedKeys()).toContain("everywhere")
      refusedWith(await post(f.input), 403, OFF)
      const access = EverywherePreferences.access(preferencesPath)
      expect(await run(access({ version: 1, kind: "update", revision: 2, settings: { enabled: false } }))).toEqual({
        version: 1,
        kind: "locked",
      })
    } finally {
      ConfigManaged.useTestPolicies(undefined)
      Config.refreshLocal()
      Config.confirmLocal()
      if (agent !== undefined) process.env.VECTOR_AGENT_SESSION = agent
    }
    await untouched(f)
  }, 30_000)

  test("durable preference writes compare revisions and immediately stop legacy-enabled admission", async () => {
    const f = await repository(true)
    await allow([f.repo])
    await open(f.repo)
    const file = path.join(Global.Path.config, "vector.json")
    const original = await readFile(file, "utf8")
    const access = EverywherePreferences.access(preferencesPath)
    const read = { version: 1, kind: "read" }
    const update = { version: 1, kind: "update", revision: 0, settings: { enabled: false } }
    expect(await run(access(read))).toMatchObject({ kind: "ready", snapshot: { revision: 0, everywhere: { enabled: true } } })
    expect(await run(access({ ...update, version: 2 }))).toEqual({ version: 1, kind: "invalid" })
    expect(await run(access({ ...update, consent: true }))).toEqual({ version: 1, kind: "invalid" })
    const writes = await Promise.all([run(access(update)), run(access(update))])
    expect(writes.map((result) => result.kind).sort()).toEqual(["ready", "stale"])
    expect(await run(access(read))).toMatchObject({ kind: "ready", snapshot: { revision: 1, everywhere: { enabled: false } } })
    expect(JSON.parse(await readFile(preferencesPath, "utf8"))).toEqual({ version: 1, revision: 1, settings: { enabled: false } })
    const name = path.basename(preferencesPath)
    expect(readdirSync(path.dirname(preferencesPath)).filter((item) => item.startsWith(name))).toEqual([name])
    expect(await readFile(file, "utf8")).toBe(original)
    refusedWith(await post(f.input), 403, OFF)
    await untouched(f)
  }, 30_000)

  test("a company lock on everywhere is off, with the project open and trusted", async () => {
    const f = await repository(true)
    await allow([f.repo])
    await open(f.repo)
    const agent = process.env.VECTOR_AGENT_SESSION
    // Under the agent marker the owner's yes below would not count, and the lock would outlive this case.
    delete process.env.VECTOR_AGENT_SESSION
    const restore = useManagedPolicyFixture(managedDirectory)
    try {
      await mkdir(managedDirectory, { recursive: true })
      await writeFile(
        path.join(managedDirectory, "vector.json"),
        JSON.stringify({ local: { lock: true, locked_keys: ["everywhere"] } }),
      )
      Config.refreshLocal()
      Config.confirmLocal()
      expect(Config.lockedKeys()).toContain("everywhere")
      refusedWith(await post(f.input), 403, OFF)
      await untouched(f)
    } finally {
      await rm(managedDirectory, { force: true, recursive: true })
      restore()
      await rm(Config.localConfirmedFile(), { force: true })
      // Removing the company's policy loosens Vector Local, which waits for the owner; the owner here says yes.
      Config.refreshLocal()
      Config.confirmLocal()
      if (agent !== undefined) process.env.VECTOR_AGENT_SESSION = agent
    }
  }, 30_000)

  test("an allowed, trusted project the owner has not opened is refused and gets no instance", async () => {
    const f = await repository(true)
    await allow([f.repo])
    expect(await loaded()).not.toContain(FileLock.key(f.repo))
    refusedWith(await post(f.input), 403, CLOSED)
    expect(await loaded()).not.toContain(FileLock.key(f.repo))
    await untouched(f)
  }, 30_000)

  test("a listed link to the folder admits the folder", async () => {
    const f = await repository(true)
    const link = path.join(f.markers, "linked")
    await symlink(f.repo, link, process.platform === "win32" ? "junction" : "dir")
    await allow([link])
    await open(f.repo)
    const created = await post(f.input)
    expect(created.status).toBe(200)
    expect(created.body.branch).toBe(f.input.branch)
  }, 30_000)

  test("an allowed project that is open but not trusted is refused, with or without settings of its own", async () => {
    const f = await repository(false)
    // Trust only decides on a project's own settings, so one with none is still refused: the check is "trusted".
    const bare = await repository(false, false)
    await allow([f.repo, bare.repo])
    for (const item of [f, bare]) {
      await open(item.repo)
      refusedWith(await post(item.input), 403, UNTRUSTED)
      await untouched(item)
    }
  }, 30_000)

  test("malformed or foreign input answers 400 and creates nothing", async () => {
    const f = await repository(true)
    const gone = path.join(f.markers, "gone")
    const closed = await repository(true)
    await allow([f.repo, gone, closed.repo])
    await open(f.repo)
    for (const body of [
      { ...f.input, branch: "main" },
      { ...f.input, base: "HEAD" },
      { ...f.input, jid: "vej_short" },
      { ...f.input, directory: 1 },
    ]) {
      expect((await post(body)).status).toBe(400)
      await untouched(f)
    }
    // A refused field never brings the request's other fields back with it.
    const echoed = await post({ ...f.input, branch: "main", task: TASK })
    expect(echoed.status).toBe(400)
    expect(echoed.text).not.toContain(TASK)

    const other = createJobId(Date.now() + 1)
    refusedWith(
      await post({ ...f.input, branch: `vector/ve-${other.slice(-12)}` }),
      400,
      "Invalid unattended worktree request.",
    )
    refusedWith(await post({ ...f.input, base: "0".repeat(40) }), 400, "The base is not this job's fetched commit.")
    await untouched(f)

    // A relative path is refused as written, never resolved against the engine's own folder first: here it would name
    // a listed folder that is open, and another that is not.
    // Across drives (a Windows runner's checkout on D:, its temp folder on C:) path.relative answers the absolute path,
    // so there the request names a folder of that name beside the engine's folder instead: still relative, so refused.
    for (const item of [f, closed]) {
      const between = path.relative(process.cwd(), item.repo)
      const relative = path.isAbsolute(between) ? path.join("..", path.basename(item.repo)) : between
      expect(path.isAbsolute(relative)).toBe(false)
      refusedWith(await post({ ...item.input, directory: relative }), 400, "Invalid unattended worktree request.")
      await untouched(item)
    }

    refusedWith(await post({ ...f.input, directory: gone }), 400, UNAVAILABLE)
    expect(await loaded()).not.toContain(FileLock.key(gone))
    expect(await present(gone)).toBe(false)
    await untouched(f)
  }, 30_000)

  // EV-18 (EV-16's first precondition): a command in the job's checkout can write a formatter, language server or
  // other config into it, and the engine would run that outside the sandbox. A checkout the route creates is never
  // trusted (createUnattended inherits no trust, and trust is keyed by folder and content), so the repository's own
  // config, and whatever is written over it, stays unloaded after a reload. The desktop adapter checks GET /config/trust
  // for exactly this answer.
  test("the job's checkout is never trusted, so its own config, or one written into it, loads no formatter or server", async () => {
    // The repository commits a vector.json ({formatter: false, lsp: false}), and its owner trusts it.
    const f = await repository(true)
    const user = { "ev18-user": { command: ["true"], extensions: [".ev18"] } }
    await writeGlobal({
      everywhere: { enabled: true, projects: [{ directory: f.repo, repository: "acme/widgets" }] },
      // Formatters are on for the user: only trust keeps them out of a folder.
      formatter: user,
    })
    await open(f.repo)
    const read = async (directory: string, route: string): Promise<unknown> => {
      const response = await call(route, { headers: { ...owner, "x-vector-directory": directory } })
      expect(response.status).toBe(200)
      return response.body
    }
    const config = async (directory: string) => (await read(directory, "/config")) as { formatter?: unknown }
    // The control: in the trusted project its own config loads, and its `formatter: false` wins over the user's.
    expect(await read(f.repo, "/config/trust")).toMatchObject({ trusted: true, settings: true })
    expect((await config(f.repo)).formatter).toBe(false)

    const created = await post(f.input)
    expect(created.status).toBe(200)
    const checkout = created.body.directory as string
    const state = async () => ({
      trust: await read(checkout, "/config/trust"),
      formatter: (await config(checkout)).formatter,
      formatters: await read(checkout, "/formatter"),
      servers: await read(checkout, "/lsp"),
    })
    // The same committed file in the job's checkout is not loaded, and neither formatters nor servers start there.
    const untrusted = {
      trust: expect.objectContaining({ trusted: false, ignored: true, settings: true }),
      formatter: user,
      formatters: [],
      servers: [],
    }
    expect(await state()).toEqual(untrusted)

    // What a sandboxed command can write: the checkout's config with a formatter and a language server that would
    // leave a marker, and a .vector folder. A reload (the engine disposes the instance) reads the folder again.
    const marker = path.join(f.markers, "ran")
    const command = ["sh", "-c", `echo x > '${marker.replaceAll("\\", "/")}'`]
    await writeFile(
      path.join(checkout, "vector.json"),
      JSON.stringify({
        formatter: { "ev18-checkout": { command, extensions: [".txt"] } },
        lsp: { "ev18-server": { command, extensions: [".txt"] } },
      }),
    )
    await mkdir(path.join(checkout, ".vector"), { recursive: true })
    await writeFile(
      path.join(checkout, ".vector", "vector.json"),
      JSON.stringify({ formatter: { "ev18-dot": { command } } }),
    )
    // The instance's Vcs reads the checkout's branch with git whose working folder is the checkout; on Windows a running
    // git keeps the folder from being removed. Vcs.init now awaits that lookup during the instance's boot, and GET /vcs
    // joins it as well, so read it before the instance is disposed and before the test ends.
    await read(checkout, "/vcs")
    const dispose = await call("/instance/dispose", {
      method: "POST",
      headers: { ...owner, "x-vector-directory": checkout },
    })
    expect(dispose.status).toBe(200)
    expect(await state()).toEqual(untrusted)
    expect(await present(marker)).toBe(false)
    await read(checkout, "/vcs")
  }, 30_000)
})
