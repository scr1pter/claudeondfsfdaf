// What a learned workflow default did to a request, for the "Learned default · Why" chip under the reply (section 6.3).
// The engine writes it on the assistant message beside the user's own variant, which it never changes.

export type Workflow = {
  readonly effort?: "default"
  readonly split?: "solo"
  readonly subagentModel?: "small"
  readonly source: "learned" | "explore"
  readonly reason: string
}

/** The chip's line. Exploration is a try, so it says so. */
export function chipLabel(workflow: Pick<Workflow, "source">) {
  return workflow.source === "explore" ? "Trying a cheaper default" : "Learned default"
}

/** What the default changed for this request, in a few words. */
export function changed(workflow: Pick<Workflow, "effort" | "split" | "subagentModel">) {
  return [
    ...(workflow.effort ? ["Default effort instead of Thorough's high effort"] : []),
    ...(workflow.split ? ["Worked without subagents"] : []),
    ...(workflow.subagentModel ? ["The small model for subagents"] : []),
  ].join(" · ")
}

/**
 * Where "Workflow insights" opens Settings: the repository and folder the reply ran in. The insights are a repository's,
 * so Settings opened without one shows none of them.
 */
export function insightsPlace(message: { readonly path: { readonly root: string; readonly cwd: string } }) {
  return { repositoryPath: message.path.root, sessionDirectory: message.path.cwd }
}

/** The popover's own words. */
export const WORKFLOW_CHIP = {
  own: "Your own picks always win. Learned defaults only drop Thorough's extra effort, skip subagents or use a cheaper subagent model; spend caps are unchanged.",
  link: "Workflow insights",
  stop: "Stop using learned defaults",
  stopped:
    "Vector records runs and applies no learned defaults. Turn them back on in Settings > Memory > Workflow insights.",
  failed: "Vector could not change the setting. Try again in a moment.",
}
