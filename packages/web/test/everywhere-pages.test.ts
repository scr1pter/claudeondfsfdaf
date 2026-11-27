import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test"
import { generateKeyPairSync, randomBytes, randomUUID } from "node:crypto"
import path from "node:path"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import {
  AUDIT_PAGE,
  HISTORY_LIMIT,
  createAccountApi,
  type AccountApiDeps,
} from "../../../api/_lib/everywhere/account-api"
import { AUDIT_CODES, AUDIT_EVENTS, appendAudit } from "../../../api/_lib/everywhere/audit"
import { readConfig, type OfferKey } from "../../../api/_lib/everywhere/config"
import type { InstallRevoker, JobEraser } from "../../../api/_lib/everywhere/erase"
import {
  CODE_ALPHABET,
  LINK_CODE_CHARS,
  OAUTH,
  PLACE_PATTERN,
  findInstall,
  findLink,
  issueConnectCode,
  listMappings,
  recordInstall,
  redeemLinkCode,
  unlink,
  type IdentityContext,
  type LinkActor,
} from "../../../api/_lib/everywhere/identity"
import {
  claimJob,
  clearSummary,
  createJob,
  jobEraser,
  offerJob,
  refuseJob,
  settleJob,
  type JobRecord,
  type JobsContext,
  type NewJob,
} from "../../../api/_lib/everywhere/jobs"
import { KEEP_MS, USER_ID_PATTERNS, everywhereKeys } from "../../../api/_lib/everywhere/keys"
import { linearOAuthCallback } from "../../../api/_lib/everywhere/linear/install"
import { platformExchanges } from "../../../api/_lib/everywhere/oauth-exchanges"
import { slackOAuthCallback } from "../../../api/_lib/everywhere/slack/install"
import { storeUnavailable } from "../../../api/_lib/everywhere/store"
import {
  DECLINE_CODES,
  JOB_STATES,
  OUTCOMES,
  PLATFORMS,
  REFUSAL_CODES,
  installationPlatform,
  type Settle,
} from "../../../packages/schema/src/everywhere"
import { ENDINGS, WITHHELD } from "../../../packages/schema/src/everywhere-policy"
import {
  AUDIT_LIMIT,
  EVERYWHERE_AUDIT_CODES,
  EVERYWHERE_AUDIT_EVENTS,
  EVERYWHERE_AUTHORIZE,
  EVERYWHERE_COPY,
  EVERYWHERE_ROUTES,
  GITHUB_USER_ID_PATTERN,
  JOB_ENDINGS,
  JOBS_LIMIT,
  LINK_CODE_MS,
  LINK_CODE_PATTERN,
  LINK_USER_ID_PATTERNS,
  PLACE_ID_PATTERN,
  PLATFORM_NAMES,
  connectAccountSession,
  createEverywhereAccountModel,
  focusJob,
  formatTime,
  installationLabel,
  landingProblemOf,
  placeLabel,
  problemOf,
  readAuditEntries,
  readAuthorize,
  readFinish,
  readInstalls,
  readJobs,
  readLinkCode,
  readLinks,
  readMappings,
  readOAuthReturn,
  signInPath,
  takeInstallIntent,
  takeOAuthReturn,
  type EverywhereAccountModel,
  type EverywhereAuth,
  type EverywhereAuthSession,
  type EverywhereLandingProblem,
  type EverywhereOAuthReturn,
  type EverywhereReady,
  type OAuthPlace,
} from "../src/components/marketing/everywhere/everywhere-model"
import {
  everywhereEnv,
  FakeAccounts,
  FakeJira,
  RouteHarness,
  testAccount,
  type TestAccount,
} from "./lib/everywhere-account"
import { installFetchGuard } from "./lib/everywhere-fetch-guard"
import { seedJobAuthority } from "./lib/everywhere-job-authority"
import { FakeLinear } from "./lib/everywhere-linear"
import { FakeSlack } from "./lib/everywhere-slack"
import {
  FAKE_KV_URL,
  FakeStore,
  realRedis,
  testAccountAuthority,
  testEverywhereStore,
  useKv,
} from "./lib/everywhere-store"
import { missingAccountAuthority } from "../../../api/_lib/everywhere/authority"
import { tombstoneKey } from "../../../api/_lib/codium-tombstone"
import { safeReturnPath } from "../src/lib/account-client"

// As in account-page.test.ts: this package's tsconfig compiles JSX for Solid, and Astro builds the React islands
// itself, so the everywhere components are compiled here with React's automatic runtime.
const react = new Bun.Transpiler({
  loader: "tsx",
  autoImportJSX: true,
  tsconfig: { compilerOptions: { jsx: "react-jsx", jsxImportSource: "react" } },
})
Bun.plugin({
  name: "react islands",
  setup(build) {
    build.onLoad({ filter: /components\/marketing\/(everywhere|account|download)\/[^/]+\.tsx$/ }, async (args) => ({
      contents: react.transformSync(await Bun.file(args.path).text()),
      loader: "js",
    }))
  },
})
const { EverywhereAccountView, EverywhereLinkView } = await import(
  "../src/components/marketing/everywhere/EverywhereView"
)
const { EverywhereAccount } = await import("../src/components/marketing/everywhere/EverywhereAccount")
const { EverywhereLink } = await import("../src/components/marketing/everywhere/EverywhereLink")

installFetchGuard()

/*
 * VE-42 (EV-22 and EV-23): the vectordev.ai pages for Vector everywhere, at model level. The model drives the real
 * account routes (createAccountApi) on 127.0.0.1 with the real bearer check against FakeAccounts, and the views are
 * rendered from its state with renderToStaticMarkup. EV-23 adds the OAuth landing (the real Slack and Linear callbacks
 * against FakeSlack and FakeLinear), the Linear link page, the jobs (seeded through the real job state machine) and the
 * audit log, and pins that the two draft pages are not routed. Nothing here reaches a platform, a browser or the
 * network.
 */

const accounts = new FakeAccounts()
const harness = new RouteHarness()
const jira = new FakeJira()
const slack = new FakeSlack()
const linear = new FakeLinear()
let restore: () => void
beforeAll(async () => {
  restore = useKv()
  accounts.start()
  jira.start()
  slack.start()
  linear.start()
  await harness.start()
})
afterAll(async () => {
  restore()
  await accounts.stop()
  await jira.stop()
  await slack.stop()
  await linear.stop()
  await harness.stop()
})

const alice = accounts.add(testAccount("alice@example.com"))
const bob = accounts.add(testAccount("bob@example.org"))
// Alice's session after Supabase refreshed it: the same account, a new token.
const aliceRefreshed = accounts.add({ ...alice, token: `session-${randomBytes(18).toString("base64url")}` })
const SLACK = "slack:T0123ABCD"
const SLACK_OTHER = "slack:T0999ZZZZ"
const LINEAR = `linear:${randomUUID()}`
const TEAM = randomUUID()
const CLOUD = randomUUID()
const JIRA = `jira:${CLOUD}`
const JIRA_USER = `557058:${randomUUID()}`
const person: LinkActor = { bot: false, external: false, guest: false }
const adminToken = `admin-${randomBytes(12).toString("hex")}`
jira.admins.add(adminToken)

let fake: FakeStore
let env: Record<string, string>
let erasedJobs: string[]
let jobs: JobEraser

function deps(extra: Partial<AccountApiDeps> = {}): AccountApiDeps {
  return {
    env,
    store: testEverywhereStore(fake.fetch),
    accountAuthority: testAccountAuthority,
    now: () => fake.clock.now,
    notify: async () => {},
    // Replacing the exchanges keeps the default Slack and Linear revocation off the network.
    exchanges: {},
    jobs,
    ...extra,
  }
}

function ctx(): IdentityContext {
  return {
    store: testEverywhereStore(fake.fetch),
    keys: readConfig(env).dataKeys,
    now: fake.clock.now,
    accountAuthority: testAccountAuthority,
  }
}

beforeEach(() => {
  fake = new FakeStore()
  env = everywhereEnv()
  erasedJobs = []
  jobs = {
    installation: async (installation) => {
      erasedJobs.push(installation)
    },
    account: async () => {},
  }
  accounts.calls = 0
  mountAccount(createAccountApi(deps()))
})

type Handlers = Parameters<RouteHarness["mount"]>[0]

/** Every account route at its path, EV-23's two reads included, and anything else a case needs. */
function mountAccount(api: ReturnType<typeof createAccountApi>, extra: Handlers = {}) {
  harness.mount({
    [EVERYWHERE_ROUTES.link]: api.link,
    [EVERYWHERE_ROUTES.links]: api.links,
    [EVERYWHERE_ROUTES.installs]: api.installs,
    [EVERYWHERE_ROUTES.repos]: api.repos,
    [EVERYWHERE_ROUTES.oauthFinish]: api.oauthFinish,
    [EVERYWHERE_ROUTES.history]: api.history,
    [EVERYWHERE_ROUTES.audit]: api.audit,
    ...extra,
  })
}

type Call = { readonly path: string; readonly init: RequestInit }
type Request = (path: string, init: RequestInit) => Promise<Response>
const loopback: Request = (route, init) => fetch(harness.origin + route, init)

/** A browser: the model with a recording request, a recording navigation and a manual timer. */
function browser(request: Request = loopback, extra: { readonly activity?: boolean } = {}) {
  const calls: Call[] = []
  const navigations: string[] = []
  const timers: { ms: number; run: () => void; cancelled: boolean }[] = []
  const signOuts: string[] = []
  const model = createEverywhereAccountModel({
    request: (route, init) => {
      calls.push({ path: route, init })
      return request(route, init)
    },
    navigate: (url) => {
      navigations.push(url)
    },
    schedule: (ms, run) => {
      const timer = { ms, run, cancelled: false }
      timers.push(timer)
      return () => {
        timer.cancelled = true
      }
    },
    signOut: async () => {
      signOuts.push("local")
    },
    ...extra,
  })
  return { model, calls, navigations, timers, signOuts }
}

const as = (account: TestAccount) => ({ account: account.id, token: account.token })

function render(model: EverywhereAccountModel, pathname = "/everywhere") {
  return renderToStaticMarkup(createElement(EverywhereAccountView, { state: model.state(), model, pathname }))
}

function ready(model: EverywhereAccountModel): EverywhereReady {
  const state = model.state()
  if (state.kind !== "ready") throw new Error(`The model is ${state.kind}, not ready.`)
  return state
}

function headers(call: Call) {
  return call.init.headers as Record<string, string>
}

function count(text: string, part: string) {
  return text.split(part).length - 1
}

function gate() {
  let open!: () => void
  const opened = new Promise<void>((resolve) => {
    open = resolve
  })
  return { open, opened }
}

/** Sends matching requests to the route without the model's abort signal, then holds the answer until the gate opens. */
function held(
  match: (route: string, init: RequestInit) => boolean,
  door: { opened: Promise<void> },
  seen: unknown[] = [],
): Request {
  return (route, init) => {
    if (!match(route, init)) return loopback(route, init)
    return fetch(harness.origin + route, { ...init, signal: undefined }).then(async (response) => {
      const body: unknown = await response.json()
      seen.push(body)
      await door.opened
      return Response.json(body, { status: response.status })
    })
  }
}

async function until(check: () => boolean, label: string) {
  for (let attempt = 0; attempt < 400; attempt++) {
    if (check()) return
    await Bun.sleep(5)
  }
  throw new Error(`Timed out waiting for ${label}.`)
}

async function install(installation: string, account: TestAccount, scopes: string[] = [], token?: string) {
  const verdict = await recordInstall(ctx(), {
    account: account.id,
    event: "install",
    grant: { installation, scopes, installer: { admin: true }, ...(token ? { token } : {}) },
  })
  expect(verdict.ok).toBe(true)
}

async function linkCode(account: TestAccount, platform: "slack" | "jira") {
  const answer = await harness.call("POST", EVERYWHERE_ROUTES.link, { token: account.token, body: { platform } })
  expect(answer.status).toBe(200)
  return answer.body.code as string
}

async function link(account: TestAccount, installation: string, userId: string) {
  const code = await linkCode(account, installation.startsWith("jira:") ? "jira" : "slack")
  expect((await redeemLinkCode(ctx(), { code, installation, userId, place: "private", actor: person })).ok).toBe(true)
}

async function map(
  installation: string,
  place: string,
  repositories: { fullName: string; id: number }[],
  marked?: boolean,
) {
  const answer = await harness.call("PUT", EVERYWHERE_ROUTES.repos, {
    token: alice.token,
    body: { installation, place, repositories, ...(marked === undefined ? {} : { private: marked }) },
  })
  expect(answer.status).toBe(200)
}

async function connectCode() {
  const issued = await issueConnectCode(
    ctx(),
    { cloudId: CLOUD, accountId: `557058:${randomUUID()}`, userToken: adminToken },
    jira.fetch,
  )
  if (!issued.ok) throw new Error("no connect code")
  return issued.code
}

describe("signed out, the root and the sign-in link", () => {
  test("before a session the view shows loading; signed out it shows only the sign-in prompt and sends nothing", async () => {
    const b = browser()
    expect(render(b.model)).toContain(EVERYWHERE_COPY.loading)
    await b.model.setSession(undefined)
    const html = render(b.model)
    expect(html).toContain(EVERYWHERE_COPY.signIn)
    expect(html).toContain('href="/login?returnTo=%2Feverywhere"')
    expect(html).not.toContain("<button")
    expect(html).not.toContain("link ")
    expect(b.calls).toEqual([])
    // Nothing a signed-out page can do sends a request.
    await b.model.issueCode("slack")
    await b.model.startInstall("slack")
    await b.model.connectJira("ABCD-EFGH-JKMN")
    await b.model.refresh()
    expect(b.calls).toEqual([])
  })

  test("the root renders loading and sends nothing until it runs in a browser", () => {
    const html = renderToStaticMarkup(createElement(EverywhereAccount))
    expect(html).toContain(EVERYWHERE_COPY.loading)
    expect(accounts.calls).toBe(0)
  })

  test("the sign-in link carries this page's path only", () => {
    expect(signInPath("/everywhere")).toBe("/login?returnTo=%2Feverywhere")
    expect(signInPath("/everywhere?x=1#platform=slack&code=C0DE&state=S7A7E")).toBe("/login?returnTo=%2Feverywhere")
    expect(signInPath("/everywhere/link")).toBe("/login?returnTo=%2Feverywhere%2Flink")
    for (const outside of ["//evil.example/x", "https://evil.example", "/\\evil.example", "everywhere", ""])
      expect(signInPath(outside)).toBe("/login?returnTo=%2Feverywhere")
  })

  test("a signed-out job link carries only the selected job through account sign-in", async () => {
    const job = forgedJob()
    const focus = focusJob(`?job=${job.jid}&code=C0DE&state=S7A7E`)
    const b = browser(forgedHistory({ jobs: [job], capped: false, skipped: 0 }), { activity: true })
    await b.model.setSession(undefined)
    const login = new URL(hrefs(renderFocused(b.model, focus))[0]!, "https://vectordev.ai")
    const returned = safeReturnPath(login.searchParams.get("returnTo"))
    expect(login.pathname).toBe("/login")
    expect(returned).toBe(`/everywhere?job=${job.jid}`)
    expect(login.href).not.toContain("C0DE")
    expect(login.href).not.toContain("S7A7E")
    expect(b.calls).toEqual([])

    await b.model.setSession(as(alice))
    const returnedFocus = focusJob(new URL(returned, login).search)
    expect(renderFocused(b.model, returnedFocus)).toContain(
      `<li id="job-${job.jid}" class="everywhere-job everywhere-focus" aria-current="true">`,
    )
  })

  test("sign-in only carries a valid job on the everywhere account page", () => {
    const job = forgedJob()
    expect(signInPath("/everywhere?code=C0DE#state=S7A7E", job.jid)).toBe(
      `/login?returnTo=%2Feverywhere%3Fjob%3D${job.jid}`,
    )
    expect(signInPath("/everywhere/", job.jid)).toBe(`/login?returnTo=%2Feverywhere%2F%3Fjob%3D${job.jid}`)
    expect(signInPath("/everywhere", "vej_bad&returnTo=//evil.example")).toBe("/login?returnTo=%2Feverywhere")
    expect(signInPath("/everywhere/link", job.jid)).toBe("/login?returnTo=%2Feverywhere%2Flink")
    expect(signInPath("//evil.example/everywhere", job.jid)).toBe("/login?returnTo=%2Feverywhere")
  })

  test("a session the server refuses asks to sign in again, ending the browser's session first", async () => {
    const ghost = testAccount("ghost@example.com")
    const b = browser()
    await b.model.setSession(as(ghost))
    expect(b.model.state().kind).toBe("session-expired")
    const html = render(b.model)
    expect(html).toContain(EVERYWHERE_COPY.expired)
    expect(html).toContain(EVERYWHERE_COPY.expiredButton)
    // A link to /login would bounce straight back while Supabase still holds the refused session.
    expect(html).not.toContain("href=")
    const job = forgedJob()
    await b.model.signInAgain("/everywhere?code=C0DE", job.jid)
    expect(b.signOuts).toEqual(["local"])
    expect(b.navigations).toEqual([`/login?returnTo=%2Feverywhere%3Fjob%3D${job.jid}`])
    // The same account with a token the server accepts recovers without a reload.
    const renewed = accounts.add({ ...ghost, token: `session-${randomBytes(18).toString("base64url")}` })
    await b.model.setSession(as(renewed))
    expect(ready(b.model).loaded).toBe(true)
    expect(headers(b.calls.at(-1)!).authorization).toBe(`Bearer ${renewed.token}`)
  })
})

describe("following the browser's sign-in", () => {
  function fakeAuth() {
    const listeners: ((event: string, session: EverywhereAuthSession | null) => void)[] = []
    const unsubscribed: string[] = []
    let answer!: (value: Awaited<ReturnType<EverywhereAuth["getSession"]>>) => void
    const pending = new Promise<Awaited<ReturnType<EverywhereAuth["getSession"]>>>((resolve) => {
      answer = resolve
    })
    const auth: EverywhereAuth = {
      onAuthStateChange(callback) {
        listeners.push(callback)
        return { data: { subscription: { unsubscribe: () => void unsubscribed.push("unsubscribed") } } }
      },
      getSession: () => pending,
    }
    return {
      auth,
      emit: (event: string, session: EverywhereAuthSession | null) =>
        listeners.forEach((listener) => listener(event, session)),
      answer,
      unsubscribed,
    }
  }
  const supabase = (account: TestAccount): EverywhereAuthSession => ({
    user: { id: account.id },
    access_token: account.token,
  })

  test("auth events drive the model, and a late getSession cannot put back an older token", async () => {
    const b = browser()
    const fakes = fakeAuth()
    const disconnect = connectAccountSession(b.model, Promise.resolve(fakes.auth))
    await until(() => fakes.unsubscribed.length === 0 && b.model.state().kind === "loading", "the subscription")
    fakes.emit("INITIAL_SESSION", supabase(alice))
    await until(() => b.model.state().kind === "ready" && ready(b.model).loaded, "alice's lists")
    fakes.emit("TOKEN_REFRESHED", supabase(aliceRefreshed))
    fakes.answer({ data: { session: supabase(alice) }, error: null })
    await Bun.sleep(5)
    await b.model.refresh()
    expect(headers(b.calls.at(-1)!).authorization).toBe(`Bearer ${aliceRefreshed.token}`)
    fakes.emit("SIGNED_OUT", null)
    expect(b.model.state().kind).toBe("signed-out")
    disconnect()
    expect(fakes.unsubscribed).toEqual(["unsubscribed"])
    fakes.emit("SIGNED_IN", supabase(bob))
    expect(b.model.state().kind).toBe("signed-out")
  })

  test("with no event yet, getSession's answer is used; a client that fails leaves accounts unavailable", async () => {
    const first = browser()
    const quiet = fakeAuth()
    connectAccountSession(first.model, Promise.resolve(quiet.auth))
    quiet.answer({ data: { session: supabase(bob) }, error: null })
    await until(() => first.model.state().kind === "ready" && ready(first.model).loaded, "bob's lists")
    expect(headers(first.calls[0]!).authorization).toBe(`Bearer ${bob.token}`)

    const second = browser()
    const broken = fakeAuth()
    connectAccountSession(second.model, Promise.resolve(broken.auth))
    broken.answer({ data: { session: null }, error: new Error("storage") })
    await until(() => second.model.state().kind === "accounts-unavailable", "the getSession error")

    const third = browser()
    connectAccountSession(third.model, Promise.reject(new Error("Vector accounts are temporarily unavailable.")))
    await until(() => third.model.state().kind === "accounts-unavailable", "the client failure")
    expect(render(third.model)).toContain(EVERYWHERE_COPY.accountsUnavailable)
    expect([...second.calls, ...third.calls]).toEqual([])
  })
})

describe("recovering after a failure", () => {
  test("Try again after a failed first load clears that problem once the lists load", async () => {
    await install(SLACK, alice)
    let failures = 1
    const b = browser((route, init) =>
      route === EVERYWHERE_ROUTES.installs && init.method === "GET" && failures-- > 0
        ? Promise.resolve(Response.json({ error: { code: "EVERYWHERE_UNAVAILABLE" } }, { status: 503 }))
        : loopback(route, init),
    )
    await b.model.setSession(as(alice))
    expect(ready(b.model).loaded).toBe(false)
    expect(ready(b.model).problem).toBe("unavailable")
    const failed = render(b.model)
    expect(failed).toContain(EVERYWHERE_COPY.problem.unavailable)
    expect(failed).toContain(`>${EVERYWHERE_COPY.retry}</button>`)
    // What the Try again button calls.
    await b.model.refresh()
    expect(ready(b.model).loaded).toBe(true)
    expect(ready(b.model).problem).toBeUndefined()
    const html = render(b.model)
    expect(html).not.toContain(EVERYWHERE_COPY.problem.unavailable)
    expect(html).not.toContain(`>${EVERYWHERE_COPY.retry}</button>`)
    expect(html).toContain("Slack workspace T0123ABCD")
  })

  test("a request sent with the refused token cannot expire the renewed session", async () => {
    await install(SLACK, alice)
    const carol = accounts.add(testAccount("carol@example.com"))
    const refused = new Set<string>()
    const door = gate()
    const b = browser(async (route, init) => {
      // The routes' answer to a token they no longer accept (requireAccountUser), given here for writes: the
      // loopback harness cannot close once a route has refused a request body it never read.
      if (init.body !== undefined && refused.has(headers({ path: route, init }).authorization!)) {
        if (route === EVERYWHERE_ROUTES.link) await door.opened
        return Response.json({ error: { code: "SESSION_INVALID" } }, { status: 401 })
      }
      return loopback(route, init)
    })
    await b.model.setSession(as(carol))
    expect(ready(b.model).loaded).toBe(true)
    // The server stops accepting the token the page still holds.
    accounts.accounts.delete(carol.token)
    refused.add(`Bearer ${carol.token}`)
    const code = b.model.issueCode("slack")
    await b.model.unlink(SLACK, "U0CCC3333")
    expect(b.model.state().kind).toBe("session-expired")
    const renewed = accounts.add({ ...carol, token: `session-${randomBytes(18).toString("base64url")}` })
    await b.model.setSession(as(renewed))
    expect(ready(b.model).loaded).toBe(true)
    // The code request's 401 for the old token arrives after the recovery and is dropped.
    door.open()
    await code
    expect(b.model.state().kind).toBe("ready")
    expect(render(b.model)).not.toContain(EVERYWHERE_COPY.expired)
    expect(
      b.calls.filter((call) => call.path === EVERYWHERE_ROUTES.link).map((call) => headers(call).authorization),
    ).toEqual([`Bearer ${carol.token}`])
    // Later calls carry the renewed token, and the server takes them.
    await b.model.issueCode("slack")
    expect(ready(b.model).code?.code).toMatch(LINK_CODE_PATTERN)
    expect(headers(b.calls.at(-1)!).authorization).toBe(`Bearer ${renewed.token}`)
  })
})

describe("the feature off", () => {
  test("with Vector everywhere off the page says so, offers nothing and the routes read nothing", async () => {
    env = {}
    harness.use(createAccountApi(deps()))
    const b = browser()
    await b.model.setSession(as(alice))
    expect(b.model.state().kind).toBe("off")
    const html = render(b.model)
    expect(html).toContain(EVERYWHERE_COPY.off)
    expect(html).not.toContain("<button")
    expect(b.calls.map((call) => [call.init.method, call.path])).toEqual([
      ["GET", EVERYWHERE_ROUTES.installs],
      ["GET", EVERYWHERE_ROUTES.links],
    ])
    for (const call of b.calls) expect(headers(call).authorization).toBe(`Bearer ${alice.token}`)
    expect(accounts.calls).toBe(0)
    expect(fake.commands).toEqual([])
  })
})

// EV-27: with no store or authority injected, the account routes build their own store, which must carry Codium's
// account authority; only an explicitly missing authority answers 503.
describe("the default store", () => {
  test("carries Codium's account authority, and only a missing one is unverified", async () => {
    const fetcher = ((input: RequestInfo | URL, init?: RequestInit) =>
      String(input instanceof Request ? input.url : input).startsWith(FAKE_KV_URL)
        ? fake.fetch(input, init)
        : fetch(input, init)) as typeof fetch
    const links = async () => {
      const answer = await harness.call("GET", EVERYWHERE_ROUTES.links, { token: alice.token })
      return { status: answer.status, code: answer.body.error?.code }
    }
    harness.use(createAccountApi(deps({ store: undefined, accountAuthority: undefined, fetcher })))
    expect(await links()).toEqual({ status: 200, code: undefined })
    fake.send(["SET", tombstoneKey(alice.id.toLowerCase()), JSON.stringify({ erased: true })])
    expect(await links()).toEqual({ status: 409, code: "EVERYWHERE_AUTHORITY_CHANGED" })
    fake.send(["DEL", tombstoneKey(alice.id.toLowerCase())])
    harness.use(createAccountApi(deps({ store: undefined, accountAuthority: missingAccountAuthority, fetcher })))
    expect(await links()).toEqual({ status: 503, code: "EVERYWHERE_ACCOUNT_UNVERIFIED" })
  })
})

describe("routes, bearer token and URLs", () => {
  test("every call goes to an account route with the bearer token, and no URL carries an account id, email or code", async () => {
    await install(SLACK, alice, ["chat:write", "app_mentions:read"])
    await install(LINEAR, alice)
    await install(SLACK_OTHER, bob)
    const b = browser()
    await b.model.setSession(as(alice))
    const issued: string[] = []
    const html: string[] = [render(b.model)]
    await b.model.issueCode("slack")
    issued.push(ready(b.model).code!.code)
    html.push(render(b.model))
    expect(
      (
        await redeemLinkCode(ctx(), {
          code: issued[0]!,
          installation: SLACK,
          userId: "U0AAA1111",
          place: "private",
          actor: person,
        })
      ).ok,
    ).toBe(true)
    await b.model.issueCode("jira")
    issued.push(ready(b.model).code!.code)
    html.push(render(b.model))
    await b.model.startLink()
    await b.model.startInstall("slack")
    const connect = await connectCode()
    await b.model.connectJira(connect)
    expect(ready(b.model).notice).toBe("connected")
    await map(SLACK, "C0123", [
      { fullName: "acme/api", id: 7 },
      { fullName: "acme/web", id: 8 },
    ])
    await map(LINEAR, TEAM, [{ fullName: "acme/app", id: 9 }])
    await map(JIRA, "ENG", [{ fullName: "acme/tools", id: 10 }])
    await b.model.refresh()
    html.push(render(b.model))
    b.model.ask({ action: "drop-repository", installation: SLACK, place: "C0123", fullName: "acme/web" })
    await b.model.confirm()
    b.model.ask({ action: "remove-mapping", installation: JIRA, place: "ENG" })
    await b.model.confirm()
    html.push(render(b.model))
    await b.model.unlink(SLACK, "U0AAA1111")
    b.model.ask({ action: "disconnect", installation: LINEAR })
    html.push(render(b.model))
    await b.model.confirm()
    html.push(render(b.model))

    const expected: Record<string, readonly string[]> = {
      [EVERYWHERE_ROUTES.installs]: ["GET", "POST", "DELETE"],
      [EVERYWHERE_ROUTES.links]: ["GET", "DELETE"],
      [EVERYWHERE_ROUTES.link]: ["POST"],
      [EVERYWHERE_ROUTES.repos]: ["GET", "PUT", "DELETE"],
    }
    const listed = new Set([SLACK, LINEAR, JIRA])
    const seen = new Set<string>()
    for (const call of b.calls) {
      const url = new URL(call.path, harness.origin)
      const method = call.init.method!
      seen.add(`${method} ${url.pathname}`)
      expect(expected[url.pathname]).toContain(method)
      expect(headers(call).authorization).toBe(`Bearer ${alice.token}`)
      expect(headers(call).accept).toBe("application/json")
      expect(call.init.credentials).toBe("omit")
      expect(call.init.cache).toBe("no-store")
      expect(call.init.redirect).toBe("error")
      expect(headers(call)["content-type"] ?? "none").toBe(call.init.body === undefined ? "none" : "application/json")
      expect(call.init.body === undefined).toBe(method === "GET")
      // The only query anywhere: the installation on GET repos, one the account listed.
      if (method === "GET" && url.pathname === EVERYWHERE_ROUTES.repos) {
        expect([...url.searchParams.keys()]).toEqual(["installation"])
        expect(listed.has(url.searchParams.get("installation")!)).toBe(true)
      }
      if (!(method === "GET" && url.pathname === EVERYWHERE_ROUTES.repos)) expect(url.search).toBe("")
    }
    expect(seen).toEqual(
      new Set(Object.entries(expected).flatMap(([route, methods]) => methods.map((method) => `${method} ${route}`))),
    )
    expect(b.calls.some((call) => call.path.includes("oauth-finish"))).toBe(false)
    expect(accounts.calls).toBeGreaterThan(0)
    expect(b.navigations.map((url) => new URL(url).origin + new URL(url).pathname)).toEqual([
      EVERYWHERE_AUTHORIZE.linear,
      EVERYWHERE_AUTHORIZE.slack,
    ])

    const hrefs = html.flatMap((page) => [...page.matchAll(/href="([^"]*)"/g)].map((match) => match[1]!))
    const urls = [...b.calls.map((call) => call.path), ...b.navigations, ...hrefs]
    const secrets = [
      alice.id,
      alice.id.toUpperCase(),
      alice.email,
      encodeURIComponent(alice.email),
      alice.token,
      connect,
      connect.replace(/-/g, ""),
      ...issued,
      ...issued.map((code) => code.replace(/-/g, "")),
    ]
    for (const url of urls) for (const secret of secrets) expect(url).not.toContain(secret)
    for (const page of html) expect(page).not.toContain("<form")
    // The Jira connect code went in a body, never a URL, and links were seen in the body only.
    expect(b.calls.filter((call) => String(call.init.body ?? "").includes(connect))).toHaveLength(1)
  })
})

describe("link codes", () => {
  test("a token refresh keeps the code and the lists; later calls carry the new token", async () => {
    await install(SLACK, alice)
    const b = browser()
    await b.model.setSession(as(alice))
    await b.model.issueCode("slack")
    const before = ready(b.model)
    await b.model.setSession(as(aliceRefreshed))
    expect(ready(b.model).code).toEqual(before.code)
    expect(ready(b.model).installs).toEqual(before.installs)
    expect(b.timers.filter((timer) => timer.cancelled)).toEqual([])
    await b.model.refresh()
    expect(headers(b.calls.at(-1)!).authorization).toBe(`Bearer ${aliceRefreshed.token}`)
  })

  test("the signed-in account's code: the pattern, shown once with the right note, linking to that account", async () => {
    await install(SLACK, bob)
    const b = browser()
    await b.model.setSession(as(alice))
    await b.model.issueCode("slack")
    const code = ready(b.model).code!
    expect(code.platform).toBe("slack")
    expect(code.code).toMatch(LINK_CODE_PATTERN)
    const html = render(b.model)
    expect(count(html, code.code)).toBe(1)
    expect(html).toContain(`link ${code.code}`)
    expect(html).toContain(EVERYWHERE_COPY.codeNote.slack)
    expect(html).toContain(EVERYWHERE_COPY.codeExpiry)
    expect(
      await redeemLinkCode(ctx(), {
        code: code.code,
        installation: SLACK,
        userId: "U0AAA1111",
        place: "private",
        actor: person,
      }),
    ).toMatchObject({ ok: true, account: alice.id })
    await b.model.issueCode("jira")
    const jiraHtml = render(b.model)
    expect(jiraHtml).toContain(EVERYWHERE_COPY.codeNote.jira)
    expect(jiraHtml).not.toContain(EVERYWHERE_COPY.codeNote.slack)
  })

  test("a code is never shown from another account's answer", async () => {
    // A code on screen goes with its account: another account, or signing out and back in, starts with none.
    const shown = browser()
    await shown.model.setSession(as(alice))
    await shown.model.issueCode("slack")
    const visible = ready(shown.model).code!.code
    await shown.model.setSession(as(bob))
    expect(ready(shown.model).code).toBeUndefined()
    expect(render(shown.model)).not.toContain(visible)
    expect(shown.timers.map((timer) => timer.cancelled)).toEqual([true])
    await shown.model.setSession(undefined)
    await shown.model.setSession(as(alice))
    expect(ready(shown.model).code).toBeUndefined()

    const door = gate()
    const answers: unknown[] = []
    const b = browser(held((route, init) => route === EVERYWHERE_ROUTES.link && init.method === "POST", door, answers))
    await b.model.setSession(as(alice))
    const pending = b.model.issueCode("slack")
    await until(() => answers.length === 1, "alice's code")
    const aliceCode = (answers[0] as { code: string }).code
    await b.model.setSession(as(bob))
    door.open()
    await pending
    expect(ready(b.model).code).toBeUndefined()
    expect(render(b.model)).not.toContain(aliceCode)

    // Signed out in between, and alice → bob → alice with the first request still on its way.
    for (const steps of [[undefined], [as(bob), as(alice)]] as const) {
      const again = gate()
      const seen: unknown[] = []
      const c = browser(held((route, init) => route === EVERYWHERE_ROUTES.link && init.method === "POST", again, seen))
      await c.model.setSession(as(alice))
      const asked = c.model.issueCode("slack")
      await until(() => seen.length === 1, "the held code")
      for (const step of steps) await c.model.setSession(step)
      again.open()
      await asked
      const state = c.model.state()
      expect(state.kind === "ready" ? state.code : undefined).toBeUndefined()
      expect(render(c.model)).not.toContain((seen[0] as { code: string }).code)
    }

    // Alice's list arriving after the switch does not fill bob's page.
    await install(SLACK, alice)
    const list = gate()
    const lists: unknown[] = []
    const d = browser(held((route, init) => route === EVERYWHERE_ROUTES.installs && init.method === "GET", list, lists))
    const first = d.model.setSession(as(alice))
    await until(() => lists.length === 1, "alice's installs")
    const second = d.model.setSession(as(bob))
    await until(() => lists.length === 2, "bob's installs")
    list.open()
    await Promise.all([first, second])
    expect(ready(d.model).installs).toEqual([])
    expect(render(d.model)).not.toContain("T0123ABCD")

    // Bob's own code shows.
    await b.model.issueCode("slack")
    expect(ready(b.model).code?.code).toMatch(LINK_CODE_PATTERN)
  })

  test("a newer request, Hide and 10 local minutes each clear a code, whatever the server's clock", async () => {
    const door = gate()
    const b = browser(
      held((route, init) => route === EVERYWHERE_ROUTES.link && String(init.body).includes("slack"), door),
    )
    await b.model.setSession(as(alice))
    const slack = b.model.issueCode("slack")
    await b.model.issueCode("jira")
    door.open()
    await slack
    expect(ready(b.model).code?.platform).toBe("jira")
    b.model.forgetCode()
    expect(ready(b.model).code).toBeUndefined()
    expect(b.timers.every((timer) => timer.cancelled)).toBe(true)

    for (const skew of [5 * 60_000, -5 * 60_000]) {
      fake.clock.now = Date.now() + skew
      const c = browser()
      await c.model.setSession(as(alice))
      await c.model.issueCode("slack")
      expect(ready(c.model).code?.code).toMatch(LINK_CODE_PATTERN)
      expect(c.timers.map((timer) => timer.ms)).toEqual([LINK_CODE_MS])
      c.timers[0]!.run()
      expect(ready(c.model).code).toBeUndefined()
    }
  })
})

describe("connecting", () => {
  test("Connect and Link go only to the platform's own authorize page with the answer's state", async () => {
    expect(EVERYWHERE_AUTHORIZE).toEqual({ slack: OAUTH.slack.authorize, linear: OAUTH.linear.authorize })
    const b = browser()
    await b.model.setSession(as(alice))
    await b.model.startInstall("slack")
    await b.model.startLink()
    expect(b.navigations).toHaveLength(2)
    const slack = new URL(b.navigations[0]!)
    const linear = new URL(b.navigations[1]!)
    expect(slack.origin + slack.pathname).toBe(EVERYWHERE_AUTHORIZE.slack)
    expect(linear.origin + linear.pathname).toBe(EVERYWHERE_AUTHORIZE.linear)
    expect(linear.searchParams.get("actor")).toBe("user")
    for (const url of [slack, linear]) {
      const stored = fake.read(everywhereKeys.state(url.searchParams.get("state")!))
      expect(stored?.kind === "string" && JSON.parse(stored.value).account).toBe(alice.id)
    }

    const rewrites: ((body: Record<string, string>) => Record<string, unknown>)[] = [
      (body) => ({ ...body, url: body.url!.replace("https://slack.com", "https://slack.com.evil.example") }),
      (body) => ({ ...body, url: body.url!.replace("/oauth/v2/authorize", "/oauth/v2/other") }),
      (body) => ({ ...body, url: body.url!.replace("https:", "http:") }),
      (body) => ({ ...body, url: `${body.url}#x` }),
      (body) => ({ ...body, url: body.url!.replace(/state=[^&]+/, "state=AAAAAAAAAAAAAAAAAAAA") }),
      (body) => ({ ...body, url: body.url!.replace(/[?&]state=[^&]+/, "") }),
      (body) => ({ ...body, url: `${body.url}&state=${body.state}` }),
      (body) => ({ ...body, url: body.url!.replace("https://", "https://user:pass@") }),
      (body) => ({ ...body, platform: "linear" }),
    ]
    for (const rewrite of rewrites) {
      const c = browser((route, init) =>
        loopback(route, init).then(async (response) =>
          init.method === "POST"
            ? Response.json(rewrite((await response.json()) as Record<string, string>), { status: response.status })
            : response,
        ),
      )
      await c.model.setSession(as(alice))
      await c.model.startInstall("slack")
      expect(c.navigations).toEqual([])
      expect(ready(c.model).problem).toBe("unavailable")
    }

    env = everywhereEnv("jira")
    harness.use(createAccountApi(deps()))
    const d = browser()
    await d.model.setSession(as(alice))
    await d.model.startInstall("slack")
    expect(d.navigations).toEqual([])
    expect(ready(d.model).problem).toBe("not-found")
    expect(render(d.model)).toContain(EVERYWHERE_COPY.problem["not-found"])
  })

  test("a Jira connect code connects its site once, in the body only; reusing it says so", async () => {
    const b = browser()
    await b.model.setSession(as(alice))
    const code = await connectCode()
    await b.model.connectJira(`  ${code.toLowerCase()} `)
    expect(ready(b.model).notice).toBe("connected")
    expect(ready(b.model).installs.map((item) => item.installation)).toEqual([JIRA])
    expect(await findInstall(ctx().store, JIRA)).toMatchObject({ connector: alice.id })
    const c = browser()
    await c.model.setSession(as(bob))
    await c.model.connectJira(code)
    expect(ready(c.model).problem).toBe("code-invalid")
    expect(render(c.model)).toContain(EVERYWHERE_COPY.problem["code-invalid"])
    for (const call of [...b.calls, ...c.calls]) expect(call.path).not.toContain(code)
    const blank = c.calls.length
    await c.model.connectJira("   ")
    expect(c.calls).toHaveLength(blank)
    expect(ready(c.model).problem).toBe("invalid")
  })
})

describe("installations", () => {
  test("only the account's own installations are listed, and Disconnect erases one after the E13 confirmation", async () => {
    await install(SLACK, alice, ["chat:write"])
    await install(JIRA, alice)
    await install(SLACK_OTHER, bob)
    await link(bob, SLACK, "U0BBB2222")
    await map(SLACK, "C0123", [{ fullName: "acme/api", id: 7 }])
    const b = browser()
    await b.model.setSession(as(alice))
    let html = render(b.model)
    expect(html).toContain("Slack workspace T0123ABCD")
    expect(html).toContain(`Jira site ${CLOUD}`)
    expect(html).toContain("Scopes: chat:write")
    expect(html).not.toContain("T0999ZZZZ")
    expect(html).not.toContain(EVERYWHERE_COPY.disconnectConfirm)
    b.model.ask({ action: "disconnect", installation: SLACK })
    expect(render(b.model)).toContain(EVERYWHERE_COPY.disconnectConfirm)
    b.model.cancel()
    expect(render(b.model)).not.toContain(EVERYWHERE_COPY.disconnectConfirm)
    b.model.ask({ action: "disconnect", installation: SLACK })
    await b.model.confirm()
    expect(ready(b.model).notice).toBe("disconnected")
    expect(await findInstall(ctx().store, SLACK)).toBeUndefined()
    expect(await findLink(ctx().store, SLACK, "U0BBB2222")).toBeUndefined()
    expect(await listMappings(ctx().store, SLACK)).toEqual([])
    expect(new Set(erasedJobs)).toEqual(new Set([SLACK]))
    html = render(b.model)
    expect(html).not.toContain("T0123ABCD")
    expect(html).toContain(EVERYWHERE_COPY.notice.disconnected)
    expect(ready(b.model).installs.map((item) => item.installation)).toEqual([JIRA])
  })

  test("an unconfirmed revoke answers 202: the page says what to check and offers no blind retry", async () => {
    harness.use(createAccountApi(deps({ revoke: (async () => "uncertain") satisfies InstallRevoker })))
    // A bot token is what a disconnect revokes on the platform.
    await install(SLACK, alice, ["chat:write"], `xoxb-${randomBytes(16).toString("hex")}`)
    const b = browser()
    await b.model.setSession(as(alice))
    b.model.ask({ action: "disconnect", installation: SLACK })
    await b.model.confirm()
    expect(ready(b.model).notice).toBe("closing")
    expect(ready(b.model).installs).toEqual([
      expect.objectContaining({ installation: SLACK, status: "closing", nextAction: "review-native-revocation" }),
    ])
    const html = render(b.model)
    expect(html).toContain(EVERYWHERE_COPY.reviewRevocation)
    expect(html).toContain(EVERYWHERE_COPY.notice.closing)
    expect(html).not.toContain(`aria-label="${EVERYWHERE_COPY.disconnect} Slack workspace T0123ABCD"`)
  })

  test("a disconnect that stopped part way keeps Disconnect, which finishes it", async () => {
    let failures = 1
    jobs = {
      installation: async (installation) => {
        if (failures-- > 0) throw storeUnavailable()
        erasedJobs.push(installation)
      },
      account: async () => {},
    }
    harness.use(
      createAccountApi(
        deps({
          revoke: (async (_installation, _record, beforeRequest) => {
            await beforeRequest()
            return "confirmed"
          }) satisfies InstallRevoker,
        }),
      ),
    )
    await install(SLACK, alice, ["chat:write"], `xoxb-${randomBytes(16).toString("hex")}`)
    const b = browser()
    await b.model.setSession(as(alice))
    b.model.ask({ action: "disconnect", installation: SLACK })
    await b.model.confirm()
    expect(ready(b.model).problem).toBe("unavailable")
    expect(ready(b.model).installs).toEqual([
      expect.objectContaining({ installation: SLACK, nextAction: "retry-disconnect" }),
    ])
    const html = render(b.model)
    expect(html).toContain(EVERYWHERE_COPY.retryDisconnect)
    expect(html).toContain(`aria-label="${EVERYWHERE_COPY.disconnect} Slack workspace T0123ABCD"`)
    b.model.ask({ action: "disconnect", installation: SLACK })
    await b.model.confirm()
    expect(ready(b.model).notice).toBe("disconnected")
    expect(ready(b.model).installs).toEqual([])
  })

  test("a malformed entry is left out with a note, and the rest keep their controls", async () => {
    await install(SLACK, alice)
    const b = browser((route, init) =>
      loopback(route, init).then(async (response) => {
        if (route !== EVERYWHERE_ROUTES.installs || init.method !== "GET") return response
        const body = (await response.json()) as { installs: unknown[] }
        return Response.json({ installs: [...body.installs, { installation: "slack:not a key", platform: "slack" }] })
      }),
    )
    await b.model.setSession(as(alice))
    expect(ready(b.model).partial).toBe(true)
    const html = render(b.model)
    expect(html).toContain(EVERYWHERE_COPY.partial)
    expect(html).toContain(`aria-label="${EVERYWHERE_COPY.disconnect} Slack workspace T0123ABCD"`)
  })
})

describe("links", () => {
  test("links show the platform user id and the workspace id; Unlink removes only that link", async () => {
    await install(SLACK, bob)
    await install(JIRA, bob)
    await link(alice, SLACK, "U0AAA1111")
    await link(alice, JIRA, JIRA_USER)
    await link(bob, SLACK, "U0BBB2222")
    const b = browser()
    await b.model.setSession(as(alice))
    const html = render(b.model)
    expect(html).toContain("U0AAA1111")
    expect(html).toContain(JIRA_USER)
    expect(html).toContain("Slack workspace T0123ABCD")
    expect(html).not.toContain("U0BBB2222")
    await b.model.unlink(SLACK, "U0AAA1111")
    expect(ready(b.model).notice).toBe("unlinked")
    expect(await findLink(ctx().store, SLACK, "U0AAA1111")).toBeUndefined()
    expect(await findLink(ctx().store, SLACK, "U0BBB2222")).toMatchObject({ account: bob.id })
    expect(ready(b.model).links.map((item) => item.userId)).toEqual([JIRA_USER])
  })

  test("unlinking a link already removed on the platform says it is not there and reloads, not that the feature is off", async () => {
    await install(SLACK, bob)
    await link(alice, SLACK, "U0AAA1111")
    const b = browser()
    await b.model.setSession(as(alice))
    expect(ready(b.model).links).toHaveLength(1)
    // The person sent the `unlink` word in Slack meanwhile.
    expect((await unlink(ctx(), { installation: SLACK, userId: "U0AAA1111" })).ok).toBe(true)
    await b.model.unlink(SLACK, "U0AAA1111")
    expect(b.model.state().kind).toBe("ready")
    expect(ready(b.model).problem).toBe("not-found")
    expect(ready(b.model).links).toEqual([])
  })
})

describe("repository mappings", () => {
  test("places by id, the private mark read-only for Linear and Jira, and narrowing or removing a mapping", async () => {
    await install(SLACK, alice)
    await install(LINEAR, alice)
    await install(JIRA, alice)
    await map(SLACK, "C0123", [
      { fullName: "acme/api", id: 7 },
      { fullName: "acme/web", id: 8 },
    ])
    await map(
      LINEAR,
      TEAM,
      [
        { fullName: "acme/app", id: 9 },
        { fullName: "acme/lib", id: 11 },
      ],
      true,
    )
    await map(JIRA, "ENG", [{ fullName: "acme/tools", id: 10 }])
    const b = browser()
    // The session's id in capitals: the server lowercases account ids, and "by you" still holds.
    await b.model.setSession({ account: alice.id.toUpperCase(), token: alice.token })
    let html = render(b.model)
    expect(html).toContain("Channel C0123")
    expect(html).toContain(`Team ${TEAM}`)
    expect(html).toContain("Key ENG")
    expect(count(html, EVERYWHERE_COPY.markedPrivate)).toBe(1)
    expect(count(html, EVERYWHERE_COPY.notPrivate)).toBe(1)
    expect(count(html, EVERYWHERE_COPY.privateNote)).toBe(2)
    expect(count(html, " by you")).toBe(3)
    expect(html).toContain(EVERYWHERE_COPY.slackMappingHint)
    expect(html).toContain(EVERYWHERE_COPY.trackerMappingHint)
    expect(
      Object.values(ready(b.model).mappings)
        .flat()
        .every((mapping) => mapping.setByYou),
    ).toBe(true)

    b.model.ask({ action: "drop-repository", installation: SLACK, place: "C0123", fullName: "acme/web" })
    expect(render(b.model)).toContain(EVERYWHERE_COPY.dropRepositoryConfirm)
    await b.model.confirm()
    expect(ready(b.model).notice).toBe("saved")
    const slack = await harness.call("GET", EVERYWHERE_ROUTES.repos, {
      token: alice.token,
      query: { installation: SLACK },
    })
    expect(slack.body.mappings[0].repositories).toEqual([{ fullName: "acme/api", id: 7 }])

    b.model.ask({ action: "drop-repository", installation: LINEAR, place: TEAM, fullName: "acme/lib" })
    await b.model.confirm()
    const [team] = await listMappings(ctx().store, LINEAR)
    expect(team).toMatchObject({ repositories: [{ fullName: "acme/app", id: 9 }], private: true })
    b.model.ask({ action: "drop-repository", installation: LINEAR, place: TEAM, fullName: "acme/app" })
    await b.model.confirm()
    expect(await listMappings(ctx().store, LINEAR)).toEqual([])

    b.model.ask({ action: "remove-mapping", installation: JIRA, place: "ENG" })
    expect(render(b.model)).toContain(EVERYWHERE_COPY.removeMappingConfirm)
    await b.model.confirm()
    expect(ready(b.model).notice).toBe("removed")
    expect(await listMappings(ctx().store, JIRA)).toEqual([])
    html = render(b.model)
    expect(html).not.toContain("Key ENG")
    expect(html).toContain("Channel C0123")
  })

  test("a repository whose id is not known yet is listed and its mapping can be removed, but it is never sent back", async () => {
    await install(SLACK, alice)
    await map(SLACK, "C0456", [
      { fullName: "acme/api", id: 7 },
      { fullName: "acme/old", id: 12 },
    ])
    const key = everywhereKeys.repo(SLACK, "C0456")
    const stored = fake.read(key)
    if (stored?.kind !== "string") throw new Error("no stored mapping")
    const record = JSON.parse(stored.value)
    fake.data.set(key, { kind: "string", value: JSON.stringify({ ...record, repositoryIds: [7, null] }) })
    const b = browser()
    await b.model.setSession(as(alice))
    expect(ready(b.model).mappings[SLACK]).toEqual([
      expect.objectContaining({
        place: "C0456",
        repositories: [{ fullName: "acme/api", id: 7 }, { fullName: "acme/old" }],
      }),
    ])
    const html = render(b.model)
    expect(html).toContain(EVERYWHERE_COPY.unknownId)
    expect(html).not.toContain(`aria-label="${EVERYWHERE_COPY.removeRepository} acme/api from Channel C0456"`)
    expect(html).toContain(`aria-label="${EVERYWHERE_COPY.removeRepository} acme/old from Channel C0456"`)
    expect(html).toContain(`aria-label="${EVERYWHERE_COPY.removeMapping} for Channel C0456"`)
    b.model.ask({ action: "drop-repository", installation: SLACK, place: "C0456", fullName: "acme/api" })
    const sent = b.calls.length
    await b.model.confirm()
    expect(b.calls).toHaveLength(sent)
    expect(ready(b.model).problem).toBe("invalid")
    b.model.ask({ action: "remove-mapping", installation: SLACK, place: "C0456" })
    await b.model.confirm()
    expect(await listMappings(ctx().store, SLACK)).toEqual([])
  })
})

describe("repository mappings that could not be read or are empty", () => {
  const reposOf = (route: string) =>
    route.startsWith(`${EVERYWHERE_ROUTES.repos}?`)
      ? new URL(route, harness.origin).searchParams.get("installation")
      : undefined

  test("a connection whose repositories could not be read is named, never shown as having no place", async () => {
    await install(SLACK, alice)
    await install(LINEAR, alice)
    const failures: Request[] = [
      () => Promise.resolve(Response.json({ error: { code: "EVERYWHERE_UNAVAILABLE" } }, { status: 503 })),
      () => Promise.resolve(Response.json({ error: { code: "EVERYWHERE_RATE_LIMITED" } }, { status: 429 })),
      () => Promise.reject(new TypeError("network")),
      // A 200 for another installation is not this one's answer.
      (_route, init) => loopback(`${EVERYWHERE_ROUTES.repos}?${new URLSearchParams({ installation: LINEAR })}`, init),
    ]
    for (const failure of failures) {
      const b = browser((route, init) => (reposOf(route) === SLACK ? failure(route, init) : loopback(route, init)))
      await b.model.setSession(as(alice))
      expect(ready(b.model).unread).toEqual([SLACK])
      expect(ready(b.model).partial).toBe(false)
      const html = render(b.model)
      expect(count(html, EVERYWHERE_COPY.mappingsUnread)).toBe(1)
      expect(html).toContain("<h3>Slack workspace T0123ABCD</h3>")
      expect(html).not.toContain(EVERYWHERE_COPY.mappingsEmpty)
      expect(html).not.toContain(EVERYWHERE_COPY.partial)
    }

    // The other connection's mappings still show beside the note.
    await map(LINEAR, TEAM, [{ fullName: "acme/app", id: 9 }])
    const c = browser((route, init) => (reposOf(route) === SLACK ? failures[0]!(route, init) : loopback(route, init)))
    await c.model.setSession(as(alice))
    const html = render(c.model)
    expect(html).toContain(`Team ${TEAM}`)
    expect(html).toContain(EVERYWHERE_COPY.mappingsUnread)

    // Once every read answers, the note goes.
    const d = browser()
    await d.model.setSession(as(alice))
    expect(ready(d.model).unread).toEqual([])
    expect(render(d.model)).not.toContain(EVERYWHERE_COPY.mappingsUnread)
  })

  test("a refused session on a repositories read asks to sign in again", async () => {
    await install(SLACK, alice)
    const b = browser((route, init) =>
      reposOf(route) === SLACK
        ? Promise.resolve(Response.json({ error: { code: "SESSION_INVALID" } }, { status: 401 }))
        : loopback(route, init),
    )
    await b.model.setSession(as(alice))
    expect(b.model.state().kind).toBe("session-expired")
    expect(render(b.model)).toContain(EVERYWHERE_COPY.expired)
  })

  test("a mapping with no repository is listed with only Remove mapping", async () => {
    await install(SLACK, alice)
    // The repos PUT accepts an empty list from the connector.
    await map(SLACK, "C0789", [])
    const b = browser()
    await b.model.setSession(as(alice))
    expect(ready(b.model).mappings[SLACK]).toEqual([expect.objectContaining({ place: "C0789", repositories: [] })])
    expect(ready(b.model).partial).toBe(false)
    const html = render(b.model)
    expect(html).toContain("Channel C0789")
    expect(html).toContain(EVERYWHERE_COPY.noRepositories)
    expect(html).not.toContain(EVERYWHERE_COPY.partial)
    expect(html).not.toContain(EVERYWHERE_COPY.mappingsEmpty)
    expect(html).not.toMatch(/aria-label="Remove [^"]+ from Channel C0789"/)
    expect(html).toContain(`aria-label="${EVERYWHERE_COPY.removeMapping} for Channel C0789"`)
    b.model.ask({ action: "remove-mapping", installation: SLACK, place: "C0789" })
    await b.model.confirm()
    expect(ready(b.model).notice).toBe("removed")
    expect(await listMappings(ctx().store, SLACK)).toEqual([])
    expect(render(b.model)).toContain(EVERYWHERE_COPY.mappingsEmpty)
  })
})

describe("decoders and fixed values", () => {
  test("the client's patterns and timings are the server's", () => {
    for (const letter of "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789")
      expect(LINK_CODE_PATTERN.test(`${letter.repeat(4)}-${letter.repeat(4)}`)).toBe(CODE_ALPHABET.includes(letter))
    expect(LINK_CODE_PATTERN.test("ABCD-EFG")).toBe(false)
    expect(LINK_CODE_PATTERN.test("ABCDEFGH")).toBe(false)
    expect(LINK_CODE_CHARS).toBe(8)
    expect(LINK_CODE_MS).toBe(KEEP_MS.linkCode)
    expect(PLACE_ID_PATTERN.source).toBe(PLACE_PATTERN.source)
    for (const platform of ["slack", "linear", "jira"] as const) {
      expect(LINK_USER_ID_PATTERNS[platform].source).toBe(USER_ID_PATTERNS[platform].source)
      expect(LINK_USER_ID_PATTERNS[platform].flags).toBe(USER_ID_PATTERNS[platform].flags)
    }
  })

  test("readLinkCode checks the platform and the shape, never the server's clock", () => {
    const answer = { platform: "slack", code: "ABCD-EFGH", expiresAt: 1_000, note: "a server note" }
    expect(readLinkCode(answer, "slack")).toEqual({ platform: "slack", code: "ABCD-EFGH" })
    expect(readLinkCode({ ...answer, expiresAt: Date.now() + 86_400_000 }, "slack")).toBeDefined()
    expect(readLinkCode(answer, "jira")).toBeUndefined()
    for (const broken of [
      { ...answer, code: "ABCD-EFGI" },
      { ...answer, code: "ABCDEFGH" },
      { ...answer, expiresAt: 0 },
      { ...answer, expiresAt: 1.5 },
      null,
      [],
    ])
      expect(readLinkCode(broken, "slack")).toBeUndefined()
  })

  test("readInstalls skips a malformed entry and GitHub's, and reads every Slack key form", () => {
    const good = (installation: string, platform: string) => ({
      installation,
      platform,
      installedAt: 5,
      scopes: ["chat:write"],
    })
    const read = readInstalls({
      installs: [
        good(SLACK, "slack"),
        good("slack:E0ORG0001:T0TEAM001", "slack"),
        good("slack:E0ORG0001", "slack"),
        good("github:42", "github"),
        good("slack:bad", "slack"),
        good(LINEAR, "jira"),
        { ...good(JIRA, "jira"), status: "gone" },
        { ...good(JIRA, "jira"), scopes: ["has space"] },
        good(SLACK, "slack"),
      ],
    })
    expect(read?.items.map((item) => item.installation)).toEqual([
      SLACK,
      "slack:E0ORG0001:T0TEAM001",
      "slack:E0ORG0001",
    ])
    expect(read?.skipped).toBe(5)
    expect(
      readInstalls({
        installs: Array.from({ length: 201 }, (_, index) => good(`slack:T0${String(index).padStart(4, "0")}`, "slack")),
      }),
    ).toMatchObject({ skipped: 1 })
    expect(readInstalls({ installs: "nope" })).toBeUndefined()
    expect(installationLabel("slack:E0ORG0001:T0TEAM001")).toBe("Slack workspace T0TEAM001 (organization E0ORG0001)")
    expect(installationLabel("slack:E0ORG0001")).toBe("Slack organization E0ORG0001")
    expect(installationLabel(LINEAR)).toBe(`Linear workspace ${LINEAR.slice(7)}`)
    expect(placeLabel("linear", TEAM)).toBe(`Team ${TEAM}`)
  })

  test("readLinks uses each platform's user id shape", () => {
    const long = `${"a".repeat(64)}:${"b".repeat(64)}`
    const read = readLinks({
      links: [
        { installation: JIRA, platform: "jira", userId: long, linkedAt: 9 },
        { installation: SLACK, platform: "slack", userId: "u0lower", linkedAt: 9 },
        { installation: LINEAR, platform: "linear", userId: "not-a-uuid", linkedAt: 9 },
        { installation: LINEAR, platform: "linear", userId: randomUUID(), linkedAt: 9 },
        // GitHub needs no link (4.1), so the route never lists one.
        { installation: "github:42", platform: "github", userId: "42", linkedAt: 9 },
      ],
    })
    expect(read?.items.map((item) => item.platform)).toEqual(["jira", "linear"])
    expect(read?.items[0]?.userId).toHaveLength(129)
    expect(read?.skipped).toBe(3)
  })

  test("readMappings refuses another installation's answer, keeps an empty mapping and skips only the malformed one", () => {
    const mapping = (place: string, repositories: unknown[]) => ({
      place,
      repositories,
      setBy: alice.id,
      private: false,
      setAt: 3,
    })
    const read = readMappings(
      {
        installation: SLACK,
        mappings: [
          mapping("C1", [{ fullName: "acme/api", id: 7 }, { fullName: "acme/old" }]),
          mapping("C2", [{ fullName: "acme/../x", id: 8 }]),
          mapping("C3", [{ fullName: "acme/web", id: 0 }]),
          mapping("C 4", [{ fullName: "acme/web", id: 8 }]),
          mapping("C5", []),
        ],
      },
      SLACK,
      alice.id,
    )
    expect(read?.items).toEqual([
      {
        place: "C1",
        repositories: [{ fullName: "acme/api", id: 7 }, { fullName: "acme/old" }],
        private: false,
        setAt: 3,
        setByYou: true,
      },
      { place: "C5", repositories: [], private: false, setAt: 3, setByYou: true },
    ])
    expect(read?.skipped).toBe(3)
    expect(
      readMappings(
        {
          installation: SLACK,
          mappings: [
            mapping(
              "C6",
              Array.from({ length: 21 }, (_, index) => ({ fullName: `a/r${index}`, id: index + 1 })),
            ),
          ],
        },
        SLACK,
        alice.id,
      ),
    ).toEqual({ items: [], skipped: 1 })
    expect(readMappings({ installation: SLACK_OTHER, mappings: [] }, SLACK, alice.id)).toBeUndefined()
    expect(
      readMappings({ installation: SLACK, mappings: [mapping("C1", [{ fullName: "a/b", id: 1 }])] }, SLACK, bob.id)
        ?.items[0]?.setByYou,
    ).toBe(false)
  })

  test("readAuthorize and problemOf", () => {
    const state = "S".repeat(32)
    const url = `${EVERYWHERE_AUTHORIZE.slack}?client_id=1&state=${state}`
    expect(readAuthorize({ platform: "slack", state, url }, "slack")).toBe(url)
    expect(readAuthorize({ platform: "slack", state: "short", url }, "slack")).toBeUndefined()
    expect(readAuthorize({ platform: "slack", state, url: "not a url" }, "slack")).toBeUndefined()
    expect(problemOf(400, "EVERYWHERE_CODE_INVALID")).toBe("code-invalid")
    expect(problemOf(409, "EVERYWHERE_INSTALLED_ELSEWHERE")).toBe("installed-elsewhere")
    expect([404, 409, 403, 429, 400, 500, 503, 0].map((status) => problemOf(status))).toEqual([
      "not-found",
      "changed",
      "not-allowed",
      "too-many",
      "invalid",
      "unavailable",
      "unavailable",
      "unavailable",
    ])
  })
})

describe("older browsers", () => {
  test("without AbortSignal.any the page loads; a request that throws at once says Vector could not be reached", async () => {
    await install(SLACK, alice)
    const any = Object.getOwnPropertyDescriptor(AbortSignal, "any")!
    Reflect.deleteProperty(AbortSignal, "any")
    try {
      const b = browser()
      await b.model.setSession(as(alice))
      expect(ready(b.model).loaded).toBe(true)
      expect(ready(b.model).installs.map((item) => item.installation)).toEqual([SLACK])
      for (const call of b.calls) expect(call.init.signal).toBeInstanceOf(AbortSignal)
    } finally {
      Object.defineProperty(AbortSignal, "any", any)
    }
    const c = browser(() => {
      throw new TypeError("fetch is not a function")
    })
    await c.model.setSession(as(alice))
    expect(ready(c.model).problem).toBe("unavailable")
    expect(render(c.model)).toContain(`>${EVERYWHERE_COPY.retry}</button>`)
  })

  test("without URL.canParse the sign-in link falls back to /everywhere and a Connect refuses", async () => {
    const b = browser()
    await b.model.setSession(as(alice))
    const canParse = Object.getOwnPropertyDescriptor(URL, "canParse")!
    const state = "S".repeat(32)
    Reflect.deleteProperty(URL, "canParse")
    try {
      expect(signInPath("/everywhere/link")).toBe("/login?returnTo=%2Feverywhere")
      expect(
        readAuthorize({ platform: "slack", state, url: `${EVERYWHERE_AUTHORIZE.slack}?state=${state}` }, "slack"),
      ).toBeUndefined()
      await b.model.startInstall("slack")
    } finally {
      Object.defineProperty(URL, "canParse", canParse)
    }
    expect(b.navigations).toEqual([])
    expect(ready(b.model).problem).toBe("unavailable")
  })
})

// ---------------------------------------------------------------------------------------------------------------------
// EV-23 (VE-42b): the OAuth landing, the Linear link page, the jobs and the audit log
// ---------------------------------------------------------------------------------------------------------------------

const DAY = 86_400_000
const STATE = "S".repeat(32)
const OFFER: OfferKey = { kid: "test-offer-key", key: generateKeyPairSync("ed25519").privateKey }
const TASK = "Fix the login button on Safari"
const DM_SUMMARY = "Fixed the redirect in the Safari login flow."
const CHANNEL_SUMMARY = "Changed the channel job's sign-in handler."
const TRACKER_SUMMARY = "Changed the Linear issue's settings page."
const THEIR_SUMMARY = "Changed the summary another account asked for."
// Built at run time, as the schema's policy tests do, so no token-shaped literal is in the source.
const TOKEN = "gh" + "p_" + randomBytes(18).toString("hex")
const SECRET_SUMMARY = `Set the token ${TOKEN} in the deploy settings.`
// The settle decoder reads `&#100;` as text, so this passes settle; the post's cleaning decodes it to a diff header.
const DIFF_SUMMARY = "&#100;iff --git a/src/login.ts b/src/login.ts"
const LINK_SUMMARY = "Fixed the login redirect. The log is at https://evil.example/log?run=7 for the record."
const ONLY_LINK_SUMMARY = "https://evil.example/only"
const LINEAR_USER = randomUUID()

function jobsCtx(): JobsContext {
  return { ...ctx(), offer: OFFER }
}

function renderLink(model: EverywhereAccountModel, pathname = "/everywhere/link") {
  return renderToStaticMarkup(createElement(EverywhereLinkView, { state: model.state(), model, pathname }))
}

function renderFocused(model: EverywhereAccountModel, focus: string | undefined) {
  return renderToStaticMarkup(
    createElement(EverywhereAccountView, { state: model.state(), model, pathname: "/everywhere", focus }),
  )
}

function hrefs(html: string) {
  return [...html.matchAll(/href="([^"]*)"/g)].map((match) => match[1]!)
}

function finishes(calls: readonly Call[]) {
  return calls.filter((call) => call.path === EVERYWHERE_ROUTES.oauthFinish)
}

/** `window.location` and `window.history` for a page opened at `url`, recording every replaceState. */
function standIn(url: string) {
  const parsed = new URL(url, "https://vectordev.ai")
  const location = { hash: parsed.hash, pathname: parsed.pathname, search: parsed.search }
  const replaced: string[] = []
  const states: unknown[] = []
  const place: OAuthPlace = {
    location,
    history: {
      state: { kept: true },
      replaceState(data, _unused, next) {
        states.push(data)
        replaced.push(next)
        const after = new URL(next, "https://vectordev.ai")
        location.hash = after.hash
        location.pathname = after.pathname
        location.search = after.search
      },
    },
  }
  return { place, replaced, states, location }
}

/** Slack's answers for an install of slack:T0123ABCD by U0ALICE01, an admin there. */
function slackGrant() {
  slack.calls = []
  slack.answer = undefined
  slack.user = {
    id: "U0ALICE01",
    team_id: "T0123ABCD",
    is_bot: false,
    deleted: false,
    is_restricted: false,
    is_ultra_restricted: false,
    is_admin: true,
  }
  slack.grant = {
    app_id: readConfig(env).slack!.appId,
    token_type: "bot",
    access_token: `xoxb-${randomBytes(24).toString("hex")}`,
    bot_user_id: "U0BOT0001",
    team: { id: "T0123ABCD" },
    scope: OAUTH.slack.scopes.install.join(","),
    authed_user: { id: "U0ALICE01" },
  }
}

/** The account routes with the platforms' real exchanges over a fake, and the two real OAuth callbacks. */
function mountNative(fetcher: typeof fetch) {
  mountAccount(
    createAccountApi(deps({ exchanges: platformExchanges(readConfig(env), fetcher, () => fake.clock.now) })),
    {
      "/api/slack/oauth": slackOAuthCallback(() => readConfig(env)),
      "/api/linear/oauth": linearOAuthCallback(() => readConfig(env)),
    },
  )
}

/** The platform's redirect back to the callback, as the browser follows it; answers the callback's Location. */
async function callback(platform: "slack" | "linear", code: string, state: string) {
  const answer = await fetch(`${harness.origin}/api/${platform}/oauth?${new URLSearchParams({ code, state })}`, {
    redirect: "manual",
  })
  expect(answer.status).toBe(303)
  return answer.headers.get("location")!
}

/** Alice (or `account`) starts an install or a link on the real route; answers the state the platform returns with. */
async function startState(account: TestAccount, start: (model: EverywhereAccountModel) => Promise<void>) {
  const page = browser()
  await page.model.setSession(as(account))
  await start(page.model)
  expect(page.navigations).toHaveLength(1)
  return { state: new URL(page.navigations[0]!).searchParams.get("state")!, authorize: new URL(page.navigations[0]!) }
}

type Seed = {
  readonly account: TestAccount
  readonly installation: string
  readonly userId: string
  readonly shared: boolean
  /** The requester's Vector account, when it is not the sponsor's. */
  readonly requester?: string
  readonly issue?: string
}

/** A job created through the real state machine, with its installation and link proven as intake would. */
async function seedJob(seed: Seed): Promise<JobRecord> {
  const input: NewJob = {
    platform: installationPlatform(seed.installation)!,
    installation: seed.installation,
    kind: seed.shared ? "mention" : "dm",
    requester: { userId: seed.userId, account: seed.requester ?? seed.account.id },
    sponsor: seed.account.id,
    repository: { id: 4242, fullName: "acme/app", shared: false },
    ...(seed.issue ? { issue: { key: seed.issue } } : {}),
    shared: seed.shared,
    task: TASK,
    context: [],
    reply: { channel: "D0ALICE01" },
  }
  await seedJobAuthority(jobsCtx(), input)
  const verdict = await createJob(jobsCtx(), input)
  if (!verdict.ok) throw new Error(`createJob refused: ${verdict.code}`)
  return verdict.job
}

/** Offered, claimed by a computer and settled by it. */
async function settled(job: JobRecord, settle: Partial<Omit<Settle, "jid" | "lease">> = {}) {
  const device = randomBytes(16).toString("base64url")
  expect((await offerJob(jobsCtx(), job.jid)).ok).toBe(true)
  const claim = await claimJob(jobsCtx(), { account: job.sponsor, jid: job.jid, device })
  if (!claim.ok) throw new Error(`claim refused: ${claim.code}`)
  const verdict = await settleJob(jobsCtx(), {
    account: job.sponsor,
    device,
    settle: { jid: job.jid, lease: claim.job.lease.id, outcome: "changes", ...settle },
  })
  if (!verdict.ok) throw new Error(`settle refused: ${verdict.code}`)
  return { job: verdict.job, device, lease: claim.job.lease.id }
}

/** A browser whose GET history answers `body` (a forged or a failing answer); everything else is the real route. */
function forgedHistory(body: unknown, status = 200): Request {
  return (route, init) =>
    route === EVERYWHERE_ROUTES.history ? Promise.resolve(Response.json(body, { status })) : loopback(route, init)
}

function forgedJob(extra: Record<string, unknown> = {}) {
  return {
    jid: `vej_${"0".repeat(10)}${randomBytes(6)
      .toString("hex")
      .replace(/[ilou]/g, "0")
      .slice(0, 12)}`,
    platform: "slack",
    installation: SLACK,
    state: "settled",
    route: "laptop",
    outcome: "changes",
    repository: "acme/app",
    shared: false,
    receivedAt: fake.clock.now,
    ...extra,
  }
}

describe("the OAuth landing (PUB-8)", () => {
  test("takeOAuthReturn strips the fragment before anything else and keeps the path and query", () => {
    const first = standIn(`/everywhere#platform=slack&code=C0DE-1234&state=${STATE}`)
    expect(takeOAuthReturn(first.place)).toEqual({ platform: "slack", code: "C0DE-1234", state: STATE })
    expect(first.replaced).toEqual(["/everywhere"])
    // The history entry's own state is kept; only its address changes.
    expect(first.states).toEqual([{ kept: true }])
    expect(first.location.hash).toBe("")
    const job = `vej_${"0".repeat(22)}`
    const second = standIn(`/everywhere?job=${job}#platform=linear&code=abc.DEF~1&state=${STATE}`)
    expect(takeOAuthReturn(second.place)).toEqual({ platform: "linear", code: "abc.DEF~1", state: STATE })
    expect(second.replaced).toEqual([`/everywhere?job=${job}`])
    // A fragment that is not a return, or none at all, is left alone.
    for (const url of ["/everywhere#links", "/everywhere", "/everywhere#", "/everywhere?job=x"]) {
      const plain = standIn(url)
      expect(takeOAuthReturn(plain.place)).toBeUndefined()
      expect(plain.replaced).toEqual([])
    }
    const malformed = [
      "platform=slack&code=C0DE",
      `platform=slack&code=A&code=B&state=${STATE}`,
      `platform=slack&code=A&state=${STATE}&extra=1`,
      `platform=slack&platform=linear&code=A&state=${STATE}`,
      `platform=jira&code=A&state=${STATE}`,
      `platform=github&code=A&state=${STATE}`,
      `platform=slack&code=A&state=${"S".repeat(15)}`,
      `platform=slack&code=A&state=${"S".repeat(129)}`,
      `platform=slack&code=a%20b&state=${STATE}`,
      `platform=slack&code=&state=${STATE}`,
      `platform=slack&code=${"c".repeat(1025)}&state=${STATE}`,
      "code=only",
      "platform=linear&error=other",
      "platform=linear&error=server_error",
      "platform=linear&error=access_denied&error=access_denied",
      "platform=linear&error=access_denied&error_description=provider-details",
      `platform=linear&error=access_denied&state=${STATE}`,
      `platform=linear&code=A&state=${STATE}&error=access_denied`,
      "platform=jira&error=access_denied",
      "error=access_denied",
    ]
    for (const hash of malformed) {
      const page = standIn(`/everywhere#${hash}`)
      expect(takeOAuthReturn(page.place)).toBe("invalid")
      // Stripped all the same: a malformed code never stays in the address bar either.
      expect(page.replaced).toEqual(["/everywhere"])
    }
    expect(readOAuthReturn(`#platform=slack&code=${"c".repeat(1024)}&state=${STATE}`)).toMatchObject({
      code: "c".repeat(1024),
    })
    expect(readOAuthReturn("#platform=slack&error=access_denied")).toEqual({ platform: "slack", cancelled: true })
    expect(readOAuthReturn(`platform=slack&code=x&state=${STATE}`)).toEqual({
      platform: "slack",
      code: "x",
      state: STATE,
    })
  })

  test("the OAuth landing posts {code, state} with the bearer token and never puts the code in a later URL", async () => {
    slackGrant()
    mountNative(slack.fetch)
    const started = await startState(alice, (model) => model.startInstall("slack"))
    const code = `slack-code-${randomBytes(12).toString("hex")}`
    const location = await callback("slack", code, started.state)
    expect(location).toBe(`/everywhere#${new URLSearchParams({ platform: "slack", code, state: started.state })}`)
    const stand = standIn(location)
    const back = takeOAuthReturn(stand.place)
    expect(back).toEqual({ platform: "slack", code, state: started.state })
    expect(stand.replaced).toEqual(["/everywhere"])

    const door = gate()
    const b = browser(
      held((route, init) => route === EVERYWHERE_ROUTES.oauthFinish && init.method === "POST", door),
      { activity: true },
    )
    // Before the session is known nothing is sent; the landing says it is finishing.
    void b.model.finishOAuth(back as EverywhereOAuthReturn)
    expect(b.calls).toEqual([])
    expect(b.model.state().landing).toEqual({ kind: "finishing", platform: "slack" })
    expect(render(b.model)).toContain(EVERYWHERE_COPY.landing.finishing("slack"))
    const signedIn = b.model.setSession(as(alice))
    await until(() => b.calls.length === 1, "the finish POST")
    // Every control is off until the answer: nothing can navigate away mid-POST.
    expect(ready(b.model).busy).toBe(true)
    await b.model.startInstall("slack")
    await b.model.startLink()
    expect(b.calls).toHaveLength(1)
    expect(b.navigations).toEqual([])
    door.open()
    await signedIn

    const finish = finishes(b.calls)
    expect(finish).toHaveLength(1)
    const sent = finish[0]!
    expect(sent.init.method).toBe("POST")
    expect(Object.keys(JSON.parse(String(sent.init.body)))).toEqual(["code", "state"])
    expect(JSON.parse(String(sent.init.body))).toEqual({ code, state: started.state })
    expect(headers(sent).authorization).toBe(`Bearer ${alice.token}`)
    expect(headers(sent).accept).toBe("application/json")
    expect(headers(sent)["content-type"]).toBe("application/json")
    expect(sent.init.credentials).toBe("omit")
    expect(sent.init.cache).toBe("no-store")
    expect(sent.init.redirect).toBe("error")
    expect(new URL(sent.path, harness.origin).search).toBe("")
    // Then the lists, now with the new connection.
    expect(b.calls[0]).toBe(sent)
    expect(new Set(b.calls.slice(1).map((call) => `${call.init.method} ${call.path}`))).toEqual(
      new Set([
        `GET ${EVERYWHERE_ROUTES.installs}`,
        `GET ${EVERYWHERE_ROUTES.links}`,
        `GET ${EVERYWHERE_ROUTES.history}`,
        `GET ${EVERYWHERE_ROUTES.audit}`,
        `GET ${EVERYWHERE_ROUTES.repos}?installation=${encodeURIComponent(SLACK)}`,
      ]),
    )
    expect(ready(b.model).installs.map((item) => item.installation)).toEqual([SLACK])
    expect((await findInstall(ctx().store, SLACK))?.connector).toBe(alice.id)
    expect(b.model.state().landing).toEqual({
      kind: "installed",
      platform: "slack",
      installation: SLACK,
      change: "new",
    })
    expect(ready(b.model).busy).toBe(false)
    const html = render(b.model)
    expect(html).toContain("Connected Slack workspace T0123ABCD.")
    expect(slack.calls.map((call) => call.method)).toEqual(["oauth.v2.access", "users.info"])

    // A token refresh, a reload of the lists and another account's sign-in send nothing more.
    await b.model.setSession(as(aliceRefreshed))
    await b.model.refresh()
    const pages = [html, render(b.model)]
    await b.model.signInAgain("/everywhere")
    expect(b.navigations).toEqual(["/login?returnTo=%2Feverywhere"])
    await b.model.setSession(as(bob))
    pages.push(render(b.model))
    expect(finishes(b.calls)).toHaveLength(1)
    const urls = [...b.calls.map((call) => call.path), ...b.navigations, ...pages.flatMap(hrefs)]
    for (const secret of [code, started.state, encodeURIComponent(code)]) {
      for (const url of urls) expect(url).not.toContain(secret)
      for (const page of pages) expect(page).not.toContain(secret)
      expect(JSON.stringify(b.model.state())).not.toContain(secret)
    }
    expect(b.calls.filter((call) => String(call.init.body ?? "").includes(code))).toHaveLength(1)
  })

  test("signed out at the landing nothing is sent, the landing says to sign in first, and a later sign-in sends nothing", async () => {
    const back = { platform: "slack", code: "slack-code-signed-out", state: STATE } as const
    const b = browser(loopback, { activity: true })
    await b.model.finishOAuth(back)
    await b.model.setSession(undefined)
    expect(b.calls).toEqual([])
    expect(b.model.state().landing).toEqual({ kind: "failed", problem: "signed-out" })
    const html = render(b.model)
    expect(html).toContain(EVERYWHERE_COPY.landing.problem["signed-out"])
    expect(html).toContain(EVERYWHERE_COPY.signIn)
    expect(html).toContain('href="/login?returnTo=%2Feverywhere"')
    expect(html).not.toContain(back.code)
    await b.model.setSession(as(alice))
    expect(ready(b.model).loaded).toBe(true)
    expect(finishes(b.calls)).toEqual([])
    expect(b.model.state().landing).toBeUndefined()
    // Already signed out when the return arrives: the same.
    const c = browser()
    await c.model.setSession(undefined)
    await c.model.finishOAuth(back)
    expect(c.model.state().landing).toEqual({ kind: "failed", problem: "signed-out" })
    expect(c.calls).toEqual([])
  })

  test("another account's return is refused 403 and connects nothing; switching accounts clears the landing", async () => {
    slackGrant()
    mountNative(slack.fetch)
    const started = await startState(alice, (model) => model.startInstall("slack"))
    const b = browser(loopback, { activity: true })
    void b.model.finishOAuth({ platform: "slack", code: "slack-code-for-alice", state: started.state })
    await b.model.setSession(as(bob))
    expect(b.model.state().landing).toEqual({ kind: "failed", problem: "other-account" })
    expect(render(b.model)).toContain(EVERYWHERE_COPY.landing.problem["other-account"])
    expect(slack.calls).toEqual([])
    expect(await findInstall(ctx().store, SLACK)).toBeUndefined()
    expect(finishes(b.calls)).toHaveLength(1)
    await b.model.setSession(as(alice))
    expect(b.model.state().landing).toBeUndefined()
    expect(render(b.model)).not.toContain(EVERYWHERE_COPY.landing.problem["other-account"])
    expect(finishes(b.calls)).toHaveLength(1)
  })

  test("a 401 comes before the state is read: the return waits for the same account's renewed session, never another's", async () => {
    slackGrant()
    mountNative(slack.fetch)
    const carol = accounts.add(testAccount("carol@example.com"))
    const started = await harness.call("POST", EVERYWHERE_ROUTES.installs, {
      token: carol.token,
      body: { platform: "slack" },
    })
    expect(started.status).toBe(200)
    const state = started.body.state as string
    accounts.accounts.delete(carol.token)
    const refused = `Bearer ${carol.token}`
    // The routes' answer to a token they no longer accept (account-api.ts `begin`), given here for the POST: the
    // loopback harness cannot close once a route has refused a body it never read (EV-22, Left open).
    const request: Request = (route, init) =>
      init.body !== undefined && headers({ path: route, init }).authorization === refused
        ? Promise.resolve(Response.json({ error: { code: "SESSION_INVALID" } }, { status: 401 }))
        : loopback(route, init)
    const b = browser(request, { activity: true })
    await b.model.finishOAuth({ platform: "slack", code: "slack-code-carol", state })
    await b.model.setSession(as(carol))
    expect(b.model.state().kind).toBe("session-expired")
    expect(b.model.state().landing).toEqual({ kind: "finishing", platform: "slack" })
    const html = render(b.model)
    expect(html).toContain(EVERYWHERE_COPY.landing.held)
    expect(html).not.toContain("slack-code-carol")
    // Supabase refreshes the token: the same account sends the return once more, and it finishes.
    const renewed = accounts.add({ ...carol, token: `session-${randomBytes(18).toString("base64url")}` })
    await b.model.setSession(as(renewed))
    expect(b.model.state().landing).toEqual({
      kind: "installed",
      platform: "slack",
      installation: SLACK,
      change: "new",
    })
    expect(finishes(b.calls).map((call) => headers(call).authorization)).toEqual([refused, `Bearer ${renewed.token}`])
    const again = accounts.add({ ...carol, token: `session-${randomBytes(18).toString("base64url")}` })
    await b.model.setSession(as(again))
    await b.model.refresh()
    expect(finishes(b.calls)).toHaveLength(2)

    // A return a 401 kept for one account is dropped when another signs in.
    const dave = accounts.add(testAccount("dave@example.com"))
    const daveState = (
      await harness.call("POST", EVERYWHERE_ROUTES.link, { token: dave.token, body: { platform: "linear" } })
    ).body.state as string
    accounts.accounts.delete(dave.token)
    const refusedDave = `Bearer ${dave.token}`
    const c = browser(
      (route, init) =>
        init.body !== undefined && headers({ path: route, init }).authorization === refusedDave
          ? Promise.resolve(Response.json({ error: { code: "SESSION_INVALID" } }, { status: 401 }))
          : loopback(route, init),
      { activity: true },
    )
    await c.model.finishOAuth({ platform: "linear", code: "linear-code-dave", state: daveState })
    await c.model.setSession(as(dave))
    expect(c.model.state().kind).toBe("session-expired")
    await c.model.setSession(as(bob))
    expect(c.model.state().landing).toEqual({ kind: "failed", problem: "session" })
    expect(finishes(c.calls).map((call) => headers(call).authorization)).toEqual([refusedDave])
  })

  test("a malformed return posts nothing and says so to the session that opened it", async () => {
    const b = browser(loopback, { activity: true })
    await b.model.finishOAuth("invalid")
    expect(b.model.state().landing).toEqual({ kind: "failed", problem: "invalid-return" })
    await b.model.setSession(as(alice))
    expect(ready(b.model).loaded).toBe(true)
    expect(b.model.state().landing).toEqual({ kind: "failed", problem: "invalid-return" })
    expect(render(b.model)).toContain(EVERYWHERE_COPY.landing.problem["invalid-return"])
    expect(finishes(b.calls)).toEqual([])
    // Doing something else, or another account, clears it.
    await b.model.issueCode("slack")
    expect(b.model.state().landing).toBeUndefined()
  })

  test("readFinish and landingProblemOf", () => {
    for (const change of ["new", "renewed", "connector-change"] as const)
      expect(readFinish({ purpose: "install", platform: "slack", installation: SLACK, change }, "slack")).toEqual({
        kind: "installed",
        platform: "slack",
        installation: SLACK,
        change,
      })
    const linked = { purpose: "link", platform: "linear", installation: LINEAR, userId: LINEAR_USER, already: false }
    expect(readFinish({ ...linked, hint: "a•••@example.com" }, "linear")).toEqual({
      kind: "linked",
      installation: LINEAR,
      userId: LINEAR_USER,
      already: false,
      hint: "a•••@example.com",
    })
    expect(readFinish({ ...linked, already: true }, "linear")).toEqual({
      kind: "linked",
      installation: LINEAR,
      userId: LINEAR_USER,
      already: true,
    })
    for (const [value, platform] of [
      [{ purpose: "install", platform: "slack", installation: LINEAR, change: "new" }, "slack"],
      [{ purpose: "install", platform: "linear", installation: SLACK, change: "new" }, "linear"],
      [{ purpose: "install", platform: "linear", installation: LINEAR, change: "new" }, "slack"],
      [{ purpose: "install", platform: "slack", installation: SLACK, change: "moved" }, "slack"],
      [{ purpose: "install", platform: "slack", installation: SLACK }, "slack"],
      [{ ...linked, platform: "slack", installation: SLACK }, "slack"],
      [{ ...linked, userId: "U0ALICE01" }, "linear"],
      [{ ...linked, hint: "alice@example.com" }, "linear"],
      [{ ...linked, already: "no" }, "linear"],
      [{ ...linked, purpose: "other" }, "linear"],
      ["installed", "slack"],
      [null, "slack"],
    ] as const)
      expect(readFinish(value, platform)).toBeUndefined()
    const table: [number, string | undefined, string | undefined, EverywhereLandingProblem][] = [
      [400, "EVERYWHERE_STATE_INVALID", undefined, "expired-state"],
      [403, "EVERYWHERE_STATE_ACCOUNT", undefined, "other-account"],
      [403, "EVERYWHERE_LINK_REFUSED", "not-connected", "not-connected"],
      [403, "EVERYWHERE_LINK_REFUSED", "guest", "link-refused"],
      [403, "EVERYWHERE_LINK_REFUSED", undefined, "link-refused"],
      [409, "EVERYWHERE_INSTALLED_ELSEWHERE", undefined, "installed-elsewhere"],
      [409, "EVERYWHERE_WRONG_PLACE", undefined, "wrong-place"],
      [400, "SLACK_GRANT_INVALID", undefined, "not-verified"],
      [400, "LINEAR_GRANT_INVALID", undefined, "not-verified"],
      [404, "NOT_FOUND", undefined, "not-found"],
      [400, "EVERYWHERE_INVALID", undefined, "unavailable"],
      [501, "EVERYWHERE_UNAVAILABLE", undefined, "unavailable"],
      [502, "EVERYWHERE_EXCHANGE_FAILED", undefined, "unavailable"],
      [503, "PERSISTENT_STORE_UNAVAILABLE", undefined, "unavailable"],
      [0, undefined, undefined, "unavailable"],
    ]
    for (const [status, code, reason, problem] of table) expect(landingProblemOf(status, code, reason)).toBe(problem)
    // Every problem has its own fixed text.
    expect(new Set(table.map((row) => row[3])).size).toBeLessThanOrEqual(
      Object.keys(EVERYWHERE_COPY.landing.problem).length,
    )
  })

  test("a return held through React's double mount is sent once", async () => {
    const b = browser(loopback, { activity: true })
    void b.model.finishOAuth({ platform: "slack", code: "slack-code-strict", state: STATE })
    b.model.close()
    expect(b.model.state().kind).toBe("loading")
    expect(b.model.state().landing).toEqual({ kind: "finishing", platform: "slack" })
    // The second mount finds the fragment gone.
    expect(takeOAuthReturn(standIn("/everywhere").place)).toBeUndefined()
    await b.model.setSession(as(alice))
    expect(finishes(b.calls)).toHaveLength(1)
    // An unknown state: the server used nothing, and the landing says to start again.
    expect(b.model.state().landing).toEqual({ kind: "failed", problem: "expired-state" })
    await b.model.setSession(as(aliceRefreshed))
    expect(finishes(b.calls)).toHaveLength(1)
  })
})

// EV-23: a person who cancels at Slack or Linear, and an install that starts in a platform's directory (spec 3.8).
describe("cancelled sign-ins and directory installs", () => {
  test.each(["slack", "linear"] as const)(
    "a cancelled %s sign-in returns to a fixed notice without using the state or exchanging a code",
    async (platform) => {
      const exchanged: string[] = []
      const refuse = (input: RequestInfo | URL) => {
        exchanged.push(String(input))
        throw new Error("A cancellation must not contact the platform")
      }
      mountNative(Object.assign(async (input: RequestInfo | URL) => refuse(input), { preconnect: refuse }))
      const { state } = await startState(alice, (model) => model.startInstall(platform))
      const before = fake.commands.length
      const query = new URLSearchParams({ error: "access_denied", state, error_description: "provider explanation" })
      const response = await fetch(`${harness.origin}/api/${platform}/oauth?${query}`, { redirect: "manual" })
      expect(response.status).toBe(303)
      const location = response.headers.get("location")!
      expect(location).toBe(`/everywhere#platform=${platform}&error=access_denied`)
      expect(fake.commands).toHaveLength(before)
      const page = standIn(location)
      const back = takeOAuthReturn(page.place)
      expect(back).toEqual({ platform, cancelled: true })
      expect(page.replaced).toEqual(["/everywhere"])

      const b = browser()
      await b.model.finishOAuth(back!)
      await b.model.setSession(as(alice))
      expect(finishes(b.calls)).toEqual([])
      expect(b.model.state().landing).toEqual({ kind: "failed", problem: "cancelled" })
      expect(render(b.model)).toContain(EVERYWHERE_COPY.landing.problem.cancelled)
      // The state was not used up: it simply expires.
      expect(fake.read(everywhereKeys.state(state))?.kind).toBe("string")
      expect(exchanged).toEqual([])
    },
  )

  test("the sign-in link keeps only an install of Slack or Linear on the everywhere page", () => {
    expect(signInPath("/everywhere", undefined, "slack")).toBe("/login?returnTo=%2Feverywhere%3Finstall%3Dslack")
    expect(signInPath("/everywhere/?code=C0DE&state=S7A7E#platform=slack", undefined, "linear")).toBe(
      "/login?returnTo=%2Feverywhere%2F%3Finstall%3Dlinear",
    )
    expect(signInPath("/everywhere/link", undefined, "linear")).toBe("/login?returnTo=%2Feverywhere%2Flink")
    expect(signInPath("//evil.example/everywhere", undefined, "slack")).toBe("/login?returnTo=%2Feverywhere")
    const job = forgedJob()
    expect(
      safeReturnPath(
        new URL(signInPath("/everywhere", job.jid, "slack"), "https://vectordev.ai").searchParams.get("returnTo"),
      ),
    ).toBe(`/everywhere?job=${job.jid}&install=slack`)
  })

  test("takeInstallIntent strips ?install from the address and keeps the rest", () => {
    const job = `vej_${"0".repeat(22)}`
    const page = standIn(`/everywhere?install=slack&job=${job}`)
    expect(takeInstallIntent(page.place)).toBe("slack")
    expect(page.replaced).toEqual([`/everywhere?job=${job}`])
    expect(page.states).toEqual([{ kept: true }])
    // The reload finds nothing to start again.
    expect(takeInstallIntent(page.place)).toBeUndefined()
    expect(page.replaced).toHaveLength(1)
    expect(takeInstallIntent(standIn("/everywhere?install=linear").place)).toBe("linear")
    for (const url of ["/everywhere?install=jira", "/everywhere?install=slack&install=slack", "/everywhere?install="]) {
      const odd = standIn(url)
      expect(takeInstallIntent(odd.place)).toBeUndefined()
      expect(odd.replaced).toEqual(["/everywhere"])
    }
    const plain = standIn(`/everywhere?job=${job}`)
    expect(takeInstallIntent(plain.place)).toBeUndefined()
    expect(plain.replaced).toEqual([])
  })

  test("an install intent starts once after the session is ready, never while signed out or off", async () => {
    const b = browser()
    b.model.installOnReady("slack")
    await b.model.setSession(undefined)
    expect(b.calls).toEqual([])
    expect(b.navigations).toEqual([])
    // Signed out, the sign-in link carries the intent and no landing problem is shown.
    const html = render(b.model)
    expect(html).toContain('href="/login?returnTo=%2Feverywhere%3Finstall%3Dslack"')
    expect(b.model.state().landing).toBeUndefined()

    await b.model.setSession(as(alice))
    expect(b.calls.filter((call) => call.init.method === "POST").map((call) => call.path)).toEqual([
      EVERYWHERE_ROUTES.installs,
    ])
    expect(b.navigations).toHaveLength(1)
    expect(new URL(b.navigations[0]!).origin + new URL(b.navigations[0]!).pathname).toBe(EVERYWHERE_AUTHORIZE.slack)
    // Not again for a renewed token, another account or a later refresh.
    await b.model.setSession(as(aliceRefreshed))
    await b.model.setSession(as(bob))
    await b.model.refresh()
    expect(b.navigations).toHaveLength(1)
    expect(render(b.model)).not.toContain("install%3Dslack")

    const ready = browser()
    await ready.model.setSession(as(alice))
    await ready.model.installOnReady("linear")
    await ready.model.refresh()
    expect(ready.navigations).toHaveLength(1)
    expect(new URL(ready.navigations[0]!).origin + new URL(ready.navigations[0]!).pathname).toBe(
      EVERYWHERE_AUTHORIZE.linear,
    )

    // A first load that failed holds the intent; Try again starts it once the lists load.
    let failures = 1
    const retried = browser((route, init) =>
      route === EVERYWHERE_ROUTES.installs && init.method === "GET" && failures-- > 0
        ? Promise.resolve(Response.json({ error: { code: "EVERYWHERE_UNAVAILABLE" } }, { status: 503 }))
        : loopback(route, init),
    )
    retried.model.installOnReady("slack")
    await retried.model.setSession(as(alice))
    expect(retried.model.state()).toMatchObject({ kind: "ready", loaded: false, problem: "unavailable" })
    expect(retried.navigations).toEqual([])
    await retried.model.refresh()
    await retried.model.refresh()
    expect(retried.calls.filter((call) => call.init.method === "POST").map((call) => call.path)).toEqual([
      EVERYWHERE_ROUTES.installs,
    ])
    expect(retried.navigations).toHaveLength(1)

    env = {}
    harness.use(createAccountApi(deps()))
    const off = browser()
    off.model.installOnReady("slack")
    await off.model.setSession(as(alice))
    expect(off.model.state().kind).toBe("off")
    expect(off.calls.filter((call) => call.init.method === "POST")).toEqual([])
    expect(off.navigations).toEqual([])
  })
})

describe("the Linear link page", () => {
  test("signed out, the link page offers only a sign-in that comes back to /everywhere/link", async () => {
    const b = browser()
    await b.model.setSession(undefined)
    const html = renderLink(b.model)
    expect(html).toContain(EVERYWHERE_COPY.linkPage.signIn)
    expect(html).toContain('href="/login?returnTo=%2Feverywhere%2Flink"')
    expect(html).not.toContain("<button")
    expect(b.calls).toEqual([])
  })

  test("the link page binds viewer.id: its Linear sign-in returns to /everywhere, which links that Linear user", async () => {
    linear.reset()
    const workspace = `linear:${linear.organization}`
    await install(workspace, alice)
    mountNative(linear.fetch)
    const page = browser()
    await page.model.setSession(as(alice))
    const before = renderLink(page.model)
    expect(before).toContain(EVERYWHERE_COPY.linkPage.heading)
    expect(before).toContain(EVERYWHERE_COPY.linkPage.connectedFirst)
    expect(before).toContain(`>${EVERYWHERE_COPY.linkPage.button}</button>`)
    expect(before).toContain(EVERYWHERE_COPY.linkPage.empty)
    expect(before).not.toContain("<form")
    await page.model.startLink()
    expect(page.navigations).toHaveLength(1)
    const authorize = new URL(page.navigations[0]!)
    expect(authorize.origin + authorize.pathname).toBe(EVERYWHERE_AUTHORIZE.linear)
    expect(authorize.searchParams.get("actor")).toBe("user")
    expect(authorize.searchParams.get("scope")).toBe("read")
    const state = authorize.searchParams.get("state")!
    // Linear's person grant: its viewer is the person who signed in.
    const person = `person-${randomBytes(24).toString("hex")}`
    linear.grant = {
      token_type: "Bearer",
      access_token: person,
      refresh_token: linear.refresh,
      expires_in: 86400,
      scope: "read",
    }
    linear.viewers.set(person, {
      id: linear.user,
      app: false,
      active: true,
      guest: false,
      organization: { id: linear.organization },
    })
    const code = `linear-code-${randomBytes(12).toString("hex")}`
    const location = await callback("linear", code, state)
    expect(location).toBe(`/everywhere#${new URLSearchParams({ platform: "linear", code, state })}`)
    const back = takeOAuthReturn(standIn(location).place) as EverywhereOAuthReturn
    const landing = browser(loopback, { activity: true })
    await landing.model.finishOAuth(back)
    await landing.model.setSession(as(alice))

    expect((await findLink(ctx().store, workspace, linear.user))?.account).toBe(alice.id)
    expect(ready(landing.model).links.map((item) => item.userId)).toContain(linear.user)
    expect(landing.model.state().landing).toEqual({
      kind: "linked",
      installation: workspace,
      userId: linear.user,
      already: false,
      hint: "a•••@example.com",
    })
    const html = render(landing.model)
    expect(html).toContain(
      `Linked Linear user ${linear.user} in Linear workspace ${linear.organization} to the Vector account a•••@example.com.`,
    )
    expect(html).not.toContain(alice.email)
    const sent = finishes(landing.calls)
    expect(sent).toHaveLength(1)
    expect(Object.keys(JSON.parse(String(sent[0]!.init.body)))).toEqual(["code", "state"])
    expect(linear.calls.map((call) => call.operation)).toEqual(["oauth", "viewer"])
    expect(linear.calls[1]!.authorization).toBe(`Bearer ${person}`)
    expect(JSON.stringify(fake.commands)).not.toContain(person)
    // The link page lists it; it never asked for the jobs or the audit log.
    await page.model.refresh()
    const after = renderLink(page.model)
    expect(after).toContain(linear.user)
    expect(after).not.toContain(EVERYWHERE_COPY.linkPage.empty)
    const read = page.calls.map((call) => new URL(call.path, harness.origin).pathname)
    expect(read).not.toContain(EVERYWHERE_ROUTES.history)
    expect(read).not.toContain(EVERYWHERE_ROUTES.audit)
    expect(finishes(page.calls)).toEqual([])
  })

  test("a guest or app viewer is not linked, nor is a workspace nobody connected", async () => {
    for (const viewer of [
      { guest: true, app: false },
      { guest: false, app: true },
    ]) {
      linear.reset()
      const workspace = `linear:${linear.organization}`
      await install(workspace, alice)
      mountNative(linear.fetch)
      const started = await startState(alice, (model) => model.startLink())
      const person = `person-${randomBytes(24).toString("hex")}`
      linear.grant = {
        token_type: "Bearer",
        access_token: person,
        refresh_token: linear.refresh,
        expires_in: 86400,
        scope: "read",
      }
      linear.viewers.set(person, {
        id: linear.user,
        active: true,
        organization: { id: linear.organization },
        ...viewer,
      })
      const b = browser(loopback, { activity: true })
      await b.model.finishOAuth({ platform: "linear", code: "linear-code-guest", state: started.state })
      await b.model.setSession(as(alice))
      expect(b.model.state().landing).toEqual({ kind: "failed", problem: "not-verified" })
      expect(render(b.model)).toContain(EVERYWHERE_COPY.landing.problem["not-verified"])
      expect(await findLink(ctx().store, workspace, linear.user)).toBeUndefined()
    }
    linear.reset()
    mountNative(linear.fetch)
    const started = await startState(alice, (model) => model.startLink())
    const person = `person-${randomBytes(24).toString("hex")}`
    linear.grant = {
      token_type: "Bearer",
      access_token: person,
      refresh_token: linear.refresh,
      expires_in: 86400,
      scope: "read",
    }
    linear.viewers.set(person, {
      id: linear.user,
      app: false,
      active: true,
      guest: false,
      organization: { id: linear.organization },
    })
    const b = browser(loopback, { activity: true })
    await b.model.finishOAuth({ platform: "linear", code: "linear-code-unconnected", state: started.state })
    await b.model.setSession(as(alice))
    expect(b.model.state().landing).toEqual({ kind: "failed", problem: "not-connected" })
    expect(render(b.model)).toContain(EVERYWHERE_COPY.landing.problem["not-connected"])
    expect(await findLink(ctx().store, `linear:${linear.organization}`, linear.user)).toBeUndefined()
  })

  test("the link page's root renders loading and calls no account service", () => {
    const html = renderToStaticMarkup(createElement(EverywhereLink))
    expect(html).toContain(EVERYWHERE_COPY.loading)
    expect(accounts.calls).toBe(0)
  })
})

describe("the jobs", () => {
  test("the history and audit routes: off answers 404 before any sign-in or store read, a bad bearer 401, GET only", async () => {
    env = {}
    mountAccount(createAccountApi(deps()))
    // Off, every account route answers 404 to every method, with no allow header that would show the route exists
    // (the spec's Switches rule; this replaces the method-first order of deviations EV-23 (b)). Nothing is read.
    for (const route of Object.values(EVERYWHERE_ROUTES))
      for (const method of ["GET", "POST", "PUT", "DELETE", "PATCH"]) {
        const answer = await harness.call(method, route, { token: alice.token })
        expect({ route, method, status: answer.status, allow: answer.headers.get("allow") }).toEqual({
          route,
          method,
          status: 404,
          allow: null,
        })
      }
    expect(accounts.calls).toBe(0)
    expect(fake.commands).toEqual([])
    env = everywhereEnv()
    mountAccount(createAccountApi(deps()))
    for (const route of [EVERYWHERE_ROUTES.history, EVERYWHERE_ROUTES.audit]) {
      expect((await harness.call("GET", route)).status).toBe(401)
      expect((await harness.call("GET", route, { token: "session-unknown" })).status).toBe(401)
      expect((await harness.call("POST", route, { token: alice.token })).status).toBe(405)
      expect((await harness.call("DELETE", route, { token: alice.token })).status).toBe(405)
    }
    expect(fake.commands).toEqual([])
  })

  test("GET history lists only the account's own jobs of the last 30 days, newest first, with ids and codes only", async () => {
    await install(SLACK, alice)
    await install(SLACK_OTHER, bob)
    // Received 31 days ago, its record still there (a lagging expiry) and back in the history.
    const old = await seedJob({ account: alice, installation: SLACK, userId: "U0ALICE01", shared: false })
    fake.clock.advance(31 * DAY)
    fake.expires.delete(everywhereKeys.job(old.jid))
    const first = await seedJob({ account: alice, installation: SLACK, userId: "U0ALICE01", shared: true })
    fake.clock.advance(60_000)
    const second = await settled(
      await seedJob({ account: alice, installation: SLACK, userId: "U0ALICE01", shared: false }),
      {
        prUrl: "https://github.com/acme/app/pull/7",
      },
    )
    fake.clock.advance(60_000)
    const third = await seedJob({ account: alice, installation: SLACK, userId: "U0ALICE01", shared: false })
    expect((await refuseJob(jobsCtx(), third.jid, "not-mapped")).ok).toBe(true)
    const bobs = await seedJob({ account: bob, installation: SLACK_OTHER, userId: "U0BOB0001", shared: false })
    // Ids written into Alice's history that are not hers to see: Bob's job, and the old one.
    fake.send(["ZADD", everywhereKeys.jobHistory(alice.id), fake.clock.now + 1, bobs.jid])
    fake.send(["ZADD", everywhereKeys.jobHistory(alice.id), old.receivedAt, old.jid])

    const answer = await harness.call("GET", EVERYWHERE_ROUTES.history, { token: alice.token })
    expect(answer.status).toBe(200)
    expect(answer.body.jobs.map((job: { jid: string }) => job.jid)).toEqual([third.jid, second.job.jid, first.jid])
    expect(answer.body.capped).toBe(false)
    expect(answer.body.skipped).toBe(0)
    expect(answer.body.jobs[0]).toEqual({
      jid: third.jid,
      platform: "slack",
      installation: SLACK,
      state: "refused",
      code: "not-mapped",
      repository: "acme/app",
      shared: false,
      receivedAt: third.receivedAt,
      endedAt: fake.clock.now,
    })
    expect(answer.body.jobs[1]).toMatchObject({
      state: "settled",
      route: "laptop",
      outcome: "changes",
      prUrl: "https://github.com/acme/app/pull/7",
    })
    const allowed = new Set([
      "jid",
      "platform",
      "installation",
      "state",
      "route",
      "outcome",
      "code",
      "ending",
      "repository",
      "issue",
      "shared",
      "receivedAt",
      "endedAt",
      "prUrl",
      "summary",
    ])
    for (const job of answer.body.jobs) expect(Object.keys(job).filter((key) => !allowed.has(key))).toEqual([])
    for (const field of [
      "requester",
      "sponsor",
      "device",
      "lease",
      "replyEnc",
      "summaryEnc",
      "limits",
      "kind",
      "declines",
    ])
      expect(answer.text).not.toContain(`"${field}"`)
    for (const secret of [TASK, second.device, second.lease, "D0ALICE01", bobs.jid, old.jid, alice.id])
      expect(answer.text).not.toContain(secret)

    const b = browser(loopback, { activity: true })
    await b.model.setSession(as(alice))
    expect(ready(b.model).jobs?.map((job) => job.jid)).toEqual([third.jid, second.job.jid, first.jid])
    expect(ready(b.model).activityUnread).toEqual([])
    const activity = b.calls.filter(
      (call) => call.path === EVERYWHERE_ROUTES.history || call.path === EVERYWHERE_ROUTES.audit,
    )
    expect(activity.map((call) => `${call.init.method} ${call.path}`)).toEqual([
      `GET ${EVERYWHERE_ROUTES.history}`,
      `GET ${EVERYWHERE_ROUTES.audit}`,
    ])
    for (const call of activity) {
      expect(headers(call).authorization).toBe(`Bearer ${alice.token}`)
      expect(headers(call).accept).toBe("application/json")
      expect(headers(call)["content-type"]).toBeUndefined()
      expect(call.init.body).toBeUndefined()
      expect(call.init.credentials).toBe("omit")
      expect(call.init.cache).toBe("no-store")
      expect(call.init.redirect).toBe("error")
    }
    const html = render(b.model)
    expect(html).toContain(EVERYWHERE_COPY.jobsHeading)
    expect(html).toContain(EVERYWHERE_COPY.jobsNote)
    expect(html).not.toContain(TASK)
    expect(html).not.toContain(EVERYWHERE_COPY.jobsCapped)
  })

  test("GET history counts a record it could not read and says when the 30 days hold more than it answers", async () => {
    await install(SLACK, alice)
    const kept = await seedJob({ account: alice, installation: SLACK, userId: "U0ALICE01", shared: false })
    // A record this deployment cannot decode (a newer deployment's field, after a rollback): counted, not fatal.
    const newer = `vej_${"1".repeat(10)}${"a".repeat(12)}`
    fake.send([
      "SET",
      everywhereKeys.job(newer),
      JSON.stringify({ version: 1, state: "settled", jid: newer, future: true }),
    ])
    fake.send(["ZADD", everywhereKeys.jobHistory(alice.id), fake.clock.now, newer])
    const first = await harness.call("GET", EVERYWHERE_ROUTES.history, { token: alice.token })
    expect(first.body).toMatchObject({ capped: false, skipped: 1 })
    expect(first.body.jobs.map((job: { jid: string }) => job.jid)).toEqual([kept.jid])
    // More than HISTORY_LIMIT ids in the 30 days: the newest are read and the answer says it was cut.
    for (let index = 0; index < HISTORY_LIMIT; index++)
      fake.send([
        "ZADD",
        everywhereKeys.jobHistory(alice.id),
        fake.clock.now + 1 + index,
        `vej_${String(index).padStart(10, "0")}${"b".repeat(12)}`,
      ])
    const cut = await harness.call("GET", EVERYWHERE_ROUTES.history, { token: alice.token })
    expect(cut.body.capped).toBe(true)
    // Ids whose record is gone are not counted as unreadable.
    expect(cut.body.skipped).toBe(0)
    const b = browser(loopback, { activity: true })
    await b.model.setSession(as(alice))
    expect(ready(b.model).jobsCapped).toBe(true)
    expect(render(b.model)).toContain(EVERYWHERE_COPY.jobsCapped)
  })

  test("the jobs view hides summaries for shared places", async () => {
    await install(SLACK, alice)
    await install(LINEAR, alice)
    const dm = await settled(
      await seedJob({ account: alice, installation: SLACK, userId: "U0ALICE01", shared: false }),
      {
        summary: DM_SUMMARY,
      },
    )
    fake.clock.advance(1_000)
    const channel = await settled(
      await seedJob({ account: alice, installation: SLACK, userId: "U0ALICE01", shared: true }),
      {
        summary: CHANNEL_SUMMARY,
      },
    )
    fake.clock.advance(1_000)
    const tracker = await settled(
      await seedJob({ account: alice, installation: LINEAR, userId: LINEAR_USER, shared: true, issue: "ENG-123" }),
      { summary: TRACKER_SUMMARY },
    )
    fake.clock.advance(1_000)
    // In a private place, but another account asked: the sponsor sees the job, not its summary.
    const theirs = await settled(
      await seedJob({ account: alice, installation: SLACK, userId: "U0ALICE02", shared: false, requester: bob.id }),
      { summary: THEIR_SUMMARY },
    )
    const answer = await harness.call("GET", EVERYWHERE_ROUTES.history, { token: alice.token })
    const byJid = Object.fromEntries(answer.body.jobs.map((job: { jid: string }) => [job.jid, job]))
    expect(Object.keys(byJid)).toHaveLength(4)
    expect(byJid[dm.job.jid].summary).toBe(DM_SUMMARY)
    for (const job of [channel, tracker, theirs]) expect(byJid[job.job.jid]).not.toHaveProperty("summary")
    for (const text of [CHANNEL_SUMMARY, TRACKER_SUMMARY, THEIR_SUMMARY]) expect(answer.text).not.toContain(text)

    const b = browser(loopback, { activity: true })
    await b.model.setSession(as(alice))
    const html = render(b.model)
    expect(count(html, DM_SUMMARY)).toBe(1)
    expect(html).toContain(`<p class="everywhere-summary">${DM_SUMMARY}</p>`)
    for (const text of [CHANNEL_SUMMARY, TRACKER_SUMMARY, THEIR_SUMMARY]) expect(html).not.toContain(text)
    expect(count(html, EVERYWHERE_COPY.sharedSummary)).toBe(2)
    expect(html).toContain("ENG-123")
    // A summary is erased once posted (3.2): after the DM's post went out the page has nothing to show.
    expect(await clearSummary(jobsCtx(), dm.job.jid)).toBe(true)
    await b.model.refresh()
    expect(ready(b.model).jobs?.find((job) => job.jid === dm.job.jid)).not.toHaveProperty("summary")
    expect(render(b.model)).not.toContain(DM_SUMMARY)
  })

  test("a held summary is cleaned on the server as the post is: a secret or a diff is withheld, another host's link removed", async () => {
    await install(SLACK, alice)
    const dm = async (summary: string) => {
      const job = await settled(
        await seedJob({ account: alice, installation: SLACK, userId: "U0ALICE01", shared: false }),
        { summary },
      )
      fake.clock.advance(1_000)
      return job.job.jid
    }
    const secret = await dm(SECRET_SUMMARY)
    const diff = await dm(DIFF_SUMMARY)
    const link = await dm(LINK_SUMMARY)
    const onlyLink = await dm(ONLY_LINK_SUMMARY)
    fake.commands.splice(0)
    const answer = await harness.call("GET", EVERYWHERE_ROUTES.history, { token: alice.token })
    expect(answer.status).toBe(200)
    const byJid = Object.fromEntries(answer.body.jobs.map((job: { jid: string }) => [job.jid, job]))
    expect(Object.keys(byJid)).toHaveLength(4)
    expect(byJid[secret].summary).toBe(WITHHELD.secret)
    expect(byJid[diff].summary).toBe(WITHHELD.code)
    expect(byJid[link].summary).toBe("Fixed the login redirect. The log is at for the record.")
    // Nothing is left once the link is removed: no summary at all.
    expect(byJid[onlyLink]).not.toHaveProperty("summary")
    for (const text of [TOKEN, "ghp_", "login.ts", "&#100;", "evil.example"]) expect(answer.text).not.toContain(text)
    // The installation is read once for its four jobs, not once for each.
    const installReads = fake.commands.filter(
      (command) => command[0] === "GET" && command[1] === everywhereKeys.install(SLACK),
    )
    expect(installReads).toHaveLength(1)

    const b = browser(loopback, { activity: true })
    await b.model.setSession(as(alice))
    const html = render(b.model)
    expect(count(html, WITHHELD.secret)).toBe(1)
    expect(count(html, WITHHELD.code)).toBe(1)
    expect(count(html, "Fixed the login redirect. The log is at for the record.")).toBe(1)
    for (const text of [TOKEN, "ghp_", "login.ts", "#100;", "evil.example"]) expect(html).not.toContain(text)
  })

  test("a held summary is gone once its installation is disconnected, and stays gone after a re-install", async () => {
    mountAccount(createAccountApi(deps({ jobs: jobEraser(testEverywhereStore(fake.fetch), () => fake.clock.now) })))
    await install(SLACK, alice)
    const dm = await settled(
      await seedJob({ account: alice, installation: SLACK, userId: "U0ALICE01", shared: false }),
      {
        summary: DM_SUMMARY,
      },
    )
    const b = browser(loopback, { activity: true })
    await b.model.setSession(as(alice))
    expect(ready(b.model).jobs?.[0]?.summary).toBe(DM_SUMMARY)
    b.model.ask({ action: "disconnect", installation: SLACK })
    await b.model.confirm()
    expect(ready(b.model).notice).toBe("disconnected")
    // The job stays listed, ids only.
    expect(ready(b.model).jobs?.map((job) => job.jid)).toEqual([dm.job.jid])
    expect(ready(b.model).jobs?.[0]).not.toHaveProperty("summary")
    expect(render(b.model)).not.toContain(DM_SUMMARY)
    fake.clock.advance(60_000)
    await install(SLACK, alice)
    await b.model.refresh()
    expect(ready(b.model).installs.map((item) => item.installation)).toEqual([SLACK])
    expect(ready(b.model).jobs?.[0]).not.toHaveProperty("summary")
    expect(render(b.model)).not.toContain(DM_SUMMARY)
    expect((await harness.call("GET", EVERYWHERE_ROUTES.history, { token: alice.token })).text).not.toContain(
      DM_SUMMARY,
    )
  })

  test("readJobs drops a summary on a shared job in a forged answer and keeps the job", async () => {
    const shared = forgedJob({ shared: true, summary: CHANNEL_SUMMARY })
    const read = readJobs({ jobs: [shared], capped: false, skipped: 0 })
    expect(read?.items).toHaveLength(1)
    expect(read?.items[0]).not.toHaveProperty("summary")
    expect(read?.skipped).toBe(0)
    const own = forgedJob({ summary: DM_SUMMARY })
    expect(readJobs({ jobs: [own], capped: false, skipped: 0 })?.items[0]?.summary).toBe(DM_SUMMARY)
    await install(SLACK, alice)
    const b = browser(forgedHistory({ jobs: [shared], capped: false, skipped: 0 }), { activity: true })
    await b.model.setSession(as(alice))
    const html = render(b.model)
    expect(html).not.toContain(CHANNEL_SUMMARY)
    expect(html).toContain(EVERYWHERE_COPY.sharedSummary)
  })

  test("each job's platform, route, state, outcome, reason, ending and pull request link", async () => {
    const actions = forgedJob({ state: "running", route: "actions", outcome: undefined })
    const refused = forgedJob({ state: "refused", route: undefined, outcome: undefined, code: "not-mapped" })
    const lost = forgedJob({ state: "lost", outcome: undefined, ending: "lost", endedAt: fake.clock.now + 5 })
    const done = forgedJob({ prUrl: "https://github.com/acme/app/pull/7", issue: "ENG-12" })
    const github = forgedJob({
      platform: "github",
      installation: "github:4242",
      state: "dispatched",
      route: "actions",
      outcome: undefined,
    })
    const jobs = [actions, refused, lost, done, github].map((job) =>
      Object.fromEntries(Object.entries(job).filter((entry) => entry[1] !== undefined)),
    )
    await install(SLACK, alice)
    const b = browser(forgedHistory({ jobs, capped: true, skipped: 0 }), { activity: true })
    await b.model.setSession(as(alice))
    expect(ready(b.model).jobs).toHaveLength(5)
    const html = render(b.model)
    const row = (jid: string) => html.slice(html.indexOf(`id="job-${jid}"`)).split("</li>")[0]!
    // A running Actions job is not said to be on your computer.
    expect(row(actions.jid)).toContain("Running · Route: GitHub Actions")
    expect(row(actions.jid)).not.toContain("your computer")
    expect(row(refused.jid)).toContain("Refused")
    expect(row(refused.jid)).toContain("Reason: <code>not-mapped</code>")
    expect(row(lost.jid)).toContain("Lost · Route: your computer")
    expect(row(lost.jid)).toContain("Ending: <code>lost</code>")
    expect(row(lost.jid)).toContain(`Ended <time dateTime="${new Date(fake.clock.now + 5).toISOString()}">`)
    expect(row(done.jid)).toContain("Finished · Route: your computer · Outcome: changes made")
    expect(row(done.jid)).toContain(
      '<a href="https://github.com/acme/app/pull/7" rel="noopener noreferrer">Pull request</a>',
    )
    expect(row(done.jid)).toContain("ENG-12")
    expect(row(done.jid)).toContain(`<code>${done.jid}</code>`)
    expect(row(done.jid)).toContain("Slack workspace T0123ABCD")
    expect(row(github.jid)).toContain("<strong>GitHub</strong>")
    expect(row(github.jid)).toContain("GitHub installation 4242")
    expect(row(github.jid)).toContain("Sent to GitHub Actions · Route: GitHub Actions")
    expect(html).toContain(EVERYWHERE_COPY.jobsCapped)
    expect(html).toContain(formatTime(fake.clock.now))
    expect(formatTime(Date.UTC(2026, 10, 20, 9, 5, 59))).toBe("2026-11-20 09:05 (UTC)")
    // Every word has its text.
    expect(Object.keys(EVERYWHERE_COPY.jobState)).toEqual([...JOB_STATES])
    expect(Object.keys(EVERYWHERE_COPY.jobRoute)).toEqual(["laptop", "actions", "queue"])
    expect(Object.keys(EVERYWHERE_COPY.jobOutcome)).toEqual([...OUTCOMES])
    expect(Object.keys(PLATFORM_NAMES)).toEqual([...PLATFORMS])
  })

  test("readJobs skips each malformed entry, and the page says some could not be shown", async () => {
    const good = forgedJob()
    const malformed = [
      forgedJob({ device: "a".repeat(21) + "A" }),
      forgedJob({ jid: "vej_short" }),
      forgedJob({ installation: LINEAR }),
      forgedJob({ state: "paused" }),
      forgedJob({ route: "refuse" }),
      forgedJob({ outcome: "great" }),
      forgedJob({ code: "because" }),
      forgedJob({ ending: "gone" }),
      forgedJob({ repository: "not a repository" }),
      forgedJob({ issue: "eng 1" }),
      forgedJob({ shared: "no" }),
      forgedJob({ receivedAt: -1 }),
      forgedJob({ prUrl: "https://github.com/other/app/pull/7" }),
      forgedJob({ prUrl: "https://example.com/acme/app/pull/7" }),
      forgedJob({ summary: "x".repeat(1_501) }),
      forgedJob({ summary: "" }),
      { ...good },
      "job",
      null,
    ]
    const read = readJobs({ jobs: [good, ...malformed], capped: false, skipped: 2 })
    expect(read?.items.map((job) => job.jid)).toEqual([good.jid])
    expect(read?.skipped).toBe(malformed.length + 2)
    expect(
      readJobs({ jobs: [good, forgedJob({ prUrl: "https://github.com/ACME/App/pull/7" })], capped: false, skipped: 0 })
        ?.items,
    ).toHaveLength(2)
    expect(
      readJobs({ jobs: Array.from({ length: JOBS_LIMIT + 3 }, () => forgedJob()), capped: true, skipped: 0 })?.skipped,
    ).toBe(3)
    for (const answer of [
      { jobs: [], capped: false },
      { jobs: [], skipped: 0 },
      { jobs: {}, capped: false, skipped: 0 },
      { jobs: [], capped: false, skipped: -1 },
      [],
    ])
      expect(readJobs(answer)).toBeUndefined()
    await install(SLACK, alice)
    const b = browser(forgedHistory({ jobs: [good, malformed[0]], capped: false, skipped: 0 }), { activity: true })
    await b.model.setSession(as(alice))
    expect(ready(b.model).partial).toBe(true)
    expect(render(b.model)).toContain(EVERYWHERE_COPY.partial)
  })

  test("a refused session on a jobs read asks to sign in again; a jobs read that fails is named and the lists still show", async () => {
    await install(SLACK, alice)
    const refused = browser(forgedHistory({ error: { code: "SESSION_INVALID" } }, 401), { activity: true })
    await refused.model.setSession(as(alice))
    expect(refused.model.state().kind).toBe("session-expired")
    for (const status of [503, 404, 0]) {
      const b = browser(
        status === 0
          ? (route, init) =>
              route === EVERYWHERE_ROUTES.history ? Promise.reject(new TypeError("offline")) : loopback(route, init)
          : forgedHistory({ error: { code: "PERSISTENT_STORE_UNAVAILABLE" } }, status),
        { activity: true },
      )
      await b.model.setSession(as(alice))
      expect(ready(b.model).loaded).toBe(true)
      expect(ready(b.model).activityUnread).toEqual(["jobs"])
      expect(ready(b.model).partial).toBe(false)
      const html = render(b.model)
      expect(count(html, EVERYWHERE_COPY.jobsUnread)).toBe(1)
      expect(html).not.toContain(EVERYWHERE_COPY.jobsEmpty)
      expect(html).toContain("Slack workspace T0123ABCD")
      expect(html).toContain(EVERYWHERE_COPY.auditHeading)
    }
    // An answer the decoder refuses is unread too, never "no job".
    const forged = browser(forgedHistory({ jobs: "none" }), { activity: true })
    await forged.model.setSession(as(alice))
    expect(ready(forged.model).activityUnread).toEqual(["jobs"])
  })

  test("a vectordev.ai job link marks its job; a missing one says so; a malformed one is ignored", async () => {
    const job = forgedJob()
    expect(focusJob(`?job=${job.jid}`)).toBe(job.jid)
    expect(focusJob(`?x=1&job=${job.jid}`)).toBe(job.jid)
    for (const search of [`?job=${job.jid}&job=${job.jid}`, "?job=vej_bad", "?job=", "", "?other=1", undefined])
      expect(focusJob(search)).toBeUndefined()
    await install(SLACK, alice)
    const b = browser(forgedHistory({ jobs: [job], capped: false, skipped: 0 }), { activity: true })
    await b.model.setSession(as(alice))
    const marked = renderFocused(b.model, focusJob(`?job=${job.jid}`))
    expect(marked).toContain(`<li id="job-${job.jid}" class="everywhere-job everywhere-focus" aria-current="true">`)
    expect(marked).not.toContain(EVERYWHERE_COPY.focusMissing)
    const missing = renderFocused(b.model, `vej_${"z".repeat(22)}`)
    expect(missing).toContain(EVERYWHERE_COPY.focusMissing)
    expect(missing).not.toContain("everywhere-focus")
    const ignored = renderFocused(b.model, focusJob("?job=vej_bad"))
    expect(ignored).not.toContain(EVERYWHERE_COPY.focusMissing)
    expect(ignored).not.toContain("everywhere-focus")
  })

  test("without activity, as on EV-22's page and the link page, no jobs or audit read is sent", async () => {
    await install(SLACK, alice)
    const b = browser()
    await b.model.setSession(as(alice))
    await b.model.refresh()
    const read = b.calls.map((call) => call.path)
    expect(read).not.toContain(EVERYWHERE_ROUTES.history)
    expect(read).not.toContain(EVERYWHERE_ROUTES.audit)
    expect(ready(b.model).jobs).toBeUndefined()
    expect(ready(b.model).audit).toBeUndefined()
    const html = render(b.model)
    expect(html).not.toContain(EVERYWHERE_COPY.jobsHeading)
    expect(html).not.toContain(EVERYWHERE_COPY.auditHeading)
  })
})

describe("the audit log", () => {
  test("GET audit: newest first, without another account's id or the computer's, nothing older than 90 days", async () => {
    await install(SLACK, alice)
    fake.clock.advance(1_000)
    const done = await settled(
      await seedJob({ account: alice, installation: SLACK, userId: "U0ALICE01", shared: false }),
    )
    fake.clock.advance(1_000)
    // Bob, an admin of the workspace, re-installs: Alice's log records the connector change.
    const reinstall = await recordInstall(ctx(), {
      account: bob.id,
      event: "install",
      grant: { installation: SLACK, scopes: [], installer: { admin: true, userId: "U0BOB0001" } },
    })
    expect(reinstall.ok).toBe(true)
    // Appended last, with its own old time, so no later append trims it.
    const ancient = await appendAudit(
      ctx().store,
      alice.id,
      { event: "link", platform: "slack", installation: SLACK, userId: "U0ALICE01" },
      fake.clock.now - 91 * DAY,
      testAccountAuthority,
    )
    const answer = await harness.call("GET", EVERYWHERE_ROUTES.audit, { token: alice.token })
    expect(answer.status).toBe(200)
    const entries = answer.body.entries as Record<string, unknown>[]
    const times = entries.map((entry) => entry.at as number)
    expect(times).toEqual([...times].sort((a, b) => b - a))
    expect(entries.map((entry) => entry.id)).not.toContain(ancient.id)
    expect(entries.map((entry) => entry.event)).toEqual(
      expect.arrayContaining(["install", "job-accepted", "offer", "claim", "settle", "connector-change"]),
    )
    const change = entries.find((entry) => entry.event === "connector-change")
    expect(change).toEqual({
      id: change!.id,
      at: change!.at,
      event: "connector-change",
      platform: "slack",
      installation: SLACK,
      code: "admin",
      userId: "U0BOB0001",
      byOther: true,
    })
    const settle = entries.find((entry) => entry.event === "settle" && entry.jid === done.job.jid)
    expect(settle).toMatchObject({ code: "changes", installation: SLACK })
    expect(settle).not.toHaveProperty("device")
    const allowed = new Set(["id", "at", "event", "platform", "installation", "jid", "code", "userId", "byOther"])
    for (const entry of entries) expect(Object.keys(entry).filter((key) => !allowed.has(key))).toEqual([])
    for (const secret of [bob.id, done.device, `"actor"`, `"device"`]) expect(answer.text).not.toContain(secret)

    const b = browser(loopback, { activity: true })
    await b.model.setSession(as(alice))
    expect(ready(b.model).audit?.map((entry) => entry.id)).toEqual(entries.map((entry) => String(entry.id)))
    const html = render(b.model)
    expect(html).toContain(EVERYWHERE_COPY.auditHeading)
    expect(html).toContain(EVERYWHERE_COPY.auditNote)
    expect(html).toContain(EVERYWHERE_COPY.auditEvent["connector-change"])
    expect(html).toContain(EVERYWHERE_COPY.auditEvent.claim)
    expect(count(html, EVERYWHERE_COPY.byOther)).toBe(1)
    expect(html).toContain("Code: <code>admin</code>")
    expect(html).toContain("user <code>U0BOB0001</code>")
    expect(html).toContain(`<code>${done.job.jid}</code>`)
    for (const secret of [bob.id, bob.email, alice.id, alice.email, done.device]) expect(html).not.toContain(secret)
  })

  test("the vocabularies, limits and patterns are the server's", () => {
    expect([...EVERYWHERE_AUDIT_EVENTS]).toEqual([...AUDIT_EVENTS])
    expect(new Set(EVERYWHERE_AUDIT_CODES)).toEqual(new Set(AUDIT_CODES))
    expect([...JOB_ENDINGS]).toEqual([...ENDINGS])
    expect(JOBS_LIMIT).toBe(HISTORY_LIMIT)
    expect(AUDIT_LIMIT).toBe(AUDIT_PAGE)
    expect(GITHUB_USER_ID_PATTERN.source).toBe(USER_ID_PATTERNS.github.source)
    expect(Object.keys(EVERYWHERE_COPY.auditEvent)).toEqual([...AUDIT_EVENTS])
    for (const code of [...REFUSAL_CODES, ...DECLINE_CODES]) expect(EVERYWHERE_AUDIT_CODES.has(code)).toBe(true)
  })

  test("readAuditEntries skips each malformed entry", () => {
    const entry = (extra: Record<string, unknown> = {}) => ({
      id: randomBytes(13).toString("hex"),
      at: fake.clock.now,
      event: "link",
      platform: "slack",
      installation: SLACK,
      userId: "U0ALICE01",
      ...extra,
    })
    const good = entry()
    const malformed = [
      entry({ device: "a".repeat(21) + "A" }),
      entry({ actor: alice.id }),
      entry({ id: "short" }),
      entry({ at: 0 }),
      entry({ event: "login" }),
      entry({ platform: "linear" }),
      entry({ installation: "slack:lowercase" }),
      entry({ jid: "vej_bad" }),
      entry({ code: "because" }),
      entry({ userId: LINEAR_USER }),
      entry({ byOther: false }),
      { ...good },
      "entry",
    ]
    const read = readAuditEntries({ entries: [good, ...malformed] })
    expect(read?.items.map((item) => item.id)).toEqual([good.id])
    const first: unknown = read?.items[0]
    expect(first).toEqual({ ...good, byOther: false })
    expect(read?.skipped).toBe(malformed.length)
    expect(
      readAuditEntries({
        entries: [entry({ platform: undefined, installation: "github:42", userId: "12345", byOther: true })],
      })?.items[0],
    ).toMatchObject({ platform: "github", byOther: true })
    expect(readAuditEntries({ entries: Array.from({ length: AUDIT_LIMIT + 2 }, () => entry()) })?.skipped).toBe(2)
    expect(readAuditEntries({ entries: "none" })).toBeUndefined()
  })
})

describe("nothing is routed", () => {
  const web = path.join(import.meta.dir, "..")

  test("no page, docs entry or prune keep line names everywhere: the keep set lacks everywhere", async () => {
    const pages = [...new Bun.Glob("**/*").scanSync({ cwd: path.join(web, "src/pages") })]
    expect(pages.length).toBeGreaterThan(10)
    expect(pages.filter((file) => /everywhere/i.test(file))).toEqual([])
    const nav = await Bun.file(path.join(web, "src/data/docs-nav.ts")).text()
    expect(nav).toContain("automations")
    expect(nav).not.toMatch(/["'`][^"'`]*\/everywhere/i)
    expect(nav).not.toMatch(/(?:id|slug):\s*["'`]everywhere["'`]/)
    // Read as text: importing the script would run the prune.
    const prune = await Bun.file(path.join(web, "../../script/prune-vector-site.mjs")).text()
    const block = /const keep = new Set\(\[([\s\S]*?)\]\)/.exec(prune)?.[1] ?? ""
    const keep = [...block.replace(/\/\/.*$/gm, "").matchAll(/"([^"]+)"/g)].map((match) => match[1])
    expect(keep).toContain("account")
    expect(keep).toContain("docs")
    expect(keep).not.toContain("everywhere")
  })

  test("the drafts exist and nothing is routed", async () => {
    const drafts = [
      { draft: "everywhere.astro", root: "EverywhereAccount", title: "Vector everywhere" },
      { draft: "everywhere/link.astro", root: "EverywhereLink", title: "Link Linear · Vector everywhere" },
    ]
    for (const item of drafts) {
      const file = path.join(web, "src/drafts", item.draft)
      // Where the owner moves it at 2.0.0 (spec 6.5): not there before.
      const future = path.join(web, "src/pages", item.draft)
      expect(await Bun.file(future).exists()).toBe(false)
      const text = await Bun.file(file).text()
      const lines = text.split("\n")
      expect(lines[0]).toBe("---")
      expect(lines[1]).toBe(
        "// Unreleased draft: Astro routes only src/pages, so this page is not built, linked or listed in the sitemap.",
      )
      expect(text).toContain("export const prerender = true")
      expect(text).toContain(`<MarketingLayout title="${item.title}" `)
      expect(text).toMatch(/<MarketingLayout [^>]*\snoindex>/)
      expect(text).toContain(`<${item.root} client:only="react" />`)
      // Every import resolves to the same file from src/drafts now and from src/pages after the move.
      const imports = [...text.matchAll(/from "(\.[^"]+)"/g)].map((match) => match[1]!)
      expect(imports).toHaveLength(2)
      for (const specifier of imports)
        for (const from of [path.dirname(file), path.dirname(future)]) {
          const found = ["", ".tsx", ".ts", ".astro"].map((ending) => path.resolve(from, specifier + ending))
          const exists = await Promise.all(found.map((candidate) => Bun.file(candidate).exists()))
          expect(exists.some(Boolean)).toBe(true)
          expect(found.find((_, index) => exists[index])!.startsWith(path.join(web, "src/components/marketing/"))).toBe(
            true,
          )
        }
    }
    // noindex keeps the robots tag on and the visit counter off (MarketingLayout.astro).
    const layout = await Bun.file(path.join(web, "src/components/marketing/MarketingLayout.astro")).text()
    expect(layout).toContain('{noindex && <meta name="robots" content="noindex, nofollow" />}')
    expect(layout).toMatch(/!noindex && \(\s*<>[\s\S]*?\/_vercel\/insights\/script\.js[\s\S]*?<\/>\s*\)/)
  })

  test("nothing imports or links the drafts, and the Astro config does not name them", async () => {
    const src = path.join(web, "src")
    const files = [...new Bun.Glob("**/*.{ts,tsx,astro,mjs,js,md,mdx}").scanSync({ cwd: src })]
    expect(files.length).toBeGreaterThan(100)
    const texts = await Promise.all(
      files.map(async (file) => ({ file, text: await Bun.file(path.join(src, file)).text() })),
    )
    expect(
      texts.filter((item) => /(?:from|import\()\s*["'][^"']*drafts\//.test(item.text)).map((item) => item.file),
    ).toEqual([])
    const outside = texts.filter(
      (item) => !item.file.startsWith("components/marketing/everywhere/") && !item.file.startsWith("drafts/everywhere"),
    )
    expect(
      outside
        .filter(
          (item) => /href=["'{`][^"'`]*\/everywhere/.test(item.text) || /vectordev\.ai\/everywhere/.test(item.text),
        )
        .map((item) => item.file),
    ).toEqual([])
    const config = await Bun.file(path.join(web, "astro.config.mjs")).text()
    expect(config).not.toContain("drafts")
    expect(config).not.toMatch(/everywhere/i)
  })
})

describe.skipIf(!process.env.VECTOR_TEST_REDIS_URL)("against a real Redis", () => {
  test("GET history reads the account's jobs, newest first, with the private place's summary only", async () => {
    const redis = (await realRedis())!
    try {
      const store = testEverywhereStore(redis.fetch)
      const keys = readConfig(env).dataKeys
      const real = (): JobsContext => ({
        store,
        keys,
        now: Date.now(),
        offer: OFFER,
        accountAuthority: testAccountAuthority,
      })
      const owner = accounts.add(testAccount("redis-owner@example.com"))
      const installation = `slack:T${randomBytes(8).toString("hex").toUpperCase()}`
      const base: NewJob = {
        platform: "slack",
        installation,
        kind: "dm",
        requester: { userId: "U0ALICE01", account: owner.id },
        sponsor: owner.id,
        repository: { id: 4242, fullName: "acme/app", shared: false },
        shared: false,
        task: TASK,
        context: [],
      }
      await seedJobAuthority(real(), base)
      await Bun.sleep(2)
      const create = async (input: NewJob) => {
        const verdict = await createJob(real(), input)
        if (!verdict.ok) throw new Error(`createJob refused: ${verdict.code}`)
        return verdict.job
      }
      const dm = await create(base)
      const device = randomBytes(16).toString("base64url")
      expect((await offerJob(real(), dm.jid)).ok).toBe(true)
      const claim = await claimJob(real(), { account: owner.id, jid: dm.jid, device })
      if (!claim.ok) throw new Error(`claim refused: ${claim.code}`)
      expect(
        (
          await settleJob(real(), {
            account: owner.id,
            device,
            settle: { jid: dm.jid, lease: claim.job.lease.id, outcome: "changes", summary: DM_SUMMARY },
          })
        ).ok,
      ).toBe(true)
      await Bun.sleep(2)
      const channel = await create({ ...base, kind: "mention", shared: true })
      mountAccount(createAccountApi({ ...deps(), store, now: Date.now }))
      const answer = await harness.call("GET", EVERYWHERE_ROUTES.history, { token: owner.token })
      expect(answer.status).toBe(200)
      expect(answer.body.jobs.map((job: { jid: string }) => job.jid)).toEqual([channel.jid, dm.jid])
      expect(answer.body.jobs[1].summary).toBe(DM_SUMMARY)
      expect(answer.body.jobs[0]).not.toHaveProperty("summary")
      expect(answer.body.capped).toBe(false)
      expect(answer.body.skipped).toBe(0)
      expect(answer.text).not.toContain(TASK)
    } finally {
      await redis.close()
    }
  })
})
