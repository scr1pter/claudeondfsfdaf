import type { Milestone } from "../../../../packages/schema/src/everywhere.js"
import type { RouteNote } from "../../../../packages/schema/src/everywhere-policy.js"

export function linearPlan(milestone: Milestone | RouteNote, terminal?: "completed" | "canceled") {
  const active = milestone === "pushing" ? 2 : ["editing", "testing"].includes(milestone) ? 1 : 0
  return ["Read the workspace", "Make the changes", "Prepare the result"].map((content, index) => ({ content,
    status: terminal ?? (index < active ? "completed" : index === active ? "inProgress" : "pending") }))
}

export function linearThought(milestone: Milestone | RouteNote) {
  return milestone === "waiting" ? "Waiting for your computer." : milestone === "actions" ? "Starting your GitHub runner." :
    milestone === "pushing" ? "Preparing the result." : milestone === "editing" ? "Working on the requested changes." :
    milestone === "testing" ? "Reviewing the changes." : "Working on your request."
}
