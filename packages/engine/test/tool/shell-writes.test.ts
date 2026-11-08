import { describe, expect } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { Effect, Exit, Layer } from "effect"
import { LayerNode } from "@vectordevai/core/effect/layer-node"
import { CrossSpawnSpawner } from "@vectordevai/core/cross-spawn-spawner"
import { FSUtil } from "@vectordevai/core/fs-util"
import type { PermissionV1 } from "@vectordevai/core/v1/permission"
import { Config } from "@/config/config"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Tool } from "@/tool/tool"
import { Truncate } from "@/tool/truncate"
import { Agent } from "../../src/agent/agent"
import { Plugin } from "../../src/plugin"
import { MessageID, SessionID } from "../../src/session/schema"
import { ShellTool } from "../../src/tool/shell"
import { provideInstance, testInstanceStoreLayer, tmpdirScoped } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

// The files a bash command writes by name, without a redirect (section 8.2): they ask what the edit tool asks, so the
// edit rules and the prompt guard see them. Best effort: the common write commands only. Every command stops at its
// shell ask, before it runs.

const it = testEffect(
  Layer.mergeAll(
    LayerNode.compile(
      LayerNode.group([
        CrossSpawnSpawner.node,
        FSUtil.node,
        Plugin.node,
        Truncate.node,
        Config.node,
        Agent.node,
        RuntimeFlags.node,
      ]),
    ),
    testInstanceStoreLayer,
  ),
)

type Asked = Omit<PermissionV1.Request, "id" | "sessionID" | "tool">

// The files a command's edit ask names, relative to the repository, or none when it asks no edit.
const written = Effect.fn("ShellWritesTest.written")(function* (command: string) {
  const asked: Asked[] = []
  const info = yield* ShellTool
  const shell = yield* info.init()
  const exit = yield* shell
    .execute({ command }, {
      sessionID: SessionID.make("ses_test"),
      messageID: MessageID.make("msg_test"),
      callID: "",
      agent: "build",
      abort: AbortSignal.any([]),
      messages: [],
      metadata: () => Effect.void,
      ask: (req: Asked) =>
        Effect.sync(() => {
          asked.push(req)
          if (req.permission === "bash") throw new Error("stop before running")
        }),
    } satisfies Tool.Context)
    .pipe(Effect.exit)
  expect(Exit.isFailure(exit)).toBe(true)
  return (asked.find((req) => req.permission === "edit")?.patterns ?? []).map((item) => item.replaceAll("\\", "/"))
})

// The permissions a command asks for before it would run, in order.
const permissions = Effect.fn("ShellWritesTest.permissions")(function* (command: string) {
  const asked: string[] = []
  const info = yield* ShellTool
  const shell = yield* info.init()
  yield* shell
    .execute({ command }, {
      sessionID: SessionID.make("ses_test"),
      messageID: MessageID.make("msg_test"),
      callID: "",
      agent: "build",
      abort: AbortSignal.any([]),
      messages: [],
      metadata: () => Effect.void,
      ask: (req: Asked) =>
        Effect.sync(() => {
          asked.push(req.permission)
          if (req.permission === "bash") throw new Error("stop before running")
        }),
    } satisfies Tool.Context)
    .pipe(Effect.exit)
  return asked
})

describe.skipIf(process.platform === "win32")("the agent marker", () => {
  // Owner-only commands refuse under the marker, so dropping it would run one as the owner: that asks every time.
  it.live("a command that removes or overrides the marker asks agent_marker; others do not", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped({ git: true })
      yield* Effect.gen(function* () {
        for (const command of [
          "env -u VECTOR_AGENT_SESSION vector memory skills approve s4k2q7m",
          "unset VECTOR_AGENT_SESSION; vector trust prompts approve",
          "VECTOR_AGENT_SESSION= vector trust prompts approve",
          "env -i PATH=/usr/bin vector trust prompts approve",
          "/usr/bin/env - vector trust approve",
          "exec -c vector memory skills approve s4k2q7m",
        ])
          expect(yield* permissions(command)).toContain("agent_marker")
        for (const command of ["vector memory skills list", "env FOO=1 node -i", "git status"])
          expect(yield* permissions(command)).not.toContain("agent_marker")
      }).pipe(provideInstance(dir))
    }),
  )
})

describe.skipIf(process.platform === "win32")("shell writes", () => {
  it.live("asks edit for what cp, mv, install, ln, tee, sed -i and dd write", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped({ git: true })
      yield* Effect.promise(() => fs.mkdir(path.join(dir, "out"), { recursive: true }))
      yield* Effect.gen(function* () {
        expect(yield* written("cp a.txt b.txt")).toEqual(["b.txt"])
        // Into a folder, each source keeps its name; -t names the folder first.
        expect(yield* written("cp a.txt 'c d.txt' out")).toEqual(["out/a.txt", "out/c d.txt"])
        expect(yield* written("mv -t out a.txt")).toEqual(["out/a.txt"])
        expect(yield* written("install -m 644 a.txt bin/tool")).toEqual(["bin/tool"])
        expect(yield* written("ln -s a.txt link.txt")).toEqual(["link.txt"])
        expect(yield* written("echo hi | tee -a one.log two.log")).toEqual(["one.log", "two.log"])
        // The script is not a file, whether it comes first, after BSD sed's '' suffix, or by -e.
        expect(yield* written("sed -i 's/a/b/' x.ts y.ts")).toEqual(["x.ts", "y.ts"])
        expect(yield* written("sed -i '' -e 's/a/b/' x.ts")).toEqual(["x.ts"])
        expect(yield* written("dd if=a.txt of=disk.img")).toEqual(["disk.img"])
      }).pipe(provideInstance(dir))
    }),
  )

  it.live("a target spelled with $HOME or $XDG_CONFIG_HOME asks for the file it lands on", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped({ git: true })
      // Relative to the repository, as every edit ask names its files.
      const home = (file: string) => path.relative(dir, path.join(os.homedir(), file)).replaceAll("\\", "/")
      const config = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config")
      yield* Effect.gen(function* () {
        expect(yield* written("cp planted.md $HOME/.config/vector/agents/build.md")).toEqual([
          home(".config/vector/agents/build.md"),
        ])
        expect(yield* written('cat x > "$HOME/.config/vector/AGENTS.md"')).toEqual([home(".config/vector/AGENTS.md")])
        expect(yield* written("cp x ${HOME}/.vector/agents/build.md")).toEqual([home(".vector/agents/build.md")])
        expect(yield* written("tee $XDG_CONFIG_HOME/vector/AGENTS.md < x")).toEqual([
          path.relative(dir, path.join(config, "vector", "AGENTS.md")).replaceAll("\\", "/"),
        ])
        // Single quotes keep the text as written, and another variable stays unknown.
        expect(yield* written("cp x '$HOME/a.md'")).toEqual(["'$HOME/a.md'"])
        expect(yield* written("cp x $HOMEDIR/a.md")).toEqual(["$HOMEDIR/a.md"])
      }).pipe(provideInstance(dir))
    }),
  )

  it.live("asks no edit for commands that only read or only make folders", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped({ git: true })
      yield* Effect.gen(function* () {
        expect(yield* written("sed 's/a/b/' x.ts")).toEqual([])
        expect(yield* written("install -d build/bin")).toEqual([])
        expect(yield* written("cat a.txt")).toEqual([])
        expect(yield* written("dd if=a.txt")).toEqual([])
      }).pipe(provideInstance(dir))
    }),
  )
})
