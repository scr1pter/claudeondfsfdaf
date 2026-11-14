import { WebAuthn } from "@vectordevai/core/webauthn/verify"
import { fromBase64url, random, toBase64url } from "./remote-crypto"

// Passkey approvals for Vector Remote (WP A41, S6). A phone may allow a permission request only once, and only with a
// passkey check this computer verifies itself: the phone asks for a challenge for one request, its passkey signs it
// (user verification required), and the desktop checks the assertion against the credential stored when that phone
// paired (packages/core/src/webauthn/verify.ts), with the origin exactly the phone app's. No server takes part, and a
// phone can never answer "always". A challenge is good for one request, one phone, one try and two minutes.

export const APPROVAL_TTL_MS = 2 * 60_000
const PER_PHONE = 20

export type ApprovalTarget = { requestID: string; sessionID: string; directory: string }
export type Assertion = { id: string; clientDataJSON: string; authenticatorData: string; signature: string }

type Pending = ApprovalTarget & { phone: string; challenge: Uint8Array; expiresAt: number }

export class ApprovalError extends Error {
  constructor(
    readonly code: "REMOTE_APPROVAL_INVALID" | "REMOTE_APPROVAL_EXPIRED" | "REMOTE_PASSKEY_REFUSED",
    message: string,
  ) {
    super(message)
    this.name = "ApprovalError"
  }
}

export function createPasskeyApprovals(deps: { origin: string; now?: () => number }) {
  const now = deps.now ?? Date.now
  const rpId = WebAuthn.rpIdFor(deps.origin)
  const pending = new Map<string, Pending>()

  const prune = () => {
    for (const [key, entry] of pending) if (entry.expiresAt <= now()) pending.delete(key)
  }

  return {
    rpId,
    /** A challenge for one phone to allow one request once. A phone holds at most 20 at a time. */
    challenge(phone: string, target: ApprovalTarget, credentialId: string) {
      prune()
      const mine = [...pending].filter(([, entry]) => entry.phone === phone)
      if (mine.length >= PER_PHONE) pending.delete(mine[0]![0])
      const challenge = random(32)
      const expiresAt = now() + APPROVAL_TTL_MS
      pending.set(toBase64url(challenge), { ...target, phone, challenge, expiresAt })
      return {
        challenge: toBase64url(challenge),
        rpId,
        allowCredentials: [credentialId],
        userVerification: "required" as const,
        expiresAt,
      }
    },
    /**
     * Checks a phone's assertion for `target`. The challenge it signed must have been issued to this phone for this
     * request; it is used up by this call whatever the outcome. Returns the credential to store (its new counter).
     */
    async verify(
      phone: string,
      target: ApprovalTarget,
      assertion: unknown,
      credential: WebAuthn.Credential,
    ): Promise<WebAuthn.Credential> {
      prune()
      const parsed = readAssertion(assertion)
      if (!parsed) throw new ApprovalError("REMOTE_APPROVAL_INVALID", "The phone's passkey answer is not valid.")
      const client = parseClientData(parsed.clientDataJSON)
      const entry = client ? pending.get(client.challenge) : undefined
      if (client) pending.delete(client.challenge)
      if (!entry || entry.phone !== phone)
        throw new ApprovalError("REMOTE_APPROVAL_EXPIRED", "That approval expired. Ask again from your phone.")
      if (
        entry.requestID !== target.requestID ||
        entry.sessionID !== target.sessionID ||
        entry.directory !== target.directory
      )
        throw new ApprovalError("REMOTE_APPROVAL_INVALID", "That passkey answer is for a different request.")
      if (entry.expiresAt <= now())
        throw new ApprovalError("REMOTE_APPROVAL_EXPIRED", "That approval expired. Ask again from your phone.")
      const result = await WebAuthn.verifyAssertion(parsed, credential, {
        challenge: entry.challenge,
        origin: deps.origin,
        rpId,
        requireUserVerification: true,
      }).catch((error: unknown) => {
        if (error instanceof WebAuthn.WebAuthnError)
          throw new ApprovalError(
            "REMOTE_PASSKEY_REFUSED",
            "Your phone's passkey check did not pass, so nothing was allowed.",
          )
        throw error
      })
      return { ...credential, signCount: result.signCount }
    },
    /** Forgets a phone's challenges, when it is unpaired. */
    forget(phone: string) {
      for (const [key, entry] of pending) if (entry.phone === phone) pending.delete(key)
    },
    size: () => pending.size,
  }
}

export type PasskeyApprovals = ReturnType<typeof createPasskeyApprovals>

function readAssertion(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
  const input = value as Record<string, unknown>
  const fields = ["id", "clientDataJSON", "authenticatorData", "signature"] as const
  if (!fields.every((field) => typeof input[field] === "string" && (input[field] as string).length <= 8_192))
    return undefined
  try {
    return {
      id: input.id as string,
      clientDataJSON: fromBase64url(input.clientDataJSON as string),
      authenticatorData: fromBase64url(input.authenticatorData as string),
      signature: fromBase64url(input.signature as string),
    }
  } catch {
    return undefined
  }
}

/** Only the challenge, to find the pending entry; every check of the client data is WebAuthn.verifyAssertion's. */
function parseClientData(bytes: Uint8Array) {
  try {
    const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as Record<string, unknown>
    return typeof value.challenge === "string" ? { challenge: value.challenge } : undefined
  } catch {
    return undefined
  }
}
