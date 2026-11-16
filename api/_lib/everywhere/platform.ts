import type { DeclineCode, InboundTrigger, Milestone, PlatformId, RefusalCode } from "../../../packages/schema/src/everywhere.js"
import type { RouteNote, ResultInput, RenderedResult } from "../../../packages/schema/src/everywhere-policy.js"
import type { InstallRecord } from "./identity.js"
import type { JobRecord } from "./jobs.js"

/** Reply references contain platform ids only, and are sealed with the job. */
export type ReplyReference = Readonly<Record<string, string | number | boolean | null>>
export type JobView = {
  readonly jid: string
  readonly platform: PlatformId
  readonly installation: string
  readonly shared: boolean
  readonly reply: ReplyReference
  readonly job?: JobRecord
}
export type ResultView = {
  readonly text: string
  readonly privateText?: string
  readonly result?: ResultInput
}
export type ParsedTrigger = { readonly trigger: InboundTrigger; readonly reply: ReplyReference; readonly place: string }
export type NativeReservation = { readonly resource: string; readonly owner: string }

export interface PlatformAdapter {
  readonly id: PlatformId
  readonly ackMs: number
  /** Native processing sessions need a refresh while long-running jobs report only heartbeats. */
  readonly heartbeats?: boolean
  verify(raw: Uint8Array, headers: Headers, now: number): Promise<
    { readonly ok: true; readonly body: unknown } | { readonly ok: false; readonly status: number }
  >
  parse(body: unknown, installation?: InstallRecord): ParsedTrigger | { readonly ignore: string }
  acknowledge(job: JobView): Promise<ReplyReference | void>
  /** Optional native membership/context lookup, after the first signal and before job admission. */
  prepare?(parsed: ParsedTrigger, installation: InstallRecord): Promise<ParsedTrigger | { readonly ignore: string }>
  /** Native account-link/help controls may run before an identity has linked. True means handled without a job. */
  control?(parsed: ParsedTrigger, installation: InstallRecord): Promise<boolean>
  /** Server-owned native session/context reservation. Undefined means handled or busy, without admitting a job. */
  reserve?(parsed: ParsedTrigger, view: JobView): Promise<NativeReservation | undefined>
  progress(job: JobView, milestone: Milestone | RouteNote): Promise<void>
  finish(job: JobView, result: ResultView | RenderedResult): Promise<void>
  linkPrompt(trigger: InboundTrigger): Promise<void>
  help(trigger: InboundTrigger): Promise<void>
  refuse(trigger: InboundTrigger, code: RefusalCode | DeclineCode): Promise<void>
  repositoryPrompt(trigger: InboundTrigger, repositories: readonly { readonly fullName: string }[], view?: JobView): Promise<void>
  erase(installation: string): Promise<void>
}

export type Platforms = Partial<Readonly<Record<PlatformId, PlatformAdapter>>>
