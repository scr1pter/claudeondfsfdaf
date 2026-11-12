import { hexSignatureValid, timestampFresh } from "../signature.js"

/** Slack signs the original bytes, including form encoding for interactivity. */
export function verifySlack(raw: Uint8Array, headers: Headers, secret: string | undefined, now: number): boolean {
  const timestamp = headers.get("x-slack-request-timestamp")
  return timestampFresh(timestamp, "s", now, 5 * 60_000) && hexSignatureValid({
    secret, message: [`v0:${timestamp}:`, raw], signature: headers.get("x-slack-signature"), prefix: "v0=",
  })
}

export function slackObject(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

export function slackId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Z][A-Z0-9]{1,31}$/.test(value)
}

export function slackTimestamp(value: unknown): value is string {
  return typeof value === "string" && /^[0-9]{10,16}\.[0-9]{6}$/.test(value)
}
