import { expect, test } from "bun:test"
import { randomBytes } from "node:crypto"
import { hmacSha256Hex } from "../../../api/_lib/everywhere/signature"
import { verifySlack } from "../../../api/_lib/everywhere/slack/verify"
import { installFetchGuard } from "./lib/everywhere-fetch-guard"

installFetchGuard()
test("Slack verifies exact raw bytes and a timestamp within five minutes", () => {
  const secret = randomBytes(24).toString("hex")
  const now = Date.now()
  const timestamp = String(Math.floor(now / 1000))
  for (const body of ['{ "text": "é" }', "payload=%7B%22text%22%3A%22a%2Bb%22%7D"]) {
    const raw = new TextEncoder().encode(body)
    const headers = new Headers({ "x-slack-request-timestamp": timestamp,
      "x-slack-signature": `v0=${hmacSha256Hex(secret, `v0:${timestamp}:`, raw)}` })
    expect(verifySlack(raw, headers, secret, now)).toBe(true)
    expect(verifySlack(new TextEncoder().encode(`${body} `), headers, secret, now)).toBe(false)
    expect(verifySlack(raw, headers, secret, now + 301_000)).toBe(false)
    expect(verifySlack(raw, headers, secret, now - 301_000)).toBe(false)
    expect(verifySlack(raw, headers, undefined, now)).toBe(false)
    headers.set("x-slack-signature", "v0=bad")
    expect(verifySlack(raw, headers, secret, now)).toBe(false)
  }
})
