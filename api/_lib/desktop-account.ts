import { createHash, randomBytes } from "node:crypto"
import { Option, Schema } from "effect"
import { accountAvatar } from "./account.js"
import { ApiError } from "./http.js"
import { persistentStore } from "./persistent-store.js"
import type { CliTokenUser } from "./cli-token.js"

const TTL_SECONDS = 300
const opaque = /^[A-Za-z0-9_-]{43}$/
const unavailable = () =>
  new ApiError(503, "DESKTOP_SIGN_IN_UNAVAILABLE", "Desktop sign-in is temporarily unavailable. Try again shortly.")
const invalid = () =>
  new ApiError(
    400,
    "DESKTOP_CODE_INVALID",
    "This sign-in link expired or was already used. Start sign-in again in Vector.",
  )

function binding(value: unknown) {
  if (
    !value ||
    typeof value !== "object" ||
    !("state" in value) ||
    !("challenge" in value) ||
    typeof value.state !== "string" ||
    typeof value.challenge !== "string" ||
    !opaque.test(value.state) ||
    !opaque.test(value.challenge) ||
    ("purpose" in value && value.purpose !== undefined && value.purpose !== "delete" && value.purpose !== "cli")
  )
    throw invalid()
  return {
    state: value.state,
    challenge: value.challenge,
    // A code for deleting the account buys a deletion grant instead of a sign-in (see cli-exchange.ts).
    ...("purpose" in value && (value.purpose === "delete" || value.purpose === "cli")
      ? { purpose: value.purpose }
      : {}),
  }
}

export async function mintDesktopCode(
  user: CliTokenUser & { name?: string; avatar?: string },
  input: unknown,
  fetcher: typeof fetch = fetch,
  now = Date.now(),
) {
  const request = binding(input)
  const code = randomBytes(32).toString("base64url")
  const expiresAt = now + TTL_SECONDS * 1_000
  const record = JSON.stringify({ ...request, user, expiresAt })
  if ((await persistentStore(["SET", codeKey(code), record, "EX", String(TTL_SECONDS), "NX"], fetcher)) !== "OK")
    throw unavailable()
  return { code, state: request.state, expiresAt }
}

export async function consumeDesktopCode(input: unknown, fetcher: typeof fetch = fetch, now = Date.now()) {
  if (
    !input ||
    typeof input !== "object" ||
    !("code" in input) ||
    !("state" in input) ||
    !("verifier" in input) ||
    typeof input.code !== "string" ||
    typeof input.state !== "string" ||
    typeof input.verifier !== "string" ||
    !opaque.test(input.code) ||
    !opaque.test(input.state) ||
    !/^[A-Za-z0-9._~-]{43,128}$/.test(input.verifier)
  )
    throw invalid()
  // Verification and deletion must be one transaction across all Vercel instances.
  // Incorrect bindings cannot burn a valid code, and two exchanges cannot both win.
  const script =
    "local raw = redis.call('GET', KEYS[1]); if not raw then return false end; local item = cjson.decode(raw); if item.state ~= ARGV[1] or item.challenge ~= ARGV[2] or item.expiresAt <= tonumber(ARGV[3]) then return false end; if item.purpose ~= nil and item.purpose ~= 'delete' and item.purpose ~= 'cli' then return false end; redis.call('DEL', KEYS[1]); return raw"
  const raw = await persistentStore(
    [
      "EVAL",
      script,
      "1",
      codeKey(input.code),
      input.state,
      createHash("sha256").update(input.verifier).digest("base64url"),
      String(now),
    ],
    fetcher,
  )
  if (typeof raw !== "string") throw invalid()
  const parsed = Option.getOrUndefined(
    Schema.decodeUnknownOption(
      Schema.fromJsonString(
        Schema.Struct({
          purpose: Schema.optional(Schema.Literals(["delete", "cli"])),
          user: Schema.Struct({
            id: Schema.String,
            email: Schema.String,
            name: Schema.optional(Schema.Unknown),
            avatar: Schema.optional(Schema.Unknown),
          }),
        }),
      ),
    )(raw),
  )
  if (!parsed) throw invalid()
  const purpose = parsed.purpose ?? "sign-in"
  // The name and photo are display-only, so a missing or odd value never fails the exchange.
  const name =
    "name" in parsed.user && typeof parsed.user.name === "string" ? parsed.user.name.trim().slice(0, 120) : ""
  const avatar = "avatar" in parsed.user ? accountAvatar(parsed.user.avatar) : undefined
  return {
    purpose,
    user: { id: parsed.user.id, email: parsed.user.email, ...(name ? { name } : {}), ...(avatar ? { avatar } : {}) },
  }
}

function codeKey(code: string) {
  return `vector:desktop-sign-in:${createHash("sha256").update(code).digest("hex")}`
}
