import path from "path"
import { Effect, Schema } from "effect"
import { InstanceState } from "@/effect/instance-state"
import { FSUtil } from "@vectordevai/core/fs-util"
import { Ripgrep } from "@vectordevai/core/ripgrep"
import { WebFence } from "@vectordevai/core/research/fence"
import { assertExternalDirectoryEffect, readPatterns } from "./external-directory"
import { ProcessIsolation } from "@vectordevai/core/process-isolation"
import { heldReason, holdbackLines, holdbackText } from "@vectordevai/core/review/holdback"
import { holdbackSpelling } from "@vectordevai/core/review/permission"
import type { Match } from "@vectordevai/schema/filesystem"
import DESCRIPTION from "./grep.txt"
import * as Tool from "./tool"

// Under VS-34's holdback "secrets": how many matches ripgrep may give before the lines that redaction would change are
// withheld (see `clean`), the largest file whose lines are redacted as one text rather than one at a time, and how
// many bytes of such files one search may read again. A change can commit many large files whose matching lines are
// all withheld, so without the last a search could read and redact up to HOLDBACK_SCAN of them (about 30 ms each at
// the size cap); with it a search reads at most 16 MiB again (about half a second) and then reads as truncated.
const HOLDBACK_SCAN = 1000
const HOLDBACK_FILE_BYTES = 1024 * 1024
const HOLDBACK_REREAD_BYTES = 16 * 1024 * 1024

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

    // Under holdback, the first `want` matches whose line redaction leaves as it is, in ripgrep's order, each with its
    // whole line. A line that would show `[redacted]` is withheld rather than shown redacted: that it matched would
    // still say whether the pattern matched inside the value, so a search for a token's first characters could spell
    // it out. A file is redacted as one text, as the read tool redacts the lines it reads, so a private key's header
    // still marks its body, and ripgrep's cut (Ripgrep.LINE_CAP) cannot leave part of a token behind. A file over
    // HOLDBACK_FILE_BYTES is redacted a line at a time and gives no line ripgrep cut; a line the file no longer holds,
    // or a file that cannot be read again, gives none. The file that would take the bytes read again past
    // HOLDBACK_REREAD_BYTES is not read, and the search stops there (`stopped`).
    const clean = Effect.fn("GrepTool.clean")(function* (cwd: string, result: readonly Match[], want: number) {
      const kept: Match[] = []
      let left = HOLDBACK_REREAD_BYTES
      for (const [file, items] of Map.groupBy(result, (item) => item.entry.path)) {
        if (kept.length >= want) break
        const absolute = path.resolve(cwd, file)
        const size = yield* fs.stat(absolute).pipe(
          Effect.map((info) => Number(info.size)),
          Effect.catch(() => Effect.succeed(undefined)),
        )
        if (size === undefined) continue
        const whole = size <= HOLDBACK_FILE_BYTES
        if (whole && size > left) return { kept: kept.slice(0, want), stopped: true }
        if (whole) left -= size
        kept.push(
          ...(yield* Effect.gen(function* () {
            const lines = whole
              ? (yield* fs.readFileString(absolute)).split("\n").map((line) => line.replace(/\r$/, ""))
              : undefined
            const redacted = lines && holdbackLines(lines)
            return items.flatMap((item) => {
              const line = item.text.replace(/\r?\n$/, "")
              const cut = item.text.length === Ripgrep.LINE_CAP + 3 && item.text.endsWith("...")
              if (!lines) return !cut && holdbackText(line) === line ? [item] : []
              const full = lines[item.line - 1]
              if (full === undefined || (full !== line && !(cut && line === full.slice(0, Ripgrep.LINE_CAP) + "...")))
                return []
              return redacted?.[item.line - 1] === full ? [{ ...item, text: full }] : []
            })
          }).pipe(Effect.catch(() => Effect.succeed([])))),
        )
      }
      return { kept: kept.slice(0, want), stopped: false }
    })

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
          // VS-34's tool half (SF-14), set by the session runtime for a review session under holdback "secrets".
          const holdback = ctx.extra?.holdback === "secrets"

          const ins = yield* InstanceState.context
          const requested = path.isAbsolute(params.path ?? ins.directory)
            ? (params.path ?? ins.directory)
            : path.join(ins.directory, params.path ?? ".")
          ProcessIsolation.assertToolPath(requested)
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
          // The search runs where links resolve to, but a read denial can name a link: every file keeps the name the
          // caller reached it by as well as the one it resolved to.
          const spelled = path.resolve(FSUtil.windowsPath(requested))
          const resources = (...files: string[]) => [
            ...new Set(
              [...new Set(files)]
                .flatMap((file) => readPatterns(ins.worktree, file))
                .map((resource) => resource.replaceAll("\\", "/")),
            ),
          ]
          const candidates =
            info.type === "File"
              ? [
                  {
                    file: `./${path.basename(search)}`,
                    resources: resources(spelled, search),
                  },
                ]
              : (yield* ripgrep.find({
                  cwd,
                  pattern: params.include ?? "*",
                  hidden: true,
                  limit: Number.MAX_SAFE_INTEGER,
                })).map((entry) => ({
                  file: `./${entry.path}`,
                  resources: resources(path.resolve(spelled, entry.path), path.resolve(cwd, entry.path)),
                }))
          const read = { permission: "read", patterns: [...new Set(candidates.flatMap((entry) => entry.resources))] }
          // The runtime supplies its actual agent/session deny ceiling. Embedders
          // without inspection still authorize the whole batch before any content is read.
          const denied =
            info.type === "Directory" && ctx.deniedResources
              ? new Set(yield* ctx.deniedResources(read))
              : new Set<string>()
          const admitted = candidates.filter((entry) => !entry.resources.some((resource) => denied.has(resource)))
          if (!admitted.length) return empty
          yield* ctx.ask({
            ...read,
            patterns: [...new Set(admitted.flatMap((entry) => entry.resources))],
            always: ["*"],
            metadata: { path: params.path, include: params.include },
          })
          // Under holdback the session's read rules are read again with every spelling folded (NFC, lowercased), as the
          // read tool reads them, so a file whose case or normal form the platform's rules let through is never
          // searched, and one named directly is refused as read refuses it.
          const folded = (entry: (typeof admitted)[number]) => entry.resources.map(holdbackSpelling)
          const refused = holdback
            ? new Set(
                ctx.deniedResources
                  ? yield* ctx.deniedResources({ permission: "read", patterns: [...new Set(admitted.flatMap(folded))] })
                  : admitted.flatMap(folded),
              )
            : new Set<string>()
          const searched = admitted.filter((entry) => !folded(entry).some((resource) => refused.has(resource)))
          if (!searched.length && info.type === "File")
            return yield* Effect.fail(
              new Error(
                `${params.path ?? "."} may hold credentials, so this review does not search it (holdback "secrets"); nothing was read.`,
              ),
            )
          if (!searched.length) return empty
          const limit = 100
          const result = yield* ripgrep.grep({
            cwd,
            pattern: params.pattern,
            // ripgrep searches a directory, so a file target has to be named
            // explicitly or every sibling in its directory gets searched too.
            // The prefix also keeps a literal "-" from being interpreted as stdin.
            file: info.type === "File" ? searched[0].file : undefined,
            files: info.type === "Directory" ? searched.map((entry) => entry.file) : undefined,
            include: params.include,
            // One over the limit distinguishes "exactly limit matches" from
            // "more than we are showing"; only the first limit are reported.
            // Under holdback more, so that withheld lines still leave as many.
            limit: holdback ? HOLDBACK_SCAN : limit + 1,
          })
          // The backstop of design item 2, apart from the session's rules: under holdback no line comes from a path
          // holdback itself would hold back (SECRET_FILES, the env files but templates, CREDENTIAL_FILES), by its path
          // in the worktree or in the search, folded as the rules' paths are.
          const listed = (item: Match) =>
            [item.entry.path, path.relative(ins.worktree, path.resolve(cwd, item.entry.path))].some(
              (file) => heldReason(holdbackSpelling(file)) !== undefined,
            )
          const cleaned = holdback
            ? yield* clean(
                cwd,
                result.filter((item) => !listed(item)),
                limit + 1,
              )
            : undefined
          const shown = cleaned ? cleaned.kept : result
          // Under holdback a scan that reached its cap, or stopped at its budget, may have missed lines it would show,
          // so it reads as truncated, with no match shown too.
          const truncated =
            shown.length > limit || (cleaned !== undefined && (cleaned.stopped || result.length >= HOLDBACK_SCAN))
          if (shown.length === 0 && !truncated) return empty

          const final = shown.slice(0, limit).map((item) => {
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
