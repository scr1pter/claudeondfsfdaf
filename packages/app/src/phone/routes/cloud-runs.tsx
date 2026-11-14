import { Empty, Panel, type RouteProps } from "./parts"

// Runs of Vector's GitHub agent (WP A38 shell), from the run records Remote's API reads (A40). They run in the
// user's own repo, on the user's own Actions minutes (H4).
export function CloudRunsRoute(_props: RouteProps) {
  return (
    <Panel title="GitHub runs">
      <Empty>
        Runs of Vector's GitHub agent show here with their pull requests. They run in your own repo, on your own Actions
        minutes.
      </Empty>
    </Panel>
  )
}
