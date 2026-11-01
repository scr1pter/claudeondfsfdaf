export * as CodiumRunTrigger from "./codium-run-trigger.js"

/*
 * One shape for every way a Codium run can start, so a later integration only adds a source. Nothing reads a trigger
 * from Slack, Linear or Jira: those sources are reserved names, and a trigger from one is refused with the reason
 * `source-unavailable`.
 */

export const RUN_SOURCES = [
  "desktop",
  "cli",
  "phone",
  "schedule",
  "ops",
  "github-comment",
  "github-dispatch",
  "github-schedule",
  "slack",
  "linear",
  "jira",
] as const
export type RunSource = (typeof RUN_SOURCES)[number]

const RESERVED: readonly RunSource[] = ["slack", "linear", "jira"]

/** The sources a run may start from today: every source except the reserved ones. */
export const ENABLED_SOURCES: ReadonlySet<RunSource> = new Set(
  RUN_SOURCES.filter((source) => !RESERVED.includes(source)),
)

export type RunTrigger = {
  readonly source: RunSource
  readonly account: string
  /** Who asked, on the platform the trigger came from. */
  readonly requestedBy?: { readonly platform: string; readonly userId: string }
  readonly target:
    | { readonly kind: "github-run"; readonly repositoryId: number; readonly branch?: string }
    | { readonly kind: "hosted-job"; readonly size?: "standard" | "large" }
  readonly prompt: string
  /** Success criteria a second lab checks the result against. */
  readonly criteria?: readonly string[]
  /** Milliseconds since the epoch. */
  readonly deliverBy?: number
  readonly purpose: "task" | "review" | "scheduled" | "incident" | "changes"
}
