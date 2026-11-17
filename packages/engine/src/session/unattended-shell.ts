export * as UnattendedShell from "./unattended-shell"

import { isDeepStrictEqual } from "node:util"
import { Effect, Exit, Option, Schema } from "effect"
import { ChildProcess } from "effect/unstable/process"
import type { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"
import { UNATTENDED_KEY, UNATTENDED_SHELL_KEY, UNATTENDED_SHELL_OFFLINE } from "@vectordevai/core/everywhere/frame"
import { Sandbox } from "@/tool/shell/sandbox"
import type { Session } from "./session"
import { SessionID } from "./schema"

/*
 * An unattended session's commands (R-M2): a session created by the owner with `vector.unattended` and
 * `vector.unattended.shell: "offline"` runs every command of its own, and of every session below it, only in Vector's
 * offline sandbox (Sandbox.unattended), whatever VECTOR_SHELL_SANDBOX or Vector Local says, and runs none where that
 * sandbox cannot be applied. Other sessions are unaffected, and there is no switch for the whole engine.
 *
 * The two marks are the engine's: only a session's creation by the owner sets them, and nothing changes them after.
 */

/** The session metadata keys this module owns. A public metadata write keeps both as they are. */
export const MARKS = [UNATTENDED_KEY, UNATTENDED_SHELL_KEY] as const

export const OWNER_ONLY = "Only the server owner can create a session whose commands run only in the offline sandbox."
export const INVALID = `A session whose commands run only in the offline sandbox needs "${UNATTENDED_SHELL_KEY}": "${UNATTENDED_SHELL_OFFLINE}" beside "${UNATTENDED_KEY}".`
export const FIXED = "A session's unattended marks are set when it is created and cannot be changed."
export const KEPT =
  "A sync replay cannot delete or move a session whose commands run only in the offline sandbox, or one below it."
export const USER_SHELL =
  "Vector did not run this command. This session's commands run only in Vector's offline sandbox, and a command sent to the session's shell does not."
export const TERMINAL =
  "Vector did not use the terminal. This session's commands run only in Vector's offline sandbox, and a terminal does not run there. Use the shell tool."
const LINEAGE = "The conversation ancestry of this command could not be verified."

/**
 * Only bubblewrap's own start is tried: a fixed argument list with no user input, the namespaces and mounts the offline
 * profile needs, and a program that does nothing, named by a path every system bubblewrap runs on has (NixOS has no
 * `true` in /usr/bin or /bin, only /bin/sh). A bubblewrap that is installed but cannot start (Ubuntu 24.04 refuses an
 * unprivileged user namespace to an unconfined program) is then not advertised.
 */
export const SELF_TEST = [
  "--die-with-parent",
  "--unshare-ipc",
  "--unshare-uts",
  "--unshare-pid",
  "--unshare-net",
  "--cap-drop",
  "ALL",
  "--ro-bind",
  "/",
  "/",
  "--dev",
  "/dev",
  "--proc",
  "/proc",
  "--tmpfs",
  "/tmp",
  "/bin/sh",
  "-c",
  ":",
] as const
// Each bubblewrap's answer, once per process, by the binary it would run.
const started = new Map<string, boolean>()

/**
 * Whether the owner's request may create a session with this metadata. Undefined when it carries no shell mark (the
 * session is not offline-only), "owner" when the request is not the owner's, "invalid" when the shell mark is not the
 * one accepted value or stands without a `vector.unattended` value (null is none).
 */
export function admission(metadata: Readonly<Record<string, unknown>> | undefined, owner: boolean) {
  if (metadata === undefined || !Object.hasOwn(metadata, UNATTENDED_SHELL_KEY)) return undefined
  if (!owner) return "owner" as const
  if (metadata[UNATTENDED_SHELL_KEY] !== UNATTENDED_SHELL_OFFLINE || (metadata[UNATTENDED_KEY] ?? null) === null)
    return "invalid" as const
  return undefined
}

/**
 * Whether a public metadata update would change a mark. A key the update leaves out is kept (setPublicMetadata), so
 * only a key it names counts, and a value equal to the current one passes, so a client that writes back what it read
 * keeps working.
 */
export function changes(
  current: Readonly<Record<string, unknown>> | undefined,
  next: Readonly<Record<string, unknown>>,
) {
  return MARKS.some((key) => Object.hasOwn(next, key) && !isDeepStrictEqual(current?.[key], next[key]))
}

/** Whether replacing a session's whole metadata (a replayed update) would add, change or remove a mark. */
export function differs(
  current: Readonly<Record<string, unknown>> | undefined,
  next: Readonly<Record<string, unknown>> | undefined,
) {
  return MARKS.some((key) => !isDeepStrictEqual(current?.[key], next?.[key]))
}

/**
 * Whether a session's commands run only in the offline sandbox: it, or a session above it, carries the shell mark,
 * whatever its value. A session that is not stored is judged by `parentID`, the tool context's, and what is stored above
 * that; a tool run with neither stored (outside any conversation, as the tools' own tests run it) has no mark.
 */
export const marked = Effect.fn("UnattendedShell.marked")(function* (
  sessions: Session.Interface,
  sessionID: SessionID,
  parentID?: SessionID,
) {
  const lookup = (id: SessionID) => find(sessions, id)
  const session = yield* lookup(sessionID)
  if (session !== undefined) return yield* lineage(lookup, sessionID, session, [])
  if (parentID === undefined) return false
  const parent = yield* lookup(parentID)
  return parent === undefined ? false : yield* lineage(lookup, parentID, parent, [sessionID])
})

/** What a lineage reads of a session. */
type Node = { readonly metadata?: Readonly<Record<string, unknown>>; readonly parentID?: SessionID }

const find = (sessions: Session.Interface, id: SessionID) =>
  sessions.get(id).pipe(
    Effect.map((session): Node | undefined => session),
    Effect.catchTag("NotFoundError", () => Effect.succeed(undefined)),
    Effect.orDie,
  )

/**
 * Whether `node` or a session above it carries the shell mark. A missing ancestor ends the lineage, so an orphan (an
 * import, a replayed child) runs its commands as any session does: the marks never change, Session.remove removes a
 * session's children before it, and a sync replay may not delete or move a session of a marked lineage
 * (replayRefusal), so no session of a marked lineage goes while one below it stays. A loop or a lineage deeper than 64
 * is refused.
 */
function lineage(
  lookup: (id: SessionID) => Effect.Effect<Node | undefined>,
  id: SessionID,
  node: Node,
  seen: readonly SessionID[],
): Effect.Effect<boolean> {
  if (node.metadata?.[UNATTENDED_SHELL_KEY] !== undefined) return Effect.succeed(true)
  const parentID = node.parentID
  if (parentID === undefined) return Effect.succeed(false)
  const path = [...seen, id]
  if (path.includes(parentID) || path.length >= 64) return Effect.die(new Error(LINEAGE))
  return lookup(parentID).pipe(
    Effect.flatMap((parent) =>
      parent === undefined ? Effect.succeed(false) : lineage(lookup, parentID, parent, path),
    ),
  )
}

/**
 * What this engine can promise an unattended session's commands: "offline-v1" where they run in the offline sandbox
 * (Linux, with a bubblewrap only root can change that starts here), "none" everywhere else. The start is tried once per
 * process and binary, through the spawner, which owns and signals it as it does every command.
 */
export const policy = Effect.fn("UnattendedShell.policy")(function* (
  spawner: ChildProcessSpawner["Service"],
  platform: NodeJS.Platform = process.platform,
) {
  const binary = Sandbox.unattendedBinary(platform)
  if (binary === undefined) return "none" as const
  const works = started.get(binary) ?? (yield* selfTest(spawner, binary))
  started.set(binary, works)
  return works ? ("offline-v1" as const) : ("none" as const)
})

/** Whether this bubblewrap starts the self-test, asked afresh: only exit 0 within ten seconds counts. */
export const selfTest = Effect.fn("UnattendedShell.selfTest")(function* (
  spawner: ChildProcessSpawner["Service"],
  binary: string,
) {
  const exit = yield* spawner
    .exitCode(
      ChildProcess.make(binary, SELF_TEST, {
        env: { PATH: "/usr/bin:/bin" },
        stdin: "ignore",
        stdout: "ignore",
        stderr: "ignore",
      }),
    )
    .pipe(Effect.timeout("10 seconds"), Effect.exit)
  return Exit.isSuccess(exit) && exit.value === 0
})

/** Why an unattended session's command cannot run here, before anything about it is asked; undefined where it can. */
export const refusal = Effect.fn("UnattendedShell.refusal")(function* (
  spawner: ChildProcessSpawner["Service"],
  platform: NodeJS.Platform = process.platform,
) {
  return (yield* policy(spawner, platform)) === "offline-v1" ? undefined : Sandbox.UNATTENDED_REFUSAL
})

type Replayed = { readonly type: string; readonly data: unknown }

// What the replay check reads of a session event. The replay decodes each event with SessionV1's schema, which requires
// these fields at least as strictly, so an event this cannot read is one the replay never projects.
const decodeReplayed = Schema.decodeUnknownOption(
  Schema.Struct({
    sessionID: SessionID,
    info: Schema.optional(
      Schema.Struct({
        parentID: Schema.optional(SessionID),
        metadata: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
      }),
    ),
  }),
)

/**
 * Why a sync replay may not run: a session it creates carries the shell mark without the owner (or an invalid one), an
 * update it replays would add, change or remove a mark, or it deletes a session of a marked lineage or moves one to
 * another parent. A deletion would let a later creation bring the same ID back without the marks and would cut the
 * sessions below it off from the mark above them, as a move would. A replayed update replaces the session's whole
 * metadata and parent, so each event is compared with the session as the replay leaves it before that event: an
 * earlier event of the same replay, or the stored session.
 */
export const replayRefusal = Effect.fn("UnattendedShell.replayRefusal")(function* (
  sessions: Session.Interface,
  events: readonly Replayed[],
  owner: boolean,
) {
  // Each session as the replay has left it so far; undefined once the replay deletes it.
  const seen = new Map<SessionID, Node | undefined>()
  const lookup = (id: SessionID) => (seen.has(id) ? Effect.succeed(seen.get(id)) : find(sessions, id))
  for (const event of events) {
    const kind = /^session\.(created|updated|deleted)(?:\.\d+)?$/.exec(event.type)?.[1]
    if (kind === undefined) continue
    const decoded = decodeReplayed(event.data)
    if (Option.isNone(decoded)) continue
    const id = decoded.value.sessionID
    const next = { metadata: decoded.value.info?.metadata, parentID: decoded.value.info?.parentID }
    if (kind === "created") {
      const admitted = admission(next.metadata, owner)
      if (admitted === "owner") return OWNER_ONLY
      if (admitted === "invalid") return INVALID
      seen.set(id, next)
      continue
    }
    const current = yield* lookup(id)
    const kept = current !== undefined && (yield* lineage(lookup, id, current, []))
    if (kind === "deleted") {
      if (kept) return KEPT
      seen.set(id, undefined)
      continue
    }
    if (differs(current?.metadata, next.metadata)) return FIXED
    if (kept && current?.parentID !== next.parentID) return KEPT
    seen.set(id, next)
  }
  return undefined
})
