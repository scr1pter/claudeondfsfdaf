import { stripeMode, type StripeMode } from "./model-plan-stripe.js"

/**
 * Every Codium store key starts `vector:codium:<live|test>:`, so a preview running Stripe test mode can never read or
 * write a live record, even pointed at the wrong store, and a store can be flushed or audited one mode at a time. Codium
 * code builds keys only through `codiumKey()`; `test/codium-mode.test.ts` greps for any other spelling.
 */
const ROOT = "vector:codium"

export function codiumKeyPrefix(mode: StripeMode = stripeMode()) {
  return `${ROOT}:${mode}:`
}

/** The store key for `parts` in the server's current mode, e.g. `codiumKey("account", id)`. */
export function codiumKey(...parts: readonly (string | number)[]) {
  return codiumKeyIn(stripeMode(), ...parts)
}

/** The same key in an explicit mode, for the owner's tools and tests that look at both. */
export function codiumKeyIn(mode: StripeMode, ...parts: readonly (string | number)[]) {
  if (!parts.length) throw new Error("A Codium store key needs at least one part.")
  return `${codiumKeyPrefix(mode)}${parts.map(keyPart).join(":")}`
}

/** The mode a stored key belongs to, or undefined for a key that is not a Codium key. */
export function codiumKeyMode(key: string): StripeMode | undefined {
  return /^vector:codium:(live|test):./.exec(key)?.[1] as StripeMode | undefined
}

function keyPart(part: string | number) {
  const value = String(part)
  // Parts are ids, hashes, dates and fixed names. Whitespace or an empty part would let two different records share
  // one key, or split one record across two.
  if (!value || /[\s\x00-\x1f\x7f]/.test(value))
    throw new Error("A Codium store key part must be non-empty, without spaces.")
  return value
}

/**
 * The name of an OpenRouter key Codium creates. Test mode prefixes `Vector test`, so the owner can tell test keys apart
 * in OpenRouter's dashboard and the live funding check never counts one as owed.
 */
export function openRouterKeyName(parts: readonly (string | number)[], mode: StripeMode = stripeMode()) {
  return `${mode === "test" ? "Vector test" : "Vector"} ${parts.map(keyPart).join(" ")}`
}

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"
// Every key Codium creates is named after the Vector account it pays for; other keys on the account are not owed.
// `Codium <id> …` is the name purchased-credit keys had before this change.
const LIVE_KEY_NAME = new RegExp(`^(?:Vector|Codium) ${UUID} `, "i")
const ANY_KEY_NAME = new RegExp(`^(?:Vector test|Vector|Codium) ${UUID} `, "i")

/**
 * Whether the funding check counts an OpenRouter key as owed. A live server counts only live keys: test keys are capped
 * and are not money customers paid for. A test server counts both, since both draw on the one OpenRouter balance it
 * measures, which errs towards pausing test sales rather than live ones.
 */
export function owedKeyName(name: string, mode: StripeMode = stripeMode()) {
  return (mode === "live" ? LIVE_KEY_NAME : ANY_KEY_NAME).test(name)
}
