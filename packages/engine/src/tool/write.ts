import { Schema } from "effect"
import * as path from "path"
import { Effect } from "effect"
import * as Tool from "./tool"
import { LSP } from "@/lsp/lsp"
import { createTwoFilesPatch } from "diff"
import DESCRIPTION from "./write.txt"
import { EventV2Bridge } from "@/event-v2-bridge"
import { FileSystem } from "@vectordevai/core/filesystem"
import { Watcher } from "@vectordevai/core/filesystem/watcher"
import { Format } from "../format"
import { FSUtil } from "@vectordevai/core/fs-util"
import { InstanceState } from "@/effect/instance-state"
import { trimDiff } from "./edit"
import { assertExternalDirectoryEffect } from "./external-directory"
import { assertOwnedPath } from "./owned-path"
import { FileLock } from "./file-lock"
import { FileState } from "./file-state"
import * as Bom from "@/util/bom"
import { Instruction } from "../session/instruction"
import { SessionMemory } from "../session/memory"

const MAX_PROJECT_DIAGNOSTICS_FILES = 5

export const Parameters = Schema.Struct({
  content: Schema.String.annotate({ description: "The content to write to the file" }),
  filePath: Schema.String.annotate({
    description: "The absolute path to the file to write (must be absolute, not relative)",
  }),
})

export const WriteTool = Tool.define(
  "write",
  Effect.gen(function* () {
    const lsp = yield* LSP.Service
    const fs = yield* FSUtil.Service
    const events = yield* EventV2Bridge.Service
    const format = yield* Format.Service
    const instruction = yield* Instruction.Service

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: { content: string; filePath: string }, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const instance = yield* InstanceState.context
          const filepath = path.isAbsolute(params.filePath)
            ? params.filePath
            : path.join(instance.directory, params.filePath)
          yield* assertExternalDirectoryEffect(ctx, filepath)
          yield* assertOwnedPath(ctx, filepath)

          const next = Bom.split(params.content)
          const contentNew = next.text
          const before = yield* FileState.observe(filepath)
          const check = (now: FileState.Observed | undefined) =>
            FileState.verify({
              sessionID: ctx.sessionID,
              file: filepath,
              now: now?.stamp,
              kind: "update",
              messages: ctx.messages,
              tool: "write",
              inFamily: ctx.inFamily,
            })
          yield* check(before)
          const source = before ? Bom.decode(before.bytes) : { bom: false, text: "" }
          const contentOld = source.text

          const diff = trimDiff(createTwoFilesPatch(filepath, filepath, contentOld, contentNew))
          yield* ctx.ask({
            permission: "edit",
            patterns: [path.relative(instance.worktree, filepath)],
            always: ["*"],
            metadata: {
              filepath,
              diff,
            },
          })

          // Never held across the ask. A change since the read above passes only when this session made it.
          const { exists, fileState } = yield* FileLock.withFiles([filepath])(
            Effect.gen(function* () {
              const current = yield* FileState.observe(filepath)
              if (!FileState.same(current?.stamp, before?.stamp)) yield* check(current)
              const bom = (current ? Bom.decode(current.bytes).bom : false) || next.bom
              if (ctx.assertWritable) yield* ctx.assertWritable({ files: [filepath] })
              yield* FileLock.write(fs, filepath, Bom.join(contentNew, bom))
              if (yield* format.file(filepath)) {
                yield* Bom.syncFile(fs, filepath, bom)
              }
              const fileState = yield* FileState.commit({
                sessionID: ctx.sessionID,
                file: filepath,
                title: typeof ctx.extra?.subagentTitle === "string" ? ctx.extra.subagentTitle : undefined,
              })
              yield* events.publish(FileSystem.Event.Edited, {
                file: filepath,
                sessionID: ctx.sessionID,
                agent: ctx.agent,
                messageID: ctx.messageID,
              })
              yield* events.publish(Watcher.Event.Updated, {
                file: filepath,
                event: current ? "change" : "add",
              })
              return { exists: current !== undefined, fileState }
            }),
          )

          let output = "Wrote file successfully."
          yield* lsp.touchFile(filepath, "document")
          const diagnostics = yield* lsp.diagnostics()
          const normalizedFilepath = FSUtil.normalizePath(filepath)
          let projectDiagnosticsCount = 0
          for (const [file, issues] of Object.entries(diagnostics)) {
            const current = file === normalizedFilepath
            if (!current && projectDiagnosticsCount >= MAX_PROJECT_DIAGNOSTICS_FILES) continue
            const block = LSP.Diagnostic.report(current ? filepath : file, issues)
            if (!block) continue
            if (current) {
              output += `\n\nLSP errors detected in this file, please fix:\n${block}`
              continue
            }
            projectDiagnosticsCount++
            output += `\n\nLSP errors detected in other files:\n${block}`
          }

          const guarded = yield* instruction.guard(ctx.messages, [filepath], ctx.messageID, SessionMemory.linking(ctx))
          return {
            title: path.relative(instance.worktree, filepath),
            metadata: {
              diagnostics,
              filepath,
              exists: exists,
              fileState,
              ...(guarded.links.length ? { [Instruction.LINKS]: guarded.links } : {}),
            },
            output: guarded.text ? `${output}\n\n${guarded.text}` : output,
          }
        }).pipe(Effect.orDie),
    }
  }),
)
