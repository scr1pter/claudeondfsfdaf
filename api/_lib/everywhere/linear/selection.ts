import { randomUUID } from "node:crypto"
import { LIMITS, type InboundTrigger } from "../../../../packages/schema/src/everywhere.js"
import { ApiError } from "../../http.js"
import type { RepoRef } from "../identity.js"
import type { ParsedTrigger } from "../platform.js"
import { sha256Hex } from "../signature.js"
import type { LinearApi } from "./client.js"
import { linearId, linearObject } from "./verify.js"

function optionPrefix(authority: string, team: string, repository: RepoRef) {
  return `ve1:${sha256Hex(authority, "\0", team, "\0", String(repository.id ?? ""), "\0", repository.fullName.toLowerCase())}:`
}

export function linearOptions(authority: string, team: string, repositories: readonly RepoRef[], nonce: string = randomUUID()) {
  return repositories.filter((repository) => Number.isSafeInteger(repository.id) && repository.id! > 0).slice(0, 20).map((repository) => ({ label: repository.fullName, value: `${optionPrefix(authority, team, repository)}${nonce}` }))
}

/** Reconstruct only an exact opaque selection from our own immutable elicitation and the creator's preceding prompt. */
export async function restoreLinearSelection(input: {
  readonly parsed: ParsedTrigger
  readonly authority: string
  readonly bot: string
  readonly repositories: readonly RepoRef[]
  readonly call: LinearApi
}): Promise<Pick<InboundTrigger, "task" | "repository"> | undefined> {
  const chosen = input.parsed.trigger.task
  if (!chosen.startsWith("ve1:")) return undefined
  const reply = input.parsed.reply
  const fail = () => { throw new ApiError(409, "LINEAR_SELECTION_UNVERIFIED", "Choose a current repository option or send your task again.") }
  const data = await input.call("history", { id: reply.session })
  const session = linearObject(data.agentSession)
  const issue = linearObject(session.issue)
  if (session.id !== reply.session || linearObject(session.creator).id !== input.parsed.trigger.actor.userId ||
    linearObject(session.appUser).id !== input.bot || issue.id !== reply.issue || linearObject(issue.team).id !== reply.team) return fail()
  const connection = linearObject(session.activities)
  const nodes = (Array.isArray(connection.nodes) ? connection.nodes.slice(0, 30) : []).map(linearObject)
  const current = nodes.findIndex((node) => node.id === reply.activity)
  if (current < 0 || linearObject(nodes[current]!.user).id !== input.parsed.trigger.actor.userId ||
    linearObject(nodes[current]!.content).__typename !== "AgentActivityPromptContent" || linearObject(nodes[current]!.content).body !== chosen) return fail()
  const question = nodes.slice(current + 1).findIndex((node) => linearObject(node.user).id === input.bot && node.signal === "select" &&
    linearObject(node.content).__typename === "AgentActivityElicitationContent")
  if (question < 0) return fail() // Page exhaustion is explicit refusal; never guess an older prompt or paginate indefinitely.
  const at = current + 1 + question
  if (nodes.slice(current + 1, at).some((node) => ["AgentActivityPromptContent", "AgentActivityElicitationContent"].includes(String(linearObject(node.content).__typename)))) return fail()
  const metadata = linearObject(nodes[at]!.signalMetadata)
  const options = (Array.isArray(metadata.options) ? metadata.options.slice(0, 100) : []).map(linearObject)
  const option = options.find((entry) => entry.value === chosen)
  if (!option) return fail()
  const repository = input.repositories.find((entry) => Number.isSafeInteger(entry.id) && entry.id! > 0 && option.label === entry.fullName && chosen.startsWith(optionPrefix(input.authority, String(reply.team), entry)) &&
    linearId(chosen.slice(optionPrefix(input.authority, String(reply.team), entry).length)))
  if (!repository) return fail()
  // The immediately preceding human prompt must be the same creator. Other authors never become their task.
  const prior = nodes.slice(at + 1).find((node) => linearObject(node.content).__typename === "AgentActivityPromptContent")
  const task = prior && linearObject(prior.content).body
  if (!prior || linearObject(prior.user).id !== input.parsed.trigger.actor.userId || !linearId(prior.id) ||
    typeof task !== "string" || !task.trim() || task.length > LIMITS.taskChars || task.startsWith("ve1:")) return fail()
  return { task, repository: { fullName: repository.fullName, ...(repository.id === undefined ? {} : { id: repository.id }) } }
}
