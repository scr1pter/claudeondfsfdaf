export * as ResearchClaim from "./claim"

import { Schema } from "effect"
import { Research } from "@vectordevai/schema/research"

// Comparisons concern the scope a source actually states. They do not decide that a source is true, that an omitted
// method is equivalent to another method, or that a quote semantically entails the model's structured annotation.
const SCOPE = ["period", "geography", "population", "methodology", "definition"] as const
const SCALE = { one: 1, thousand: 1e3, million: 1e6, billion: 1e9, trillion: 1e12 } as const
export const TOLERANCE = 0.02
export const LIMIT = { notes: 200, comparisons: 100 } as const

export type Comparison = {
  readonly left: string
  readonly right: string
  readonly kind: "agreement" | "conflict" | "different-scope" | "insufficient-scope"
  readonly metric: string
  readonly values: readonly [Research.Measurement, Research.Measurement]
  readonly fields: readonly string[]
  /** Different sites with no known shared lineage; this cannot establish real-world independence. */
  readonly independent: boolean
}

/** Basic evidence anchoring, not semantic validation. Every annotation must be stated in this exact saved quote. */
export function check(value: Research.Measurement, quote: string): string | undefined {
  if (!Schema.is(Research.Measurement)(value)) return "The measurement has invalid or oversized fields."
  const text = words(quote)
  const missing = ["metric", ...SCOPE, "currency"] as const
  const absent = missing.find((key) => value[key] !== undefined && !includes(text, words(value[key]!)))
  if (absent)
    return `The measurement's ${absent} is not stated in its quote. Omit inferred scope or copy a fuller quote.`
  if (!unitWords(value.unit).some((unit) => includes(text, words(unit))))
    return "The measurement's unit is not stated in its quote."
  if (value.scale && value.scale !== "one" && !includes(text, value.scale))
    return "The measurement's scale is not stated in its quote."
  const quantities = [
    ...quote
      .replaceAll("−", "-")
      .matchAll(/(?<![\p{L}\d.,])[-+]?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?(?:e[-+]?\d+)?(?![\p{L}\d]|[.,]\d)/giu),
  ]
  if (!quantities.some((match) => equal(Number(match[0].replaceAll(",", "")), value.value)))
    return "The measurement's value is not stated in its quote. Copy the reported number and scale without converting it."
  if (!Number.isFinite(amount(value))) return "The measurement's scaled value is too large."
}

/** Compare one metric only. Unknown/asymmetric scope never becomes a disagreement by default. */
export function compare(left: Research.Measurement, right: Research.Measurement) {
  if (words(left.metric) !== words(right.metric)) return undefined
  const fields: string[] = SCOPE.filter((key) => left[key] && right[key] && words(left[key]!) !== words(right[key]!))
  if (unit(left.unit) !== unit(right.unit)) fields.push("unit")
  if (left.currency && right.currency && left.currency !== right.currency) fields.push("currency")
  if (fields.length) return { kind: "different-scope" as const, fields }
  const missing: string[] = SCOPE.filter((key) => Boolean(left[key]) !== Boolean(right[key]))
  if (Boolean(left.currency) !== Boolean(right.currency)) missing.push("currency")
  // A date by itself does not identify a population/market, and a place without a period mixes historical estimates.
  if (!left.period || !(left.geography || left.population || left.definition)) missing.push("scope")
  if (missing.length) return { kind: "insufficient-scope" as const, fields: missing }
  const a = amount(left)
  const b = amount(right)
  const agrees = Math.abs(a - b) <= TOLERANCE * Math.max(Math.abs(a), Math.abs(b), Number.EPSILON)
  return { kind: agrees ? ("agreement" as const) : ("conflict" as const), fields: [] }
}

/** Findings are compared only after the run store verified their quote and the report has kept them. */
export function comparisons(notes: readonly Research.Note[], sources: readonly Research.Source[]): Comparison[] {
  const measured = notes
    .filter(
      (note) =>
        note.measurement &&
        note.support &&
        note.stance !== "context" &&
        note.verdict !== "unsupported" &&
        note.verdict !== "contradicted",
    )
    .slice(0, LIMIT.notes)
  return measured
    .flatMap((left, index) =>
      measured.slice(index + 1).flatMap((right) => {
        const relation = compare(left.measurement!, right.measurement!)
        if (!relation) return []
        const a = sources.find((source) => source.id === left.source)
        const b = sources.find((source) => source.id === right.source)
        return [
          {
            left: left.id,
            right: right.id,
            metric: left.measurement!.metric,
            values: [left.measurement!, right.measurement!] as const,
            ...relation,
            independent: Boolean(a && b && independent(a, b, sources)),
          },
        ]
      }),
    )
    .slice(0, LIMIT.comparisons)
}

/** A known copy, canonical address or publication identifier joins sources even when their domains differ. */
export function lineage(source: Research.Source, sources: readonly Research.Source[]): string[] {
  const visited = new Set<string>()
  const collect = (current: Research.Source): string[] => {
    if (visited.has(current.id)) return []
    visited.add(current.id)
    const signal = current.signals
    const copy = signal?.duplicate_of && sources.find((item) => item.id === signal.duplicate_of)
    return [
      `source:${current.id}`,
      ...(current.canonical_url ? [`url:${current.canonical_url.toLowerCase()}`] : []),
      ...(signal?.doi ? [`doi:${signal.doi.toLowerCase().replace(/^https?:\/\/(?:dx\.)?doi\.org\//, "")}`] : []),
      ...(signal?.arxiv ? [`arxiv:${signal.arxiv.toLowerCase().replace(/v\d+$/, "")}`] : []),
      ...(signal?.pmid ? [`pmid:${signal.pmid}`] : []),
      ...(copy ? collect(copy) : []),
    ]
  }
  return collect(source)
}

export function summary(item: Comparison) {
  const label = {
    agreement: "Reported values agree within 2% in the stated scope",
    conflict: "Reported values differ by more than 2% in the stated scope; review both sources",
    "different-scope": `Different scope (${item.fields.join(", ")}); do not treat these values as contradictory`,
    "insufficient-scope": `Scope incomplete (${item.fields.join(", ")}); direct comparison is unconfirmed`,
  }
  const reported = item.values.map((value) =>
    [value.value, value.scale === "one" ? undefined : value.scale, value.unit]
      .filter((part) => part !== undefined)
      .join(" "),
  )
  return `${item.metric}: ${item.left} (${reported[0]}) / ${item.right} (${reported[1]}). ${label[item.kind]}.${item.independent ? " Different sites; no shared source lineage is known. Independence is not verified." : " Independent corroboration is not established."}`
}

function independent(left: Research.Source, right: Research.Source, sources: readonly Research.Source[]) {
  if (!left.site || !right.site || left.site.toLowerCase() === right.site.toLowerCase()) return false
  const a = new Set(lineage(left, sources))
  return !lineage(right, sources).some((token) => a.has(token))
}

function amount(value: Research.Measurement) {
  return value.value * SCALE[value.scale ?? "one"]
}

function equal(left: number, right: number) {
  return Math.abs(left - right) <= 1e-10 * Math.max(1, Math.abs(left), Math.abs(right))
}

function words(text: string) {
  return text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}%]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ")
}

function includes(text: string, part: string) {
  return part.length > 0 && ` ${text} `.includes(` ${part} `)
}

function unit(value: string) {
  const text = words(value)
  return ["%", "percent", "percentage"].includes(text) ? "percent" : text
}

function unitWords(value: string) {
  return unit(value) === "percent" ? ["%", "percent", "percentage"] : [value]
}
