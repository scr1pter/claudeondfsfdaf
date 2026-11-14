import { describe, expect } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { Cause, Effect, Exit, Layer } from "effect"
import { CrossSpawnSpawner } from "@vectordevai/core/cross-spawn-spawner"
import { LayerNode } from "@vectordevai/core/effect/layer-node"
import { FSUtil } from "@vectordevai/core/fs-util"
import { Ripgrep } from "@vectordevai/core/ripgrep"
import { reviewPermissionRules } from "@vectordevai/core/review/permission"
import { PermissionV1 } from "@vectordevai/core/v1/permission"
import { Agent } from "@/agent/agent"
import { InstanceState } from "@/effect/instance-state"
import { Git } from "@/git"
import { LSP } from "@/lsp/lsp"
import { Permission } from "@/permission"
import { readAuthority } from "@/review/read-authority"
import { Instruction } from "@/session/instruction"
import { MessageID, SessionID } from "@/session/schema"
import { GlobTool } from "@/tool/glob"
import { GrepTool } from "@/tool/grep"
import { ReadTool } from "@/tool/read"
import type { Tool } from "@/tool/tool"
import { Truncate } from "@/tool/truncate"
import { provideInstance, testInstanceStoreLayer, TestInstance, tmpdirScoped } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(
  Layer.mergeAll(
    LayerNode.compile(
      LayerNode.group([
        Agent.node,
        CrossSpawnSpawner.node,
        FSUtil.node,
        Git.node,
        Instruction.node,
        LSP.node,
        Ripgrep.node,
        Truncate.node,
      ]),
    ),
    testInstanceStoreLayer,
  ),
)

function context(patterns: readonly string[]): Tool.Context {
  const ruleset = reviewPermissionRules({ readDenies: patterns })
  return {
    sessionID: SessionID.make("ses_read_authority"),
    messageID: MessageID.make("msg_read_authority"),
    callID: "authority",
    agent: "review",
    abort: AbortSignal.any([]),
    messages: [],
    extra: { restrictedReadListing: true },
    metadata: () => Effect.void,
    ask: (request) =>
      Effect.sync(() => {
        const denied = request.patterns.find(
          (resource) => Permission.evaluate(request.permission, resource, ruleset).action === "deny",
        )
        if (denied) throw new PermissionV1.DeniedError({ ruleset, permission: request.permission, pattern: denied })
      }),
    deniedResources: (request) =>
      Effect.succeed(
        request.patterns.filter(
          (resource) => Permission.evaluate(request.permission, resource, ruleset).action === "deny",
        ),
      ),
  }
}

const exercise = Effect.fn("ReviewReadAuthorityTest.exercise")(function* (input: {
  directory: string
  denied: string
  protectedFile: string
  visibleFile: string
  alias?: string
  readRoot?: string
}) {
  const instance = yield* InstanceState.context
  const authority = readAuthority([input.denied], {
    directory: input.directory,
    worktree: instance.worktree,
    ...(input.readRoot ? { readRoot: input.readRoot } : {}),
  })
  const ctx = context(authority.patterns)
  const readInfo = yield* ReadTool
  const read = yield* readInfo.init()
  const grepInfo = yield* GrepTool
  const grep = yield* grepInfo.init()
  const globInfo = yield* GlobTool
  const glob = yield* globInfo.init()
  for (const filePath of [
    input.protectedFile,
    path.relative(instance.directory, input.protectedFile),
    ...(input.alias ? [input.alias] : []),
  ]) {
    expect(Exit.isFailure(yield* read.execute({ filePath }, ctx).pipe(Effect.exit))).toBe(true)
    expect(
      Exit.isFailure(
        yield* grep.execute({ pattern: "VECTOR_AUTHORITY_MARKER", path: filePath }, ctx).pipe(Effect.exit),
      ),
    ).toBe(true)
  }
  const visible = yield* read.execute({ filePath: input.visibleFile }, ctx)
  expect(visible.output).toContain("VISIBLE")
  const searched = yield* grep.execute({ pattern: "VECTOR_AUTHORITY_MARKER", path: input.directory }, ctx)
  expect(searched.output).toContain("VISIBLE")
  expect(searched.output).not.toContain("WITHHELD")
  const listed = yield* glob.execute({ pattern: "**/*.txt", path: input.directory }, ctx)
  expect(listed.output).toContain("visible.txt")
  expect(listed.output).not.toContain("sensitive.txt")
  const directory = yield* read.execute({ filePath: path.dirname(input.protectedFile) }, ctx)
  expect(directory.output).not.toContain("sensitive.txt")
  expect(JSON.stringify(directory.metadata)).not.toContain("sensitive.txt")
  const missing = yield* read
    .execute({ filePath: path.join(path.dirname(input.protectedFile), "sensitive.tx") }, ctx)
    .pipe(Effect.exit)
  expect(Exit.isFailure(missing)).toBe(true)
  if (Exit.isFailure(missing)) expect(Cause.pretty(missing.cause)).not.toContain("sensitive.txt")
  if (input.alias) {
    const viaAlias = yield* glob.execute({ pattern: "*.txt", path: path.dirname(input.alias) }, ctx)
    expect(viaAlias.output).not.toContain("sensitive.txt")
    const readAlias = yield* read.execute({ filePath: path.dirname(input.alias) }, ctx)
    expect(readAlias.output).not.toContain("sensitive.txt")
  }
})

describe("review read authority reaches actual tools", () => {
  it.instance(
    "ordinary glob keeps its existing ask and listing behavior",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        yield* Effect.promise(() => fs.writeFile(path.join(test.directory, "visible.txt"), "visible\n"))
        const rules = context([])
        const asks: string[] = []
        const info = yield* GlobTool
        const glob = yield* info.init()
        const result = yield* glob.execute(
          { pattern: "*.txt" },
          {
            ...rules,
            extra: undefined,
            deniedResources: () => Effect.die("ordinary glob must not add a read inspection"),
            ask: (request) => Effect.sync(() => asks.push(request.permission)).pipe(Effect.andThen(rules.ask(request))),
          },
        )
        expect(result.output).toContain("visible.txt")
        expect(asks).toEqual(["glob"])
      }),
    { git: true },
  )

  it.instance(
    "ordinary read keeps its existing directory ask and listing behavior",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        yield* Effect.promise(() => fs.writeFile(path.join(test.directory, "sensitive.txt"), "ordinary listing\n"))
        const rules = context(["sensitive.txt"])
        const asks: string[] = []
        const info = yield* ReadTool
        const read = yield* info.init()
        const result = yield* read.execute(
          { filePath: test.directory },
          {
            ...rules,
            extra: undefined,
            deniedResources: () => Effect.die("ordinary read must not add a listing inspection"),
            ask: (request) => Effect.sync(() => asks.push(request.permission)).pipe(Effect.andThen(rules.ask(request))),
          },
        )
        expect(result.output).toContain("sensitive.txt")
        expect(asks).toEqual(["read"])
      }),
    { git: true },
  )

  it.instance(
    "a restricted listing without a permission inspector refuses",
    () =>
      Effect.gen(function* () {
        const info = yield* GlobTool
        const glob = yield* info.init()
        expect(
          Exit.isFailure(
            yield* glob.execute({ pattern: "*" }, { ...context([]), deniedResources: undefined }).pipe(Effect.exit),
          ),
        ).toBe(true)
        const readInfo = yield* ReadTool
        const read = yield* readInfo.init()
        const test = yield* TestInstance
        expect(
          Exit.isFailure(
            yield* read
              .execute({ filePath: test.directory }, { ...context([]), deniedResources: undefined })
              .pipe(Effect.exit),
          ),
        ).toBe(true)
      }),
    { git: true },
  )

  it.live("a real Git worktree inherits absolute requester denials from its source placement", () =>
    Effect.gen(function* () {
      const source = yield* tmpdirScoped({ git: true })
      const worktree = yield* tmpdirScoped()
      const repository = yield* Git.Service
      yield* Effect.promise(() =>
        fs.writeFile(path.join(source, "sensitive.txt"), "VECTOR_AUTHORITY_MARKER WITHHELD\n"),
      )
      yield* Effect.promise(() => fs.writeFile(path.join(source, "visible.txt"), "VECTOR_AUTHORITY_MARKER VISIBLE\n"))
      expect((yield* repository.run(["add", "."], { cwd: source })).exitCode).toBe(0)
      expect((yield* repository.run(["commit", "-m", "source content"], { cwd: source })).exitCode).toBe(0)
      expect((yield* repository.run(["worktree", "add", "--detach", worktree, "HEAD"], { cwd: source })).exitCode).toBe(
        0,
      )
      yield* provideInstance(worktree)(
        exercise({
          directory: worktree,
          readRoot: source,
          denied: path.join(source, "sensitive.txt"),
          protectedFile: path.join(worktree, "sensitive.txt"),
          visibleFile: path.join(worktree, "visible.txt"),
        }),
      )
    }),
  )

  it.instance(
    "an absolute file deny protects Read, Grep and Glob through a directory symlink",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        yield* Effect.promise(() => fs.mkdir(path.join(test.directory, "private")))
        const protectedFile = path.join(test.directory, "private/sensitive.txt")
        const visibleFile = path.join(test.directory, "visible.txt")
        yield* Effect.promise(() => fs.writeFile(protectedFile, "VECTOR_AUTHORITY_MARKER WITHHELD\n"))
        yield* Effect.promise(() => fs.writeFile(visibleFile, "VECTOR_AUTHORITY_MARKER VISIBLE\n"))
        yield* Effect.promise(() =>
          fs.symlink(
            path.join(test.directory, "private"),
            path.join(test.directory, "alias"),
            process.platform === "win32" ? "junction" : "dir",
          ),
        )
        yield* exercise({
          directory: test.directory,
          denied: protectedFile,
          protectedFile,
          visibleFile,
          alias: path.join(test.directory, "alias/sensitive.txt"),
        })
      }),
    { git: true },
  )

  it.live("nested placement and a symlinked root retain the actual worktree-relative denial", () =>
    Effect.gen(function* () {
      const root = yield* tmpdirScoped({ git: true })
      const linkParent = yield* tmpdirScoped()
      const nested = path.join(root, "nested")
      yield* Effect.promise(() => fs.mkdir(nested))
      yield* Effect.promise(() =>
        fs.symlink(root, path.join(linkParent, "root-alias"), process.platform === "win32" ? "junction" : "dir"),
      )
      const protectedFile = path.join(nested, "sensitive.txt")
      const visibleFile = path.join(nested, "visible.txt")
      yield* Effect.promise(() => fs.writeFile(protectedFile, "VECTOR_AUTHORITY_MARKER WITHHELD\n"))
      yield* Effect.promise(() => fs.writeFile(visibleFile, "VECTOR_AUTHORITY_MARKER VISIBLE\n"))
      yield* provideInstance(nested)(
        exercise({
          directory: nested,
          denied: path.join(linkParent, "root-alias/nested/sensitive.txt"),
          protectedFile,
          visibleFile,
        }),
      )
    }),
  )
})
