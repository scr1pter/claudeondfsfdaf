import { Billing } from "@vectordevai/schema/billing"
import { Session } from "@/session/session"
import { SessionID } from "../../session/schema"
import { effectCmd, fail } from "../effect-cmd"
import { UI } from "../ui"
import * as prompts from "@clack/prompts"
import { EOL } from "os"
import { Effect, Schema } from "effect"
import { PublicSession } from "@vectordevai/schema/public-session"
import { PublicSessionShare } from "@vectordevai/core/public-session-share"
import { SessionArchive } from "@vectordevai/core/share/archive"

function redact(kind: string, id: string, value: string) {
  return value.trim() ? `[redacted:${kind}:${id}]` : value
}

function data(kind: string, id: string, value: Record<string, unknown> | undefined) {
  if (!value) return value
  return Object.keys(value).length ? { redacted: `${kind}:${id}` } : value
}

function span(id: string, value: { value: string; start: number; end: number }) {
  return {
    ...value,
    value: redact("file-text", id, value.value),
  }
}

function diff<T extends { file?: string; patch?: string }>(kind: string, diffs: readonly T[] | undefined) {
  return diffs?.map((item, i) => ({
    ...item,
    file: item.file === undefined ? undefined : redact(`${kind}-file`, String(i), item.file),
    patch: item.patch === undefined ? undefined : redact(`${kind}-patch`, String(i), item.patch),
  }))
}

type ArchivePart = SessionArchive.Legacy["messages"][number]["parts"][number]
type ArchiveFile = Extract<ArchivePart, { type: "file" }>

function source(part: ArchiveFile) {
  if (!part.source) return part.source
  if (part.source.type === "symbol") {
    return {
      ...part.source,
      path: redact("file-path", part.id, part.source.path),
      name: redact("file-symbol", part.id, part.source.name),
      text: span(part.id, part.source.text),
    }
  }
  if (part.source.type === "resource") {
    return {
      ...part.source,
      clientName: redact("file-client", part.id, part.source.clientName),
      uri: redact("file-uri", part.id, part.source.uri),
      text: span(part.id, part.source.text),
    }
  }
  return {
    ...part.source,
    path: redact("file-path", part.id, part.source.path),
    text: span(part.id, part.source.text),
  }
}

function filepart(part: ArchiveFile): ArchiveFile {
  return {
    ...part,
    url: redact("file-url", part.id, part.url),
    filename: part.filename === undefined ? undefined : redact("file-name", part.id, part.filename),
    source: source(part),
  }
}

function part(part: ArchivePart) {
  switch (part.type) {
    case "text":
      return {
        ...part,
        text: redact("text", part.id, part.text),
        metadata: data("text-metadata", part.id, part.metadata),
      }
    case "reasoning":
      return {
        ...part,
        text: redact("reasoning", part.id, part.text),
        metadata: data("reasoning-metadata", part.id, part.metadata),
      }
    case "file":
      return filepart(part)
    case "subtask":
      return {
        ...part,
        prompt: redact("subtask-prompt", part.id, part.prompt),
        description: redact("subtask-description", part.id, part.description),
        command: part.command === undefined ? undefined : redact("subtask-command", part.id, part.command),
      }
    case "tool":
      return {
        ...part,
        metadata: data("tool-metadata", part.id, part.metadata),
        state:
          part.state.status === "pending"
            ? {
                ...part.state,
                input: data("tool-input", part.id, part.state.input) ?? part.state.input,
                raw: redact("tool-raw", part.id, part.state.raw),
              }
            : part.state.status === "running"
              ? {
                  ...part.state,
                  input: data("tool-input", part.id, part.state.input) ?? part.state.input,
                  title: part.state.title === undefined ? undefined : redact("tool-title", part.id, part.state.title),
                  metadata: data("tool-state-metadata", part.id, part.state.metadata),
                }
              : part.state.status === "completed"
                ? {
                    ...part.state,
                    input: data("tool-input", part.id, part.state.input) ?? part.state.input,
                    output: redact("tool-output", part.id, part.state.output),
                    title: redact("tool-title", part.id, part.state.title),
                    metadata: data("tool-state-metadata", part.id, part.state.metadata) ?? part.state.metadata,
                    attachments: part.state.attachments?.map(filepart),
                  }
                : {
                    ...part.state,
                    input: data("tool-input", part.id, part.state.input) ?? part.state.input,
                    metadata: data("tool-state-metadata", part.id, part.state.metadata),
                  },
      }
    case "patch":
      return {
        ...part,
        hash: redact("patch", part.id, part.hash),
        files: part.files.map((item: string, i: number) => redact("patch-file", `${part.id}-${i}`, item)),
      }
    case "snapshot":
      return {
        ...part,
        snapshot: redact("snapshot", part.id, part.snapshot),
      }
    case "step-start":
      return {
        ...part,
        snapshot: part.snapshot === undefined ? undefined : redact("snapshot", part.id, part.snapshot),
      }
    case "step-finish":
      return {
        ...part,
        snapshot: part.snapshot === undefined ? undefined : redact("snapshot", part.id, part.snapshot),
      }
    case "agent":
      return {
        ...part,
        source: !part.source
          ? part.source
          : {
              ...part.source,
              value: redact("agent-source", part.id, part.source.value),
            },
      }
    default:
      return part
  }
}

const partFn = part

export function sanitizeLegacy(data: SessionArchive.Legacy) {
  const codiumMessages = new Set(
    data.messages
      .filter(
        (message) =>
          message.info.role === "assistant" &&
          (Billing.of(message.info) || message.parts.some((part) => part.type === "step-finish" && Billing.of(part))),
      )
      .map((message) => message.info.id),
  )
  const info = { ...data.info }
  if (data.info.tokensOwnOnly !== true) delete info.tokens
  if (data.info.subagentTokensOwnOnly !== true) delete info.subagentTokens
  return {
    // The privacy, guest-input and usage markers travel with the archive: an import may only tighten them.
    ...data,
    info: {
      ...info,
      title: redact("session-title", data.info.id, data.info.title),
      directory: redact("session-directory", data.info.id, data.info.directory),
      summary: !data.info.summary
        ? data.info.summary
        : {
            ...data.info.summary,
            diffs: diff("session-diff", data.info.summary.diffs),
          },
      revert: !data.info.revert
        ? data.info.revert
        : {
            ...data.info.revert,
            snapshot:
              data.info.revert.snapshot === undefined
                ? undefined
                : redact("revert-snapshot", data.info.id, data.info.revert.snapshot),
            diff:
              data.info.revert.diff === undefined
                ? undefined
                : redact("revert-diff", data.info.id, data.info.revert.diff),
          },
    },
    messages: data.messages.map((msg) => ({
      info:
        msg.info.role === "user"
          ? {
              ...msg.info,
              system: msg.info.system === undefined ? undefined : redact("system", msg.info.id, msg.info.system),
              summary: !msg.info.summary
                ? msg.info.summary
                : {
                    ...msg.info.summary,
                    title:
                      msg.info.summary.title === undefined
                        ? undefined
                        : redact("summary-title", msg.info.id, msg.info.summary.title),
                    body:
                      msg.info.summary.body === undefined
                        ? undefined
                        : redact("summary-body", msg.info.id, msg.info.summary.body),
                    diffs: diff("message-diff", msg.info.summary.diffs),
                  },
            }
          : {
              ...withoutTokens(msg.info, codiumMessages.has(msg.info.id), Billing.hasOwnIdentity(msg.info)),
              path: {
                cwd: redact("cwd", msg.info.id, msg.info.path.cwd),
                root: redact("root", msg.info.id, msg.info.path.root),
              },
            },
      parts: msg.parts.map((part) => {
        const redacted = partFn(part)
        return part.type === "step-finish"
          ? withoutTokens(
              redacted,
              Boolean(Billing.of(part) || (msg.info.role === "assistant" && Billing.of(msg.info))),
              msg.info.role === "assistant" && Billing.hasOwnIdentity(msg.info),
            )
          : redacted
      }),
    })),
  }
}

function withoutTokens<T extends object>(value: T, codium: boolean, own = false) {
  if (!codium && own) return value
  const result: Partial<T> & { tokens?: unknown; billing?: "codium" } = {
    ...value,
    ...(codium ? { billing: "codium" as const } : {}),
  }
  delete result.tokens
  return result
}

export const ExportCommand = effectCmd({
  command: "export [sessionID]",
  describe: "export session data as JSON",
  builder: (yargs) =>
    yargs
      .positional("sessionID", {
        describe: "session id to export",
        type: "string",
      })
      .option("public", {
        describe: "write a portable archive of visible history for local use",
        type: "boolean",
      })
      .option("sanitize", {
        describe: "redact sensitive transcript and file data (native sessions use the portable format)",
        type: "boolean",
      }),
  handler: Effect.fn("Cli.export")(function* (args) {
    return yield* run(args)
  }),
})

const run = Effect.fn("Cli.export.body")(function* (args: {
  sessionID?: string
  sanitize?: boolean
  public?: boolean
}) {
  const shares = yield* PublicSessionShare.Service
  const svc = yield* Session.Service
  let sessionID = args.sessionID ? SessionID.make(args.sessionID) : undefined
  process.stderr.write(`Exporting session: ${sessionID ?? "latest"}\n`)

  if (!sessionID) {
    UI.empty()
    prompts.intro("Export session", { output: process.stderr })

    const sessions = yield* svc.list()

    if (sessions.length === 0) {
      prompts.log.error("No sessions found", { output: process.stderr })
      prompts.outro("Done", { output: process.stderr })
      return
    }

    sessions.sort((a, b) => b.time.updated - a.time.updated)

    const selectedSession = yield* Effect.promise(() =>
      prompts.autocomplete({
        message: "Select session to export",
        maxItems: 10,
        options: sessions.map((session) => ({
          label: session.title,
          value: session.id,
          hint: `${new Date(session.time.updated).toLocaleString()} • ${session.id.slice(-8)}`,
        })),
        output: process.stderr,
      }),
    )

    if (prompts.isCancel(selectedSession)) {
      return yield* Effect.die(new UI.CancelledError())
    }

    sessionID = selectedSession

    prompts.outro("Exporting session...", { output: process.stderr })
  }

  return yield* Effect.gen(function* () {
    const local = yield* shares.export({ sessionID: sessionID! })
    const portable = args.public || (args.sanitize && "engine" in local)
    // The portable format has no owner-only marker, and an import treats it as ordinary guest input. A conversation
    // with isolated work would lose its restriction, so it is exported only in the local format, which keeps it.
    if (portable && local.privacy === "owner-only")
      return yield* fail(
        "This conversation has owner-only isolated work, so it cannot be exported in the portable format. Export it without --public or --sanitize to keep its owner-only marker.",
      )
    const output = portable
      ? yield* shares
          .preview({ sessionID: sessionID! })
          .pipe(Effect.map((archive) => (args.sanitize ? sanitizePublic(archive) : archive)))
      : "engine" in local
        ? Schema.encodeSync(SessionArchive.Native)(local)
        : args.sanitize
          ? sanitizeLegacy(local)
          : local
    process.stdout.write(JSON.stringify(output, null, 2))
    process.stdout.write(EOL)
  }).pipe(Effect.catchTag("PublicSessionError", (error) => fail(error.message)))
})

function sanitizePublic(archive: PublicSession.Archive): PublicSession.Archive {
  return {
    ...archive,
    title: redact("session-title", "archive", archive.title),
    messages: archive.messages.map((message) => ({
      ...message,
      parts: message.parts.map((part, index): PublicSession.Part => {
        const id = `${message.id}:${index}`
        if (part.type === "tool")
          return {
            ...part,
            name: redact("tool-name", id, part.name),
            callID: redact("tool-call", id, part.callID),
            input: redact("tool-input", id, part.input),
            output: redact("tool-output", id, part.output),
          }
        if (part.type === "attachment") return { ...part, name: redact("file-name", id, part.name) }
        return { ...part, text: redact(part.type, id, part.text) }
      }),
    })),
  }
}
