import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { randomBytes, randomUUID } from "node:crypto"
import { readAudit } from "../../../api/_lib/everywhere/audit"
import { dataKey } from "../../../api/_lib/everywhere/crypto"
import { eraseInstallation } from "../../../api/_lib/everywhere/erase"
import {
  CODE_ALPHABET,
  LINK_TRIES_MAX,
  createState,
  findInstall,
  findLink,
  findMapping,
  installToken,
  issueConnectCode,
  issueLinkCode,
  linkBySignIn,
  listInstalls,
  listLinks,
  listMappings,
  maskEmail,
  normalizeCode,
  oauthUrl,
  recordInstall,
  redeemConnectCode,
  redeemLinkCode,
  removeMapping,
  setMapping,
  setMappingByWord,
  takeState,
  unlink,
  type IdentityContext,
  type InstallGrant,
  type LinkActor,
  type LinkNotice,
} from "../../../api/_lib/everywhere/identity"
import { readConfig } from "../../../api/_lib/everywhere/config"
import { everywhereKeys } from "../../../api/_lib/everywhere/keys"
import { type Store } from "../../../api/_lib/everywhere/store"
import { everywhereEnv, FakeJira } from "./lib/everywhere-account"
import { installFetchGuard } from "./lib/everywhere-fetch-guard"
import { FakeStore, realRedis, useKv, type RealRedis, testEverywhereStore, testAccountAuthority } from "./lib/everywhere-store"

installFetchGuard()

/*
 * VE-04: identity, links, installations and mappings (3.8, E2). A link code works once, within 10 minutes, only from a
 * private place and only on the platform (and workspace) it was made for; a re-install by another account is refused
 * unless the installer administers the place; a Jira connect code is issued only after the ADMINISTER check and works
 * once for its cloud id; a mapping is set only by the connector or a linked requester's `repo` word.
 */

let restore: () => void
const jira = new FakeJira()
beforeAll(() => {
  restore = useKv()
  jira.start()
})
afterAll(async () => {
  restore()
  await jira.stop()
})

const keys = [dataKey(randomBytes(32))]
const A = { id: randomUUID(), email: "alice@example.com" }
const B = { id: randomUUID(), email: "bob@example.org" }
const SLACK = "slack:T0123ABCD"
const SLACK_OTHER = "slack:T0999ZZZZ"
const LINEAR = `linear:${randomUUID()}`
const CLOUD = randomUUID()
const JIRA = `jira:${CLOUD}`
const U1 = "U0AAA1111"
const U2 = "U0BBB2222"
const JIRA_USER = `557058:${randomUUID()}`
const person: LinkActor = { bot: false, external: false, guest: false }

class World {
  readonly fake = new FakeStore()
  readonly store: Store = testEverywhereStore(this.fake.fetch)
  readonly notices: LinkNotice[] = []
  ctx(): IdentityContext {
    return {
      store: this.store,
      accountAuthority: testAccountAuthority,
      keys,
      now: this.fake.clock.now,
      notify: async (notice) => {
        this.notices.push(notice)
      },
    }
  }
  async install(installation: string, account: string, extra: Partial<InstallGrant> = {}) {
    const verdict = await recordInstall(this.ctx(), {
      account,
      event: "install",
      grant: { installation, scopes: ["chat:write"], installer: { admin: false }, ...extra },
    })
    expect(verdict.ok).toBe(true)
  }
  /** Every stored key and value as one string, to check that something secret is not in it. */
  dump() {
    return JSON.stringify(
      [...this.fake.data.entries()].map(([key, value]) => [
        key,
        value.kind === "string" ? value.value : [...value.value.keys()],
      ]),
    )
  }
}

async function codeFor(
  world: World,
  account: { id: string; email?: string },
  platform: "slack" | "jira" = "slack",
  installation?: string,
) {
  return (
    await issueLinkCode(world.ctx(), {
      account: account.id,
      ...(account.email ? { email: account.email } : {}),
      platform,
      ...(installation ? { installation } : {}),
    })
  ).code
}

function dm(code: string, installation = SLACK, userId = U1, actor: LinkActor = person) {
  return { code, installation, userId, place: "private" as const, actor }
}

describe("link codes", () => {
  test("a code is 8 letters from a 32-letter alphabet and is stored only as a keyed hash, with the e-mail sealed", async () => {
    const world = new World()
    const issued = await issueLinkCode(world.ctx(), { account: A.id, email: A.email, platform: "slack" })
    expect(issued.code).toMatch(/^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/)
    expect(CODE_ALPHABET).toHaveLength(32)
    expect(issued.expiresAt).toBe(world.fake.clock.now + 600_000)
    const compact = issued.code.replace("-", "")
    const stored = world.dump()
    expect(stored).not.toContain(compact)
    expect(stored).not.toContain(issued.code)
    expect(stored).not.toContain(A.email)
    const codeKeys = [...world.fake.data.keys()].filter((key) => key.startsWith("vector:everywhere:linkcode:"))
    expect(codeKeys).toHaveLength(1)
    expect(codeKeys[0]).toMatch(/^vector:everywhere:linkcode:[0-9a-f]{64}$/)
    expect(world.fake.pttl(codeKeys[0]!)).toBe(600_000)
  })

  test("a code works once, sent from a private place, and the platform user learns which account it linked", async () => {
    const world = new World()
    await world.install(SLACK, A.id)
    const code = await codeFor(world, A)
    const first = await redeemLinkCode(world.ctx(), dm(code))
    expect(first).toEqual({ ok: true, account: A.id, already: false, hint: "a•••@example.com" })
    expect(await redeemLinkCode(world.ctx(), dm(code, SLACK, U2))).toEqual({ ok: false, code: "link-invalid" })
    expect(await findLink(world.store, SLACK, U2)).toBeUndefined()
  })

  test("a code works for 10 minutes and not after", async () => {
    const world = new World()
    await world.install(SLACK, A.id)
    const late = await codeFor(world, A)
    world.fake.clock.advance(600_001)
    expect(await redeemLinkCode(world.ctx(), dm(late))).toEqual({ ok: false, code: "link-invalid" })
    const inTime = await codeFor(world, A)
    world.fake.clock.advance(599_000)
    expect((await redeemLinkCode(world.ctx(), dm(inTime))).ok).toBe(true)
  })

  test("a code sent in a shared place is refused and burned, whoever sends it", async () => {
    const world = new World()
    await world.install(SLACK, A.id)
    const code = await codeFor(world, A)
    expect(await redeemLinkCode(world.ctx(), { ...dm(code), place: "shared" })).toEqual({
      ok: false,
      code: "shared-place",
    })
    expect(await redeemLinkCode(world.ctx(), dm(code))).toEqual({ ok: false, code: "link-invalid" })
    expect(await findLink(world.store, SLACK, U1)).toBeUndefined()
  })

  test("a code made for one platform is refused on another, and is used up", async () => {
    const world = new World()
    await world.install(SLACK, A.id)
    await world.install(JIRA, A.id)
    const code = await codeFor(world, A, "slack")
    expect(await redeemLinkCode(world.ctx(), dm(code, JIRA, JIRA_USER))).toEqual({ ok: false, code: "link-invalid" })
    expect(await redeemLinkCode(world.ctx(), dm(code))).toEqual({ ok: false, code: "link-invalid" })
  })

  test("a code made for one workspace is refused in another", async () => {
    const world = new World()
    await world.install(SLACK, A.id)
    await world.install(SLACK_OTHER, B.id)
    const code = await codeFor(world, A, "slack", SLACK)
    expect(await redeemLinkCode(world.ctx(), dm(code, SLACK_OTHER, U2))).toEqual({ ok: false, code: "link-invalid" })
    expect(await findLink(world.store, SLACK_OTHER, U2)).toBeUndefined()
  })

  test("a newer code ends the older one", async () => {
    const world = new World()
    await world.install(SLACK, A.id)
    const older = await codeFor(world, A)
    const newer = await codeFor(world, A)
    expect(await redeemLinkCode(world.ctx(), dm(older))).toEqual({ ok: false, code: "link-invalid" })
    expect((await redeemLinkCode(world.ctx(), dm(newer))).ok).toBe(true)
  })

  test("bots, automations, external users and guests are refused", async () => {
    const world = new World()
    await world.install(SLACK, A.id)
    const cases: [LinkActor, string][] = [
      [{ ...person, bot: true }, "bot"],
      [{ ...person, automation: true }, "automation"],
      [{ ...person, external: true }, "external"],
      [{ ...person, guest: true }, "guest"],
    ]
    for (const [actor, code] of cases) {
      const issued = await codeFor(world, A)
      expect(await redeemLinkCode(world.ctx(), dm(issued, SLACK, U1, actor))).toEqual({
        ok: false,
        code: code as never,
      })
    }
    expect(await findLink(world.store, SLACK, U1)).toBeUndefined()
  })

  test("an installation nobody connected is refused", async () => {
    const world = new World()
    const code = await codeFor(world, A)
    expect(await redeemLinkCode(world.ctx(), dm(code))).toEqual({ ok: false, code: "not-connected" })
  })

  test("after 10 failed attempts in an hour, a platform user is refused without any code being read", async () => {
    const world = new World()
    await world.install(SLACK, A.id)
    for (let index = 0; index < LINK_TRIES_MAX; index++)
      expect(await redeemLinkCode(world.ctx(), dm("ZZZZ-ZZZZ"))).toEqual({ ok: false, code: "link-invalid" })
    const code = await codeFor(world, A)
    const before = world.fake.commands.length
    expect(await redeemLinkCode(world.ctx(), dm(code))).toEqual({ ok: false, code: "link-invalid" })
    expect(world.fake.commands.slice(before).some(([name]) => name === "GETDEL")).toBe(false)
    // Another person is not held back, and the code is still unused.
    expect((await redeemLinkCode(world.ctx(), dm(code, SLACK, U2))).ok).toBe(true)
    world.fake.clock.advance(3_600_000)
    expect((await redeemLinkCode(world.ctx(), dm(await codeFor(world, A)))).ok).toBe(true)
  })

  test("codes are read as people type them", () => {
    expect(normalizeCode("abcd-efgh", 8)).toBe("ABCDEFGH")
    expect(normalizeCode(" ab cd ef gh ", 8)).toBe("ABCDEFGH")
    expect(normalizeCode("O0IL-1234", 8)).toBe("00111234")
    expect(normalizeCode("ABCD-EFGU", 8)).toBeUndefined()
    expect(normalizeCode("ABCD-EFG", 8)).toBeUndefined()
    expect(normalizeCode("ABCD-EFGH-J", 8)).toBeUndefined()
    expect(normalizeCode(42, 8)).toBeUndefined()
  })

  test("Linear and GitHub links take no code", async () => {
    const world = new World()
    for (const platform of ["linear", "github"] as const)
      await expect(issueLinkCode(world.ctx(), { account: A.id, platform })).rejects.toMatchObject({
        code: "EVERYWHERE_UNSUPPORTED",
      })
  })

  test("the e-mail is shown masked", () => {
    expect(maskEmail("Alice@Example.com")).toBe("a•••@example.com")
    expect(maskEmail("x@y.io")).toBe("x•••@y.io")
    expect(maskEmail("not an address")).toBeUndefined()
  })
})

describe("links", () => {
  test("a link records the account, both indexes, an audit entry and a notice to the account", async () => {
    const world = new World()
    await world.install(SLACK, B.id)
    await redeemLinkCode(world.ctx(), dm(await codeFor(world, A)))
    expect(await findLink(world.store, SLACK, U1)).toEqual({ account: A.id, linkedAt: world.fake.clock.now, revision: expect.stringMatching(/^[A-Za-z0-9_-]{22}$/) })
    expect(await listLinks(world.store, A.id)).toEqual([
      { installation: SLACK, platform: "slack", userId: U1, linkedAt: world.fake.clock.now },
    ])
    expect(world.fake.read(everywhereKeys.linked(SLACK))).toEqual({ kind: "set", value: new Set([U1]) })
    expect(await readAudit(world.store, A.id)).toContainEqual(
      expect.objectContaining({ event: "link", platform: "slack", installation: SLACK, userId: U1 }),
    )
    expect(world.notices).toEqual([
      { account: A.id, email: A.email, platform: "slack", installation: SLACK, userId: U1 },
    ])
  })

  test("linking again to the same account changes nothing and sends no second notice", async () => {
    const world = new World()
    await world.install(SLACK, A.id)
    await redeemLinkCode(world.ctx(), dm(await codeFor(world, A)))
    const again = await redeemLinkCode(world.ctx(), dm(await codeFor(world, A)))
    expect(again).toMatchObject({ ok: true, already: true })
    expect(world.notices).toHaveLength(1)
  })

  test("a person who links to another account moves the link, and the old account's log says so", async () => {
    const world = new World()
    await world.install(SLACK, A.id)
    await redeemLinkCode(world.ctx(), dm(await codeFor(world, A)))
    const moved = await redeemLinkCode(world.ctx(), dm(await codeFor(world, B)))
    expect(moved).toMatchObject({ ok: true, account: B.id, previous: A.id })
    expect(await listLinks(world.store, A.id)).toEqual([])
    expect((await listLinks(world.store, B.id)).map((link) => link.userId)).toEqual([U1])
    expect(await readAudit(world.store, A.id)).toContainEqual(
      expect.objectContaining({ event: "unlink", userId: U1, code: "unlinked" }),
    )
  })

  test("unlink removes the link and its index entries", async () => {
    const world = new World()
    await world.install(SLACK, A.id)
    await redeemLinkCode(world.ctx(), dm(await codeFor(world, A)))
    expect(await unlink(world.ctx(), { installation: SLACK, userId: U1 })).toEqual({ ok: true, account: A.id })
    expect(await findLink(world.store, SLACK, U1)).toBeUndefined()
    expect(world.fake.read(everywhereKeys.links(A.id))).toBeUndefined()
    expect(world.fake.read(everywhereKeys.linked(SLACK))).toBeUndefined()
    expect(await readAudit(world.store, A.id)).toContainEqual(
      expect.objectContaining({ event: "unlink", userId: U1, code: "unlinked" }),
    )
    expect(await unlink(world.ctx(), { installation: SLACK, userId: U1 })).toEqual({ ok: false })
  })

  test("from vectordev.ai an account removes only its own link", async () => {
    const world = new World()
    await world.install(SLACK, A.id)
    await redeemLinkCode(world.ctx(), dm(await codeFor(world, A)))
    expect(await unlink(world.ctx(), { installation: SLACK, userId: U1, account: B.id })).toEqual({ ok: false })
    expect(await findLink(world.store, SLACK, U1)).toMatchObject({ account: A.id })
    expect(await unlink(world.ctx(), { installation: SLACK, userId: U1, account: A.id })).toEqual({
      ok: true,
      account: A.id,
    })
  })

  test("a Linear sign-in links the signed-in viewer; app users and unconnected workspaces are refused", async () => {
    const world = new World()
    const viewer = randomUUID()
    expect(
      await linkBySignIn(world.ctx(), { account: A.id, installation: LINEAR, userId: viewer, actor: person }),
    ).toEqual({
      ok: false,
      code: "not-connected",
    })
    await world.install(LINEAR, B.id, { installer: { admin: true } })
    expect(
      await linkBySignIn(world.ctx(), {
        account: A.id,
        installation: LINEAR,
        userId: viewer,
        actor: { ...person, automation: true },
      }),
    ).toEqual({ ok: false, code: "automation" })
    expect(
      await linkBySignIn(world.ctx(), {
        account: A.id,
        email: A.email,
        installation: LINEAR,
        userId: viewer,
        actor: person,
      }),
    ).toEqual({ ok: true, account: A.id, already: false, hint: "a•••@example.com" })
    expect(await findLink(world.store, LINEAR, viewer)).toMatchObject({ account: A.id })
    await expect(
      linkBySignIn(world.ctx(), { account: A.id, installation: SLACK, userId: U1, actor: person }),
    ).rejects.toMatchObject({ code: "EVERYWHERE_UNSUPPORTED" })
  })
})

describe("installations", () => {
  const token = () => `xoxb-${randomBytes(16).toString("hex")}`

  test("the first install makes the account its connector, with the token sealed to that record", async () => {
    const world = new World()
    const secretToken = token()
    const verdict = await recordInstall(world.ctx(), {
      account: A.id,
      event: "install",
      grant: {
        installation: SLACK,
        token: secretToken,
        scopes: ["chat:write"],
        botUserId: "U0BOT0001",
        installer: { admin: false },
      },
    })
    expect(verdict).toEqual({ ok: true, installation: SLACK, change: "new" })
    expect(world.dump()).not.toContain(secretToken)
    const record = (await findInstall(world.store, SLACK))!
    expect(record).toMatchObject({ connector: A.id, scopes: ["chat:write"], botUserId: "U0BOT0001" })
    expect(installToken(keys, SLACK, record)).toBe(secretToken)
    // A sealed token copied into another installation's record does not open there.
    expect(installToken(keys, SLACK_OTHER, record)).toBeUndefined()
    const listed = await listInstalls(world.store, A.id)
    expect(listed).toEqual([
      {
        installation: SLACK,
        platform: "slack",
        installedAt: world.fake.clock.now,
        scopes: ["chat:write"],
        botUserId: "U0BOT0001",
      },
    ])
    expect(JSON.stringify(listed)).not.toContain("tokenEnc")
    expect(await readAudit(world.store, A.id)).toContainEqual(
      expect.objectContaining({ event: "install", installation: SLACK }),
    )
  })

  test("the connector may install again", async () => {
    const world = new World()
    await world.install(SLACK, A.id)
    const again = await recordInstall(world.ctx(), {
      account: A.id,
      event: "install",
      grant: { installation: SLACK, scopes: [], installer: { admin: false } },
    })
    expect(again).toEqual({ ok: true, installation: SLACK, change: "renewed" })
  })

  test("a re-install by another account is refused", async () => {
    const world = new World()
    await world.install(SLACK, A.id)
    const refused = await recordInstall(world.ctx(), {
      account: B.id,
      event: "install",
      grant: { installation: SLACK, token: token(), scopes: [], installer: { userId: U2, admin: false } },
    })
    expect(refused).toEqual({ ok: false, code: "installed-elsewhere" })
    expect(await findInstall(world.store, SLACK)).toMatchObject({ connector: A.id })
    expect(await listInstalls(world.store, B.id)).toEqual([])
    expect(world.fake.read(everywhereKeys.installs(B.id))).toBeUndefined()
  })

  test("a platform admin's re-install changes the connector, and both accounts' logs say so", async () => {
    const world = new World()
    await world.install(SLACK, A.id)
    const changed = await recordInstall(world.ctx(), {
      account: B.id,
      event: "install",
      grant: { installation: SLACK, scopes: [], installer: { userId: U2, admin: true } },
    })
    expect(changed).toEqual({ ok: true, installation: SLACK, change: "connector-change", previous: A.id })
    expect(await listInstalls(world.store, A.id)).toEqual([])
    expect((await listInstalls(world.store, B.id)).map((item) => item.installation)).toEqual([SLACK])
    expect(await readAudit(world.store, A.id)).toContainEqual(
      expect.objectContaining({
        event: "connector-change",
        installation: SLACK,
        actor: B.id,
        code: "admin",
        userId: U2,
      }),
    )
    expect(await readAudit(world.store, B.id)).toContainEqual(
      expect.objectContaining({ event: "install", installation: SLACK, code: "admin" }),
    )
  })

  test("after the connector disconnects, another account may install", async () => {
    const world = new World()
    await world.install(SLACK, A.id)
    await eraseInstallation({ store: world.store, now: world.fake.clock.now }, SLACK, "disconnected")
    const fresh = await recordInstall(world.ctx(), {
      account: B.id,
      event: "install",
      grant: { installation: SLACK, scopes: [], installer: { admin: false } },
    })
    expect(fresh).toEqual({ ok: true, installation: SLACK, change: "new" })
  })

  test("a grant with a malformed installation, scope, token or bot id is refused", async () => {
    const world = new World()
    const base: InstallGrant = { installation: SLACK, scopes: [], installer: { admin: false } }
    for (const grant of [
      { ...base, installation: "slack:lowercase" },
      { ...base, scopes: ["has space"] },
      { ...base, token: "two words" },
      { ...base, botUserId: "not a user" },
    ])
      await expect(recordInstall(world.ctx(), { account: A.id, event: "install", grant })).rejects.toMatchObject({
        statusCode: 400,
      })
  })
})

describe("Jira site connect codes", () => {
  const adminToken = `admin-${randomBytes(12).toString("hex")}`
  const memberToken = `member-${randomBytes(12).toString("hex")}`
  beforeAll(() => {
    jira.admins.add(adminToken)
    jira.members.add(memberToken)
  })

  test("a connect code is issued only after the user token passes the ADMINISTER check", async () => {
    const world = new World()
    const input = { cloudId: CLOUD, accountId: JIRA_USER }
    expect(await issueConnectCode(world.ctx(), { ...input, userToken: memberToken }, jira.fetch)).toEqual({
      ok: false,
      code: "not-allowed",
    })
    expect(await issueConnectCode(world.ctx(), { ...input, userToken: "unknown-token" }, jira.fetch)).toEqual({
      ok: false,
      code: "not-allowed",
    })
    jira.failWith = 500
    expect(await issueConnectCode(world.ctx(), { ...input, userToken: adminToken }, jira.fetch)).toEqual({
      ok: false,
      code: "not-allowed",
    })
    jira.failWith = undefined
    expect([...world.fake.data.keys()].some((key) => key.includes(":connectcode:"))).toBe(false)
    const issued = await issueConnectCode(world.ctx(), { ...input, userToken: adminToken }, jira.fetch)
    expect(issued).toMatchObject({ ok: true, expiresAt: world.fake.clock.now + 600_000 })
    if (!issued.ok) throw new Error("no code")
    expect(issued.code).toMatch(/^[0-9A-HJKMNP-TV-Z]{4}(?:-[0-9A-HJKMNP-TV-Z]{4}){2}$/)
    expect(jira.seen.at(-1)).toEqual({ cloudId: CLOUD, permissions: "ADMINISTER" })
    const stored = world.dump()
    expect(stored).not.toContain(adminToken)
    expect(stored).not.toContain(issued.code.replaceAll("-", ""))
  })

  test("the code works once, only for its own cloud id; naming another site burns it", async () => {
    const world = new World()
    const issue = async () => {
      const issued = await issueConnectCode(
        world.ctx(),
        { cloudId: CLOUD, accountId: JIRA_USER, userToken: adminToken },
        jira.fetch,
      )
      if (!issued.ok) throw new Error("no code")
      return issued.code
    }
    const burned = await issue()
    expect(await redeemConnectCode(world.ctx(), { account: A.id, code: burned, cloudId: randomUUID() })).toEqual({
      ok: false,
      code: "code-invalid",
    })
    expect(await redeemConnectCode(world.ctx(), { account: A.id, code: burned, cloudId: CLOUD })).toEqual({
      ok: false,
      code: "code-invalid",
    })
    const code = await issue()
    expect(await redeemConnectCode(world.ctx(), { account: A.id, code, cloudId: CLOUD })).toEqual({
      ok: true,
      installation: JIRA,
      change: "new",
    })
    expect(await redeemConnectCode(world.ctx(), { account: B.id, code })).toEqual({ ok: false, code: "code-invalid" })
    expect(await findInstall(world.store, JIRA)).toMatchObject({ connector: A.id, scopes: [] })
    expect(await readAudit(world.store, A.id)).toContainEqual(
      expect.objectContaining({ event: "connect", installation: JIRA }),
    )
  })

  test("the code expires after 10 minutes", async () => {
    const world = new World()
    const issued = await issueConnectCode(
      world.ctx(),
      { cloudId: CLOUD, accountId: JIRA_USER, userToken: adminToken },
      jira.fetch,
    )
    if (!issued.ok) throw new Error("no code")
    world.fake.clock.advance(600_001)
    expect(await redeemConnectCode(world.ctx(), { account: A.id, code: issued.code })).toEqual({
      ok: false,
      code: "code-invalid",
    })
  })

  test("a site another account connected changes connector, because a connect code's issuer is a site admin", async () => {
    const world = new World()
    await world.install(JIRA, A.id)
    const issued = await issueConnectCode(
      world.ctx(),
      { cloudId: CLOUD, accountId: JIRA_USER, userToken: adminToken },
      jira.fetch,
    )
    if (!issued.ok) throw new Error("no code")
    expect(await redeemConnectCode(world.ctx(), { account: B.id, code: issued.code })).toMatchObject({
      ok: true,
      change: "connector-change",
      previous: A.id,
    })
    expect(await readAudit(world.store, A.id)).toContainEqual(
      expect.objectContaining({ event: "connector-change", actor: B.id, userId: JIRA_USER }),
    )
  })
})

describe("repository mappings", () => {
  const repo = (fullName: string, id = fullName === "acme/api" ? 7 : fullName === "acme/web" ? 8 : 9) => ({ fullName, id })

  test("only the connector sets a place's repositories", async () => {
    const world = new World()
    await world.install(SLACK, A.id)
    expect(
      await setMapping(world.ctx(), {
        account: B.id,
        installation: SLACK,
        place: "C0123",
        repositories: [repo("acme/api", 7)],
      }),
    ).toEqual({ ok: false, code: "not-connector" })
    expect(
      await setMapping(world.ctx(), { account: A.id, installation: SLACK_OTHER, place: "C0123", repositories: [] }),
    ).toEqual({ ok: false, code: "not-connected" })
    const set = await setMapping(world.ctx(), {
      account: A.id,
      installation: SLACK,
      place: "C0123",
      repositories: [repo("acme/api", 7), repo("acme/web")],
      private: true,
    })
    expect(set.ok).toBe(true)
    expect(await findMapping(world.store, SLACK, "C0123")).toEqual({
      revision: expect.stringMatching(/^[A-Za-z0-9_-]{22}$/),
      place: "C0123",
      repositories: [repo("acme/api", 7), repo("acme/web")],
      setBy: A.id,
      private: true,
      setAt: world.fake.clock.now,
    })
    expect((await listMappings(world.store, SLACK)).map((mapping) => mapping.place)).toEqual(["C0123"])
  })

  const allowed =
    (...accounts: string[]) =>
    (account: string) =>
      accounts.includes(account)

  test("the repo word: an allowed, linked requester sets a Slack channel's repository", async () => {
    const world = new World()
    await world.install(SLACK, A.id)
    await redeemLinkCode(world.ctx(), dm(await codeFor(world, B), SLACK, U2))
    const verdict = await setMappingByWord(world.ctx(), {
      installation: SLACK,
      place: "C0456",
      userId: U2,
      actor: person,
      repository: repo("bob/tool"),
      maySponsor: allowed(B.id),
    })
    expect(verdict).toMatchObject({
      ok: true,
      mapping: { setBy: B.id, private: false, repositories: [repo("bob/tool")] },
    })
    // Another allowed requester may change what a requester set.
    await redeemLinkCode(world.ctx(), dm(await codeFor(world, A), SLACK, U1))
    expect(
      await setMappingByWord(world.ctx(), {
        installation: SLACK,
        place: "C0456",
        userId: U1,
        actor: person,
        repository: repo("acme/api"),
        maySponsor: allowed(A.id, B.id),
      }),
    ).toMatchObject({ ok: true, mapping: { setBy: A.id, repositories: [repo("acme/api")] } })
  })

  test("the repo word never changes the connector's mapping but from the connector, and the private mark stays", async () => {
    const world = new World()
    await world.install(SLACK, A.id)
    await setMapping(world.ctx(), {
      account: A.id,
      installation: SLACK,
      place: "C0123",
      repositories: [repo("acme/api", 7)],
      private: true,
    })
    await redeemLinkCode(world.ctx(), dm(await codeFor(world, B), SLACK, U2))
    await redeemLinkCode(world.ctx(), dm(await codeFor(world, A), SLACK, U1))
    const word = (userId: string) =>
      setMappingByWord(world.ctx(), {
        installation: SLACK,
        place: "C0123",
        userId,
        actor: person,
        repository: repo("bob/tool"),
        maySponsor: allowed(A.id, B.id),
      })
    expect(await word(U2)).toEqual({ ok: false, code: "not-connector" })
    expect(await findMapping(world.store, SLACK, "C0123")).toMatchObject({
      setBy: A.id,
      repositories: [repo("acme/api", 7)],
    })
    expect(await word(U1)).toMatchObject({
      ok: true,
      mapping: { setBy: A.id, private: true, repositories: [repo("bob/tool")] },
    })
  })

  test("the repo word: a linked account that may not sponsor runs changes nothing", async () => {
    const world = new World()
    await world.install(SLACK, A.id)
    await redeemLinkCode(world.ctx(), dm(await codeFor(world, B), SLACK, U2))
    const asked: string[] = []
    const verdict = await setMappingByWord(world.ctx(), {
      installation: SLACK,
      place: "C0123",
      userId: U2,
      actor: person,
      repository: repo("evil/repo"),
      maySponsor: async (account) => {
        asked.push(account)
        return false
      },
    })
    expect(verdict).toEqual({ ok: false, code: "not-allowed" })
    expect(asked).toEqual([B.id])
    expect(await findMapping(world.store, SLACK, "C0123")).toBeUndefined()
  })

  test("the repo word is Slack's only: a Linear team's or a Jira project's mapping stays the connector's", async () => {
    const world = new World()
    await world.install(LINEAR, A.id)
    await world.install(JIRA, A.id)
    const viewer = randomUUID()
    expect(
      (await linkBySignIn(world.ctx(), { account: B.id, installation: LINEAR, userId: viewer, actor: person })).ok,
    ).toBe(true)
    expect((await redeemLinkCode(world.ctx(), dm(await codeFor(world, B, "jira"), JIRA, JIRA_USER))).ok).toBe(true)
    await setMapping(world.ctx(), {
      account: A.id,
      installation: LINEAR,
      place: "TEAM1",
      repositories: [repo("acme/api"), repo("acme/web")],
    })
    await setMapping(world.ctx(), {
      account: A.id,
      installation: JIRA,
      place: "PROJ",
      repositories: [repo("acme/api")],
    })
    const word = (installation: string, place: string, userId: string) =>
      setMappingByWord(world.ctx(), {
        installation,
        place,
        userId,
        actor: person,
        repository: repo("bob/tool"),
        maySponsor: allowed(A.id, B.id),
      })
    expect(await word(LINEAR, "TEAM1", viewer)).toEqual({ ok: false, code: "wrong-platform" })
    expect(await word(JIRA, "PROJ", JIRA_USER)).toEqual({ ok: false, code: "wrong-platform" })
    expect((await findMapping(world.store, LINEAR, "TEAM1"))?.repositories).toEqual([
      repo("acme/api"),
      repo("acme/web"),
    ])
    expect((await findMapping(world.store, JIRA, "PROJ"))?.repositories).toEqual([repo("acme/api")])
  })

  test("the repo word: an unlinked person, a bot, an external user or a guest changes nothing", async () => {
    const world = new World()
    await world.install(SLACK, A.id)
    await redeemLinkCode(world.ctx(), dm(await codeFor(world, B), SLACK, U2))
    const word = (userId: string, actor: LinkActor) =>
      setMappingByWord(world.ctx(), {
        installation: SLACK,
        place: "C0123",
        userId,
        actor,
        repository: repo("evil/repo"),
        maySponsor: () => true,
      })
    expect(await word(U1, person)).toEqual({ ok: false, code: "not-linked" })
    expect(await word(U2, { ...person, bot: true })).toEqual({ ok: false, code: "bot" })
    expect(await word(U2, { ...person, external: true })).toEqual({ ok: false, code: "external" })
    expect(await word(U2, { ...person, guest: true })).toEqual({ ok: false, code: "guest" })
    expect(await findMapping(world.store, SLACK, "C0123")).toBeUndefined()
  })

  test("malformed repositories and places are refused", async () => {
    const world = new World()
    await world.install(SLACK, A.id)
    const bad = [
      Array.from({ length: 21 }, (_, index) => repo(`acme/r${index}`)),
      [repo("acme/api"), repo("ACME/API")],
      [repo("not a repo")],
      [repo("acme/..")],
      [repo("acme/api", 0)],
    ]
    for (const repositories of bad)
      await expect(
        setMapping(world.ctx(), { account: A.id, installation: SLACK, place: "C0123", repositories }),
      ).rejects.toMatchObject({ statusCode: 400 })
    await expect(
      setMapping(world.ctx(), { account: A.id, installation: SLACK, place: "C0 123", repositories: [] }),
    ).rejects.toMatchObject({ statusCode: 400 })
  })

  test("only the connector removes a mapping", async () => {
    const world = new World()
    await world.install(SLACK, A.id)
    await setMapping(world.ctx(), {
      account: A.id,
      installation: SLACK,
      place: "C0123",
      repositories: [repo("acme/api")],
    })
    expect(await removeMapping(world.ctx(), { account: B.id, installation: SLACK, place: "C0123" })).toEqual({
      ok: false,
      code: "not-connector",
    })
    expect(await removeMapping(world.ctx(), { account: A.id, installation: SLACK, place: "C0123" })).toEqual({
      ok: true,
      removed: true,
    })
    expect(await listMappings(world.store, SLACK)).toEqual([])
    expect(world.fake.read(everywhereKeys.repos(SLACK))).toBeUndefined()
  })
})

describe("OAuth states", () => {
  test("a state works once, for 10 minutes, and carries only ids", async () => {
    const world = new World()
    const started = await createState(world.ctx(), {
      account: A.id,
      platform: "slack",
      purpose: "install",
      installation: SLACK,
    })
    expect(started.state).toMatch(/^[A-Za-z0-9_-]{32}$/)
    expect(world.dump()).not.toContain(A.email)
    expect(await takeState(world.store, started.state)).toEqual({
      account: A.id,
      platform: "slack",
      purpose: "install",
      installation: SLACK,
      issuedAt: world.fake.clock.now,
    })
    expect(await takeState(world.store, started.state)).toBeUndefined()
    const late = await createState(world.ctx(), { account: A.id, platform: "linear", purpose: "link" })
    world.fake.clock.advance(600_001)
    expect(await takeState(world.store, late.state)).toBeUndefined()
    expect(await takeState(world.store, "short")).toBeUndefined()
    expect(await takeState(world.store, "x".repeat(40) + "/")).toBeUndefined()
  })

  test("authorize URLs carry the client id, the fixed scopes and redirect, and the state", () => {
    const config = readConfig(everywhereEnv())
    const slack = new URL(oauthUrl(config, { platform: "slack", purpose: "install", state: "s".repeat(32) })!)
    expect(slack.origin + slack.pathname).toBe("https://slack.com/oauth/v2/authorize")
    expect(slack.searchParams.get("client_id")).toBe("1234.5678")
    expect(slack.searchParams.get("redirect_uri")).toBe("https://vectordev.ai/api/slack/oauth")
    expect(slack.searchParams.get("scope")?.split(",")).not.toContain("reactions:write")
    expect(slack.searchParams.get("state")).toBe("s".repeat(32))
    const install = new URL(oauthUrl(config, { platform: "linear", purpose: "install", state: "s".repeat(32) })!)
    expect(install.searchParams.get("actor")).toBe("app")
    expect(install.searchParams.get("scope")).toBe("read,write,app:assignable,app:mentionable")
    const link = new URL(oauthUrl(config, { platform: "linear", purpose: "link", state: "s".repeat(32) })!)
    expect(link.searchParams.get("actor")).toBe("user")
    expect(link.searchParams.get("scope")).toBe("read")
    expect(oauthUrl(config, { platform: "slack", purpose: "link", state: "s".repeat(32) })).toBeUndefined()
    expect(oauthUrl(config, { platform: "jira", purpose: "install", state: "s".repeat(32) })).toBeUndefined()
    expect(oauthUrl(readConfig({}), { platform: "slack", purpose: "install", state: "s".repeat(32) })).toBeUndefined()
  })
})

describe.skipIf(!process.env.VECTOR_TEST_REDIS_URL)("against a real Redis", () => {
  let redis: RealRedis
  beforeAll(async () => {
    redis = (await realRedis())!
  })
  afterAll(async () => {
    await redis?.close()
  })

  test("twelve people sending one code at once: exactly one is linked", async () => {
    const store = testEverywhereStore(redis.fetch)
    const ctx: IdentityContext = { store, keys, now: Date.now() }
    const installation = `slack:T${randomBytes(5).toString("hex").toUpperCase()}`
    const account = randomUUID()
    await recordInstall(ctx, {
      account,
      event: "install",
      grant: { installation, scopes: [], installer: { admin: false } },
    })
    const { code } = await issueLinkCode(ctx, { account, platform: "slack" })
    const users = Array.from({ length: 12 }, (_, index) => `U${String(index).padStart(8, "0")}`)
    const answers = await Promise.all(users.map((userId) => redeemLinkCode(ctx, dm(code, installation, userId))))
    expect(answers.filter((answer) => answer.ok)).toHaveLength(1)
    await eraseInstallation({ store, now: Date.now() }, installation, "disconnected")
    await store(["DEL", everywhereKeys.audit(account), everywhereKeys.installs(account), everywhereKeys.links(account)])
    for (const userId of users) await store(["DEL", everywhereKeys.linkTries(installation, userId)])
  })

  test("two accounts installing one place at once: exactly one becomes its connector", async () => {
    const store = testEverywhereStore(redis.fetch)
    const ctx: IdentityContext = { store, keys, now: Date.now() }
    const installation = `slack:T${randomBytes(5).toString("hex").toUpperCase()}`
    const accounts = [randomUUID(), randomUUID()]
    const answers = await Promise.all(
      accounts.map((account) =>
        recordInstall(ctx, {
          account,
          event: "install",
          grant: { installation, scopes: [], installer: { admin: false } },
        }),
      ),
    )
    expect(answers.filter((answer) => answer.ok)).toHaveLength(1)
    const winner = accounts[answers.findIndex((answer) => answer.ok)]!
    expect(await findInstall(store, installation)).toMatchObject({ connector: winner })
    await eraseInstallation({ store, now: Date.now() }, installation, "disconnected")
    for (const account of accounts)
      await store(["DEL", everywhereKeys.audit(account), everywhereKeys.installs(account)])
  })
})
