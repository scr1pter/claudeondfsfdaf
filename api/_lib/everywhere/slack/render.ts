import type { Milestone } from "../../../../packages/schema/src/everywhere.js"
import type { RouteNote } from "../../../../packages/schema/src/everywhere-policy.js"

export function slackPlan(milestone: Milestone | RouteNote, complete = false) {
  const step = complete ? 3 : milestone === "pushing" ? 2 : ["editing", "testing"].includes(milestone) ? 1 : 0
  return { type: "plan", title: "Vector task", tasks: ["Read the workspace", "Make the changes", "Prepare the result"].map((title, index) => ({
    task_id: `vector-task-${index}`, title, status: complete || index < step ? "complete" : index === step ? "in_progress" : "pending",
  })) }
}

export function slackResult(text: string) {
  return [
    { type: "section", text: { type: "mrkdwn", text } },
    { type: "context_actions", elements: [{ type: "feedback_buttons", action_id: "vector-result-feedback",
      positive_button: { text: { type: "plain_text", text: "Helpful" }, value: "helpful" },
      negative_button: { text: { type: "plain_text", text: "Not helpful" }, value: "unhelpful" } }] },
  ]
}

