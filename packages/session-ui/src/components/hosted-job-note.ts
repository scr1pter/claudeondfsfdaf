import type { Part, TextPart } from "@vectordevai/sdk/v2"

/** Display marker only. It grants no model, account, artifact, or task-control authority. */
export function hostedJobNote(part: Part | undefined): part is TextPart {
  if (part?.type !== "text" || part.synthetic !== true) return false
  const value = part.metadata?.hostedJobNotification
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const note = value as Record<string, unknown>
  return typeof note.jobID === "string" && /^(?:jb|jr)_[a-z2-7]{26}$/.test(note.jobID) &&
    typeof note.state === "string" && ["reported", "incomplete", "cancelled", "missed"].includes(note.state)
}
