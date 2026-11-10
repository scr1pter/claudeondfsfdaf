import * as path from "path"
import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Watcher } from "@vectordevai/core/filesystem/watcher"
import { InstanceState } from "@/effect/instance-state"
import { Patch } from "../patch"
import { createTwoFilesPatch, diffLines } from "diff"
import { assertExternalDirectoryEffect } from "./external-directory"
import { assertOwnedPath } from "./owned-path"
import { FileLock } from "./file-lock"
import { FileState } from "./file-state"
import { trimDiff } from "./edit"
import { LSP } from "@/lsp/lsp"
import { FSUtil } from "@vectordevai/core/fs-util"
import DESCRIPTION from "./apply_patch.txt"
import { FileSystem } from "@vectordevai/core/filesystem"
import { Format } from "../format"
import * as Bom from "@/util/bom"
import { Instruction } from "../session/instruction"
import { SessionMemory } from "../session/memory"

export const Parameters = Schema.Struct({
  patchText: Schema.String.annotate({ description: "The full patch text that describes all changes to be made" }),
})

export const ApplyPatchTool = Tool.define(
  "apply_patch",
  Effect.gen(function* () {
    const lsp = yield* LSP.Service
    const afs = yield* FSUtil.Service
    const format = yield* Format.Service
    const events = yield* EventV2Bridge.Service
    const instruction = yield* Instruction.Service

    const run = Effect.fn("ApplyPatchTool.execute")(function* (
      params: Schema.Schema.Type<typeof Parameters>,
      ctx: Tool.Context,
    ) {
      if (!params.patchText) {
        return yield* Effect.fail(new Error("patchText is required"))
      }

      // Parse the patch to get hunks
      let hunks: Patch.Hunk[]
      let recoveredMissingBegin = false
      try {
        const parseResult = Patch.parsePatch(params.patchText)
        hunks = parseResult.hunks
        recoveredMissingBegin = parseResult.recoveredMissingBegin === true
      } catch (error) {
        return yield* Effect.fail(new Error(`apply_patch verification failed: ${error}`))
      }

      if (hunks.length === 0) {
        const normalized = params.patchText.replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim()
        if (normalized === "*** Begin Patch\n*** End Patch") {
          return yield* Effect.fail(new Error("patch rejected: empty patch"))
        }
        return yield* Effect.fail(new Error("apply_patch verification failed: no hunks found"))
      }

      const instance = yield* InstanceState.context

      // Validate file paths and check permissions
      const fileChanges: Array<{
        filePath: string
        oldContent: string
        newContent: string
        type: "add" | "update" | "delete" | "move"
        movePath?: string
        diff: string
        additions: number
        deletions: number
        bom: boolean
        hunk: Patch.Hunk
        // The file, and the move target, as they were when the patch was checked.
        before?: FileState.Observed
        target?: FileState.Observed
      }> = []

      let totalDiff = ""

      const check = (file: string, now: FileState.Observed | undefined, kind: FileState.Kind) =>
        FileState.verify({
          sessionID: ctx.sessionID,
          file,
          now: now?.stamp,
          kind,
          messages: ctx.messages,
          tool: "apply_patch",
          inFamily: ctx.inFamily,
        })
      const count = (from: string, to: string) => {
        let additions = 0
        let deletions = 0
        for (const change of diffLines(from, to)) {
          if (change.added) additions += change.count || 0
          if (change.removed) deletions += change.count || 0
        }
        return { additions, deletions }
      }
      // An update's new text, worked out on the file as it is.
      const derive = Effect.fnUntraced(function* (
        filePath: string,
        hunk: Extract<Patch.Hunk, { type: "update" }>,
        current: FileState.Observed,
      ) {
        const source = Bom.decode(current.bytes)
        try {
          const fileUpdate = Patch.deriveNewContentsFromChunks(filePath, hunk.chunks, Bom.join(source.text, source.bom))
          return { oldContent: source.text, newContent: fileUpdate.content, bom: fileUpdate.bom }
        } catch (error) {
          return yield* Effect.fail(new Error(`apply_patch verification failed: ${error}`))
        }
      })

      for (const hunk of hunks) {
        const filePath = path.resolve(instance.directory, hunk.path)
        yield* assertExternalDirectoryEffect(ctx, filePath)
        yield* assertOwnedPath(ctx, filePath)

        switch (hunk.type) {
          case "add": {
            const oldContent = ""
            const newContent =
              hunk.contents.length === 0 || hunk.contents.endsWith("\n") ? hunk.contents : `${hunk.contents}\n`
            const next = Bom.split(newContent)
            yield* check(filePath, yield* FileState.observe(filePath), "create")
            const diff = trimDiff(createTwoFilesPatch(filePath, filePath, oldContent, next.text))

            fileChanges.push({
              filePath,
              oldContent,
              newContent: next.text,
              type: "add",
              diff,
              ...count(oldContent, next.text),
              bom: next.bom,
              hunk,
            })

            totalDiff += diff + "\n"
            break
          }

          case "update": {
            // Check if file exists for update
            const stats = yield* afs.stat(filePath).pipe(Effect.catch(() => Effect.succeed(undefined)))
            const before = stats && stats.type !== "Directory" ? yield* FileState.observe(filePath) : undefined
            if (!before) {
              return yield* Effect.fail(
                new Error(`apply_patch verification failed: Failed to read file to update: ${filePath}`),
              )
            }
            yield* check(filePath, before, "update")

            const { oldContent, newContent, bom } = yield* derive(filePath, hunk, before)
            const diff = trimDiff(createTwoFilesPatch(filePath, filePath, oldContent, newContent))

            const movePath = hunk.move_path ? path.resolve(instance.directory, hunk.move_path) : undefined
            yield* assertExternalDirectoryEffect(ctx, movePath)
            if (movePath) yield* assertOwnedPath(ctx, movePath)
            // Writing the moved file over another is a change to that one too.
            const target =
              movePath && FileLock.key(movePath) !== FileLock.key(filePath)
                ? yield* FileState.observe(movePath)
                : undefined
            if (movePath && FileLock.key(movePath) !== FileLock.key(filePath)) yield* check(movePath, target, "update")

            fileChanges.push({
              filePath,
              oldContent,
              newContent,
              type: hunk.move_path ? "move" : "update",
              movePath,
              diff,
              ...count(oldContent, newContent),
              bom,
              hunk,
              before,
              target,
            })

            totalDiff += diff + "\n"
            break
          }

          case "delete": {
            const before = yield* FileState.observe(filePath).pipe(
              Effect.flatMap((observed) =>
                observed ? Effect.succeed(observed) : Effect.fail(new Error(`File not found: ${filePath}`)),
              ),
              Effect.mapError((error) => new Error(`apply_patch verification failed: ${error.message}`)),
            )
            yield* check(filePath, before, "update")
            const contentToDelete = Bom.decode(before.bytes).text
            const deleteDiff = trimDiff(createTwoFilesPatch(filePath, filePath, contentToDelete, ""))

            const deletions = contentToDelete.split("\n").length

            fileChanges.push({
              filePath,
              oldContent: contentToDelete,
              newContent: "",
              type: "delete",
              diff: deleteDiff,
              additions: 0,
              deletions,
              bom: false,
              hunk,
              before,
            })

            totalDiff += deleteDiff + "\n"
            break
          }
        }
      }

      // Build per-file metadata for UI rendering (used for both permission and result)
      const files = () =>
        fileChanges.map((change) => ({
          filePath: change.filePath,
          relativePath: path.relative(instance.worktree, change.movePath ?? change.filePath).replaceAll("\\", "/"),
          type: change.type,
          patch: change.diff,
          additions: change.additions,
          deletions: change.deletions,
          movePath: change.movePath,
        }))

      // Check permissions if needed. Move targets are asked for too, so the asks for prompt and memory files see them.
      const relative = (file: string) => path.relative(instance.worktree, file).replaceAll("\\", "/")
      const relativePaths = fileChanges.map((c) => relative(c.filePath))
      const targets = fileChanges.flatMap((c) => (c.movePath ? [relative(c.movePath)] : []))
      yield* ctx.ask({
        permission: "edit",
        patterns: [...new Set([...relativePaths, ...targets])],
        always: ["*"],
        metadata: {
          filepath: relativePaths.join(", "),
          diff: totalDiff,
          files: files(),
        },
      })

      // Apply the changes under every file's lock, never held across the ask. Each file is read again first and nothing
      // is written unless all pass: this session's own change since passes and the patch applies to the new text.
      const updates: Array<{ file: string; event: "add" | "change" | "unlink" }> = []
      const fileStates: FileState.Entry[] = []
      const title = typeof ctx.extra?.subagentTitle === "string" ? ctx.extra.subagentTitle : undefined
      yield* FileLock.withFiles(
        fileChanges.flatMap((change) => [change.filePath, ...(change.movePath ? [change.movePath] : [])]),
      )(
        Effect.gen(function* () {
          for (const change of fileChanges) {
            const current = yield* FileState.observe(change.filePath)
            if (!FileState.same(current?.stamp, change.before?.stamp)) {
              if (change.type === "add") yield* check(change.filePath, current, "create")
              else if (!current)
                return yield* Effect.fail(
                  new Error(`apply_patch verification failed: Failed to read file to update: ${change.filePath}`),
                )
              else yield* check(change.filePath, current, "update")
              if (current && change.hunk.type === "update") {
                const next = yield* derive(change.filePath, change.hunk, current)
                change.oldContent = next.oldContent
                change.newContent = next.newContent
                change.bom = next.bom
                change.diff = trimDiff(
                  createTwoFilesPatch(change.filePath, change.filePath, next.oldContent, next.newContent),
                )
                Object.assign(change, count(next.oldContent, next.newContent))
              }
            }
            if (change.movePath && FileLock.key(change.movePath) !== FileLock.key(change.filePath)) {
              const target = yield* FileState.observe(change.movePath)
              if (!FileState.same(target?.stamp, change.target?.stamp)) yield* check(change.movePath, target, "update")
            }
          }

          if (ctx.assertWritable)
            yield* ctx.assertWritable({
              files: fileChanges.flatMap((change) => [change.filePath, ...(change.movePath ? [change.movePath] : [])]),
            })

          for (const change of fileChanges) {
            const edited = change.type === "delete" ? undefined : (change.movePath ?? change.filePath)
            switch (change.type) {
              case "add":
                yield* FileLock.write(afs, change.filePath, Bom.join(change.newContent, change.bom))
                updates.push({ file: change.filePath, event: "add" })
                break

              case "update":
                yield* FileLock.write(afs, change.filePath, Bom.join(change.newContent, change.bom))
                updates.push({ file: change.filePath, event: "change" })
                break

              case "move":
                if (change.movePath) {
                  yield* FileLock.write(afs, change.movePath, Bom.join(change.newContent, change.bom))
                  yield* afs.remove(change.filePath)
                  updates.push({ file: change.filePath, event: "unlink" })
                  updates.push({ file: change.movePath, event: "add" })
                }
                break

              case "delete":
                yield* afs.remove(change.filePath)
                updates.push({ file: change.filePath, event: "unlink" })
                break
            }

            if (edited) {
              if (yield* format.file(edited)) {
                yield* Bom.syncFile(afs, edited, change.bom)
              }
            }
            fileStates.push(yield* FileState.commit({ sessionID: ctx.sessionID, file: change.filePath, title }))
            if (change.movePath && FileLock.key(change.movePath) !== FileLock.key(change.filePath))
              fileStates.push(yield* FileState.commit({ sessionID: ctx.sessionID, file: change.movePath, title }))
            if (edited) {
              yield* events.publish(FileSystem.Event.Edited, {
                file: edited,
                sessionID: ctx.sessionID,
                agent: ctx.agent,
                messageID: ctx.messageID,
              })
            }
          }

          // Publish file change events
          for (const update of updates) {
            yield* events.publish(Watcher.Event.Updated, update)
          }
        }),
      )

      // Notify LSP of file changes and collect diagnostics
      for (const change of fileChanges) {
        if (change.type === "delete") continue
        const target = change.movePath ?? change.filePath
        yield* lsp.touchFile(target, "document")
      }
      const diagnostics = yield* lsp.diagnostics()

      // Generate output summary
      const summaryLines = fileChanges.map((change) => {
        if (change.type === "add") {
          return `A ${path.relative(instance.worktree, change.filePath).replaceAll("\\", "/")}`
        }
        if (change.type === "delete") {
          return `D ${path.relative(instance.worktree, change.filePath).replaceAll("\\", "/")}`
        }
        const target = change.movePath ?? change.filePath
        return `M ${path.relative(instance.worktree, target).replaceAll("\\", "/")}`
      })
      let output = `Success. Updated the following files:\n${summaryLines.join("\n")}`

      for (const change of fileChanges) {
        if (change.type === "delete") continue
        const target = change.movePath ?? change.filePath
        const block = LSP.Diagnostic.report(target, diagnostics[FSUtil.normalizePath(target)] ?? [])
        if (!block) continue
        const rel = path.relative(instance.worktree, target).replaceAll("\\", "/")
        output += `\n\nLSP errors detected in ${rel}, please fix:\n${block}`
      }
      const guarded = yield* instruction.guard(
        ctx.messages,
        fileChanges.flatMap((change) => (change.type === "delete" ? [] : [change.movePath ?? change.filePath])),
        ctx.messageID,
        SessionMemory.linking(ctx),
      )

      return {
        title: output,
        metadata: {
          diff: fileChanges.map((change) => change.diff).join("\n") + "\n",
          files: files(),
          diagnostics,
          fileStates,
          ...(recoveredMissingBegin ? { recoveredMissingBegin: true } : {}),
          ...(guarded.links.length ? { [Instruction.LINKS]: guarded.links } : {}),
        },
        output: guarded.text ? `${output}\n\n${guarded.text}` : output,
      }
    })

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        run(params, ctx).pipe(Effect.orDie),
    }
  }),
)
