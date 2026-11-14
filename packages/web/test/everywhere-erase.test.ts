import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test"
import { randomBytes, randomUUID } from "node:crypto"
import { readAudit } from "../../../api/_lib/everywhere/audit"
import { dataKey } from "../../../api/_lib/everywhere/crypto"
import {
  EVERYWHERE_ERASE_PART,
  eraseEverywhereAccount,
  eraseInstallation,
  everywhereStoreConfigured,
  type EraseContext,
  type EraseReason,
  type JobEraser,
} from "../../../api/_lib/everywhere/erase"
import {
  findInstall, readInstallState,
  findLink,
  findMapping,
  issueLinkCode,
  linkBySignIn,
  listInstalls,
  listLinks,
  recordInstall,
  redeemLinkCode,
  setMapping,
  type IdentityContext,
  type LinkActor,
} from "../../../api/_lib/everywhere/identity"
import { createJob, readJob, readJobBody } from "../../../api/_lib/everywhere/jobs"
import { everywhereKeys } from "../../../api/_lib/everywhere/keys"
import { type Store } from "../../../api/_lib/everywhere/store"
import { installFetchGuard } from "./lib/everywhere-fetch-guard"
import { FakeStore, useKv, testEverywhereStore, testAccountAuthority } from "./lib/everywhere-store"

installFetchGuard()

/*
 * VE-04 and E13: erasing. Uninstall, revoked tokens, Linear's revocation and a disconnect remove an installation, its
 * token, its links, its mappings and its live jobs; account deletion removes everything Vector everywhere keeps for an
 * account, and nothing of anyone else's.
 */

let restore: () => void
beforeAll(() => {
  restore = useKv()
})
afterAll(() => restore())

const keys = [dataKey(randomBytes(32))]
const person: LinkActor = { bot: false, external: false, guest: false }
const A = randomUUID()
const B = randomUUID()
const SLACK = "slack:T0123ABCD"
const LINEAR = `linear:${randomUUID()}`
const JIRA = `jira:${randomUUID()}`
const VIEWER = randomUUID()
const JIRA_USER = `557058:${randomUUID()}`

let fake: FakeStore
let store: Store
let erasedJobs: { installations: string[]; accounts: string[] }
const jobs: JobEraser = {
  installation: async (installation) => {
    erasedJobs.installations.push(installation)
  },
  account: async (account) => {
    erasedJobs.accounts.push(account)
  },
}

function ctx(): IdentityContext {
  return { store, keys, now: fake.clock.now, accountAuthority: testAccountAuthority }
}

function eraseCtx(extra: Partial<EraseContext> = {}): EraseContext {
  return { store, now: fake.clock.now, jobs, accountAuthority: testAccountAuthority, ...extra }
}

async function link(account: string, installation: string, userId: string) {
  const platform = installation.startsWith("jira:") ? "jira" : "slack"
  const { code } = await issueLinkCode(ctx(), { account, platform })
  const verdict = await redeemLinkCode(ctx(), { code, installation, userId, place: "private", actor: person })
  expect(verdict.ok).toBe(true)
}

/**
 * A connects Slack (with a token) and Linear; B connects a Jira site. On Slack, U1 is A and U2 is B; on Linear the
 * viewer is A; on Jira a user is A. Slack has two mapped channels and Linear one team. A has a live link code.
 */
async function world() {
  const install = (installation: string, account: string, token?: string) =>
    recordInstall(ctx(), {
      account,
      event: "install",
      grant: { installation, scopes: [], ...(token ? { token } : {}), installer: { admin: true } },
    })
  await install(SLACK, A, `xoxb-${randomBytes(12).toString("hex")}`)
  await install(LINEAR, A, `lin_oauth_${randomBytes(12).toString("hex")}`)
  await install(JIRA, B)
  await link(A, SLACK, "U0AAA1111")
  await link(B, SLACK, "U0BBB2222")
  await linkBySignIn(ctx(), { account: A, installation: LINEAR, userId: VIEWER, actor: person })
  await link(A, JIRA, JIRA_USER)
  for (const place of ["C0001", "C0002"])
    await setMapping(ctx(), { account: A, installation: SLACK, place, repositories: [{ fullName: "acme/api", id: 1 }] })
  await setMapping(ctx(), { account: A, installation: LINEAR, place: VIEWER, repositories: [{ fullName: "acme/web", id: 8 }] })
  await setMapping(ctx(), { account: B, installation: JIRA, place: "PROJ", repositories: [{ fullName: "bob/tool", id: 9 }] })
  const live = await issueLinkCode(ctx(), { account: A, platform: "slack" })
  return { liveCode: live.code }
}

beforeEach(() => {
  fake = new FakeStore()
  store = testEverywhereStore(fake.fetch)
  erasedJobs = { installations: [], accounts: [] }
})

describe("erasing an installation", () => {
  test("uninstall removes the record and token, every link, every mapping and the live jobs", async () => {
    await world()
    const result = await eraseInstallation(eraseCtx(), SLACK, "uninstalled")
    expect(result).toEqual({ installed: true, links: 2, mappings: 2 })
    expect(await findInstall(store, SLACK)).toBeUndefined()
    expect(await findLink(store, SLACK, "U0AAA1111")).toBeUndefined()
    expect(await findLink(store, SLACK, "U0BBB2222")).toBeUndefined()
    expect(await findMapping(store, SLACK, "C0001")).toBeUndefined()
    expect(await findMapping(store, SLACK, "C0002")).toBeUndefined()
    for (const key of [everywhereKeys.install(SLACK), everywhereKeys.linked(SLACK), everywhereKeys.repos(SLACK)])
      expect(fake.read(key)).toBeUndefined()
    expect([...fake.data.keys()].filter((key) => key.includes("T0123ABCD") && !key.includes(":audit:"))).toEqual([everywhereKeys.installEpoch(SLACK)])
    expect(fake.read(everywhereKeys.installEpoch(SLACK))).toEqual({ kind: "string", value: expect.stringMatching(/^[A-Za-z0-9_-]{22}$/) })
    expect(fake.pttl(everywhereKeys.installEpoch(SLACK))).toBe(-1)
    // Once with the record and once more after it went, for anything started in between.
    expect(new Set(erasedJobs.installations)).toEqual(new Set([SLACK]))
    expect((await listInstalls(store, A)).map((item) => item.installation)).toEqual([LINEAR])
    expect((await listLinks(store, A)).map((item) => item.installation).sort()).toEqual([JIRA, LINEAR].sort())
    expect(await listLinks(store, B)).toEqual([])
    expect(await readAudit(store, A)).toContainEqual(
      expect.objectContaining({ event: "uninstall", installation: SLACK, code: "uninstalled" }),
    )
    expect(await readAudit(store, B)).toContainEqual(
      expect.objectContaining({ event: "unlink", installation: SLACK, userId: "U0BBB2222", code: "uninstalled" }),
    )
    // Other installations are untouched.
    expect(await findInstall(store, LINEAR)).toMatchObject({ connector: A })
    expect(await findLink(store, JIRA, JIRA_USER)).toMatchObject({ account: A })
    expect(await findMapping(store, JIRA, "PROJ")).toBeDefined()
  })

  test("each reason is recorded with its own event", async () => {
    const cases: [EraseReason, string][] = [
      ["uninstalled", "uninstall"],
      ["tokens-revoked", "uninstall"],
      ["revoked", "uninstall"],
      ["disconnected", "disconnect"],
    ]
    for (const [reason, event] of cases) {
      fake = new FakeStore()
      store = testEverywhereStore(fake.fetch)
      await world()
      await eraseInstallation(eraseCtx(), LINEAR, reason)
      expect(await findInstall(store, LINEAR)).toBeUndefined()
      expect(await findLink(store, LINEAR, VIEWER)).toBeUndefined()
      expect(await findMapping(store, LINEAR, VIEWER)).toBeUndefined()
      expect(await readAudit(store, A)).toContainEqual(
        expect.objectContaining({ event, installation: LINEAR, code: reason }),
      )
    }
  })

  test("a second erase finds nothing, and an unknown installation is fine", async () => {
    await world()
    await eraseInstallation(eraseCtx(), SLACK, "uninstalled")
    expect(await eraseInstallation(eraseCtx(), SLACK, "uninstalled")).toEqual({
      installed: false,
      links: 0,
      mappings: 0,
    })
    expect(await eraseInstallation(eraseCtx(), "slack:T0NOBODY1", "tokens-revoked")).toEqual({
      installed: false,
      links: 0,
      mappings: 0,
    })
  })

  test("a failing native revoke erases local contents and credentials but retains an uncertain closing barrier", async () => {
    await world()
    const seen: string[] = []
    await eraseInstallation(
      eraseCtx({
        revoke: async (installation, record) => {
          seen.push(`${installation}:${record.connector}:${record.tokenEnc ? "token" : "none"}`)
          throw new Error("platform down")
        },
      }),
      SLACK,
      "disconnected",
    )
    expect(seen).toEqual([`${SLACK}:${A}:token`])
    expect(await findInstall(store, SLACK)).toBeUndefined()
    const marker = (await readInstallState(store, SLACK))!
    expect(marker.record.closing?.revocation).toBe("uncertain")
    expect(marker.record.tokenEnc).toBeUndefined()
    expect(marker.record.scopes).toEqual([])
    expect(await findLink(store, SLACK, "U0BBB2222")).toBeUndefined()
    expect(await findMapping(store, SLACK, "C0001")).toBeUndefined()
  })

  test("a step that fails leaves the record, so the erase can run again and finish", async () => {
    await world()
    let failures = 1
    const flaky: JobEraser = {
      ...jobs,
      installation: async (installation) => {
        if (failures-- > 0) throw new Error("store busy")
        erasedJobs.installations.push(installation)
      },
    }
    await expect(eraseInstallation(eraseCtx({ jobs: flaky }), SLACK, "disconnected")).rejects.toThrow()
    // Cleanup is resumable, but the durable closing record refuses all ordinary new work.
    expect(await findInstall(store, SLACK)).toBeUndefined()
    expect((await readInstallState(store, SLACK))?.record).toMatchObject({ connector: A, closing: { reason: "disconnected" } })
    expect((await listInstalls(store, A)).find((item) => item.installation === SLACK)).toMatchObject({ status: "closing", nextAction: "retry-disconnect" })
    expect(await findLink(store, SLACK, "U0BBB2222")).toBeDefined()
    expect(await findMapping(store, SLACK, "C0001")).toBeDefined()
    expect(await eraseInstallation(eraseCtx({ jobs: flaky }), SLACK, "disconnected")).toEqual({
      installed: true,
      links: 2,
      mappings: 2,
    })
    expect(await findInstall(store, SLACK)).toBeUndefined()
    expect(await findLink(store, SLACK, "U0BBB2222")).toBeUndefined()
    expect(await findMapping(store, SLACK, "C0001")).toBeUndefined()
    expect(erasedJobs.installations).toContain(SLACK)
  })

  test("a redemption awaiting cleanup cannot recreate a link after the installation closes", async () => {
    await world()
    const issued = await issueLinkCode(ctx(), { account: B, platform: "slack", installation: SLACK })
    const inner = store
    let checked = false
    const watching: Store = async (command) => {
      const result = await inner(command)
      if (!checked && command[0] === "EVAL" && command.some((part) => typeof part === "string" && part.includes(JSON.stringify(["DEL", everywhereKeys.repos(SLACK)])))) {
        checked = true
        expect(await redeemLinkCode({ ...ctx(), store: inner }, { installation: SLACK, userId: "U0CCC3333", code: issued.code,
          place: "private", actor: { bot: false, external: false, guest: false } })).toEqual({ ok: false, code: "not-connected" })
      }
      return result
    }
    const result = await eraseInstallation({ ...eraseCtx(), store: watching }, SLACK, "uninstalled")
    expect(checked).toBe(true)
    expect(result).toEqual({ installed: true, links: 2, mappings: 2 })
    expect(await findLink(store, SLACK, "U0CCC3333")).toBeUndefined()
    expect(fake.read(everywhereKeys.linked(SLACK))).toBeUndefined()
  })

  test("erase needs no data key: it works while the feature's keys are gone", async () => {
    await world()
    const keyless: EraseContext = { store, now: fake.clock.now }
    expect((await eraseInstallation(keyless, SLACK, "uninstalled")).installed).toBe(true)
  })
})

describe("erasing an account", () => {
  test("everything kept for the account goes: installations, links, the live code, jobs and its audit log", async () => {
    const { liveCode } = await world()
    await eraseEverywhereAccount(eraseCtx(), A)
    // The installations A connected, with everyone's links and the mappings on them.
    for (const installation of [SLACK, LINEAR]) expect(await findInstall(store, installation)).toBeUndefined()
    expect(await findLink(store, SLACK, "U0BBB2222")).toBeUndefined()
    expect(await findMapping(store, SLACK, "C0001")).toBeUndefined()
    expect(await findMapping(store, LINEAR, VIEWER)).toBeUndefined()
    // A's link on B's site, and that site's index entry.
    expect(await findLink(store, JIRA, JIRA_USER)).toBeUndefined()
    expect(fake.read(everywhereKeys.linked(JIRA))).toBeUndefined()
    // The live code no longer works.
    expect(
      await redeemLinkCode(ctx(), {
        code: liveCode,
        installation: JIRA,
        userId: JIRA_USER,
        place: "private",
        actor: person,
      }),
    ).toEqual({ ok: false, code: "link-invalid" })
    expect(erasedJobs.accounts).toEqual([A.toLowerCase()])
    expect(new Set(erasedJobs.installations)).toEqual(new Set([LINEAR, SLACK]))
    // Only the minimal permanent deletion marker remains; it prevents delayed writers from recreating data.
    expect([...fake.data.keys()].filter((key) => key.includes(A.toLowerCase()))).toEqual([everywhereKeys.accountClosed(A)])
    expect(fake.read(everywhereKeys.accountClosed(A))).toEqual({ kind: "string", value: "closed" })
    expect(fake.pttl(everywhereKeys.accountClosed(A))).toBe(-1)
    expect(await readAudit(store, A)).toEqual([])
  })

  test("other accounts keep their own records, and their logs say why a link went", async () => {
    await world()
    await eraseEverywhereAccount(eraseCtx(), A)
    expect(await findInstall(store, JIRA)).toMatchObject({ connector: B })
    expect(await findMapping(store, JIRA, "PROJ")).toMatchObject({ setBy: B })
    expect((await listInstalls(store, B)).map((item) => item.installation)).toEqual([JIRA])
    expect(await readAudit(store, B)).toContainEqual(
      expect.objectContaining({ event: "unlink", installation: SLACK, userId: "U0BBB2222", code: "account-deleted" }),
    )
  })

  test("the erase part has the shape Codium's account deletion calls: configured(), then erase(account, context)", async () => {
    expect(EVERYWHERE_ERASE_PART.id).toBe("everywhere")
    // Configured whenever the store exists, whether or not the feature is on, so data left from before is erased.
    expect(
      everywhereStoreConfigured({ KV_REST_API_URL: "https://kv.example", KV_REST_API_TOKEN: "t".repeat(24) }),
    ).toBe(true)
    expect(
      everywhereStoreConfigured({ UPSTASH_REDIS_REST_URL: "https://kv.example", UPSTASH_REDIS_REST_TOKEN: "x" }),
    ).toBe(true)
    expect(everywhereStoreConfigured({ KV_REST_API_URL: "https://kv.example" })).toBe(false)
    expect(everywhereStoreConfigured({})).toBe(false)
    expect(EVERYWHERE_ERASE_PART.configured()).toBe(true)

    // A stand-in for Codium's loop (codium-erase.ts): skip a part that is not configured, else erase with the
    // deletion's own fetcher and clock.
    type CodiumPart = {
      readonly id: string
      readonly configured: () => boolean
      readonly requires?: readonly string[]
      readonly erase: (
        account: string,
        context: { fetcher: typeof fetch; now: number; deadline?: number },
      ) => Promise<unknown>
    }
    const part: CodiumPart = EVERYWHERE_ERASE_PART
    await world()
    const created = await createJob(ctx(), { platform: "slack", installation: SLACK, kind: "mention", sponsor: B,
      requester: { userId: "U0BBB2222", account: B }, repository: { id: 1, fullName: "acme/api", shared: false },
      shared: false, task: "The teammate's private task", context: [] })
    if (!created.ok) throw new Error("Fixture foreign-sponsored job missing")
    expect((await readJobBody(ctx(), created.job.jid))?.task).toBe("The teammate's private task")
    const auditBefore = await readAudit(store, B)
    fake.clock.advance(60_000)
    if (part.configured())
      await part.erase(A, { fetcher: fake.fetch, now: fake.clock.now, deadline: Date.now() + 30_000 })
    for (const installation of [SLACK, LINEAR]) expect(await findInstall(store, installation)).toBeUndefined()
    expect(await findLink(store, JIRA, JIRA_USER)).toBeUndefined()
    expect([...fake.data.keys()].filter((key) => key.includes(A.toLowerCase()))).toEqual([everywhereKeys.accountClosed(A)])
    expect(fake.read(everywhereKeys.accountClosed(A))).toEqual({ kind: "string", value: "closed" })
    expect(fake.pttl(everywhereKeys.accountClosed(A))).toBe(-1)
    // The default part has no active-account adapter: it cannot append to an unverified teammate's audit.
    expect(await readAudit(store, B)).toEqual(auditBefore)
    // Actual job cancellation still uses the deletion's clock and erases bodies without that adapter.
    expect(await readJob(store, created.job.jid)).toMatchObject({ sponsor: B, state: "cancelled", endedAt: fake.clock.now })
    expect(await readJobBody(ctx(), created.job.jid)).toBeUndefined()
  })
})
