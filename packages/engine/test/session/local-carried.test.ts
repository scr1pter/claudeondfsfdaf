import { describe, expect, test } from "bun:test"
import type { SessionV1 } from "@vectordevai/core/v1/session"
import { SessionMemory } from "../../src/session/memory"
import { carriedOf } from "../../src/session/prompt"

// What a request carries out of the brain, for Vector Local's network log (section 5.4): learned skills count as the
// repository's own memory, a line for each skill the system prompt lists and each loaded skill whose steps the request
// fills in. Where they are withheld, only the listing counts.

const message = (parts: readonly unknown[]) =>
  ({ info: { id: "msg_1", role: "assistant", time: { created: 1 } }, parts }) as unknown as SessionV1.WithParts

const recall = {
  type: "text",
  synthetic: true,
  text: "",
  metadata: { [SessionMemory.RECALL]: { ids: ["m00001", "m00002"], personal: ["m00002"] } },
}
const loaded = (id: string) => ({
  type: "tool",
  tool: "skill",
  callID: id,
  state: {
    status: "completed",
    input: { name: `learned-${id}` },
    output: "placeholder",
    metadata: { learned: id, [SessionMemory.SKILL]: { id, version: 1, checks: ["bun test"] } },
    time: { start: 1, end: 2 },
  },
})

describe("carriedOf", () => {
  test("counts listed learned skills and the loaded ones a request fills in under the repository", () => {
    const msgs = [message([recall, loaded("sabcdef"), loaded("sbcdefg")])]
    expect(carriedOf(msgs, true, true, 3)).toEqual({ personal: 1, documents: 0, repository: 1 + 3 + 2 })
  })

  test("a loaded skill whose steps are withheld is not carried; the listing still is", () => {
    const msgs = [message([recall, loaded("sabcdef")])]
    expect(carriedOf(msgs, false, false, 2)).toEqual({ personal: 0, documents: 0, repository: 1 + 2 })
  })
})
