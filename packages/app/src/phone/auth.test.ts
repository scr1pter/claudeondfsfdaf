import { describe, expect, test } from "bun:test"
import { readFile } from "node:fs/promises"
import path from "node:path"
import {
  AuthError,
  currentSession,
  finishGoogleSignIn,
  GOOGLE_SIGN_IN_FAILED,
  googleSignInFailed,
  googleSignInUrl,
  passwordSignIn,
  pkceChallenge,
  pkcePair,
  readAuthConfig,
  readSession,
  signOut,
  type KeyValue,
} from "./auth"

// WP A38: the phone signs in to the Vector account on its own origin, with the account service named by the site's
// /api/auth/config. These run against a fake account service; nothing leaves the test.

const config = { url: "https://accounts.example.test", publishableKey: "fixture-publishable-key" }

function memory(): KeyValue & { data: Map<string, string> } {
  const data = new Map<string, string>()
  return {
    data,
    get: (key) => data.get(key) ?? null,
    set: (key, value) => void data.set(key, value),
    remove: (key) => void data.delete(key),
  }
}

type Call = { url: string; init?: RequestInit }
function service(answer: (call: Call) => Response | Promise<Response>) {
  const calls: Call[] = []
  const fetcher = async (url: string, init?: RequestInit) => {
    calls.push({ url, init })
    return answer({ url, init })
  }
  return { calls, fetcher }
}
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
const tokens = (access = "access-1", refresh = "refresh-1") => ({
  access_token: access,
  refresh_token: refresh,
  expires_in: 3600,
  user: { email: "person@example.test" },
})

test("reads the account service from the site, or says accounts are unavailable", async () => {
  const ok = service(() => json({ available: true, url: "https://accounts.example.test/", publishableKey: "k" }))
  expect(await readAuthConfig(ok.fetcher)).toEqual({ url: "https://accounts.example.test", publishableKey: "k" })
  expect(ok.calls[0].url).toBe("/api/auth/config")
  for (const body of [{ available: false }, { available: true, url: "http://plain.test", publishableKey: "k" }, {}])
    await expect(readAuthConfig(service(() => json(body)).fetcher)).rejects.toThrow("temporarily unavailable")
  await expect(readAuthConfig(async () => Promise.reject(new Error("offline")))).rejects.toThrow(AuthError)
})

test("PKCE uses S256 as RFC 7636 appendix B computes it", async () => {
  expect(await pkceChallenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")).toBe(
    "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
  )
  const pair = await pkcePair()
  expect(pair.verifier).toMatch(/^[A-Za-z0-9_-]{64}$/)
  expect(pair.challenge).toBe(await pkceChallenge(pair.verifier))
})

describe("Google sign-in", () => {
  test("starts with a challenge and finishes with the kept verifier, once", async () => {
    const storage = memory()
    const start = new URL(await googleSignInUrl(config, "https://remote.vectordev.ai/phone/", storage))
    expect(start.origin + start.pathname).toBe("https://accounts.example.test/auth/v1/authorize")
    expect(start.searchParams.get("provider")).toBe("google")
    expect(start.searchParams.get("redirect_to")).toBe("https://remote.vectordev.ai/phone/")
    expect(start.searchParams.get("code_challenge_method")).toBe("s256")
    const verifier = storage.data.get("vector-phone-pkce")!
    expect(start.searchParams.get("code_challenge")).toBe(await pkceChallenge(verifier))

    const account = service(() => json(tokens()))
    const session = await finishGoogleSignIn(config, "code-1", storage, account.fetcher, 1_000)
    expect(session).toEqual({
      accessToken: "access-1",
      refreshToken: "refresh-1",
      expiresAt: 3_601_000,
      email: "person@example.test",
    })
    expect(account.calls[0].url).toBe("https://accounts.example.test/auth/v1/token?grant_type=pkce")
    expect(JSON.parse(String(account.calls[0].init?.body))).toEqual({ auth_code: "code-1", code_verifier: verifier })
    expect((account.calls[0].init?.headers as Record<string, string>).apikey).toBe("fixture-publishable-key")
    expect(readSession(storage)).toEqual(session)
    // The verifier is used once.
    await expect(finishGoogleSignIn(config, "code-1", storage, account.fetcher)).rejects.toThrow(AuthError)
  })

  test("an error coming back gets fixed words, and only for a sign-in this phone started", async () => {
    // A link anyone could send, with text of their own: nothing was started here, so nothing is said.
    const fresh = memory()
    expect(googleSignInFailed(fresh)).toBeUndefined()
    const started = memory()
    await googleSignInUrl(config, "https://remote.vectordev.ai/phone/", started)
    expect(googleSignInFailed(started)).toBe(GOOGLE_SIGN_IN_FAILED)
    // The attempt is over: its verifier is gone, and a second error link says nothing.
    expect(started.data.has("vector-phone-pkce")).toBe(false)
    expect(googleSignInFailed(started)).toBeUndefined()
  })
})

test("the app never shows a sign-in error's text from the address it was opened with", async () => {
  const app = await readFile(path.join(import.meta.dir, "app.tsx"), "utf8")
  expect(app).not.toMatch(/\.get\(\s*["']error(_description)?["']\s*\)/)
  expect(app).toContain("googleSignInFailed(storage)")
})

test("email and password sign-in, and a refusal in plain words", async () => {
  const storage = memory()
  const ok = service(() => json(tokens()))
  await passwordSignIn(config, " person@example.test ", "pw", storage, ok.fetcher)
  expect(ok.calls[0].url).toEndWith("grant_type=password")
  expect(JSON.parse(String(ok.calls[0].init?.body))).toEqual({ email: "person@example.test", password: "pw" })
  const refused = service(() => json({ error: "invalid_grant" }, 400))
  await expect(passwordSignIn(config, "a@b.test", "bad", memory(), refused.fetcher)).rejects.toThrow(
    "That email and password did not match.",
  )
})

describe("currentSession", () => {
  test("keeps a fresh session and refreshes one about to expire", async () => {
    const storage = memory()
    storage.set("vector-phone-session", JSON.stringify({ accessToken: "a", refreshToken: "r", expiresAt: 100_000 }))
    const none = service(() => json(tokens()))
    expect((await currentSession(config, storage, none.fetcher, 10_000))?.accessToken).toBe("a")
    expect(none.calls).toHaveLength(0)
    const refresh = service(() => json(tokens("a2", "r2")))
    const next = await currentSession(config, storage, refresh.fetcher, 50_000)
    expect(next?.accessToken).toBe("a2")
    expect(refresh.calls[0].url).toEndWith("grant_type=refresh_token")
    expect(JSON.parse(String(refresh.calls[0].init?.body))).toEqual({ refresh_token: "r" })
  })

  test("a refused refresh signs out; a network failure keeps the session and throws", async () => {
    const stale = JSON.stringify({ accessToken: "a", refreshToken: "r", expiresAt: 0 })
    const refused = memory()
    refused.set("vector-phone-session", stale)
    expect(await currentSession(config, refused, service(() => json({}, 401)).fetcher, 1)).toBeUndefined()
    expect(refused.data.has("vector-phone-session")).toBe(false)
    const offline = memory()
    offline.set("vector-phone-session", stale)
    await expect(
      currentSession(config, offline, async () => Promise.reject(new TypeError("offline")), 1),
    ).rejects.toThrow()
    expect(offline.data.has("vector-phone-session")).toBe(true)
    const down = memory()
    down.set("vector-phone-session", stale)
    await expect(currentSession(config, down, service(() => json({}, 503)).fetcher, 1)).rejects.toThrow()
    expect(down.data.has("vector-phone-session")).toBe(true)
  })

  test("a corrupt stored session reads as signed out", async () => {
    const storage = memory()
    storage.set("vector-phone-session", "{nope")
    expect(await currentSession(config, storage, service(() => json(tokens())).fetcher)).toBeUndefined()
    expect(storage.data.has("vector-phone-session")).toBe(false)
  })
})

test("signing out forgets the session even when the account service cannot be reached", async () => {
  const storage = memory()
  storage.set("vector-phone-session", JSON.stringify({ accessToken: "a", refreshToken: "r", expiresAt: 1 }))
  const account = service(() => json({}))
  await signOut(config, storage, account.fetcher)
  expect(storage.data.size).toBe(0)
  expect(account.calls[0].url).toBe("https://accounts.example.test/auth/v1/logout")
  expect((account.calls[0].init?.headers as Record<string, string>).authorization).toBe("Bearer a")
  storage.set("vector-phone-session", JSON.stringify({ accessToken: "a", refreshToken: "r", expiresAt: 1 }))
  await signOut(config, storage, async () => Promise.reject(new Error("offline")))
  expect(storage.data.size).toBe(0)
})
