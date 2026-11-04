import { createResource, createSignal, For, Match, onCleanup, onMount, Show, Switch, type JSX } from "solid-js"
import { readPhoneStatus } from "./api"
import {
  browserStorage,
  currentSession,
  finishGoogleSignIn,
  googleSignInUrl,
  passwordSignIn,
  readAuthConfig,
  signOut,
  type AuthConfig,
  type PhoneSession,
} from "./auth"
import { forgetAlertKeys } from "./alert-keys"
import { MANAGE_URL, PHONE_VERSION_URL, PLANS_URL, phonePath } from "./config"
import { readEnvironment } from "./environment"
import { phoneFeatures, planNotice, routeFromPath, routeShown, type PhoneRoute, type PhoneStatus } from "./status"
import { decodeVersion, phoneBuild, shouldReload } from "./version"
import { ApprovalsRoute } from "./routes/approvals"
import { CloudRunsRoute } from "./routes/cloud-runs"
import { ComputerRoute } from "./routes/computer"
import { DevicesRoute } from "./routes/devices"
import { NotificationsRoute } from "./routes/notifications"
import { OpsRoute } from "./routes/ops"
import { InstallCard, Notice, type RouteProps } from "./routes/parts"
import { SessionsRoute } from "./routes/sessions"

// The phone app's shell (WP A38): sign-in, the version handshake, and the routes the account's status shows.

const RELOADED_KEY = "vector-phone-reloaded-for"

const ROUTES: Record<PhoneRoute, (props: RouteProps) => JSX.Element> = {
  sessions: SessionsRoute,
  approvals: ApprovalsRoute,
  devices: DevicesRoute,
  "cloud-runs": CloudRunsRoute,
  computer: ComputerRoute,
  ops: OpsRoute,
  notifications: NotificationsRoute,
}

type Phase =
  | { kind: "loading" }
  | { kind: "unavailable"; message: string }
  | { kind: "signed-out"; config: AuthConfig; message?: string }
  | { kind: "signed-in"; config: AuthConfig; session: PhoneSession }

export function PhoneApp() {
  const storage = browserStorage()
  const environment = readEnvironment(navigator, window)
  const [phase, setPhase] = createSignal<Phase>({ kind: "loading" })
  const [path, setPath] = createSignal(location.pathname)

  const navigate = (to: string) => {
    if (to === location.pathname) return
    history.pushState(null, "", to)
    setPath(to)
    window.scrollTo(0, 0)
  }

  const boot = async () => {
    const config = await readAuthConfig(fetch).catch((cause: Error) => cause)
    if (config instanceof Error) return setPhase({ kind: "unavailable", message: config.message })
    const query = new URLSearchParams(location.search)
    const code = query.get("code")
    const failed = query.get("error_description")
    if (code || failed) history.replaceState(null, "", location.pathname)
    try {
      const session = code
        ? await finishGoogleSignIn(config, code, storage, fetch)
        : await currentSession(config, storage, fetch)
      if (session) return setPhase({ kind: "signed-in", config, session })
      setPhase({ kind: "signed-out", config, ...(failed ? { message: failed.slice(0, 200) } : {}) })
    } catch (cause) {
      setPhase({ kind: "signed-out", config, message: cause instanceof Error ? cause.message : "Sign in again." })
    }
  }

  // The version handshake with the server: reload once onto a newer deployed build.
  const checkVersion = async () => {
    const response = await fetch(PHONE_VERSION_URL, { cache: "no-store", credentials: "omit" }).catch(() => undefined)
    const deployed = decodeVersion(response?.ok ? await response.json().catch(() => undefined) : undefined)
    let reloadedFor: string | null = null
    try {
      reloadedFor = sessionStorage.getItem(RELOADED_KEY)
    } catch {}
    if (!shouldReload(phoneBuild(), deployed, reloadedFor)) return
    try {
      sessionStorage.setItem(RELOADED_KEY, deployed!.build)
    } catch {
      return
    }
    location.reload()
  }

  onMount(() => {
    void boot()
    void checkVersion()
    const onPop = () => setPath(location.pathname)
    const onVisible = () => {
      if (document.visibilityState === "visible") void checkVersion()
    }
    window.addEventListener("popstate", onPop)
    document.addEventListener("visibilitychange", onVisible)
    onCleanup(() => {
      window.removeEventListener("popstate", onPop)
      document.removeEventListener("visibilitychange", onVisible)
    })
  })

  const leave = async (config: AuthConfig) => {
    await signOut(config, storage, fetch)
    await forgetAlertKeys().catch(() => undefined)
    setPhase({ kind: "signed-out", config })
    navigate(phonePath())
  }

  return (
    <div class="phone-app">
      <Switch>
        <Match when={phase().kind === "loading"}>
          <p class="phone-loading" role="status">
            Loading…
          </p>
        </Match>
        <Match when={phase().kind === "unavailable" && (phase() as Extract<Phase, { kind: "unavailable" }>)}>
          {(current) => <p class="phone-notice">{current().message}</p>}
        </Match>
        <Match when={phase().kind === "signed-out" && (phase() as Extract<Phase, { kind: "signed-out" }>)}>
          {(current) => (
            <SignIn
              config={current().config}
              message={current().message}
              environment={environment}
              onSession={(session) => setPhase({ kind: "signed-in", config: current().config, session })}
            />
          )}
        </Match>
        <Match when={phase().kind === "signed-in" && (phase() as Extract<Phase, { kind: "signed-in" }>)}>
          {(current) => (
            <Signed
              session={current().session}
              environment={environment}
              path={path()}
              navigate={navigate}
              onSignOut={() => leave(current().config)}
              onExpired={() => setPhase({ kind: "signed-out", config: current().config, message: "Sign in again." })}
            />
          )}
        </Match>
      </Switch>
    </div>
  )
}

function Signed(props: {
  session: PhoneSession
  environment: ReturnType<typeof readEnvironment>
  path: string
  navigate: (to: string) => void
  onSignOut: () => void
  onExpired: () => void
}) {
  const [status, { refetch }] = createResource(
    () => props.session,
    (session) =>
      readPhoneStatus(session).catch((cause: { status?: number; message?: string }) => {
        if (cause?.status === 401) props.onExpired()
        throw cause
      }),
  )
  onMount(() => {
    const onVisible = () => {
      if (document.visibilityState === "visible") void refetch()
    }
    document.addEventListener("visibilitychange", onVisible)
    onCleanup(() => document.removeEventListener("visibilitychange", onVisible))
  })
  const route = () => routeFromPath(props.path)

  return (
    <>
      <header class="phone-header">
        <Show when={route()} fallback={<h1>Vector</h1>}>
          <button type="button" class="phone-back" onClick={() => props.navigate(phonePath())}>
            Back
          </button>
        </Show>
        <button type="button" class="phone-link" onClick={props.onSignOut}>
          Sign out
        </button>
      </header>
      <main class="phone-main">
        <Show when={props.session.email}>
          <p class="phone-meta">Signed in as {props.session.email}</p>
        </Show>
        <Show
          when={status.latest}
          fallback={
            <Show when={status.error} fallback={<p class="phone-loading">Loading your plan…</p>}>
              <p class="phone-notice">Vector could not load your plan. Check your connection and try again.</p>
              <button type="button" class="phone-button phone-button--quiet" onClick={() => void refetch()}>
                Try again
              </button>
            </Show>
          }
        >
          {(current) => (
            <Show when={route()} fallback={<Home status={current()} navigate={props.navigate} />}>
              {(open) => (
                <Show
                  when={routeShown(open(), current())}
                  fallback={<p class="phone-empty">This isn't part of what your plan shows on this phone.</p>}
                >
                  {ROUTES[open()]({ status: current(), session: props.session, environment: props.environment })}
                </Show>
              )}
            </Show>
          )}
        </Show>
      </main>
    </>
  )
}

function Home(props: { status: PhoneStatus; navigate: (to: string) => void }) {
  const features = () => phoneFeatures(props.status)
  return (
    <>
      <Notice text={planNotice(props.status)} />
      <Show
        when={features().length}
        fallback={
          <div class="phone-panel">
            <p>Nothing to show on this phone yet. What your Vector Codium plan includes on your phone shows up here.</p>
            <p class="phone-meta">
              <a href={props.status.plan ? MANAGE_URL : PLANS_URL} rel="noreferrer">
                {props.status.plan ? "Your account" : "Vector Codium plans"}
              </a>
            </p>
          </div>
        }
      >
        <nav class="phone-features" aria-label="Vector on this phone">
          <For each={features()}>
            {(feature) => (
              <a
                class="phone-feature"
                href={phonePath(feature.route)}
                onClick={(event) => {
                  event.preventDefault()
                  props.navigate(phonePath(feature.route))
                }}
              >
                <strong>{feature.label}</strong>
                <span>{feature.summary}</span>
              </a>
            )}
          </For>
        </nav>
      </Show>
    </>
  )
}

function SignIn(props: {
  config: AuthConfig
  message?: string
  environment: ReturnType<typeof readEnvironment>
  onSession: (session: PhoneSession) => void
}) {
  const storage = browserStorage()
  const [email, setEmail] = createSignal("")
  const [password, setPassword] = createSignal("")
  const [busy, setBusy] = createSignal(false)
  const [problem, setProblem] = createSignal(props.message)

  const google = async () => {
    setBusy(true)
    try {
      location.assign(await googleSignInUrl(props.config, `${location.origin}${phonePath()}`, storage))
    } catch {
      setProblem("Google sign-in could not start.")
      setBusy(false)
    }
  }
  const submit = async (event: SubmitEvent) => {
    event.preventDefault()
    if (busy()) return
    setBusy(true)
    setProblem(undefined)
    try {
      props.onSession(await passwordSignIn(props.config, email(), password(), storage, fetch))
    } catch (cause) {
      setProblem(cause instanceof Error ? cause.message : "Vector could not sign you in.")
      setBusy(false)
    }
  }

  return (
    <main class="phone-main phone-signin">
      <h1>Vector</h1>
      <p>Sign in with your Vector account to see your agents on this phone.</p>
      <Show when={props.environment.ios && !props.environment.standalone}>
        <InstallCard
          environment={props.environment}
          reason="Safari and the Home Screen app keep separate sign-ins, and pairing and alerts work only in the app. Install it first, then sign in there."
        />
      </Show>
      <button type="button" class="phone-button" disabled={busy()} onClick={google}>
        Continue with Google
      </button>
      <form class="phone-form" method="post" onSubmit={submit}>
        <label>
          Email
          <input
            type="email"
            autocomplete="email"
            required
            value={email()}
            onInput={(event) => setEmail(event.currentTarget.value)}
          />
        </label>
        <label>
          Password
          <input
            type="password"
            autocomplete="current-password"
            required
            value={password()}
            onInput={(event) => setPassword(event.currentTarget.value)}
          />
        </label>
        <button type="submit" class="phone-button phone-button--quiet" disabled={busy()}>
          Sign in with email
        </button>
      </form>
      <Notice text={problem()} />
    </main>
  )
}
