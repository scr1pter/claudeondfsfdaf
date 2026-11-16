import { Effect } from "effect"

export * as BrowserBridge from "./browser-bridge"

// The desktop app's browser bridge on 127.0.0.1 (desktop/src/main/browser-bridge.ts), found by the address and token
// the desktop hands the engine. Outside the desktop app there is none.

/** Whether this engine runs under the desktop app, with its browser bridge at hand. */
export function available() {
  return Boolean(process.env.VECTOR_BROWSER_BRIDGE_URL && process.env.VECTOR_BROWSER_BRIDGE_TOKEN)
}

/**
 * Sends one command to the agent browser. A command the page could not take comes back as its whole report with
 * ok: false (409); anything else that is not a report never reached a page (a refused request, a bad token, a desktop
 * that is gone) and fails.
 */
export function command<T extends { readonly ok: boolean; readonly error?: string }>(
  input: Record<string, unknown>,
  signal: AbortSignal,
): Promise<T> {
  const url = process.env.VECTOR_BROWSER_BRIDGE_URL
  const token = process.env.VECTOR_BROWSER_BRIDGE_TOKEN
  if (!url || !token) throw new Error("The controlled browser is available in the Vector desktop app only.")
  return fetch(`${url}/command`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(input),
    signal,
  }).then(async (response) => {
    const report = (await response.json()) as T
    if (typeof report.ok === "boolean" && (response.ok || response.status === 409)) return report
    throw new Error(report.error || `Browser command failed (${response.status})`)
  })
}

/**
 * Closes the agent browsers of these sessions (each session's browser is named by its id, the browser tool's
 * contextId), with their tabs and the pages running in them. Nothing outside the desktop app; a browser already closed,
 * or a desktop that does not answer within a few seconds, is left as it is.
 */
export const close = (sessionIDs: readonly string[]) =>
  Effect.suspend(() =>
    Effect.forEach(
      available() ? sessionIDs : [],
      (contextId) =>
        Effect.promise(() =>
          command({ contextId, command: "closeBrowser" }, AbortSignal.timeout(5_000)).then(
            () => undefined,
            () => undefined,
          ),
        ),
      { concurrency: 4, discard: true },
    ),
  )
