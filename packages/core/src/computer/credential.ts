import type { Computer } from "@vectordevai/schema/computer"

/** The desktop and helper must inspect the actual field again immediately before input. */
export function field(element: Computer.InspectResult["element"]) {
  if (!element) return false
  if (element.secure || /secure.?text|password/i.test(element.role)) return true
  if (!element.editable && !/text|edit|input|combo/i.test(element.role)) return false
  return /\b(?:password|passphrase|passcode|otp|pin|cvv|cvc|card|code|social security|ssn|national id|id number|identification number|passport|api key|access token|secret key)\b/i.test(
    (element.label ?? "").normalize("NFKC").replace(/[_-]+/g, " "),
  )
}

/** Only plausible payment-card lengths with a valid checksum count as a card secret. */
export function card(value: string) {
  const digits = value.replace(/[\s-]/g, "")
  if (!/^\d{13,19}$/.test(digits) || /^(\d)\1+$/.test(digits)) return false
  const sum = [...digits].reverse().reduce((total, digit, index) => {
    const n = Number(digit) * (index % 2 === 1 ? 2 : 1)
    return total + (n > 9 ? n - 9 : n)
  }, 0)
  return sum % 10 === 0
}

/** Recognizable credentials are refused without reproducing them in a result or log. */
export function secret(text: string) {
  const normalized = text.normalize("NFKC")
  if ((normalized.match(/\d(?:[\s-]*\d)*/g) ?? []).some(cardInRun)) return true
  if (/\b\d{3}[- ]\d{2}[- ]\d{4}\b/.test(normalized)) return true
  if (
    /\b(?:ssn|social security|national id|id number|identification number|passport|tax id)\s*(?:number\s*)?[:=#]?\s*[a-z0-9][a-z0-9 -]{5,24}\b/i.test(
      normalized,
    )
  )
    return true
  return /\b(?:sk-(?:proj-|ant-)?[a-z0-9_-]{16,}|gh[pousr]_[a-z0-9]{20,}|github_pat_[a-z0-9_]{20,}|AIza[a-z0-9_-]{30,}|(?:AKIA|ASIA)[A-Z0-9]{16}|xox[baprs]-[a-z0-9-]{16,}|Bearer\s+[a-z0-9._-]{16,})\b|-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----/i.test(
    normalized,
  )
}

// Each separated group can end a card, so a later independent number cannot hide an earlier valid checksum.
function cardInRun(text: string) {
  const groups = text.match(/\d+/g) ?? []
  return groups.some((_, start) => {
    let digits = ""
    for (let index = start; index < groups.length; index++) {
      digits += groups[index]
      if (digits.length > 19) return false
      if (card(digits)) return true
    }
    return false
  })
}

export * as ComputerCredential from "./credential"
