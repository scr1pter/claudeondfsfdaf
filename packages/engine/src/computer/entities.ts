import type { SessionV1 } from "@vectordevai/core/v1/session"
import { SessionMemory } from "@/session/memory"

export type Entity = {
  readonly kind: "email" | "url" | "phone" | "iban" | "card" | "crypto"
  readonly value: string
}

const IBAN_LENGTHS: Readonly<Record<string, number>> = {
  AD: 24,
  AE: 23,
  AL: 28,
  AT: 20,
  AZ: 28,
  BA: 20,
  BE: 16,
  BG: 22,
  BH: 22,
  BR: 29,
  BY: 28,
  CH: 21,
  CR: 22,
  CY: 28,
  CZ: 24,
  DE: 22,
  DK: 18,
  DO: 28,
  EE: 20,
  EG: 29,
  ES: 24,
  FI: 18,
  FO: 18,
  FR: 27,
  GB: 22,
  GE: 22,
  GI: 23,
  GL: 18,
  GR: 27,
  GT: 28,
  HR: 21,
  HU: 28,
  IE: 22,
  IL: 23,
  IQ: 23,
  IS: 26,
  IT: 27,
  JO: 30,
  KW: 30,
  KZ: 20,
  LB: 28,
  LC: 32,
  LI: 21,
  LT: 20,
  LU: 20,
  LV: 21,
  MC: 27,
  MD: 24,
  ME: 22,
  MK: 19,
  MR: 27,
  MT: 31,
  MU: 30,
  NL: 18,
  NO: 15,
  PK: 24,
  PL: 28,
  PS: 29,
  PT: 25,
  QA: 29,
  RO: 24,
  RS: 22,
  SA: 24,
  SC: 31,
  SE: 24,
  SI: 19,
  SK: 24,
  SM: 27,
  ST: 25,
  SV: 28,
  TL: 23,
  TN: 24,
  TR: 26,
  UA: 29,
  VA: 22,
  VG: 24,
  XK: 20,
}

/** Destination candidates, not credentials: the credential classifier refuses secret text before an ask is built. */
export function extract(text: string): Entity[] {
  const found: (Entity & { start: number; end: number })[] = []
  const add = (kind: Entity["kind"], value: string, start: number) => {
    const end = start + value.length
    if (!value) return
    found.push({ kind, value, start, end })
  }
  for (const match of text.matchAll(/\b(?:https?|ftp):\/\/[^\s<>"']+/gi)) {
    const value = match[0].replace(/[),.;!?\]}]+$/, "")
    if (URL.canParse(value)) add("url", value, match.index)
  }
  for (const match of text.matchAll(
    /(?<![\p{L}\p{N}.!#$%&'*+/=?^_`{|}~-])[\p{L}\p{N}.!#$%&'*+/=?^_`{|}~-]+@[\p{L}\p{N}](?:[\p{L}\p{N}.-]*[\p{L}\p{N}])?\.(?:[\p{L}]{2,63}|xn--[a-z0-9-]{2,59})(?![\p{L}\p{N}-])/giu,
  ))
    add("email", match[0], match.index)
  for (const match of text.matchAll(
    /\b(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}(?::\d{1,5})?(?:[/?#][^\s<>"']*)?/gi,
  )) {
    const value = match[0].replace(/[),.;!?\]}]+$/, "")
    if (URL.canParse(`https://${value}`)) add("url", value, match.index)
  }
  // A lookahead leaves a following account available to the next match instead of consuming it with this one.
  for (const match of text.matchAll(/(?=\b([A-Z]{2}\d{2}(?:[ \u00a0\u202f-]?[A-Z0-9]){11,30}))/gi)) {
    const candidate = match[1]
    // This detects destinations rather than validating bank accounts. Unknown country formats still require review.
    const length = IBAN_LENGTHS[candidate.slice(0, 2).toUpperCase()] ?? candidate.replace(/[\s-]/g, "").length
    const chars = [...candidate]
    const end = chars.reduce(
      (result, char, index) => {
        if (result.count === length) return result
        return { count: result.count + (/\w/.test(char) ? 1 : 0), end: index + 1 }
      },
      { count: 0, end: 0 },
    )
    if (end.count === length && !/[A-Z0-9]/i.test(text[match.index + end.end] ?? ""))
      add("iban", candidate.slice(0, end.end), match.index)
  }
  for (const match of text.matchAll(
    /\b(?:0[xX][a-fA-F0-9]{40}|(?:bc1|BC1)[ac-hj-np-zAC-HJ-NP-Z02-9]{11,71}|[13][a-km-zA-HJ-NP-Z1-9]{25,34}|[a-km-zA-HJ-NP-Z1-9]{32,44})\b/g,
  ))
    add("crypto", match[0], match.index)
  for (const match of text.matchAll(/\+?\d(?:[\d \u00a0\u202f().-]*\d)?/g)) {
    const value = match[0]
    const digits = value.replace(/\D/g, "")
    if (digits.length >= 13 && digits.length <= 19 && !value.startsWith("+")) add("card", value, match.index)
    else if (digits.length <= 15 && digits.length >= (value.startsWith("+") ? 7 : 10)) add("phone", value, match.index)
    else if (digits.length > 19) {
      const numbers = [...value.matchAll(/(?<!\d)\d{10,15}(?!\d)/g)]
      if (numbers.length > 1 && numbers.reduce((total, number) => total + number[0].length, 0) === digits.length) {
        for (const number of numbers) add("phone", number[0], match.index + number.index)
      } else {
        // Ambiguous formatted runs still need review; do not discard a possible second destination.
        add("phone", value, match.index)
      }
    }
  }
  // An enclosing destination wins over its email/number/domain components, regardless of scanner order.
  const selected: typeof found = []
  for (const item of found.sort(
    (a, b) => a.start - b.start || b.end - a.end || Number(b.kind === "url") - Number(a.kind === "url"),
  )) {
    if (!selected.some((previous) => item.start < previous.end && item.end > previous.start)) selected.push(item)
  }
  const unique = new Map<string, Entity>()
  for (const item of selected) {
    const identity = key(item)
    if (!unique.has(identity)) unique.set(identity, { kind: item.kind, value: item.value })
  }
  return [...unique.values()]
}

/** Once outside content has been observed, only addresses the user actually supplied can vouch for a destination. */
export function unvouched(text: string, history: readonly SessionV1.WithParts[], observed = false) {
  // A batch can observe a live target before its tool result has entered persisted history.
  if (!observed && !SessionMemory.taint(history)) return []
  const given = new Set(
    history
      .filter((message) => message.info.role === "user")
      .flatMap((message) => extract(SessionMemory.said(message)).map(key)),
  )
  return extract(text).filter((entity) => !given.has(key(entity)))
}

function key(entity: Entity) {
  if (entity.kind === "email") return `email:${entity.value.toLowerCase()}`
  if (entity.kind === "url")
    return `url:${new URL(/^(?:https?|ftp):\/\//i.test(entity.value) ? entity.value : `https://${entity.value}`).href}`
  if (entity.kind === "iban") return `iban:${entity.value.replace(/[\s-]/g, "").toUpperCase()}`
  if (entity.kind === "phone" || entity.kind === "card") return `${entity.kind}:${entity.value.replace(/[^\d+]/g, "")}`
  return `crypto:${/^(?:0x|bc1)/i.test(entity.value) ? entity.value.toLowerCase() : entity.value}`
}

export * as ComputerEntities from "./entities"
