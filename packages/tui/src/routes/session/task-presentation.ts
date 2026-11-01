import { CodiumUsage } from "@vectordevai/core/codium-usage"
import type { Task } from "@vectordevai/schema/task"

export function taskDescription(task: Task.Info) {
  return [
    task.connection === "disconnected"
      ? `Disconnected (last known: ${task.status})`
      : task.status === "waiting_on_user"
        ? "Needs you"
        : task.status,
    `${Math.round(task.elapsedMs / 1000)}s`,
    ...(CodiumUsage.taskText(task) ??
      (task.usage
        ? [
            `${task.usage.total.toLocaleString("en-US")} tokens`,
            task.usage.unpricedSteps
              ? "cost partly unknown"
              : task.costKind === "plan"
                ? "covered by plan"
                : task.costKind === "free"
                  ? "free model"
                  : `$${task.usage.cost.toFixed(4)}`,
          ]
        : task.measuredCost !== undefined
          ? [`$${task.measuredCost.toFixed(4)} reported`, "tokens unavailable"]
          : [
              task.costKind === "plan"
                ? "covered by plan"
                : task.costKind === "free"
                  ? "free model"
                  : "usage unavailable",
            ])),
    ...(task.currentStep ? [task.currentStep] : []),
    ...(task.dependsOn.length
      ? [`${task.dependsOn.length} ${task.dependsOn.length === 1 ? "dependency" : "dependencies"}`]
      : []),
  ].join(" · ")
}

export function taskProgress(result: Task.InspectResult) {
  return [
    taskDescription(result.task),
    ...(result.task.reason ? [result.task.reason] : []),
    ...(result.task.ownedPaths.length ? [`Owns: ${result.task.ownedPaths.join(", ")}`] : []),
    ...(result.task.dependsOn.length ? [`Depends on: ${result.task.dependsOn.join(", ")}`] : []),
    ...result.steps.map((step) => `${step.tool ?? "Step"}${step.status ? ` (${step.status})` : ""}: ${step.text}`),
    result.output,
    ...(result.truncated
      ? [
          `Showing bounded progress. Result reference: ${result.task.resultRef ?? result.task.sessionID ?? result.task.id}`,
        ]
      : []),
  ]
    .filter(Boolean)
    .join("\n\n")
}
