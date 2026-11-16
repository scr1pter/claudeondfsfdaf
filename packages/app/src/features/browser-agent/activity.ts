import type { BrowserAgentActivity, BrowserAgentApi } from "./types"

/** The window event that asks the session page to open Preview on its own browser (session-side-panel.tsx). */
export const OPEN_PREVIEW = "vector:open-browser-preview"

/** The agent browsers open right now, by context, as the desktop announces them. A closed one, or one with no tab, is dropped. */
export function applyActivity(open: ReadonlyMap<string, BrowserAgentActivity>, event: BrowserAgentActivity) {
  const next = new Map(open)
  if (event.closed || event.tabs <= 0) next.delete(event.contextId)
  else next.set(event.contextId, event)
  return next
}

/**
 * The browsers a session's page shows the indicator for: its own (named by the session's id) and its helpers' (a
 * session whose parents lead to it), while no Preview shows them. `own` is the session's own browser, which its
 * Preview can show; a helper's has no Preview of its own, only Stop.
 */
export function visibleActivity(
  open: ReadonlyMap<string, BrowserAgentActivity>,
  sessionID: string,
  parentOf: (sessionID: string) => string | undefined,
) {
  return [...open.values()]
    .filter((activity) => !activity.shown && ancestors(activity.contextId, parentOf).includes(sessionID))
    .map((activity) => ({ activity, own: activity.contextId === sessionID }))
    .toSorted((a, b) => Number(b.own) - Number(a.own) || a.activity.contextId.localeCompare(b.activity.contextId))
}

/** What the indicator names the page by: its title, else its host, else nothing. */
export function activityLabel(activity: Pick<BrowserAgentActivity, "title" | "url">) {
  if (activity.title.trim()) return activity.title.trim()
  try {
    return new URL(activity.url).host
  } catch {
    return ""
  }
}

function ancestors(sessionID: string, parentOf: (sessionID: string) => string | undefined) {
  const out = [sessionID]
  for (let current = parentOf(sessionID); current && !out.includes(current) && out.length < 100; current = parentOf(current))
    out.push(current)
  return out
}

/** Stop on the indicator: closes that browser, its tabs and their pages. A desktop that is gone has nothing to close. */
export function stopBrowser(api: Pick<BrowserAgentApi, "runBrowserAgent"> | undefined, contextId: string) {
  return api?.runBrowserAgent({ contextId, command: "closeBrowser" }).then(
    () => undefined,
    () => undefined,
  )
}
