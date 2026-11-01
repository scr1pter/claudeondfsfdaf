export * as Billing from "./billing.js"

import { Schema } from "effect"

/** Vector Codium's provider id. It stays "vector-plan" in storage and on the wire; people see "Vector Codium". */
export const CODIUM_PROVIDER_ID = "vector-plan"

/** What Vector shows for work on a Vector Codium model, in place of its tokens and dollars. */
export const LABEL = "Codium"

/** How a step, message or request was billed, when not by its own tokens: "codium" is the account's Codium plan. */
export const Kind = Schema.Literal("codium").annotate({ identifier: "Billing.Kind" })
export type Kind = typeof Kind.Type

export const isCodium = (providerID?: string) => providerID === CODIUM_PROVIDER_ID

// The flag first; else the provider id (an in-flight message, or a record written before the flag existed).
// For display only: accounting reads a record's stored flag alone. Records written before the flag were counted as
// ordinary steps and are not backfilled, so reading one as Codium when it is reverted would subtract a Codium step
// that was never added.
export const of = (x: { billing?: string; providerID?: string; model?: { providerID?: string } }) =>
  x.billing === "codium" || isCodium(x.providerID ?? x.model?.providerID) ? ("codium" as const) : undefined
