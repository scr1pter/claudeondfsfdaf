export type PhoneTask = { readonly id: string; readonly title: string; readonly status: string; readonly detail?: string }
const states = new Set(["queued", "running", "waiting_on_user", "completed", "failed", "stopped", "interrupted"])
const record = (value: unknown) => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined

/** Exact display projection: no commands, output paths, prompts, usage figures or model credentials reach this view. */
export function decodeTasks(value: unknown): PhoneTask[] {
  const body = record(value)
  return [...(Array.isArray(body?.tasks) ? body.tasks : []), ...(Array.isArray(body?.shells) ? body.shells : [])].slice(0, 200).flatMap((value) => {
    const item = record(value)
    if (!item || typeof item.id !== "string" || typeof item.title !== "string" || typeof item.status !== "string" || !states.has(item.status)) return []
    const waiting = record(item.waiting)
    const interrupted = record(item.interrupted)
    return [{ id: item.id, title: item.title.slice(0, 200), status: item.connection === "disconnected" ? "disconnected" : item.status,
      ...(interrupted && !interrupted.resumedAt && !interrupted.dismissedAt ? { detail: "Interrupted. Continue this task from Vector on your computer." } :
        waiting ? { detail: waiting.kind === "question" ? "Waiting for your answer in Approvals." : "Waiting for your approval." } : {}),
    }]
  })
}

export function taskStatus(status: string) {
  return ({ waiting_on_user: "Waiting for you", running: "Working", queued: "Queued", completed: "Done", failed: "Failed", stopped: "Stopped", interrupted: "Interrupted", disconnected: "Disconnected · last known state" } as Record<string, string>)[status] ?? status
}
