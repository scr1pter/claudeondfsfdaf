import { Effect, ManagedRuntime } from "effect"
import type { Brain } from "@vectordevai/core/brain/brain"
import { BrainWorkflow } from "@vectordevai/core/brain/workflow"
import { LayerNode } from "@vectordevai/core/effect/layer-node"
import { AppNodeBuilderV1 } from "../../src/effect/app-node-builder-v1"
import { ServerAuth } from "../../src/server/auth"
import { Server } from "../../src/server/server"

// One person's Vector for the desktop's Brain Vault acceptance test (packages/desktop/src/main/vault-sections.test.ts):
// the real engine server on a loopback port, in a process of its own, with the HOME and XDG folders the test gives it,
// as the desktop app runs its engine. No route writes workflow runs, so a line `workflow <directory>` on stdin records
// eight checked, priced runs of the build agent there through BrainWorkflow, as the engine records them at the end of a
// run, over the same brain file the server reads, and answers `recorded`.

const listener = await Server.listen({ hostname: "127.0.0.1", port: 0 })
const runtime = ManagedRuntime.make(AppNodeBuilderV1.build(LayerNode.group([BrainWorkflow.node])))
const authorization =
  ServerAuth.header({ username: "vector", password: process.env.VECTOR_SERVER_PASSWORD ?? "" }) ?? ""

const placeOf = async (directory: string): Promise<Brain.Place> => {
  const url = new URL("/project/current", listener.url)
  url.searchParams.set("directory", directory)
  const project = (await (await fetch(url, { headers: { authorization }, keepalive: false })).json()) as { id: string }
  return { repository: project.id, root: directory, sources: [], held: false }
}

const run = (index: number): BrainWorkflow.Observation => ({
  sessionID: `ses_vault_${index}`,
  requestID: `msg_vault_${index}`,
  at: Date.now() - index * 1000,
  tier: "thorough",
  effortTier: "thorough",
  agent: "build",
  providerID: "anthropic",
  modelID: "claude-x",
  effort: "default",
  effortSource: "size",
  subagents: 0,
  subagentModels: {},
  judgeRounds: 0,
  outcome: "pass",
  signal: "recovered",
  costUsd: 0.4,
  costKinds: { priced: 3 },
  steps: 3,
  unpricedSteps: 0,
  tokens: { input: 1000, output: 200, reasoning: 0, cacheRead: 0 },
  partial: false,
})

console.log(`listening on ${listener.url}`)

for await (const line of console) {
  const directory = /^workflow (.+)$/.exec(line.trim())?.[1]
  if (!directory) continue
  const where = await placeOf(directory)
  await runtime.runPromise(
    Effect.gen(function* () {
      const workflow = yield* BrainWorkflow.Service
      yield* Effect.forEach(
        Array.from({ length: 8 }, (_, index) => run(index)),
        (observation) => workflow.record(where, observation),
        { discard: true },
      )
    }),
  )
  console.log("recorded")
}

// stdin closes when the test stops this process or dies itself; the listener would otherwise keep it running.
await listener.stop(true)
await runtime.dispose()
process.exit(0)
