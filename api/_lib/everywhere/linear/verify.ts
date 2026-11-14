import { hexSignatureValid, timestampFresh } from "../signature.js"

export function linearObject(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

export function linearId(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
}

/** Native HMAC is checked before decoding; the signed millisecond timestamp is then bounded in both directions. */
export function verifyLinear(raw: Uint8Array, headers: Headers, secret: string | undefined, now: number):
  { readonly ok: true; readonly body: Record<string, unknown> } | { readonly ok: false; readonly status: number } {
  if (!hexSignatureValid({ secret, message: raw, signature: headers.get("linear-signature") })) return { ok: false, status: 401 }
  try {
    const body = linearObject(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw)))
    if (!timestampFresh(body.webhookTimestamp, "ms", now, 60_000)) return { ok: false, status: 401 }
    return { ok: true, body }
  } catch { return { ok: false, status: 400 } }
}
