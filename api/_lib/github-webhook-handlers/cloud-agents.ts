import {
  bindingFor,
  renameBinding,
  suspendBinding,
  type RepoBinding,
  type SuspendReason,
} from "../cloud-agents-binding.js"

// Structurally matches the shared A47 router without making this independently buildable lane depend on that merge.
export type GithubWebhookEvent = { name: string; action?: string; deliveryId: string; payload: Record<string, unknown> }
export type GithubWebhookHandler = {
  id: string
  events: readonly string[]
  handle(event: GithubWebhookEvent): Promise<void>
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function id(value: unknown) {
  const text = typeof value === "number" && Number.isSafeInteger(value) ? String(value) : value
  return typeof text === "string" && /^[1-9]\d{0,15}$(?![\s\S])/.test(text) && Number.isSafeInteger(Number(text))
    ? text
    : undefined
}

export function createCloudAgentsWebhookHandler(
  deps: {
    bindingFor: (repositoryId: string) => Promise<RepoBinding | undefined>
    suspendBinding: (binding: RepoBinding, reason: SuspendReason) => Promise<void>
    renameBinding: (repositoryId: string, repository: string) => Promise<void>
  } = { bindingFor, suspendBinding, renameBinding },
): GithubWebhookHandler {
  return {
    id: "cloud-agents",
    events: ["repository"] as const,
    async handle(event: GithubWebhookEvent) {
      if (event.name !== "repository" || !["transferred", "deleted", "renamed"].includes(event.action ?? "")) return
      const repository = record(record(event.payload)?.repository)
      const repositoryId = id(repository?.id)
      if (!repositoryId) return
      if (event.action === "renamed") {
        const name = repository?.full_name
        if (typeof name !== "string" || !/^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9_.-]{1,100}$(?![\s\S])/.test(name))
          return
        const binding = await deps.bindingFor(repositoryId)
        if (binding && binding.repository !== name) await deps.renameBinding(repositoryId, name)
        return
      }
      const ownerId = event.action === "transferred" ? id(record(repository?.owner)?.id) : undefined
      if (event.action === "transferred" && !ownerId) return
      const binding = await deps.bindingFor(repositoryId)
      if (!binding || binding.suspended || (event.action === "transferred" && binding.ownerId === ownerId)) return
      await deps.suspendBinding(binding, event.action === "deleted" ? "deleted" : "transferred")
    },
  }
}

export const cloudAgentsWebhookHandler = createCloudAgentsWebhookHandler()
