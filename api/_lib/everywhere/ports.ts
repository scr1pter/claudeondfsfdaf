import type { PlatformId } from "../../../packages/schema/src/everywhere.js"
import type { SwitchState } from "../../../packages/schema/src/everywhere-policy.js"
import { readConfig, sponsorListed, type EverywhereConfig } from "./config.js"
import { readEverywhereSwitch, readRemoteSwitch } from "./switch.js"
import { missingAccountAuthority, type AccountAuthorityPort } from "./authority.js"

export type Repository = { readonly id: number; readonly fullName: string; readonly shared: boolean }

/** Preparing a dispatch must perform no workflow dispatch. The job's fenced transition precedes commit. */
export type PreparedDispatch = {
  readonly ticketHash: string
  readonly commit: () => Promise<void>
  readonly cancel?: () => Promise<void>
}

export type Ports = {
  readonly accountAuthority?: AccountAuthorityPort
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
  readonly repository?: (input: {
    readonly fullName: string
    readonly account: string
    /** The immutable repository id from a previously selected mapping. */
    readonly id?: number
  }) => Promise<Repository | undefined>
  /**
   * Whether this platform's jobs may run in Actions: it is an enabled run source (R-C8/R-A8). Absent, none may. Routing
   * reads no binding or visibility for a platform that may not.
   */
  readonly cloudSource?: (platform: PlatformId) => boolean
  /** Absent until a platform is an enabled run source (R-C8/R-A8) and the workflow mode is read live (EV-30). */
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

/**
 * Every missing integration is unavailable; an account allowlist grants only the Everywhere pilot perk, and under these
 * ports it is the only grant. productionPorts (runtime.ts) replaces presence, offer and perk with the relay adapter
 * (adapters/remote.ts, EV-09) once the flag and the offer key are set; its read-only plan check joins the allowlist for
 * `everywhere` only once the laptop route is wired and the owner lists the perk. With the flag on it also replaces
 * binding and visibility with @vector's, and adds cloudSource (adapters/cloud-agents.ts, EV-29).
 */
export function safePorts(config: EverywhereConfig = readConfig()): Ports {
  return {
    accountAuthority: missingAccountAuthority,
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
