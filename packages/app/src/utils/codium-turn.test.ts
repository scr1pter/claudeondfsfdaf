import { expect, test } from "bun:test"
import type { Event, AssistantMessage } from "@vectordevai/sdk/v2/client"
import { observeCodiumTurns } from "./codium-turn"

function message(id: string, providerID: string, created: number): Event {
  const info = {
    id,
    sessionID: "session",
    role: "assistant",
    providerID,
    modelID: "model",
    time: { created },
  } as AssistantMessage
  return { id: `event-${id}`, type: "message.updated", properties: { sessionID: "session", info } }
}

test("Codium turn refresh fires once at idle and ignores old messages after an own-key turn", () => {
  const calls: string[] = []
  const observe = observeCodiumTurns(() => calls.push("refresh"))
  const idle: Event = { id: "idle", type: "session.idle", properties: { sessionID: "session" } }
  observe(message("codium", "vector-plan", 1))
  expect(calls).toEqual([])
  observe(idle)
  observe({ id: "status", type: "session.status", properties: { sessionID: "session", status: { type: "idle" } } })
  observe(message("codium", "vector-plan", 1))
  observe(idle)
  expect(calls).toEqual(["refresh"])
  observe(message("own", "anthropic", 2))
  observe(message("codium", "vector-plan", 1))
  observe(idle)
  expect(calls).toEqual(["refresh"])
  observe(message("codium-next", "vector-plan", 3))
  observe(idle)
  expect(calls).toEqual(["refresh", "refresh"])
})
