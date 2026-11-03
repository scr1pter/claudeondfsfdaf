import { LayerNode } from "@vectordevai/core/effect/layer-node"
import { Cause, Duration, Effect, Layer, Option, Schedule, Context } from "effect"
import path from "path"
import type { Agent } from "../agent/agent"
import { FSUtil } from "@vectordevai/core/fs-util"
import { Config } from "@/config/config"
import { Identifier } from "../id/id"
import { ToolID } from "./schema"
import { TRUNCATION_DIR } from "./truncation-dir"
import { WebFence } from "@vectordevai/core/research/fence"

const RETENTION = Duration.days(7)

export const MAX_LINES = 2000
export const MAX_BYTES = 50 * 1024
export const DIR = TRUNCATION_DIR
export const GLOB = path.join(TRUNCATION_DIR, "*")

export type Result = { content: string; truncated: false } | { content: string; truncated: true; outputPath: string }

// A background command's log (`shell-<shl_ id>.log`, 5.H), named by an ID that encodes when the command started.
const SHELL_LOG = /^shell-(shl_[0-9a-f]{12}[0-9A-Za-z]{14})\.log$/
// Logs a command this process still runs. Cleanup leaves them, however long the command has been quiet.
const held = new Set<string>()

/** Keeps a file in the tool-output directory from cleanup until the returned release is called. */
export function hold(file: string) {
  const name = path.basename(file)
  held.add(name)
  return () => {
    held.delete(name)
  }
}

// What output() writes beside the part of a text it keeps: how much it left out, and where the whole text is.
// A Grep or a ranged Read of the saved file costs far less than a subagent that starts from an empty context.
function notice(removed: number, unit: "bytes" | "lines", file: string) {
  return `...${removed} ${unit} truncated...\n\nThe tool call succeeded but the output was truncated. Full output saved to: ${file}\nUse Grep to search the full content or Read with offset/limit to view specific sections.`
}

/** The most output() adds to the text it keeps when it cuts, for callers fitting several cut texts into one output. */
export const NOTICE = {
  bytes: Buffer.byteLength(`\n\n${notice(Number.MAX_SAFE_INTEGER, "bytes", path.join(DIR, `${"x".repeat(40)}.web`))}`),
  lines: 5,
} as const

export interface Options {
  maxLines?: number
  maxBytes?: number
  direction?: "head" | "tail"
  /** What the saved file holds in place of the text, such as a web page in its fence; built only when it is saved. */
  save?: () => string
}

export interface Interface {
  readonly cleanup: () => Effect.Effect<void>
  readonly write: (text: string) => Effect.Effect<string>
  /**
   * Returns output unchanged when it fits within the limits, otherwise writes the full text
   * to the truncation directory and returns a preview plus a hint to inspect the saved file.
   */
  readonly output: (text: string, options?: Options, agent?: Agent.Info) => Effect.Effect<Result>
  /**
   * Resolved truncation limits: values from `tool_output` in vector config, or MAX_LINES / MAX_BYTES if unset.
   */
  readonly limits: () => Effect.Effect<{ maxLines: number; maxBytes: number }>
}

export class Service extends Context.Service<Service, Interface>()("@vector/Truncate") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const fs = yield* FSUtil.Service

    const cleanup = Effect.fn("Truncate.cleanup")(function* () {
      const now = Date.now()
      const cutoff = Identifier.timestamp(Identifier.create("tool", "ascending", now - Duration.toMillis(RETENTION)))
      const entries = yield* fs.readDirectory(TRUNCATION_DIR).pipe(
        // The directory also holds retained artifacts. Only generated tool IDs
        // encode a timestamp; unrelated names must not abort or enter cleanup.
        // A saved web page ends in `.web`, so Grep and Read know to fence it.
        Effect.map((all) =>
          all.filter((name) => /^tool_[0-9a-f]{12}[0-9A-Za-z]{14}(?:\.web)?$/.test(name) || SHELL_LOG.test(name)),
        ),
        Effect.catch(() => Effect.succeed([])),
      )
      for (const entry of entries) {
        const file = path.join(TRUNCATION_DIR, entry)
        const command = SHELL_LOG.exec(entry)?.[1]
        if (Identifier.timestamp(command ?? entry.replace(/\.web$/, "")) >= cutoff) continue
        if (command) {
          // A command's log goes once its command started and last wrote more than RETENTION ago, and never while this
          // process still runs it. A command another engine still runs keeps writing to its log, so a recent write keeps
          // it too.
          if (held.has(entry)) continue
          const written = yield* fs.stat(file).pipe(
            Effect.map((info) => Option.getOrUndefined(info.mtime)?.getTime() ?? now),
            Effect.catch(() => Effect.succeed(now)),
          )
          if (written >= now - Duration.toMillis(RETENTION)) continue
        }
        yield* fs.remove(file).pipe(Effect.catch(() => Effect.void))
      }
    })

    const write = Effect.fn("Truncate.write")(function* (text: string) {
      const file = path.join(TRUNCATION_DIR, WebFence.savedName(ToolID.ascending(), text))
      yield* fs.ensureDir(TRUNCATION_DIR).pipe(Effect.orDie)
      yield* fs.writeFileString(file, text).pipe(Effect.orDie)
      return file
    })

    const limits = Effect.fn("Truncate.limits")(function* () {
      const configSvc = yield* Effect.serviceOption(Config.Service)
      if (Option.isNone(configSvc)) return { maxLines: MAX_LINES, maxBytes: MAX_BYTES }
      const cfg = yield* configSvc.value.get().pipe(Effect.catch(() => Effect.succeed(undefined)))
      return {
        maxLines: cfg?.tool_output?.max_lines ?? MAX_LINES,
        maxBytes: cfg?.tool_output?.max_bytes ?? MAX_BYTES,
      }
    })

    const output = Effect.fn("Truncate.output")(function* (text: string, options: Options = {}, _agent?: Agent.Info) {
      const resolved = yield* limits()
      const maxLines = options.maxLines ?? resolved.maxLines
      const maxBytes = options.maxBytes ?? resolved.maxBytes
      const direction = options.direction ?? "head"
      const lines = text.split("\n")
      const totalBytes = Buffer.byteLength(text, "utf-8")

      if (lines.length <= maxLines && totalBytes <= maxBytes) {
        return { content: text, truncated: false } as const
      }

      const out: string[] = []
      let i = 0
      let bytes = 0
      let hitBytes = false

      if (direction === "head") {
        for (i = 0; i < lines.length && i < maxLines; i++) {
          const size = Buffer.byteLength(lines[i], "utf-8") + (i > 0 ? 1 : 0)
          if (bytes + size > maxBytes) {
            hitBytes = true
            // A single line longer than the whole budget, such as minified HTML or a JSON blob, still shows its start.
            if (out.length === 0) {
              out.push(slice(lines[i], maxBytes, "start"))
              bytes += Buffer.byteLength(out[0], "utf-8")
            }
            break
          }
          out.push(lines[i])
          bytes += size
        }
      } else {
        for (i = lines.length - 1; i >= 0 && out.length < maxLines; i--) {
          const size = Buffer.byteLength(lines[i], "utf-8") + (out.length > 0 ? 1 : 0)
          if (bytes + size > maxBytes) {
            hitBytes = true
            if (out.length === 0) {
              out.unshift(slice(lines[i], maxBytes, "end"))
              bytes += Buffer.byteLength(out[0], "utf-8")
            }
            break
          }
          out.unshift(lines[i])
          bytes += size
        }
      }

      const removed = hitBytes ? totalBytes - bytes : lines.length - out.length
      const unit = hitBytes ? "bytes" : "lines"
      const preview = out.join("\n")
      const file = yield* write(options.save?.() ?? text)
      const cut = notice(removed, unit, file)

      return {
        content: direction === "head" ? `${preview}\n\n${cut}` : `${cut}\n\n${preview}`,
        truncated: true,
        outputPath: file,
      } as const
    })

    yield* cleanup().pipe(
      Effect.catchCause((cause) => Effect.logError("truncation cleanup failed", { cause: Cause.pretty(cause) })),
      Effect.repeat(Schedule.spaced(Duration.hours(1))),
      Effect.delay(Duration.minutes(1)),
      Effect.forkScoped,
    )

    return Service.of({ cleanup, write, output, limits })
  }),
)

export const node = LayerNode.make({ service: Service, layer: layer, deps: [FSUtil.node] })

// At most `bytes` bytes from one end of a line, cut on a character boundary.
function slice(line: string, bytes: number, from: "start" | "end") {
  const buffer = Buffer.from(line, "utf-8")
  return from === "start"
    ? buffer
        .subarray(0, bytes)
        .toString("utf-8")
        .replace(/\uFFFD$/, "")
    : buffer
        .subarray(buffer.length - bytes)
        .toString("utf-8")
        .replace(/^\uFFFD/, "")
}

export * as Truncate from "./truncate"
