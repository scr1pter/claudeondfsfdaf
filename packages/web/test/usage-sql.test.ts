import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test"
import { SQL } from "bun"
import { randomUUID } from "node:crypto"
import {
  createShare,
  forgetUsage,
  listShares,
  openShare,
  recordDownload,
  recordUsage,
  revokeShare,
  usageSummary,
} from "../../../api/_lib/usage"

// Dedicated disposable databases only: these tests execute the real usage SQL through the API code.
const url = new URL(process.env.VECTOR_TEST_POSTGRES_URL ?? "postgres://127.0.0.1/vector_shares_test")
if (!["127.0.0.1", "localhost"].includes(url.hostname) || url.pathname !== "/vector_shares_test")
  throw new Error("Usage SQL tests require a disposable loopback vector_shares_test database")
const database = new SQL(url.href)
const results: unknown[] = []
// Stands in for Supabase's PostgREST: each RPC runs as the service role, exactly as in production.
const upstream = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request): Promise<Response> {
    expect(request.headers.get("authorization")).toBe("Bearer fixture-service-role")
    const name = new URL(request.url).pathname.replace("/rest/v1/rpc/", "")
    const body = (await request.json()) as { request?: Record<string, unknown>; account?: string }
    const json = body.request ?? {}
    const rows = await database
      .begin(async (transaction) => {
        await transaction`set local role service_role`
        if (name === "vector_usage_record")
          return transaction`select public.vector_usage_record(${json}::jsonb) as result`
        if (name === "vector_usage_download")
          return transaction`select public.vector_usage_download(${json}::jsonb) as result`
        if (name === "vector_usage_forget")
          return transaction`select public.vector_usage_forget(${body.account ?? null}::uuid) as result`
        if (name === "vector_usage_summary")
          return transaction`select public.vector_usage_summary(${json}::jsonb) as result`
        if (name === "vector_usage_share_create")
          return transaction`select public.vector_usage_share_create(${json}::jsonb) as result`
        if (name === "vector_usage_share_list")
          return transaction`select public.vector_usage_share_list(${json}::jsonb) as result`
        if (name === "vector_usage_share_revoke")
          return transaction`select public.vector_usage_share_revoke(${json}::jsonb) as result`
        if (name === "vector_usage_share_open")
          return transaction`select public.vector_usage_share_open(${json}::jsonb) as result`
        throw new Error(`Unexpected RPC ${name}`)
      })
      .catch((error: unknown) => {
        results.push({ name, error: String(error) })
        return undefined
      })
    if (!rows) return new Response(null, { status: 500 })
    results.push({ name, result: rows[0].result })
    return Response.json(rows[0].result)
  },
})
const keys = ["NODE_ENV", "SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"]
const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]))
const state = { account: "", today: "" }

const report = (extra: Record<string, unknown> = {}) => ({
  lifetimeTokens: 1_000_000,
  lifetimeCost: 12.5,
  inputTokens: 600_000,
  outputTokens: 200_000,
  reasoningTokens: 50_000,
  cachedTokens: 150_000,
  completedChats: 40,
  conversations: 12,
  activeDays: 9,
  currentStreak: 3,
  longestStreak: 5,
  averageTaskMs: 42_000,
  longestTaskMs: 600_000,
  modelResponses: 300,
  days: [] as Array<{ date: string; tokens: number; tasks: number; cost: number }>,
  favoriteModels: [{ providerID: "anthropic", modelID: "claude-sonnet-4-5", tokens: 700_000, percentage: 70 }],
  effortLevels: [{ id: "default", label: "Default", tokens: 1_000_000, responses: 300, percentage: 100 }],
  ...extra,
})

const desktop = (installId: string, extra: Record<string, unknown> = {}) => ({
  client: "desktop" as const,
  installId,
  version: "1.99.105",
  platform: "darwin",
  arch: "arm64",
  sessions: 3,
  subagentSessions: 1,
  ...extra,
})

beforeAll(async () => {
  await database
    .unsafe(
      `
    do $$ begin create role anon; exception when duplicate_object then null; end $$;
    do $$ begin create role authenticated; exception when duplicate_object then null; end $$;
    do $$ begin create role service_role bypassrls; exception when duplicate_object then null; end $$;
    create schema if not exists auth;
    create table if not exists auth.users (id uuid primary key);
    alter table auth.users add column if not exists created_at timestamptz not null default now();
    alter table auth.users add column if not exists email text;
  `,
    )
    .simple()
  const migration = await Bun.file(new URL("../../../docs/vector/owner-actions/sql/usage.sql", import.meta.url)).text()
  // Applying it twice proves the owner can safely re-run it.
  await database.unsafe(migration).simple()
  await database.unsafe(migration).simple()
  Object.assign(process.env, {
    NODE_ENV: "development",
    SUPABASE_URL: upstream.url.origin,
    SUPABASE_SERVICE_ROLE_KEY: "fixture-service-role",
  })
})

beforeEach(async () => {
  results.length = 0
  await database`truncate public.vector_usage_daily, public.vector_usage_downloads, public.vector_usage_tokens, public.vector_usage_shares`
  state.account = randomUUID()
  await database`insert into auth.users(id) values (${state.account})`
  state.today = (await database`select ((now() at time zone 'utc')::date)::text as today`)[0].today
})

afterAll(async () => {
  upstream.stop(true)
  await database.close()
  Object.entries(previous).forEach(([key, value]) => {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  })
})

const day = (offset: number) =>
  new Date(Date.parse(`${state.today}T00:00:00Z`) + offset * 86_400_000).toISOString().slice(0, 10)

const statuses = () =>
  results.map((entry) => {
    const value = entry as { result?: { status?: string }; error?: string }
    return value.result?.status ?? value.error
  })

test("one row per install per day: counts never drop and an account, once known, stays", async () => {
  const install = randomUUID()
  await recordUsage(desktop(install, { accountId: state.account, sessions: 3, subagentSessions: 1 }))
  await recordUsage(desktop(install, { version: "1.99.106", sessions: 2, subagentSessions: 5 }))
  expect(statuses()).toEqual(["ok", "ok"])
  const rows = await database`
    select key, client, day::text as day, account_id::text as account_id, version, platform, arch, sessions, subagent_sessions
    from public.vector_usage_daily`
  expect(rows).toEqual([
    {
      key: `install:${install}`,
      client: "desktop",
      day: state.today,
      account_id: state.account,
      version: "1.99.106",
      platform: "darwin",
      arch: "arm64",
      sessions: 3,
      subagent_sessions: 5,
    },
  ])
})

test("the CLI counts one day per account, and only for an account that exists", async () => {
  const cli = { client: "cli" as const, version: "1.99.105", platform: "linux", arch: "x64" }
  await recordUsage({ ...cli, accountId: state.account })
  await recordUsage({ ...cli, accountId: state.account })
  await recordUsage({ ...cli, accountId: randomUUID() })
  expect(statuses()).toEqual(["ok", "ok", "skipped"])
  const rows = await database`select key, account_id::text as account from public.vector_usage_daily`
  expect(rows).toEqual([{ key: `account:${state.account}`, account: state.account }])
})

test("a deleted account's token still counts the install, without the account", async () => {
  const install = randomUUID()
  await recordUsage(desktop(install, { accountId: randomUUID() }))
  expect(statuses()).toEqual(["ok"])
  const rows = await database`select key, account_id from public.vector_usage_daily`
  expect(rows).toEqual([{ key: `install:${install}`, account_id: null }])
})

test("the database refuses what the API would never send", async () => {
  const install = randomUUID()
  for (const request of [
    desktop("not-a-uuid"),
    desktop(install.toUpperCase()),
    desktop(install, { platform: "freebsd" }),
    desktop(install, { version: "1.2" }),
    desktop(install, { sessions: -1 }),
    desktop(install, { sessions: 1.5 }),
    desktop(install, { subagentSessions: 100_001 }),
    desktop(install, { sessions: "3" }),
    desktop(install, { accountId: "someone" }),
    { client: "cli", version: "1.99.105", platform: "linux", arch: "x64" },
    { client: "server", version: "1.99.105", platform: "linux", arch: "x64", accountId: state.account },
    desktop(install, { usage: { ...report(), prompt: "fix the bug" } }),
    desktop(install, { usage: report({ lifetimeTokens: -1 }) }),
    desktop(install, { usage: report({ lifetimeTokens: 1e12 + 1 }) }),
    desktop(install, { usage: report({ days: [{ date: "2026-10-01", tokens: 1e10 + 1, tasks: 1, cost: 0 }] }) }),
    desktop(install, { usage: report({ days: [{ date: "2026-02-30", tokens: 1, tasks: 1, cost: 0 }] }) }),
    desktop(install, {
      usage: report({
        days: [
          { date: "2026-10-01", tokens: 1, tasks: 1, cost: 0 },
          { date: "2026-10-01", tokens: 2, tasks: 1, cost: 0 },
        ],
      }),
    }),
    desktop(install, {
      usage: report({ favoriteModels: [{ providerID: "p", modelID: "my model", tokens: 1, percentage: 1 }] }),
    }),
    ...["/Users/someone/models/qwen.gguf", "./qwen.gguf", "C:/models/qwen.gguf", "srv/home/someone/qwen.gguf"].map(
      (modelID) =>
        desktop(install, {
          usage: report({ favoriteModels: [{ providerID: "llamacpp", modelID, tokens: 1, percentage: 1 }] }),
        }),
    ),
  ])
    await recordUsage(request as Parameters<typeof recordUsage>[0])
  expect(statuses()).toEqual([...Array(9).fill("invalid"), "skipped", ...Array(12).fill("invalid")])
  expect((await database`select count(*)::int as count from public.vector_usage_daily`)[0].count).toBe(0)
})

test("recording removes days older than 400, and downloads older than 400 days", async () => {
  const old = randomUUID()
  await database`
    insert into public.vector_usage_daily (key, client, day, version, platform, arch)
    values (${`install:${old}`}, 'desktop', (now() at time zone 'utc')::date - 401, '1.0.0', 'linux', 'x64'),
           (${`install:${old}`}, 'desktop', (now() at time zone 'utc')::date - 399, '1.0.0', 'linux', 'x64')`
  await database`
    insert into public.vector_usage_downloads (account_id, target, version, created_at)
    values (${state.account}, 'linux-x64', '1.0.0', now() - interval '401 days')`
  await recordUsage(desktop(randomUUID()))
  await recordDownload({ accountId: state.account, target: "mac-arm64", version: "1.99.105" })
  expect(statuses()).toEqual(["ok", "ok"])
  expect(
    (await database`select count(*)::int as count from public.vector_usage_daily where key = ${`install:${old}`}`)[0]
      .count,
  ).toBe(1)
  const downloads = await database`select target from public.vector_usage_downloads`
  expect(downloads).toEqual([{ target: "mac-arm64" }])
})

test("forgetting an account removes its CLI days, every day of a linked install, and its downloads", async () => {
  const linked = randomUUID()
  const stranger = randomUUID()
  await database`
    insert into public.vector_usage_daily (key, client, day, version, platform, arch)
    values (${`install:${linked}`}, 'desktop', (now() at time zone 'utc')::date - 3, '1.99.100', 'darwin', 'arm64')`
  await recordUsage(desktop(linked, { accountId: state.account }))
  await recordUsage({ client: "cli", accountId: state.account, version: "1.99.105", platform: "linux", arch: "x64" })
  await recordUsage(desktop(stranger))
  await recordDownload({ accountId: state.account, target: "mac-arm64", version: "1.99.105" })
  expect(await forgetUsage(state.account)).toBe(true)
  const rows = await database`select key from public.vector_usage_daily`
  expect(rows).toEqual([{ key: `install:${stranger}` }])
  expect((await database`select count(*)::int as count from public.vector_usage_downloads`)[0].count).toBe(0)
})

test("deleting an identity elsewhere also removes its linked rows", async () => {
  await recordUsage({ client: "cli", accountId: state.account, version: "1.99.105", platform: "linux", arch: "x64" })
  await recordDownload({ accountId: state.account, target: "mac-arm64", version: "1.99.105" })
  await database`delete from auth.users where id = ${state.account}`
  expect((await database`select count(*)::int as count from public.vector_usage_daily`)[0].count).toBe(0)
  expect((await database`select count(*)::int as count from public.vector_usage_downloads`)[0].count).toBe(0)
})

test("a usage report keeps each day's largest values and the report with the most lifetime tokens", async () => {
  const install = randomUUID()
  await recordUsage(
    desktop(install, {
      accountId: state.account,
      usage: report({
        days: [
          { date: day(-1), tokens: 200, tasks: 3, cost: 1.25 },
          { date: day(0), tokens: 300, tasks: 4, cost: 2 },
        ],
      }),
    }),
  )
  await recordUsage(
    desktop(install, {
      accountId: state.account,
      usage: report({ lifetimeTokens: 900_000, days: [{ date: day(0), tokens: 250, tasks: 6, cost: 1 }] }),
    }),
  )
  // Too old for retention and too far ahead of UTC: skipped, not refused.
  await recordUsage(
    desktop(install, {
      accountId: state.account,
      usage: report({
        days: [
          { date: day(-401), tokens: 1, tasks: 1, cost: 0 },
          { date: day(3), tokens: 1, tasks: 1, cost: 0 },
        ],
      }),
    }),
  )
  expect(statuses()).toEqual(["ok", "ok", "ok"])
  const days = await database`
    select day::text as day, tokens::int as tokens, tasks, cost::float as cost, account_id::text as account
    from public.vector_usage_tokens order by day`
  expect(days).toEqual([
    { day: day(-1), tokens: 200, tasks: 3, cost: 1.25, account: state.account },
    { day: state.today, tokens: 300, tasks: 6, cost: 2, account: state.account },
  ])
  const stored = await database`select usage from public.vector_usage_daily`
  expect(stored[0].usage.lifetimeTokens).toBe(1_000_000)
  expect(stored[0].usage.days).toBeUndefined()
})

test("the CLI reports through one row per account per day", async () => {
  const cli = { client: "cli" as const, accountId: state.account, version: "1.99.106", platform: "linux", arch: "x64" }
  await recordUsage(cli)
  await recordUsage({
    ...cli,
    usage: report({ lifetimeTokens: 250_000, days: [{ date: day(0), tokens: 50, tasks: 1, cost: 0 }] }),
  })
  await recordUsage({
    ...cli,
    usage: report({ lifetimeTokens: 10, days: [{ date: day(0), tokens: 5, tasks: 1, cost: 0 }] }),
  })
  expect(statuses()).toEqual(["ok", "ok", "ok"])
  const rows = await database`select key, (usage->>'lifetimeTokens')::int as lifetime from public.vector_usage_daily`
  expect(rows).toEqual([{ key: `account:${state.account}`, lifetime: 250_000 }])
  const days = await database`select tokens::int as tokens from public.vector_usage_tokens`
  expect(days).toEqual([{ tokens: 50 }])
})

test("model use is kept only with an account that exists", async () => {
  const anonymous = randomUUID()
  const deleted = randomUUID()
  const usage = report({ days: [{ date: day(0), tokens: 9, tasks: 1, cost: 0 }] })
  await recordUsage(desktop(anonymous, { usage }))
  await recordUsage(desktop(deleted, { accountId: randomUUID(), usage }))
  expect(statuses()).toEqual(["ok", "ok"])
  // Both still count as active installs, without their reports.
  const rows = await database`select key, usage from public.vector_usage_daily order by key`
  expect(rows).toEqual([`install:${anonymous}`, `install:${deleted}`].sort().map((key) => ({ key, usage: null })))
  expect((await database`select count(*)::int as count from public.vector_usage_tokens`)[0].count).toBe(0)
  expect((await usageSummary()).usage).toMatchObject({ reporting: 0, lifetimeTokens: 0 })
})

test("a CLI account keeps the largest report any of its computers sent", async () => {
  const cli = { client: "cli" as const, accountId: state.account, version: "1.99.106", platform: "linux", arch: "x64" }
  // A laptop with a long history reported yesterday; a fresh second computer reports today with far less.
  await recordUsage({ ...cli, usage: report({ lifetimeTokens: 500_000_000, currentStreak: 5 }) })
  await database`update public.vector_usage_daily set day = day - 1`
  await recordUsage({ ...cli, usage: report({ lifetimeTokens: 1_000_000, currentStreak: 1 }) })
  expect(statuses()).toEqual(["ok", "ok"])

  const summary = await usageSummary()
  expect(summary.usage).toMatchObject({ reporting: 1, lifetimeTokens: 500_000_000 })
  expect(summary.streaks).toEqual({ one: 0, twoToSix: 1, sevenPlus: 0 })
})

test("forgetting an account also removes its per-day tokens", async () => {
  const linked = randomUUID()
  await recordUsage(
    desktop(linked, {
      accountId: state.account,
      usage: report({ days: [{ date: day(-2), tokens: 9, tasks: 1, cost: 0 }] }),
    }),
  )
  await recordUsage({
    client: "cli",
    accountId: state.account,
    version: "1.99.106",
    platform: "linux",
    arch: "x64",
    usage: report({ days: [{ date: day(0), tokens: 1, tasks: 1, cost: 0 }] }),
  })
  expect(await forgetUsage(state.account)).toBe(true)
  expect((await database`select count(*)::int as count from public.vector_usage_tokens`)[0].count).toBe(0)
})

test("share links: made once, opened by hash, expire and are revoked", async () => {
  const created = await createShare({ label: " Seed round ", days: 7 })
  expect(created.token).toMatch(/^[A-Za-z0-9_-]{43}$/)
  expect(created.share).toMatchObject({ label: "Seed round", state: "active", views: 0, revokedAt: null })
  const stored = await database`select token_hash from public.vector_usage_shares`
  expect(stored[0].token_hash).toMatch(/^[0-9a-f]{64}$/)
  expect(JSON.stringify(stored)).not.toContain(created.token)

  expect(await openShare(created.token)).toEqual({ expiresAt: created.share.expiresAt })
  expect((await listShares())[0]).toMatchObject({ views: 1, state: "active" })
  await expect(openShare("A".repeat(43))).rejects.toMatchObject({ code: "SHARE_NOT_FOUND" })

  await database`update public.vector_usage_shares set created_at = now() - interval '8 days', expires_at = now() - interval '1 day'`
  await expect(openShare(created.token)).rejects.toMatchObject({ code: "SHARE_EXPIRED" })

  const other = await createShare({ label: "Partner", days: 30 })
  await revokeShare(other.share.id)
  await expect(openShare(other.token)).rejects.toMatchObject({ code: "SHARE_REVOKED" })
  await expect(revokeShare(randomUUID())).rejects.toMatchObject({ code: "SHARE_NOT_FOUND" })
  expect((await listShares()).map((share) => share.state)).toEqual(["revoked", "expired"])
})

test("the summary counts people once across desktop and CLI, by day, week and cohort", async () => {
  const signedIn = randomUUID()
  const anonymous = randomUUID()
  // Last week this install was not signed in yet; today it is, so both days belong to one person.
  await database`
    insert into public.vector_usage_daily (key, client, day, version, platform, arch, sessions)
    values (${`install:${signedIn}`}, 'desktop', (now() at time zone 'utc')::date - 7, '1.99.100', 'darwin', 'arm64', 9)`
  await recordUsage(desktop(signedIn, { accountId: state.account, sessions: 4, subagentSessions: 2 }))
  await recordUsage({ client: "cli", accountId: state.account, version: "1.99.105", platform: "linux", arch: "arm64" })
  await recordUsage(desktop(anonymous, { platform: "linux", arch: "x64", sessions: 1, subagentSessions: 0 }))
  await recordDownload({ accountId: state.account, target: "mac-arm64", version: "1.99.105" })
  expect(statuses()).toEqual(["ok", "ok", "ok", "ok"])
  const accounts = (await database`select count(*)::int as count from auth.users`)[0].count

  const summary = await usageSummary()
  expect(summary.today).toBe(state.today)
  expect(summary.generatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/)
  expect(summary.totals).toEqual({
    accounts,
    installs: 2,
    cliAccounts: 1,
    downloads: 1,
    downloadAccounts: 1,
    activeToday: 2,
    active7: 2,
    previous7: 1,
    active30: 2,
    sessions7: 5,
    subagentSessions7: 2,
  })
  expect(summary.daily).toHaveLength(90)
  expect(summary.daily.at(-1)).toEqual({
    day: state.today,
    active: 2,
    desktop: 2,
    cli: 1,
    sessions: 5,
    subagentSessions: 2,
    tokens: 0,
    cost: 0,
    tasks: 0,
  })
  expect(summary.daily.at(-8)).toMatchObject({ active: 1, desktop: 1, cli: 0, sessions: 9 })
  expect(summary.daily.slice(0, -8).every((day) => day.active === 0)).toBe(true)

  expect(summary.weekly).toHaveLength(26)
  expect(summary.weekly.at(-1)).toMatchObject({ active: 2, desktop: 2, cli: 1, growth: 1 })
  expect(summary.weekly.at(-2)).toMatchObject({ active: 1, desktop: 1, cli: 0, growth: null })
  expect(summary.monthly).toHaveLength(12)

  expect(summary.retention).toHaveLength(12)
  const lastWeek = summary.weekly.at(-2)?.week
  const thisWeek = summary.weekly.at(-1)?.week
  expect(summary.retention.find((cohort) => cohort.cohort === lastWeek)).toMatchObject({
    size: 1,
    weeks: [null, null, null, null],
  })
  expect(summary.retention.find((cohort) => cohort.cohort === thisWeek)).toMatchObject({ size: 1 })

  expect(summary.funnel).toHaveLength(12)
  expect(summary.funnel.at(-1)).toMatchObject({ week: thisWeek, downloaded: 1, active: 1 })
  expect(summary.funnel.at(-1)?.signups).toBeGreaterThanOrEqual(1)

  expect(summary.versions).toEqual([
    { client: "desktop", version: "1.99.105", active: 2 },
    { client: "cli", version: "1.99.105", active: 1 },
  ])
  expect(summary.platforms).toEqual([
    { client: "cli", platform: "linux", arch: "arm64", active: 1 },
    { client: "desktop", platform: "darwin", arch: "arm64", active: 1 },
    { client: "desktop", platform: "linux", arch: "x64", active: 1 },
  ])
})

test("the summary leaves out the dashboard owners' own use, from before and after they signed in", async () => {
  const owner = randomUUID()
  const ownerInstall = randomUUID()
  const other = randomUUID()
  const admins = process.env.VECTOR_ADMIN_EMAILS
  await database`insert into auth.users(id, email) values (${owner}, 'owner@vector.test')`
  try {
    // The owner used this install before signing in on it: those days are the owner's too.
    await database`
      insert into public.vector_usage_daily (key, client, day, version, platform, arch, sessions)
      values (${`install:${ownerInstall}`}, 'desktop', (now() at time zone 'utc')::date - 3, '1.99.100', 'darwin', 'arm64', 9)`
    await recordUsage(
      desktop(ownerInstall, {
        accountId: owner,
        usage: report({ days: [{ date: day(0), tokens: 500, tasks: 2, cost: 1 }] }),
      }),
    )
    await recordUsage({
      client: "cli",
      accountId: owner,
      version: "1.99.106",
      platform: "linux",
      arch: "x64",
      usage: report({ days: [{ date: day(0), tokens: 700, tasks: 1, cost: 2 }] }),
    })
    await recordDownload({ accountId: owner, target: "mac-arm64", version: "1.99.105" })
    await recordUsage(
      desktop(other, {
        accountId: state.account,
        sessions: 2,
        subagentSessions: 0,
        usage: report({ days: [{ date: day(0), tokens: 40, tasks: 1, cost: 0.5 }] }),
      }),
    )
    await recordDownload({ accountId: state.account, target: "windows-x64", version: "1.99.105" })

    process.env.VECTOR_ADMIN_EMAILS = "nobody@vector.test"
    const everyone = await usageSummary()
    // Matched however the owner's address is written.
    process.env.VECTOR_ADMIN_EMAILS = "Owner@Vector.test"
    const summary = await usageSummary()

    expect(everyone.totals).toMatchObject({ installs: 2, cliAccounts: 1, downloads: 2, downloadAccounts: 2 })
    expect(summary.totals).toMatchObject({
      accounts: everyone.totals.accounts - 1,
      installs: 1,
      cliAccounts: 0,
      downloads: 1,
      downloadAccounts: 1,
      activeToday: 1,
      active7: 1,
      active30: 1,
      sessions7: 2,
      subagentSessions7: 0,
    })
    expect(summary.daily.at(-1)).toMatchObject({ active: 1, desktop: 1, cli: 0, sessions: 2, tokens: 40, tasks: 1 })
    expect(everyone.daily.at(-4)).toMatchObject({ active: 1, sessions: 9 })
    expect(summary.daily.at(-4)).toMatchObject({ active: 0, sessions: 0 })
    expect(summary.usage).toMatchObject({ reporting: 1, lifetimeTokens: 1_000_000, tokens7: 40 })
    expect(summary.models).toEqual([
      { providerID: "anthropic", modelID: "claude-sonnet-4-5", tokens: 700_000, people: 1, share: 1 },
    ])
    expect(summary.versions).toEqual([{ client: "desktop", version: "1.99.105", active: 1 }])
    expect(summary.funnel.at(-1)?.signups).toBe((everyone.funnel.at(-1)?.signups ?? 0) - 1)
    expect(summary.retention.reduce((sum, cohort) => sum + cohort.size, 0)).toBe(1)
  } finally {
    if (admins === undefined) delete process.env.VECTOR_ADMIN_EMAILS
    else process.env.VECTOR_ADMIN_EMAILS = admins
    await database`delete from auth.users where id = ${owner}`
  }
})

test("the summary adds up model use from each install's latest report", async () => {
  const signedIn = randomUUID()
  const other = randomUUID()
  const otherAccount = randomUUID()
  await database`insert into auth.users(id) values (${otherAccount})`
  await recordUsage(
    desktop(signedIn, {
      accountId: state.account,
      usage: report({
        currentStreak: 8,
        days: [
          { date: day(-8), tokens: 40, tasks: 1, cost: 0.5 },
          { date: day(0), tokens: 100, tasks: 2, cost: 1 },
        ],
        effortLevels: [
          { id: "default", label: "Default", tokens: 600_000, responses: 200, percentage: 60 },
          { id: "max", label: "Max", tokens: 400_000, responses: 100, percentage: 40 },
        ],
      }),
    }),
  )
  await recordUsage({
    client: "cli",
    accountId: state.account,
    version: "1.99.106",
    platform: "linux",
    arch: "x64",
    usage: report({
      lifetimeTokens: 300_000,
      lifetimeCost: 2,
      currentStreak: 1,
      days: [{ date: day(0), tokens: 50, tasks: 1, cost: 0.25 }],
    }),
  })
  await recordUsage(
    desktop(other, {
      accountId: otherAccount,
      usage: report({
        lifetimeTokens: 200_000,
        currentStreak: 4,
        favoriteModels: [
          { providerID: "anthropic", modelID: "claude-sonnet-4-5", tokens: 150_000, percentage: 75 },
          { providerID: "openrouter", modelID: "x-ai/grok-code-fast-1:free", tokens: 50_000, percentage: 25 },
        ],
      }),
    }),
  )
  expect(statuses()).toEqual(["ok", "ok", "ok"])

  const summary = await usageSummary()
  expect(summary.usage).toMatchObject({
    reporting: 3,
    lifetimeTokens: 1_500_000,
    lifetimeCost: 27,
    completedChats: 120,
    tokens7: 150,
    previousTokens7: 40,
    cost7: 1.25,
    previousCost7: 0.5,
    tokensPerActive7: 75,
  })
  expect(summary.daily.at(-1)).toMatchObject({ tokens: 150, tasks: 3, cost: 1.25 })
  expect(summary.models).toEqual([
    { providerID: "anthropic", modelID: "claude-sonnet-4-5", tokens: 1_550_000, people: 2, share: 0.9688 },
    { providerID: "openrouter", modelID: "x-ai/grok-code-fast-1:free", tokens: 50_000, people: 1, share: 0.0313 },
  ])
  expect(summary.efforts.map((effort) => [effort.id, effort.tokens, effort.people])).toEqual([
    ["default", 2_600_000, 2],
    ["max", 400_000, 1],
  ])
  // The signed-in desktop and its CLI are one person: their longest current streak counts.
  expect(summary.streaks).toEqual({ one: 0, twoToSix: 1, sevenPlus: 1 })
  const text = JSON.stringify(summary)
  for (const identity of [state.account, signedIn, other, otherAccount]) expect(text).not.toContain(identity)
})

test("totals that add up past 2^53 still reach the dashboard", async () => {
  // Ten thousand reports at the 1e12 lifetime-token bound: the sum no longer fits a safe integer.
  await database`
    insert into public.vector_usage_daily (key, client, day, version, platform, arch, usage)
    select 'install:' || gen_random_uuid(), 'desktop', (now() at time zone 'utc')::date, '1.99.106', 'linux', 'x64',
      ${report({ lifetimeTokens: 1e12, inputTokens: 1e12 })}::jsonb
    from generate_series(1, 10000)`
  const summary = await usageSummary()
  expect(summary.usage.reporting).toBe(10_000)
  expect(summary.usage.lifetimeTokens).toBeGreaterThan(Number.MAX_SAFE_INTEGER)
  expect(summary.usage.inputTokens).toBe(1e16)
})

test("retention fills in a finished week", async () => {
  const install = randomUUID()
  await database`
    insert into public.vector_usage_daily (key, client, day, version, platform, arch)
    values (${`install:${install}`}, 'desktop', (now() at time zone 'utc')::date - 14, '1.99.100', 'darwin', 'arm64'),
           (${`install:${install}`}, 'desktop', (now() at time zone 'utc')::date - 7, '1.99.100', 'darwin', 'arm64')`
  const summary = await usageSummary()
  const cohort = summary.weekly.at(-3)?.week
  expect(summary.retention.find((entry) => entry.cohort === cohort)).toMatchObject({
    size: 1,
    weeks: [1, null, null, null],
  })
})

test("an empty database still yields a complete summary", async () => {
  const summary = await usageSummary()
  expect(summary.totals).toMatchObject({ installs: 0, cliAccounts: 0, downloads: 0, active7: 0, previous7: 0 })
  expect(summary.weekly.every((week) => week.growth === null)).toBe(true)
  expect(summary.retention.every((cohort) => cohort.size === 0 && cohort.weeks.every((share) => share === null))).toBe(
    true,
  )
  expect(summary.versions).toEqual([])
})

test("browsers can neither call the functions nor read the tables", async () => {
  const rows = await database`
    select
      has_function_privilege('anon', 'public.vector_usage_record(jsonb)', 'EXECUTE')
        or has_function_privilege('authenticated', 'public.vector_usage_record(jsonb)', 'EXECUTE')
        or has_function_privilege('anon', 'public.vector_usage_download(jsonb)', 'EXECUTE')
        or has_function_privilege('authenticated', 'public.vector_usage_download(jsonb)', 'EXECUTE')
        or has_function_privilege('anon', 'public.vector_usage_forget(uuid)', 'EXECUTE')
        or has_function_privilege('authenticated', 'public.vector_usage_forget(uuid)', 'EXECUTE')
        or has_function_privilege('anon', 'public.vector_usage_summary(jsonb)', 'EXECUTE')
        or has_function_privilege('authenticated', 'public.vector_usage_summary(jsonb)', 'EXECUTE')
        or has_function_privilege('anon', 'public.vector_usage_share_create(jsonb)', 'EXECUTE')
        or has_function_privilege('authenticated', 'public.vector_usage_share_open(jsonb)', 'EXECUTE')
        or has_function_privilege('anon', 'public.vector_usage_share_list(jsonb)', 'EXECUTE')
        or has_function_privilege('authenticated', 'public.vector_usage_share_revoke(jsonb)', 'EXECUTE')
        or has_function_privilege('anon', 'public.vector_usage_report_valid(jsonb)', 'EXECUTE') as rpc,
      has_table_privilege('anon', 'public.vector_usage_daily', 'SELECT')
        or has_table_privilege('authenticated', 'public.vector_usage_daily', 'SELECT')
        or has_table_privilege('anon', 'public.vector_usage_downloads', 'SELECT')
        or has_table_privilege('authenticated', 'public.vector_usage_downloads', 'SELECT')
        or has_table_privilege('anon', 'public.vector_usage_tokens', 'SELECT')
        or has_table_privilege('authenticated', 'public.vector_usage_tokens', 'SELECT')
        or has_table_privilege('anon', 'public.vector_usage_shares', 'SELECT')
        or has_table_privilege('authenticated', 'public.vector_usage_shares', 'SELECT') as tables,
      has_function_privilege('service_role', 'public.vector_usage_summary(jsonb)', 'EXECUTE') as server`
  expect(rows).toEqual([{ rpc: false, tables: false, server: true }])
})
