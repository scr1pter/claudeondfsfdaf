import { afterAll, afterEach, describe, expect } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { execFileSync } from "node:child_process"
import { Cause, Deferred, Effect, Exit, ManagedRuntime } from "effect"
import { LayerNode } from "@vectordevai/core/effect/layer-node"
import { CrossSpawnSpawner } from "@vectordevai/core/cross-spawn-spawner"
import { Database } from "@vectordevai/core/database/database"
import { SessionAudience } from "@vectordevai/core/session/audience"
import { FSUtil } from "@vectordevai/core/fs-util"
import { Shell } from "@vectordevai/core/shell"
import { Agent } from "@/agent/agent"
import { Config } from "@/config/config"
import { InstanceState } from "@/effect/instance-state"
import { Plugin } from "@/plugin"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { MessageID, SessionID } from "@/session/schema"
import { TaskClaims } from "@/task/claims"
import { FileLock } from "@/tool/file-lock"
import { assertWritable } from "@/tool/owned-path"
import { ShellTool } from "@/tool/shell"
import { GitMutation } from "@/tool/shell/git-mutation"
import type { Tool } from "@/tool/tool"
import { Truncate } from "@/tool/truncate"
import { disposeAllInstances, tmpdirScoped } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(
  LayerNode.compile(
    LayerNode.group([
      Agent.node,
      Config.node,
      CrossSpawnSpawner.node,
      FSUtil.node,
      Plugin.node,
      RuntimeFlags.node,
      Truncate.node,
    ]),
  ),
)

const base: Tool.Context = {
  sessionID: SessionID.make("ses_root"),
  messageID: MessageID.make("msg_ownership"),
  agent: "build",
  abort: new AbortController().signal,
  messages: [],
  metadata: () => Effect.void,
  ask: () => Effect.void,
}
// The family relation SessionTools gives the main agent, over this file's own database. Nothing is registered there, so
// the main agent's family is its own conversation: the claims it launched (parentSessionID ses_root) are named to it,
// another conversation's (ses_other_root) are not.
const families = ManagedRuntime.make(Database.layerFromPath(":memory:"))
afterAll(() => families.dispose())
const audience = await families.runPromise(Effect.map(Database.Service, (database) => SessionAudience.make(database)))
const main: Tool.Context = { ...base, inFamily: (id) => audience.inFamily(base.sessionID, id) }
const stop = "ownership scan stopped before execution"
const context = (id: string): Tool.Context => ({
  ...base,
  sessionID: SessionID.make(id),
  parentID: base.sessionID,
  getOwnedPaths: () => Effect.sync(() => TaskClaims.trustedPaths(id, true)),
})

const withShell = <A, E, R>(shell: string, effect: Effect.Effect<A, E, R>) =>
  Effect.acquireUseRelease(
    Effect.sync(() => {
      const previous = process.env.SHELL
      process.env.SHELL = shell
      Shell.acceptable.reset()
      Shell.preferred.reset()
      return previous
    }),
    () => effect,
    (previous) =>
      Effect.sync(() => {
        if (previous === undefined) delete process.env.SHELL
        else process.env.SHELL = previous
        Shell.acceptable.reset()
        Shell.preferred.reset()
      }),
  )

const scan = Effect.fn("ShellOwnershipTest.scan")(function* (command: string, denyOwnership = true) {
  const checks: Tool.WritableInput[] = []
  const asks: Array<{ permission: string; patterns: readonly string[] }> = []
  const tool = yield* ShellTool
  const definition = yield* tool.init()
  const result = yield* definition
    .execute(
      { command },
      {
        ...base,
        assertWritable: (request) =>
          Effect.sync(() => {
            checks.push(request)
            if (denyOwnership) throw new Error(stop)
          }),
        ask: (request) =>
          Effect.sync(() => {
            asks.push({ permission: request.permission, patterns: request.patterns })
            if (request.permission === "bash") throw new Error(stop)
          }),
      },
    )
    .pipe(Effect.exit)
  expect(Exit.isFailure(result) ? Cause.pretty(result.cause) : "").toContain(stop)
  return { checks, asks }
})

const claim = Effect.fn("ShellOwnershipTest.claim")(function* (
  taskID: string,
  title = taskID,
  paths: string[] = [],
  isolated = false,
) {
  const instance = yield* InstanceState.context
  const entry = TaskClaims.reserve({
    tree: instance.worktree,
    directory: instance.directory,
    parentSessionID: base.sessionID,
    taskID,
    title,
    paths,
    isolated,
  })
  TaskClaims.bind(entry, taskID)
  return entry
})

const git = Effect.fn("ShellOwnershipTest.git")(function* (
  words: readonly string[],
  options: Partial<GitMutation.Options> = {},
) {
  const instance = yield* InstanceState.context
  const mutation = GitMutation.classify(words, {
    cwd: instance.directory,
    trees: [instance.worktree],
    canonicalize: FileLock.key,
    ...options,
  })
  if (!mutation) throw new Error("Expected a detected git command")
  return mutation
})

const error = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.exit,
    Effect.map((result) => (Exit.isFailure(result) ? Cause.pretty(result.cause) : "")),
  )

afterEach(async () => {
  for (const entry of TaskClaims.claims) TaskClaims.release(entry)
  for (const entry of TaskClaims.protectedTrees()) TaskClaims.unprotect(entry.taskID)
  await disposeAllInstances()
})

if (process.platform !== "win32")
  describe("bash ownership scanning", () => {
    for (const [command, names] of [
      ["echo ok > target.txt", ["target.txt"]],
      ["cp source.txt target.txt", ["target.txt"]],
      ["rm -rf owned", ["owned"]],
      ["rmdir owned", ["owned"]],
      ["unlink owned", ["owned"]],
      ["touch target.txt", ["target.txt"]],
      ["truncate -s 0 target.txt", ["target.txt"]],
      ["mv source.txt target.txt", ["source.txt", "target.txt"]],
      ["git checkout -- owned.ts", ["owned.ts"]],
      ["git mv source.ts target.ts", ["source.ts", "target.ts"]],
    ] as const) {
      it.instance(
        `checks resolved ownership before asking: ${command}`,
        () =>
          withShell(
            "/bin/bash",
            Effect.gen(function* () {
              const instance = yield* InstanceState.context
              const result = yield* scan(command)
              expect(result.checks).toHaveLength(1)
              expect([...new Set(result.checks[0].files)].sort()).toEqual(
                names.map((name) => path.join(instance.directory, name)).sort(),
              )
              expect(result.checks[0].via).toBe("shell")
              expect(result.asks).toEqual([])
            }),
          ),
        { git: true },
      )
    }

    it.instance(
      "unresolved write targets are omitted while edit patterns retain their exact spelling",
      () =>
        withShell(
          "/bin/bash",
          Effect.gen(function* () {
            const result = yield* scan('echo ok > "$OUT"', false)
            expect(result.checks[0].files).toEqual([])
            expect(result.asks.find((request) => request.permission === "edit")?.patterns).toEqual(['"$OUT"'])
          }),
        ),
      { git: true },
    )

    it.instance(
      "existing copy and redirect edit ask patterns are unchanged",
      () =>
        withShell(
          "/bin/bash",
          Effect.gen(function* () {
            for (const [command, patterns] of [
              ["cp input.txt dest.txt", ["dest.txt"]],
              ["echo ok > output.txt", ["output.txt"]],
            ] as const) {
              const result = yield* scan(command, false)
              expect(result.asks.find((request) => request.permission === "edit")?.patterns).toEqual([...patterns])
            }
          }),
        ),
      { git: true },
    )

    it.instance(
      "git stash reaches ownership before the bash ask",
      () =>
        withShell(
          "/bin/bash",
          Effect.gen(function* () {
            const result = yield* scan("git stash")
            expect(result.checks[0].git?.[0].effects).toContain("stash")
            expect(result.asks).toEqual([])
          }),
        ),
      { git: true },
    )

    it.instance(
      "resolves configured git aliases read-only before checking ownership",
      () =>
        withShell(
          "/bin/bash",
          Effect.gen(function* () {
            const instance = yield* InstanceState.context
            yield* Effect.sync(() =>
              execFileSync("git", ["config", "alias.co", "checkout"], { cwd: instance.directory }),
            )
            const result = yield* scan("git co main")
            expect(result.checks[0].git?.[0].effects).toContain("branch")
            expect(result.checks[0].git?.[0].alias).toBeUndefined()
          }),
        ),
      { git: true },
    )

    it.instance(
      "leading git environment assignments route detected paths into their known tree",
      () =>
        withShell(
          "/bin/bash",
          Effect.gen(function* () {
            const instance = yield* InstanceState.context
            const command = `GIT_WORK_TREE='${instance.directory}' git checkout -- owned.ts`
            const result = yield* scan(command)
            expect(result.checks[0].files).toContain(path.join(instance.directory, "owned.ts"))
          }),
        ),
      { git: true },
    )
  })

for (const kind of ["pwsh", "cmd"] as const)
  describe.skipIf(process.platform === "win32" && !Bun.which(kind === "cmd" ? "cmd.exe" : kind))(
    `${kind} ownership scanning`,
    () => {
      it.instance(
        "collects removal targets and move sources before asking",
        () =>
          Effect.gen(function* () {
            const instance = yield* InstanceState.context
            const shell =
              process.platform === "win32"
                ? Bun.which(kind === "cmd" ? "cmd.exe" : kind)
                : path.join(instance.directory, kind)
            if (!shell) throw new Error("This shell should have been gated when unavailable")
            if (process.platform !== "win32") {
              yield* Effect.promise(() => fs.writeFile(shell, "#!/bin/sh\nexit 19\n", { mode: 0o755 }))
            }
            const cases =
              kind === "pwsh"
                ? ([
                    ["Remove-Item -LiteralPath owned.txt -Force", ["owned.txt"]],
                    ["ri -Path owned.txt", ["owned.txt"]],
                    ["rm owned.txt", ["owned.txt"]],
                    ["Move-Item -Path src.txt -Destination dst.txt", ["src.txt", "dst.txt"]],
                  ] as const)
                : ([
                    ["del /F owned.txt", ["owned.txt"]],
                    ["rmdir /S owned", ["owned"]],
                    ["move /Y src.txt dst.txt", ["src.txt", "dst.txt"]],
                  ] as const)
            for (const [command, names] of cases) {
              const result = yield* withShell(shell, scan(command))
              expect([...new Set(result.checks[0].files)].sort()).toEqual(
                names.map((name) => path.join(instance.directory, name)).sort(),
              )
              expect(result.asks).toEqual([])
            }
          }),
        { git: true },
      )
    },
  )

describe("git ownership policy", () => {
  it.instance(
    "the main agent waits for every other shared-tree writer",
    () =>
      Effect.gen(function* () {
        yield* claim("ses_a", "A")
        yield* claim("ses_b", "B")
        const mutation = yield* git(["git", "reset", "--hard"])
        expect(yield* error(assertWritable(main, { files: [], git: [mutation] }))).toContain(
          'This git command changes the whole working tree while 2 subagents are editing it ("A", "B"). It was not run. Wait for them or stop them first.',
        )
      }),
    { git: true },
  )

  it.instance(
    "another conversation's shared-tree writers are counted but not named",
    () =>
      Effect.gen(function* () {
        const instance = yield* InstanceState.context
        yield* claim("ses_a", "A")
        const other = TaskClaims.reserve({
          tree: instance.worktree,
          directory: instance.directory,
          parentSessionID: "ses_other_root",
          taskID: "ses_b",
          title: "Rotate the keys",
          paths: [],
        })
        TaskClaims.bind(other, "ses_b")
        const mutation = yield* git(["git", "reset", "--hard"])
        const refused = yield* error(assertWritable(main, { files: [], git: [mutation] }))
        expect(refused).toContain(
          'This git command changes the whole working tree while 2 subagents are editing it ("A", 1 outside this conversation). It was not run. Wait for them to finish.',
        )
        for (const hidden of ["Rotate", "ses_b", "ses_other_root"]) expect(refused).not.toContain(hidden)
        // Without the family relation no writer is named, and the command is still refused.
        expect(yield* error(assertWritable(base, { files: [], git: [mutation] }))).toContain(
          "while 2 subagents are editing it (2 outside this conversation). It was not run. Wait for them to finish.",
        )
      }),
    { git: true },
  )

  it.instance(
    "shared helpers refuse tree, branch, head, index, stash and ref mutations",
    () =>
      Effect.gen(function* () {
        yield* claim("ses_child")
        for (const words of [
          ["git", "reset", "--hard"],
          ["git", "switch", "other"],
          ["git", "commit", "-m", "x"],
          ["git", "add", "a"],
          ["git", "stash"],
          ["git", "branch", "-d", "other"],
        ]) {
          expect(yield* error(assertWritable(context("ses_child"), { files: [], git: [yield* git(words)] }))).toMatch(
            /shared by the whole repository|share the user's working tree/,
          )
        }
        yield* assertWritable(context("ses_child"), {
          files: [],
          git: [yield* git(["git", "checkout", "--", "free.ts"])],
        })
      }),
    { git: true },
  )

  it.instance(
    "an isolated helper may commit and merge in its own tree but cannot switch, stash or mutate shared refs",
    () =>
      Effect.gen(function* () {
        yield* claim("ses_isolated", "Isolated", [], true)
        for (const words of [
          ["git", "commit", "-m", "x"],
          ["git", "merge", "other"],
          ["git", "rebase", "base"],
        ]) {
          yield* assertWritable(context("ses_isolated"), { files: [], git: [yield* git(words)] })
        }
        for (const words of [
          ["git", "switch", "other"],
          ["git", "checkout", "-b", "new"],
          ["git", "stash"],
          ["git", "stash", "pop"],
          ["git", "stash", "apply"],
          ["git", "branch", "-d", "other"],
        ]) {
          expect(
            yield* error(assertWritable(context("ses_isolated"), { files: [], git: [yield* git(words)] })),
          ).toContain("shared by the whole repository")
        }
      }),
    { git: true },
  )

  it.instance(
    "reserved branches and worktree directories remain protected without a running task",
    () =>
      Effect.gen(function* () {
        const instance = yield* InstanceState.context
        const directory = path.join(instance.directory, "kept-worktree")
        TaskClaims.protect({ taskID: "ses_kept", directories: [directory], branch: "vector/subagent/ses_kept" })
        for (const words of [
          ["git", "branch", "-D", "vector/subagent/ses_kept"],
          ["git", "worktree", "remove", directory],
          ["git", "worktree", "prune"],
          ["git", "update-ref", "--stdin"],
          ["git", "update-ref", "-d", `refs/vector/isolation/ses_kept/${"a".repeat(40)}`],
          ["git", "checkout", "-bvector/subagent/ses_kept"],
          ["git", "switch", "-cvector/subagent/ses_kept"],
        ]) {
          expect(yield* error(assertWritable(base, { files: [], git: [yield* git(words)] }))).toContain(
            "isolated subagent branches and worktrees are protected",
          )
        }
      }),
    { git: true },
  )

  it.instance(
    "git -C path changes enforce another open tree's claims",
    () =>
      Effect.gen(function* () {
        const instance = yield* InstanceState.context
        const other = yield* tmpdirScoped({ git: true })
        const owner = TaskClaims.reserve({
          tree: other,
          directory: other,
          parentSessionID: "ses_other_root",
          taskID: "ses_owner",
          title: "Owner",
          paths: ["owned.ts"],
        })
        TaskClaims.bind(owner, "ses_owner")
        const mutation = yield* git(["git", "-C", other, "checkout", "--", "owned.ts"], {
          trees: [instance.worktree, other],
        })
        // The claim is another conversation's, so the refusal names neither its subagent nor its owned path.
        const refused = yield* error(assertWritable(main, { files: [], git: [mutation] }))
        expect(refused).toContain(
          `${path.join(other, "owned.ts")} belongs to another conversation's running subagent. It was not changed. Wait for it to finish.`,
        )
        for (const hidden of ['"Owner"', "ses_owner", "ses_other_root", "which owns"])
          expect(refused).not.toContain(hidden)
      }),
    { git: true },
  )
})

if (process.platform !== "win32") {
  it.instance(
    "registered linked-worktree git directories route live shell mutations",
    () =>
      withShell(
        "/bin/bash",
        Effect.gen(function* () {
          const instance = yield* InstanceState.context
          const work = yield* tmpdirScoped()
          const gitDirectory = path.join(instance.directory, ".git", "worktrees", "registered")
          TaskClaims.protect({
            taskID: "ses_linked",
            directories: [work],
            workDirectory: work,
            parentDirectory: instance.directory,
            gitDirectory,
          })
          const result = yield* scan(`git --git-dir='${gitDirectory}' checkout -- owned.ts`)
          expect(result.checks[0].git?.[0].tree).toBe(FileLock.key(work))
          expect(result.checks[0].files).toContain(path.join(instance.directory, "owned.ts"))
          expect(result.checks[0].git?.[0].workingTree).toBe(FileLock.key(instance.worktree))
        }),
      ),
    { git: true },
  )

  it.instance(
    "broad ref mutations with kept task state fail before any shell permission ask",
    () =>
      withShell(
        "/bin/bash",
        Effect.gen(function* () {
          const instance = yield* InstanceState.context
          TaskClaims.protect({
            taskID: "ses_kept",
            directories: [path.join(instance.directory, "kept")],
            branch: "vector/subagent/ses_kept",
          })
          const tool = yield* ShellTool
          const definition = yield* tool.init()
          const asks: string[] = []
          for (const command of ["git update-ref --stdin", "git worktree prune"]) {
            const result = yield* definition
              .execute(
                { command },
                {
                  ...base,
                  assertWritable: (request) => assertWritable(base, request),
                  ask: (request) =>
                    Effect.sync(() => {
                      asks.push(request.permission)
                      throw new Error("Unexpected permission ask")
                    }),
                },
              )
              .pipe(Effect.exit)
            expect(Exit.isFailure(result) ? Cause.pretty(result.cause) : "").toContain(
              "isolated subagent branches and worktrees are protected",
            )
          }
          expect(asks).toEqual([])
        }),
      ),
    { git: true },
  )
}

it.instance(
  "pathspec magic and report-plus-apply commands cannot bypass active file ownership",
  () =>
    Effect.gen(function* () {
      yield* claim("ses_owner", "Owner", ["src/owned.ts"])
      for (const words of [
        ["git", "restore", "--", ":(top)src/owned.ts"],
        ["git", "restore", "--", ":/"],
        ["git", "restore", "--", ":(glob)src/*.ts"],
        ["git", "apply", "--stat", "--apply", "patch.diff"],
        ["git", "rm", "--cached", "--no-cached", "src/owned.ts"],
        ["git", "clean", "--dry-run", "--no-dry-run", "-f"],
      ]) {
        expect(yield* error(assertWritable(base, { files: [], git: [yield* git(words)] }))).not.toBe("")
      }
      yield* claim("ses_child")
      expect(
        yield* error(
          assertWritable(context("ses_child"), {
            files: [],
            git: [yield* git(["git", "restore", "--", ":(top)src/owned.ts"])],
          }),
        ),
      ).toContain("share the user's working tree")
    }),
  { git: true },
)

it.instance(
  "redirected git metadata cannot hide current-tree writers or mutate a kept task's metadata",
  () =>
    Effect.gen(function* () {
      const instance = yield* InstanceState.context
      const other = yield* tmpdirScoped({ git: true })
      yield* claim("ses_owner", "Owner", ["src"])
      for (const words of [
        ["git", "--git-dir", path.join(other, ".git"), "reset", "--hard"],
        ["git", "--git-dir", path.join(other, ".git"), "checkout", "--", "src/file.ts"],
      ]) {
        const mutation = yield* git(words)
        expect(yield* error(assertWritable(base, { files: [], git: [mutation] }))).not.toBe("")
      }
      const gitDirectory = path.join(instance.directory, ".git", "worktrees", "kept")
      TaskClaims.protect({
        taskID: "ses_kept",
        directories: [other],
        workDirectory: other,
        parentDirectory: instance.worktree,
        gitDirectory,
      })
      const mutation = yield* git(["git", "--git-dir", gitDirectory, "commit", "-m", "x"], {
        trees: [instance.worktree, other],
        gitDirectories: TaskClaims.gitDirectories(),
      })
      expect(yield* error(assertWritable(base, { files: [], git: [mutation] }))).toContain("protected")
    }),
  { git: true },
)

if (process.platform !== "win32") {
  it.instance(
    "detected shell writes retain an unscoped child's ownership until it settles",
    () =>
      withShell(
        "/bin/bash",
        Effect.gen(function* () {
          const instance = yield* InstanceState.context
          const owner = yield* claim("ses_shell_owner", "Shell owner")
          const tool = yield* ShellTool
          const definition = yield* tool.init()
          const ctx = context("ses_shell_owner")
          const result = yield* definition.execute(
            { command: "printf changed > target.txt" },
            {
              ...ctx,
              assertWritable: (request) => assertWritable(ctx, request),
            },
          )
          expect(result.metadata.exit).toBe(0)
          const file = path.join(instance.directory, "target.txt")
          expect(yield* error(assertWritable(main, { files: [file] }))).toContain(
            'was changed by the running subagent "Shell owner"',
          )
          TaskClaims.release(owner)
          yield* assertWritable(base, { files: [file] })
        }),
      ),
    { git: true },
  )

  it.instance(
    "two detected unscoped shell writers reserve one target before either command can overwrite it",
    () =>
      withShell(
        "/bin/bash",
        Effect.gen(function* () {
          const instance = yield* InstanceState.context
          const ready = yield* Deferred.make<void>()
          const counter = { asked: 0 }
          const tool = yield* ShellTool
          const definition = yield* tool.init()
          for (const id of ["ses_shell_a", "ses_shell_b"]) yield* claim(id, id)
          const results = yield* Effect.forEach(
            ["ses_shell_a", "ses_shell_b"],
            (id) => {
              const ctx = context(id)
              return definition
                .execute(
                  { command: `printf ${id} > target.txt` },
                  {
                    ...ctx,
                    assertWritable: (request) => assertWritable(ctx, request),
                    ask: (request) =>
                      request.permission !== "bash"
                        ? Effect.void
                        : Effect.gen(function* () {
                            counter.asked++
                            if (counter.asked === 2) yield* Deferred.succeed(ready, undefined)
                            yield* Deferred.await(ready)
                          }),
                  },
                )
                .pipe(Effect.exit)
            },
            { concurrency: 2 },
          )
          expect(results.filter(Exit.isSuccess)).toHaveLength(1)
          expect(results.filter(Exit.isFailure)).toHaveLength(1)
          const content = yield* Effect.promise(() => fs.readFile(path.join(instance.directory, "target.txt"), "utf8"))
          expect(["ses_shell_a", "ses_shell_b"]).toContain(content)
        }),
      ),
    { git: true },
  )

  it.instance(
    "a detected directory removal retains ownership over descendants",
    () =>
      withShell(
        "/bin/bash",
        Effect.gen(function* () {
          const instance = yield* InstanceState.context
          yield* claim("ses_shell_owner", "Shell owner")
          const tool = yield* ShellTool
          const definition = yield* tool.init()
          const ctx = context("ses_shell_owner")
          yield* definition.execute(
            { command: "mkdir removed && rmdir removed" },
            { ...ctx, assertWritable: (request) => assertWritable(ctx, request) },
          )
          expect(
            yield* error(assertWritable(main, { files: [path.join(instance.directory, "removed/new.txt")] })),
          ).toContain('was changed by the running subagent "Shell owner"')
        }),
      ),
    { git: true },
  )
}

it.instance(
  "read-only git metadata inspection remains allowed in protected task state",
  () =>
    Effect.gen(function* () {
      const instance = yield* InstanceState.context
      const other = yield* tmpdirScoped({ git: true })
      const gitDirectory = path.join(instance.directory, ".git", "worktrees", "kept")
      TaskClaims.protect({ taskID: "ses_kept", directories: [other], workDirectory: other, gitDirectory })
      for (const command of ["status", "log", "show"]) {
        const mutation = yield* git(["git", "--git-dir", gitDirectory, command], {
          trees: [instance.worktree, other],
          gitDirectories: TaskClaims.gitDirectories(),
        })
        expect(mutation.effects).toEqual([])
        yield* assertWritable(base, { files: [], git: [mutation] })
      }
      const mutation = yield* git(["git", "-C", other, "commit", "-m", "x"], { trees: [instance.worktree, other] })
      expect(yield* error(assertWritable(base, { files: [], git: [mutation] }))).toContain(
        "isolated subagent branches and worktrees are protected",
      )
    }),
  { git: true },
)

if (process.platform !== "win32") {
  it.instance(
    "ownership acquired during a shell permission prompt is rechecked before execution",
    () =>
      withShell(
        "/bin/bash",
        Effect.gen(function* () {
          const instance = yield* InstanceState.context
          const file = path.join(instance.directory, "target.txt")
          const calls = { ownership: 0 }
          const tool = yield* ShellTool
          const definition = yield* tool.init()
          const result = yield* definition
            .execute(
              { command: "printf changed > target.txt" },
              {
                ...base,
                assertWritable: (request) =>
                  Effect.sync(() => {
                    calls.ownership++
                  }).pipe(Effect.andThen(assertWritable(main, request))),
                ask: (request) =>
                  request.permission === "bash"
                    ? claim("ses_new_owner", "New owner", ["target.txt"]).pipe(Effect.asVoid)
                    : Effect.void,
              },
            )
            .pipe(Effect.exit)
          expect(Exit.isFailure(result) ? Cause.pretty(result.cause) : "").toContain(
            'belongs to the running subagent "New owner"',
          )
          expect(calls.ownership).toBe(2)
          expect(
            yield* Effect.promise(() =>
              fs.stat(file).then(
                () => true,
                () => false,
              ),
            ),
          ).toBe(false)
        }),
      ),
    { git: true },
  )
}

it.instance(
  "explicit git index and metadata selectors cannot overwrite another child's owned paths",
  () =>
    Effect.gen(function* () {
      const instance = yield* InstanceState.context
      yield* claim("ses_owner", "Owner", ["src"])
      const index = yield* git(["git", "add", "."], {
        env: { GIT_INDEX_FILE: path.join(instance.directory, "src/custom-index") },
      })
      expect(yield* error(assertWritable(main, { files: [], git: [index] }))).toContain(
        'belongs to the running subagent "Owner"',
      )
      const metadata = yield* git(["git", "--git-dir", path.join(instance.directory, "src/.git"), "commit", "-m", "x"])
      expect(yield* error(assertWritable(main, { files: [], git: [metadata] }))).toContain(
        'belongs to the running subagent "Owner"',
      )
    }),
  { git: true },
)

if (process.platform !== "win32") {
  it.instance(
    "detected recursive shell ancestors cannot remove private registries or an owning task's .git",
    () =>
      withShell(
        "/bin/bash",
        Effect.gen(function* () {
          const instance = yield* InstanceState.context
          const registryProject = yield* tmpdirScoped()
          const registry = path.join(registryProject, "child")
          yield* Effect.promise(async () => {
            await fs.mkdir(registry)
            await fs.writeFile(path.join(registry, "record.json"), "keep")
          })
          yield* claim("ses_private", "Private", [], true)
          TaskClaims.protect({
            taskID: "ses_private",
            directories: [instance.directory, registry],
            workDirectory: instance.directory,
            privateDirectories: [registry],
            immutableFiles: [path.join(instance.directory, ".git")],
          })
          const tool = yield* ShellTool
          const definition = yield* tool.init()
          const asks: string[] = []
          for (const item of [
            { command: `rm -rf -- '${registryProject}'`, ctx: base },
            { command: "rm -rf -- .", ctx: context("ses_private") },
          ]) {
            const ctx = {
              ...item.ctx,
              ask: (input: { permission: string }) =>
                Effect.sync(() => {
                  asks.push(input.permission)
                }),
            }
            expect(
              yield* error(
                definition.execute(
                  { command: item.command },
                  { ...ctx, assertWritable: (input) => assertWritable(ctx, input) },
                ),
              ),
            ).toContain("protected")
          }
          expect(asks).toEqual([])
          expect(yield* Effect.promise(() => fs.readFile(path.join(registry, "record.json"), "utf8"))).toBe("keep")
          expect(
            yield* Effect.promise(() =>
              fs.stat(path.join(instance.directory, ".git")).then((info) => info.isDirectory()),
            ),
          ).toBe(true)
        }),
      ),
    { git: true },
  )

  it.instance(
    "a recursive ancestor of the parent checkout is refused with data and work roots elsewhere",
    () =>
      withShell(
        "/bin/bash",
        Effect.gen(function* () {
          const instance = yield* InstanceState.context
          const ancestor = yield* tmpdirScoped()
          const parent = path.join(ancestor, "repo")
          yield* Effect.promise(async () => {
            await fs.mkdir(parent)
            await fs.writeFile(path.join(parent, "keep.txt"), "keep")
          })
          yield* claim("ses_parent_boundary", "Parent boundary", [], true)
          TaskClaims.protect({
            taskID: "ses_parent_boundary",
            directories: [instance.directory],
            workDirectory: instance.directory,
            parentDirectory: parent,
          })
          const tool = yield* ShellTool
          const definition = yield* tool.init()
          const asks: string[] = []
          const ctx = {
            ...context("ses_parent_boundary"),
            ask: (input: { permission: string }) =>
              Effect.sync(() => {
                asks.push(input.permission)
              }),
          }
          expect(
            yield* error(
              definition.execute(
                { command: `rm -rf -- '${ancestor}'` },
                { ...ctx, assertWritable: (input) => assertWritable(ctx, input) },
              ),
            ),
          ).toContain("parent's working tree")
          expect(asks).toEqual([])
          expect(yield* Effect.promise(() => fs.readFile(path.join(parent, "keep.txt"), "utf8"))).toBe("keep")
        }),
      ),
    { git: true },
  )
}

// The guest Git guard (WP28): every git invocation the scan recognizes, read-only ones included, is screened before
// any permission ask or subprocess, with its own environment assignments; other commands are not. The commands are
// bash syntax, so bash runs them on every platform: Git Bash on Windows, whose default shell is PowerShell.
const bashtest = process.platform === "win32" && !Shell.gitbash() ? it.instance.skip : it.instance
bashtest("every recognized git invocation is screened before the command is asked for or run", () =>
  withShell(
    Shell.gitbash() ?? "/bin/bash",
    Effect.gen(function* () {
      const instance = yield* InstanceState.context
      const tool = yield* ShellTool
      const definition = yield* tool.init()
      const screened: { cwd: string; args?: string[]; env?: Record<string, string> }[] = []
      const read: (readonly string[])[] = []
      const asks: string[] = []
      const run = (command: string, refuse: boolean) =>
        definition
          .execute(
            { command },
            {
              ...base,
              assertReadable: (request) => Effect.sync(() => void read.push(request.files)),
              assertGitReadable: (request) =>
                Effect.sync(() => {
                  screened.push(request)
                  if (refuse) throw new Error("refused by the guest Git guard")
                }),
              ask: (request) =>
                Effect.sync(() => {
                  asks.push(request.permission)
                  throw new Error(stop)
                }),
            },
          )
          .pipe(Effect.exit)
      const refused = yield* run("GIT_DIR=.git git log --all --oneline && git worktree list", true)
      expect(Exit.isFailure(refused) ? Cause.pretty(refused.cause) : "").toContain("refused by the guest Git guard")
      expect(asks).toEqual([])
      expect(screened[0]).toMatchObject({ cwd: instance.directory, args: ["git", "log", "--all", "--oneline"] })
      expect(screened[0].env).toEqual({ GIT_DIR: ".git" })
      // The working directory is screened as a recursive read target too.
      expect(read[0]).toContain(instance.directory)

      screened.length = 0
      const plain = yield* run("ls -la && echo done", false)
      expect(Exit.isFailure(plain) ? Cause.pretty(plain.cause) : "").toContain(stop)
      expect(screened).toEqual([])
    }),
  ),
)
