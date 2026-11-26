export * as Ripgrep from "./ripgrep"

import { Context, Effect, Fiber, Layer, Schema, Stream } from "effect"
import { ChildProcess } from "effect/unstable/process"
import { Entry, Match } from "@vectordevai/schema/filesystem"
import { makeGlobalNode } from "./effect/app-node"
import { AppProcess, collectStream, waitForAbort } from "./process"
import { NonNegativeInt, PositiveInt, RelativePath } from "./schema"
import { RipgrepBinary } from "./ripgrep/binary"

/**
 * Small core-owned ripgrep execution adapter. It deliberately exposes raw
 * process-oriented rows, not model text or permission behavior. Search maps
 * these rows into filesystem results; leaf tools own
 * presentation and permission prompts.
 */

const ERROR_BYTES = 8 * 1024
const MAX_RECORD_BYTES = 64 * 1024
const MAX_SUBMATCHES = 100

// The longest line a grep match carries whole: a longer one is cut to this many characters and marked with "...".
// The grep tool reads it to tell a cut line from a whole one (VS-34's holdback).
export const LINE_CAP = 2_000

// Ripgrep gives text that is not valid UTF-8 (a Latin-1 line, a file name in another encoding) as base64 `bytes`.
const RawText = Schema.Union([Schema.Struct({ text: Schema.String }), Schema.Struct({ bytes: Schema.String })])

const RawMatch = Schema.Struct({
  type: Schema.Literal("match"),
  data: Schema.Struct({
    path: RawText,
    lines: RawText,
    line_number: PositiveInt,
    absolute_offset: NonNegativeInt,
    submatches: Schema.Array(
      Schema.Struct({
        match: RawText,
        start: NonNegativeInt,
        end: NonNegativeInt,
      }),
    ),
  }),
})

type RawMatchData = {
  readonly path: string
  readonly lines: string
  readonly line_number: number
  readonly absolute_offset: number
  readonly submatches: readonly { readonly text: string; readonly start: number; readonly end: number }[]
}

// Bytes read as UTF-8 the way a file read as UTF-8 is, each bad sequence a replacement character.
const decoded = (raw: typeof RawText.Type) => ("text" in raw ? raw.text : Buffer.from(raw.bytes, "base64").toString("utf8"))

export class Error extends Schema.TaggedErrorClass<Error>()("Ripgrep.Error", {
  message: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}

export class InvalidPatternError extends Schema.TaggedErrorClass<InvalidPatternError>()("Ripgrep.InvalidPatternError", {
  pattern: Schema.String,
  message: Schema.String,
}) {}

export interface FindInput {
  readonly cwd: string
  readonly pattern: string
  readonly limit: number
  readonly hidden?: boolean
  readonly follow?: boolean
  readonly signal?: AbortSignal
  readonly onEntry?: (entry: Entry) => Effect.Effect<void>
}

export interface GlobInput {
  readonly cwd: string
  readonly pattern: string
  readonly limit: number
  readonly hidden?: boolean
  readonly follow?: boolean
  readonly signal?: AbortSignal
}

export interface GrepInput {
  readonly cwd: string
  readonly pattern: string
  readonly file?: string
  /** An exact admitted file set; an empty set searches nothing. */
  readonly files?: readonly string[]
  readonly include?: string
  readonly limit: number
  /** At most this many matching lines from each file. */
  readonly maxCount?: number
  readonly signal?: AbortSignal
}

export interface Interface {
  readonly find: (input: FindInput) => Effect.Effect<readonly Entry[], Error>
  readonly glob: (input: GlobInput) => Effect.Effect<readonly Entry[], Error>
  readonly grep: (input: GrepInput) => Effect.Effect<readonly Match[], Error | InvalidPatternError>
}

export class Service extends Context.Service<Service, Interface>()("@vector/v2/Ripgrep") {}

const failure = (message: string, cause?: unknown) => new Error({ message, cause })

const isInvalidPattern = (stderr: string) =>
  stderr.includes("regex parse error") || stderr.includes("error parsing regex")

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const process = yield* AppProcess.Service
    const binary = yield* RipgrepBinary.Service

    const run = <A>(input: {
      readonly cwd: string
      readonly args: string[]
      readonly limit: number
      readonly signal?: AbortSignal
      readonly parse: (line: string) => Effect.Effect<A | undefined, Error>
      readonly pattern?: string
      readonly nullDelimited?: boolean
      readonly onItem?: (item: A) => Effect.Effect<void>
    }) => {
      const program = Effect.scoped(
        Effect.gen(function* () {
          const handle = yield* process.spawn(
            ChildProcess.make(yield* binary.filepath, input.args, { cwd: input.cwd, extendEnv: true, stdin: "ignore" }),
          )
          const stderrFiber = yield* collectStream(handle.stderr, ERROR_BYTES).pipe(
            Effect.map((output) => output.buffer.toString("utf8")),
            Effect.forkScoped,
          )
          let observed = 0
          const rows = yield* Stream.decodeText(handle.stdout).pipe(
            // Newlines are legal in filenames. Only NUL delimits a complete
            // enumerated path; split lines could fabricate ../ search arguments.
            input.nullDelimited
              ? Stream.mapAccum(
                  () => "",
                  (pending, chunk: string) => {
                    const records = (pending + chunk).split("\0")
                    return [records.pop()!, records] as const
                  },
                )
              : Stream.splitLines,
            Stream.filter((line) => line.length > 0),
            Stream.mapEffect(input.parse),
            Stream.filter((row): row is A => row !== undefined),
            Stream.tap((row) => {
              if (!input.onItem || observed++ >= input.limit) return Effect.void
              return input.onItem(row)
            }),
            Stream.take(input.limit + 1),
            Stream.runCollect,
            Effect.map((chunk) => [...chunk]),
          )
          const truncated = rows.length > input.limit
          if (truncated) return { items: rows.slice(0, input.limit), truncated, partial: false }

          const code = yield* handle.exitCode
          const stderr = yield* Fiber.join(stderrFiber)
          if (input.pattern && code === 2 && isInvalidPattern(stderr)) {
            return yield* new InvalidPatternError({ pattern: input.pattern, message: stderr.trim() })
          }
          if (code !== 0 && code !== 1 && code !== 2) {
            return yield* failure(stderr.trim() || `ripgrep failed with code ${code}`)
          }
          return { items: code === 1 ? [] : rows, truncated: false, partial: code === 2 }
        }),
      )
      const abortable = input.signal ? program.pipe(Effect.raceFirst(waitForAbort(input.signal))) : program
      return abortable.pipe(
        Effect.mapError((cause) =>
          cause instanceof Error || cause instanceof InvalidPatternError
            ? cause
            : failure("ripgrep execution failed", cause),
        ),
      )
    }

    const grep = (input: GrepInput) =>
      run<RawMatchData>({
        ...input,
        args: [
          "--no-config",
          "--json",
          "--hidden",
          "--no-messages",
          ...(input.include ? [`--glob=${input.include}`] : []),
          ...(input.maxCount ? [`--max-count=${input.maxCount}`] : []),
          "--glob=!**/.git/**",
          "--",
          input.pattern,
          ...(input.files ?? [input.file ?? "."]),
        ],
        parse: (line) =>
          (Buffer.byteLength(line, "utf8") > MAX_RECORD_BYTES
            ? Effect.fail(failure(`Ripgrep JSON record exceeded ${MAX_RECORD_BYTES} bytes`))
            : Effect.try({
                try: () => JSON.parse(line) as unknown,
                catch: (cause) => failure("Invalid ripgrep JSON output", cause),
              })
          ).pipe(
            Effect.flatMap((json) => {
              if (!json || typeof json !== "object" || !("type" in json) || json.type !== "match")
                return Effect.succeed(undefined)
              return Schema.decodeUnknownEffect(RawMatch)(json).pipe(
                Effect.map((match): RawMatchData | undefined => {
                  // A file name that is not UTF-8 cannot be given back as a path to open, so only its match is left out.
                  if (!("text" in match.data.path)) return undefined
                  return {
                    path: match.data.path.text.replace(/^\.[\\/]/, ""),
                    lines: decoded(match.data.lines),
                    line_number: match.data.line_number,
                    absolute_offset: match.data.absolute_offset,
                    submatches: match.data.submatches.slice(0, MAX_SUBMATCHES).map((submatch) => ({
                      text: decoded(submatch.match),
                      start: submatch.start,
                      end: submatch.end,
                    })),
                  }
                }),
                Effect.mapError((cause) => failure("Invalid ripgrep match output", cause)),
              )
            }),
          ),
      }).pipe(
        Effect.map((result) =>
          result.items.map((match) => {
            const relative = match.path
              .replace(/^(?:\.[\\/])+/u, "")
              .replace(/^[\\/]+/u, "")
              .replaceAll("\\", "/")
            return Match.make({
              entry: Entry.make({
                path: RelativePath.make(relative),
                type: "file",
              }),
              line: match.line_number,
              offset: match.absolute_offset,
              text: match.lines.length > LINE_CAP ? match.lines.slice(0, LINE_CAP) + "..." : match.lines,
              submatches: match.submatches.map((submatch) => ({ ...submatch })),
            })
          }),
        ),
      )

    return Service.of({
      glob: (input) =>
        run<string>({
          cwd: input.cwd,
          limit: input.limit,
          signal: input.signal,
          nullDelimited: true,
          args: [
            "--no-config",
            "--files",
            "--null",
            ...(input.hidden ? ["--hidden"] : []),
            ...(input.follow ? ["--follow"] : []),
            `--glob=${input.pattern}`,
            "--glob=!**/.git/**",
            ".",
          ],
          parse: (line) =>
            Effect.succeed(
              line
                .replace(/^(?:\.[\\/])+/u, "")
                .replace(/^[\\/]+/u, "")
                .replaceAll("\\", "/"),
            ),
        }).pipe(
          Effect.map((result) =>
            result.items.map((relative) =>
              Entry.make({
                path: RelativePath.make(relative),
                type: "file",
              }),
            ),
          ),
          Effect.catchTag("Ripgrep.InvalidPatternError", (cause) => Effect.fail(failure(cause.message, cause))),
        ),
      find: (input) =>
        run<Entry>({
          cwd: input.cwd,
          limit: input.limit,
          signal: input.signal,
          nullDelimited: true,
          args: [
            "--no-config",
            "--files",
            "--null",
            ...(input.hidden ? ["--hidden"] : []),
            ...(input.follow ? ["--follow"] : []),
            ...(input.pattern === "*" ? [] : [`--glob=${input.pattern}`]),
            "--glob=!**/.git/**",
            ".",
          ],
          parse: (line) => {
            const relative = line
              .replace(/^(?:\.[\\/])+/u, "")
              .replace(/^[\\/]+/u, "")
              .replaceAll("\\", "/")
            return Effect.succeed(
              Entry.make({
                path: RelativePath.make(relative),
                type: "file",
              }),
            )
          },
          onItem: input.onEntry,
        }).pipe(
          Effect.map((result) => result.items),
          Effect.catchTag("Ripgrep.InvalidPatternError", (cause) => Effect.fail(failure(cause.message, cause))),
        ),
      grep: (input) => {
        const admitted = input.files
        if (!admitted) return grep(input)
        return Effect.gen(function* () {
          const batches: string[][] = []
          let bytes = 0
          for (const file of admitted) {
            // Keep each exact-file argv comfortably below platform argument limits.
            if (!batches.length || bytes + Buffer.byteLength(file) > 32_000) {
              batches.push([])
              bytes = 0
            }
            batches[batches.length - 1].push(file)
            bytes += Buffer.byteLength(file) + 1
          }
          const matches: Match[] = []
          for (const files of batches) {
            matches.push(...(yield* grep({ ...input, files, limit: input.limit - matches.length })))
            if (matches.length >= input.limit) break
          }
          return matches
        })
      },
    })
  }),
)

export const node = makeGlobalNode({ service: Service, layer: layer, deps: [RipgrepBinary.node, AppProcess.node] })
