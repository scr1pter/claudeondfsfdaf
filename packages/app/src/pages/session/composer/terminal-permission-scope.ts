import type { PermissionRequest } from "@vectordevai/sdk/v2"

/** The terminal actions that ask, under the terminal permission, for a terminal the agent did not open. */
export const TERMINAL_ACTIONS = ["read", "wait", "resize", "close"] as const
export type TerminalAction = (typeof TERMINAL_ACTIONS)[number]

// The terminal tool asks before it reads, waits on, resizes or closes a terminal the agent did not open, and before it
// types into a terminal. The prompt names the terminal by its title and shows the text and keys exactly as they would
// be sent, so Allow is never given for input the user has not seen. The metadata comes from the engine; anything that
// is not this shape is left out.
export function terminalPermissionScope(request: Pick<PermissionRequest, "permission" | "metadata">) {
  if (request.permission !== "terminal" && request.permission !== "terminal_input") return
  const meta = request.metadata
  const string = (key: string) => {
    const value = meta[key]
    return typeof value === "string" ? value : undefined
  }
  const id = string("id")
  const title = string("title")?.trim()
  const terminal = title && id ? `${title} (${id})` : (title ?? id)
  const action = request.permission === "terminal" ? string("action") : undefined
  const text = request.permission === "terminal_input" ? string("text") : undefined
  const keys =
    request.permission === "terminal_input" && Array.isArray(meta.keys)
      ? meta.keys.filter((key): key is string => typeof key === "string")
      : []
  if (!terminal && text === undefined && keys.length === 0) return
  return {
    terminal,
    action: TERMINAL_ACTIONS.find((item) => item === action),
    text,
    enter: text !== undefined && meta.enter === true,
    keys,
  }
}
