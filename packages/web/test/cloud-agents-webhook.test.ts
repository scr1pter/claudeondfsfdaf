import { expect, test } from "bun:test"
import { createCloudAgentsWebhookHandler } from "../../../api/_lib/github-webhook-handlers/cloud-agents"
import type { RepoBinding, SuspendReason } from "../../../api/_lib/cloud-agents-binding"

function fixture() {
  const state = {
    binding: {
      repositoryId: "123",
      ownerId: "7",
      repository: "old/project",
      account: "11111111-1111-4111-8111-111111111111",
      visibility: "private",
      defaultRef: "refs/heads/main",
      generation: 1,
      binder: { githubId: "9", login: "writer" },
      workflowVersion: "3",
      boundAt: 1_800_000_000_000,
    } as RepoBinding | undefined,
    reads: [] as string[],
    suspended: [] as { repositoryId: string; generation: number; reason: SuspendReason }[],
    renamed: [] as string[],
  }
  const handler = createCloudAgentsWebhookHandler({
    bindingFor: async (id) => {
      state.reads.push(id)
      return state.binding?.repositoryId === id ? { ...state.binding } : undefined
    },
    suspendBinding: async (binding, reason) => {
      if (state.binding?.account !== binding.account || state.binding.generation !== binding.generation) return
      state.suspended.push({ repositoryId: binding.repositoryId, generation: binding.generation, reason })
      state.binding.suspended = reason
      state.binding.generation++
    },
    renameBinding: async (_id, name) => {
      state.renamed.push(name)
      if (state.binding) state.binding.repository = name
    },
  })
  return {
    state,
    handler,
    run: (action: string, repository: unknown = { id: 123, owner: { id: 8 }, full_name: "new/project" }) =>
      handler.handle({ name: "repository", action, deliveryId: "fixture-delivery", payload: { repository } }),
  }
}

test("repository transfer suspends once and ignores a binding already written for the new owner", async () => {
  const f = fixture()
  expect(f.handler.id).toBe("cloud-agents")
  expect(f.handler.events).toEqual(["repository"])
  await f.run("transferred")
  await f.run("transferred")
  expect(f.state.suspended).toEqual([{ repositoryId: "123", generation: 1, reason: "transferred" }])
  const rebound = fixture()
  rebound.state.binding!.ownerId = "8"
  await rebound.run("transferred")
  expect(rebound.state.suspended).toEqual([])
})

test("delete and rename are replay-safe and unknown repositories are no-ops", async () => {
  const deleted = fixture()
  await deleted.run("deleted")
  await deleted.run("deleted")
  expect(deleted.state.suspended).toEqual([{ repositoryId: "123", generation: 1, reason: "deleted" }])
  const renamed = fixture()
  await renamed.run("renamed")
  await renamed.run("renamed")
  expect(renamed.state.renamed).toEqual(["new/project"])
  const missing = fixture()
  missing.state.binding = undefined
  await missing.run("deleted")
  await missing.run("transferred")
  await missing.run("renamed")
  expect(missing.state.suspended).toEqual([])
  expect(missing.state.renamed).toEqual([])
})

test("unknown actions and malformed repository data cause no store read and never throw", async () => {
  const f = fixture()
  await f.run("unknown")
  for (const action of ["transferred", "deleted", "renamed"]) {
    for (const repository of [
      null,
      [],
      {},
      { id: 0 },
      { id: -1 },
      { id: 1.5 },
      { id: "123\n" },
      { id: Number.MAX_SAFE_INTEGER + 1 },
    ])
      await f.run(action, repository)
  }
  for (const repository of [{ id: 123 }, { id: 123, owner: {} }, { id: 123, owner: { id: -1 } }])
    await f.run("transferred", repository)
  for (const full_name of [undefined, "../outside", "owner/repo\n", "owner/repo/other", "owner space/repo"])
    await f.run("renamed", { id: 123, full_name })
  await f.handler.handle({ name: "installation", action: "deleted", deliveryId: "x", payload: {} })
  expect(f.state.reads).toEqual([])
})

test("valid deliveries propagate a persistent failure for the shared router to retry", async () => {
  const handler = createCloudAgentsWebhookHandler({
    bindingFor: async () => {
      throw new Error("fixture store unavailable")
    },
    suspendBinding: async () => {},
    renameBinding: async () => {},
  })
  await expect(
    handler.handle({ name: "repository", action: "deleted", deliveryId: "x", payload: { repository: { id: 123 } } }),
  ).rejects.toThrow("fixture store unavailable")
  await expect(
    handler.handle({ name: "repository", action: "unknown", deliveryId: "x", payload: {} }),
  ).resolves.toBeUndefined()
})
