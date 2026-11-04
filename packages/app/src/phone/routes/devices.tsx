import { Show } from "solid-js"
import { canPair } from "../environment"
import { Empty, InstallCard, Panel, type RouteProps } from "./parts"

// Remote's devices (WP A38 shell). A42 adds pairing, revoking and "Disconnect all". The paired count comes from the
// status, and the relay refuses a pairing over the plan's count whatever this page shows (S1).
export function DevicesRoute(props: RouteProps) {
  const limit = () => {
    const remote = props.status.entitlements.remote
    const computers = remote && typeof remote === "object" ? (remote as { computers?: unknown }).computers : undefined
    return typeof computers === "number" ? computers : 0
  }
  return (
    <Panel title="Devices">
      <p class="phone-meta">
        <Show
          when={props.status.remote}
          fallback={`Your plan pairs up to ${limit()} ${limit() === 1 ? "computer" : "computers"}.`}
        >
          {(remote) => `${remote().computers} of ${remote().limit} computers paired.`}
        </Show>
      </p>
      <Show
        when={canPair(props.environment)}
        fallback={
          <InstallCard
            environment={props.environment}
            reason="On iPhone and iPad, pairing happens inside the installed app, which keeps its own keys apart from Safari."
          />
        }
      >
        <Empty>This phone is not paired with a computer.</Empty>
      </Show>
    </Panel>
  )
}
