import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test"
import { randomUUID } from "node:crypto"
import { createAccountApi, type AccountApiDeps } from "../../../api/_lib/everywhere/account-api"
import { readAudit } from "../../../api/_lib/everywhere/audit"
import { readConfig } from "../../../api/_lib/everywhere/config"
import {
  findLink,
  recordInstall,
  redeemLinkCode,
  type IdentityContext,
  type LinkActor,
  type LinkNotice,
  type OAuthExchanges,
} from "../../../api/_lib/everywhere/identity"
import { everywhereStore } from "../../../api/_lib/everywhere/store"
import { everywhereEnv, FakeAccounts, RouteHarness, testAccount } from "./lib/everywhere-account"
import { installFetchGuard } from "./lib/everywhere-fetch-guard"
import { FakeStore, useKv } from "./lib/everywhere-store"

installFetchGuard()

/*
 * VE-04 and E2: the link routes. The signed-in account gets a link code (Slack, Jira) or starts the Linear sign-in. A
 * code works only when its platform user sends it from a private place on the platform it was made for; a code from a
 * shared place, or redeemed by an identity on another platform or workspace, is refused. The account is told about
 * every link and can remove it. Everything runs against fakes on 127.0.0.1.
 */

const accounts = new FakeAccounts()
const harness = new RouteHarness()
let restore: () => void
beforeAll(async () => {
  restore = useKv()
  accounts.start()
  await harness.start()
})
afterAll(async () => {
  restore()
  await accounts.stop()
  await harness.stop()
})

const alice = accounts.add(testAccount("alice@example.com"))
const bob = accounts.add(testAccount("bob@example.org"))
const SLACK = "slack:T0123ABCD"
const SLACK_OTHER = "slack:T0999ZZZZ"
const LINEAR = `linear:${randomUUID()}`
const JIRA = `jira:${randomUUID()}`
const person: LinkActor = { bot: false, external: false, guest: false }

let fake: FakeStore
let env: Record<string, string>
let notices: LinkNotice[]
let exchanged: string[]

function deps(extra: Partial<AccountApiDeps> = {}): AccountApiDeps {
  return {
    env,
    store: everywhereStore(fake.fetch),
    now: () => fake.clock.now,
    notify: async (notice) => {
      notices.push(notice)
    },
    ...extra,
  }
}

function ctx(): IdentityContext {
  return { store: everywhereStore(fake.fetch), keys: readConfig(env).dataKeys, now: fake.clock.now }
}

async function install(installation: string, account: string) {
  const verdict = await recordInstall(ctx(), {
    account,
    event: "install",
    grant: { installation, scopes: [], installer: { admin: true } },
  })
  expect(verdict.ok).toBe(true)
}

beforeEach(() => {
  fake = new FakeStore()
  env = everywhereEnv()
  notices = []
  exchanged = []
  accounts.calls = 0
  harness.use(createAccountApi(deps()))
})

describe("switches and sign-in", () => {
  test("with the feature off, every route answers 404 before any sign-in check or store read", async () => {
    env = {}
    harness.use(createAccountApi(deps()))
    for (const [method, path] of [
      ["POST", "/api/everywhere/link"],
      ["GET", "/api/everywhere/links"],
      ["DELETE", "/api/everywhere/links"],
      ["GET", "/api/everywhere/installs"],
      ["PUT", "/api/everywhere/repos"],
      ["POST", "/api/everywhere/oauth-finish"],
    ] as const) {
      const answer = await harness.call(method, path, {
        token: alice.token,
        ...(method === "GET" ? {} : { body: { platform: "slack" } }),
      })
      expect(answer.status).toBe(404)
    }
    expect(accounts.calls).toBe(0)
    expect(fake.commands).toEqual([])
  })

  test("without a valid bearer token the routes answer 401", async () => {
    expect((await harness.call("POST", "/api/everywhere/link", { body: { platform: "slack" } })).status).toBe(401)
    expect((await harness.call("GET", "/api/everywhere/links", { token: "session-unknown" })).status).toBe(401)
    expect(fake.commands).toEqual([])
  })

  test("a platform that is off answers 404, GitHub needs no link, and other methods are refused", async () => {
    env = everywhereEnv("slack")
    harness.use(createAccountApi(deps()))
    expect(
      (await harness.call("POST", "/api/everywhere/link", { token: alice.token, body: { platform: "jira" } })).status,
    ).toBe(404)
    const github = await harness.call("POST", "/api/everywhere/link", {
      token: alice.token,
      body: { platform: "github" },
    })
    expect(github.status).toBe(400)
    expect(github.body.error.code).toBe("EVERYWHERE_UNSUPPORTED")
    expect(
      (await harness.call("POST", "/api/everywhere/link", { token: alice.token, body: { platform: "teams" } })).status,
    ).toBe(400)
    expect((await harness.call("GET", "/api/everywhere/link", { token: alice.token })).status).toBe(405)
  })
})

describe("link codes", () => {
  test("the signed-in account gets a code, with the warning, and the code links to that account only", async () => {
    await install(SLACK, bob.id)
    const answer = await harness.call("POST", "/api/everywhere/link", {
      token: alice.token,
      body: { platform: "slack" },
    })
    expect(answer.status).toBe(200)
    expect(answer.body).toMatchObject({
      platform: "slack",
      expiresAt: fake.clock.now + 600_000,
      note: "Send this only to the Vector bot in a direct message. Never give it to a person.",
    })
    expect(answer.body.code).toMatch(/^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/)
    const linked = await redeemLinkCode(ctx(), {
      code: answer.body.code,
      installation: SLACK,
      userId: "U0AAA1111",
      place: "private",
      actor: person,
    })
    expect(linked).toEqual({ ok: true, account: alice.id, already: false, hint: "a•••@example.com" })
  })

  test("a Jira code says to send it in Rovo chat", async () => {
    const answer = await harness.call("POST", "/api/everywhere/link", {
      token: alice.token,
      body: { platform: "jira" },
    })
    expect(answer.body.note).toBe("Send this only to Vector in Rovo chat. Never give it to a person.")
  })

  test("a code redeemed from a shared place is refused and burned", async () => {
    await install(SLACK, bob.id)
    const { code } = (
      await harness.call("POST", "/api/everywhere/link", { token: alice.token, body: { platform: "slack" } })
    ).body
    const redeem = (place: "private" | "shared") =>
      redeemLinkCode(ctx(), { code, installation: SLACK, userId: "U0AAA1111", place, actor: person })
    expect(await redeem("shared")).toEqual({ ok: false, code: "shared-place" })
    expect(await redeem("private")).toEqual({ ok: false, code: "link-invalid" })
  })

  test("a code redeemed by an identity on another platform, or in another workspace than it was made for, is refused", async () => {
    await install(SLACK, bob.id)
    await install(SLACK_OTHER, bob.id)
    await install(JIRA, bob.id)
    const slackCode = (
      await harness.call("POST", "/api/everywhere/link", { token: alice.token, body: { platform: "slack" } })
    ).body.code
    expect(
      await redeemLinkCode(ctx(), {
        code: slackCode,
        installation: JIRA,
        userId: `557058:${randomUUID()}`,
        place: "private",
        actor: person,
      }),
    ).toEqual({ ok: false, code: "link-invalid" })
    const pinned = await harness.call("POST", "/api/everywhere/link", {
      token: alice.token,
      body: { platform: "slack", installation: SLACK },
    })
    expect(
      await redeemLinkCode(ctx(), {
        code: pinned.body.code,
        installation: SLACK_OTHER,
        userId: "U0BBB2222",
        place: "private",
        actor: person,
      }),
    ).toEqual({ ok: false, code: "link-invalid" })
    expect(await findLink(ctx().store, SLACK_OTHER, "U0BBB2222")).toBeUndefined()
    const mismatched = await harness.call("POST", "/api/everywhere/link", {
      token: alice.token,
      body: { platform: "slack", installation: JIRA },
    })
    expect(mismatched.status).toBe(400)
  })

  test("a code forwarded to another person: the person sees whose account it is, the account is told, and unlinks", async () => {
    await install(SLACK, bob.id)
    const { code } = (
      await harness.call("POST", "/api/everywhere/link", { token: alice.token, body: { platform: "slack" } })
    ).body
    // The person it was forwarded to sends it in their own DM: both checks pass, so the notices are the defence.
    const linked = await redeemLinkCode(
      { ...ctx(), notify: deps().notify },
      { code, installation: SLACK, userId: "U0EVE0001", place: "private", actor: person },
    )
    expect(linked).toMatchObject({ ok: true, account: alice.id, hint: "a•••@example.com" })
    expect(notices).toEqual([
      { account: alice.id, email: alice.email, platform: "slack", installation: SLACK, userId: "U0EVE0001" },
    ])
    expect(await readAudit(ctx().store, alice.id)).toContainEqual(
      expect.objectContaining({ event: "link", installation: SLACK, userId: "U0EVE0001" }),
    )
    const listed = await harness.call("GET", "/api/everywhere/links", { token: alice.token })
    expect(listed.body.links).toEqual([
      { installation: SLACK, platform: "slack", userId: "U0EVE0001", linkedAt: fake.clock.now },
    ])
    const removed = await harness.call("DELETE", "/api/everywhere/links", {
      token: alice.token,
      body: { installation: SLACK, userId: "U0EVE0001" },
    })
    expect(removed.status).toBe(200)
    expect(await findLink(ctx().store, SLACK, "U0EVE0001")).toBeUndefined()
    expect((await harness.call("GET", "/api/everywhere/links", { token: alice.token })).body.links).toEqual([])
  })
})

describe("links", () => {
  test("an account lists only its own links and removes only its own", async () => {
    await install(SLACK, bob.id)
    for (const [account, userId] of [
      [alice, "U0AAA1111"],
      [bob, "U0BBB2222"],
    ] as const) {
      const { code } = (
        await harness.call("POST", "/api/everywhere/link", { token: account.token, body: { platform: "slack" } })
      ).body
      expect(
        (await redeemLinkCode(ctx(), { code, installation: SLACK, userId, place: "private", actor: person })).ok,
      ).toBe(true)
    }
    const listed = await harness.call("GET", "/api/everywhere/links", { token: alice.token })
    expect(listed.body.links.map((link: { userId: string }) => link.userId)).toEqual(["U0AAA1111"])
    const theft = await harness.call("DELETE", "/api/everywhere/links", {
      token: alice.token,
      body: { installation: SLACK, userId: "U0BBB2222" },
    })
    expect(theft.status).toBe(404)
    expect(await findLink(ctx().store, SLACK, "U0BBB2222")).toMatchObject({ account: bob.id })
    const malformed = await harness.call("DELETE", "/api/everywhere/links", {
      token: alice.token,
      body: { installation: "nowhere", userId: "U0AAA1111" },
    })
    expect(malformed.status).toBe(400)
  })
})

describe("the Linear sign-in", () => {
  const viewer = randomUUID()
  const exchanges = (): OAuthExchanges => ({
    linear: {
      link: async (code) => {
        exchanged.push(code)
        return { installation: LINEAR, userId: viewer, actor: person }
      },
    },
  })

  test("POST /link starts it with a state for the signed-in account and Linear's authorize URL", async () => {
    const answer = await harness.call("POST", "/api/everywhere/link", {
      token: alice.token,
      body: { platform: "linear" },
    })
    expect(answer.status).toBe(200)
    const url = new URL(answer.body.url)
    expect(url.origin).toBe("https://linear.app")
    expect(url.searchParams.get("state")).toBe(answer.body.state)
    expect(url.searchParams.get("actor")).toBe("user")
    expect(url.searchParams.get("scope")).toBe("read")
  })

  test("the finish links the signed-in Linear user to the account that started it", async () => {
    await install(LINEAR, bob.id)
    harness.use(createAccountApi(deps({ exchanges: exchanges() })))
    const { state } = (
      await harness.call("POST", "/api/everywhere/link", { token: alice.token, body: { platform: "linear" } })
    ).body
    const finished = await harness.call("POST", "/api/everywhere/oauth-finish", {
      token: alice.token,
      body: { code: "linear-oauth-code", state },
    })
    expect(finished.status).toBe(200)
    expect(finished.body).toEqual({
      purpose: "link",
      platform: "linear",
      installation: LINEAR,
      userId: viewer,
      already: false,
      hint: "a•••@example.com",
    })
    expect(exchanged).toEqual(["linear-oauth-code"])
    expect(await findLink(ctx().store, LINEAR, viewer)).toMatchObject({ account: alice.id })
    expect(notices).toEqual([
      { account: alice.id, email: alice.email, platform: "linear", installation: LINEAR, userId: viewer },
    ])
  })

  test("a sign-in finished by another account is refused before Linear's code is exchanged, and the state is spent", async () => {
    await install(LINEAR, bob.id)
    harness.use(createAccountApi(deps({ exchanges: exchanges() })))
    const { state } = (
      await harness.call("POST", "/api/everywhere/link", { token: alice.token, body: { platform: "linear" } })
    ).body
    const stolen = await harness.call("POST", "/api/everywhere/oauth-finish", {
      token: bob.token,
      body: { code: "linear-oauth-code", state },
    })
    expect(stolen.status).toBe(403)
    expect(stolen.body.error.code).toBe("EVERYWHERE_STATE_ACCOUNT")
    expect(exchanged).toEqual([])
    const late = await harness.call("POST", "/api/everywhere/oauth-finish", {
      token: alice.token,
      body: { code: "linear-oauth-code", state },
    })
    expect(late.status).toBe(400)
    expect(late.body.error.code).toBe("EVERYWHERE_STATE_INVALID")
    expect(await findLink(ctx().store, LINEAR, viewer)).toBeUndefined()
  })

  test("a sign-in for a workspace nobody connected, or by an app user, links nobody", async () => {
    let actor: LinkActor = person
    harness.use(
      createAccountApi(
        deps({ exchanges: { linear: { link: async () => ({ installation: LINEAR, userId: viewer, actor }) } } }),
      ),
    )
    const finish = async () => {
      const { state } = (
        await harness.call("POST", "/api/everywhere/link", { token: alice.token, body: { platform: "linear" } })
      ).body
      return harness.call("POST", "/api/everywhere/oauth-finish", { token: alice.token, body: { code: "c", state } })
    }
    const unconnected = await finish()
    expect(unconnected.status).toBe(403)
    expect(unconnected.body.error.reason).toBe("not-connected")
    await install(LINEAR, bob.id)
    actor = { ...person, automation: true }
    const app = await finish()
    expect(app.status).toBe(403)
    expect(app.body.error.reason).toBe("automation")
    expect(await findLink(ctx().store, LINEAR, viewer)).toBeUndefined()
    expect(notices).toEqual([])
  })
})
