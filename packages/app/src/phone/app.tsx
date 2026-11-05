import { createResource, createSignal, For, Match, onCleanup, onMount, Show, Switch, type JSX } from "solid-js"
import { Dynamic } from "solid-js/web"
import { phoneApi, readPhoneStatus } from "./api"
import {
  browserStorage,
  currentSession,
  finishGoogleSignIn,
  googleSignInFailed,
  googleSignInUrl,
  passwordSignIn,
  readAuthConfig,
  signOut,
  type AuthConfig,
  type PhoneSession,
} from "./auth"
import { forgetAlertKey, forgetAlertKeys, saveAlertKey } from "./alert-keys"
import { MANAGE_URL, PHONE_VERSION_URL, PLANS_URL, phonePath } from "./config"
import { readEnvironment } from "./environment"
import { phoneFeatures, planNotice, routeFromPath, routeShown, type PhoneRoute, type PhoneStatus } from "./status"
import { decodeVersion, phoneBuild, shouldReload } from "./version"
import { createPhoneRemote, type RemoteSocket } from "./remote/client"
import { phoneName, relayAllowed } from "./remote/model"
import { browserPasskeys } from "./remote/passkey"
import { browserRemoteStore } from "./remote/store"
import { ApprovalsRoute } from "./routes/approvals"
import { CloudRunsRoute } from "./routes/cloud-runs"
import { ComputerRoute } from "./routes/computer"
import { DevicesRoute } from "./routes/devices"
import { NotificationsRoute } from "./routes/notifications"
import { OpsRoute } from "./routes/ops"
import { PairRoute } from "./routes/pair"
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
  pair: PairRoute,
}
/** The pages that use Vector Remote's connection: coming back to one of them is the person's action to reconnect. */
const REMOTE_PAGES = new Set<PhoneRoute>(["sessions", "approvals", "devices", "pair"])

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
    const failed = query.has("error") || query.has("error_description")
    if (code || failed) history.replaceState(null, "", location.pathname)
    // The address's own error text is never shown: anyone can send a link with one.
    const failure = !code && failed ? googleSignInFailed(storage) : undefined
    try {
      const session = code
        ? await finishGoogleSignIn(config, code, storage, fetch)
        : await currentSession(config, storage, fetch)
      if (session) return setPhase({ kind: "signed-in", config, session })
      setPhase({ kind: "signed-out", config, ...(failure ? { message: failure } : {}) })
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
              freshSession={() => currentSession(current().config, storage, fetch).catch(() => undefined)}
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
  /** The session, refreshed when it is close to expiring (Remote's tickets need a current one). */
  freshSession: () => Promise<PhoneSession | undefined>
  environment: ReturnType<typeof readEnvironment>
  path: string
  navigate: (to: string) => void
  onSignOut: () => void
  onExpired: () => void
}) {
  // Vector Remote on this phone (WP A42): one client for this sign-in, shared by every route.
  const remote = createPhoneRemote({
    origin: location.origin,
    api: async (path, init) => phoneApi(path, (await props.freshSession()) ?? props.session, init),
    store: browserRemoteStore(),
    socket: (url, protocols) => new WebSocket(url, protocols) as unknown as RemoteSocket,
    relayAllowed: (url) => relayAllowed(url, location.origin),
    passkeys: browserPasskeys(),
    alertKeys: { save: saveAlertKey, remove: forgetAlertKey, forget: forgetAlertKeys },
    phoneName: () => phoneName(navigator),
  })
  onCleanup(() => remote.disconnect())
  const signOut = async () => {
    await remote.signOut().catch(() => undefined)
    props.onSignOut()
  }
  const [status, { refetch }] = createResource(
    () => props.session,
    (session) =>
      readPhoneStatus(session).catch((cause: { status?: number; message?: string }) => {
        if (cause?.status === 401) props.onExpired()
        throw cause
      }),
  )
  const route = () => routeFromPath(props.path)
  onMount(() => {
    const onVisible = () => {
      if (document.visibilityState !== "visible") return
      void refetch()
      const open = route()
      if (open && REMOTE_PAGES.has(open)) void remote.connect()
    }
    document.addEventListener("visibilitychange", onVisible)
    onCleanup(() => document.removeEventListener("visibilitychange", onVisible))
  })

  return (
    <>
      <header class="phone-header">
        <Show when={route()} fallback={<h1>Vector</h1>}>
          <button type="button" class="phone-back" onClick={() => props.navigate(phonePath())}>
            Back
          </button>
        </Show>
        <button type="button" class="phone-link" onClick={() => void signOut()}>
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
                  {/* A status read again updates the open page in place; only a new route mounts a new page. */}
                  <Dynamic
                    component={ROUTES[open()]}
                    status={current()}
                    session={props.session}
                    environment={props.environment}
                    remote={remote}
                    navigate={props.navigate}
                    refresh={() => void refetch()}
                  />
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
