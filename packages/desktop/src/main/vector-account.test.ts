import { expect, test } from "bun:test"
import { createHash, randomBytes } from "node:crypto"
import { createVectorAccount, refreshVectorModels, syncVectorAccount } from "./vector-account"

const PHOTO = "https://lh3.googleusercontent.com/a/fixture=s96-c"
const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])

const claims = (value: Record<string, unknown>) => Buffer.from(JSON.stringify(value)).toString("base64url")
const desktopToken = (extra: Record<string, unknown> = {}) =>
  `vct_${claims({ sub: "account-fixture", client: "desktop", ...extra })}.${randomBytes(32).toString("base64url")}`

function fixture() {
  const state = {
    stored: undefined as unknown,
    secure: true,
    now: 1_000,
    failStorage: false,
    fetchDelay: undefined as Promise<void> | undefined,
    syncDelay: undefined as Promise<void> | undefined,
    // Holds the local server's read of the account's models until a test resolves it.
    modelsDelay: undefined as Promise<void> | undefined,
    failSync: false,
    codium: {} as Record<string, unknown>,
    name: undefined as string | undefined,
    avatar: undefined as string | undefined,
    ttl: 100_000,
    profile: undefined as Record<string, unknown> | undefined,
    photo: () => new Response(png, { headers: { "content-type": "image/png" } }),
    // vectordev.ai's billing routes, the public Codium configuration and account deletion.
    billing: (_url: string, _init: RequestInit) =>
      Response.json({ url: "https://checkout.stripe.com/c/pay/cs_fixture" }) as Response,
    config: {} as unknown,
    deletion: (_init: RequestInit) =>
      Response.json({ deleted: true, email: "fixture@example.test", cliTokens: "revoked" }) as Response,
    // What the exchange answers, when a test needs something other than a sign-in token.
    exchange: undefined as ((init: RequestInit) => Response) | undefined,
    outcome: "completed" as "completed" | "cancelled" | "closed" | "failed" | "busy",
    // Holds the billing window open until a test resolves it.
    billingDelay: undefined as Promise<void> | undefined,
  }
  const fetched: string[] = []
  const urls: string[] = []
  const tokens: Array<string | undefined> = []
  // Every credential write the local server got, in order: a sync (sign-in, sign-out) or a models read.
  const engine: Array<[string, string | undefined]> = []
  const statuses: unknown[] = []
  const requests: RequestInit[] = []
  const windows: string[] = []
  const focused: true[] = []
  const writes: unknown[] = []
  const secrets = new Map<string, string>()
  // A sign-in token minted for the desktop: its claims say client "desktop" (only vectordev.ai checks the signature).
  const token = desktopToken()
  const controller = createVectorAccount({
    read: () => state.stored,
    write: (value) => {
      writes.push(value)
      state.stored = value
    },
    clear: async () => {
      state.stored = undefined
    },
    available: async () => state.secure,
    encrypt: async (value) => {
      if (state.failStorage) throw new Error("synthetic vault failure")
      const ciphertext = randomBytes(32).toString("base64")
      secrets.set(ciphertext, value)
      return ciphertext
    },
    decrypt: async (value) => {
      const secret = secrets.get(value)
      if (!secret) throw new Error("Unknown fixture ciphertext")
      return secret
    },
    openBrowser: async (url) => {
      urls.push(url)
    },
    fetch: async (url, init) => {
      fetched.push(url)
      requests.push(init)
      if (url === "https://vectordev.ai/api/model-plans/status") return Response.json(state.codium)
      if (url === "https://vectordev.ai/api/account/profile")
        return state.profile ? Response.json(state.profile) : new Response(null, { status: 503 })
      if (url === "https://vectordev.ai/api/model-plans/config") return Response.json(state.config)
      if (url.startsWith("https://vectordev.ai/api/model-plans/")) return state.billing(url, init)
      if (url === "https://vectordev.ai/api/account/delete") return state.deletion(init)
      if (url !== "https://vectordev.ai/api/account/cli-exchange") return state.photo()
      await state.fetchDelay
      if (state.exchange) return state.exchange(init)
      return Response.json({
        token,
        expiresAt: state.now + state.ttl,
        user: {
          email: "fixture@example.test",
          ...(state.name === undefined ? {} : { name: state.name }),
          ...(state.avatar === undefined ? {} : { avatar: state.avatar }),
        },
      })
    },
    sync: async (value) => {
      tokens.push(value)
      engine.push(["sync", value])
      await state.syncDelay
      if (state.failSync) throw new Error("WSL termination not confirmed")
    },
    models: async (value) => {
      engine.push(["models", value])
      await state.modelsDelay
    },
    changed: (status) => statuses.push(status),
    billingWindow: async (url) => {
      windows.push(url)
      await state.billingDelay
      return state.outcome
    },
    focusBilling: () => {
      focused.push(true)
    },
    now: () => state.now,
  })
  const callback = () =>
    `vector://auth/callback?${new URLSearchParams({ code: randomBytes(32).toString("base64url"), state: new URL(urls.at(-1)!).searchParams.get("state")! })}`
  return {
    controller,
    state,
    urls,
    tokens,
    engine,
    statuses,
    requests,
    fetched,
    token,
    callback,
    windows,
    writes,
    focused,
  }
}

async function signedIn() {
  const app = fixture()
  await app.controller.start()
  await app.controller.consume([app.callback()])
  app.fetched.length = 0
  app.requests.length = 0
  return app
}

test("account success notifications wait for managed server synchronization", async () => {
  const app = fixture()
  const released = Promise.withResolvers<void>()
  app.state.syncDelay = released.promise
  await app.controller.start()
  const signingIn = app.controller.consume([app.callback()])
  for (let count = 0; count < 50 && !app.tokens.length; count++) await Bun.sleep(1)
  expect(app.tokens).toEqual([app.token])
  expect(app.statuses).toEqual([{ authenticated: false, pending: true }])
  released.resolve()
  await signingIn
  expect(app.statuses.at(-1)).toMatchObject({ authenticated: true, pending: false })
  app.state.failSync = true
  const stored = app.state.stored
  const status = await app.controller.logout()
  expect(status).toMatchObject({ authenticated: true, error: expect.stringContaining("could not finish signing out") })
  expect(app.state.stored).toEqual(stored)
  expect(app.statuses.at(-1)).toEqual(status)
  app.state.failSync = false
  await app.controller.logout()
  expect(app.state.stored).toBeUndefined()
})

test("desktop owns PKCE exchange and only ciphertext/status cross persistence and renderer boundaries", async () => {
  const app = fixture()
  expect(await app.controller.start()).toMatchObject({ pending: true, authenticated: false })
  const url = new URL(app.urls[0])
  expect(url.origin + url.pathname).toBe("https://vectordev.ai/auth/cli")
  expect(url.searchParams.get("desktop")).toBe("1")
  expect(url.searchParams.get("code_challenge_method")).toBe("S256")
  expect(url.searchParams.has("verifier")).toBe(false)
  expect(await app.controller.consume([app.callback(), "vector://session/example"])).toEqual([
    "vector://session/example",
  ])
  const exchange = JSON.parse(String(app.requests[0].body))
  expect(createHash("sha256").update(exchange.verifier).digest("base64url")).toBe(
    url.searchParams.get("code_challenge"),
  )
  expect(app.requests[0].redirect).toBe("error")
  expect(app.tokens).toEqual([app.token])
  expect(app.controller.status()).toMatchObject({ authenticated: true, pending: false, email: "fixture@example.test" })
  expect(JSON.stringify([app.state.stored, app.statuses, app.urls])).not.toContain(app.token)
  await app.controller.restore()
  expect(app.tokens).toEqual([app.token, app.token])
  await app.controller.logout()
  expect(app.tokens.at(-1)).toBeUndefined()
  expect(app.state.stored).toBeUndefined()
  expect(app.controller.status()).toEqual({ authenticated: false, pending: false })
})

test("the desktop keeps only a sign-in minted for it: a CLI grant or an unmarked token stores nothing", async () => {
  for (const issued of [
    desktopToken({ client: "cli", jti: "cli-grant" }),
    `vct_${claims({ sub: "account-fixture" })}.${randomBytes(32).toString("base64url")}`,
    `vct_${randomBytes(32).toString("base64url")}.synthetic`,
    `vct_${Buffer.from("not json").toString("base64url")}.signature`,
  ]) {
    const app = fixture()
    app.state.exchange = () =>
      Response.json({ token: issued, expiresAt: app.state.now + 100_000, user: { email: "fixture@example.test" } })
    await app.controller.start()
    await app.controller.consume([app.callback()])
    expect(app.state.stored).toBeUndefined()
    expect(app.tokens).toEqual([])
    expect(app.controller.status()).toEqual({
      authenticated: false,
      pending: false,
      error: "Vector could not complete sign-in. The link may have expired; start sign-in again.",
    })
    expect(JSON.stringify([app.statuses, app.writes])).not.toContain(issued)
  }
  // The same answer with the desktop's own client signs in.
  const app = fixture()
  await app.controller.start()
  await app.controller.consume([app.callback()])
  expect(app.tokens).toEqual([app.token])
})

test("the main-process token is available only while signed in and unexpired", async () => {
  const app = fixture()
  expect(await app.controller.token()).toBeUndefined()
  await app.controller.start()
  await app.controller.consume([app.callback()])
  expect(await app.controller.token()).toBe(app.token)
  app.state.secure = false
  expect(await app.controller.token()).toBeUndefined()
  app.state.secure = true
  app.state.now += 100_000
  expect(await app.controller.token()).toBeUndefined()
})

test("mismatched, duplicate, expired and cancelled callbacks never forward or exchange credentials", async () => {
  const app = fixture()
  await app.controller.start()
  const callback = app.callback()
  for (const url of [
    callback.replace(/state=[^&]+/, "state=wrong"),
    `${callback}&token=vct_synthetic`,
    "vector://auth/callback?code=bad",
    "vector://auth/other?token=vct_synthetic",
    " vector://auth/callback?code=bad ",
    callback.replace("vector://auth", "vector://unexpected@auth"),
  ])
    expect(await app.controller.consume([url])).toEqual([])
  expect(app.requests).toHaveLength(0)
  await Promise.all([app.controller.consume([callback]), app.controller.consume([callback])])
  expect(app.requests).toHaveLength(1)
  await app.controller.start()
  const cancelled = app.callback()
  app.controller.cancel()
  expect(await app.controller.consume([cancelled])).toEqual([])
  await app.controller.start()
  app.state.now += 300_001
  expect(await app.controller.consume([app.callback()])).toEqual([])
  expect(app.requests).toHaveLength(1)
})

test("unavailable storage prevents browser sign-in and encryption failure never writes plaintext", async () => {
  const app = fixture()
  app.state.secure = false
  expect((await app.controller.start()).error).toContain("securely")
  expect(app.urls).toEqual([])
  app.state.secure = true
  await app.controller.start()
  app.state.failStorage = true
  await app.controller.consume([app.callback()])
  expect(app.state.stored).toBeUndefined()
  expect(app.tokens).toEqual([])
  expect(JSON.stringify(app.statuses)).not.toContain(app.token)
})

test("local credential sync uses authenticated engine routes and refuses remote or redirect targets", async () => {
  const requests: Array<{ url: string; init: RequestInit }> = []
  const fetcher = async (url: string, init: RequestInit) => {
    requests.push({ url, init })
    return new Response(null, { status: 200 })
  }
  for (const url of ["https://foreign.example", "http://127.0.0.1.evil.example", "http://user:password@127.0.0.1"])
    await expect(
      syncVectorAccount({ url, username: "vector", password: "synthetic" }, "vct_fixture", fetcher),
    ).rejects.toThrow("local server")
  expect(requests).toEqual([])
  await syncVectorAccount(
    { url: "http://127.0.0.1:9999", username: "vector", password: "synthetic" },
    "vct_fixture",
    fetcher,
  )
  expect(requests.map((item) => [item.url, item.init.method])).toEqual([
    ["http://127.0.0.1:9999/auth/vector", "PUT"],
    ["http://127.0.0.1:9999/global/dispose", "POST"],
  ])
  expect(JSON.parse(String(requests[0].init.body))).toEqual({ type: "api", key: "vct_fixture" })
  expect(new Headers(requests[0].init.headers).get("authorization")).toBe(`Basic ${btoa("vector:synthetic")}`)
  expect(requests.every((item) => item.init.redirect === "error")).toBe(true)
  await syncVectorAccount(
    { url: "http://127.0.0.1:9999", username: "vector", password: "synthetic" },
    undefined,
    fetcher,
  )
  expect(requests[2].init.method).toBe("DELETE")
  expect(requests[2].init.body).toBeUndefined()
  // A models read writes the same credential and reloads nothing, under the same local-only rule.
  requests.length = 0
  await expect(
    refreshVectorModels(
      { url: "https://foreign.example", username: "vector", password: "synthetic" },
      "vct_fixture",
      fetcher,
    ),
  ).rejects.toThrow("local server")
  await refreshVectorModels(
    { url: "http://127.0.0.1:9999", username: "vector", password: "synthetic" },
    "vct_fixture",
    fetcher,
  )
  expect(requests.map((item) => [item.url, item.init.method, item.init.redirect])).toEqual([
    ["http://127.0.0.1:9999/auth/vector", "PUT", "error"],
  ])
  expect(JSON.parse(String(requests[0].init.body))).toEqual({ type: "api", key: "vct_fixture" })
})

test("after a purchase the local server reads the models again for the stored account, and not while signed out", async () => {
  const signedOut = fixture()
  await signedOut.controller.refreshModels()
  expect(signedOut.engine).toEqual([])

  const app = await signedIn()
  app.engine.length = 0
  await app.controller.refreshModels()
  // The same token again, without the reload a sign-in makes, so running sessions carry on.
  expect(app.engine).toEqual([["models", app.token]])
  expect(app.fetched).toEqual([])
  // An expired sign-in is a signed-out one.
  app.state.now += app.state.ttl
  await app.controller.refreshModels()
  expect(app.engine).toEqual([["models", app.token]])
})

test("a sign-out asked for before the models read wins, and one asked for after it waits for it", async () => {
  const before = await signedIn()
  before.engine.length = 0
  const held = Promise.withResolvers<void>()
  before.state.syncDelay = held.promise
  const loggingOut = before.controller.logout()
  const refreshing = before.controller.refreshModels()
  held.resolve()
  await Promise.all([loggingOut, refreshing])
  // The read ran after the sign-out and found no account, so the token never reached the server again.
  expect(before.engine).toEqual([["sync", undefined]])
  expect(before.controller.status().authenticated).toBe(false)

  const after = await signedIn()
  after.engine.length = 0
  const reading = Promise.withResolvers<void>()
  after.state.modelsDelay = reading.promise
  const refresh = after.controller.refreshModels()
  for (let count = 0; count < 50 && !after.engine.length; count++) await Bun.sleep(1)
  const logout = after.controller.logout()
  await Bun.sleep(5)
  // The sign-out waits for the read under way; nothing writes the token after it.
  expect(after.engine).toEqual([["models", after.token]])
  reading.resolve()
  await Promise.all([refresh, logout])
  expect(after.engine).toEqual([
    ["models", after.token],
    ["sync", undefined],
  ])
  expect(after.controller.status().authenticated).toBe(false)
})

test("switching accounts never writes the earlier account's token after the new one", async () => {
  const app = await signedIn()
  app.engine.length = 0
  const second = desktopToken({ sub: "second-account" })
  app.state.exchange = () =>
    Response.json({ token: second, expiresAt: app.state.now + app.state.ttl, user: { email: "second@example.test" } })
  // A read asked for while the new sign-in is being saved runs after it, with the new account's token.
  const saving = Promise.withResolvers<void>()
  app.state.syncDelay = saving.promise
  await app.controller.start()
  const switching = app.controller.consume([app.callback()])
  for (let count = 0; count < 50 && !app.engine.length; count++) await Bun.sleep(1)
  const refresh = app.controller.refreshModels()
  saving.resolve()
  await Promise.all([switching, refresh])
  expect(app.engine).toEqual([
    ["sync", second],
    ["models", second],
  ])

  // A read already under way when another sign-in lands finishes before that sign-in is written, and a read asked
  // for while that sign-in waits its turn reads the account it saved, not the one stored when it was asked for.
  app.engine.length = 0
  app.state.syncDelay = undefined
  const third = desktopToken({ sub: "third-account" })
  app.state.exchange = () =>
    Response.json({ token: third, expiresAt: app.state.now + app.state.ttl, user: { email: "third@example.test" } })
  const reading = Promise.withResolvers<void>()
  app.state.modelsDelay = reading.promise
  const earlier = app.controller.refreshModels()
  for (let count = 0; count < 50 && !app.engine.length; count++) await Bun.sleep(1)
  await app.controller.start()
  const next = app.controller.consume([app.callback()])
  await Bun.sleep(5)
  const later = app.controller.refreshModels()
  expect(app.engine).toEqual([["models", second]])
  reading.resolve()
  await Promise.all([earlier, next, later])
  expect(app.engine).toEqual([
    ["models", second],
    ["sync", third],
    ["models", third],
  ])
  expect(app.controller.status()).toMatchObject({ authenticated: true, email: "third@example.test" })
})

test("cancelling an exchange in flight prevents storage and expired saved grants are removed", async () => {
  const app = fixture()
  await app.controller.start()
  const response = Promise.withResolvers<void>()
  app.state.fetchDelay = response.promise
  const pending = app.controller.consume([app.callback()])
  expect(app.requests).toHaveLength(1)
  app.controller.cancel()
  response.resolve()
  await pending
  expect(app.state.stored).toBeUndefined()
  expect(app.tokens).toEqual([])
  app.state.fetchDelay = undefined
  await app.controller.start()
  await app.controller.consume([app.callback()])
  app.state.now += 100_001
  await app.controller.restore()
  expect(app.state.stored).toBeUndefined()
  expect(app.tokens.at(-1)).toBeUndefined()
  expect(app.controller.status()).toMatchObject({
    authenticated: false,
    pending: false,
    error: "Your Vector sign-in expired. Sign in again.",
  })
})

test("Codium balances are read in the main process and only the result reaches the renderer", async () => {
  const app = fixture()
  expect(await app.controller.codium()).toMatchObject({ signedIn: false })
  expect(app.fetched).toEqual([])
  await app.controller.start()
  await app.controller.consume([app.callback()])
  // vectordev.ai answers shares and flags, never an amount of credits.
  app.state.codium = {
    enabled: true,
    active: true,
    access: true,
    plan: { id: "vector-50", name: "Pro", left: 0.5, renewsAt: 2_000_000, cancelAtPeriodEnd: false },
    purchased: { bought: true, state: "available" },
    empty: false,
    low: false,
  }
  const status = await app.controller.codium()
  expect(app.fetched.at(-1)).toBe("https://vectordev.ai/api/model-plans/status")
  expect(new Headers(app.requests.at(-1)!.headers).get("authorization")).toBe(`Bearer ${app.token}`)
  expect(app.requests.at(-1)!.redirect).toBe("error")
  expect(status).toEqual({
    signedIn: true,
    enabled: true,
    access: true,
    plan: { id: "vector-50", name: "Pro", left: 0.5, renewsAt: 2_000_000, cancelAtPeriodEnd: false },
    purchased: { bought: true, state: "available" },
    empty: false,
    low: false,
  })
  expect(JSON.stringify(status)).not.toContain(app.token)
})

test("the signed-in name is kept for the sidebar, and older sign-ins without one still work", async () => {
  const app = fixture()
  app.state.name = "  Ada Lovelace  "
  await app.controller.start()
  await app.controller.consume([app.callback()])
  expect(app.controller.status()).toMatchObject({
    authenticated: true,
    email: "fixture@example.test",
    name: "Ada Lovelace",
  })
  expect(app.state.stored).toMatchObject({ email: "fixture@example.test", name: "Ada Lovelace" })
  const { name: _, ...older } = app.state.stored as { name: string }
  app.state.stored = older
  const status = app.controller.status()
  expect(status).toMatchObject({ authenticated: true, email: "fixture@example.test" })
  expect(status).not.toHaveProperty("name")
})

test("a missing or blank name never fails sign-in", async () => {
  const app = fixture()
  app.state.name = "   "
  await app.controller.start()
  await app.controller.consume([app.callback()])
  expect(app.controller.status()).toMatchObject({ authenticated: true, email: "fixture@example.test" })
  expect(app.controller.status()).not.toHaveProperty("name")
  expect(app.state.stored).not.toHaveProperty("name")
})

test("sign-in downloads the photo in the main process and the renderer only ever gets a data URL", async () => {
  const app = fixture()
  app.state.avatar = PHOTO
  await app.controller.start()
  await app.controller.consume([app.callback()])
  const photo = `data:image/png;base64,${png.toString("base64")}`
  expect(app.controller.status()).toMatchObject({ authenticated: true, avatar: photo })
  expect(app.state.stored).toMatchObject({ avatar: photo, avatarSource: PHOTO, profileAt: app.state.now })
  expect(app.statuses.at(-1)).toMatchObject({ avatar: photo })
  expect(app.fetched.at(-1)).toBe(PHOTO)
  // Google gets a plain image request: no account token, and no redirects to somewhere else.
  expect(app.requests.at(-1)!.redirect).toBe("error")
  expect(new Headers(app.requests.at(-1)!.headers).has("authorization")).toBe(false)
  expect(JSON.stringify(app.statuses)).not.toContain(PHOTO)
  await app.controller.logout()
  expect(app.controller.status()).not.toHaveProperty("avatar")
})

test("a saved sign-in refreshes its name and photo at most once a day and only while signed in", async () => {
  const app = fixture()
  app.state.ttl = 90 * 24 * 60 * 60 * 1_000
  expect(await app.controller.refreshProfile()).toEqual({ authenticated: false, pending: false })
  expect(app.fetched).toEqual([])
  await app.controller.start()
  await app.controller.consume([app.callback()])
  // A sign-in saved before names and photos were carried.
  app.state.stored = {
    ciphertext: (app.state.stored as { ciphertext: string }).ciphertext,
    email: "fixture@example.test",
    expiresAt: app.state.now + app.state.ttl,
  }
  app.state.profile = { name: "  Ada Lovelace ", avatar: PHOTO }
  const count = app.fetched.length
  expect(await app.controller.refreshProfile()).toMatchObject({
    name: "Ada Lovelace",
    avatar: `data:image/png;base64,${png.toString("base64")}`,
  })
  expect(app.fetched.slice(count)).toEqual(["https://vectordev.ai/api/account/profile", PHOTO])
  const profile = app.requests[count]
  expect(new Headers(profile.headers).get("authorization")).toBe(`Bearer ${app.token}`)
  expect(profile.redirect).toBe("error")
  await app.controller.refreshProfile()
  app.state.now += 23 * 60 * 60 * 1_000
  await app.controller.refreshProfile()
  expect(app.fetched.length).toBe(count + 2)
  // A day later the profile is asked again, and the unchanged photo is not downloaded again.
  app.state.now += 60 * 60 * 1_000
  await app.controller.refreshProfile()
  expect(app.fetched.slice(count + 2)).toEqual(["https://vectordev.ai/api/account/profile"])
  app.state.now += app.state.ttl
  await app.controller.refreshProfile()
  expect(app.fetched.length).toBe(count + 3)
})

test("photos outside Google's avatar hosts, of other types or over 256 KB are never kept", async () => {
  const sources = [
    "https://evil.example/photo.png",
    "http://lh3.googleusercontent.com/a/fixture",
    "https://lh3.googleusercontent.com.evil.example/a/fixture",
    "https://1.2.3.4.bc.googleusercontent.com/a/fixture",
    "https://user@lh3.googleusercontent.com/a/fixture",
    "https://lh3.googleusercontent.com:8443/a/fixture",
    `https://lh3.googleusercontent.com/a/${"x".repeat(2_100)}`,
  ]
  for (const source of sources) {
    const app = fixture()
    app.state.avatar = source
    await app.controller.start()
    await app.controller.consume([app.callback()])
    expect(app.fetched).toEqual(["https://vectordev.ai/api/account/cli-exchange"])
    expect(app.controller.status()).toMatchObject({ authenticated: true })
    expect(app.controller.status()).not.toHaveProperty("avatar")
  }
  const responses = [
    () => new Response("<svg onload=alert(1)>", { headers: { "content-type": "image/svg+xml" } }),
    () => new Response("<html>", { headers: { "content-type": "text/html" } }),
    () => new Response(png, { status: 404, headers: { "content-type": "image/png" } }),
    () => new Response(new Uint8Array(0), { headers: { "content-type": "image/png" } }),
    () => new Response(png, { headers: { "content-type": "image/png", "content-length": String(300 * 1024) } }),
    // A body larger than it says: the cap holds while reading.
    () =>
      new Response(
        new ReadableStream({
          start(controller) {
            Array.from({ length: 5 }, () => controller.enqueue(new Uint8Array(64 * 1024)))
            controller.close()
          },
        }),
        { headers: { "content-type": "image/jpeg" } },
      ),
    () => {
      throw new TypeError("fetch failed: redirect mode is set to error")
    },
  ]
  for (const response of responses) {
    const app = fixture()
    app.state.avatar = PHOTO
    app.state.photo = response
    await app.controller.start()
    await app.controller.consume([app.callback()])
    expect(app.fetched.at(-1)).toBe(PHOTO)
    expect(app.controller.status()).toMatchObject({ authenticated: true })
    expect(app.controller.status()).not.toHaveProperty("avatar")
    // Not settled, so the next start tries the photo again.
    expect(app.state.stored).not.toHaveProperty("profileAt")
  }
})

test("a failed refresh keeps the last good photo, and a profile without one falls back to the initial", async () => {
  const app = fixture()
  app.state.ttl = 90 * 24 * 60 * 60 * 1_000
  app.state.avatar = PHOTO
  await app.controller.start()
  await app.controller.consume([app.callback()])
  const photo = app.controller.status().avatar
  expect(photo).toStartWith("data:image/png;base64,")
  app.state.now += 25 * 60 * 60 * 1_000
  // vectordev.ai unavailable: nothing changes and nothing is settled.
  await app.controller.refreshProfile()
  expect(app.controller.status()).toMatchObject({ avatar: photo })
  // A new photo that cannot be downloaded keeps the old one.
  app.state.profile = { name: null, avatar: `${PHOTO}-new` }
  app.state.photo = () => new Response(null, { status: 500 })
  await app.controller.refreshProfile()
  expect(app.controller.status()).toMatchObject({ avatar: photo })
  expect(app.state.stored).toMatchObject({ avatarSource: PHOTO })
  // The account has no photo any more.
  app.state.profile = { name: null, avatar: null }
  await app.controller.refreshProfile()
  expect(app.controller.status()).not.toHaveProperty("avatar")
  expect(app.state.stored).not.toHaveProperty("avatarSource")
  // A saved value that is not an inline image never reaches the renderer.
  app.state.stored = { ...(app.state.stored as object), avatar: PHOTO, avatarSource: PHOTO }
  expect(app.controller.status()).not.toHaveProperty("avatar")
})

test("signing out while the photo downloads keeps the account signed out", async () => {
  const app = fixture()
  app.state.avatar = PHOTO
  const released = Promise.withResolvers<void>()
  app.state.photo = () => {
    void app.controller.logout()
    return new Response(
      new ReadableStream({
        async start(controller) {
          await released.promise
          controller.enqueue(png)
          controller.close()
        },
      }),
      { headers: { "content-type": "image/png" } },
    )
  }
  await app.controller.start()
  const signingIn = app.controller.consume([app.callback()])
  for (let count = 0; count < 50 && app.state.stored; count++) await Bun.sleep(1)
  released.resolve()
  await signingIn
  expect(app.state.stored).toBeUndefined()
  expect(app.controller.status()).toEqual({ authenticated: false, pending: false })
})

test("billing posts the account token and JSON to vectordev.ai and shows only the Stripe page it answers with", async () => {
  const app = await signedIn()
  expect(await app.controller.billing({ kind: "checkout", plan: "vector-10" })).toEqual({ outcome: "completed" })
  expect(app.fetched).toEqual(["https://vectordev.ai/api/model-plans/checkout"])
  const request = app.requests[0]!
  expect(request.method).toBe("POST")
  expect(request.redirect).toBe("error")
  expect(new Headers(request.headers).get("authorization")).toBe(`Bearer ${app.token}`)
  expect(new Headers(request.headers).get("content-type")).toBe("application/json")
  expect(JSON.parse(String(request.body))).toEqual({ plan: "vector-10" })
  expect(app.windows).toEqual(["https://checkout.stripe.com/c/pay/cs_fixture"])

  // An upgrade is a POST to /change that answers the upgrade's checkout, shown in the same window.
  app.state.outcome = "cancelled"
  expect(await app.controller.billing({ kind: "change", plan: "vector-100" })).toEqual({ outcome: "cancelled" })
  expect(app.fetched.at(-1)).toBe("https://vectordev.ai/api/model-plans/change")
  expect(app.requests.at(-1)!.method).toBe("POST")
  expect(JSON.parse(String(app.requests.at(-1)!.body))).toEqual({ plan: "vector-100" })
  expect(app.windows.at(-1)).toBe("https://checkout.stripe.com/c/pay/cs_fixture")

  // The portal answers a billing.stripe.com address: its home, cancelling, or updating the card.
  app.state.billing = () => Response.json({ url: "https://billing.stripe.com/p/session/fixture" })
  app.state.outcome = "closed"
  expect(await app.controller.billing({ kind: "portal", flow: "payment_method_update" })).toEqual({ outcome: "closed" })
  expect(app.fetched.at(-1)).toBe("https://vectordev.ai/api/model-plans/portal")
  expect(JSON.parse(String(app.requests.at(-1)!.body))).toEqual({ flow: "payment_method_update" })
  expect(await app.controller.billing({ kind: "portal", flow: "cancel" })).toEqual({ outcome: "closed" })
  expect(JSON.parse(String(app.requests.at(-1)!.body))).toEqual({ flow: "cancel" })
  expect(await app.controller.billing({ kind: "portal" })).toEqual({ outcome: "closed" })
  expect(JSON.parse(String(app.requests.at(-1)!.body))).toEqual({})
  expect(JSON.stringify([app.statuses, app.windows])).not.toContain(app.token)
})

test("a smaller plan is scheduled for renewal and Keep my plan drops it, with no billing window", async () => {
  const app = await signedIn()
  const at = Date.UTC(2026, 10, 1, 12)
  app.state.billing = () => Response.json({ scheduled: { plan: "vector-10", at } })
  expect(await app.controller.billing({ kind: "change", plan: "vector-10" })).toEqual({
    outcome: "scheduled",
    plan: "vector-10",
    at,
  })
  expect(app.fetched).toEqual(["https://vectordev.ai/api/model-plans/change"])
  expect(JSON.parse(String(app.requests[0]!.body))).toEqual({ plan: "vector-10" })

  app.state.billing = () => Response.json({ scheduled: false })
  expect(await app.controller.billing({ kind: "keep" })).toEqual({ outcome: "kept" })
  const keep = app.requests.at(-1)!
  expect(app.fetched.at(-1)).toBe("https://vectordev.ai/api/model-plans/change")
  expect(keep.method).toBe("DELETE")
  // vectordev.ai takes /change only as JSON (requireTrustedJsonRequest), the DELETE included.
  expect(new Headers(keep.headers).get("content-type")).toBe("application/json")
  expect(new Headers(keep.headers).get("authorization")).toBe(`Bearer ${app.token}`)
  expect(app.windows).toEqual([])

  // vectordev.ai refuses a change it cannot make, such as one while another is scheduled; the app says why.
  app.state.billing = () =>
    Response.json(
      { error: { code: "MODEL_PLAN_CHANGE_UNAVAILABLE", message: "Change plans on vectordev.ai/account." } },
      { status: 409 },
    )
  expect(await app.controller.billing({ kind: "change", plan: "vector-100" })).toEqual({
    outcome: "failed",
    message: "Change plans on vectordev.ai/account.",
  })
  // An answer that is neither a checkout nor a schedule, or a keep that kept nothing, is a failure, not a success.
  for (const answer of [{ scheduled: { plan: "vector-10" } }, { scheduled: true }, {}]) {
    app.state.billing = () => Response.json(answer)
    expect(await app.controller.billing({ kind: "change", plan: "vector-10" })).toMatchObject({ outcome: "failed" })
    expect(await app.controller.billing({ kind: "keep" })).toMatchObject({ outcome: "failed" })
  }
  // An older vectordev.ai without /change sends the person to the account page.
  app.state.billing = () => new Response("Not found", { status: 404 })
  expect(await app.controller.billing({ kind: "change", plan: "vector-100" })).toEqual({ outcome: "website" })
  expect(app.urls.at(-1)).toBe("https://vectordev.ai/account")
  expect(await app.controller.billing({ kind: "keep" })).toEqual({ outcome: "website" })
  expect(app.windows).toEqual([])
})

test("billing never opens a page vectordev.ai did not send from Stripe, nor a request the app did not offer", async () => {
  const app = await signedIn()
  for (const url of [
    "https://checkout.stripe.com.evil.example/c/pay",
    "http://checkout.stripe.com/c/pay",
    "https://billing.stripe.com/p/session/fixture",
    "javascript:alert(1)",
  ]) {
    app.state.billing = () => Response.json({ url })
    expect(await app.controller.billing({ kind: "checkout", plan: "vector-10" })).toMatchObject({ outcome: "failed" })
  }
  // A portal address is not taken from checkout, nor the other way round.
  app.state.billing = () => Response.json({ url: "https://checkout.stripe.com/c/pay/cs_fixture" })
  expect(await app.controller.billing({ kind: "portal" })).toMatchObject({ outcome: "failed" })
  expect(app.windows).toEqual([])
  const sent = app.fetched.length
  for (const input of [
    { kind: "refund" },
    { kind: "checkout", plan: "../admin" },
    { kind: "checkout" },
    { kind: "change" },
    { kind: "change", plan: "A".repeat(41) },
    // Codium sells no top-ups, and the portal no longer changes plans.
    { kind: "topup", pack: "codium-topup-10" },
    { kind: "portal", flow: "change" },
    { kind: "portal", flow: "upgrade" },
    "checkout",
    undefined,
  ])
    expect(await app.controller.billing(input)).toMatchObject({ outcome: "failed" })
  expect(app.fetched).toHaveLength(sent)
})

test("an older vectordev.ai sends billing to the website, while an expired sign-in or a refusal is said in the app", async () => {
  const app = await signedIn()
  // Before 1.99.109 these routes took only a website session, and Supabase refused the account token.
  app.state.billing = () =>
    Response.json(
      { error: { code: "SESSION_INVALID", message: "Your session expired. Sign in again." } },
      { status: 401 },
    )
  expect(await app.controller.billing({ kind: "portal" })).toEqual({ outcome: "website" })
  expect(app.urls.at(-1)).toBe("https://vectordev.ai/account")
  app.state.billing = () => new Response("Not found", { status: 404 })
  expect(await app.controller.billing({ kind: "checkout", plan: "vector-10" })).toEqual({ outcome: "website" })
  expect(app.urls.at(-1)).toBe("https://vectordev.ai/codium")

  const browser = app.urls.length
  app.state.billing = () =>
    Response.json(
      { error: { code: "CLI_TOKEN_EXPIRED", message: "That CLI token has expired. Generate a new one." } },
      { status: 401 },
    )
  expect(await app.controller.billing({ kind: "portal" })).toEqual({
    outcome: "failed",
    message: "That CLI token has expired. Generate a new one.",
  })
  app.state.billing = () =>
    Response.json(
      { error: { code: "MODEL_PLANS_DISABLED", message: "Vector Codium is not available yet." } },
      { status: 503 },
    )
  expect(await app.controller.billing({ kind: "checkout", plan: "vector-10" })).toEqual({
    outcome: "failed",
    message: "Vector Codium is not available yet.",
  })
  app.state.outcome = "failed"
  app.state.billing = () => Response.json({ url: "https://checkout.stripe.com/c/pay/cs_fixture" })
  expect(await app.controller.billing({ kind: "checkout", plan: "vector-10" })).toMatchObject({ outcome: "failed" })
  expect(app.urls).toHaveLength(browser)

  await app.controller.logout()
  expect(await app.controller.billing({ kind: "portal" })).toEqual({
    outcome: "failed",
    message: "Sign in to Vector to manage billing.",
  })
})

test("a request while a billing window is open brings it forward and never takes its result", async () => {
  const app = await signedIn()
  const open = Promise.withResolvers<void>()
  app.state.billingDelay = open.promise
  const checkout = app.controller.billing({ kind: "checkout", plan: "vector-10" })
  // Say Usage, or the purchase dialog, asks to cancel the plan while checkout is open.
  expect(await app.controller.billing({ kind: "portal", flow: "cancel" })).toEqual({ outcome: "busy" })
  expect(await app.controller.billing({ kind: "change", plan: "vector-100" })).toEqual({ outcome: "busy" })
  expect(await app.controller.billing({ kind: "keep" })).toEqual({ outcome: "busy" })
  expect(app.focused).toHaveLength(3)
  open.resolve()
  expect(await checkout).toEqual({ outcome: "completed" })
  // No Stripe session was made for them.
  expect(app.fetched).toEqual(["https://vectordev.ai/api/model-plans/checkout"])
  // Once it is done, the next request opens its own window.
  app.state.billingDelay = undefined
  app.state.billing = () => Response.json({ url: "https://billing.stripe.com/p/session/fixture" })
  expect(await app.controller.billing({ kind: "portal", flow: "cancel" })).toEqual({ outcome: "completed" })
  expect(app.windows).toEqual([
    "https://checkout.stripe.com/c/pay/cs_fixture",
    "https://billing.stripe.com/p/session/fixture",
  ])
  // A failed request frees the next one too.
  app.state.billing = () => new Response("Bad gateway", { status: 502 })
  expect(await app.controller.billing({ kind: "portal" })).toMatchObject({ outcome: "failed" })
  app.state.billing = () => Response.json({ url: "https://billing.stripe.com/p/session/fixture" })
  expect(await app.controller.billing({ kind: "portal" })).toEqual({ outcome: "completed" })
})

test("the billing portal for a sign-in from before 1.99.109 opens on the website", async () => {
  const app = await signedIn()
  app.state.billing = () =>
    Response.json(
      {
        error: {
          code: "DESKTOP_SIGN_IN_REQUIRED",
          message: "Sign in to Vector again to manage billing in the app.",
        },
      },
      { status: 403 },
    )
  expect(await app.controller.billing({ kind: "portal", flow: "payment_method_update" })).toEqual({
    outcome: "website",
  })
  expect(app.urls.at(-1)).toBe("https://vectordev.ai/account")
  expect(app.windows).toEqual([])
})

test("offers are read from the public configuration without the account token", async () => {
  const app = await signedIn()
  app.state.config = {
    enabled: false,
    plans: [{ id: "vector-10", name: "Plus", price: 10, available: false, tasks: [] }],
    topups: [{ id: "codium-topup-10", name: "$10 credit top-up", price: 10, available: false }],
  }
  // An older site's top-ups are not read: Codium sells monthly plans only.
  expect(await app.controller.offers()).toEqual({
    enabled: false,
    plans: [{ id: "vector-10", name: "Plus", price: 10, available: false }],
  })
  expect(app.fetched).toEqual(["https://vectordev.ai/api/model-plans/config"])
  expect(new Headers(app.requests[0]!.headers).get("authorization")).toBeNull()
})

const grantCallback = (app: Awaited<ReturnType<typeof signedIn>>) =>
  `vector://auth/callback?${new URLSearchParams({ code: randomBytes(32).toString("base64url"), state: new URL(app.urls.at(-1)!).searchParams.get("state")! })}`
const grant = `vdg_${randomBytes(24).toString("base64url")}.${randomBytes(32).toString("base64url")}`

test("deleting confirms with a fresh browser sign-in of its own, and the grant stays in main-process memory", async () => {
  const app = await signedIn()
  expect(await app.controller.confirmDeletion()).toMatchObject({ authenticated: true, deletion: "confirming" })
  const url = new URL(app.urls.at(-1)!)
  expect(url.origin + url.pathname).toBe("https://vectordev.ai/auth/cli")
  expect(url.searchParams.get("purpose")).toBe("delete")
  expect(url.searchParams.get("desktop")).toBe("1")
  const confirming = grantCallback(app)
  // A sign-in started meanwhile keeps its own slot and finishes without touching the confirmation.
  await app.controller.start()
  expect(app.controller.status()).toMatchObject({ pending: true, deletion: "confirming" })
  await app.controller.consume([app.callback()])
  expect(app.controller.status()).toMatchObject({ authenticated: true, pending: false, deletion: "confirming" })

  app.state.exchange = () =>
    Response.json({ grant, expiresAt: app.state.now + 600_000, user: { email: "Fixture@Example.test" } })
  const writes = app.writes.length
  expect(await app.controller.consume([confirming])).toEqual([])
  expect(JSON.parse(String(app.requests.at(-1)!.body))).toMatchObject({ state: url.searchParams.get("state") })
  expect(app.controller.status()).toMatchObject({ authenticated: true, deletion: "confirmed" })
  expect(app.writes).toHaveLength(writes)
  expect(JSON.stringify([app.state.stored, app.statuses, app.writes, app.tokens])).not.toContain(grant)

  // A mistyped email sends nothing.
  expect(await app.controller.deleteAccount("someone@example.test")).toEqual({
    deleted: false,
    message: "Type the email address on this account to confirm.",
  })
  expect(app.fetched.at(-1)).not.toBe("https://vectordev.ai/api/account/delete")
  expect(await app.controller.deleteAccount(" fixture@example.test ")).toEqual({ deleted: true })
  const request = app.requests.at(-1)!
  expect(app.fetched.at(-1)).toBe("https://vectordev.ai/api/account/delete")
  expect(new Headers(request.headers).get("authorization")).toBe(`Bearer ${grant}`)
  expect(JSON.parse(String(request.body))).toEqual({ confirm: "fixture@example.test" })
  // Deleted on vectordev.ai, so this machine forgets the account and the local server's copy of the token.
  expect(app.state.stored).toBeUndefined()
  expect(app.tokens.at(-1)).toBeUndefined()
  expect(app.controller.status()).toEqual({ authenticated: false, pending: false })
})

test("a failed deletion keeps the confirmation for a retry until it is used up or expires", async () => {
  const app = await signedIn()
  await app.controller.confirmDeletion()
  app.state.exchange = () =>
    Response.json({ grant, expiresAt: app.state.now + 600_000, user: { email: "fixture@example.test" } })
  await app.controller.consume([grantCallback(app)])
  app.state.deletion = () =>
    Response.json(
      { error: { code: "REVOCATION_FAILED", message: "Account access could not be revoked. Retry account deletion." } },
      { status: 503 },
    )
  expect(await app.controller.deleteAccount("fixture@example.test")).toEqual({
    deleted: false,
    message: "Account access could not be revoked. Retry account deletion.",
  })
  expect(app.controller.status()).toMatchObject({ authenticated: true, deletion: "confirmed" })
  app.state.deletion = () =>
    Response.json(
      { error: { code: "DELETION_GRANT_USED", message: "This confirmation was already used." } },
      { status: 401 },
    )
  await app.controller.deleteAccount("fixture@example.test")
  expect(app.controller.status()).toMatchObject({ authenticated: true })
  expect(app.controller.status()).not.toHaveProperty("deletion")

  // Ten minutes later the confirmation is gone without asking vectordev.ai.
  await app.controller.confirmDeletion()
  await app.controller.consume([grantCallback(app)])
  app.state.now += 600_001
  const sent = app.fetched.length
  expect(await app.controller.deleteAccount("fixture@example.test")).toMatchObject({ deleted: false })
  expect(app.fetched).toHaveLength(sent)
  expect(app.state.stored).toBeDefined()
})

test("a confirmation for another account, a sign-in token or a cancelled step never becomes a deletion grant", async () => {
  const app = await signedIn()
  await app.controller.confirmDeletion()
  app.state.exchange = () =>
    Response.json({ grant, expiresAt: app.state.now + 600_000, user: { email: "other@example.test" } })
  await app.controller.consume([grantCallback(app)])
  expect(app.controller.status()).toMatchObject({
    error: expect.stringContaining("You confirmed as other@example.test"),
  })
  expect(app.controller.status()).not.toHaveProperty("deletion")

  await app.controller.confirmDeletion()
  app.state.exchange = () =>
    Response.json({ token: app.token, expiresAt: app.state.now + 600_000, user: { email: "fixture@example.test" } })
  await app.controller.consume([grantCallback(app)])
  expect(app.controller.status()).not.toHaveProperty("deletion")

  await app.controller.confirmDeletion()
  const cancelled = grantCallback(app)
  expect(app.controller.cancelDeletion()).not.toHaveProperty("deletion")
  app.state.exchange = () =>
    Response.json({ grant, expiresAt: app.state.now + 600_000, user: { email: "fixture@example.test" } })
  const sent = app.fetched.length
  await app.controller.consume([cancelled])
  expect(app.fetched).toHaveLength(sent)
  expect(app.controller.status()).not.toHaveProperty("deletion")
  expect(await app.controller.deleteAccount("fixture@example.test")).toMatchObject({ deleted: false })

  // Signed out, there is nothing to confirm.
  await app.controller.logout()
  expect(await app.controller.confirmDeletion()).toMatchObject({ authenticated: false, error: expect.any(String) })
})
