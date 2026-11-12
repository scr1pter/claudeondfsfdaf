import path from "path"
import { Effect, Schema } from "effect"
import { InstanceState } from "@/effect/instance-state"
import { FSUtil } from "@vectordevai/core/fs-util"
import { Ripgrep } from "@vectordevai/core/ripgrep"
import { WebFence } from "@vectordevai/core/research/fence"
import { assertExternalDirectoryEffect } from "./external-directory"
import DESCRIPTION from "./grep.txt"
import * as Tool from "./tool"

export const Parameters = Schema.Struct({
  pattern: Schema.String.annotate({ description: "The regex pattern to search for in file contents" }),
  path: Schema.optional(Schema.String).annotate({
    description:
      "Existing literal file or directory to search. Relative paths use the current working directory, which is also the default. No shell or glob expansion; use include for file globs.",
  }),
  include: Schema.optional(Schema.String).annotate({
    description: 'File pattern to include in the search (e.g. "*.js", "*.{ts,tsx}")',
  }),
})

export const GrepTool = Tool.define(
  "grep",
  Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    const ripgrep = yield* Ripgrep.Service
    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: { pattern: string; path?: string; include?: string }, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const empty = {
            title: params.pattern,
            metadata: { matches: 0, truncated: false },
            output: "No files found",
          }
          if (!params.pattern) {
            throw new Error("pattern is required")
          }

          const ins = yield* InstanceState.context
          const requested = path.isAbsolute(params.path ?? ins.directory)
            ? (params.path ?? ins.directory)
            : path.join(ins.directory, params.path ?? ".")
          // A guest family may not search a private task folder or a folder holding one, nor learn through a stat or an
          // ask whether one exists.
          if (ctx.assertReadable) yield* ctx.assertReadable({ files: [requested], recursive: true })

          yield* ctx.ask({
            permission: "grep",
            patterns: [params.pattern],
            always: ["*"],
            metadata: {
              pattern: params.pattern,
              path: params.path,
              include: params.include,
            },
          })

          const requestedInfo = yield* fs.stat(requested).pipe(Effect.catch(() => Effect.succeed(undefined)))
          yield* assertExternalDirectoryEffect(ctx, requested, {
            bypass: false,
            kind: requestedInfo?.type === "Directory" ? "directory" : "file",
          })

          const search = FSUtil.resolve(requested)
          const info = yield* fs
            .stat(search)
            .pipe(
              Effect.catchReason("PlatformError", "NotFound", () =>
                Effect.fail(
                  new Error(
                    `Search path does not exist: ${params.path ?? "."}. 'path' is a literal file or directory; use 'include' for file globs.`,
                  ),
                ),
              ),
            )
          if (info.type !== "Directory" && info.type !== "File")
            return yield* Effect.fail(new Error(`Search path is not a file or directory: ${params.path ?? "."}`))
          const cwd = info.type === "Directory" ? search : path.dirname(search)
          const candidates =
            info.type === "File"
              ? [
                  {
                    file: `./${path.basename(search)}`,
                    resource: path.relative(ins.worktree, search).replaceAll("\\", "/"),
                  },
                ]
              : (yield* ripgrep.find({
                  cwd,
                  pattern: params.include ?? "*",
                  hidden: true,
                  limit: Number.MAX_SAFE_INTEGER,
                })).map((entry) => ({
                  file: `./${entry.path}`,
                  resource: path.relative(ins.worktree, path.resolve(cwd, entry.path)).replaceAll("\\", "/"),
                }))
          const read = { permission: "read", patterns: candidates.map((entry) => entry.resource) }
          // The runtime supplies its actual agent/session deny ceiling. Embedders
          // without inspection still authorize the whole batch before any content is read.
          const denied =
            info.type === "Directory" && ctx.deniedResources
              ? new Set(yield* ctx.deniedResources(read))
              : new Set<string>()
          const admitted = candidates.filter((entry) => !denied.has(entry.resource))
          if (!admitted.length) return empty
          yield* ctx.ask({
            ...read,
            patterns: admitted.map((entry) => entry.resource),
            always: ["*"],
            metadata: { path: params.path, include: params.include },
          })
          const limit = 100
          const result = yield* ripgrep.grep({
            cwd,
            pattern: params.pattern,
            // ripgrep searches a directory, so a file target has to be named
            // explicitly or every sibling in its directory gets searched too.
            // The prefix also keeps a literal "-" from being interpreted as stdin.
            file: info.type === "File" ? admitted[0].file : undefined,
            files: info.type === "Directory" ? admitted.map((entry) => entry.file) : undefined,
            include: params.include,
            // One over the limit distinguishes "exactly limit matches" from
            // "more than we are showing"; only the first limit are reported.
            limit: limit + 1,
          })
          if (result.length === 0) return empty

          const truncated = result.length > limit
          const final = result.slice(0, limit).map((item) => {
            const absolute = path.resolve(cwd, item.entry.path)
            const relative = path.relative(ins.directory, absolute)
            // ripgrep keeps each line's newline, which printed a blank line after every match; a minified or generated
            // line can run to thousands of characters, so a match shows the 500 around what it matched.
            const text = item.text.replace(/\r?\n$/, "")
            // Submatch offsets count bytes, the window counts characters.
            const at = Buffer.from(text, "utf-8")
              .subarray(0, item.submatches[0]?.start ?? 0)
              .toString("utf-8").length
            return {
              // Relative to the working directory, which read, edit and write resolve against, when it is inside it.
              path: relative.startsWith("..") || path.isAbsolute(relative) ? absolute : relative,
              absolute,
              line: item.line,
              text: excerpt(text, at),
            }
          })

          const total = final.length
          const render = (match: { line: number; text: string }) => `  Line ${match.line}: ${match.text}`
          // Lines from a page a web tool saved whole are web text, so they come back fenced again.
          const output = [
            `Found ${total} matches${truncated ? " (more matches available)" : ""}`,
            ...[...Map.groupBy(final, (match) => match.path).entries()].flatMap(([file, matches], index) => [
              ...(index > 0 ? [""] : []),
              `${file}:`,
              ...(WebFence.savedFile(matches[0]!.absolute)
                ? [WebFence.fenceLines({ tool: "grep", file: matches[0]!.absolute }, matches, render)]
                : matches.map(render)),
            ]),
          ]

          if (truncated) {
            output.push("")
            output.push("(Results truncated. Consider using a more specific path or pattern.)")
          }

          return {
            title: params.pattern,
            metadata: {
              matches: total,
              truncated,
            },
            output: output.join("\n"),
          }
        }).pipe(Effect.orDie),
    }
  }),
)

// 500 characters of a long line around position `at`, marked where the line goes on.
function excerpt(text: string, at: number) {
  if (text.length <= 500) return text
  const start = Math.max(0, Math.min(at - 200, text.length - 500))
  return `${start > 0 ? "…" : ""}${text.slice(start, start + 500)}${start + 500 < text.length ? "…" : ""}`
}
