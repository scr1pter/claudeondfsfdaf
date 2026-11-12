import { ApiError } from "../../http.js"
import { PLATFORM_HOSTS, platformFetch, readPlatformJson } from "../fetch.js"
import { linearObject } from "./verify.js"

export const LINEAR_QUERIES = {
  viewer: "query EverywhereViewer { viewer { id app active guest organization { id } } organization { id } }",
  user: "query EverywhereUser($id: String!) { user(id: $id) { id app active guest organization { id } } }",
  activity: "query EverywhereActivity($id: String!) { agentActivity(id: $id) { id agentSession { id } user { id } signal signalMetadata content { __typename ... on AgentActivityThoughtContent { body } ... on AgentActivityResponseContent { body } ... on AgentActivityErrorContent { body } ... on AgentActivityElicitationContent { body } } } }",
  history: "query EverywhereSessionHistory($id: String!) { agentSession(id: $id) { id creator { id } appUser { id } issue { id team { id } } activities(first: 30, orderBy: createdAt) { nodes { id createdAt user { id } signal signalMetadata content { __typename ... on AgentActivityPromptContent { body } ... on AgentActivityElicitationContent { body } } } pageInfo { hasNextPage } } } }",
  create: "mutation EverywhereActivityCreate($input: AgentActivityCreateInput!) { agentActivityCreate(input: $input) { success agentActivity { id } } }",
  session: "mutation EverywhereSessionUpdate($id: String!, $input: AgentSessionUpdateInput!) { agentSessionUpdate(id: $id, input: $input) { success } }",
  issue: "query EverywhereIssue($id: String!) { issue(id: $id) { id team { id } state { type } } }",
  states: "query EverywhereStartedStates($id: String!) { team(id: $id) { id states(first: 50, filter: {type: {eq: \"started\"}}) { nodes { id position } } } }",
  start: "mutation EverywhereIssueStart($id: String!, $state: String!) { issueUpdate(id: $id, input: {stateId: $state}) { success } }",
} as const
export type LinearOperation = keyof typeof LINEAR_QUERIES

export class LinearFailure extends ApiError {
  constructor(readonly uncertain = false, readonly retryMs = 0) {
    super(503, uncertain ? "LINEAR_DELIVERY_UNCERTAIN" : "LINEAR_UNAVAILABLE", "Linear is temporarily unavailable.")
  }
}

export type LinearCooldown = { read(): Promise<number>; write(at: number): Promise<void> }
export function linearApi(input: {
  readonly token: string
  readonly fetcher?: typeof fetch
  readonly now?: () => number
  readonly revoked?: () => Promise<void>
  readonly cooldown?: LinearCooldown
  readonly deadline?: number
}) {
  return async (operation: LinearOperation, variables: Readonly<Record<string, unknown>> = {}) => {
    if (!Object.hasOwn(LINEAR_QUERIES, operation)) throw new RangeError("Unsupported Linear operation")
    const now = (input.now ?? Date.now)()
    const until = await input.cooldown?.read() ?? 0
    if (until > now) throw new LinearFailure(false, until - now)
    const remaining = input.deadline === undefined ? 10_000 : Math.min(10_000, input.deadline - (input.now ?? Date.now)())
    if (remaining <= 0) throw new LinearFailure(false)
    let response: Response
    try {
      response = await platformFetch("linear", new URL("/graphql", `https://${PLATFORM_HOSTS.linear[0]!.host}`), {
        method: "POST", headers: { authorization: `Bearer ${input.token}`, "content-type": "application/json" },
        body: JSON.stringify({ query: LINEAR_QUERIES[operation], variables }), signal: AbortSignal.timeout(remaining),
      }, input.fetcher)
    } catch { throw new LinearFailure(true) }
    if (response.status === 401) {
      await response.body?.cancel().catch(() => undefined)
      await input.revoked?.()
      throw new LinearFailure(false)
    }
    const limits = ["x-ratelimit-requests", "x-ratelimit-endpoint-requests", "x-ratelimit-complexity"]
    const resets = limits.filter((limit) => response.headers.get(`${limit}-remaining`) === "0").map((limit) => Number(response.headers.get(`${limit}-reset`)))
    const retry = Number(response.headers.get("retry-after"))
    const blocked = Math.max(0, ...resets.filter((value) => Number.isSafeInteger(value) && value > now),
      response.status === 429 ? now + (Number.isFinite(retry) && retry > 0 ? Math.min(retry * 1000, 86_400_000) : 60_000) : 0)
    if (blocked) await input.cooldown?.write(Math.min(blocked, now + 86_400_000))
    if (response.status === 429 || response.status >= 500) {
      await response.body?.cancel().catch(() => undefined)
      throw new LinearFailure(response.status >= 500, blocked ? blocked - now : 0)
    }
    const result = linearObject(await readPlatformJson(response).catch(() => { throw new LinearFailure(true) }))
    if (!response.ok || Array.isArray(result.errors) && result.errors.length) {
      const limited = Array.isArray(result.errors) && result.errors.some((error) => linearObject(linearObject(error).extensions).code === "RATELIMITED")
      if (limited) await input.cooldown?.write(blocked || now + 60_000)
      throw new LinearFailure(!limited && ["create", "start", "session"].includes(operation), limited ? Math.max(60_000, blocked - now) : 0)
    }
    const data = linearObject(result.data)
    if (!Object.keys(data).length) throw new LinearFailure(true)
    return data
  }
}
export type LinearApi = ReturnType<typeof linearApi>
