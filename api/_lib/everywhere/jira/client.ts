import { ApiError } from "../../http.js"
import { platformFetch, readPlatformJson } from "../fetch.js"
import { everywhereKeys } from "../keys.js"
import { storeScore, type Store } from "../store.js"
import { JIRA_UUID, jiraObject } from "./fit.js"

export const JIRA_SCOPES = ["read:jira-work", "read:jira-user", "read:app-user-token", "read:app-system-token"] as const
export class JiraFailure extends ApiError {
  constructor(readonly retryMs = 0) { super(503, "JIRA_UNAVAILABLE", "Jira is temporarily unavailable.") }
}
export function jiraClient(input: { readonly cloudId: string; readonly userToken: string; readonly fetcher?: typeof fetch; readonly store: Store; readonly now: () => number }) {
  if (!JIRA_UUID.test(input.cloudId) || !/^[\x21-\x7e]{1,16384}$/.test(input.userToken)) throw new JiraFailure()
  return async (operation: "myself" | "issue" | "comment", id?: string, commentId?: string) => {
    if (operation !== "myself" && (!id || !/^[1-9][0-9]{0,19}$/.test(id))) throw new JiraFailure()
    if (operation === "comment" && (!commentId || !/^[1-9][0-9]{0,19}$/.test(commentId))) throw new JiraFailure()
    const key = everywhereKeys.jiraRetry(`jira:${input.cloudId}`)
    // Native Redis may answer the score as a number; a malformed or negative one is a store fault, not a cooldown.
    const until = storeScore(await input.store(["ZSCORE", key, "until"]))
    if (until > input.now()) throw new JiraFailure(until - input.now())
    const path = operation === "myself" ? "/rest/api/3/myself" : operation === "comment" ? `/rest/api/3/issue/${id}/comment/${commentId}` :
      `/rest/api/3/issue/${id}?fields=summary,description,project,reporter,comment`
    const response = await platformFetch("jira", `https://api.atlassian.com/ex/jira/${input.cloudId}${path}`, {
      headers: { authorization: `Bearer ${input.userToken}`, accept: "application/json" },
    }, input.fetcher).catch(() => { throw new JiraFailure() })
    if (!response.ok) {
      const seconds = Number(response.headers.get("retry-after"))
      if (response.status === 429) {
        const at = input.now() + (Number.isFinite(seconds) && seconds > 0 ? Math.min(86_400_000, seconds * 1000) : 60_000)
        await input.store(["ZADD", key, "GT", Math.ceil(at), "until"])
        await input.store(["PEXPIRE", key, 86_400_000])
        await response.body?.cancel().catch(() => undefined)
        throw new JiraFailure(at - input.now())
      }
      await response.body?.cancel().catch(() => undefined)
      throw new JiraFailure()
    }
    return jiraObject(await readPlatformJson(response))
  }
}
