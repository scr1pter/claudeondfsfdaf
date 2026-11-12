import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test"
import { randomBytes, randomUUID } from "node:crypto"
import { createAccountApi, type AccountApiDeps } from "../../../api/_lib/everywhere/account-api"
import { readAudit } from "../../../api/_lib/everywhere/audit"
import { readConfig } from "../../../api/_lib/everywhere/config"
import type { JobEraser } from "../../../api/_lib/everywhere/erase"
import {
  findInstall,
  findLink,
  installToken,
  issueConnectCode,
  redeemLinkCode,
  type IdentityContext,
  type InstallGrant,
  type OAuthExchanges,
} from "../../../api/_lib/everywhere/identity"
import { everywhereKeys } from "../../../api/_lib/everywhere/keys"
import { everywhereStore } from "../../../api/_lib/everywhere/store"
import { everywhereEnv, FakeAccounts, FakeJira, RouteHarness, testAccount } from "./lib/everywhere-account"
import { installFetchGuard } from "./lib/everywhere-fetch-guard"
import { FakeStore, useKv } from "./lib/everywhere-store"

installFetchGuard()

/*
 * VE-04: installations and repository mappings through the routes (3.8, E2, E13). An install finishes only for the
 * account that started it, with the platform's code exchanged only after that check; a re-install by another account
 * is refused unless the installer administers the place; a Jira site is connected with a connect code that works once
 * for its cloud id; only the connector maps repositories or disconnects. Fakes only, on 127.0.0.1.
 */

const accounts = new FakeAccounts()
const harness = new RouteHarness()
const jira = new FakeJira()
let restore: () => void
beforeAll(async () => {
  restore = useKv()
  accounts.start()
  jira.start()
  await harness.start()
})
afterAll(async () => {
  restore()
  await accounts.stop()
  await jira.stop()
  await harness.stop()
})

const alice = accounts.add(testAccount("alice@example.com"))
const bob = accounts.add(testAccount("bob@example.org"))
const SLACK = "slack:T0123ABCD"
const SLACK_OTHER = "slack:T0999ZZZZ"
const CLOUD = randomUUID()
const JIRA = `jira:${CLOUD}`
const adminToken = `admin-${randomBytes(12).toString("hex")}`
jira.admins.add(adminToken)

let fake: FakeStore
let env: Record<string, string>
let exchanged: string[]
let grant: InstallGrant
let erasedJobs: string[]

const slackToken = () => `xoxb-${randomBytes(16).toString("hex")}`

function exchanges(): OAuthExchanges {
  return {
    slack: {
      install: async (code) => {
        exchanged.push(code)
        return grant
      },
    },
  }
}

const jobs: JobEraser = {
  installation: async (installation) => {
    erasedJobs.push(installation)
  },
  account: async () => {},
}

function deps(extra: Partial<AccountApiDeps> = {}): AccountApiDeps {
  return {
    env,
    store: everywhereStore(fake.fetch),
    now: () => fake.clock.now,
    notify: async () => {},
    exchanges: exchanges(),
    jobs,
    ...extra,
  }
}

function ctx(): IdentityContext {
  return { store: everywhereStore(fake.fetch), keys: readConfig(env).dataKeys, now: fake.clock.now }
}

async function start(account: { token: string }, body: Record<string, unknown> = { platform: "slack" }) {
  const answer = await harness.call("POST", "/api/everywhere/installs", { token: account.token, body })
  expect(answer.status).toBe(200)
  return answer.body as { state: string; url: string; expiresAt: number }
}

function finish(account: { token: string }, state: string, code = "slack-oauth-code") {
  return harness.call("POST", "/api/everywhere/oauth-finish", { token: account.token, body: { code, state } })
}

beforeEach(() => {
  fake = new FakeStore()
  env = everywhereEnv()
  exchanged = []
  erasedJobs = []
  grant = {
    installation: SLACK,
    token: slackToken(),
    scopes: ["chat:write", "app_mentions:read"],
    botUserId: "U0BOT0001",
    installer: { userId: "U0AAA1111", admin: false },
  }
  harness.use(createAccountApi(deps()))
})

describe("OAuth installs", () => {
  test("POST /installs starts a Slack install with a state for the signed-in account and the authorize URL", async () => {
    const started = await start(alice)
    const url = new URL(started.url)
    expect(url.origin + url.pathname).toBe("https://slack.com/oauth/v2/authorize")
    expect(url.searchParams.get("state")).toBe(started.state)
    expect(started.expiresAt).toBe(fake.clock.now + 600_000)
    const stored = fake.read(everywhereKeys.state(started.state))
    expect(stored?.kind === "string" && JSON.parse(stored.value)).toMatchObject({
      account: alice.id,
      platform: "slack",
      purpose: "install",
    })
    expect(JSON.stringify([...fake.data.values()])).not.toContain(alice.email)
  })

  test("the finish records the installation for the account that started it; no answer carries the token", async () => {
    const started = await start(alice)
    const finished = await finish(alice, started.state)
    expect(finished.status).toBe(200)
    expect(finished.body).toEqual({ purpose: "install", platform: "slack", installation: SLACK, change: "new" })
    expect(exchanged).toEqual(["slack-oauth-code"])
    const record = (await findInstall(ctx().store, SLACK))!
    expect(record.connector).toBe(alice.id)
    expect(installToken(readConfig(env).dataKeys, SLACK, record)).toBe(grant.token)
    const listed = await harness.call("GET", "/api/everywhere/installs", { token: alice.token })
    expect(listed.body.installs).toEqual([
      {
        installation: SLACK,
        platform: "slack",
        installedAt: fake.clock.now,
        scopes: ["chat:write", "app_mentions:read"],
        botUserId: "U0BOT0001",
      },
    ])
    for (const text of [finished.text, listed.text]) {
      expect(text).not.toContain(grant.token!)
      expect(text).not.toContain("tokenEnc")
    }
    expect((await harness.call("GET", "/api/everywhere/installs", { token: bob.token })).body.installs).toEqual([])
  })

  test("an install finished by another account is refused before the platform's code is exchanged", async () => {
    const started = await start(alice)
    const stolen = await finish(bob, started.state)
    expect(stolen.status).toBe(403)
    expect(stolen.body.error.code).toBe("EVERYWHERE_STATE_ACCOUNT")
    expect(exchanged).toEqual([])
    expect(await findInstall(ctx().store, SLACK)).toBeUndefined()
    // The state was spent by the refused attempt.
    expect((await finish(alice, started.state)).body.error.code).toBe("EVERYWHERE_STATE_INVALID")
  })

  test("a state works once and for 10 minutes", async () => {
    const started = await start(alice)
    expect((await finish(alice, started.state)).status).toBe(200)
    expect((await finish(alice, started.state)).status).toBe(400)
    const late = await start(alice)
    fake.clock.advance(600_001)
    expect((await finish(alice, late.state)).body.error.code).toBe("EVERYWHERE_STATE_INVALID")
    expect((await finish(alice, "not-a-state")).status).toBe(400)
  })

  test("an install that lands in another workspace than the one it started for is refused", async () => {
    const started = await start(alice, { platform: "slack", installation: SLACK_OTHER })
    const answer = await finish(alice, started.state)
    expect(answer.status).toBe(409)
    expect(answer.body.error.code).toBe("EVERYWHERE_WRONG_PLACE")
    expect(await findInstall(ctx().store, SLACK)).toBeUndefined()
  })

  test("a re-install by another account is refused unless the installer administers the workspace", async () => {
    expect((await finish(alice, (await start(alice)).state)).status).toBe(200)
    grant = { ...grant, token: slackToken(), installer: { userId: "U0BBB2222", admin: false } }
    const refused = await finish(bob, (await start(bob)).state)
    expect(refused.status).toBe(409)
    expect(refused.body.error.code).toBe("EVERYWHERE_INSTALLED_ELSEWHERE")
    expect(await findInstall(ctx().store, SLACK)).toMatchObject({ connector: alice.id })
    grant = { ...grant, installer: { userId: "U0BBB2222", admin: true } }
    const admin = await finish(bob, (await start(bob)).state)
    expect(admin.status).toBe(200)
    expect(admin.body.change).toBe("connector-change")
    expect((await harness.call("GET", "/api/everywhere/installs", { token: alice.token })).body.installs).toEqual([])
    expect(
      (await harness.call("GET", "/api/everywhere/installs", { token: bob.token })).body.installs.map(
        (item: { installation: string }) => item.installation,
      ),
    ).toEqual([SLACK])
    expect(await readAudit(ctx().store, alice.id)).toContainEqual(
      expect.objectContaining({ event: "connector-change", installation: SLACK, actor: bob.id, code: "admin" }),
    )
  })

  test("after the connector disconnects, another account may install; only the connector disconnects", async () => {
    expect((await finish(alice, (await start(alice)).state)).status).toBe(200)
    const notYours = await harness.call("DELETE", "/api/everywhere/installs", {
      token: bob.token,
      body: { installation: SLACK },
    })
    expect(notYours.status).toBe(404)
    expect(await findInstall(ctx().store, SLACK)).toMatchObject({ connector: alice.id })
    const gone = await harness.call("DELETE", "/api/everywhere/installs", {
      token: alice.token,
      body: { installation: SLACK },
    })
    expect(gone.status).toBe(200)
    expect(gone.body).toEqual({ erased: true, links: 0, mappings: 0 })
    expect(erasedJobs).toEqual([SLACK])
    expect(await findInstall(ctx().store, SLACK)).toBeUndefined()
    expect(await readAudit(ctx().store, alice.id)).toContainEqual(
      expect.objectContaining({ event: "disconnect", installation: SLACK, code: "disconnected" }),
    )
    grant = { ...grant, token: slackToken(), installer: { userId: "U0BBB2222", admin: false } }
    const fresh = await finish(bob, (await start(bob)).state)
    expect(fresh.status).toBe(200)
    expect(fresh.body.change).toBe("new")
  })

  test("a disconnect erases the workspace's links and mappings too", async () => {
    expect((await finish(alice, (await start(alice)).state)).status).toBe(200)
    const { code } = (
      await harness.call("POST", "/api/everywhere/link", { token: bob.token, body: { platform: "slack" } })
    ).body
    await redeemLinkCode(ctx(), {
      code,
      installation: SLACK,
      userId: "U0BBB2222",
      place: "private",
      actor: { bot: false, external: false, guest: false },
    })
    await harness.call("PUT", "/api/everywhere/repos", {
      token: alice.token,
      body: { installation: SLACK, place: "C0123", repositories: [{ fullName: "acme/api", id: 7 }] },
    })
    const gone = await harness.call("DELETE", "/api/everywhere/installs", {
      token: alice.token,
      body: { installation: SLACK },
    })
    expect(gone.body).toEqual({ erased: true, links: 1, mappings: 1 })
    expect(await findLink(ctx().store, SLACK, "U0BBB2222")).toBeUndefined()
    expect((await harness.call("GET", "/api/everywhere/links", { token: bob.token })).body.links).toEqual([])
  })

  test("without the platform's exchange, the finish answers 501; GitHub installs are not made here", async () => {
    harness.use(createAccountApi(deps({ exchanges: {} })))
    const answer = await finish(alice, (await start(alice)).state)
    expect(answer.status).toBe(501)
    const github = await harness.call("POST", "/api/everywhere/installs", {
      token: alice.token,
      body: { platform: "github" },
    })
    expect(github.status).toBe(400)
  })

  test("an exchange that fails says so without the platform's words", async () => {
    harness.use(
      createAccountApi(
        deps({
          exchanges: {
            slack: {
              install: async () => {
                throw new Error("invalid_code from upstream with secret-ish detail")
              },
            },
          },
        }),
      ),
    )
    const answer = await finish(alice, (await start(alice)).state)
    expect(answer.status).toBe(502)
    expect(answer.text).not.toContain("secret-ish")
  })
})

describe("Jira connect codes on vectordev.ai", () => {
  async function connectCode() {
    const issued = await issueConnectCode(
      ctx(),
      { cloudId: CLOUD, accountId: `557058:${randomUUID()}`, userToken: adminToken },
      jira.fetch,
    )
    if (!issued.ok) throw new Error("no code")
    return issued.code
  }

  test("a connect code connects its own site, once; naming another site burns it", async () => {
    const burned = await connectCode()
    const wrongSite = await harness.call("POST", "/api/everywhere/installs", {
      token: alice.token,
      body: { platform: "jira", code: burned, cloudId: randomUUID() },
    })
    expect(wrongSite.status).toBe(400)
    expect(wrongSite.body.error.code).toBe("EVERYWHERE_CODE_INVALID")
    const retry = await harness.call("POST", "/api/everywhere/installs", {
      token: alice.token,
      body: { platform: "jira", code: burned, cloudId: CLOUD },
    })
    expect(retry.status).toBe(400)
    const code = await connectCode()
    const connected = await harness.call("POST", "/api/everywhere/installs", {
      token: alice.token,
      body: { platform: "jira", code, cloudId: CLOUD },
    })
    expect(connected.status).toBe(200)
    expect(connected.body).toEqual({ platform: "jira", installation: JIRA, change: "new" })
    const again = await harness.call("POST", "/api/everywhere/installs", {
      token: bob.token,
      body: { platform: "jira", code },
    })
    expect(again.status).toBe(400)
    expect(await findInstall(ctx().store, JIRA)).toMatchObject({ connector: alice.id })
  })

  test("a Jira site is off while the platform is off", async () => {
    env = everywhereEnv("slack")
    harness.use(createAccountApi(deps()))
    const answer = await harness.call("POST", "/api/everywhere/installs", {
      token: alice.token,
      body: { platform: "jira", code: "AAAA-BBBB-CCCC" },
    })
    expect(answer.status).toBe(404)
  })
})

describe("repository mappings", () => {
  beforeEach(async () => {
    expect((await finish(alice, (await start(alice)).state)).status).toBe(200)
  })

  test("only the connector sets, lists and removes a place's repositories", async () => {
    const body = {
      installation: SLACK,
      place: "C0123",
      repositories: [{ fullName: "acme/api", id: 7 }, { fullName: "acme/web" }],
      private: true,
    }
    expect((await harness.call("PUT", "/api/everywhere/repos", { token: bob.token, body })).status).toBe(404)
    const set = await harness.call("PUT", "/api/everywhere/repos", { token: alice.token, body })
    expect(set.status).toBe(200)
    expect(set.body.mapping).toEqual({
      place: "C0123",
      repositories: [{ fullName: "acme/api", id: 7 }, { fullName: "acme/web" }],
      setBy: alice.id,
      private: true,
      setAt: fake.clock.now,
    })
    expect(
      (await harness.call("GET", "/api/everywhere/repos", { token: bob.token, query: { installation: SLACK } })).status,
    ).toBe(404)
    const listed = await harness.call("GET", "/api/everywhere/repos", {
      token: alice.token,
      query: { installation: SLACK },
    })
    expect(listed.body).toEqual({ installation: SLACK, mappings: [set.body.mapping] })
    expect(
      (
        await harness.call("DELETE", "/api/everywhere/repos", {
          token: bob.token,
          body: { installation: SLACK, place: "C0123" },
        })
      ).status,
    ).toBe(404)
    const removed = await harness.call("DELETE", "/api/everywhere/repos", {
      token: alice.token,
      body: { installation: SLACK, place: "C0123" },
    })
    expect(removed.body).toEqual({ removed: true })
    expect(
      (await harness.call("GET", "/api/everywhere/repos", { token: alice.token, query: { installation: SLACK } })).body
        .mappings,
    ).toEqual([])
  })

  test("malformed mappings are refused", async () => {
    for (const body of [
      { installation: SLACK, place: "C0123", repositories: [{ fullName: "not a repo" }] },
      { installation: SLACK, place: "C0123", repositories: [{ fullName: "acme/api", id: -1 }] },
      { installation: SLACK, place: "C0123", repositories: [{ fullName: "acme/api", extra: "field" }] },
      { installation: SLACK, place: "C0123", repositories: [], private: "yes" },
      { installation: SLACK, place: "C 0123", repositories: [] },
    ])
      expect((await harness.call("PUT", "/api/everywhere/repos", { token: alice.token, body })).status).toBe(400)
  })
})
