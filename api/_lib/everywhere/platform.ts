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

export interface PlatformAdapter {
  readonly id: PlatformId
  readonly ackMs: number
  verify(raw: Uint8Array, headers: Headers, now: number): Promise<
    { readonly ok: true; readonly body: unknown } | { readonly ok: false; readonly status: number }
  >
  parse(body: unknown, installation?: InstallRecord): ParsedTrigger | { readonly ignore: string }
  acknowledge(job: JobView): Promise<void>
  progress(job: JobView, milestone: Milestone | RouteNote): Promise<void>
  finish(job: JobView, result: ResultView | RenderedResult): Promise<void>
  linkPrompt(trigger: InboundTrigger): Promise<void>
  help(trigger: InboundTrigger): Promise<void>
  refuse(trigger: InboundTrigger, code: RefusalCode | DeclineCode): Promise<void>
  repositoryPrompt(trigger: InboundTrigger, repositories: readonly { readonly fullName: string }[]): Promise<void>
  erase(installation: string): Promise<void>
}

export type Platforms = Partial<Readonly<Record<PlatformId, PlatformAdapter>>>
