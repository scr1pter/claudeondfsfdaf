export * as ConnectAdapter from "./adapter"

import type { Effect } from "effect"
import type { Connect } from "@vectordevai/schema/connect"
import type { ConnectPolicy } from "@vectordevai/core/connect/policy"
import type { SessionV1 } from "@vectordevai/core/v1/session"
// Types only: a value import of the prompt loop would close the cycle registry → connect tool → hub → adapter →
// review run → session prompt → registry.
import type { SessionPrompt } from "@/session/prompt"
import type { SessionID } from "@/session/schema"

// How a member whose code lives elsewhere plugs into connected tools. An owner adds one file under connect/adapters/
// and one line to its index. The hub checks effects, asks consent, records the run, emits events and keeps results;
// an adapter only does the work. It cannot widen its own effects at run time, because the hub reads the effects the
// member declared in `describe()` and checks them before anything starts.

export interface Adapter {
  /** The member id, such as "vectorscope". */
  readonly id: string
  readonly owner: Connect.Owner
  /** No model call and no new network destination. It may read the member's own cached availability. */
  readonly describe: () => Effect.Effect<Connect.Member>
  /** Absent for a member that is only listed. */
  readonly handle?: (
    request: Connect.Request,
    context: HandoffContext,
  ) => Effect.Effect<Connect.Result, Connect.Refusal>
}

/**
 * The only way an adapter reaches the prompt loop. It accepts only hidden helper sessions (`internal` set to a name
 * of this member) whose parent is the run's requester or a placement session connect made for the run; never the
 * requester, another conversation or a session of another member, and nothing once the run is over. Any other call
 * dies with a plain message.
 */
export interface HelperHandle {
  readonly prompt: (input: SessionPrompt.PromptInput) => Effect.Effect<SessionV1.WithParts>
  readonly cancel: (sessionID: SessionID) => Effect.Effect<void>
}

/** What a fix in an isolated worktree asks its caller to start: the hidden connect_fix child, through the task tool. */
export interface FixLaunch {
  readonly title: string
  /** The brief: Vector's own lines, then the findings in their labelled untrusted block. */
  readonly prompt: string
  /** The files the child may write, relative to the requester's directory: the owned-path rule's, never a model's. */
  readonly ownedPaths: readonly string[]
  /** The JSON Schema of the child's checked answer. */
  readonly schema: Record<string, unknown>
}

/** How a fix child ended, as its caller saw it. Its answer and output are a model's: data, never instructions. */
export interface FixLaunched {
  readonly sessionID?: SessionID
  /** `background` when the child moved to the background while the call waited; its report arrives as a note. */
  readonly state: "completed" | "error" | "cancelled" | "background"
  /** The child's checked JSON answer, when it gave one. */
  readonly answer?: unknown
  /** What its isolated worktree holds once it settled. */
  readonly isolation?: {
    readonly state: string
    readonly files: number
    readonly additions: number
    readonly deletions: number
  }
  /** The task tool's own report of the child, for the model. */
  readonly output: string
}

export type Launcher = (input: FixLaunch) => Effect.Effect<FixLaunched>

/** A progress update as an adapter reports it. The hub stamps the time when the adapter leaves it out. */
export type ProgressUpdate = Omit<Connect.Progress, "at"> & { readonly at?: number }

export interface HandoffContext {
  readonly runID: Connect.RunID
  /** The requester; absent for a run a person starts on a directory with no session. */
  readonly sessionID?: SessionID
  /** The request this run belongs to: the id of the message the user last wrote, or the run id with no session. */
  readonly requestID: string
  readonly directory: string
  /** Fires when the run is cancelled, times out, or its caller stops waiting. */
  readonly abort: AbortSignal
  /**
   * Asks a consent in the requester's session. A rule's deny refuses with `permission`, the user's no with `denied`.
   * `connect_model` is asked once per request for each model; `connect_write` every time, never saved.
   */
  readonly ask: (consent: Connect.Consent) => Effect.Effect<void, Connect.Refusal>
  readonly progress: (update: ProgressUpdate) => Effect.Effect<void>
  /**
   * An adapter calls it once every question it asks is behind it and its long work begins (CW-08). A background run's
   * caller stops waiting here: the run goes on as a background job, a later ask reaches the requester's session rather
   * than the call, and the end arrives as a note. In the foreground it changes nothing.
   */
  readonly working?: () => Effect.Effect<void>
  /** Only the vectorscope adapter receives it, and only when the caller gave the hub prompt calls to build it from. */
  readonly helper?: HelperHandle
  /** What the requester's run has left in dollars; undefined when it has no dollar limit or there is no session. */
  readonly remainingUsd?: number
  /**
   * Where the requester's run stands, read from the spend guard, for `ConnectPolicy.effectiveCap`. A background run may
   * outlive the turn that started it, so its spend reads as outside the run (`running: false`).
   */
  readonly spend: ConnectPolicy.RunSpend
  /** For a review with `since`: the earlier run, found in the requester's session and of the same target kind. */
  readonly previous?: Connect.Run
  /** For a fix: the review run whose findings are fixed, found in the requester's session. */
  readonly source?: Connect.Run
  /**
   * For a fix in an isolated worktree: starts the connect_fix child. Only the vectorscope adapter receives it, only for
   * a fix, and only while the run is going; a tool call lends it.
   */
  readonly launch?: Launcher
}

/** How an adapter is built: an effect over services the hub's layer provides. */
export type Factory<R = never> = Effect.Effect<Adapter, never, R>
