import { describe, expect, test } from "bun:test"
import {
  ACTIONS_COPY,
  agentHandle,
  agentListing,
  agentsView,
  brainApproval,
  runMinutes,
  type AgentsStatus,
  type BrainPreview,
} from "./agents-model"

const status = (patch: Partial<AgentsStatus> = {}): AgentsStatus => ({
  signedIn: true,
  canDispatch: true,
  workflow: "current",
  bound: "yours",
  binding: { repositoryId: "17", boundAt: 1, workflowVersion: "3", codium: "ready" },
  listed: agentListing(),
  options: {
    mode: "own-key",
    provider: "openrouter",
    model: "example",
    keys: [],
    autoReview: false,
    version: "1.99.113",
  },
  ...patch,
})

describe("GitHub agents view", () => {
  test("own-key setup and schedules stay available without any paid entitlement or listing", () => {
    const free = agentsView(status())
    expect(free).toEqual({ kind: "ready", ownKey: true, codium: false, scheduled: true, noSecret: false })
    expect(agentsView(status({ workflow: "missing" })).ownKey).toBe(true)
    expect(agentsView(undefined).ownKey).toBe(true)
  })

  test("missing listing and child flags without the parent fail closed", () => {
    expect(agentListing()).toEqual({ agents: false, scheduled: false, noSecret: false, brain: false })
    expect(agentListing({ scheduled: true, noSecret: true, brain: true })).toEqual(agentListing())
    const codium = status({ options: { ...status().options!, mode: "codium" } })
    expect(agentsView(codium)).toEqual({
      kind: "unavailable",
      ownKey: true,
      codium: false,
      scheduled: false,
      noSecret: false,
    })
    expect(agentsView({ ...codium, listed: undefined as unknown as AgentsStatus["listed"] }).codium).toBe(false)
  })

  test("every Codium surface follows its separate listing gate", () => {
    const codium = status({ options: { ...status().options!, mode: "codium" }, listed: agentListing({ agents: true }) })
    expect(agentsView(codium)).toMatchObject({ kind: "ready", codium: true, scheduled: false, noSecret: false })
    expect(agentsView({ ...codium, listed: agentListing({ agents: true, scheduled: true }) }).scheduled).toBe(true)
    expect(agentsView({ ...codium, listed: agentListing({ agents: true, noSecret: true }) }).noSecret).toBe(true)
    expect(agentListing({ agents: true, brain: true }).brain).toBe(true)
  })

  test("shows sign-in, CLI upgrade, setup and binding in authority order", () => {
    expect(agentsView(status({ signedIn: false })).kind).toBe("sign-in")
    expect(agentsView(status({ workflow: "cli-too-old" })).kind).toBe("update-cli")
    for (const workflow of ["missing", "old"] as const) expect(agentsView(status({ workflow })).kind).toBe("setup")
    expect(
      agentsView(
        status({
          options: { ...status().options!, mode: "codium" },
          listed: agentListing({ agents: true }),
          bound: "not-yours-or-unknown",
        }),
      ).kind,
    ).toBe("bind")
  })

  test("uses only the supplied handle and verified positive workflow timeout", () => {
    expect(agentHandle(status())).toBe("/vector")
    expect(agentHandle(status({ handleAvailable: "example-helper" }))).toBe("@example-helper")
    expect(runMinutes(status())).toBeUndefined()
    for (const timeoutMinutes of [0, -1, 1.2, Infinity]) expect(runMinutes(status({ timeoutMinutes }))).toBeUndefined()
    expect(runMinutes(status({ timeoutMinutes: 42 }))).toContain("42 minutes")
  })

  test("an owned Codium binding needs current availability and no suspension; own-key stays independent", () => {
    const codium = status({ options: { ...status().options!, mode: "codium" }, listed: agentListing({ agents: true }) })
    for (const binding of [
      undefined,
      { ...codium.binding!, codium: "unavailable" as const },
      { ...codium.binding!, suspended: "transferred" },
      { ...codium.binding!, suspended: "binder-left" },
    ]) {
      expect(agentsView({ ...codium, binding }).kind).toBe("unavailable")
      expect(agentsView(status({ binding })).kind).toBe("ready")
    }
    expect(agentsView(codium).kind).toBe("ready")
  })

  test("Brain approval binds the exact current repository and preview digest", () => {
    const preview: BrainPreview = {
      id: "opaque",
      repositoryId: "17",
      publicRepository: false,
      sha256: "a".repeat(64),
      bytes: 12,
      entries: 1,
      skills: 0,
      text: "bounded preview",
    }
    expect(brainApproval(preview, "17", preview.sha256)).toBe(true)
    expect(brainApproval(preview, "18", preview.sha256)).toBe(false)
    expect(brainApproval(preview, "17", "b".repeat(64))).toBe(false)
    expect(brainApproval(undefined, "17", preview.sha256)).toBe(false)
  })

  test("Actions copy names the user's repository and minutes without availability promises", () => {
    expect(ACTIONS_COPY).toBe("in your own repo, on your own Actions minutes")
    expect(ACTIONS_COPY).not.toMatch(
      /hosted|compute|cloud hours|cloud capacity|our cloud|exclusive|every PR|every pull request|guaranteed|24\/7|SLA/i,
    )
  })
})
