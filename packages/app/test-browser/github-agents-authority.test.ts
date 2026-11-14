import { expect, test } from "bun:test"
import { createRoot, createSignal } from "solid-js"
import { createAgentsStatus } from "@/features/github-agents/agents-status"
import { agentListing, type AgentsStatus } from "@/features/github-agents/agents-model"

const status = (repositoryId: string): AgentsStatus => ({
  repositoryId,
  signedIn: true,
  canDispatch: true,
  workflow: "current",
  listed: agentListing(),
  bound: "not-yours-or-unknown",
})
const deferred = <T>() => {
  let finish: ((value: T) => void) | undefined
  return {
    promise: new Promise<T>((resolve) => {
      finish = resolve
    }),
    resolve: (value: T) => finish!(value),
  }
}
const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

test("authority invalidation clears current private content immediately and retires an old account reply", async () => {
  const old = deferred<AgentsStatus>()
  const current = deferred<AgentsStatus>()
  const reads: string[] = []
  const privateState = { text: "old Brain", approved: true }
  const live = createRoot((dispose) => ({
    ...createAgentsStatus({
      cwd: () => "/same",
      api: () => ({
        status: (cwd) => {
          reads.push(cwd)
          return reads.length === 1 ? old.promise : current.promise
        },
      }),
      onRetire: () => {
        privateState.text = ""
        privateState.approved = false
      },
    }),
    dispose,
  }))
  await settle()
  privateState.text = "old Brain"
  privateState.approved = true
  const epoch = live.state.authorityEpoch
  live.reload()
  expect(privateState).toEqual({ text: "", approved: false })
  expect(live.state.status).toBeUndefined()
  expect(live.state.authorityEpoch).toBeGreaterThan(epoch)
  await settle()
  current.resolve(status("19"))
  await settle()
  expect(live.state.status?.repositoryId).toBe("19")
  old.resolve(status("17"))
  await settle()
  expect(live.state.status?.repositoryId).toBe("19")
  live.dispose()
})

test("same-directory verification retires old repository state and disposed readers accept no late results", async () => {
  const next = deferred<AgentsStatus>()
  let reads = 0
  const live = createRoot((dispose) => ({
    ...createAgentsStatus({
      cwd: () => "/same",
      api: () => ({ status: async () => (++reads === 1 ? status("17") : next.promise) }),
    }),
    dispose,
  }))
  await settle()
  expect(live.state.status?.repositoryId).toBe("17")
  live.reload()
  expect(live.state.status).toBeUndefined()
  await settle()
  live.dispose()
  next.resolve(status("19"))
  await settle()
  expect(live.state.status).toBeUndefined()
})

test("retirement callbacks cannot introduce reactive read loops into the status request", async () => {
  let reads = 0
  const live = createRoot((dispose) => {
    const [busy, setBusy] = createSignal(false)
    return {
      ...createAgentsStatus({
        cwd: () => "/same",
        api: () => ({
          status: async () => {
            reads += 1
            return status("17")
          },
        }),
        onRetire: () => {
          busy()
        },
      }),
      setBusy,
      dispose,
    }
  })
  await settle()
  expect(reads).toBe(1)
  live.setBusy(true)
  await settle()
  expect(reads).toBe(1)
  live.dispose()
})
