import type { PermissionRequest } from "@vectordevai/sdk/v2"

// What a connected-tools question asks the user to agree to. The engine's connect hub asks `connect` (hand a review
// to VectorScope), `connect_model` (a review on a priced model, or on one the repository's review.json picks) and
// `connect_write` (a fix), and writes Vector's own sentence about it into the ask's metadata: for `connect_model`, the
// model, where the diff goes and the dollar cap. The permission dock shows that sentence, since the patterns alone name
// only the model. No model writes it: the hub builds it from the review's settings and the user's.

const PERMISSIONS = new Set(["connect", "connect_model", "connect_write"])

/** The most of the sentence the dock shows; the hub keeps it to 2,000 characters already. */
export const MAX_DETAILS = 2_000

/** The sentence to show under a connected-tools question, or undefined for any other question. */
export function connectConsentDetails(request: Pick<PermissionRequest, "permission" | "metadata">): string | undefined {
  if (!PERMISSIONS.has(request.permission)) return undefined
  const metadata = request.metadata ?? {}
  // The hub's asks carry the run they belong to; a question without one is not the hub's.
  if (typeof metadata.runID !== "string" || !metadata.runID.startsWith("cr_")) return undefined
  if (typeof metadata.description !== "string") return undefined
  const text = metadata.description.trim()
  if (!text) return undefined
  return text.length > MAX_DETAILS ? `${text.slice(0, MAX_DETAILS - 1)}…` : text
}

/** Keep the full patch available for an explicit write decision; render it as text, never HTML. */
export function connectConsentDiff(request: Pick<PermissionRequest, "permission" | "metadata">): string | undefined {
  if (request.permission !== "connect_write" || connectConsentDetails(request) === undefined) return undefined
  const diff = request.metadata?.diff
  return typeof diff === "string" && diff.length > 0 ? diff : undefined
}
