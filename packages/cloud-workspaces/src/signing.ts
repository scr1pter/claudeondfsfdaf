import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto"
import { accountId, WorkspaceError } from "./protocol.js"

function payload(input: {
  accountId: string
  method: string
  path: string
  body: string
  timestamp: string
  nonce: string
}) {
  return [
    input.accountId,
    input.method,
    input.path,
    input.timestamp,
    input.nonce,
    createHash("sha256").update(input.body).digest("hex"),
  ].join("\n")
}

export function signWorkspaceRequest(input: {
  secret: string
  accountId: string
  method: string
  path: string
  body: string
  now?: number
  nonce?: string
}) {
  if (input.secret.length < 32 || !accountId(input.accountId)) throw new Error("Workspace signing is not configured.")
  const timestamp = String(input.now ?? Date.now())
  const nonce = input.nonce ?? randomUUID()
  return {
    "x-vector-account": input.accountId,
    "x-vector-timestamp": timestamp,
    "x-vector-nonce": nonce,
    "x-vector-signature": createHmac("sha256", input.secret)
      .update(payload({ ...input, timestamp, nonce }))
      .digest("hex"),
  }
}

export function verifyWorkspaceRequest(input: {
  secret: string
  headers: Headers
  method: string
  path: string
  body: string
  now?: number
}) {
  const owner = input.headers.get("x-vector-account")
  const timestamp = input.headers.get("x-vector-timestamp") ?? ""
  const nonce = input.headers.get("x-vector-nonce") ?? ""
  const signature = input.headers.get("x-vector-signature") ?? ""
  if (
    input.secret.length < 32 ||
    !accountId(owner) ||
    !/^\d{13}$/.test(timestamp) ||
    Math.abs((input.now ?? Date.now()) - Number(timestamp)) > 60_000 ||
    !/^[0-9a-f-]{36}$/.test(nonce) ||
    !/^[0-9a-f]{64}$/.test(signature)
  )
    throw denied()
  const expected = createHmac("sha256", input.secret)
    .update(
      payload({
        accountId: owner,
        method: input.method,
        path: input.path,
        body: input.body,
        timestamp,
        nonce,
      }),
    )
    .digest()
  if (!timingSafeEqual(expected, Buffer.from(signature, "hex"))) throw denied()
  return { accountId: owner, nonce, expiresAt: Number(timestamp) + 60_000 }
}

function denied() {
  return new WorkspaceError("WORKSPACE_AUTH_REQUIRED", "A current workspace service identity is required.", 401)
}
