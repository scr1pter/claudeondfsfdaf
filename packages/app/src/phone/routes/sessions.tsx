import { Show } from "solid-js"
import { canPair } from "../environment"
import { Empty, InstallCard, Panel, type RouteProps } from "./parts"

// Remote's sessions (WP A38 shell). Remote's phone half (A42) lists the paired computers' sessions here, streamed
// end to end encrypted through the relay while this page is open.
export function SessionsRoute(props: RouteProps) {
  return (
    <Panel title="Sessions">
      <Show
        when={canPair(props.environment)}
        fallback={
          <InstallCard
            environment={props.environment}
            reason="Sessions open only in the installed app, where this phone keeps its pairing keys."
          />
        }
      >
        <Empty>Sessions on your paired computers show here. Pair a computer from Devices first.</Empty>
      </Show>
    </Panel>
  )
}
