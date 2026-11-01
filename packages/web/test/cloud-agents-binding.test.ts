import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test"
import { RedisClient } from "bun"
import { createHash, randomBytes, randomInt, randomUUID } from "node:crypto"
import {
  bindingFor,
  bindingKey,
  bindingsForAccount,
  createBindCode,
  generationKey,
  peekBindCode,
  recordRepoBinding,
  redeemAndBind,
  renameBinding,
  revokeBinding,
  suspendBinding,
  takeoverAllowed,
  touchBinding,
  type BindIdentity,
  type RedeemInput,
  type RepoBinding,
  type SuspendReason,
} from "../../../api/_lib/cloud-agents-binding"
import type { GithubIdentity } from "../../../api/_lib/github-oidc"

// Repository bindings, bind codes and generations (vector-at-mention-spec 2.5 and 2.7, V05), against a real Redis or
// Valkey behind an in-process fake of the store's REST endpoint. CI runs this file in one Bun process with the other
// web GitHub tests against one Valkey, so it never flushes: every test uses fresh accounts and repository ids, and
// afterAll deletes every key the file touched, the generation counters the product never deletes included.

const PREFIX = "vector:cloud-agents:"
const DAY = 86_400_000
const O6_WINDOW = 30 * DAY
// 2026-10-26T08:53:20Z, in milliseconds. The store's TTLs run on real time; every `now` here is the module's own clock.
const T = 1_793_000_000_000
const NO_TAKEOVER = { adminVerified: false, allowanceInactive: false }
const TOKEN = "cloud-agents-binding-fixture"

integrationTests()

function integrationTests() {
  const configured = process.env.VECTOR_TEST_REDIS_URL
  // V05's done-criterion is this file passing against a loopback Redis, so a missing one fails instead of skipping.
  if (!configured) {
    test("repository binding tests need VECTOR_TEST_REDIS_URL, a disposable loopback Redis or Valkey", () => {
      throw new Error("Set VECTOR_TEST_REDIS_URL=redis://127.0.0.1:<port> (contract 0.3).")
    })
    return
  }
  const url = new URL(configured)
  if (!["127.0.0.1", "localhost"].includes(url.hostname)) throw new Error("Binding tests require loopback Redis")
  const redis = new RedisClient(url.href, { connectionTimeout: 1000, enableOfflineQueue: false })
  const state: { down: boolean; corrupt: boolean; gate?: { size: number; held: (() => void)[] } } = {
    down: false,
    corrupt: false,
  }
  const commands: string[][] = []
  const keys = new Set<string>()
  const upstream = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      if (request.headers.get("authorization") !== `Bearer ${TOKEN}`) return new Response(null, { status: 401 })
      const command = ((await request.json()) as unknown[]).map(String)
      commands.push(command)
      if (state.down) return new Response(null, { status: 503 })
      if (state.corrupt) return Response.json({ result: { unexpected: true } })
      await gate()
      for (const key of command[0] === "EVAL" ? command.slice(3, 3 + Number(command[2])) : [command[1]]) keys.add(key)
      return redis.send(command[0], command.slice(1)).then(
        (result) => Response.json({ result }),
        (error: unknown) => Response.json({ error: String(error) }, { status: 400 }),
      )
    },
  })
  const environment = ["KV_REST_API_URL", "KV_REST_API_TOKEN", "UPSTASH_REDIS_REST_URL", "UPSTASH_REDIS_REST_TOKEN"]
  const previous = Object.fromEntries(environment.map((key) => [key, process.env[key]]))

  // Holds the first `size` requests to arrive until all of them have, then lets them go together, so two parallel
  // calls interleave at their first store command. An implementation that split a redeem into a read and a later
  // write would then always let both reads see the code.
  function gate() {
    const current = state.gate
    if (!current) return
    return new Promise<void>((resolve) => {
      current.held.push(resolve)
      if (current.held.length < current.size) return
      state.gate = undefined
      current.held.forEach((release) => release())
    })
  }

  beforeAll(async () => {
    await redis.connect()
    expect(await redis.send("PING", [])).toBe("PONG")
    delete process.env.UPSTASH_REDIS_REST_URL
    delete process.env.UPSTASH_REDIS_REST_TOKEN
    Object.assign(process.env, { KV_REST_API_URL: upstream.url.origin, KV_REST_API_TOKEN: TOKEN })
  })
  beforeEach(() => {
    state.down = false
    state.corrupt = false
    state.gate = undefined
    commands.length = 0
  })
  afterAll(async () => {
    if (keys.size) await redis.send("DEL", [...keys])
    redis.close()
    upstream.stop(true)
    environment.forEach((key) =>
      previous[key] === undefined ? delete process.env[key] : (process.env[key] = previous[key]),
    )
  })

  function repository(overrides: Partial<BindIdentity> = {}): BindIdentity {
    const repositoryId = String(randomInt(100_000_000, 1_000_000_000))
    return {
      repository: `octo-${repositoryId}/app`,
      repositoryId,
      ownerId: String(randomInt(1_000_000, 10_000_000)),
      actor: "octocat",
      actorId: "583231",
      ref: "refs/heads/main",
      ...overrides,
    }
  }

  // Writes made by the test itself, outside the fake store.
  async function write(command: string, key: string, args: string[]) {
    keys.add(key)
    await redis.send(command, [key, ...args])
  }

  async function issue(account: string, who: BindIdentity, now: number, extra: { defaultRef?: string } = {}) {
    const issued = await createBindCode({
      account,
      repository: who.repository,
      repositoryId: who.repositoryId,
      githubUserId: who.actorId,
      now,
      ...extra,
    })
    return issued.code
  }

  // Binds the way V10 will: the binder V10 judged O6 against is the one bindingFor reads just before.
  async function bind(account: string, who: BindIdentity, now: number, input: Partial<RedeemInput> = {}) {
    const code = await issue(account, who, now - 1_000)
    const current = (await bindingFor(who.repositoryId))?.account
    return redeemAndBind({
      code,
      account,
      ...(current === undefined ? {} : { current }),
      identity: who,
      workflowVersion: "3",
      takeover: NO_TAKEOVER,
      now,
      ...input,
    })
  }

  // Suspends the binding as it stands, the way V12 and V28 suspend the binding they have just read.
  async function suspend(repositoryId: string, reason: SuspendReason) {
    const binding = await bindingFor(repositoryId)
    if (!binding) throw new Error(`${repositoryId} is not bound`)
    await suspendBinding(binding, reason)
  }

  async function generation(repositoryId: string) {
    return redis.send("GET", [generationKey(repositoryId)])
  }

  async function members(account: string) {
    return [...((await redis.send("SMEMBERS", [`${PREFIX}bindings:${account}`])) as string[])].sort()
  }

  async function binderLeft(account: string) {
    return [...((await redis.send("SMEMBERS", [`${PREFIX}binder-left:${account}`])) as string[])].sort()
  }

  async function stored(repositoryId: string) {
    return (await redis.send("HGETALL", [bindingKey(repositoryId)])) as Record<string, string>
  }

  // While a binding exists, its generation is the counter's value (2.7).
  async function expectGenerationMatches(repositoryId: string) {
    const binding = await bindingFor(repositoryId)
    expect(binding?.generation).toBe(Number(await generation(repositoryId)))
    return binding
  }

  async function outcome(promise: Promise<unknown>) {
    return promise.then(
      () => "accepted",
      (error: { statusCode?: number; code?: string; message?: string }) =>
        `${error.statusCode} ${error.code} ${error.message}`,
    )
  }

  function rejected(result: PromiseSettledResult<unknown>): result is PromiseRejectedResult {
    return result.status === "rejected"
  }

  function sha256(value: string) {
    return createHash("sha256").update(value).digest("hex")
  }

  const BIND_CODE_INVALID = { statusCode: 403, code: "BIND_CODE_INVALID" }
  const INVALID_REQUEST = { statusCode: 400, code: "INVALID_REQUEST" }
  const STORE_UNAVAILABLE = { statusCode: 503, code: "PERSISTENT_STORE_UNAVAILABLE" }
  const BOUND_ELSEWHERE = { statusCode: 409, code: "REPO_BOUND_ELSEWHERE" }

  describe("bind codes", () => {
    test("a code is vbc_ and 32 random bytes, kept for 600 s under its SHA-256 only, with the documented fields", async () => {
      const account = randomUUID()
      const who = repository()
      const issued = await createBindCode({
        account,
        repository: who.repository,
        repositoryId: who.repositoryId,
        githubUserId: "583231",
        defaultRef: "refs/heads/trunk",
        now: T,
      })
      expect(issued.code).toMatch(/^vbc_[A-Za-z0-9_-]{43}$/)
      expect(Buffer.from(issued.code.slice(4), "base64url")).toHaveLength(32)
      expect(issued.expiresAt).toBe(T + 600_000)
      const key = `${PREFIX}bind-code:${sha256(issued.code)}`
      expect(commands).toEqual([
        ["EVAL", expect.any(String), "2", key, `vector:cli-revoked:${account}`, expect.any(String), "600"],
      ])
      expect(commands.flat().some((part) => part.includes(issued.code.slice(4)))).toBe(false)
      const raw = (await redis.send("GET", [key])) as string
      expect(JSON.parse(raw)).toStrictEqual({
        account,
        repository: who.repository,
        repositoryId: who.repositoryId,
        githubUserId: "583231",
        defaultRef: "refs/heads/trunk",
        exp: T + 600_000,
      })
      const ttl = (await redis.send("TTL", [key])) as number
      expect(ttl).toBeGreaterThan(590)
      expect(ttl).toBeLessThanOrEqual(600)

      const bare = await createBindCode({ account, repository: who.repository, now: T })
      expect(bare.code).not.toBe(issued.code)
      const bareRaw = (await redis.send("GET", [`${PREFIX}bind-code:${sha256(bare.code)}`])) as string
      expect(JSON.parse(bareRaw)).toStrictEqual({ account, repository: who.repository, exp: T + 600_000 })
    })

    test("invalid code requests answer 400 and reach no store", async () => {
      const valid = { account: randomUUID(), repository: "octo/app", now: T }
      const inputs = [
        { ...valid, account: "not-a-uuid" },
        { ...valid, account: randomUUID().toUpperCase() },
        { ...valid, repository: "octo" },
        { ...valid, repository: "octo/app/extra" },
        { ...valid, repository: "-octo/app" },
        { ...valid, repositoryId: "0" },
        { ...valid, repositoryId: "0123" },
        { ...valid, repositoryId: "9007199254740993" },
        { ...valid, githubUserId: "12a" },
        { ...valid, githubUserId: "" },
        { ...valid, defaultRef: "main" },
        { ...valid, defaultRef: "refs/tags/v1" },
        { ...valid, defaultRef: "refs/heads/a b" },
        { ...valid, now: 0 },
        { ...valid, now: Number.NaN },
        { ...valid, now: T + 0.5 },
      ]
      for (const input of inputs) await expect(createBindCode(input)).rejects.toMatchObject(INVALID_REQUEST)
      expect(commands).toEqual([])
    })

    test("a peek returns the account and default ref and consumes nothing, however often", async () => {
      const account = randomUUID()
      const who = repository()
      const code = await issue(account, who, T, { defaultRef: "refs/heads/trunk" })
      const key = `${PREFIX}bind-code:${sha256(code)}`
      commands.length = 0
      for (const now of [T, T + 1, T + 599_999])
        expect(await peekBindCode(code, who, now)).toStrictEqual({ account, defaultRef: "refs/heads/trunk" })
      expect(commands).toEqual([
        ["GET", key],
        ["GET", key],
        ["GET", key],
      ])
      expect(await redis.send("EXISTS", [key])).toBe(1)
      expect((await redis.send("TTL", [key])) as number).toBeGreaterThan(590)

      const plain = await issue(account, who, T)
      expect(await peekBindCode(plain, who, T)).toStrictEqual({ account })
    })

    test("a malformed code is refused with the same 403 before any store command", async () => {
      const who = repository()
      const input = { account: randomUUID(), identity: who, workflowVersion: "3", takeover: NO_TAKEOVER, now: T }
      const valid = `vbc_${randomBytes(32).toString("base64url")}`
      for (const code of [
        "",
        "vbc_",
        `${valid}A`,
        valid.slice(0, -1),
        `vbx_${valid.slice(4)}`,
        `${valid}\n`,
        ` ${valid}`,
      ]) {
        await expect(peekBindCode(code, who, T)).rejects.toMatchObject(BIND_CODE_INVALID)
        await expect(redeemAndBind({ ...input, code })).rejects.toMatchObject(BIND_CODE_INVALID)
      }
      expect(commands).toEqual([])
    })

    // The match rules exist twice, in peekBindCode and in the redeem script, so every case runs through both.
    test("peek and redeem agree on every match case, and every refusal is the same 403", async () => {
      const cases: {
        name: string
        setup?: (input: { account: string; who: BindIdentity; code: string }) => Promise<void>
        ids?: boolean
        who?: (who: BindIdentity) => BindIdentity
        at?: number
        unknown?: boolean
        accepted: boolean
      }[] = [
        { name: "the same repository, id and user", accepted: true },
        {
          name: "another letter case in the repository name",
          who: (who) => ({ ...who, repository: who.repository.toUpperCase() }),
          accepted: true,
        },
        { name: "one millisecond before exp", at: T + 599_999, accepted: true },
        {
          name: "no repository id or GitHub user stored, another user",
          ids: false,
          who: (who) => ({ ...who, actorId: "999" }),
          accepted: true,
        },
        { name: "exactly at exp", at: T + 600_000, accepted: false },
        { name: "after exp", at: T + 600_001, accepted: false },
        {
          name: "another repository name",
          who: (who) => ({ ...who, repository: `${who.repository}-fork` }),
          accepted: false,
        },
        {
          name: "another repository id",
          who: (who) => ({ ...who, repositoryId: String(Number(who.repositoryId) + 1) }),
          accepted: false,
        },
        { name: "another GitHub user", who: (who) => ({ ...who, actorId: "583232" }), accepted: false },
        { name: "an unknown code", unknown: true, accepted: false },
        {
          name: "a used code",
          setup: async ({ account, who, code }) => {
            await redeemAndBind({ code, account, identity: who, workflowVersion: "3", takeover: NO_TAKEOVER, now: T })
          },
          accepted: false,
        },
      ]
      const refusals = new Set<string>()
      for (const item of cases) {
        const account = randomUUID()
        const owner = repository()
        const issued = await createBindCode({
          account,
          repository: owner.repository,
          ...(item.ids === false ? {} : { repositoryId: owner.repositoryId, githubUserId: owner.actorId }),
          now: T,
        })
        const code = item.unknown ? `vbc_${randomBytes(32).toString("base64url")}` : issued.code
        await item.setup?.({ account, who: owner, code })
        const who = item.who ? item.who(owner) : owner
        const now = item.at ?? T + 1
        const peeked = await outcome(peekBindCode(code, who, now))
        const redeemed = await outcome(
          redeemAndBind({ code, account, identity: who, workflowVersion: "3", takeover: NO_TAKEOVER, now }),
        )
        expect({ case: item.name, peeked, redeemed }).toEqual({
          case: item.name,
          peeked: item.accepted ? "accepted" : expect.stringMatching(/^403 BIND_CODE_INVALID /),
          redeemed: item.accepted ? "accepted" : expect.stringMatching(/^403 BIND_CODE_INVALID /),
        })
        if (!item.accepted) {
          refusals.add(peeked).add(redeemed)
          // A refused redeem burns nothing: a code that existed before still does.
          if (!item.unknown && !item.setup)
            expect(await redis.send("EXISTS", [`${PREFIX}bind-code:${sha256(code)}`])).toBe(1)
        }
      }
      expect(refusals.size).toBe(1)
    })
  })

  describe("redeemAndBind", () => {
    test("one EVAL consumes the code and writes exactly the documented binding", async () => {
      const account = randomUUID()
      const who = repository()
      const code = await issue(account, who, T)
      commands.length = 0
      const binding = await redeemAndBind({
        code,
        account,
        identity: who,
        workflowVersion: "3",
        takeover: NO_TAKEOVER,
        now: T + 5,
      })
      expect(commands).toHaveLength(1)
      expect(commands[0][0]).toBe("EVAL")
      expect(binding).toStrictEqual({
        repositoryId: who.repositoryId,
        ownerId: who.ownerId,
        repository: who.repository,
        account,
        visibility: "private",
        defaultRef: "refs/heads/main",
        generation: 1,
        binder: { githubId: "583231", login: "octocat" },
        workflowVersion: "3",
        boundAt: T + 5,
      } satisfies RepoBinding)
      expect(await stored(who.repositoryId)).toStrictEqual({
        repositoryId: who.repositoryId,
        ownerId: who.ownerId,
        repository: who.repository,
        account,
        visibility: "private",
        defaultRef: "refs/heads/main",
        generation: "1",
        binderGithubId: "583231",
        binderLogin: "octocat",
        workflowVersion: "3",
        boundAt: String(T + 5),
      })
      expect(await bindingFor(who.repositoryId)).toStrictEqual(binding)
      expect(await members(account)).toEqual([who.repositoryId])
      expect(await redis.send("EXISTS", [`${PREFIX}bind-code:${sha256(code)}`])).toBe(0)
      await expect(peekBindCode(code, who, T + 6)).rejects.toMatchObject(BIND_CODE_INVALID)
      await expect(
        redeemAndBind({ code, account, identity: who, workflowVersion: "3", takeover: NO_TAKEOVER, now: T + 6 }),
      ).rejects.toMatchObject(BIND_CODE_INVALID)
    })

    // V10 verifies the token's ref before the redeem (INV-S11); a code's default ref is only the desktop's claim, and
    // here each code names another branch than the token, so storing the code's would show.
    test("the default ref is the bind token's ref, never the code's, and the visibility its claim or private", async () => {
      const account = randomUUID()
      const open = repository({ ref: "refs/heads/trunk", repositoryVisibility: "public" })
      const internal = repository({ repositoryVisibility: "internal" })
      const cases = [
        [open, "refs/heads/main", "public"],
        [internal, "refs/heads/trunk", "internal"],
      ] as const
      for (const [who, claimed, visibility] of cases) {
        const code = await issue(account, who, T, { defaultRef: claimed })
        expect(await peekBindCode(code, who, T + 1)).toStrictEqual({ account, defaultRef: claimed })
        const binding = await redeemAndBind({
          code,
          account,
          identity: who,
          workflowVersion: "3",
          takeover: NO_TAKEOVER,
          now: T + 1,
        })
        expect(binding).toMatchObject({ visibility, defaultRef: who.ref })
        expect(await stored(who.repositoryId)).toMatchObject({ visibility, defaultRef: who.ref })
        expect(await bindingFor(who.repositoryId)).toStrictEqual(binding)
      }
    })

    // A website user may type the code's repository in another case than GitHub's (deviation 3); the binding, as
    // returned, stored and read back, always holds the bind token's spelling.
    test("the binding holds the bind token's spelling of the repository name, never the code's", async () => {
      const account = randomUUID()
      const who = repository()
      const token = { ...who, repository: who.repository.replace("octo", "Octo").replace("app", "App") }
      const code = await issue(account, who, T)
      expect(await peekBindCode(code, token, T + 1)).toStrictEqual({ account })
      const binding = await redeemAndBind({
        code,
        account,
        identity: token,
        workflowVersion: "3",
        takeover: NO_TAKEOVER,
        now: T + 1,
      })
      expect(binding.repository).toBe(token.repository)
      expect((await stored(who.repositoryId)).repository).toBe(token.repository)
      expect(await bindingFor(who.repositoryId)).toStrictEqual(binding)
    })

    test("invalid redeem input answers 400, reaches no store and leaves the code usable", async () => {
      const account = randomUUID()
      const who = repository()
      const code = await issue(account, who, T)
      const valid: RedeemInput = { code, account, identity: who, workflowVersion: "3", takeover: NO_TAKEOVER, now: T }
      const inputs = [
        { ...valid, account: "someone" },
        { ...valid, current: "someone" },
        { ...valid, identity: { ...who, repository: "octo" } },
        { ...valid, identity: { ...who, repositoryId: "0" } },
        { ...valid, identity: { ...who, ownerId: "1e5" } },
        { ...valid, identity: { ...who, actor: "octo cat" } },
        { ...valid, identity: { ...who, actorId: "9007199254740993" } },
        { ...valid, identity: { ...who, ref: "refs/pull/1/merge" } },
        { ...valid, identity: { ...who, repositoryVisibility: "secret" } as unknown as BindIdentity },
        { ...valid, workflowVersion: "" },
        { ...valid, workflowVersion: "3.1" },
        { ...valid, workflowVersion: "03" },
        { ...valid, workflowVersion: "10000" },
        {
          ...valid,
          takeover: { adminVerified: "yes", allowanceInactive: false } as unknown as RedeemInput["takeover"],
        },
        { ...valid, takeover: { adminVerified: false } as unknown as RedeemInput["takeover"] },
        { ...valid, now: 0 },
        { ...valid, now: T + 0.5 },
      ]
      commands.length = 0
      for (const input of inputs) await expect(redeemAndBind(input)).rejects.toMatchObject(INVALID_REQUEST)
      expect(commands).toEqual([])
      expect(await peekBindCode(code, who, T)).toStrictEqual({ account })
    })

    test("a parallel double redeem of one code yields exactly one binding", async () => {
      const account = randomUUID()
      const who = repository()
      const code = await issue(account, who, T)
      const input = { code, account, identity: who, workflowVersion: "3", takeover: NO_TAKEOVER, now: T + 1 }
      state.gate = { size: 2, held: [] }
      const results = await Promise.allSettled([redeemAndBind(input), redeemAndBind(input)])
      expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1)
      expect(results.find(rejected)?.reason).toMatchObject(BIND_CODE_INVALID)
      expect(await generation(who.repositoryId)).toBe("1")
      expect(await members(account)).toEqual([who.repositoryId])
      await expectGenerationMatches(who.repositoryId)
    })

    test("two accounts binding one repository at once yield one binding, and the loser keeps its code", async () => {
      const first = randomUUID()
      const second = randomUUID()
      const who = repository()
      const codes = [await issue(first, who, T), await issue(second, who, T)]
      expect(await peekBindCode(codes[0], who, T + 1)).toStrictEqual({ account: first })
      expect(await peekBindCode(codes[1], who, T + 1)).toStrictEqual({ account: second })
      // Both judged O6 against an unbound repository, as two bind requests racing in V10 would.
      state.gate = { size: 2, held: [] }
      const results = await Promise.allSettled(
        [first, second].map((account, index) =>
          redeemAndBind({
            code: codes[index],
            account,
            identity: who,
            workflowVersion: "3",
            takeover: NO_TAKEOVER,
            now: T + 2,
          }),
        ),
      )
      const won = results.flatMap((result) => (result.status === "fulfilled" ? [result.value] : []))
      expect(won).toHaveLength(1)
      expect(results.find(rejected)?.reason).toMatchObject(BOUND_ELSEWHERE)
      const winner = won[0].account
      const loser = winner === first ? second : first
      expect((await bindingFor(who.repositoryId))?.account).toBe(winner)
      expect(await members(winner)).toEqual([who.repositoryId])
      expect(await members(loser)).toEqual([])
      expect(await generation(who.repositoryId)).toBe("1")
      expect(await peekBindCode(codes[winner === first ? 1 : 0], who, T + 3)).toStrictEqual({ account: loser })
    })

    test("a binder that changed since the caller judged O6 is refused before any write", async () => {
      const binder = randomUUID()
      const other = randomUUID()
      const who = repository()
      await bind(binder, who, T)
      const code = await issue(other, who, T + O6_WINDOW)
      // The repository is old enough to take over, but the caller judged it unbound, or bound to a third account.
      for (const current of [undefined, randomUUID()]) {
        const input = {
          code,
          account: other,
          ...(current === undefined ? {} : { current }),
          identity: who,
          workflowVersion: "3",
          takeover: NO_TAKEOVER,
          now: T + O6_WINDOW + 1,
        }
        expect(await recordRepoBinding(input)).toStrictEqual({ ok: false, refusal: "changed" })
        await expect(redeemAndBind(input)).rejects.toMatchObject(BOUND_ELSEWHERE)
      }
      expect((await bindingFor(who.repositoryId))?.account).toBe(binder)
      expect(await generation(who.repositoryId)).toBe("1")
      expect(await peekBindCode(code, who, T + O6_WINDOW + 2)).toStrictEqual({ account: other })
      // The binder's own account may rebind whatever it judged.
      const again = await issue(binder, who, T + 10)
      const rebound = await redeemAndBind({
        code: again,
        account: binder,
        identity: who,
        workflowVersion: "3",
        takeover: NO_TAKEOVER,
        now: T + 11,
      })
      expect(rebound.generation).toBe(2)
    })

    // The redeem script's account check is all that ties a binding to the account that asked for the code.
    test("a valid code redeemed for another account is refused with the same 403, and nothing is written", async () => {
      const asked = randomUUID()
      const other = randomUUID()
      const who = repository()
      const code = await issue(asked, who, T)
      const input = { code, account: other, identity: who, workflowVersion: "3", takeover: NO_TAKEOVER, now: T + 1 }
      expect(await recordRepoBinding(input)).toStrictEqual({ ok: false, refusal: "code" })
      await expect(redeemAndBind(input)).rejects.toMatchObject(BIND_CODE_INVALID)
      expect(await redis.send("EXISTS", [bindingKey(who.repositoryId), generationKey(who.repositoryId)])).toBe(0)
      expect(await members(other)).toEqual([])
      expect(await members(asked)).toEqual([])
      // Already bound to the other account, the code would otherwise pass as that account's own rebind.
      const bound = await bind(other, who, T + 2)
      const rebind = { ...input, current: other, now: T + 3 }
      expect(await recordRepoBinding(rebind)).toStrictEqual({ ok: false, refusal: "code" })
      await expect(redeemAndBind(rebind)).rejects.toMatchObject(BIND_CODE_INVALID)
      expect(await bindingFor(who.repositoryId)).toStrictEqual(bound)
      expect(await generation(who.repositoryId)).toBe("1")
      expect(await members(other)).toEqual([who.repositoryId])
      expect(await members(asked)).toEqual([])
      expect(await peekBindCode(code, who, T + 4)).toStrictEqual({ account: asked })
    })
  })

  describe("generations", () => {
    test("bind, rebind, unbind, takeover and the first suspension each move it by one, and it never resets", async () => {
      const binder = randomUUID()
      const other = randomUUID()
      const who = repository()
      expect((await bind(binder, who, T)).generation).toBe(1)
      await expectGenerationMatches(who.repositoryId)
      await touchBinding(who.repositoryId, T + 10)
      const rebound = await bind(binder, who, T + 20, { workflowVersion: "4" })
      // A rebind writes a fresh binding: a new bind time, no last use carried over.
      expect(rebound).toMatchObject({ generation: 2, boundAt: T + 20, workflowVersion: "4" })
      expect(rebound.lastUsedAt).toBeUndefined()
      expect(await expectGenerationMatches(who.repositoryId)).toStrictEqual(rebound)
      expect(await revokeBinding(who.repositoryId, binder)).toBe(true)
      expect(await generation(who.repositoryId)).toBe("3")
      expect(await redis.send("TTL", [generationKey(who.repositoryId)])).toBe(-1)
      expect(await bindingFor(who.repositoryId)).toBeUndefined()
      const fourth = await bind(binder, who, T + 30)
      expect(fourth.generation).toBe(4)
      await suspendBinding(fourth, "transferred")
      expect((await expectGenerationMatches(who.repositoryId))?.generation).toBe(5)
      expect((await bind(other, who, T + 40)).generation).toBe(6)
      await expectGenerationMatches(who.repositoryId)
      await touchBinding(who.repositoryId, T + 50)
      await renameBinding(who.repositoryId, "octo/renamed")
      expect((await expectGenerationMatches(who.repositoryId))?.generation).toBe(6)
      expect(await redis.send("TTL", [generationKey(who.repositoryId)])).toBe(-1)
    })
  })

  describe("O6 takeover", () => {
    type Case = {
      name: string
      setup?: (who: BindIdentity) => Promise<void>
      at: number
      takeover?: RedeemInput["takeover"]
      owner?: boolean
      allowed: boolean
    }
    const used = (at: number) => (who: BindIdentity) => touchBinding(who.repositoryId, at)
    const suspended = (reason: SuspendReason) => (who: BindIdentity) => suspend(who.repositoryId, reason)
    const cases: Case[] = [
      { name: "used 30 days minus 1 ms ago", setup: used(T + DAY), at: T + DAY + O6_WINDOW - 1, allowed: false },
      { name: "used exactly 30 days ago", setup: used(T + DAY), at: T + DAY + O6_WINDOW, allowed: true },
      { name: "never used, bound 30 days minus 1 ms ago", at: T + O6_WINDOW - 1, allowed: false },
      { name: "never used, bound exactly 30 days ago", at: T + O6_WINDOW, allowed: true },
      { name: "a fresh binding", at: T + 1, allowed: false },
      { name: "suspended as transferred", setup: suspended("transferred"), at: T + 1, allowed: true },
      { name: "suspended as deleted", setup: suspended("deleted"), at: T + 1, allowed: true },
      { name: "suspended as binder-left", setup: suspended("binder-left"), at: T + 1, allowed: true },
      { name: "the repository's owner changed", owner: true, at: T + 1, allowed: true },
      {
        name: "the binder's allowance is inactive",
        takeover: { adminVerified: false, allowanceInactive: true },
        at: T + 1,
        allowed: true,
      },
      {
        name: "the App verified an admin",
        takeover: { adminVerified: true, allowanceInactive: false },
        at: T + 1,
        allowed: true,
      },
    ]

    for (const item of cases)
      test(`${item.allowed ? "allowed" : "refused"}: ${item.name}, the same through takeoverAllowed and redeemAndBind`, async () => {
        const binder = randomUUID()
        const taker = randomUUID()
        const original = repository()
        await bind(binder, original, T)
        await item.setup?.(original)
        const before = await bindingFor(original.repositoryId)
        const who = item.owner
          ? {
              ...original,
              ownerId: String(Number(original.ownerId) + 1),
              repository: `new-owner/${original.repositoryId}`,
            }
          : { ...original, actor: "hubot", actorId: "1000001" }
        const takeover = item.takeover ?? NO_TAKEOVER
        const code = await issue(taker, who, item.at - 1_000)
        expect(takeoverAllowed(before, { account: taker, ownerId: who.ownerId, takeover, now: item.at })).toBe(
          item.allowed,
        )
        const result = await outcome(
          redeemAndBind({
            code,
            account: taker,
            current: binder,
            identity: who,
            workflowVersion: "3",
            takeover,
            now: item.at,
          }),
        )
        if (!item.allowed) {
          expect(result).toMatch(/^409 REPO_BOUND_ELSEWHERE /)
          expect(await bindingFor(original.repositoryId)).toStrictEqual(before)
          expect(await members(binder)).toEqual([original.repositoryId])
          expect(await members(taker)).toEqual([])
          expect(await peekBindCode(code, who, item.at)).toStrictEqual({ account: taker })
          return
        }
        expect(result).toBe("accepted")
        expect(await expectGenerationMatches(original.repositoryId)).toStrictEqual({
          repositoryId: original.repositoryId,
          ownerId: who.ownerId,
          repository: who.repository,
          account: taker,
          visibility: "private",
          defaultRef: "refs/heads/main",
          generation: before!.generation + 1,
          binder: { githubId: who.actorId, login: who.actor },
          workflowVersion: "3",
          boundAt: item.at,
        })
        expect(await members(binder)).toEqual([])
        expect(await members(taker)).toEqual([original.repositoryId])
      })

    test("the binder's own account, and an unbound repository, need no exception", () => {
      const binding = {
        repositoryId: "101",
        ownerId: "7",
        repository: "octo/app",
        account: randomUUID(),
        visibility: "private",
        defaultRef: "refs/heads/main",
        generation: 1,
        binder: { githubId: "1", login: "octo" },
        workflowVersion: "3",
        boundAt: T,
      } satisfies RepoBinding
      const input = { ownerId: "7", takeover: NO_TAKEOVER, now: T + 1 }
      expect(takeoverAllowed(binding, { ...input, account: binding.account })).toBe(true)
      expect(takeoverAllowed(undefined, { ...input, account: randomUUID() })).toBe(true)
      expect(takeoverAllowed(binding, { ...input, account: randomUUID() })).toBe(false)
    })
  })

  describe("bindingsForAccount", () => {
    test("lists only the account's own bindings, newest first, skipping stale members", async () => {
      const account = randomUUID()
      const other = randomUUID()
      // Ids rise against the expected order, so neither the set's own order nor the bind order passes for a sort.
      const [oldest, low, high] = [repository(), repository(), repository()].sort(
        (a, b) => Number(a.repositoryId) - Number(b.repositoryId),
      )
      await bind(account, oldest, T)
      await bind(account, high, T + 10)
      await bind(account, low, T + 10)
      const theirs = repository()
      await bind(other, theirs, T + 20)
      const gone = String(randomInt(100_000_000, 1_000_000_000))
      await write("SADD", `${PREFIX}bindings:${account}`, [gone, theirs.repositoryId])
      commands.length = 0
      const listed = await bindingsForAccount(account)
      expect(listed.map((binding) => binding.repositoryId)).toEqual([
        low.repositoryId,
        high.repositoryId,
        oldest.repositoryId,
      ])
      expect(listed.every((binding) => binding.account === account)).toBe(true)
      expect(commands.map((command) => command[0])).toEqual(["EVAL", "EVAL"])
      expect((await bindingsForAccount(other)).map((binding) => binding.repositoryId)).toEqual([theirs.repositoryId])
      commands.length = 0
      expect(await bindingsForAccount(randomUUID())).toEqual([])
      expect(commands).toHaveLength(1)

      await revokeBinding(oldest.repositoryId, account)
      await suspend(low.repositoryId, "binder-left")
      await bind(other, low, T + 30)
      expect((await bindingsForAccount(account)).map((binding) => binding.repositoryId)).toEqual([high.repositoryId])
      expect((await bindingsForAccount(other)).map((binding) => binding.repositoryId)).toEqual([
        low.repositoryId,
        theirs.repositoryId,
      ])
      await expect(bindingsForAccount("someone")).rejects.toMatchObject(INVALID_REQUEST)
    })
  })

  describe("revokeBinding", () => {
    test("only the binder's account unbinds; that moves the generation once", async () => {
      const binder = randomUUID()
      const who = repository()
      const bound = await bind(binder, who, T)
      expect(await revokeBinding(who.repositoryId, randomUUID())).toBe(false)
      expect(await bindingFor(who.repositoryId)).toStrictEqual(bound)
      expect(await generation(who.repositoryId)).toBe("1")
      expect(await revokeBinding(who.repositoryId, binder)).toBe(true)
      expect(await generation(who.repositoryId)).toBe("2")
      expect(await bindingFor(who.repositoryId)).toBeUndefined()
      expect(await members(binder)).toEqual([])
      expect(await revokeBinding(who.repositoryId, binder)).toBe(false)
      expect(await generation(who.repositoryId)).toBe("2")
      commands.length = 0
      await expect(revokeBinding("0", binder)).rejects.toMatchObject(INVALID_REQUEST)
      await expect(revokeBinding(who.repositoryId, "binder")).rejects.toMatchObject(INVALID_REQUEST)
      expect(commands).toEqual([])
    })
  })

  describe("touchBinding", () => {
    test("the last use only moves forward, and a removed binding is never recreated", async () => {
      const binder = randomUUID()
      const who = repository()
      await bind(binder, who, T)
      await touchBinding(who.repositoryId, T + 5)
      expect((await bindingFor(who.repositoryId))?.lastUsedAt).toBe(T + 5)
      await touchBinding(who.repositoryId, T + 3)
      expect((await bindingFor(who.repositoryId))?.lastUsedAt).toBe(T + 5)
      await touchBinding(who.repositoryId, T + 9)
      expect(await expectGenerationMatches(who.repositoryId)).toMatchObject({ lastUsedAt: T + 9, generation: 1 })
      await revokeBinding(who.repositoryId, binder)
      await touchBinding(who.repositoryId, T + 20)
      expect(await redis.send("EXISTS", [bindingKey(who.repositoryId)])).toBe(0)
      expect(await bindingFor(who.repositoryId)).toBeUndefined()
      await expect(touchBinding(who.repositoryId, 0)).rejects.toMatchObject(INVALID_REQUEST)
    })
  })

  describe("suspendBinding and renameBinding", () => {
    test("the first suspension moves the generation once and keeps its reason; binder-left wins and stays", async () => {
      const who = repository()
      await bind(randomUUID(), who, T)
      const steps: [SuspendReason, SuspendReason, number][] = [
        ["transferred", "transferred", 2],
        ["transferred", "transferred", 2],
        ["deleted", "transferred", 2],
        ["binder-left", "binder-left", 2],
        ["transferred", "binder-left", 2],
        ["deleted", "binder-left", 2],
      ]
      for (const [reason, kept, moved] of steps) {
        await suspend(who.repositoryId, reason)
        expect(await expectGenerationMatches(who.repositoryId)).toMatchObject({ suspended: kept, generation: moved })
      }
      const left = repository()
      await bind(randomUUID(), left, T)
      for (const reason of ["binder-left", "transferred", "deleted"] as const) await suspend(left.repositoryId, reason)
      expect(await expectGenerationMatches(left.repositoryId)).toMatchObject({
        suspended: "binder-left",
        generation: 2,
      })
    })

    // V12 suspends after reading the binding, at step 9 after a GitHub round trip, and V28's deliveries are not
    // ordered: the repository may have a new binding, or none, by the time the suspension runs. That binding and the
    // counter are left alone. Binder-left is the read account's fact, though, so it still reaches that account's set
    // unless the account holds the repository again: the set ends as it does when the suspension lands first (the
    // next test), whichever script lands first.
    test("a suspension lands only on the binding it was decided against", async () => {
      const admin = { adminVerified: true, allowanceInactive: false }
      const hubot = { actor: "hubot", actorId: "1000001" }
      const takeOver = (who: BindIdentity, taker: string) =>
        bind(taker, { ...who, ...hubot }, T + 10, { takeover: admin })
      type Replace = (who: BindIdentity, binder: string, taker: string) => Promise<unknown>
      const replacements: [string, boolean, Replace][] = [
        ["a rebind", false, (who, binder) => bind(binder, who, T + 10)],
        ["a takeover", true, (who, _, taker) => takeOver(who, taker)],
        ["an unbind", true, (who, binder) => revokeBinding(who.repositoryId, binder)],
        [
          "an unbind and a new bind",
          false,
          async (who, binder) => {
            await revokeBinding(who.repositoryId, binder)
            await bind(binder, who, T + 10)
          },
        ],
        [
          "an unbind and another account's bind",
          true,
          async (who, binder, taker) => {
            await revokeBinding(who.repositoryId, binder)
            await bind(taker, { ...who, ...hubot }, T + 10)
          },
        ],
        [
          "a takeover that was then unbound",
          true,
          async (who, _, taker) => {
            await takeOver(who, taker)
            await revokeBinding(who.repositoryId, taker)
          },
        ],
        [
          "a takeover that was then suspended",
          true,
          async (who, _, taker) => {
            await takeOver(who, taker)
            await suspend(who.repositoryId, "transferred")
          },
        ],
        [
          "a suspension and then a rebind",
          false,
          async (who, binder) => {
            await suspend(who.repositoryId, "deleted")
            await bind(binder, who, T + 10)
          },
        ],
        [
          "a rebind that was then suspended",
          false,
          async (who, binder) => {
            await bind(binder, who, T + 10)
            await suspend(who.repositoryId, "transferred")
          },
        ],
      ]
      for (const [name, recorded, replace] of replacements) {
        const accounts = { binder: randomUUID(), taker: randomUUID() }
        const who = repository()
        const read = await bind(accounts.binder, who, T)
        await replace(who, accounts.binder, accounts.taker)
        const later = await bindingFor(who.repositoryId)
        const counter = await generation(who.repositoryId)
        // Only binder-left is the account's fact: the other reasons concern the binding alone.
        for (const reason of ["transferred", "deleted"] as const) await suspendBinding(read, reason)
        const others = await binderLeft(accounts.binder)
        for (const reason of ["binder-left", "transferred", "deleted"] as const) await suspendBinding(read, reason)
        expect({
          name,
          binding: await bindingFor(who.repositoryId),
          counter: await generation(who.repositoryId),
          others,
          binder: await binderLeft(accounts.binder),
          taker: await binderLeft(accounts.taker),
        }).toStrictEqual({
          name,
          binding: later,
          counter,
          others: [],
          binder: recorded ? [who.repositoryId] : [],
          taker: [],
        })
      }

      // The binding read before its first suspension is still that binding after another caller's suspension moved
      // its generation, so binder-left still replaces the other reason (INV-P3).
      const binder = randomUUID()
      const who = repository()
      const read = await bind(binder, who, T)
      await suspendBinding(read, "transferred")
      await suspendBinding(read, "binder-left")
      expect(await expectGenerationMatches(who.repositoryId)).toMatchObject({ suspended: "binder-left", generation: 2 })
      // A generation the binding never had names no binding, and neither does an account it never had.
      const ahead = repository()
      const bound = await bind(binder, ahead, T)
      const stranger = randomUUID()
      await suspendBinding({ repositoryId: ahead.repositoryId, generation: 2, account: binder }, "deleted")
      await suspendBinding({ ...bound, account: stranger }, "binder-left")
      expect(await bindingFor(ahead.repositoryId)).toStrictEqual(bound)
      expect(await generation(ahead.repositoryId)).toBe("1")
      expect(await redis.send("EXISTS", [`${PREFIX}binder-left:${stranger}`])).toBe(0)
      // Nor does a binding that is gone with a generation the counter never passed, or one that another account's
      // binding, bound no later than it, holds.
      const gone = repository()
      const removed = await bind(binder, gone, T)
      await revokeBinding(gone.repositoryId, binder)
      for (const generation of [2, 3]) await suspendBinding({ ...removed, generation }, "binder-left")
      const taken = repository()
      await bind(binder, taken, T)
      const taker = randomUUID()
      const theirs = await takeOver(taken, taker)
      for (const generation of [2, 3])
        await suspendBinding({ repositoryId: taken.repositoryId, generation, account: binder }, "binder-left")
      await suspend(taken.repositoryId, "deleted")
      await suspendBinding({ repositoryId: taken.repositoryId, generation: 2, account: binder }, "binder-left")
      expect(await bindingFor(taken.repositoryId)).toStrictEqual({ ...theirs, generation: 3, suspended: "deleted" })
      expect(await binderLeft(taker)).toEqual([])
      expect(await binderLeft(binder)).toEqual([who.repositoryId])
    })

    // The binding's own field goes with it on an unbind or a takeover, while the account's run records stay for 90 days
    // (2.18), so the account's binder-left set keeps the fact for V10's and V11's lists (INV-P3).
    test("binder-left outlives the binding for its account, whatever the visibility, until that account binds again", async () => {
      const binder = randomUUID()
      const taker = randomUUID()
      // Public when bound: the stored visibility can be stale by the time the binder leaves, so it decides nothing.
      const taken = repository({ repositoryVisibility: "public" })
      const unbound = repository()
      const rebound = repository()
      const replaced = repository()
      for (const who of [taken, unbound, rebound, replaced]) await bind(binder, who, T)
      await suspend(replaced.repositoryId, "transferred")
      expect(await binderLeft(binder)).toEqual([])
      for (const who of [taken, unbound, rebound, replaced]) await suspend(who.repositoryId, "binder-left")
      const ids = (...list: BindIdentity[]) => list.map((who) => who.repositoryId).sort()
      expect(await binderLeft(binder)).toEqual(ids(taken, unbound, rebound, replaced))

      // Another account takes one over at once (O6), the binder unbinds one, and binds one again itself.
      await bind(taker, { ...taken, actor: "hubot", actorId: "1000001" }, T + 1)
      expect(await revokeBinding(unbound.repositoryId, binder)).toBe(true)
      await bind(binder, rebound, T + 2)
      expect(await bindingFor(rebound.repositoryId)).not.toHaveProperty("suspended")
      expect(await binderLeft(binder)).toEqual(ids(taken, unbound, replaced))
      expect(await binderLeft(taker)).toEqual([])

      // The new binder leaving is the new account's fact; taking the repository back clears only the first account's.
      await suspend(taken.repositoryId, "binder-left")
      expect(await binderLeft(taker)).toEqual(ids(taken))
      await bind(binder, taken, T + 3)
      expect(await binderLeft(binder)).toEqual(ids(unbound, replaced))
      expect(await binderLeft(taker)).toEqual(ids(taken))
    })

    test("a rename changes only the name", async () => {
      const who = repository()
      const bound = await bind(randomUUID(), who, T)
      await renameBinding(who.repositoryId, "octo-renamed/app.js")
      expect(await bindingFor(who.repositoryId)).toStrictEqual({ ...bound, repository: "octo-renamed/app.js" })
      commands.length = 0
      for (const name of ["octo", "octo/app/x", "", "octo/a b"])
        await expect(renameBinding(who.repositoryId, name)).rejects.toMatchObject(INVALID_REQUEST)
      await expect(suspendBinding(bound, "gone" as SuspendReason)).rejects.toMatchObject(INVALID_REQUEST)
      for (const binding of [
        { ...bound, repositoryId: "0" },
        { ...bound, generation: 0 },
        { ...bound, generation: -1 },
        { ...bound, generation: 1.5 },
        { ...bound, generation: Number.NaN },
        { ...bound, generation: 2 ** 53 },
        { ...bound, generation: "1" as unknown as number },
        { ...bound, account: "someone" },
        { ...bound, account: bound.account.toUpperCase() },
      ])
        await expect(suspendBinding(binding, "deleted")).rejects.toMatchObject(INVALID_REQUEST)
      expect(commands).toEqual([])
      expect(await bindingFor(who.repositoryId)).toStrictEqual({ ...bound, repository: "octo-renamed/app.js" })
    })

    test("suspending, renaming or touching an unknown repository creates no key", async () => {
      const who = repository()
      const account = randomUUID()
      for (const reason of ["deleted", "binder-left"] as const)
        await suspendBinding({ repositoryId: who.repositoryId, generation: 1, account }, reason)
      await renameBinding(who.repositoryId, "octo/new")
      await touchBinding(who.repositoryId, T)
      expect(
        await redis.send("EXISTS", [
          bindingKey(who.repositoryId),
          generationKey(who.repositoryId),
          `${PREFIX}binder-left:${account}`,
        ]),
      ).toBe(0)
      expect(await bindingFor(who.repositoryId)).toBeUndefined()
    })
  })

  describe("fail closed (INV-S16)", () => {
    function calls(account: string, who: BindIdentity, code: string) {
      const input = { code, account, identity: who, workflowVersion: "3", takeover: NO_TAKEOVER, now: T + 2 }
      return [
        createBindCode({ account, repository: who.repository, now: T }),
        peekBindCode(code, who, T + 1),
        recordRepoBinding(input),
        redeemAndBind(input),
        bindingFor(who.repositoryId),
        bindingsForAccount(account),
        revokeBinding(who.repositoryId, account),
        touchBinding(who.repositoryId, T + 3),
        suspendBinding({ repositoryId: who.repositoryId, generation: 1, account }, "binder-left"),
        renameBinding(who.repositoryId, "octo/other"),
      ]
    }

    for (const failure of ["down", "corrupt"] as const)
      test(`a store that is ${failure === "down" ? "down" : "answering garbage"} fails every call with 503 and changes nothing`, async () => {
        const account = randomUUID()
        const who = repository()
        const bound = await bind(account, who, T)
        const next = repository()
        const code = await issue(account, next, T)
        state[failure] = true
        const results = await Promise.allSettled([...calls(account, next, code), ...calls(account, who, code)])
        state[failure] = false
        expect(results).toHaveLength(20)
        for (const result of results) {
          expect(result.status).toBe("rejected")
          if (result.status === "rejected") expect(result.reason).toMatchObject(STORE_UNAVAILABLE)
        }
        expect(await bindingFor(who.repositoryId)).toStrictEqual(bound)
        expect(await generation(who.repositoryId)).toBe("1")
        expect(await bindingFor(next.repositoryId)).toBeUndefined()
        expect(await binderLeft(account)).toEqual([])
        expect(await peekBindCode(code, next, T + 1)).toStrictEqual({ account })
      })

    test("a malformed stored binding answers 503 to every reader", async () => {
      const account = randomUUID()
      const corruptions: [string, (fields: Record<string, string>) => Record<string, string>][] = [
        ["an unknown field", (fields) => ({ ...fields, email: "someone@example.com" })],
        ["no generation", ({ generation: _, ...fields }) => fields],
        ["no binder", ({ binderLogin: _, ...fields }) => fields],
        ["generation 0", (fields) => ({ ...fields, generation: "0" })],
        ["a word for a generation", (fields) => ({ ...fields, generation: "two" })],
        ["an unknown visibility", (fields) => ({ ...fields, visibility: "secret" })],
        ["an unknown suspension", (fields) => ({ ...fields, suspended: "gone" })],
        ["an account that is not a UUID", (fields) => ({ ...fields, account: "someone" })],
        ["another repository id", (fields) => ({ ...fields, repositoryId: "1" })],
        ["an owner id in exponent form", (fields) => ({ ...fields, ownerId: "1e5" })],
        ["a negative bind time", (fields) => ({ ...fields, boundAt: "-1" })],
        ["a tag for a default ref", (fields) => ({ ...fields, defaultRef: "refs/tags/v1" })],
      ]
      for (const [name, corrupt] of corruptions) {
        const who = repository()
        await bind(account, who, T)
        const fields = corrupt(await stored(who.repositoryId))
        await redis.send("DEL", [bindingKey(who.repositoryId)])
        await write("HSET", bindingKey(who.repositoryId), Object.entries(fields).flat())
        expect({ name, read: await outcome(bindingFor(who.repositoryId)) }).toEqual({
          name,
          read: expect.stringMatching(/^503 PERSISTENT_STORE_UNAVAILABLE /),
        })
        expect({ name, list: await outcome(bindingsForAccount(account)) }).toEqual({
          name,
          list: expect.stringMatching(/^503 PERSISTENT_STORE_UNAVAILABLE /),
        })
        await redis.send("DEL", [bindingKey(who.repositoryId)])
        await redis.send("SREM", [`${PREFIX}bindings:${account}`, who.repositoryId])
      }
      // A member that is not a repository id fails the list too.
      await write("SADD", `${PREFIX}bindings:${account}`, ["not-an-id"])
      await expect(bindingsForAccount(account)).rejects.toMatchObject(STORE_UNAVAILABLE)
    })

    test("the scripts refuse a corrupt code, binding, counter or account set before any write", async () => {
      const binder = randomUUID()
      const taker = randomUUID()

      const coded = repository()
      const code = `vbc_${randomBytes(32).toString("base64url")}`
      const codeKey = `${PREFIX}bind-code:${sha256(code)}`
      for (const value of ["not json", JSON.stringify(["a"]), JSON.stringify({ account: taker, exp: T * 2 }), "null"]) {
        await write("SET", codeKey, [value])
        await expect(peekBindCode(code, coded, T)).rejects.toMatchObject(STORE_UNAVAILABLE)
        await expect(
          redeemAndBind({ code, account: taker, identity: coded, workflowVersion: "3", takeover: NO_TAKEOVER, now: T }),
        ).rejects.toMatchObject(STORE_UNAVAILABLE)
        expect(await redis.send("GET", [codeKey])).toBe(value)
      }
      expect(await redis.send("EXISTS", [bindingKey(coded.repositoryId), generationKey(coded.repositoryId)])).toBe(0)

      // O6 reads the binding's account, owner, times and suspension, so none of them is read past, whether or not the
      // takeover would otherwise be allowed: a malformed suspension or owner id would itself be grounds for one, and
      // Lua's tonumber reads exponents, hex and padding that the reader refuses.
      const corruptions: [string, (fields: Record<string, string>) => Record<string, string>][] = [
        ["a word for a bind time", (fields) => ({ ...fields, boundAt: "soon" })],
        ["no account", ({ account: _, ...fields }) => fields],
        ["an empty suspension", (fields) => ({ ...fields, suspended: "" })],
        ["an unknown suspension", (fields) => ({ ...fields, suspended: "gone" })],
        ["an owner id in exponent form", (fields) => ({ ...fields, ownerId: "1e5" })],
        ["an owner id past 2^53 - 1", (fields) => ({ ...fields, ownerId: "9007199254740993" })],
        ["a bind time in exponent form", (fields) => ({ ...fields, boundAt: `${T / 1e12}e12` })],
        ["a hex last use", (fields) => ({ ...fields, lastUsedAt: "0x1" })],
        ["a padded last use", (fields) => ({ ...fields, lastUsedAt: ` ${T}` })],
      ]
      const attempts = [
        [NO_TAKEOVER, T + 1],
        [{ adminVerified: true, allowanceInactive: false }, T + O6_WINDOW + 1],
      ] as const
      for (const [name, corrupt] of corruptions) {
        const who = repository()
        await bind(binder, who, T)
        const fields = corrupt(await stored(who.repositoryId))
        await redis.send("DEL", [bindingKey(who.repositoryId)])
        await write("HSET", bindingKey(who.repositoryId), Object.entries(fields).flat())
        for (const [takeover, now] of attempts) {
          const taking = await issue(taker, who, now - 1_000)
          const input = {
            code: taking,
            account: taker,
            current: binder,
            identity: who,
            workflowVersion: "3",
            takeover,
            now,
          }
          expect({ name, now, redeemed: await outcome(redeemAndBind(input)) }).toEqual({
            name,
            now,
            redeemed: expect.stringMatching(/^503 PERSISTENT_STORE_UNAVAILABLE /),
          })
          expect(await stored(who.repositoryId)).toStrictEqual(fields)
          expect(await generation(who.repositoryId)).toBe("1")
          expect(await members(taker)).toEqual([])
          expect(await peekBindCode(taking, who, now)).toStrictEqual({ account: taker })
        }
      }

      const counted = repository()
      await write("SET", generationKey(counted.repositoryId), ["many"])
      const counting = await issue(taker, counted, T)
      await expect(
        redeemAndBind({
          code: counting,
          account: taker,
          identity: counted,
          workflowVersion: "3",
          takeover: NO_TAKEOVER,
          now: T,
        }),
      ).rejects.toMatchObject(STORE_UNAVAILABLE)
      expect(await redis.send("EXISTS", [bindingKey(counted.repositoryId)])).toBe(0)
      expect(await peekBindCode(counting, counted, T)).toStrictEqual({ account: taker })
      // The first suspension moves the counter before it writes the binder-left set or the binding.
      const recounted = repository()
      const recount = await bind(randomUUID(), recounted, T)
      await write("SET", generationKey(recounted.repositoryId), ["many"])
      await expect(suspendBinding(recount, "binder-left")).rejects.toMatchObject(STORE_UNAVAILABLE)
      expect(await stored(recounted.repositoryId)).not.toHaveProperty("suspended")
      expect(await binderLeft(recount.account)).toEqual([])

      // An account set holding another type would fail its SADD or SREM after the earlier writes.
      const listed = repository()
      const misfiled = randomUUID()
      await write("SET", `${PREFIX}bindings:${misfiled}`, ["not a set"])
      const filing = await issue(misfiled, listed, T)
      await expect(
        redeemAndBind({
          code: filing,
          account: misfiled,
          identity: listed,
          workflowVersion: "3",
          takeover: NO_TAKEOVER,
          now: T,
        }),
      ).rejects.toMatchObject(STORE_UNAVAILABLE)
      expect(await redis.send("EXISTS", [bindingKey(listed.repositoryId), generationKey(listed.repositoryId)])).toBe(0)
      expect(await peekBindCode(filing, listed, T)).toStrictEqual({ account: misfiled })
      const kept = repository()
      await bind(binder, kept, T)
      await redis.send("DEL", [`${PREFIX}bindings:${binder}`])
      await write("SET", `${PREFIX}bindings:${binder}`, ["not a set"])
      await expect(revokeBinding(kept.repositoryId, binder)).rejects.toMatchObject(STORE_UNAVAILABLE)
      expect((await bindingFor(kept.repositoryId))?.account).toBe(binder)
      expect(await generation(kept.repositoryId)).toBe("1")

      // A binder-left set holding another type would fail its SADD or SREM after the earlier writes.
      const leaving = repository()
      const leaver = randomUUID()
      const left = await bind(leaver, leaving, T)
      await write("SET", `${PREFIX}binder-left:${leaver}`, ["not a set"])
      await expect(suspendBinding(left, "binder-left")).rejects.toMatchObject(STORE_UNAVAILABLE)
      expect(await bindingFor(leaving.repositoryId)).toStrictEqual(left)
      expect(await generation(leaving.repositoryId)).toBe("1")
      const again = await issue(leaver, leaving, T + 1)
      await expect(
        redeemAndBind({
          code: again,
          account: leaver,
          current: leaver,
          identity: leaving,
          workflowVersion: "3",
          takeover: NO_TAKEOVER,
          now: T + 2,
        }),
      ).rejects.toMatchObject(STORE_UNAVAILABLE)
      expect(await bindingFor(leaving.repositoryId)).toStrictEqual(left)
      expect(await generation(leaving.repositoryId)).toBe("1")
      expect(await peekBindCode(again, leaving, T + 2)).toStrictEqual({ account: leaver })
      expect(await redis.send("GET", [`${PREFIX}binder-left:${leaver}`])).toBe("not a set")

      // A suspension decides on the stored suspension too, so an unknown one is not read as an earlier reason.
      const odd = repository()
      const oddRead = await bind(randomUUID(), odd, T)
      for (const value of ["gone", ""]) {
        await write("HSET", bindingKey(odd.repositoryId), ["suspended", value])
        await expect(suspendBinding(oddRead, "binder-left")).rejects.toMatchObject(STORE_UNAVAILABLE)
        expect(await stored(odd.repositoryId)).toMatchObject({ suspended: value, generation: "1" })
        expect(await generation(odd.repositoryId)).toBe("1")
      }
      expect(await binderLeft(oddRead.account)).toEqual([])

      // A suspension compares the stored generation with the one the caller read, so it cannot read past a bad one.
      const marked = repository()
      const read = await bind(randomUUID(), marked, T)
      for (const value of ["two", "0", "1.0", ""]) {
        await write("HSET", bindingKey(marked.repositoryId), ["generation", value])
        await expect(suspendBinding(read, "binder-left")).rejects.toMatchObject(STORE_UNAVAILABLE)
        expect(await stored(marked.repositoryId)).toMatchObject({ generation: value })
        expect((await stored(marked.repositoryId)).suspended).toBeUndefined()
        expect(await generation(marked.repositoryId)).toBe("1")
      }

      // Binder-left decides on the stored account (another account's binding still records it for the account read),
      // and on the counter once the binding is gone, so it reads past neither.
      const owned = repository()
      const ownedRead = await bind(randomUUID(), owned, T)
      const ownedFields = await stored(owned.repositoryId)
      for (const fields of [
        { ...ownedFields, account: "someone" },
        { ...ownedFields, account: randomUUID().toUpperCase() },
        Object.fromEntries(Object.entries(ownedFields).filter(([name]) => name !== "account")),
      ]) {
        await redis.send("DEL", [bindingKey(owned.repositoryId)])
        await write("HSET", bindingKey(owned.repositoryId), Object.entries(fields).flat())
        await expect(suspendBinding(ownedRead, "binder-left")).rejects.toMatchObject(STORE_UNAVAILABLE)
        expect(await stored(owned.repositoryId)).toStrictEqual(fields)
        expect(await generation(owned.repositoryId)).toBe("1")
      }
      expect(await binderLeft(ownedRead.account)).toEqual([])
      const gone = repository()
      const goneRead = await bind(randomUUID(), gone, T)
      await revokeBinding(gone.repositoryId, goneRead.account)
      for (const value of ["many", "0", "02"]) {
        await write("SET", generationKey(gone.repositoryId), [value])
        await expect(suspendBinding(goneRead, "binder-left")).rejects.toMatchObject(STORE_UNAVAILABLE)
        expect(await generation(gone.repositoryId)).toBe(value)
      }
      expect(await binderLeft(goneRead.account)).toEqual([])
      // A binder-left set of another type fails that late member with nothing written.
      await write("SET", generationKey(gone.repositoryId), ["2"])
      await write("SET", `${PREFIX}binder-left:${goneRead.account}`, ["not a set"])
      await expect(suspendBinding(goneRead, "binder-left")).rejects.toMatchObject(STORE_UNAVAILABLE)
      expect(await redis.send("GET", [`${PREFIX}binder-left:${goneRead.account}`])).toBe("not a set")
    })
  })

  // 2.5's binding shape, and the verified identity V10 passes in. V08 adds repositoryVisibility to GithubIdentity and
  // must keep it assignable. bun test does not check types; packages/web's typecheck checks this file.
  test("the binding has 2.5's shape, and a verified identity is a bind identity", () => {
    type Equal<A, B> = (<X>() => X extends A ? 1 : 2) extends <X>() => X extends B ? 1 : 2 ? true : false
    type Section25 = {
      repositoryId: string
      ownerId: string
      repository: string
      account: string
      visibility: "public" | "private" | "internal"
      defaultRef: string
      generation: number
      binder: { githubId: string; login: string }
      workflowVersion: string
      boundAt: number
      lastUsedAt?: number
      suspended?: "transferred" | "deleted" | "binder-left"
    }
    const shape: Equal<RepoBinding, Section25> = true
    const identity: GithubIdentity extends BindIdentity ? true : false = true
    expect([shape, identity]).toEqual([true, true])
  })
}
