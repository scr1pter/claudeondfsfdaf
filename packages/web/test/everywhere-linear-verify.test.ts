import { expect, test } from "bun:test"
import { randomBytes } from "node:crypto"
import { hmacSha256Hex } from "../../../api/_lib/everywhere/signature"
import { verifyLinear } from "../../../api/_lib/everywhere/linear/verify"
import { installFetchGuard } from "./lib/everywhere-fetch-guard"

installFetchGuard()
test("Linear authenticates original bytes and signed millisecond timestamps within sixty seconds", () => {
  const secret = randomBytes(24).toString("hex")
  const now = Date.now()
  for (const difference of [0, 60_000, -60_000, 61_000, -61_000]) {
    const raw = new TextEncoder().encode(`{ "webhookTimestamp": ${now + difference}, "text": "é" }`)
    const headers = new Headers({ "linear-signature": hmacSha256Hex(secret, raw) })
    expect(verifyLinear(raw, headers, secret, now).ok).toBe(Math.abs(difference) <= 60_000)
    expect(verifyLinear(new TextEncoder().encode(`${new TextDecoder().decode(raw)} `), headers, secret, now).ok).toBe(false)
    expect(verifyLinear(raw, headers, undefined, now).ok).toBe(false)
  }
})
