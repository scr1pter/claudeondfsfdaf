// The clause-aware scripted model: compounding/policy.ts's model, which also does only what the prompt in front of it
// says. A behaviour whose clause the request's system prompt no longer states is dropped. Without its verification
// clauses it never runs the tests or the check after a change, so it misses the errors only they show, and the hidden
// acceptance tests can fail. It stays a pure function of the request and of the clauses it is given.

import type { Call } from "../compounding/model-server"
import { decide, type Options } from "../compounding/policy"
import type { Files, Task } from "../compounding/tasks"
import { stated, type Clause } from "./contracts"

type Message = { readonly role: string; readonly content: unknown }

/** The behaviours a request drops: those with a clause its system prompt no longer states, or states turned around. */
export function dropped(body: Record<string, unknown>, clauses: readonly Clause[]) {
  const system = systemText(body)
  return new Set(clauses.flatMap((clause) => (clause.behaviour && !stated(clause, system) ? [clause.behaviour] : [])))
}

/** A request's system prompt as one text, whether it came as a string or as blocks. */
export function systemText(body: Record<string, unknown>) {
  return Array.isArray(body.system)
    ? body.system
        .map((block) => (block && typeof block === "object" && "text" in block ? String(block.text) : ""))
        .join("\n")
    : String(body.system ?? "")
}

export function decideByClauses(
  task: Task,
  start: Files,
  body: Record<string, unknown>,
  options: Options & { readonly clauses: readonly Clause[] },
): Call {
  if (!dropped(body, options.clauses).has("verify")) return decide(task, start, body, options)
  // The script still verifies. Each check it would run is answered as passed outside the conversation, so the script
  // goes on as a model that never ran one: it recovers from nothing and reports done.
  const messages = (Array.isArray(body.messages) ? body.messages : []) as Message[]
  const first = messages.findIndex((message) => message.role === "assistant")
  const head = first === -1 ? messages : messages.slice(0, first)
  const turns =
    first === -1
      ? []
      : messages
          .slice(first)
          .flatMap((message, at, rest) => (message.role === "assistant" ? [rest.slice(at, at + 2)] : []))
  const played = [...head]
  const state = { at: 0 }
  for (const step of Array.from({ length: 1_000 }, (_, index) => index)) {
    const call = decide(task, start, { ...body, messages: played }, options)
    if (!verifies(call)) {
      if (state.at === turns.length) return call
      played.push(...turns[state.at]!)
      state.at += 1
      continue
    }
    const id = `toolu_skipped_${step}`
    played.push(
      { role: "assistant", content: [{ type: "tool_use", id, name: call.name, input: call.input }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: "" }] },
    )
  }
  throw new Error(`The script for ${task.id} never ended`)
}

// The script's own checks after a change: the tests, the check and any the task asks for, first runs and re-runs.
function verifies(call: Call): call is Extract<Call, { name: string }> {
  return "name" in call && call.name === "bash" && String(call.input.description ?? "").startsWith("Verify the change")
}
