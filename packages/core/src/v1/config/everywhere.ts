export * as ConfigEverywhereV1 from "./everywhere"

import { Schema } from "effect"
import { COMPUTER_CAPS, REPOSITORY_PATTERN } from "@vectordevai/schema/everywhere"
import { PositiveInt } from "../../schema"

// This computer's own settings for jobs started from elsewhere. Only the user's own config files set this block: the
// engine drops it from repository, company, organization and environment config (projectExecutableConfig, merge() and
// the company policy loop).
// Omitted keys stay absent, so a file stays as written, and Defaults says what each one means. The bounds are the
// runner's COMPUTER_CAPS, and the runner applies the lower of these and a job's own limits. Unknown keys are refused,
// so a misspelled key such as `pushh: false` makes the file invalid instead of leaving the setting at its default.

// One folder name: not `.` or `..`, and free of separators, NUL and line breaks.
const SEGMENT = String.raw`(?!\.\.?(?:[\\/]|$))[^\\/\0\r\n]+`
// An absolute POSIX, drive-letter or UNC path on one line: no root alone, no repeated or trailing separator, no `.` or
// `..`, and one separator throughout a drive-letter path. Case is kept as written and links are not resolved, so
// `C:\Repo` and `c:\repo`, or a folder and a link to it, are still two entries: whatever matches a job to a folder
// canonicalizes both first and does not rely on the list holding each folder once.
const DIRECTORY = new RegExp(
  String.raw`^(?:(?:/${SEGMENT})+|[A-Za-z]:(?:\\${SEGMENT})+|[A-Za-z]:(?:/${SEGMENT})+|\\\\${SEGMENT}(?:\\${SEGMENT})+)$`,
)

// The folder and the repository the user ticked it for, both recorded together, so the runner's check that the
// folder's remote is this repository compares against what the user chose rather than against the remote itself.
const Project = Schema.Struct({
  directory: Schema.String.annotate({
    description: "An absolute folder path, at most 4096 characters, with no `.` or `..` and no trailing separator",
  }).check(Schema.isMaxLength(4096), Schema.isPattern(DIRECTORY)),
  repository: Schema.String.check(Schema.isPattern(REPOSITORY_PATTERN)).annotate({
    description: "The folder's GitHub repository as owner/name",
  }),
}).annotate({ identifier: "EverywhereProject", parseOptions: { onExcessProperty: "error" } })

const upTo = (maximum: number) => PositiveInt.check(Schema.isLessThanOrEqualTo(maximum))

export const Info = Schema.Struct({
  enabled: Schema.optional(Schema.Boolean).annotate({ description: "Off unless set to true (default: false)" }),
  max_usd: Schema.optional(
    Schema.Finite.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(COMPUTER_CAPS.maxUsd.max)),
  ).annotate({
    description: `US dollars per job, above 0 and at most ${COMPUTER_CAPS.maxUsd.max} (default: ${COMPUTER_CAPS.maxUsd.default})`,
  }),
  minutes: Schema.optional(upTo(COMPUTER_CAPS.minutes.max)).annotate({
    description: `Minutes per job, 1–${COMPUTER_CAPS.minutes.max} (default: ${COMPUTER_CAPS.minutes.default})`,
  }),
  at_once: Schema.optional(upTo(COMPUTER_CAPS.atOnce.max)).annotate({
    description: `Jobs at once, 1–${COMPUTER_CAPS.atOnce.max} (default: ${COMPUTER_CAPS.atOnce.default})`,
  }),
  per_day: Schema.optional(upTo(COMPUTER_CAPS.perDay.max)).annotate({
    description: `Jobs a day, 1–${COMPUTER_CAPS.perDay.max} (default: ${COMPUTER_CAPS.perDay.default})`,
  }),
  model: Schema.optional(Schema.String.check(Schema.isPattern(/^[^/\r\n]+\/[^\r\n]+$/))).annotate({
    description: "Model in the format of provider/model (default: your default model)",
  }),
  wait_for_computer: Schema.optional(Schema.Boolean).annotate({ description: "Default: true" }),
  push: Schema.optional(Schema.Boolean).annotate({ description: "Default: true" }),
  stay_awake: Schema.optional(Schema.Boolean).annotate({ description: "Default: false" }),
  projects: Schema.optional(
    Schema.mutable(Schema.Array(Project)).check(
      Schema.isMaxLength(64),
      Schema.makeFilter((items) => new Set(items.map((item) => item.directory)).size === items.length),
    ),
  ).annotate({ description: "Project folders, each listed once, at most 64 (default: none)" }),
}).annotate({ identifier: "EverywhereConfig", parseOptions: { onExcessProperty: "error" } })
export type Info = Schema.Schema.Type<typeof Info>

// What an omitted key means. `model` has no default here: absent means the user's own default model.
export const Defaults = {
  enabled: false,
  max_usd: COMPUTER_CAPS.maxUsd.default,
  minutes: COMPUTER_CAPS.minutes.default,
  at_once: COMPUTER_CAPS.atOnce.default,
  per_day: COMPUTER_CAPS.perDay.default,
  wait_for_computer: true,
  push: true,
  stay_awake: false,
  projects: [],
} as const
