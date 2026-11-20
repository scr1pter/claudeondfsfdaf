import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test"
import { randomBytes, randomUUID } from "node:crypto"
import path from "node:path"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { createAccountApi, type AccountApiDeps } from "../../../api/_lib/everywhere/account-api"
import { readConfig } from "../../../api/_lib/everywhere/config"
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
import { KEEP_MS, USER_ID_PATTERNS, everywhereKeys } from "../../../api/_lib/everywhere/keys"
import { storeUnavailable } from "../../../api/_lib/everywhere/store"
import {
  EVERYWHERE_AUTHORIZE,
  EVERYWHERE_COPY,
  EVERYWHERE_ROUTES,
  LINK_CODE_MS,
  LINK_CODE_PATTERN,
  LINK_USER_ID_PATTERNS,
  PLACE_ID_PATTERN,
  connectAccountSession,
  createEverywhereAccountModel,
  installationLabel,
  placeLabel,
  problemOf,
  readAuthorize,
  readInstalls,
  readLinkCode,
  readLinks,
  readMappings,
  signInPath,
  type EverywhereAccountModel,
  type EverywhereAuth,
  type EverywhereAuthSession,
  type EverywhereReady,
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
import { FakeStore, testAccountAuthority, testEverywhereStore, useKv } from "./lib/everywhere-store"

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
const { EverywhereAccountView } = await import("../src/components/marketing/everywhere/EverywhereView")
const { EverywhereAccount } = await import("../src/components/marketing/everywhere/EverywhereAccount")

installFetchGuard()

/*
 * VE-42a (EV-22): the vectordev.ai account components for Vector everywhere, at model level. The model drives the real
 * account routes (createAccountApi) on 127.0.0.1 with the real bearer check against FakeAccounts, and the views are
 * rendered from its state with renderToStaticMarkup. Nothing here reaches a platform, a browser or the network.
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
  harness.use(createAccountApi(deps()))
})

type Call = { readonly path: string; readonly init: RequestInit }
type Request = (path: string, init: RequestInit) => Promise<Response>
const loopback: Request = (route, init) => fetch(harness.origin + route, init)

/** A browser: the model with a recording request, a recording navigation and a manual timer. */
function browser(request: Request = loopback) {
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
    await b.model.signInAgain("/everywhere?code=C0DE")
    expect(b.signOuts).toEqual(["local"])
    expect(b.navigations).toEqual(["/login?returnTo=%2Feverywhere"])
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

describe("nothing is routed", () => {
  const web = path.join(import.meta.dir, "..")

  test("no page, docs entry or prune keep line names everywhere", async () => {
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
})
