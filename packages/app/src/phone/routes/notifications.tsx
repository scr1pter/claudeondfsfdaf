import { createSignal, Match, Show, Switch } from "solid-js"
import { alertsSupport } from "../environment"
import { alertsErrorText, turnOffAlerts, turnOnAlerts, useAlertsState } from "../push"
import { planNotice } from "../status"
import { InstallCard, Notice, Panel, type RouteProps } from "./parts"

// Phone alerts on this phone (WP A38). Which events a computer sends is chosen on that computer, in Settings →
// Notifications; the server's own alerts are titles only (P7).
export function NotificationsRoute(props: RouteProps) {
  const support = alertsSupport(props.environment)
  const { deps, state, refetch } = useAlertsState(
    () => props.session,
    () => support === "ready",
  )
  const [busy, setBusy] = createSignal(false)
  const [problem, setProblem] = createSignal<string>()

  const change = async (on: boolean) => {
    if (busy()) return
    setBusy(true)
    setProblem(undefined)
    try {
      if (on) await turnOnAlerts(props.session, deps)
      else await turnOffAlerts(props.session, deps)
    } catch (cause) {
      setProblem(alertsErrorText(cause))
    } finally {
      await refetch()
      setBusy(false)
    }
  }

  return (
    <Panel title="Alerts">
      <Notice text={planNotice(props.status)} />
      <Switch>
        <Match when={support === "install-first"}>
          <InstallCard
            environment={props.environment}
            reason="On iPhone and iPad, only the installed app can receive alerts."
          />
        </Match>
        <Match when={support === "unsupported"}>
          <p>This browser cannot receive alerts. On iPhone and iPad they need iOS 16.4 or later.</p>
        </Match>
        <Match when={state.loading}>
          <p role="status">Checking alerts on this phone…</p>
        </Match>
        <Match when={state() === "unknown"}>
          <p>Vector could not check alerts on this phone.</p>
          <button type="button" class="phone-button phone-button--quiet" onClick={() => void refetch()}>
            Try again
          </button>
        </Match>
        <Match when={state() === "denied"}>
          <p>Notifications for Vector are off in this phone's settings. Turn them on there, then come back.</p>
        </Match>
        <Match when={state() === "on"}>
          <p>
            Alerts are set up for this account on this phone. An alert can show a short title, such as the session's
            name, when an agent finishes or needs you.
          </p>
        </Match>
        <Match when={state() === "off"}>
          <p>
            Get a short alert on this phone when an agent finishes or needs you: a title such as the session's name.
          </p>
          <button type="button" class="phone-button" disabled={busy()} onClick={() => change(true)}>
            Turn on alerts
          </button>
        </Match>
      </Switch>
      <Show when={!state.loading && (state() === "on" || state() === "unknown")}>
        <button type="button" class="phone-button phone-button--quiet" disabled={busy()} onClick={() => change(false)}>
          Turn off alerts on this phone
        </button>
      </Show>
      <Notice text={problem()} />
      <p class="phone-meta">
        Choose which events reach this phone in Vector on your computer: Settings → Notifications.
      </p>
    </Panel>
  )
}
