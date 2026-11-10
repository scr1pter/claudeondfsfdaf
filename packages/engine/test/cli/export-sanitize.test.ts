import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { SessionArchive } from "@vectordevai/core/share/archive"
import { sanitizeLegacy } from "../../src/cli/cmd/export"

const tokens = (input: number) => ({ input, output: 20, reasoning: 3, cache: { read: 4, write: 5 } })

function message(id: string, providerID: string, billing?: "codium") {
  const codium = billing === "codium" || providerID === "vector-plan"
  return {
    info: {
      id,
      sessionID: "ses_export",
      role: "assistant",
      parentID: "msg_user",
      modelID: "test-model",
      providerID,
      ...(billing ? { billing } : {}),
      mode: "build",
      agent: "build",
      time: { created: 1, completed: 2 },
      path: { cwd: "/private/repo", root: "/private/repo" },
      cost: codium ? 0 : 0.12,
      tokens: tokens(codium ? 987654 : 123),
      finish: "stop",
    },
    parts: [
      {
        id: `prt_${id}_step`,
        messageID: id,
        sessionID: "ses_export",
        type: "step-finish",
        reason: "stop",
        cost: codium ? 0 : 0.12,
        tokens: tokens(codium ? 987654 : 123),
        ...(billing ? { billing } : {}),
      },
      {
        id: `prt_${id}_text`,
        messageID: id,
        sessionID: "ses_export",
        type: "text",
        text: "Private source text",
      },
    ],
  }
}

function archive(
  input: {
    tokensOwnOnly?: boolean
    codiumSteps?: number
    messages?: unknown[]
    metadata?: Record<string, unknown>
    ancillaryUsage?: unknown[]
  } = {},
) {
  return Schema.decodeUnknownSync(SessionArchive.Legacy)({
    info: {
      id: "ses_export",
      slug: "export",
      projectID: "project_export",
      directory: "/private/repo",
      title: "Private session title",
      version: "test",
      time: { created: 1, updated: 2 },
      ...(input.tokensOwnOnly === undefined
        ? {}
        : { tokensOwnOnly: input.tokensOwnOnly, subagentTokensOwnOnly: input.tokensOwnOnly }),
      tokens: tokens(123),
      subagentTokens: tokens(45),
      cost: 0.12,
      subagentCost: 0.04,
      ...(input.codiumSteps === undefined ? {} : { codiumSteps: input.codiumSteps, subagentCodiumSteps: 0 }),
      ...(input.metadata === undefined ? {} : { metadata: input.metadata }),
    },
    messages: input.messages ?? [message("msg_codium", "vector-plan", "codium"), message("msg_own", "lmstudio")],
    ...(input.ancillaryUsage === undefined ? {} : { ancillaryUsage: input.ancillaryUsage }),
  })
}

// A child session's lifecycle record, as SubagentLifecycle.settle writes it: the session totals copied at completion.
function lifecycle(proof: { tokensOwnOnly?: boolean }) {
  return {
    subagent: {
      title: "child",
      agent: "general",
      status: "completed",
      usage: { cost: 0.04, tokens: tokens(987654), total: 987686, toolUses: 2, steps: 3, codiumSteps: 1, ...proof },
    },
    // Keys outside the lifecycle record are the caller's own metadata, not Vector's accounting.
    usage: { tokens: 7 },
    unrelated: { label: "kept", usage: { tokens: 8 } },
  }
}

describe("sanitizeLegacy Codium usage", () => {
  test("current mixed archives keep partitioned own totals and omit Codium message and step tokens", () => {
    const source = archive({ codiumSteps: 1, tokensOwnOnly: true })
    const sanitized = sanitizeLegacy(source)
    expect(sanitized.info).toMatchObject({
      cost: 0.12,
      subagentCost: 0.04,
      tokensOwnOnly: true,
      subagentTokensOwnOnly: true,
      tokens: tokens(123),
      subagentTokens: tokens(45),
      codiumSteps: 1,
    })
    expect(sanitized.messages[0]?.info).toMatchObject({ billing: "codium" })
    expect(sanitized.messages[0]?.info).not.toHaveProperty("tokens")
    expect(sanitized.messages[0]?.parts[0]).toMatchObject({ type: "step-finish", billing: "codium" })
    expect(sanitized.messages[0]?.parts[0]).not.toHaveProperty("tokens")
    expect(sanitized.messages[1]?.info).toMatchObject({ cost: 0.12, tokens: tokens(123) })
    expect(sanitized.messages[1]?.parts[0]).toMatchObject({ cost: 0.12, tokens: tokens(123) })
    expect(JSON.stringify(sanitized)).not.toContain("987654")
  })

  test.each([undefined, 0])("old archives with Codium counter %s drop inseparable aggregate tokens", (codiumSteps) => {
    const source = archive({
      codiumSteps,
      // Older messages have only the provider identity, not the newer billing marker.
      messages: [message("msg_codium", "vector-plan"), message("msg_own", "lmstudio")],
    })
    const sanitized = sanitizeLegacy(source)
    expect(sanitized.info).not.toHaveProperty("tokens")
    expect(sanitized.info).not.toHaveProperty("subagentTokens")
    expect(sanitized.info).toMatchObject({ cost: 0.12, subagentCost: 0.04 })
    expect(sanitized.messages[0]?.info).toMatchObject({ billing: "codium" })
    expect(sanitized.messages[0]?.info).not.toHaveProperty("tokens")
    expect(sanitized.messages[0]?.parts[0]).not.toHaveProperty("tokens")
    expect(sanitized.messages[1]?.info).toMatchObject({ cost: 0.12, tokens: tokens(123) })
  })

  test("an explicitly billed Codium step masks old mixed message totals while retaining its own steps", () => {
    const mixed = message("msg_mixed", "lmstudio")
    const source = archive({
      codiumSteps: 0,
      messages: [
        {
          ...mixed,
          info: { ...mixed.info, tokens: tokens(987777) },
          parts: [
            ...mixed.parts,
            {
              ...message("msg_mixed", "vector-plan", "codium").parts[0],
              id: "prt_mixed_codium",
            },
          ],
        },
      ],
    })
    const sanitized = sanitizeLegacy(source)
    expect(sanitized.info).not.toHaveProperty("tokens")
    expect(sanitized.info).not.toHaveProperty("subagentTokens")
    expect(sanitized.messages[0]?.info).toMatchObject({ billing: "codium", cost: 0.12 })
    expect(sanitized.messages[0]?.info).not.toHaveProperty("tokens")
    expect(sanitized.messages[0]?.parts[0]).toMatchObject({ cost: 0.12, tokens: tokens(123) })
    expect(sanitized.messages[0]?.parts[2]).toMatchObject({ billing: "codium" })
    expect(sanitized.messages[0]?.parts[2]).not.toHaveProperty("tokens")
    expect(JSON.stringify(sanitized)).not.toContain("987777")
    expect(JSON.stringify(sanitized)).not.toContain("987654")
  })

  test("own-only archives keep their measurements without inventing a Codium marker", () => {
    const sanitized = sanitizeLegacy(archive({ tokensOwnOnly: true, messages: [message("msg_own", "lmstudio")] }))
    expect(sanitized.info).toMatchObject({ cost: 0.12, tokens: tokens(123), subagentTokens: tokens(45) })
    expect(sanitized.messages[0]?.info).toMatchObject({ cost: 0.12, tokens: tokens(123) })
    expect(sanitized.messages[0]?.info).not.toHaveProperty("billing")
    expect(sanitized.messages[0]?.parts[0]).toMatchObject({ cost: 0.12, tokens: tokens(123) })
    expect(sanitized.messages[0]?.parts[0]).not.toHaveProperty("billing")
  })

  test("sanitizing leaves the source archive and its private receipt measurements unchanged", () => {
    const source = archive()
    const before = structuredClone(source)
    const sanitized = sanitizeLegacy(source)
    expect(source).toEqual(before)
    expect(source.messages[0]?.info).toMatchObject({ tokens: tokens(987654) })
    expect(source.messages[0]?.parts[0]).toMatchObject({ tokens: tokens(987654) })
    expect(sanitized.info.title).not.toBe(source.info.title)
    expect(sanitized.info.directory).not.toBe(source.info.directory)
    expect(JSON.stringify(sanitized)).not.toContain("Private source text")
    expect(JSON.stringify(sanitized)).not.toContain("/private/repo")
  })

  test.each([
    ["a forged true proof on a proven session", { tokensOwnOnly: true }, true, tokens(123)],
    ["a forged true proof on an unproven session", { tokensOwnOnly: true }, false, undefined],
    ["an unproven record holding flagless Codium tokens", { tokensOwnOnly: false }, false, undefined],
    ["a record written before the proof existed", {}, false, undefined],
  ])("a lifecycle record's aggregate tokens never reach a sanitized export: %s", (_, proof, sessionProof, expected) => {
    const source = archive({ tokensOwnOnly: sessionProof, metadata: lifecycle(proof) })
    const before = structuredClone(source)
    const sanitized = sanitizeLegacy(source)
    expect(sanitized.info.metadata).toEqual({
      subagent: {
        title: "child",
        agent: "general",
        status: "completed",
        usage: { cost: 0.04, toolUses: 2, steps: 3, codiumSteps: 1 },
      },
      usage: { tokens: 7 },
      unrelated: { label: "kept", usage: { tokens: 8 } },
    })
    expect(JSON.stringify(sanitized)).not.toContain("987654")
    expect(JSON.stringify(sanitized)).not.toContain("987686")
    expect(JSON.stringify(sanitized.info.metadata)).not.toContain("tokensOwnOnly")
    expect(source).toEqual(before)
    // Only the session's own proof keeps its aggregate.
    expect(sanitized.info.tokens).toEqual(expected)
  })

  test("a session without metadata gains no metadata key", () => {
    expect("metadata" in sanitizeLegacy(archive()).info).toBe(false)
  })

  test("ancillary usage stays out, so Codium title and memory tokens never reach a sanitized export", () => {
    const source = archive({
      ancillaryUsage: [
        {
          timestamp: 1,
          sessionID: "ses_export",
          usageID: "evt_export_title",
          purpose: "title",
          model: { id: "deepseek", providerID: "vector-plan" },
          unpriced: true,
          billing: "codium",
          tokens: tokens(987654),
        },
      ],
    })
    expect(source.ancillaryUsage).toHaveLength(1)
    const sanitized = sanitizeLegacy(source)
    expect(Object.keys(sanitized)).toEqual(["info", "messages"])
    expect(JSON.stringify(sanitized)).not.toContain("987654")
  })
})

test("unknown proof and missing message identity omit figures without inventing Codium", () => {
  const raw = archive({ messages: [message("msg_missing", "  "), message("msg_own", "own")] })
  const before = JSON.stringify(raw)
  const output = sanitizeLegacy(raw)
  expect(output.info).not.toHaveProperty("tokens")
  expect(output.info).not.toHaveProperty("subagentTokens")
  expect(output.info.cost).toBe(0.12)
  expect(output.messages[0]?.info).not.toHaveProperty("tokens")
  expect(output.messages[0]?.info).not.toHaveProperty("billing")
  expect(output.messages[0]?.parts[0]).not.toHaveProperty("tokens")
  expect(output.messages[1]?.info).toHaveProperty("tokens")
  expect(JSON.stringify(raw)).toBe(before)
})
