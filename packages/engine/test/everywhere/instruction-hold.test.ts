import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test"
import { $ } from "bun"
import { lstat, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { ConfigProvider, Context, Effect, Exit, Layer, Scope } from "effect"
import { HttpRouter } from "effect/unstable/http"
import { Brain } from "@vectordevai/core/brain/brain"
import { UNATTENDED_KEY } from "@vectordevai/core/everywhere/frame"
import { fetchRef } from "@vectordevai/core/everywhere/git"
import { branchFor } from "@vectordevai/core/everywhere/publish"
import { FSUtil } from "@vectordevai/core/fs-util"
import { Global } from "@vectordevai/core/global"
import { createJobId } from "@vectordevai/schema/everywhere"
import { Config } from "../../src/config/config"
import { AppLayer } from "../../src/effect/app-runtime"
import { InstanceStore } from "../../src/project/instance-store"
import { Project } from "../../src/project/project"
import { HttpApiApp } from "../../src/server/routes/instance/httpapi/server"
import { Instruction } from "../../src/session/instruction"
import { MessageID } from "../../src/session/schema"
import { resetDatabase } from "../fixture/db"
import { provideInstance, tmpdir } from "../fixture/fixture"

// EV-21: a Vector everywhere job writes its checkout from platform text, and Continue opens an ordinary owner session
// there (`<data>/everywhere-worktree/<project id>/<jid>`), with network and the owner's permissions. Until the owner
// trusts that folder, an instruction file inside it reaches the session only as the job's base had it. The checkout is
// made through the real route, as EV-13's "the job's checkout is never trusted" case makes it (worktree.test.ts, copied
// here, not shared, because that file is in open PRs), against real git. What the owner's session gets is read from
// the same engine's Instruction service in that checkout: its system prompt is Instruction.system() (SessionPrompt
// sessionInstructions), the read tool attaches Instruction.resolve(), and research carries Instruction.contents(). The
// rest of that system prompt is the brain's digest of Instruction.place(), whose rules files it sends whole.

const BASE = "BASE RULES: ev21 the repository's own"
const CLAUDE = "CLAUDE RULES: ev21 the repository's own"
const LIB = "LIB RULES: ev21 the repository's own"
const JOB = "JOB RULES: ev21 written by the job"
const PKG = "PKG RULES: ev21 written by the job"
const RULES = "REPOSITORY RULES: ev21 the repository's own"
const JOB_RULES = "JOB REPOSITORY RULES: ev21 written by the job"

describe("instruction files in a Vector everywhere job's checkout (EV-21)", () => {
  const ROUTE = "/experimental/worktree/unattended"
  const OWNER_PASSWORD = "ev21-owner-secret"
  const basic = (username: string, password: string) =>
    `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`
  const owner = { authorization: basic("vector", OWNER_PASSWORD) }
  const globalFiles = () =>
    ["config.json", "vector.json", "vector.jsonc"].map((name) => path.join(Global.Path.config, name))

  const memo = Layer.makeMemoMapUnsafe()
  const web = HttpRouter.toWebHandler(
    HttpApiApp.routes.pipe(
      Layer.provide(
        ConfigProvider.layer(
          ConfigProvider.fromUnknown({
            VECTOR_SERVER_USERNAME: "vector",
            VECTOR_SERVER_PASSWORD: OWNER_PASSWORD,
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
  // How the app opens a project: any instance route with the folder selected.
  const open = async (directory: string) => {
    const response = await call("/project/current", { headers: { ...owner, "x-vector-directory": directory } })
    expect(response.status).toBe(200)
  }
  // The user's own vector.json, written by hand.
  const allow = (directories: string[]) =>
    writeFile(
      path.join(Global.Path.config, "vector.json"),
      JSON.stringify({
        $schema: "https://vectordev.ai/config.json",
        everywhere: {
          enabled: true,
          projects: directories.map((directory) => ({ directory, repository: "acme/widgets" })),
        },
      }),
    )
  // The fixture's own git runs with hooks off.
  const git = async (cwd: string, ...args: string[]) => {
    const result = await $`git -c core.hooksPath=${os.devNull} ${args}`.cwd(cwd).quiet().nothrow()
    if (result.exitCode !== 0) throw new Error(result.stderr.toString())
    return result.stdout.toString().trim()
  }
  const present = (file: string) =>
    lstat(file).then(
      () => true,
      () => false,
    )
  const disposables: AsyncDisposable[] = []
  const cleanup: string[] = []

  // A trusted repository whose base has AGENTS.md, CLAUDE.md and lib/AGENTS.md, one job whose base the runner fetched
  // into refs/vector-everywhere/<jid>, and the job's checkout as the owner's create route makes it.
  // With `rules`, the base also has the repository's .vector/RULES.md, written before the owner trusts the repository,
  // since .vector is one of the settings trust fingerprints.
  const checkout = async (options: { rules?: boolean } = {}) => {
    const tmp = await tmpdir({
      git: true,
      trusted: true,
      config: { formatter: false, lsp: false },
      init: options.rules
        ? async (directory) => {
            await mkdir(path.join(directory, ".vector"), { recursive: true })
            await writeFile(path.join(directory, ".vector", "RULES.md"), `- ${RULES}\n`)
          }
        : undefined,
    })
    disposables.push(tmp)
    const repo = tmp.path
    await git(repo, "config", "core.autocrlf", "false")
    await mkdir(path.join(repo, "pkg"), { recursive: true })
    await mkdir(path.join(repo, "lib"), { recursive: true })
    await writeFile(path.join(repo, "AGENTS.md"), `${BASE}\n`)
    await writeFile(path.join(repo, "CLAUDE.md"), `${CLAUDE}\n`)
    await writeFile(path.join(repo, "lib", "AGENTS.md"), `${LIB}\n`)
    await writeFile(path.join(repo, "lib", "y.ts"), "export const y = 1\n")
    await writeFile(path.join(repo, "pkg", "x.ts"), "export const x = 1\n")
    await git(repo, "add", ".")
    await git(repo, "commit", "-m", "base")
    const base = await git(repo, "rev-parse", "HEAD")
    const id = await run(
      Project.Service.use((project) => project.fromDirectory(repo)).pipe(Effect.map((found) => found.project.id)),
    )
    cleanup.push(path.join(Global.Path.data, "everywhere-worktree", id))
    const jid = createJobId(Date.now())
    await git(repo, "update-ref", fetchRef(jid), base)
    await allow([repo])
    await open(repo)
    const created = await call(ROUTE, {
      method: "POST",
      headers: owner,
      body: { directory: repo, jid, branch: branchFor(jid), base },
    })
    expect(created.status).toBe(200)
    const directory = created.body.directory as string
    expect(await git(directory, "rev-parse", "HEAD")).toBe(base)
    // The folder Vector made for this job, which Vector keeps untrusted.
    expect(directory).toBe(FSUtil.realpath(path.join(Global.Path.data, "everywhere-worktree", id, jid)))
    expect(await call("/config/trust", { headers: { ...owner, "x-vector-directory": directory } })).toMatchObject({
      status: 200,
      body: { trusted: false },
    })
    return { repo, base, jid, directory, id }
  }

  // A later start of the engine: no instance keeps what it resolved for the checkout while the job ran.
  const restart = () =>
    run(
      Effect.gen(function* () {
        const config = yield* Config.Service
        const store = yield* InstanceStore.Service
        yield* config.invalidate()
        yield* store.disposeAll()
      }),
    )

  // What the job does on its branch: AGENTS.md rewritten and a new pkg/AGENTS.md, committed.
  const steer = async (directory: string) => {
    await writeFile(path.join(directory, "AGENTS.md"), `${JOB}\n`)
    await writeFile(path.join(directory, "pkg", "AGENTS.md"), `${PKG}\n`)
    await git(directory, "add", ".")
    await git(directory, "commit", "-m", "job")
  }

  // An ordinary owner session in the job's checkout (the app's Continue), and what it gets from the instruction files.
  let messages = 0
  const session = async (directory: string) => {
    const created = await call("/session", {
      method: "POST",
      headers: { ...owner, "x-vector-directory": directory },
      body: { title: "Continue the job" },
    })
    expect(created.status).toBe(200)
    expect(created.body.metadata?.[UNATTENDED_KEY]).toBeUndefined()
    return run(
      Effect.gen(function* () {
        const instruction = yield* Instruction.Service
        const brain = yield* Brain.Service
        const read = (file: string) =>
          instruction
            .resolve([], path.join(directory, file), MessageID.make(`msg_ev21-read-${++messages}`))
            .pipe(Effect.map((found) => found.map((item) => item.content).join("\n")))
        const place = yield* instruction.place()
        return {
          paths: [...(yield* instruction.systemPaths())],
          system: (yield* instruction.system()).join("\n"),
          work: (yield* instruction.contents()).work.join("\n"),
          pkg: yield* read(path.join("pkg", "x.ts")),
          lib: yield* read(path.join("lib", "y.ts")),
          // The rest of that system prompt: the brain's digest, whose "Repository rules" are the place's rules files.
          sources: place.sources.map((source) => source.path),
          digest: (yield* brain.digest(place, { personal: false, index: false })).text ?? "",
        }
      }).pipe(provideInstance(directory)),
    )
  }

  const originals: (string | undefined)[] = []
  beforeEach(async () => {
    originals.length = 0
    for (const file of globalFiles()) originals.push((await present(file)) ? await readFile(file, "utf8") : undefined)
  })
  afterEach(async () => {
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
    // Windows will not remove a folder a process still has open for a moment: rm retries EBUSY and EPERM.
    for (const item of cleanup.splice(0))
      await rm(item, { recursive: true, force: true, maxRetries: 50, retryDelay: 100 })
    await resetDatabase()
  })
  afterAll(async () => {
    await web.dispose()
    await Effect.runPromise(Scope.close(scope, Exit.void))
  })

  test("an owner session in the checkout gets none of the instruction text the job wrote, and no CLAUDE.md in its place", async () => {
    const f = await checkout()
    await steer(f.directory)
    // The job's text is what is on disk and on the job's branch.
    expect(await readFile(path.join(f.directory, "AGENTS.md"), "utf8")).toBe(`${JOB}\n`)
    expect(await git(f.directory, "show", "HEAD:AGENTS.md")).toBe(JOB)

    const seen = await session(f.directory)
    for (const text of [seen.system, seen.work, seen.pkg]) {
      expect(text).not.toContain(JOB)
      expect(text).not.toContain(PKG)
      // A held root AGENTS.md keeps its place, so the repository's CLAUDE.md does not stand in for it.
      expect(text).not.toContain(CLAUDE)
      expect(text).not.toContain("CLAUDE.md")
    }
    // The held file stays in the set the computer tool protects.
    expect(seen.paths).toContain(path.join(f.directory, "AGENTS.md"))
    // The control: a nested file the base has, unchanged, still comes with a read beside it.
    expect(seen.lib).toContain(LIB)
  }, 30_000)

  test("instruction files unchanged from the job's base still reach the owner's session", async () => {
    const f = await checkout()
    const seen = await session(f.directory)
    expect(seen.system).toContain(BASE)
    expect(seen.work).toContain(BASE)
    expect(seen.system).not.toContain(CLAUDE)
    expect(seen.lib).toContain(LIB)
    expect(seen.pkg).toBe("")
  }, 30_000)

  test("with the job's ref gone, a changed file stays held, and so does every instruction file in the checkout", async () => {
    const f = await checkout()
    await steer(f.directory)
    await git(f.repo, "update-ref", "-d", fetchRef(f.jid))
    expect(await $`git rev-parse --verify --quiet ${fetchRef(f.jid)}`.cwd(f.repo).quiet().nothrow()).toMatchObject({
      exitCode: 1,
    })

    const seen = await session(f.directory)
    for (const text of [seen.system, seen.work, seen.pkg, seen.lib]) {
      expect(text).not.toContain(JOB)
      expect(text).not.toContain(PKG)
      expect(text).not.toContain(CLAUDE)
    }
    // No base to compare with, so the unchanged files are held too: the hold fails closed.
    expect(seen.system).not.toContain(BASE)
    expect(seen.lib).not.toContain(LIB)
  }, 30_000)

  // The brain gives the system prompt the repository's .vector/RULES.md whole, as "Repository rules", beside
  // Instruction.system(), so a rules file the job wrote is an instruction file too.
  test("repository rules the job wrote stay out of the owner's digest, and the base's still go", async () => {
    const f = await checkout({ rules: true })
    const rules = path.join(f.directory, ".vector", "RULES.md")
    const before = await session(f.directory)
    expect(before.sources).toContain(rules)
    expect(before.digest).toContain(RULES)

    await writeFile(rules, `- ${JOB_RULES}\n`)
    await git(f.directory, "commit", "-am", "job rules")
    const seen = await session(f.directory)
    expect(seen.digest).not.toContain(JOB_RULES)
    expect(seen.digest).not.toContain(RULES)
    expect(seen.sources).not.toContain(rules)
  }, 30_000)

  // A job's file tools may write anything in its folder, its .git marker included. Neither a marker that no longer
  // names a repository nor one that names a repository the job made may decide what the owner's session reads.
  test("a .git marker the job overwrote does not lift the hold", async () => {
    const f = await checkout()
    await steer(f.directory)
    await writeFile(path.join(f.directory, ".git"), "not a git directory\n")
    await restart()

    const seen = await session(f.directory)
    // The job's AGENTS.md is still found, and held.
    expect(seen.paths).toContain(path.join(f.directory, "AGENTS.md"))
    for (const text of [seen.system, seen.work, seen.pkg, seen.lib]) {
      expect(text).not.toContain(JOB)
      expect(text).not.toContain(PKG)
    }
  }, 30_000)

  test("a repository the job made in its folder does not stand in for the job's base", async () => {
    const f = await checkout()
    await steer(f.directory)
    const head = await git(f.directory, "rev-parse", "HEAD")
    // The job's own repository: its ref names the job's commit, and it keeps the project's id, so the folder still
    // looks like this project's checkout of this job.
    const forged = path.join(f.directory, ".forged")
    await git(f.repo, "clone", "--bare", "--quiet", "--no-local", f.repo, forged)
    await git(forged, "remote", "remove", "origin")
    await git(forged, "config", "core.bare", "false")
    await git(forged, "update-ref", fetchRef(f.jid), head)
    await mkdir(path.join(forged, "vector"), { recursive: true })
    await writeFile(path.join(forged, "vector", "project-id"), f.id)
    await writeFile(path.join(f.directory, ".git"), `gitdir: ${forged.replaceAll("\\", "/")}\n`)
    expect(await git(f.directory, "rev-parse", "--verify", `${fetchRef(f.jid)}^{commit}`)).toBe(head)
    await restart()

    const seen = await session(f.directory)
    // The job's AGENTS.md is still found, and held.
    expect(seen.paths).toContain(path.join(f.directory, "AGENTS.md"))
    for (const text of [seen.system, seen.work, seen.pkg, seen.lib]) {
      expect(text).not.toContain(JOB)
      expect(text).not.toContain(PKG)
    }
  }, 30_000)
})
