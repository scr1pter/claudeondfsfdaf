export * as ConfigReviewV1 from "./review"

import { Schema } from "effect"
import type { DeepMutable } from "../../schema"

// The `review` block (VectorScope VS-23d, SF-15): the review settings that are yours rather than a repository's. The
// engine reads it from your user config alone (Config.getGlobal: config.json, vector.json and vector.jsonc in the
// global config directory). A project's config never sets it (the engine's projectExecutableConfig drops it), and
// neither do VECTOR_CONFIG_CONTENT, managed or remote org config. Its one reader is core review/config.ts
// mergeReviewConfig, as `global`:
// - `privacy` and `holdback` only raise what review.json and REVIEW_PRIVACY / REVIEW_HOLDBACK ask (raise-only), and
//   the engine server holds the desktop's review sessions to `privacy` (engine review/route.ts adopt);
// - `zdrAttested` is the trusted source of zero data retention attestations on your own computer ("local").
//
// Every value is read loosely, on purpose: a value the strict config decoder refused would fail the load of the whole
// user config, so every engine surface would stop until it was fixed, not only reviews (fail-closed, but for
// everything). mergeReviewConfig reads a value that is not a level as the strictest, with a warning, and drops an
// attestation it cannot read, with a warning. A `review` that is not an object still fails the load. VS-30's
// `runtime` is not here: nothing runs it yet, so a global value could only warn. The block ships hidden (I-14, owner
// Q16): the published config.json leaves it out (engine script/schema.ts), and no settings page or docs page names it.

export const Info = Schema.Struct({
  inversion: Schema.optional(Schema.Unknown).annotate({
    description: 'Set to "local" to compare the reviewer with locally proven authorship.',
  }),
  alternateModel: Schema.optional(Schema.Unknown).annotate({
    description: "An owner-declared equal-tier, different-lab review model. Used only for local authorship inversion.",
  }),
  privacy: Schema.optional(Schema.Unknown).annotate({
    description: 'Review privacy: "zdr" only raises what a repository asks.',
  }),
  holdback: Schema.optional(Schema.Unknown).annotate({
    description: 'Review secret holdback: "secrets" only raises what a repository asks.',
  }),
  diagnostics: Schema.optional(Schema.Unknown).annotate({
    description: "Run the pinned offline diagnostics in Linux engine reviews.",
  }),
  ruleCheck: Schema.optional(Schema.Unknown).annotate({
    description: "Check repository rule citations against the trusted text sent for this review.",
  }),
  zdrAttested: Schema.optional(Schema.Unknown).annotate({
    description: "Provider IDs and model server hosts you attest keep no data, for reviews on this computer.",
  }),
}).annotate({ identifier: "GlobalReviewConfig" })

export type Info = DeepMutable<Schema.Schema.Type<typeof Info>>
