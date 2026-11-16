import { describe, expect, test } from "bun:test"
import { randomBytes } from "node:crypto"
import {
  SEAL_VERSION,
  dataKey,
  open,
  openJson,
  seal,
  sealJson,
  type DataKey,
} from "../../../api/_lib/everywhere/crypto"
import { ApiError } from "../../../api/_lib/http"
import { installFetchGuard } from "./lib/everywhere-fetch-guard"

installFetchGuard()

/*
 * VE-03 and E5: AES-256-GCM sealing with a key id. A tampered value, a value under another key and a value moved to
 * another record all fail. Keys are generated in the test.
 */

const fresh = (): DataKey => dataKey(randomBytes(32))
const CONTEXT = "vector:everywhere:install:slack:T0123ABCD"

function flip(text: string, index: number) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"
  const at = alphabet.indexOf(text[index]!)
  return text.slice(0, index) + alphabet[(at + 1) % alphabet.length] + text.slice(index + 1)
}

describe("seal and open", () => {
  test("a sealed value opens with the same key and context", () => {
    const keys = [fresh()]
    const token = `xoxb-${randomBytes(20).toString("hex")}`
    const sealed = seal(keys, token, CONTEXT)
    expect(sealed.startsWith(`${SEAL_VERSION}.${keys[0]!.id}.`)).toBe(true)
    expect(sealed).not.toContain(token)
    expect(sealed).not.toContain(token.slice(5, 25))
    expect(open(keys, sealed, CONTEXT)).toEqual({ ok: true, value: token })
  })

  test("every seal uses a new iv, so equal values never look alike", () => {
    const keys = [fresh()]
    const one = seal(keys, "same value", CONTEXT)
    const two = seal(keys, "same value", CONTEXT)
    expect(one).not.toBe(two)
    expect(one.split(".")[2]).not.toBe(two.split(".")[2])
  })

  test("text in any script and the empty string round-trip", () => {
    const keys = [fresh()]
    for (const value of ["", "Fix the login bug ✓", "日本語のテキスト", "emoji 🧪 and   separators", "a".repeat(100_000)])
      expect(open(keys, seal(keys, value, CONTEXT), CONTEXT)).toEqual({ ok: true, value })
  })

  test("a value larger than 1 MiB is refused", () => {
    expect(() => seal([fresh()], "a".repeat(1024 * 1024 + 1), CONTEXT)).toThrow(RangeError)
  })

  test("sealing with no key fails as the feature being off", () => {
    let caught: unknown
    try {
      seal([], "value", CONTEXT)
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(ApiError)
    expect((caught as ApiError).code).toBe("EVERYWHERE_OFF")
    expect((caught as ApiError).statusCode).toBe(503)
  })

  test("a context must be a store key: printable, no spaces, at most 512 characters", () => {
    const keys = [fresh()]
    for (const context of ["", "has space", "line\nbreak", "x".repeat(513), "tab\there"])
      expect(() => seal(keys, "value", context)).toThrow(RangeError)
    const sealed = seal(keys, "value", CONTEXT)
    expect(() => open(keys, sealed, "has space")).toThrow(RangeError)
  })
})

describe("tampering", () => {
  test("changing any character of the iv or the ciphertext fails as tampered or malformed", () => {
    const keys = [fresh()]
    const sealed = seal(keys, "a platform token", CONTEXT)
    const [version, keyId, iv, body] = sealed.split(".") as [string, string, string, string]
    for (let index = 0; index < iv.length; index++) {
      const result = open(keys, [version, keyId, flip(iv, index), body].join("."), CONTEXT)
      expect(result.ok).toBe(false)
      if (!result.ok) expect(["tampered", "malformed"]).toContain(result.reason)
    }
    for (let index = 0; index < body.length; index++) {
      const result = open(keys, [version, keyId, iv, flip(body, index)].join("."), CONTEXT)
      expect(result.ok).toBe(false)
      if (!result.ok) expect(["tampered", "malformed"]).toContain(result.reason)
    }
  })

  test("a truncated or extended ciphertext fails", () => {
    const keys = [fresh()]
    const sealed = seal(keys, "a platform token", CONTEXT)
    expect(open(keys, sealed.slice(0, -2), CONTEXT).ok).toBe(false)
    expect(open(keys, `${sealed}AA`, CONTEXT).ok).toBe(false)
  })

  test("a value moved to another record does not open there", () => {
    const keys = [fresh()]
    const sealed = seal(keys, "token for workspace one", CONTEXT)
    expect(open(keys, sealed, "vector:everywhere:install:slack:T9999ZZZZ")).toEqual({ ok: false, reason: "tampered" })
  })

  test("a value sealed under another key fails as an unknown key", () => {
    const sealed = seal([fresh()], "value", CONTEXT)
    expect(open([fresh()], sealed, CONTEXT)).toEqual({ ok: false, reason: "unknown-key" })
  })

  test("a value whose key id was swapped to a key the ring holds fails as tampered", () => {
    const first = fresh()
    const second = fresh()
    const sealed = seal([first], "value", CONTEXT)
    const swapped = sealed.replace(`.${first.id}.`, `.${second.id}.`)
    expect(open([first, second], swapped, CONTEXT)).toEqual({ ok: false, reason: "tampered" })
  })

  test("an older key in the ring still opens what it sealed, and new seals use the first key", () => {
    const old = fresh()
    const current = fresh()
    const before = seal([old], "sealed before rotation", CONTEXT)
    expect(open([current, old], before, CONTEXT)).toEqual({ ok: true, value: "sealed before rotation" })
    expect(seal([current, old], "after", CONTEXT).split(".")[1]).toBe(current.id)
  })

  test("malformed input is refused without throwing", () => {
    const keys = [fresh()]
    const sealed = seal(keys, "value", CONTEXT)
    for (const input of [
      undefined,
      null,
      42,
      {},
      "",
      "ves1",
      "ves2" + sealed.slice(4),
      sealed.replace(/\./g, ":"),
      sealed + ".extra",
      "ves1.short.iv.body",
      "x".repeat(3_000_000),
    ])
      expect(open(keys, input, CONTEXT)).toEqual({ ok: false, reason: "malformed" })
  })

  test("non-canonical base64url is refused, so one value has one spelling", () => {
    const keys = [fresh()]
    // 6 bytes of text and a 16-byte tag are 22 bytes: 30 base64url characters, whose last carries 4 spare bits.
    const sealed = seal(keys, "value!", CONTEXT)
    const [version, keyId, iv, body] = sealed.split(".") as [string, string, string, string]
    expect(body).toHaveLength(30)
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"
    const last = alphabet.indexOf(body.at(-1)!)
    const spare = alphabet[(last & ~0b1111) | ((last + 1) & 0b1111)]!
    const respelled = body.slice(0, -1) + spare
    // The respelled text decodes to the very same bytes, so only the canonical-spelling check refuses it.
    expect(Buffer.from(respelled, "base64url").equals(Buffer.from(body, "base64url"))).toBe(true)
    expect(open(keys, [version, keyId, iv, respelled].join("."), CONTEXT)).toEqual({ ok: false, reason: "malformed" })
  })
})

describe("JSON values", () => {
  test("sealJson and openJson round-trip and decode", () => {
    const keys = [fresh()]
    const body = { task: "Fix the flaky test", context: [{ from: "teammate", text: "It fails on Windows" }] }
    const sealed = sealJson(keys, body, "vector:everywhere:job:vej_0000000000000000000000:body")
    const decode = (value: unknown) =>
      typeof value === "object" && value !== null && "task" in value ? (value as typeof body) : undefined
    expect(openJson(keys, sealed, "vector:everywhere:job:vej_0000000000000000000000:body", decode)).toEqual({
      ok: true,
      value: body,
    })
    expect(openJson(keys, sealed, "vector:everywhere:job:vej_0000000000000000000000:body", () => undefined)).toEqual({
      ok: false,
      reason: "malformed",
    })
    expect(openJson(keys, seal(keys, "{not json", CONTEXT), CONTEXT, decode)).toEqual({ ok: false, reason: "malformed" })
  })

  test("only JSON values can be sealed", () => {
    expect(() => sealJson([fresh()], undefined, CONTEXT)).toThrow(TypeError)
  })
})
