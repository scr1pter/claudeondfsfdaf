import { fromBase64url, random, toBase64url } from "@vectordevai/core/remote/crypto"

// The phone's passkeys for Vector Remote (WP A42, S6). Pairing makes one passkey per computer, its challenge bound to
// the pairing transcript; allowing a request once signs a challenge the computer issued for that request. The computer
// checks both itself (packages/core/src/webauthn/verify.ts), with the origin exactly the phone app's and user
// verification required. Nothing here reaches Vector's servers.
//
// Safari lets a page ask for a passkey only straight from a tap, so callers prepare everything first and call these
// from the tap's handler.

export type PasskeyRegistration = { id: string; clientDataJSON: Uint8Array; attestationObject: Uint8Array }
export type PasskeyAssertion = { id: string; clientDataJSON: string; authenticatorData: string; signature: string }

export type PasskeyAdapter = {
  create(input: { challenge: Uint8Array; rpId: string; computerName: string }): Promise<PasskeyRegistration>
  get(input: { challenge: string; rpId: string; credential: string }): Promise<PasskeyAssertion>
}

export class PasskeyError extends Error {
  constructor(
    readonly reason: "cancelled" | "unsupported" | "failed",
    message: string,
  ) {
    super(message)
  }
}

const TIMEOUT_MS = 120_000

function bytes(value: ArrayBuffer | ArrayBufferView) {
  return value instanceof ArrayBuffer
    ? new Uint8Array(value)
    : new Uint8Array(value.buffer, value.byteOffset, value.byteLength).slice()
}

function refusal(error: unknown): PasskeyError {
  const name = error instanceof Error ? error.name : ""
  if (name === "NotAllowedError")
    return new PasskeyError("cancelled", "The passkey was cancelled or timed out. Try again.")
  if (name === "SecurityError" || name === "InvalidStateError")
    return new PasskeyError("failed", "This phone could not use a passkey here.")
  return new PasskeyError("failed", "The passkey did not work. Try again.")
}

type Credentials = Pick<CredentialsContainer, "create" | "get">

/** Passkeys through the browser's WebAuthn: a platform passkey, user verification required, no attestation. */
export function browserPasskeys(credentials: Credentials | undefined = globalThis.navigator?.credentials): PasskeyAdapter {
  const available = () => {
    if (!credentials || typeof globalThis.PublicKeyCredential === "undefined")
      throw new PasskeyError("unsupported", "This browser cannot make passkeys, which Vector Remote needs.")
    return credentials
  }
  return {
    async create(input) {
      const container = available()
      const created = await container
        .create({
          publicKey: {
            challenge: input.challenge.slice(),
            rp: { id: input.rpId, name: "Vector Remote" },
            // A fresh random handle per pairing: the passkey names no account and no person.
            user: { id: random(16), name: `Vector Remote · ${input.computerName}`.slice(0, 64), displayName: "Vector Remote" },
            pubKeyCredParams: [
              { type: "public-key", alg: -7 },
              { type: "public-key", alg: -8 },
              { type: "public-key", alg: -257 },
            ],
            authenticatorSelection: { userVerification: "required", residentKey: "discouraged" },
            attestation: "none",
            timeout: TIMEOUT_MS,
          },
        })
        .catch((error: unknown) => {
          throw refusal(error)
        })
      const credential = created as PublicKeyCredential | null
      const response = credential?.response as AuthenticatorAttestationResponse | undefined
      if (!credential || !response?.attestationObject) throw new PasskeyError("failed", "No passkey was made.")
      return {
        id: toBase64url(bytes(credential.rawId)),
        clientDataJSON: bytes(response.clientDataJSON),
        attestationObject: bytes(response.attestationObject),
      }
    },
    async get(input) {
      const container = available()
      const got = await container
        .get({
          publicKey: {
            challenge: fromBase64url(input.challenge),
            rpId: input.rpId,
            allowCredentials: [{ type: "public-key", id: fromBase64url(input.credential) }],
            userVerification: "required",
            timeout: TIMEOUT_MS,
          },
        })
        .catch((error: unknown) => {
          throw refusal(error)
        })
      const credential = got as PublicKeyCredential | null
      const response = credential?.response as AuthenticatorAssertionResponse | undefined
      if (!credential || !response?.signature) throw new PasskeyError("failed", "The passkey gave no answer.")
      return {
        id: toBase64url(bytes(credential.rawId)),
        clientDataJSON: toBase64url(bytes(response.clientDataJSON)),
        authenticatorData: toBase64url(bytes(response.authenticatorData)),
        signature: toBase64url(bytes(response.signature)),
      }
    },
  }
}
