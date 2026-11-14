import { afterEach, expect } from "bun:test"
import path from "node:path"
import fs from "node:fs/promises"
import { Deferred, Effect, Exit } from "effect"
import { LayerNode } from "@vectordevai/core/effect/layer-node"
import { CrossSpawnSpawner } from "@vectordevai/core/cross-spawn-spawner"
import { FSUtil } from "@vectordevai/core/fs-util"
import { Agent } from "@/agent/agent"
import { InstanceState } from "@/effect/instance-state"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Format } from "@/format"
import { LSP } from "@/lsp/lsp"
import { Instruction } from "@/session/instruction"
import { MessageID, SessionID } from "@/session/schema"
import { TaskClaims } from "@/task/claims"
import { FileState } from "@/tool/file-state"
import { assertWritable } from "@/tool/owned-path"
import type { Tool } from "@/tool/tool"
import { Truncate } from "@/tool/truncate"
import { WriteTool } from "@/tool/write"
import { disposeAllInstances } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(
  LayerNode.compile(
    LayerNode.group([
      Agent.node,
      CrossSpawnSpawner.node,
      EventV2Bridge.node,
      Format.node,
      FSUtil.node,
      Instruction.node,
      LSP.node,
      Truncate.node,
    ]),
  ),
)

afterEach(async () => {
  for (const claim of TaskClaims.claims) TaskClaims.release(claim)
  await disposeAllInstances()
})

it.instance("actual write tools recheck implicit ownership inside the file lock even when bytes stay equal", () =>
  Effect.gen(function* () {
    const instance = yield* InstanceState.context
    const file = path.join(instance.directory, "same.txt")
    yield* Effect.promise(() => fs.writeFile(file, "same bytes"))
    const bothAsked = yield* Deferred.make<void>()
    const counters = { asked: 0, checked: 0 }
    const contexts = ["ses_writer_a", "ses_writer_b"].map((id): Tool.Context => {
      const sessionID = SessionID.make(id)
      const claim = TaskClaims.reserve({
        tree: instance.worktree,
        directory: instance.directory,
        parentSessionID: "ses_root",
        taskID: id,
        title: id,
        paths: [],
      })
      TaskClaims.bind(claim, id)
      const context: Tool.Context = {
        sessionID,
        parentID: SessionID.make("ses_root"),
        messageID: MessageID.ascending(),
        agent: "build",
        abort: new AbortController().signal,
        messages: [],
        metadata: () => Effect.void,
        ask: () =>
          Effect.gen(function* () {
            counters.asked++
            if (counters.asked === 2) yield* Deferred.succeed(bothAsked, undefined)
            yield* Deferred.await(bothAsked)
          }),
      }
      context.assertWritable = (input) =>
        Effect.sync(() => {
          counters.checked++
        }).pipe(Effect.andThen(assertWritable(context, input)))
      return context
    })
    for (const context of contexts) FileState.record(context.sessionID, file, yield* FileState.stamp(file))
    const tool = yield* WriteTool
    const definition = yield* tool.init()
    const results = yield* Effect.forEach(
      contexts,
      (context) => definition.execute({ filePath: file, content: "same bytes" }, context).pipe(Effect.exit),
      { concurrency: 2 },
    )
    expect(results.filter(Exit.isSuccess)).toHaveLength(1)
    expect(results.filter(Exit.isFailure)).toHaveLength(1)
    expect(counters).toEqual({ asked: 2, checked: 2 })
    expect(yield* Effect.promise(() => fs.readFile(file, "utf8"))).toBe("same bytes")
  }),
)
