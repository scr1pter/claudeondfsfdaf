import { createPrivateKey, type KeyObject } from "node:crypto"
import { relayConfigured } from "./remote-relay.js"

/*
 * Whether Vector Remote is configured on this deployment (WP A40; split out of remote-ticket.ts in WP A42 so the perk
 * listing can read it without importing the ticket code and the plan reads behind it). Configured means the owner
 * turned it on, the relay can be called, and tickets can be signed. The owner's runtime `remote` switch is checked
 * separately: by the routes before minting, and by the listing with the other switches.
 */

/** Whether the owner turned Remote on for this deployment (VECTOR_REMOTE_ENABLED=true). */
export function remoteEnabled() {
  return process.env.VECTOR_REMOTE_ENABLED?.trim() === "true"
}

let signingCache: { setting: string; key: KeyObject | undefined } | undefined

/**
 * The Ed25519 private key tickets are signed with: VECTOR_REMOTE_TICKET_SIGNING_KEY, base64url PKCS#8 DER (the owner
 * makes it with the command in owner-actions/remote.md). Undefined when it is missing or is not an Ed25519 key.
 */
export function ticketSigningKey(): KeyObject | undefined {
  const setting = process.env.VECTOR_REMOTE_TICKET_SIGNING_KEY?.trim() ?? ""
  if (signingCache?.setting === setting) return signingCache.key
  let key: KeyObject | undefined
  if (setting && /^[A-Za-z0-9_-]+$/.test(setting)) {
    try {
      const parsed = createPrivateKey({ key: Buffer.from(setting, "base64url"), format: "der", type: "pkcs8" })
      key = parsed.asymmetricKeyType === "ed25519" ? parsed : undefined
    } catch {
      key = undefined
    }
  }
  signingCache = { setting, key }
  return key
}

/** Whether tickets can be minted here: Remote turned on, the relay's address, the signing key and the internal secret. */
export function remoteConfigured() {
  return remoteEnabled() && relayConfigured() && ticketSigningKey() !== undefined
}
