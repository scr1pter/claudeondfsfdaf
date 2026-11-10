/** @jsxImportSource react */
import { Option, Schema } from "effect"
import { CodiumOwner } from "@vectordevai/schema/codium-owner"
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react"
import vectorMark from "../../../assets/vector-mark.webp"
import { rememberAccountReturnPath, vectorAccountClient } from "../../../lib/account-client"
import { GoogleMark } from "../account/AuthPage"
import "../account/account.css"
import "./codium-owner.css"

export const OWNER_REFRESH_MS = 60_000
export type OwnerMutation = "switch" | "reconcile" | "replay" | "clear-risk" | "refund-end"
type OwnerInput = Record<string, string | number | null>
type State =
  | { kind: "loading" }
  | { kind: "signin"; message: string; fresh: boolean }
  | { kind: "denied"; message: string }
  | { kind: "failed"; message: string }
  | { kind: "ready"; summary: CodiumOwner.Dashboard }

const decodeDashboard = Schema.decodeUnknownOption(CodiumOwner.Dashboard)
const dollars = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2 })
const whole = new Intl.NumberFormat("en-US")
const days = new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 })
const percent = new Intl.NumberFormat("en-US", { style: "percent", maximumFractionDigits: 2 })
const when = new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" })
const PLAN_NAMES = { "vector-10": "Plus", "vector-50": "Pro", "vector-100": "Max", "vector-200": "Ultra" } as const
const SWITCHES = {
  sales: ["New sales", "Stops new purchases; existing subscribers keep access."],
  codium: ["Codium", "Stops model access; an extended shutdown pauses subscription collection."],
  cloudAgents: ["Cloud agents", "Controls Codium access inside repository agent runs."],
  hosted: ["Hosted computers", "No new stops new work; Stop also stops running work."],
  ops: ["Production checks", "Controls production monitoring and fix services."],
  remote: ["Remote", "Controls the remote connection service."],
  vault: ["Vault", "Controls the hosted backup service."],
  push: ["Push notifications", "Controls push delivery."],
} as const

const money = (value: number | null | undefined) =>
  value === null || value === undefined ? "Unavailable" : dollars.format(value / 100)
const count = (value: number | null | undefined) =>
  value === null || value === undefined ? "Unavailable" : whole.format(value)
const time = (value: number | undefined) =>
  value === undefined || !Number.isFinite(new Date(value).getTime()) ? "Unavailable" : `${when.format(value)} UTC`
const accountID = (value: string) => /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value)

export class CodiumOwnerRequestError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
  ) {
    super(ownerMessage(code))
  }
}

function ownerMessage(code: string) {
  if (["SIGN_IN_REQUIRED", "SESSION_INVALID"].includes(code)) return "Sign in with Google to open the owner dashboard."
  if (code === "GOOGLE_SIGN_IN_REQUIRED") return "Use the owner's Google sign-in to continue."
  if (code === "RECENT_SIGN_IN_REQUIRED") return "Sign in with Google again before changing Codium."
  if (code === "DESIGN_LAB_FORBIDDEN") return "This account cannot open the owner dashboard."
  if (code === "CODIUM_REFUND_CHANGED") return "The refund details changed. Refresh and review a new confirmation."
  if (code === "CODIUM_REFUND_PENDING") return "The refund is still processing. Access stays stopped while it settles."
  if (code === "CODIUM_REFUND_FAILED")
    return "The refund did not complete. Review the payment in Stripe before confirming another attempt."
  if (code === "REPLAY_SINCE_INVALID") return "Choose a UTC time within the last 30 days."
  if (code === "OWNER_RESPONSE_INVALID") return "The owner dashboard returned an incomplete response."
  return "Vector could not confirm this request. Refresh the dashboard before trying again."
}

export function ownerGate(error: unknown): Exclude<State, { kind: "ready" } | { kind: "loading" }> {
  if (error instanceof CodiumOwnerRequestError) {
    if (["GOOGLE_SIGN_IN_REQUIRED", "RECENT_SIGN_IN_REQUIRED"].includes(error.code))
      return { kind: "signin", message: error.message, fresh: true }
    if (error.status === 401) return { kind: "signin", message: ownerMessage("SIGN_IN_REQUIRED"), fresh: false }
    if (error.status === 403) return { kind: "denied", message: ownerMessage("DESIGN_LAB_FORBIDDEN") }
    return { kind: "failed", message: error.message }
  }
  return { kind: "failed", message: ownerMessage("OWNER_REQUEST_FAILED") }
}

async function ownerCall(
  path: string,
  token: string,
  input: OwnerInput | undefined,
  fetcher: typeof fetch,
  signal?: AbortSignal,
) {
  if (!token.trim()) throw new CodiumOwnerRequestError("SIGN_IN_REQUIRED", 401)
  const response = await fetcher(`/api/owner/${path}`, {
    method: input === undefined ? "GET" : "POST",
    headers: {
      accept: "application/json",
      authorization: `Bearer ${token}`,
      ...(input === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(input === undefined ? {} : { body: JSON.stringify(input) }),
    cache: "no-store",
    credentials: "omit",
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(65_000)]) : AbortSignal.timeout(65_000),
  })
  const payload: unknown = response.headers.get("content-type")?.toLowerCase().includes("json")
    ? await response.json().catch(() => undefined)
    : undefined
  if (!response.ok) {
    const detail = record(payload) && record(payload.error) ? payload.error : undefined
    const code =
      detail && typeof detail.code === "string" && /^[A-Z_]{1,80}$/.test(detail.code)
        ? detail.code
        : "OWNER_REQUEST_FAILED"
    throw new CodiumOwnerRequestError(code, response.status)
  }
  return payload
}

export async function readCodiumOwner(token: string, fetcher: typeof fetch = fetch, signal?: AbortSignal) {
  const summary = Option.getOrUndefined(decodeDashboard(await ownerCall("codium", token, undefined, fetcher, signal)))
  if (!summary) throw new CodiumOwnerRequestError("OWNER_RESPONSE_INVALID", 502)
  return summary
}

export async function mutateCodiumOwner(
  operation: OwnerMutation,
  token: string,
  input: OwnerInput,
  fetcher: typeof fetch = fetch,
  signal?: AbortSignal,
) {
  if (!["switch", "reconcile", "replay", "clear-risk", "refund-end"].includes(operation))
    throw new CodiumOwnerRequestError("OWNER_REQUEST_INVALID", 400)
  const answer = await ownerCall(`codium-${operation}`, token, input, fetcher, signal)
  if (!record(answer) || answer.accepted !== true) throw new CodiumOwnerRequestError("OWNER_RESPONSE_INVALID", 502)
}

export function replaySince(value: string, now = Date.now()) {
  const date = new Date(`${value}Z`)
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value) ||
    !Number.isFinite(date.getTime()) ||
    date.toISOString().slice(0, 16) !== value ||
    date.getTime() > now ||
    date.getTime() < now - 30 * 86_400_000
  )
    throw new CodiumOwnerRequestError("REPLAY_SINCE_INVALID", 400)
  return Math.floor(date.getTime() / 1000)
}

export function refundRequest(account: CodiumOwner.Account) {
  if (
    !accountID(account.account) ||
    account.refundCents === undefined ||
    !Number.isSafeInteger(account.refundCents) ||
    account.refundCents < 0 ||
    account.refundCharge === undefined ||
    account.refundSubscription === undefined ||
    account.refundPeriodStart === undefined ||
    (account.refundCents > 0 && !account.refundCharge)
  )
    return undefined
  return {
    account: account.account,
    expectedCharge: account.refundCharge,
    expectedRefundCents: account.refundCents,
    expectedSubscription: account.refundSubscription,
    expectedPeriodStart: account.refundPeriodStart,
  }
}

/** The public prerender contains only the gate. Owner data stays in browser memory after authenticated reads. */
export function CodiumOwnerPage() {
  const [state, setState] = useState<State>({ kind: "loading" })
  const [refreshing, setRefreshing] = useState(false)
  const [pending, setPending] = useState("")
  const [notice, setNotice] = useState<{ text: string; error?: boolean }>()
  const alive = useRef(true)
  const lifetime = useRef(0)
  const generation = useRef(0)
  const identity = useRef(0)
  const user = useRef<string | undefined>(undefined)
  const busy = useRef(false)
  const reading = useRef<AbortController | undefined>(undefined)
  const writing = useRef<AbortController | undefined>(undefined)

  const clear = () => {
    identity.current++
    generation.current++
    reading.current?.abort()
    writing.current?.abort()
    busy.current = false
    setPending("")
    setNotice(undefined)
    setState({ kind: "signin", message: ownerMessage("SIGN_IN_REQUIRED"), fresh: false })
  }

  const load = async () => {
    if (busy.current) return
    const current = ++generation.current
    reading.current?.abort()
    const controller = new AbortController()
    reading.current = controller
    setRefreshing(true)
    try {
      const client = await vectorAccountClient()
      const session = await client.auth.getSession()
      if (!alive.current || current !== generation.current) return
      if (session.error || !session.data.session) throw new CodiumOwnerRequestError("SIGN_IN_REQUIRED", 401)
      if (user.current && user.current !== session.data.session.user.id) {
        clear()
        user.current = session.data.session.user.id
        void load()
        return
      }
      user.current = session.data.session.user.id
      const summary = await readCodiumOwner(session.data.session.access_token, fetch, controller.signal)
      if (alive.current && current === generation.current) setState({ kind: "ready", summary })
    } catch (error) {
      if (alive.current && current === generation.current && !controller.signal.aborted) setState(ownerGate(error))
    } finally {
      if (alive.current && current === generation.current) setRefreshing(false)
    }
  }

  useEffect(() => {
    alive.current = true
    const mounted = ++lifetime.current
    let unsubscribe: (() => void) | undefined
    void vectorAccountClient()
      .then((client) => {
        if (!alive.current || mounted !== lifetime.current) return
        const listener = client.auth.onAuthStateChange((event, session) => {
          if (event === "SIGNED_OUT" || (user.current && session?.user.id !== user.current)) {
            clear()
            user.current = session?.user.id
          }
          if (["SIGNED_IN", "TOKEN_REFRESHED"].includes(event))
            queueMicrotask(() => {
              if (alive.current) void load()
            })
        })
        unsubscribe = () => listener.data.subscription.unsubscribe()
        void load()
      })
      .catch(() => {
        if (alive.current) setState({ kind: "failed", message: "Vector accounts are temporarily unavailable." })
      })
    const interval = setInterval(() => {
      if (!busy.current) void load()
    }, OWNER_REFRESH_MS)
    return () => {
      alive.current = false
      lifetime.current++
      generation.current++
      reading.current?.abort()
      writing.current?.abort()
      unsubscribe?.()
      clearInterval(interval)
    }
  }, [])

  const google = async (fresh: boolean) => {
    rememberAccountReturnPath("/owner/codium")
    clear()
    try {
      const client = await vectorAccountClient()
      if (fresh) {
        const ended = await client.auth.signOut({ scope: "local" })
        if (ended.error) throw ended.error
      }
      const started = await client.auth.signInWithOAuth({
        provider: "google",
        options: {
          redirectTo: `${location.origin}/account`,
          ...(fresh ? { queryParams: { prompt: "select_account" } } : {}),
        },
      })
      if (started.error) throw started.error
    } catch {
      setState({ kind: "failed", message: "Google sign-in could not start. Try again." })
    }
  }

  const mutate = async (operation: OwnerMutation, input: OwnerInput) => {
    if (busy.current || refreshing) return
    busy.current = true
    const current = identity.current
    const controller = new AbortController()
    writing.current = controller
    setPending(operation)
    setNotice(undefined)
    try {
      const client = await vectorAccountClient()
      const session = await client.auth.getSession()
      if (session.error || !session.data.session || session.data.session.user.id !== user.current)
        throw new CodiumOwnerRequestError("SESSION_INVALID", 401)
      await mutateCodiumOwner(operation, session.data.session.access_token, input, fetch, controller.signal)
      if (!alive.current || current !== identity.current) return
      busy.current = false
      setPending("")
      setNotice({ text: "Request accepted. Status will update as the work completes." })
      await load()
    } catch (error) {
      if (!alive.current || current !== identity.current) return
      const gate = ownerGate(error)
      if (gate.kind === "signin" || gate.kind === "denied") setState(gate)
      else setNotice({ text: gate.message, error: true })
      if (error instanceof CodiumOwnerRequestError && error.code === "CODIUM_REFUND_CHANGED") {
        busy.current = false
        await load()
      }
      throw error
    } finally {
      if (alive.current && current === identity.current) {
        busy.current = false
        setPending("")
      }
    }
  }

  if (state.kind === "ready")
    return (
      <OwnerDashboard
        summary={state.summary}
        onRefresh={load}
        onMutation={mutate}
        pending={pending || (refreshing ? "refresh" : "")}
        notice={notice}
      />
    )
  return <OwnerGate state={state} onGoogle={google} onRetry={load} />
}

function OwnerGate(props: {
  state: Exclude<State, { kind: "ready" }>
  onGoogle: (fresh: boolean) => void
  onRetry: () => void
}) {
  return (
    <div className="login-shell">
      <header className="login-top">
        <a className="login-brand" href="/" aria-label="Vector home">
          <img src={vectorMark.src} alt="" width="26" height="26" />
          <span>Vector</span>
        </a>
      </header>
      <main className="login-main">
        <section className="auth-card" aria-labelledby="owner-gate-title">
          <p className="auth-form-eyebrow">PRIVATE</p>
          <h1 id="owner-gate-title">Codium owner</h1>
          {props.state.kind === "loading" ? (
            <p className="auth-sub" role="status">
              Checking your session…
            </p>
          ) : (
            <p className="auth-sub" role={props.state.kind === "failed" ? "alert" : undefined}>
              {props.state.message}
            </p>
          )}
          {props.state.kind === "signin" && (
            <button
              className="google-button"
              type="button"
              onClick={() => props.onGoogle(props.state.kind === "signin" && props.state.fresh)}
            >
              <GoogleMark /> Continue with Google
            </button>
          )}
          {props.state.kind === "denied" && (
            <button className="google-button" type="button" onClick={() => props.onGoogle(true)}>
              <GoogleMark /> Use a different Google account
            </button>
          )}
          {props.state.kind === "failed" && (
            <button className="google-button" type="button" onClick={props.onRetry}>
              Try again
            </button>
          )}
        </section>
      </main>
    </div>
  )
}

export function OwnerDashboard(props: {
  summary: CodiumOwner.Dashboard
  onRefresh: () => void
  onMutation: (operation: OwnerMutation, input: OwnerInput) => Promise<void>
  pending?: string
  notice?: { text: string; error?: boolean }
}) {
  const summary = props.summary
  const funding = summary.funding
  const [refund, setRefund] = useState<CodiumOwner.Account>()
  const [since, setSince] = useState(() => new Date(summary.generatedAt - 86_400_000).toISOString().slice(0, 16))
  const [account, setAccount] = useState("")
  const [formError, setFormError] = useState("")
  const currentRefund = refund && summary.accounts.find((item) => item.account === refund.account)
  const quoteMatches =
    refund && currentRefund && JSON.stringify(refundRequest(refund)) === JSON.stringify(refundRequest(currentRefund))
  const act = (operation: OwnerMutation, input: OwnerInput) => {
    setFormError("")
    void props.onMutation(operation, input).catch(() => undefined)
  }
  const replay = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    try {
      act("replay", { since: replaySince(since) })
    } catch {
      setFormError(ownerMessage("REPLAY_SINCE_INVALID"))
    }
  }
  const accountAction = (operation: "reconcile" | "clear-risk") => {
    if (!accountID(account.trim())) return setFormError("Enter a complete account ID.")
    act(operation, { account: account.trim() })
  }
  const stale =
    funding && (funding.checkedAt > summary.generatedAt || summary.generatedAt - funding.checkedAt >= 15 * 60_000)
  const ratioWarning = summary.risk.ratio !== null && summary.risk.ratio > 0.005
  return (
    <main className="acct codium-owner">
      <header className="acct-header">
        <div className="acct-header-inner owner-wide">
          <a className="acct-brand" href="/" aria-label="Vector home">
            <img src={vectorMark.src} alt="" />
            <span>Vector</span>
          </a>
          <nav aria-label="Owner dashboard">
            <button type="button" disabled={Boolean(props.pending)} onClick={props.onRefresh}>
              {props.pending === "refresh" ? "Refreshing…" : "Refresh"}
            </button>
            <a href="/account">Account</a>
          </nav>
        </div>
      </header>
      <div className="acct-body owner-wide">
        <div className="owner-heading">
          <div>
            <p className="owner-private">Private · owner only</p>
            <h1>Codium</h1>
            <p className="acct-meta">Updated {time(summary.generatedAt)}. Refreshes every 60 seconds.</p>
          </div>
          <Badge tone={summary.sales.enabled ? "healthy" : "warning"}>
            {summary.sales.enabled ? "Sales open" : "Sales paused"}
          </Badge>
        </div>
        <p className="owner-muted">{summary.sales.reason}</p>
        {props.notice && (
          <p
            className="owner-notice"
            data-error={props.notice.error || undefined}
            role={props.notice.error ? "alert" : "status"}
          >
            {props.notice.text}
          </p>
        )}
        {formError && (
          <p className="owner-notice" data-error="true" role="alert">
            {formError}
          </p>
        )}

        <section className="acct-section" aria-labelledby="owner-funding-title">
          <div className="owner-section-head">
            <h2 id="owner-funding-title">Funding</h2>
            <Badge tone={!funding || stale || funding.status !== "open" ? "warning" : "healthy"}>
              {!funding
                ? "No reading"
                : stale
                  ? "Reading stale"
                  : funding.status === "open"
                    ? "Funded"
                    : "Sales funding paused"}
            </Badge>
          </div>
          <p className="owner-muted">
            {funding
              ? `Last checked ${time(funding.checkedAt)}${funding.reason ? ` · ${funding.reason}` : ""}.`
              : "A verified funding reading is not available."}
          </p>
          <dl className="owner-grid">
            <Metric label="OpenRouter balance" value={money(funding?.balance)} />
            <Metric label="Customer obligation" value={money(funding?.owed)} />
            <Metric label="Checkout reservations" value={money(funding?.reserved)} />
            <Metric label="Required with margin" value={money(funding?.required)} />
            <Metric
              label="Observed runway"
              value={
                funding?.runwayDays === null || funding?.runwayDays === undefined
                  ? "Unavailable"
                  : `${days.format(funding.runwayDays)} days`
              }
            />
            <Metric label="Observed spend / day" value={money(funding?.spendPerDay)} />
            <Metric label="Observed spend / hour" value={money(funding?.spendPerHour)} />
          </dl>
          {funding?.lowWater && <p className="owner-notice">Balance is at or below 1.25 times required funding.</p>}
          {funding?.spike && (
            <p className="owner-notice" data-error="true">
              Observed spend has reached the configured hourly alert threshold.
            </p>
          )}
          <p className="owner-muted">
            {!funding?.watchdog
              ? "Auto top-up watchdog is not configured."
              : `Auto top-up threshold ${money(funding.watchdog.threshold)} · ${funding.watchdog.overdue ? "Overdue: no credit addition detected after 20 minutes" : funding.watchdog.since !== undefined ? `Waiting since ${time(funding.watchdog.since)}` : "Balance is above the threshold"}.`}
          </p>
          <p className="owner-muted">
            Runway is an estimate from observed provider usage. Required funding includes paid allowances, reservations,
            the largest next purchase and the margin.
          </p>
          <FundingHistory points={summary.history} />
        </section>

        <div className="owner-pair">
          <section className="acct-section" aria-labelledby="owner-subscriptions-title">
            <h2 id="owner-subscriptions-title">Subscriptions and monthly revenue</h2>
            <div className="owner-scroll">
              <table className="owner-table">
                <thead>
                  <tr>
                    <th scope="col">Plan</th>
                    <th scope="col" className="owner-number">
                      Subscriptions
                    </th>
                    <th scope="col" className="owner-number">
                      MRR
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {summary.subscriptions.map((item) => (
                    <tr key={item.plan}>
                      <th scope="row">{PLAN_NAMES[item.plan]}</th>
                      <td className="owner-number">{count(item.count)}</td>
                      <td className="owner-number">{money(item.mrrCents)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
          <section className="acct-section" aria-labelledby="owner-risk-title">
            <div className="owner-section-head">
              <h2 id="owner-risk-title">Payment risk · 30 days</h2>
              <Badge tone={ratioWarning ? "warning" : summary.risk.ratio === null ? "unknown" : "healthy"}>
                {ratioWarning ? "Above 0.5%" : summary.risk.ratio === null ? "Unknown" : "Within threshold"}
              </Badge>
            </div>
            <dl className="owner-grid">
              <Metric label="Disputes" value={count(summary.risk.disputes30d)} />
              <Metric label="Early fraud warnings" value={count(summary.risk.efw30d)} />
              <Metric label="Paid invoices" value={count(summary.risk.paidInvoices30d)} />
              <Metric
                label="Risk ratio"
                value={summary.risk.ratio === null ? "Unavailable" : percent.format(summary.risk.ratio)}
              />
            </dl>
          </section>
        </div>

        <section className="acct-section" aria-labelledby="owner-health-title">
          <h2 id="owner-health-title">Service health</h2>
          <ul className="owner-status-list">
            {(
              [
                ["Webhooks", summary.health.webhooks],
                ["Sweep drift", summary.health.sweep],
                ["Store", summary.health.store],
              ] as const
            ).map(([name, health]) => (
              <li key={name}>
                <div>
                  <strong>{name}</strong>
                  <Badge tone={health.status}>{health.status}</Badge>
                </div>
                <p className="owner-muted">
                  {health.detail}
                  {health.checkedAt !== undefined && ` · ${time(health.checkedAt)}`}
                </p>
              </li>
            ))}
          </ul>
          <dl className="owner-grid">
            <Metric label="Outbox depth" value={count(summary.health.outbox.depth)} />
            <Metric label="Dead letters" value={count(summary.health.outbox.deadLetters)} />
          </dl>
        </section>

        <section className="acct-section" aria-labelledby="owner-budgets-title">
          <h2 id="owner-budgets-title">Provider budgets</h2>
          {summary.budgets.length === 0 ? (
            <p className="owner-muted">No provider budget readings are available.</p>
          ) : (
            <ul className="owner-status-list">
              {summary.budgets.map((budget) => (
                <li key={budget.service}>
                  <div>
                    <strong>{budget.service}</strong>
                    <Badge tone={budget.status}>{budget.status}</Badge>
                  </div>
                  <p className="owner-muted">
                    {budget.detail}
                    {budget.spentCents !== undefined && ` · Spent ${money(budget.spentCents)}`}
                    {budget.limitCents !== undefined && ` · Limit ${money(budget.limitCents)}`}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="acct-section" aria-labelledby="owner-switches-title">
          <h2 id="owner-switches-title">Runtime controls</h2>
          <p className="owner-muted">
            Changes require a recent Google sign-in. Turning sales off leaves existing subscriptions working.
          </p>
          <div className="owner-switches">
            {summary.switches.map((entry) => (
              <SwitchRow
                key={`${entry.name}:${entry.changedAt}`}
                entry={entry}
                disabled={Boolean(props.pending)}
                change={props.onMutation}
              />
            ))}
          </div>
          <DisabledResources
            kind="model"
            items={summary.modelsOff}
            disabled={Boolean(props.pending)}
            change={props.onMutation}
          />
          <DisabledResources
            kind="perk"
            items={summary.perksOff}
            disabled={Boolean(props.pending)}
            change={props.onMutation}
          />
        </section>

        <section className="acct-section" aria-labelledby="owner-accounts-title">
          <h2 id="owner-accounts-title">Accounts</h2>
          {!summary.accountsComplete && (
            <p className="owner-notice">
              This is a limited account list. Counts and account rows may be incomplete. Use an account ID below for an
              account outside this list.
            </p>
          )}
          <div className="owner-scroll">
            <table className="owner-table">
              <thead>
                <tr>
                  <th scope="col">Account ID</th>
                  <th scope="col">Plan / state</th>
                  <th scope="col">Period ends</th>
                  <th scope="col">Risk</th>
                  <th scope="col">Actions</th>
                </tr>
              </thead>
              <tbody>
                {summary.accounts.map((item) => (
                  <tr key={item.account}>
                    <th scope="row">
                      <code>{accountID(item.account) ? item.account : "Unavailable account ID"}</code>
                    </th>
                    <td>
                      {item.plan ? PLAN_NAMES[item.plan] : "No plan"}
                      <br />
                      <span className="owner-muted">{item.state}</span>
                    </td>
                    <td>{time(item.periodEnd)}</td>
                    <td>
                      {item.blocked ? "Blocked" : "Not blocked"}
                      <br />
                      <span className="owner-muted">
                        {count(item.openDisputes)} disputes · {count(item.efw)} fraud warnings
                      </span>
                    </td>
                    <td>
                      <div className="owner-actions">
                        <button
                          className="owner-button"
                          type="button"
                          disabled={Boolean(props.pending) || !accountID(item.account)}
                          onClick={() => act("reconcile", { account: item.account })}
                        >
                          Reconcile
                        </button>
                        <button
                          className="owner-button"
                          type="button"
                          disabled={Boolean(props.pending) || !item.blocked || !accountID(item.account)}
                          onClick={() => act("clear-risk", { account: item.account })}
                        >
                          Clear risk
                        </button>
                        <button
                          className="owner-button"
                          data-danger="true"
                          type="button"
                          disabled={Boolean(props.pending) || !refundRequest(item)}
                          onClick={() => setRefund(item)}
                        >
                          {item.refundCents ? "Refund and end" : "End subscriptions"}
                        </button>
                      </div>
                      {!refundRequest(item) && (
                        <p className="owner-muted">
                          Verified refund details unavailable. Reconcile before trying again.
                        </p>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {summary.accounts.length === 0 && <p className="owner-muted">No account rows are available.</p>}
          <form
            className="owner-form"
            onSubmit={(event) => {
              event.preventDefault()
              accountAction("reconcile")
            }}
          >
            <label>
              Account ID
              <input
                className="owner-control"
                value={account}
                onChange={(event) => setAccount(event.target.value)}
                placeholder="Account UUID"
                autoComplete="off"
                spellCheck={false}
              />
            </label>
            <button className="owner-button" type="submit" disabled={Boolean(props.pending)}>
              Reconcile account
            </button>
            <button
              className="owner-button"
              type="button"
              disabled={Boolean(props.pending) || !accountID(account.trim())}
              onClick={() => accountAction("clear-risk")}
            >
              Clear account risk
            </button>
          </form>
        </section>

        <section className="acct-section" aria-labelledby="owner-replay-title">
          <h2 id="owner-replay-title">Replay billing events</h2>
          <p className="owner-muted">
            Reprocess Stripe events from a chosen time within the last 30 days. The scheduled replay cursor is
            preserved.
          </p>
          <form className="owner-form" onSubmit={replay}>
            <label>
              Events since · UTC
              <input
                className="owner-control"
                type="datetime-local"
                value={since}
                onChange={(event) => setSince(event.target.value)}
                required
              />
            </label>
            <button className="owner-button" type="submit" disabled={Boolean(props.pending)}>
              Replay events
            </button>
          </form>
        </section>

        <section className="acct-section" aria-labelledby="owner-stripe-title">
          <h2 id="owner-stripe-title">Stripe settings checklist</h2>
          <p className="owner-muted">
            Configuration checks do not change Stripe. Items marked Owner check still need confirmation in Stripe.
          </p>
          <ul className="owner-checklist">
            {summary.stripeChecklist.map((item) => (
              <li key={item.id}>
                <div className="owner-section-head">
                  <strong>{item.title}</strong>
                  <Badge
                    tone={
                      item.status === "confirmed"
                        ? "healthy"
                        : item.status === "unconfigured"
                          ? "unconfigured"
                          : "warning"
                    }
                  >
                    {item.status === "owner-check" ? "Owner check" : item.status}
                  </Badge>
                </div>
                <p className="owner-muted">{item.detail}</p>
              </li>
            ))}
          </ul>
        </section>

        <section className="acct-section" aria-labelledby="owner-audit-title">
          <h2 id="owner-audit-title">Recent owner actions</h2>
          <div className="owner-scroll">
            <table className="owner-table">
              <thead>
                <tr>
                  <th scope="col">When</th>
                  <th scope="col">Action</th>
                  <th scope="col">Account ID</th>
                  <th scope="col">Outcome</th>
                </tr>
              </thead>
              <tbody>
                {summary.audit.map((entry, index) => (
                  <tr key={`${entry.at}:${index}`}>
                    <td>{time(entry.at)}</td>
                    <td>{entry.action}</td>
                    <td>
                      <code>{entry.account && accountID(entry.account) ? entry.account : "—"}</code>
                    </td>
                    <td>{entry.outcome}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {summary.audit.length === 0 && <p className="owner-muted">No recent owner actions are available.</p>}
        </section>
      </div>
      {refund && (
        <RefundConfirmation
          account={refund}
          changed={!quoteMatches}
          pending={props.pending === "refund-end"}
          refreshing={props.pending === "refresh"}
          cancel={() => setRefund(undefined)}
          confirm={() => {
            const input = refundRequest(refund)
            if (!input || !quoteMatches) return
            void props.onMutation("refund-end", input).then(
              () => setRefund(undefined),
              () => setRefund(undefined),
            )
          }}
        />
      )}
    </main>
  )
}

function Metric(props: { label: string; value: string }) {
  return (
    <div className="owner-metric">
      <dt>{props.label}</dt>
      <dd>{props.value}</dd>
    </div>
  )
}

function Badge(props: { tone: string; children: ReactNode }) {
  return (
    <span className="owner-badge" data-tone={props.tone}>
      {props.children}
    </span>
  )
}

function SwitchRow(props: {
  entry: CodiumOwner.RuntimeSwitch
  disabled: boolean
  change: (operation: OwnerMutation, input: OwnerInput) => Promise<void>
}) {
  const [value, setValue] = useState<string>(props.entry.value)
  const [label, detail] = SWITCHES[props.entry.name]
  return (
    <form
      className="owner-switch"
      onSubmit={(event) => {
        event.preventDefault()
        void props.change("switch", { name: props.entry.name, value }).catch(() => undefined)
      }}
    >
      <label htmlFor={`owner-switch-${props.entry.name}`}>{label}</label>
      <select
        className="owner-control"
        id={`owner-switch-${props.entry.name}`}
        value={value}
        disabled={props.disabled}
        onChange={(event) => setValue(event.target.value)}
      >
        {(props.entry.name === "hosted" ? ["on", "no-new", "stop"] : ["on", "off"]).map((choice) => (
          <option key={choice} value={choice}>
            {choice === "no-new" ? "No new" : choice === "on" ? "On" : choice === "stop" ? "Stop" : "Off"}
          </option>
        ))}
      </select>
      <button className="owner-button" type="submit" disabled={props.disabled || value === props.entry.value}>
        Apply
      </button>
      <small>
        {detail} {props.entry.changedAt ? `Changed ${time(props.entry.changedAt)}.` : "Default setting."}
      </small>
    </form>
  )
}

function DisabledResources(props: {
  kind: "model" | "perk"
  items: readonly string[]
  disabled: boolean
  change: (operation: OwnerMutation, input: OwnerInput) => Promise<void>
}) {
  const [name, setName] = useState("")
  const valid = /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,199}$/.test(name.trim())
  return (
    <div>
      <form
        className="owner-form"
        onSubmit={(event) => {
          event.preventDefault()
          if (valid)
            void props.change("switch", { name: `${props.kind}-off:${name.trim()}`, value: "off" }).then(
              () => setName(""),
              () => undefined,
            )
        }}
      >
        <label>
          {props.kind === "model" ? "Disable a model by ID" : "Disable a perk by ID"}
          <input
            className="owner-control"
            value={name}
            onChange={(event) => setName(event.target.value)}
            autoComplete="off"
            spellCheck={false}
          />
        </label>
        <button className="owner-button" type="submit" disabled={props.disabled || !valid}>
          Disable {props.kind}
        </button>
      </form>
      <ul className="owner-disabled">
        {props.items.map((item) => (
          <li key={item}>
            <code>{item}</code>
            <button
              className="owner-button"
              type="button"
              disabled={props.disabled}
              onClick={() => {
                void props.change("switch", { name: `${props.kind}-off:${item}`, value: "on" }).catch(() => undefined)
              }}
            >
              Restore
            </button>
          </li>
        ))}
      </ul>
      {props.items.length === 0 && (
        <p className="owner-muted">No {props.kind === "model" ? "models" : "perks"} are disabled.</p>
      )}
    </div>
  )
}

export function RefundConfirmation(props: {
  account: CodiumOwner.Account
  changed?: boolean
  pending?: boolean
  refreshing?: boolean
  cancel: () => void
  confirm: () => void
}) {
  const cancel = useRef<HTMLButtonElement>(null)
  const confirm = useRef<HTMLButtonElement>(null)
  const dialog = useRef<HTMLElement>(null)
  const pending = useRef(props.pending)
  pending.current = props.pending
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : undefined
    cancel.current?.focus()
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !pending.current) props.cancel()
      if (event.key !== "Tab") return
      if (pending.current) {
        event.preventDefault()
        dialog.current?.focus()
        return
      }
      const first = cancel.current
      const last = confirm.current && !confirm.current.disabled ? confirm.current : first
      if (
        (event.shiftKey && document.activeElement === first) ||
        (!event.shiftKey && document.activeElement === last)
      ) {
        event.preventDefault()
        ;(event.shiftKey ? last : first)?.focus()
      }
    }
    document.addEventListener("keydown", key)
    return () => {
      document.removeEventListener("keydown", key)
      if (previous?.isConnected) previous.focus({ preventScroll: true })
    }
  }, [])
  useEffect(() => {
    if (props.pending) dialog.current?.focus()
    if (!props.pending) cancel.current?.focus()
  }, [props.pending])
  const eligible = refundRequest(props.account)
  return (
    <div className="owner-confirm-backdrop">
      <section
        className="owner-confirm"
        ref={dialog}
        tabIndex={-1}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="owner-refund-title"
        aria-describedby="owner-refund-description"
      >
        <h2 id="owner-refund-title">
          {props.account.refundCents
            ? `Refund ${money(props.account.refundCents)} and end Codium?`
            : "End all Codium subscriptions?"}
        </h2>
        <p id="owner-refund-description">
          Account <code>{props.account.account}</code>. All Codium subscriptions and pending checkouts owned by this
          account will stop, and its Codium access will end.
        </p>
        {props.account.refundCents ? (
          <p>
            Refund {money(props.account.refundCents)} on charge <code>{props.account.refundCharge}</code>.
          </p>
        ) : (
          <p>No refundable payment was found. No refund will be issued.</p>
        )}
        {props.changed && (
          <p role="alert">
            The account or refund details changed. Close this confirmation, refresh, and review the latest details.
          </p>
        )}
        {props.pending && <p role="status">Request in progress…</p>}
        {props.refreshing && <p role="status">Refreshing account details…</p>}
        <div className="owner-actions">
          <button className="owner-button" ref={cancel} type="button" disabled={props.pending} onClick={props.cancel}>
            Cancel
          </button>
          <button
            className="owner-button"
            ref={confirm}
            type="button"
            data-danger="true"
            disabled={props.pending || props.refreshing || props.changed || !eligible}
            onClick={props.confirm}
          >
            {props.pending
              ? "Requesting…"
              : props.account.refundCents
                ? `Refund ${money(props.account.refundCents)} and end`
                : "End all subscriptions"}
          </button>
        </div>
      </section>
    </div>
  )
}

function FundingHistory(props: { points: readonly CodiumOwner.HistoryPoint[] }) {
  const maximum = Math.max(1, ...props.points.flatMap((point) => [point.balance, point.required]))
  const minimum = Math.min(0, ...props.points.map((point) => point.balance))
  const start = props.points[0]?.checkedAt ?? 0
  const duration = Math.max(1, (props.points.at(-1)?.checkedAt ?? start) - start)
  const path = (key: "balance" | "required") =>
    props.points
      .map(
        (point, index) =>
          `${index ? "L" : "M"}${(((point.checkedAt - start) * 560) / duration).toFixed(1)},${(115 - ((point[key] - minimum) * 100) / (maximum - minimum)).toFixed(1)}`,
      )
      .join(" ")
  return (
    <div className="owner-history">
      <h3>Funding history · last 7 days</h3>
      {props.points.length > 1 && (
        <>
          <svg viewBox="0 0 600 145" role="img" aria-labelledby="owner-history-title">
            <title id="owner-history-title">OpenRouter balance and required funding over time</title>
            <path d="M0,115H560" stroke="currentColor" opacity="0.15" />
            <path d={path("required")} fill="none" stroke="#e6ad73" strokeWidth="2" />
            <path d={path("balance")} fill="none" stroke="#b69cff" strokeWidth="2" />
            <text x="0" y="138" fill="currentColor" fontSize="10">
              {time(props.points[0]?.checkedAt)}
            </text>
            <text x="560" y="138" textAnchor="end" fill="currentColor" fontSize="10">
              {time(props.points.at(-1)?.checkedAt)}
            </text>
          </svg>
          <p className="owner-muted">Purple: balance · Orange: required funding</p>
        </>
      )}
      {props.points.length === 0 ? (
        <p className="owner-muted">No funding history is available.</p>
      ) : (
        <details>
          <summary>Latest {Math.min(12, props.points.length)} readings</summary>
          <div className="owner-scroll">
            <table className="owner-table">
              <thead>
                <tr>
                  <th scope="col">Checked · UTC</th>
                  <th scope="col" className="owner-number">
                    Balance
                  </th>
                  <th scope="col" className="owner-number">
                    Owed
                  </th>
                  <th scope="col" className="owner-number">
                    Reserved
                  </th>
                  <th scope="col" className="owner-number">
                    Required
                  </th>
                </tr>
              </thead>
              <tbody>
                {props.points.slice(-12).map((point) => (
                  <tr key={point.checkedAt}>
                    <td>{time(point.checkedAt)}</td>
                    <td className="owner-number">{money(point.balance)}</td>
                    <td className="owner-number">{money(point.owed)}</td>
                    <td className="owner-number">{money(point.reserved)}</td>
                    <td className="owner-number">{money(point.required)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      )}
    </div>
  )
}

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value))
}
