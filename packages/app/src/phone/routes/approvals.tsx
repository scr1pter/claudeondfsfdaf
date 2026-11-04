import { Show } from "solid-js"
import { canPair } from "../environment"
import { Empty, InstallCard, Panel, type RouteProps } from "./parts"

// Remote's approvals (WP A38 shell). A42 fills it: a permission an agent asks for on a paired computer can be allowed
// once or denied here, never allowed always, and the computer checks the answer itself (S6).
export function ApprovalsRoute(props: RouteProps) {
  return (
    <Panel title="Approvals">
      <Show
        when={canPair(props.environment)}
        fallback={
          <InstallCard
            environment={props.environment}
            reason="Approvals work only in the installed app, where this phone keeps its pairing keys."
          />
        }
      >
        <Empty>
          When an agent on a paired computer asks for permission, you can allow it once or deny it here. Nothing is
          waiting for you.
        </Empty>
      </Show>
    </Panel>
  )
}
