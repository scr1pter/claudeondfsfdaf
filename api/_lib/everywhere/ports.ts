import type { PlatformId } from "../../../packages/schema/src/everywhere.js"
import type { SwitchState } from "../../../packages/schema/src/everywhere-policy.js"
import { readConfig, sponsorListed, type EverywhereConfig } from "./config.js"
import { readEverywhereSwitch, readRemoteSwitch } from "./switch.js"

export type Repository = { readonly id: number; readonly fullName: string; readonly shared: boolean }

/** Preparing a dispatch must perform no workflow dispatch. The job's fenced transition precedes commit. */
export type PreparedDispatch = {
  readonly ticketHash: string
  readonly commit: () => Promise<void>
  readonly cancel?: () => Promise<void>
}

export type Ports = {
  readonly presence: (account: string) => Promise<{
    readonly online: boolean
    readonly computers: number
    readonly reason?: "remote-off" | "not-configured" | "not-in-plan" | "unreachable"
  }>
  readonly offer: (account: string, offer: string) => Promise<"sent" | "unavailable">
  readonly binding: (repositoryId: number) => Promise<{
    readonly account: string
    readonly appInstalled: boolean
    readonly codiumMode?: boolean
  } | undefined>
  readonly visibility?: (repositoryId: number) => Promise<"public" | "private" | "internal" | undefined>
  readonly repository?: (fullName: string) => Promise<Repository | undefined>
  /** Absent until the run body goes by reference and the binding records its workflow mode. */
  readonly prepareCloud?: (input: {
    readonly jid: string
    readonly source: Exclude<PlatformId, "github">
    readonly sponsor: string
    readonly requestedBy: { readonly platform: string; readonly userId: string }
    readonly repositoryId: number
    readonly bodyReference: string
  }) => Promise<PreparedDispatch | undefined>
  readonly github?: {
    comment(repositoryId: number, issue: number, body: string): Promise<{ id: number }>
    editComment(repositoryId: number, id: number, body: string): Promise<void>
    openDraftPr(input: {
      repositoryId: number
      head: string
      base: string
      title: string
      body: string
    }): Promise<{ url: string }>
  }
  readonly perk: (account: string, perk: "everywhere" | "remote") => Promise<boolean>
  readonly switch: (name: "everywhere" | "remote") => Promise<SwitchState>
}

/** Every missing integration is unavailable; an account allowlist grants only the Everywhere pilot perk. */
export function safePorts(config: EverywhereConfig = readConfig()): Ports {
  return {
    presence: async () => ({ online: false, computers: 0, reason: "not-configured" }),
    offer: async () => "unavailable",
    binding: async () => undefined,
    perk: async (account, perk) => perk === "everywhere" && sponsorListed(config, account),
    switch: (name) => name === "everywhere" ? readEverywhereSwitch(config) : readRemoteSwitch(),
  }
}

export type CloudEvents = {
  onStart(listener: (ticketHash: string, rid: string) => Promise<void>): void
  onSettle(listener: (rid: string, end: { outcome: string; prUrl?: string; runUrl?: string }) => Promise<void>): void
}
