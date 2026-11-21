import { Hash } from "@vectordevai/core/util/hash"
import type { Trust } from "@vectordevai/core/review/types"

export * as ReviewMcp from "./mcp"

// D11. A grant may authorize a broker snapshot. No first-release review exposes a live call to a model.
export const LIVE_REVIEW_MCP = false

// The engine stamps its own helper sessions; model text and the agent's display name are not authority.
export function restrictsModel(internal: string | undefined): boolean {
  return internal?.startsWith("vectorscope.") === true && !LIVE_REVIEW_MCP
}

export interface Context {
  readonly owner: string
  readonly repository: string
  readonly server: string
}

export interface Identity {
  readonly serverIdentity: string
  readonly endpointHash: string
  readonly capabilitiesHash: string
}

export interface Capability {
  readonly kind: "tool" | "resource"
  readonly id: string
  readonly schemaHash: string
}

// These two facts come from the owner-controlled source, never a server's annotations or a model argument.
export interface Grant extends Context, Identity {
  readonly selected: readonly (Capability & { readonly access: "read" | "possibly-writing" | "unknown" })[]
}

export type GrantSource = (context: Readonly<Context>) => readonly Grant[]

export type Status =
  | "granted-read"
  | "missing-grant"
  | "ambiguous-grant"
  | "unavailable"
  | "identity-changed"
  | "capability-denied"
  | "untrusted-live"
  | "live-disabled"

export interface Decision {
  readonly status: Status
  readonly audit: {
    readonly contextHash: string
    readonly identityHash: string
    readonly capabilityHash: string
    readonly status: Status
  }
}

// Encode tuple boundaries so distinct parts never collide through concatenation.
export function digest(parts: readonly string[]): string {
  return Hash.sha256(JSON.stringify(parts))
}

const hash = /^[0-9a-f]{64}$/

export function decide(
  input: {
    context: Context
    identity: Identity
    capability: Capability
    trust: Trust
    use: "live" | "snapshot"
  },
  source?: GrantSource,
): Decision {
  const { owner, repository, server } = input.context
  const { serverIdentity, endpointHash, capabilitiesHash } = input.identity
  const { kind, id, schemaHash } = input.capability
  const result = (status: Status): Decision => ({
    status,
    audit: {
      contextHash: digest([owner, repository, server]),
      identityHash: digest([serverIdentity, endpointHash, capabilitiesHash]),
      capabilityHash: digest([kind, id, schemaHash]),
      status,
    },
  })
  if (input.trust !== "trusted" && input.trust !== "untrusted") return result("unavailable")
  if (input.use === "live" && !LIVE_REVIEW_MCP)
    return result(input.trust === "untrusted" ? "untrusted-live" : "live-disabled")
  if (input.use !== "snapshot") return result("unavailable")
  if (!owner || !repository || !server || !source) return result("missing-grant")
  if (!serverIdentity || !hash.test(endpointHash) || !hash.test(capabilitiesHash)) return result("identity-changed")
  if ((kind !== "tool" && kind !== "resource") || !id || !hash.test(schemaHash)) return result("capability-denied")

  try {
    const grants = source({ owner, repository, server }).filter(
      (candidate) => candidate.owner === owner && candidate.repository === repository && candidate.server === server,
    )
    if (!grants.length) return result("missing-grant")
    if (grants.length !== 1) return result("ambiguous-grant")
    const grant = grants[0]!
    if (
      grant.serverIdentity !== serverIdentity ||
      grant.endpointHash !== endpointHash ||
      grant.capabilitiesHash !== capabilitiesHash
    )
      return result("identity-changed")
    const selected = grant.selected.filter((entry) => entry.kind === kind && entry.id === id)
    if (selected.length !== 1 || selected[0]!.access !== "read" || selected[0]!.schemaHash !== schemaHash)
      return result("capability-denied")
    return result("granted-read")
  } catch {
    // Unavailable trusted configuration cannot authorize an action. Its error may contain connector credentials.
    return result("unavailable")
  }
}
