import { For } from "solid-js"
import { opsParts } from "../status"
import { Empty, Panel, type RouteProps } from "./parts"

// Production checks (WP A38 shell): one line for each listed part only. Incidents, release watches and cards are
// A50's. On Call copy promises no availability or response time (H3).
const PARTS = {
  "on-call":
    "On Call: alerts after two failed checks in a row on your verified URLs and domains. Vector's agent is on call, not a person.",
  "release-guard": "Release Guard: releases Vector watches, and any revert pull request it opened for you to merge.",
  "ship-desk": "Ship Desk: cards for pull requests from Codium runs, with their checks, to approve.",
} as const

export function OpsRoute(props: RouteProps) {
  return (
    <Panel title="Production">
      <ul class="phone-list">
        <For each={opsParts(props.status)}>{(part) => <li>{PARTS[part]}</li>}</For>
      </ul>
      <Empty>Nothing needs you right now.</Empty>
    </Panel>
  )
}
