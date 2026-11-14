import { afterEach, expect } from "bun:test"
import { Effect, Result } from "effect"
import { LayerNode } from "@vectordevai/core/effect/layer-node"
import { Brain } from "@vectordevai/core/brain/brain"
import { BrainRunProposals } from "@vectordevai/core/brain/run-proposals"
import { CloudBrain } from "@/brain/run-bundle"
import { Instruction } from "@/session/instruction"
import { disposeAllInstances } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

afterEach(disposeAllInstances)
const it = testEffect(LayerNode.compile(LayerNode.group([CloudBrain.node, Brain.node, Instruction.node])))

it.instance("actual cloud review-queue drafts return for review without private or personal context", () => Effect.gen(function* () {
  const brain = yield* Brain.Service
  const cloud = yield* CloudBrain.Service
  const place = yield* (yield* Instruction.Service).place()
  const startedAt = Date.now() - 1000
  const text = "Parser trailing delimiters use a dedicated snapshot fixture."
  yield* brain.propose(place, { kind: "lesson", scope: "repository", origin: "agent", pending: "review", text })
  yield* brain.propose(place, { kind: "fact", scope: "repository", origin: "agent", pending: "review", private: true,
    text: "Private issue triage uses a separate restricted checklist." })
  yield* brain.propose(place, { kind: "fact", scope: "personal", origin: "import",
    text: "The owner prefers a separate personal summary document." })
  const packed = yield* cloud.proposals({ originalSource: "desktop", startedAt, publicRepository: false, maxBytes: 512 * 1024 })
  expect(packed).toBeDefined()
  const file = BrainRunProposals.decode({ ...packed!, publicRepository: false })
  expect(file.memory.entries.map((entry) => entry.text)).toEqual([text])
  expect(file.memory.entries[0]).toMatchObject({ status: "proposed", pinned: false })
  const missingVisibility = yield* cloud.returned(packed!).pipe(Effect.result)
  expect(Result.isFailure(missingVisibility)).toBe(true)
  // Clear only this disposable test repository's rows, then restore the real authenticated-archive adapter input.
  yield* brain.erase(place, "repository")
  yield* cloud.returned({ ...packed!, publicRepository: false })
  const restored = yield* brain.list(place, { scope: "repository", filter: "all" })
  expect(restored).toHaveLength(1)
  expect(restored[0]).toMatchObject({ text, status: "proposed", pinned: false, origin: "import" })
  expect((yield* brain.list(place, { scope: "repository", filter: "active" }))).toEqual([])
}))
