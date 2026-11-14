import { describe, expect, test } from "bun:test"
import { createSign, generateKeyPairSync } from "node:crypto"
import { WebAuthn } from "../../src/webauthn/verify"

// A software authenticator, built the way a phone's platform authenticator answers (WebAuthn Level 3 §6.1 and §6.5):
// authenticator data, a CBOR attestation object with format "none", client data JSON, and a DER ECDSA signature. The
// verifier must accept exactly what a real ceremony on the expected origin produces, and refuse each change.

const ORIGIN = "https://remote.vectordev.ai"
const RP_ID = "remote.vectordev.ai"
const encoder = new TextEncoder()

function cbor(value: unknown): Uint8Array {
  const head = (major: number, length: number) => {
    if (length < 24) return [(major << 5) | length]
    if (length < 256) return [(major << 5) | 24, length]
    if (length < 65_536) return [(major << 5) | 25, length >> 8, length & 0xff]
    return [(major << 5) | 26, (length >>> 24) & 0xff, (length >> 16) & 0xff, (length >> 8) & 0xff, length & 0xff]
  }
  if (typeof value === "number") return new Uint8Array(value >= 0 ? head(0, value) : head(1, -1 - value))
  if (value instanceof Uint8Array) return new Uint8Array([...head(2, value.byteLength), ...value])
  if (typeof value === "string") {
    const bytes = encoder.encode(value)
    return new Uint8Array([...head(3, bytes.byteLength), ...bytes])
  }
  if (value instanceof Map) {
    const parts = [...value].flatMap(([key, item]) => [...cbor(key), ...cbor(item)])
    return new Uint8Array([...head(5, value.size), ...parts])
  }
  throw new Error("unsupported")
}

const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64url")
const sha = async (bytes: Uint8Array) => new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array(bytes)))

type Kind = "es256" | "ed25519" | "rs256"

async function authenticator(kind: Kind = "es256") {
  const id = crypto.getRandomValues(new Uint8Array(32))
  const keys =
    kind === "es256"
      ? generateKeyPairSync("ec", { namedCurve: "P-256" })
      : kind === "ed25519"
        ? generateKeyPairSync("ed25519")
        : generateKeyPairSync("rsa", { modulusLength: 2048 })
  const jwk = keys.publicKey.export({ format: "jwk" }) as Record<string, string>
  const bytes = (text: string) => new Uint8Array(Buffer.from(text, "base64url"))
  const cose =
    kind === "es256"
      ? new Map<number, unknown>([
          [1, 2],
          [3, -7],
          [-1, 1],
          [-2, bytes(jwk.x!)],
          [-3, bytes(jwk.y!)],
        ])
      : kind === "ed25519"
        ? new Map<number, unknown>([
            [1, 1],
            [3, -8],
            [-1, 6],
            [-2, bytes(jwk.x!)],
          ])
        : new Map<number, unknown>([
            [1, 3],
            [3, -257],
            [-1, bytes(jwk.n!)],
            [-2, bytes(jwk.e!)],
          ])
  let counter = 0
  const sign = (data: Uint8Array) => {
    if (kind === "ed25519") return new Uint8Array(require("node:crypto").sign(null, data, keys.privateKey))
    const signer = createSign("sha256")
    signer.update(data)
    return new Uint8Array(signer.sign(keys.privateKey))
  }
  const authData = async (input: { rpId?: string; flags?: number; counter?: number; attested?: boolean }) => {
    const flags = input.flags ?? 0x05 | (input.attested ? 0x40 : 0)
    const count = input.counter ?? counter
    const parts = [
      ...(await sha(encoder.encode(input.rpId ?? RP_ID))),
      flags,
      (count >>> 24) & 0xff,
      (count >> 16) & 0xff,
      (count >> 8) & 0xff,
      count & 0xff,
    ]
    if (input.attested)
      parts.push(...new Uint8Array(16), id.byteLength >> 8, id.byteLength & 0xff, ...id, ...cbor(cose))
    return new Uint8Array(parts)
  }
  const clientData = (input: { type: string; challenge: Uint8Array; origin?: string; extra?: object }) =>
    encoder.encode(
      JSON.stringify({
        type: input.type,
        challenge: b64(input.challenge),
        origin: input.origin ?? ORIGIN,
        ...input.extra,
      }),
    )
  return {
    id: b64(id),
    async create(
      challenge: Uint8Array,
      options: { origin?: string; rpId?: string; flags?: number; extra?: object } = {},
    ) {
      const data = await authData({ rpId: options.rpId, flags: options.flags, attested: true })
      return {
        clientDataJSON: clientData({
          type: "webauthn.create",
          challenge,
          origin: options.origin,
          extra: options.extra,
        }),
        attestationObject: cbor(
          new Map<string, unknown>([
            ["fmt", "none"],
            ["attStmt", new Map()],
            ["authData", data],
          ]),
        ),
      }
    },
    async get(
      challenge: Uint8Array,
      options: { origin?: string; rpId?: string; flags?: number; type?: string; counter?: number; extra?: object } = {},
    ) {
      if (options.counter === undefined && kind !== "ed25519") counter += 1
      const authenticatorData = await authData({ rpId: options.rpId, flags: options.flags, counter: options.counter })
      const clientDataJSON = clientData({
        type: options.type ?? "webauthn.get",
        challenge,
        origin: options.origin,
        extra: options.extra,
      })
      const signature = sign(new Uint8Array([...authenticatorData, ...(await sha(clientDataJSON))]))
      return { id: b64(id), clientDataJSON, authenticatorData, signature }
    },
  }
}

const challenge = () => crypto.getRandomValues(new Uint8Array(32))
const expected = (value: Uint8Array) => ({ challenge: value, origin: ORIGIN, rpId: RP_ID })

async function code(promise: Promise<unknown>) {
  try {
    await promise
    return "accepted"
  } catch (error) {
    if (error instanceof WebAuthn.WebAuthnError) return error.code
    throw error
  }
}

describe("WebAuthn registration", () => {
  test("reads a P-256 passkey made on the expected origin", async () => {
    const device = await authenticator()
    const value = challenge()
    const credential = await WebAuthn.verifyRegistration(await device.create(value), expected(value))
    expect(credential.id).toBe(device.id)
    expect(credential.algorithm).toBe(-7)
    expect(credential.publicKey.kty).toBe("EC")
    expect(credential.signCount).toBe(0)
    expect(credential.userVerified).toBe(true)
    // What the relying party stores is plain JSON.
    expect(JSON.parse(JSON.stringify(credential))).toEqual(credential)
  })

  test("reads Ed25519 and RS256 passkeys", async () => {
    for (const kind of ["ed25519", "rs256"] as const) {
      const device = await authenticator(kind)
      const value = challenge()
      const credential = await WebAuthn.verifyRegistration(await device.create(value), expected(value))
      expect(credential.algorithm).toBe(kind === "ed25519" ? -8 : -257)
    }
  })

  test("refuses a passkey made elsewhere, for another challenge, or without verifying the user", async () => {
    const device = await authenticator()
    const value = challenge()
    expect(await code(WebAuthn.verifyRegistration(await device.create(challenge()), expected(value)))).toBe("challenge")
    for (const origin of [
      "https://remote.vectordev.ai.evil.example",
      "http://remote.vectordev.ai",
      "https://remote.vectordev.ai:8443",
      "https://evil.example",
      "https://remote.vectordev.ai/",
    ])
      expect(await code(WebAuthn.verifyRegistration(await device.create(value, { origin }), expected(value)))).toBe(
        "origin",
      )
    expect(
      await code(WebAuthn.verifyRegistration(await device.create(value, { rpId: "vectordev.ai" }), expected(value))),
    ).toBe("rp-id")
    expect(await code(WebAuthn.verifyRegistration(await device.create(value, { flags: 0x41 }), expected(value)))).toBe(
      "user-verification",
    )
    expect(await code(WebAuthn.verifyRegistration(await device.create(value, { flags: 0x44 }), expected(value)))).toBe(
      "user-presence",
    )
    expect(
      await code(
        WebAuthn.verifyRegistration(await device.create(value, { extra: { crossOrigin: true } }), expected(value)),
      ),
    ).toBe("cross-origin")
    const made = await device.create(value)
    const json = JSON.parse(new TextDecoder().decode(made.clientDataJSON))
    expect(
      await code(
        WebAuthn.verifyRegistration(
          { ...made, clientDataJSON: encoder.encode(JSON.stringify({ ...json, type: "webauthn.get" })) },
          expected(value),
        ),
      ),
    ).toBe("type")
  })

  test("refuses an attestation object with extra or missing bytes", async () => {
    const device = await authenticator()
    const value = challenge()
    const made = await device.create(value)
    const longer = new Uint8Array([...made.attestationObject, 0])
    expect(await code(WebAuthn.verifyRegistration({ ...made, attestationObject: longer }, expected(value)))).toBe(
      "malformed",
    )
    const shorter = made.attestationObject.slice(0, made.attestationObject.byteLength - 4)
    expect(await code(WebAuthn.verifyRegistration({ ...made, attestationObject: shorter }, expected(value)))).toBe(
      "malformed",
    )
  })
})

describe("WebAuthn assertions", () => {
  async function registered(kind: Kind = "es256") {
    const device = await authenticator(kind)
    const value = challenge()
    const credential = await WebAuthn.verifyRegistration(await device.create(value), expected(value))
    return {
      device,
      credential: { id: credential.id, algorithm: credential.algorithm, publicKey: credential.publicKey, signCount: 0 },
    }
  }

  test("accepts a signed approval and returns the next counter", async () => {
    for (const kind of ["es256", "ed25519", "rs256"] as const) {
      const { device, credential } = await registered(kind)
      const value = challenge()
      const result = await WebAuthn.verifyAssertion(await device.get(value), credential, expected(value))
      expect(result.userVerified).toBe(true)
      expect(result.signCount).toBe(kind === "ed25519" ? 0 : 1)
    }
  })

  test("refuses each change to the ceremony", async () => {
    const { device, credential } = await registered()
    const value = challenge()
    expect(await code(WebAuthn.verifyAssertion(await device.get(challenge()), credential, expected(value)))).toBe(
      "challenge",
    )
    expect(
      await code(
        WebAuthn.verifyAssertion(
          await device.get(value, { origin: "https://vectordev.ai" }),
          credential,
          expected(value),
        ),
      ),
    ).toBe("origin")
    expect(
      await code(
        WebAuthn.verifyAssertion(await device.get(value, { rpId: "vectordev.ai" }), credential, expected(value)),
      ),
    ).toBe("rp-id")
    expect(
      await code(
        WebAuthn.verifyAssertion(await device.get(value, { type: "webauthn.create" }), credential, expected(value)),
      ),
    ).toBe("type")
    expect(
      await code(WebAuthn.verifyAssertion(await device.get(value, { flags: 0x01 }), credential, expected(value))),
    ).toBe("user-verification")
    expect(
      await code(
        WebAuthn.verifyAssertion(
          await device.get(value, { extra: { topOrigin: "https://evil.example" } }),
          credential,
          expected(value),
        ),
      ),
    ).toBe("cross-origin")
    const signed = await device.get(value)
    const tampered = new Uint8Array(signed.authenticatorData)
    tampered[36] ^= 1
    expect(
      await code(WebAuthn.verifyAssertion({ ...signed, authenticatorData: tampered }, credential, expected(value))),
    ).toBe("signature")
    expect(await code(WebAuthn.verifyAssertion({ ...signed, id: "other" }, credential, expected(value)))).toBe(
      "credential",
    )
    const other = await registered()
    expect(await code(WebAuthn.verifyAssertion(signed, other.credential, expected(value)))).toBe("credential")
    expect(
      await code(WebAuthn.verifyAssertion({ ...signed, id: other.credential.id }, other.credential, expected(value))),
    ).toBe("signature")
  })

  test("refuses a counter that does not go up", async () => {
    const { device, credential } = await registered()
    const value = challenge()
    const first = await WebAuthn.verifyAssertion(await device.get(value), credential, expected(value))
    const stored = { ...credential, signCount: first.signCount }
    expect(await code(WebAuthn.verifyAssertion(await device.get(value, { counter: 1 }), stored, expected(value)))).toBe(
      "counter",
    )
    expect(await code(WebAuthn.verifyAssertion(await device.get(value, { counter: 0 }), stored, expected(value)))).toBe(
      "counter",
    )
    expect(
      (await WebAuthn.verifyAssertion(await device.get(value, { counter: 7 }), stored, expected(value))).signCount,
    ).toBe(7)
  })

  test("can leave user verification to the caller", async () => {
    const { device, credential } = await registered()
    const value = challenge()
    const result = await WebAuthn.verifyAssertion(await device.get(value, { flags: 0x01 }), credential, {
      ...expected(value),
      requireUserVerification: false,
    })
    expect(result.userVerified).toBe(false)
  })
})

describe("WebAuthn encodings", () => {
  test("turns a DER signature into r || s, with and without leading zeros", () => {
    const r = new Uint8Array(32).fill(0x81)
    const s = new Uint8Array([0x01, 0x02])
    const der = new Uint8Array([0x30, 4 + 33 + 2, 0x02, 33, 0, ...r, 0x02, 2, ...s])
    const raw = WebAuthn.derToRaw(der, 32)
    expect([...raw.subarray(0, 32)]).toEqual([...r])
    expect([...raw.subarray(32)]).toEqual([...new Uint8Array(30), 1, 2])
    expect(() => WebAuthn.derToRaw(new Uint8Array([0x30, 6, 0x02, 1, 0x80, 0x02, 1, 1]), 32)).toThrow()
    expect(() => WebAuthn.derToRaw(new Uint8Array([0x30, 7, 0x02, 2, 0, 1, 0x02, 1, 1]), 32)).toThrow()
    expect(() => WebAuthn.derToRaw(new Uint8Array([0x30, 6, 0x02, 1, 1, 0x02, 1, 1, 0]), 32)).toThrow()
  })

  test("reads CBOR maps, refuses indefinite lengths and repeated keys", () => {
    const decoded = WebAuthn.decodeCbor(
      cbor(
        new Map<unknown, unknown>([
          ["a", 1],
          [-2, new Uint8Array([7])],
        ]),
      ),
    )
    expect(decoded.value).toEqual(
      new Map<unknown, unknown>([
        ["a", 1],
        [-2, new Uint8Array([7])],
      ]),
    )
    expect(() => WebAuthn.decodeCbor(new Uint8Array([0x5f]))).toThrow()
    expect(() => WebAuthn.decodeCbor(new Uint8Array([0xa2, 0x01, 0x01, 0x01, 0x02]))).toThrow()
    expect(() => WebAuthn.decodeCbor(new Uint8Array([0xfb, 0, 0, 0, 0, 0, 0, 0, 0]))).toThrow()
  })

  test("names the relying party from an exact origin", () => {
    expect(WebAuthn.rpIdFor(ORIGIN)).toBe(RP_ID)
    expect(() => WebAuthn.rpIdFor(`${ORIGIN}/phone/`)).toThrow()
  })

  test("uses no Bun or Node module, so it runs in Electron's main process and a browser", async () => {
    const source = await Bun.file(new URL("../../src/webauthn/verify.ts", import.meta.url)).text()
    expect(source).not.toMatch(/from "(?:node:|bun)/)
    expect(source).not.toMatch(/\bBun\./)
    expect(source).not.toMatch(/console\./)
  })
})
