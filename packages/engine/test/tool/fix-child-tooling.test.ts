import { afterEach, describe, expect } from "bun:test"
import path from "path"
import fs from "fs/promises"
import { LayerNode } from "@vectordevai/core/effect/layer-node"
import { CrossSpawnSpawner } from "@vectordevai/core/cross-spawn-spawner"
import { ConnectPolicy } from "@vectordevai/core/connect/policy"
import { Effect } from "effect"
import { FSUtil } from "@vectordevai/core/fs-util"
import { LSP } from "@/lsp/lsp"
import { Truncate } from "@/tool/truncate"
import { EditTool } from "../../src/tool/edit"
import { WriteTool } from "../../src/tool/write"
import { ApplyPatchTool } from "../../src/tool/apply_patch"
import { Format } from "../../src/format"
import { Instruction } from "../../src/session/instruction"
import { Agent } from "../../src/agent/agent"
import { EventV2Bridge } from "../../src/event-v2-bridge"
import { FileState } from "../../src/tool/file-state"
import { SessionID, MessageID } from "../../src/session/schema"
import { disposeAllInstances, TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

// CW-07: a connect fix child (ConnectPolicy.FIX_AGENT) starts no project tooling. The trusted project's formatter appends
// "formatted" to the file it formats; the build agent's edit, write and patch run it, connect_fix's do not, and the
// change itself is applied either way.

afterEach(async () => {
  await disposeAllInstances()
})

const it = testEffect(
  LayerNode.compile(
    LayerNode.group([
      LSP.node,
      FSUtil.node,
      EventV2Bridge.node,
      Format.node,
      CrossSpawnSpawner.node,
      Truncate.node,
      Agent.node,
      Instruction.node,
    ]),
  ),
)

const options = {
  trusted: true,
  config: {
    formatter: {
      marker: {
        extensions: [".fmt"],
        command: ["bun", path.join(import.meta.dir, "../fixture/formatter-append.js"), "formatted", "$FILE"],
      },
    },
  },
}

const context = (agent: string, sessionID: string) => ({
  sessionID: SessionID.make(sessionID),
  messageID: MessageID.make("msg_test"),
  callID: "",
  agent,
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => Effect.void,
  ask: () => Effect.void,
})

const read = (file: string) => Effect.promise(() => fs.readFile(file, "utf8"))

describe("connect fix child tooling (CW-07)", () => {
  for (const agent of ["build", ConnectPolicy.FIX_AGENT]) {
    const runs = agent === "build"

    it.instance(
      `edit ${runs ? "runs" : "never runs"} the project's formatter for ${agent}`,
      () =>
        Effect.gen(function* () {
          const test = yield* TestInstance
          const file = path.join(test.directory, "edit.fmt")
          const ctx = context(agent, "ses_test-fix-tooling-edit")
          yield* Effect.promise(() => fs.writeFile(file, "before\n", "utf8"))
          FileState.record(ctx.sessionID, file, yield* FileState.stamp(file))
          const info = yield* EditTool
          const tool = yield* info.init()
          yield* tool.execute({ filePath: file, oldString: "before", newString: "after" }, ctx)
          expect(yield* read(file)).toBe(runs ? "after\nformatted" : "after\n")
        }),
      options,
    )

    it.instance(
      `write ${runs ? "runs" : "never runs"} the project's formatter for ${agent}`,
      () =>
        Effect.gen(function* () {
          const test = yield* TestInstance
          const file = path.join(test.directory, "write.fmt")
          const info = yield* WriteTool
          const tool = yield* info.init()
          yield* tool.execute({ filePath: file, content: "written\n" }, context(agent, "ses_test-fix-tooling-write"))
          expect(yield* read(file)).toBe(runs ? "written\nformatted" : "written\n")
        }),
      options,
    )

    it.instance(
      `apply_patch ${runs ? "runs" : "never runs"} the project's formatter for ${agent}`,
      () =>
        Effect.gen(function* () {
          const test = yield* TestInstance
          const file = path.join(test.directory, "patch.fmt")
          const info = yield* ApplyPatchTool
          const tool = yield* info.init()
          yield* tool.execute(
            { patchText: "*** Begin Patch\n*** Add File: patch.fmt\n+patched\n*** End Patch" },
            context(agent, "ses_test-fix-tooling-patch"),
          )
          expect(yield* read(file)).toBe(runs ? "patched\nformatted" : "patched\n")
        }),
      options,
    )
  }
})
