import { Empty, Panel, type RouteProps } from "./parts"

// The cloud computer (WP A38 shell). Its phone view, with the live view and take-over, is A56's. Copy about it always
// says Vector runs it (H4).
export function ComputerRoute(_props: RouteProps) {
  return (
    <Panel title="Cloud computer">
      <Empty>Jobs on the computer Vector runs for you show here, with a live view you can take over.</Empty>
    </Panel>
  )
}
