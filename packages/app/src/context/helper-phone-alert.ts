const record = (value: unknown) => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined

/** Read lifecycle-owned metadata, never a task's output. No reason, prompt or partial command is included in a push. */
export function helperPhoneAlert(value: unknown, now: number) {
  const info = record(value)
  const metadata = record(info?.metadata)
  const lifecycle = record(metadata?.subagent)
  if (!info || !lifecycle || typeof info.id !== "string" || typeof info.parentID !== "string") return undefined
  const parent = typeof lifecycle.rootSessionID === "string" ? lifecycle.rootSessionID : info.parentID
  const waiting = record(lifecycle.waiting)
  const interrupted = record(lifecycle.interruption)
  const event = waiting && (waiting.kind === "permission" || waiting.kind === "question") && typeof waiting.since === "number"
    ? { at: waiting.since, label: "A helper needs you" }
    : interrupted && interrupted.resumedAt === undefined && interrupted.dismissedAt === undefined && typeof interrupted.at === "number"
      ? { at: interrupted.at, label: "A helper was interrupted" } : undefined
  if (!event || !Number.isFinite(event.at) || event.at > now || now - event.at > 5 * 60_000) return undefined
  return { parent, label: event.label, key: `${info.id}:${event.at}:${event.label}` }
}
