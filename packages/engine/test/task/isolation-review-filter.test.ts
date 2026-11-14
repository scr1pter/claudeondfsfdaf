// Only a fixed filter in disposable test directories executes; it appends a counter and passes stdin through unchanged.
import { afterEach, expect } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { Cause, Effect, Exit, Layer } from "effect"
import { AppNodeBuilder } from "@vectordevai/core/effect/app-node-builder"
import { LayerNode } from "@vectordevai/core/effect/layer-node"
import { CrossSpawnSpawner } from "@vectordevai/core/cross-spawn-spawner"
import { Database } from "@vectordevai/core/database/database"
import { Global } from "@vectordevai/core/global"
import { LocationServiceMap, locationServiceMapLayer } from "@vectordevai/core/location-services"
import { Npm } from "@vectordevai/core/npm"
import { SessionAudience } from "@vectordevai/core/session/audience"
import { UntrustedGit } from "@vectordevai/core/untrusted-git"
import { untrustedChildEnvironment } from "@vectordevai/core/child-environment"
import { Agent } from "@/agent/agent"
import { Auth } from "@/auth"
import { BackgroundJob } from "@/background/job"
import { Config } from "@/config/config"
import { InstanceState } from "@/effect/instance-state"
import { Git } from "@/git"
import { InstanceBootstrap } from "@/project/bootstrap-service"
import { InstanceStore } from "@/project/instance-store"
import { Session } from "@/session/session"
import { SessionRunState } from "@/session/run-state"
import { TaskClaims } from "@/task/claims"
import { TaskIsolation } from "@/task/isolation"
import { TaskPlace } from "@/task/place"
import { Worktree } from "@/worktree"
import { AuthTest } from "../fake/auth"
import { NpmTest } from "../fake/npm"
import { disposeAllInstances, tmpdirScoped } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const locations = LayerNode.make({ service: LocationServiceMap.Service, layer: locationServiceMapLayer, deps: [] })
const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
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
      [InstanceStore.bootstrapNode, Layer.succeed(InstanceBootstrap.Service, { run: Effect.void })],
      [Auth.node, AuthTest.empty],
      [Npm.node, NpmTest.noop],
    ],
  ),
)
afterEach(disposeAllInstances)

const git = Effect.fn("ReviewFilterProbe.git")(function* (cwd: string, args: string[]) {
  const service = yield* Git.Service
  const result = yield* service.run(args, { cwd })
  if (result.exitCode !== 0 || result.truncated)
    throw new Error("Disposable fixture Git failed: " + result.stderr.toString())
  return result.text().trim()
})
const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'"
const calls = (file: string) =>
  Effect.promise(async () => {
    const text = await fs.readFile(file, "utf8").catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return ""
      throw error
    })
    return text.split("\n").filter((line) => line === "clean").length
  })

it.instance(
  "read-only settled-task admission refuses changed content without executing its clean filter",
  () =>
    Effect.gen(function* () {
      const home = yield* InstanceState.context
      const control = yield* tmpdirScoped()
      const counter = path.join(control, "calls.txt")
      const script = path.join(control, "filter.cjs")
      yield* Effect.promise(() =>
        fs.writeFile(
          script,
          [
            'const fs = require("node:fs");',
            "const input = fs.readFileSync(0);",
            'fs.appendFileSync(process.argv[2], "clean\\n");',
            "fs.writeFileSync(1, input);",
            "",
          ].join("\n"),
        ),
      )
      yield* Effect.promise(() =>
        fs.writeFile(path.join(home.directory, ".gitattributes"), "probe.txt filter=vectorfixturefilter\n"),
      )
      yield* Effect.promise(() => fs.writeFile(path.join(home.directory, "probe.txt"), "base\n"))
      yield* git(home.directory, ["add", "--", ".gitattributes", "probe.txt"])
      yield* git(home.directory, ["commit", "-m", "filter probe baseline"])
      const sessions = yield* Session.Service
      const isolation = yield* TaskIsolation.Service
      const agents = yield* Agent.Service
      const parent = yield* sessions.create({ title: "Filter probe owner" })
      const child = yield* sessions.create({ title: "Settled task filter probe", parentID: parent.id })
      const agent = yield* agents.get("general")
      const registry = path.join(Global.Path.data, "task-isolation", home.project.id, child.id)
      const work = path.join(Global.Path.data, "task-worktree", home.project.id, child.id)
      yield* Effect.addFinalizer(() =>
        Effect.gen(function* () {
          // Remove the deliberate filter before disposal; every invocation stays attributable to the probe's read phases.
          const service = yield* Git.Service
          yield* service.run(["config", "--local", "--unset-all", "filter.vectorfixturefilter.clean"], {
            cwd: home.directory,
          })
          yield* service.run(["config", "--local", "--unset-all", "filter.vectorfixturefilter.required"], {
            cwd: home.directory,
          })
          const store = yield* InstanceStore.Service
          yield* store.disposeDirectory(work)
          yield* service.run(["worktree", "remove", "--force", work], { cwd: home.directory })
          yield* service.run(["branch", "-D", `vector/subagent/${child.id}`], { cwd: home.directory })
          yield* Effect.promise(async () => {
            await fs.rm(work, { recursive: true, force: true })
            await fs.rm(registry, { recursive: true, force: true })
          })
          TaskClaims.unprotect(child.id)
          TaskPlace.drop(child.id)
          TaskPlace.drop(parent.id)
        }).pipe(Effect.orDie),
      )

      yield* isolation.reserve({ taskID: child.id, parentSessionID: parent.id, title: "Filter boundary", agent })
      const started = yield* isolation.start(child.id)
      expect(started.record.directory).toBe(work)
      const savedText = "settled task content\n"
      yield* Effect.promise(() => fs.writeFile(path.join(work, "probe.txt"), savedText))
      const settled = yield* isolation.settle({ taskID: child.id, attempt: 1 })
      expect(settled.state).toBe("changed")
      if (!settled.tip) throw new Error("The settled fixture has no saved commit")
      // Prove the genuine settled port is admissible before the only attacker-controlled delta is installed.
      const admission = { entered: false }
      const baseline = yield* isolation
        .review({ taskID: child.id, parentSessionID: parent.id }, () =>
          Effect.sync(() => {
            admission.entered = true
            return "baseline-admitted"
          }),
        )
        .pipe(Effect.exit)
      if (process.platform !== "linux") {
        const cause = Exit.isFailure(baseline) ? Cause.squash(baseline.cause) : undefined
        expect(cause).toBeInstanceOf(TaskIsolation.IsolationError)
        if (!(cause instanceof TaskIsolation.IsolationError)) throw new Error("No actual task-review refusal")
        expect(cause.code).toBe("review_target")
        expect(cause.message).toContain("Git metadata cannot be inspected safely")
        expect(admission.entered).toBe(false)
        expect(yield* calls(counter)).toBe(0)
        expect(yield* sessions.children(child.id)).toEqual([])
        return
      }
      if (Exit.isFailure(baseline)) return yield* Effect.failCause(baseline.cause)
      expect(baseline.value).toBe("baseline-admitted")
      expect(admission.entered).toBe(true)
      // The dangerous configuration is installed only after worktree creation/settlement, so neither step can execute it.
      yield* git(home.directory, [
        "config",
        "--local",
        "filter.vectorfixturefilter.clean",
        [process.execPath, script, counter].map(quote).join(" "),
      ])
      yield* git(home.directory, ["config", "--local", "filter.vectorfixturefilter.required", "true"])
      yield* git(work, ["update-index", "--no-assume-unchanged", "--no-skip-worktree", "--", "probe.txt"])
      const file = path.join(work, "probe.txt")
      const controlTime = Date.now() + 4000
      yield* Effect.promise(async () => {
        await fs.writeFile(file, "C".repeat(savedText.length - 1) + "\n")
        await fs.utimes(file, new Date(controlTime), new Date(controlTime))
      })
      const first = yield* Effect.promise(() => fs.stat(file))
      const executable = UntrustedGit.program()
      if (!executable) throw new Error("The disposable Git positive control needs installed Git")
      yield* Effect.promise(() => fs.writeFile(counter, ""))
      const ordinary = yield* Effect.promise(() =>
        promisify(execFile)(
          executable,
          [
            "--no-optional-locks",
            "-c",
            "core.fsmonitor=false",
            "-c",
            `core.hooksPath=${os.devNull}`,
            "status",
            "--porcelain",
            "--untracked-files=all",
          ],
          {
            cwd: work,
            timeout: 10_000,
            maxBuffer: 64 * 1024,
            env: { ...untrustedChildEnvironment(), GIT_TERMINAL_PROMPT: "0", GIT_NO_LAZY_FETCH: "1" },
          },
        ),
      )
      expect(ordinary.stdout).toContain("probe.txt")
      const ordinaryFilterCalls = yield* calls(counter)
      expect(ordinaryFilterCalls).toBeGreaterThan(0)
      yield* Effect.promise(() => fs.writeFile(counter, ""))
      // Keep the saved size, so a simple size shortcut cannot avoid the clean conversion. A new mtime also invalidates
      // any stat cache refreshed by the positive control; no sleep or stale-index assumption is part of this proof.
      yield* Effect.promise(async () => {
        await fs.writeFile(file, "T".repeat(savedText.length - 1) + "\n")
        const now = new Date(controlTime + 10_000)
        await fs.utimes(file, now, now)
      })
      const second = yield* Effect.promise(() => fs.stat(file))
      expect(second.size).toBe(first.size)
      expect(second.size).toBe(Buffer.byteLength(savedText))
      expect(second.mtimeMs).not.toBe(first.mtimeMs)
      expect(yield* git(work, ["rev-parse", "HEAD"])).toBe(settled.tip)
      let entered = false
      const exit = yield* isolation
        .review({ taskID: child.id, parentSessionID: parent.id }, () =>
          Effect.sync(() => {
            entered = true
            return "unexpected review body"
          }),
        )
        .pipe(Effect.exit)
      const refusal = Exit.isFailure(exit) ? Cause.squash(exit.cause) : undefined
      const portRefused = refusal instanceof TaskIsolation.IsolationError
      const taskReviewFilterCalls = yield* calls(counter)
      console.log(
        "CONNECT_GIT_FILTER_PROBE",
        JSON.stringify({
          ordinaryFilterCalls,
          taskReviewFilterCalls,
          portRefused,
          entered,
          refusalCode: portRefused ? refusal.code : undefined,
          equalSavedSize: second.size === Buffer.byteLength(savedText),
          changedMtime: first.mtimeMs !== second.mtimeMs,
          actualTaskIsolationPort: true,
        }),
      )
      expect(portRefused).toBe(true)
      expect(entered).toBe(false)
      // This is the security property under investigation; it must fail if the admission read executes the repository filter.
      expect(taskReviewFilterCalls).toBe(0)
      yield* Effect.promise(() => fs.writeFile(file, savedText))
      const clean = yield* isolation.review({ taskID: child.id, parentSessionID: parent.id }, () =>
        Effect.succeed("private-metadata-admitted"),
      )
      expect(clean).toBe("private-metadata-admitted")
      expect(yield* calls(counter)).toBe(0)
      if (!settled.gitCommonDirectory) throw new Error("The fixture has no saved common-dir binding")
      const alternates = path.join(settled.gitCommonDirectory, "objects", "info", "alternates")
      yield* Effect.promise(() => fs.writeFile(alternates, control + "\n", { flag: "wx" }))
      yield* Effect.addFinalizer(() => Effect.promise(() => fs.rm(alternates, { force: true })))
      let unsupportedEntered = false
      const unsupported = yield* isolation
        .review({ taskID: child.id, parentSessionID: parent.id }, () =>
          Effect.sync(() => {
            unsupportedEntered = true
          }),
        )
        .pipe(Effect.exit)
      const unsupportedCause = Exit.isFailure(unsupported) ? Cause.squash(unsupported.cause) : undefined
      expect(unsupportedCause).toBeInstanceOf(TaskIsolation.IsolationError)
      expect(unsupportedEntered).toBe(false)
      expect(yield* calls(counter)).toBe(0)
    }),
  { git: true },
)
