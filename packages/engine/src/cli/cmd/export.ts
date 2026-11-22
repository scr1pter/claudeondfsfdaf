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
import { Hands } from "@vectordevai/schema/hands"
import { isRecord } from "@/util/record"
import { taskMetadata } from "./run/usage-output"

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
                    error: redact("tool-error", part.id, part.state.error),
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
    case "retry":
      return { ...part, error: redactError(part.id, part.error) }
    default:
      // A part kind this list does not name (compaction, or one a newer version adds) keeps only its identity and kind
      // and loses every string, so a new kind fails closed instead of passing through whole (F44b).
      return Object.fromEntries(
        Object.entries(part).map(([key, value]) => [
          key,
          key === "type" || IDENTITY.test(key) ? value : redactStrings("part", part.id, value),
        ]),
      )
  }
}

// Keys that hold an id, which a sanitized part keeps so the archive still decodes and links up.
const IDENTITY = /^(?:id|sessionID|messageID)$|_id$/

// An error's text can quote the prompt, a file or a provider's response. Its name, codes, flags and figures stay; its
// message, body and reference are redacted, and its header and metadata maps become markers (F44b).
const ERROR_TEXT = new Set(["message", "responseBody", "ref"])
const ERROR_MAPS = new Set(["responseHeaders", "metadata"])

function redactError<T extends { readonly name: string; readonly data: object }>(id: string, error: T): T {
  return {
    ...error,
    data: Object.fromEntries(
      Object.entries(error.data).map(([key, value]) => [
        key,
        ERROR_TEXT.has(key) && typeof value === "string"
          ? redact(`error-${key}`, id, value)
          : ERROR_MAPS.has(key) && isRecord(value)
            ? data(`error-${key}`, id, value)
            : value,
      ]),
    ),
  }
}

const partFn = part
// sanitizeLegacy names its archive `data`, which hides the marker helper there.
const dataFn = data

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
  // A share link and a workspace id name places outside the archive; a sanitized copy carries neither (F44b).
  delete info.share
  delete info.workspaceID
  const archive = { ...data }
  // Receipt records can include Codium title and memory tokens. Sanitized output is not a receipt backup.
  delete archive.ancillaryUsage
  return {
    // The privacy, guest-input and usage markers travel with the archive: an import may only tighten them.
    ...archive,
    info: {
      ...info,
      // A child's lifecycle record copies its session totals and proof; editable metadata never certifies them (F43).
      // The record's text, and every string beside it, is redacted too (F44).
      ...(data.info.metadata === undefined
        ? {}
        : {
            metadata: Object.fromEntries(
              Object.entries(data.info.metadata).map(([key, value]) => [
                key,
                key === "subagent"
                  ? redactLifecycle(LIFECYCLE, data.info.id, taskMetadata(value))
                  : redactStrings("session-metadata", data.info.id, value),
              ]),
            ),
          }),
      title: redact("session-title", data.info.id, data.info.title),
      directory: redact("session-directory", data.info.id, data.info.directory),
      path: data.info.path === undefined ? undefined : redact("session-path", data.info.id, data.info.path),
      // A rule's pattern can name a path or a command; its tool and action stay.
      permission: data.info.permission?.map((rule, i) => ({
        ...rule,
        pattern: redact("permission-pattern", `${data.info.id}-${i}`, rule.pattern),
      })),
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
              format:
                msg.info.format?.type === "json_schema"
                  ? { ...msg.info.format, schema: dataFn("format-schema", msg.info.id, msg.info.format.schema) }
                  : msg.info.format,
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
              error: msg.info.error === undefined ? undefined : redactError(msg.info.id, msg.info.error),
              structured:
                msg.info.structured === undefined
                  ? undefined
                  : isRecord(msg.info.structured)
                    ? dataFn("structured", msg.info.id, msg.info.structured)
                    : redactStrings("structured", msg.info.id, msg.info.structured),
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

// What a sanitized export keeps of a child's lifecycle record (SubagentRecord, agent/subagent-kind.ts) once taskMetadata
// has dropped its aggregate tokens. `true` keeps a scalar field that holds no user, model or client text: an enum, id,
// count, timestamp or budget, or the engine's slot wording. An object or list under it, which only a crafted archive
// holds, takes the "subagent-field" label. A label redacts a field: a string with redact(), an object with data(), each
// array element alike. A nested rule applies field by field, to an object or to each object of an array. A key it does
// not name, from another version or a crafted archive, takes the "subagent-field" label too, so its string or object is
// redacted while a number, boolean or null stays: taskMetadata, not this rule, keeps token figures out.
type Rule = true | string | { readonly [key: string]: Rule }
const BUDGET: Rule = { usd: true, steps: true, warnAt: true, unpricedSteps: true }
const SCOPE: Rule = {
  kind: true,
  id: true,
  budget: BUDGET,
  spentUsd: true,
  steps: true,
  unpricedSteps: true,
  codiumSteps: true,
  costKind: true,
  // The stop message can name a tool; the reason keeps what stopped it.
  stopped: { reason: true, message: "subagent-stop-message" },
}
const LIFECYCLE: Rule = {
  kind: true,
  agent: true,
  custom: true,
  title: "subagent-title",
  parentSessionID: true,
  parentMessageID: true,
  callID: true,
  batchIndex: true,
  batchID: "subagent-batch",
  attempt: true,
  runtimeID: true,
  ownedPaths: "subagent-owned-path",
  dependsOn: "subagent-depends-on",
  successCriteria: "subagent-success-criterion",
  resultRef: "subagent-result-ref",
  resultSummary: "subagent-result-summary",
  reason: "subagent-reason",
  notification: { text: "subagent-notification", state: true, launchID: true, messageID: true, claimedAt: true },
  budgetScopes: SCOPE,
  budget: BUDGET,
  mailbox: {
    id: true,
    sender: "subagent-mailbox-sender",
    text: "subagent-mailbox-text",
    delivery: true,
    createdAt: true,
    deliveredAt: true,
    from: true,
  },
  model: { providerID: true, modelID: true, variant: true },
  background: true,
  status: true,
  startedAt: true,
  completedAt: true,
  usage: { cost: true, toolUses: true, steps: true, unpricedSteps: true, codiumSteps: true },
  error: "subagent-error",
  conversationID: true,
  rootSessionID: true,
  requestID: true,
  effort: true,
  modelSource: true,
  fork: { point: "subagent-fork-point", callID: true, from: "subagent-fork-from", warm: true },
  structured: { schema: "subagent-structured-schema", schemaHash: true, attempts: true, valid: true },
  delegatedScope: SCOPE,
  owner: { pid: true, boot: true },
  interruption: { at: true, cause: true, reportedAt: true, resumedAt: true, dismissedAt: true },
  waiting: {
    kind: true,
    requestID: true,
    since: true,
    expiresAt: true,
    notedAt: true,
    summary: "subagent-waiting-summary",
  },
  stop: { by: true, at: true },
  reports: { at: true, wakes: true },
  slotReason: true,
  isolation: {
    mode: true,
    state: true,
    branch: "subagent-isolation-branch",
    files: true,
    additions: true,
    deletions: true,
    merged: "subagent-isolation-merged",
    skipped: "subagent-isolation-skipped",
    conflicts: "subagent-isolation-conflict",
    error: "subagent-isolation-error",
  },
  // Both workflow shapes: a run, and one agent of a run.
  workflow: {
    role: true,
    title: "subagent-workflow-title",
    revision: true,
    quiet: true,
    progress: "subagent-workflow-progress",
    runID: true,
    stage: "subagent-workflow-stage",
    phase: "subagent-workflow-phase",
    item: "subagent-workflow-item",
    key: "subagent-workflow-key",
    node: "subagent-workflow-node",
    round: true,
    verifier: true,
    final: true,
    verified: true,
    output: true,
  },
}

function redactLifecycle(rule: Rule, id: string, value: unknown): unknown {
  if (rule === true)
    return isRecord(value) || Array.isArray(value) ? redactLifecycle("subagent-field", id, value) : value
  if (Array.isArray(value)) return value.map((item, i) => redactLifecycle(rule, `${id}-${i}`, item))
  if (typeof rule === "string")
    return typeof value === "string" ? redact(rule, id, value) : isRecord(value) ? data(rule, id, value) : value
  if (!isRecord(value)) return redactLifecycle("subagent-field", id, value)
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      redactLifecycle(Object.hasOwn(rule, key) ? rule[key] : "subagent-field", id, item),
    ]),
  )
}

// A session's other metadata keeps its keys, numbers, booleans and nulls; each string in it is redacted.
function redactStrings(kind: string, id: string, value: unknown): unknown {
  if (typeof value === "string") return redact(kind, id, value)
  if (Array.isArray(value)) return value.map((item, i) => redactStrings(kind, `${id}-${i}`, item))
  if (!isRecord(value)) return value
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redactStrings(kind, id, item)]))
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
      })
      .option("include-screenshots", {
        describe: `include ${Hands.NAME} screenshots in this export unless sanitizing`,
        type: "boolean",
        default: false,
      }),
  handler: Effect.fn("Cli.export")(function* (args) {
    return yield* run(args)
  }),
})

const run = Effect.fn("Cli.export.body")(function* (args: {
  sessionID?: string
  sanitize?: boolean
  public?: boolean
  "include-screenshots"?: boolean
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
    const selection = {
      sessionID: sessionID!,
      includeScreenshots: args["include-screenshots"] === true && !args.sanitize,
    }
    const local = yield* shares.export(selection)
    const portable = args.public || (args.sanitize && "engine" in local)
    // The portable format loses the owner-only marker; keep isolated work in a local archive.
    if (portable && local.privacy === "owner-only")
      return yield* fail(
        "This conversation has owner-only isolated work, so it cannot be exported in the portable format. Export it without --public or --sanitize to keep its owner-only marker.",
      )
    const output = portable
      ? yield* shares
          .preview(selection)
          .pipe(Effect.map((archive) => (args.sanitize ? sanitizePublic(archive) : archive)))
      : localArchive(local, args.sanitize)
    process.stdout.write(JSON.stringify(output, null, 2))
    process.stdout.write(EOL)
  }).pipe(Effect.catchTag("PublicSessionError", (error) => fail(error.message)))
})

// What an export in the local format prints. A native archive is encoded as stored: --sanitize never reaches it here,
// since it sends a native archive to the portable format. A legacy archive is printed as exported, or sanitized.
export function localArchive(local: SessionArchive.Local, sanitize?: boolean) {
  if ("engine" in local) return Schema.encodeSync(SessionArchive.Native)(local)
  return sanitize ? sanitizeLegacy(local) : local
}

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
