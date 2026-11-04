import { For, Show, type JSX } from "solid-js"
import { installSteps, type PhoneEnvironment } from "../environment"
import type { PhoneSession } from "../auth"
import type { PhoneStatus } from "../status"

/** What every phone route receives. */
export type RouteProps = {
  status: PhoneStatus
  session: PhoneSession
  environment: PhoneEnvironment
}

export function Panel(props: { title: string; children: JSX.Element }) {
  return (
    <section class="phone-panel">
      <h2>{props.title}</h2>
      {props.children}
    </section>
  )
}

export function Empty(props: { children: JSX.Element }) {
  return <p class="phone-empty">{props.children}</p>
}

/** How to install the app, for an iOS browser tab, where pairing and alerts cannot happen. */
export function InstallCard(props: { environment: PhoneEnvironment; reason: string }) {
  return (
    <div class="phone-install" role="note">
      <strong>Add Vector to your Home Screen</strong>
      <p>{props.reason}</p>
      <ol>
        <For each={installSteps(props.environment)}>{(step) => <li>{step}</li>}</For>
      </ol>
    </div>
  )
}

export function Notice(props: { text: string | undefined }) {
  return (
    <Show when={props.text}>
      <p class="phone-notice" role="status">
        {props.text}
      </p>
    </Show>
  )
}
