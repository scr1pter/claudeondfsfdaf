import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { SessionArchive } from "@vectordevai/core/share/archive"
import { localArchive, sanitizeLegacy } from "../../src/cli/cmd/export"
import { SubagentLifecycle } from "../../src/tool/subagent-lifecycle"

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
    privacy?: "owner-only"
    guestInput?: true
  } = {},
) {
  return Schema.decodeUnknownSync(SessionArchive.Legacy)({
    ...(input.privacy ? { privacy: input.privacy } : {}),
    ...(input.guestInput ? { guestInput: input.guestInput } : {}),
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

// Text the user, a model or a client put in a child's lifecycle record. Each value appears once in the archive, so a
// leak names its field.
const TEXT = {
  title: "Audit the payments module for the March incident",
  resultSummary: "The ledger flush races the refund writer",
  reason: "Stopped after the refund table looked corrupt",
  error: "Provider said the account for alice was suspended",
  criterionA: "Every refund row has a matching ledger row",
  criterionB: "No migration touches the invoices table",
  ownedPath: "src/payments/ledger-owned.ts",
  dependsOn: "task-depends-on-schema-audit",
  resultRef: "/home/alice/.vector/output/child-result.txt",
  batchID: "batch-for-the-refund-audit",
  notification: "Child finished: the refund writer needs a lock",
  steer: "Steer: look at the refund table before the ledger",
  sender: "sender-named-in-a-crafted-archive",
  waiting: "Asks whether it may read the production dump",
  workflowTitle: "Nightly refund reconciliation workflow",
  progress: "Stage reading the refund exports",
  schema: "The refund audit verdict for the finance team",
  forkPoint: "fork-point-from-a-crafted-archive",
  forkFrom: "fork-from-from-a-crafted-archive",
  branch: "vector/refund-audit-branch",
  merged: "src/payments/merged-refunds.ts",
  skipped: "src/payments/skipped-refunds.ts",
  conflict: "src/payments/conflicting-refunds.ts",
  isolationError: "Merge failed on the refund writer",
  stopMessage: "Paused a repeating loop: `refund_lookup` returned the same result",
  delegatedStop: "Subagent spend ceiling reached for the refund audit",
  client: "A client's note about the refund customer",
}

const BUDGET = { usd: 2, steps: 40, warnAt: 0.8, unpricedSteps: 5 }

// A child's whole lifecycle record (SubagentRecord) after a user steer, beside a client's own metadata keys.
function steered() {
  return {
    subagent: {
      kind: "subagent",
      agent: "general",
      custom: false,
      title: TEXT.title,
      parentSessionID: "ses_parent",
      parentMessageID: "msg_parent",
      callID: "call_launch",
      batchIndex: 1,
      batchID: TEXT.batchID,
      attempt: 2,
      runtimeID: "6f1c2a9e-0b7d-4c1e-9a55-3f0d2b7c8e41",
      ownedPaths: [TEXT.ownedPath],
      dependsOn: [TEXT.dependsOn],
      successCriteria: [TEXT.criterionA, TEXT.criterionB],
      resultRef: TEXT.resultRef,
      resultSummary: TEXT.resultSummary,
      reason: TEXT.reason,
      notification: {
        text: TEXT.notification,
        state: "completed",
        launchID: "launch_1",
        messageID: "msg_claim",
        claimedAt: 40,
      },
      budgetScopes: [
        {
          kind: "child",
          id: "ses_child",
          budget: BUDGET,
          spentUsd: 0.5,
          steps: 3,
          unpricedSteps: 0,
          codiumSteps: 1,
          costKind: "priced",
          stopped: { reason: "loop", message: TEXT.stopMessage },
        },
      ],
      budget: BUDGET,
      mailbox: [
        {
          id: "mail_1",
          sender: TEXT.sender,
          text: TEXT.steer,
          delivery: "steer",
          createdAt: 20,
          deliveredAt: 21,
          from: "user",
        },
      ],
      model: { providerID: "lmstudio", modelID: "test-model", variant: "high" },
      background: true,
      status: "completed",
      startedAt: 10,
      completedAt: 50,
      usage: {
        cost: 0.04,
        tokens: tokens(987654),
        total: 987686,
        toolUses: 2,
        steps: 3,
        unpricedSteps: 1,
        codiumSteps: 1,
      },
      error: TEXT.error,
      conversationID: "ses_parent",
      rootSessionID: "ses_root",
      requestID: "req_1",
      effort: "high",
      modelSource: "call",
      fork: { point: TEXT.forkPoint, callID: "call_fork", from: TEXT.forkFrom, warm: true },
      structured: {
        schema: { type: "object", description: TEXT.schema },
        schemaHash: "hash_1",
        attempts: 1,
        valid: true,
      },
      delegatedScope: {
        id: "req_1",
        budget: BUDGET,
        spentUsd: 0.25,
        steps: 2,
        unpricedSteps: 0,
        codiumSteps: 0,
        stopped: { reason: "cap", message: TEXT.delegatedStop },
      },
      owner: { pid: 4242, boot: 7 },
      interruption: { at: 30, cause: "crash", reportedAt: 31, resumedAt: 32, dismissedAt: 33 },
      waiting: { kind: "question", requestID: "que_1", since: 25, expiresAt: 60, notedAt: 26, summary: TEXT.waiting },
      stop: { by: "user", at: 45 },
      reports: { at: [35, 36], wakes: 1 },
      slotReason: "Waiting for a free subagent slot",
      isolation: {
        mode: "worktree",
        state: "changed",
        branch: TEXT.branch,
        files: 2,
        additions: 9,
        deletions: 4,
        merged: [TEXT.merged],
        skipped: [TEXT.skipped],
        conflicts: [TEXT.conflict],
        error: TEXT.isolationError,
      },
      workflow: {
        role: "run",
        title: TEXT.workflowTitle,
        revision: 3,
        quiet: false,
        progress: { stages: [{ id: "stage_1", title: TEXT.progress, done: 1 }] },
      },
    },
    parentSessionId: "ses_parent",
    note: { text: TEXT.client, count: 3 },
  }
}

const leaked = (value: unknown) => Object.values(TEXT).filter((text) => JSON.stringify(value).includes(text))

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
        title: "[redacted:subagent-title:ses_export]",
        agent: "general",
        status: "completed",
        usage: { cost: 0.04, toolUses: 2, steps: 3, codiumSteps: 1 },
      },
      usage: { tokens: 7 },
      unrelated: { label: "[redacted:session-metadata:ses_export]", usage: { tokens: 8 } },
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
      privacy: "owner-only",
      guestInput: true,
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
    const before = structuredClone(source)
    const sanitized = sanitizeLegacy(source)
    expect(sanitized).toMatchObject({ privacy: "owner-only", guestInput: true })
    expect(sanitized).not.toHaveProperty("ancillaryUsage")
    expect(JSON.stringify(sanitized)).not.toContain("987654")
    expect(source).toEqual(before)
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

describe("sanitizeLegacy lifecycle text", () => {
  test("a lifecycle record's text never reaches a sanitized export, while its status and timestamps remain", () => {
    const source = archive({ metadata: steered() })
    const before = structuredClone(source)
    const sanitized = sanitizeLegacy(source)
    expect(leaked(sanitized)).toEqual([])
    expect(JSON.stringify(sanitized)).not.toContain("987654")
    expect(JSON.stringify(sanitized)).not.toContain("987686")
    expect(sanitized.info.metadata).toEqual({
      subagent: {
        kind: "subagent",
        agent: "general",
        custom: false,
        title: "[redacted:subagent-title:ses_export]",
        parentSessionID: "ses_parent",
        parentMessageID: "msg_parent",
        callID: "call_launch",
        batchIndex: 1,
        batchID: "[redacted:subagent-batch:ses_export]",
        attempt: 2,
        runtimeID: "6f1c2a9e-0b7d-4c1e-9a55-3f0d2b7c8e41",
        ownedPaths: ["[redacted:subagent-owned-path:ses_export-0]"],
        dependsOn: ["[redacted:subagent-depends-on:ses_export-0]"],
        successCriteria: [
          "[redacted:subagent-success-criterion:ses_export-0]",
          "[redacted:subagent-success-criterion:ses_export-1]",
        ],
        resultRef: "[redacted:subagent-result-ref:ses_export]",
        resultSummary: "[redacted:subagent-result-summary:ses_export]",
        reason: "[redacted:subagent-reason:ses_export]",
        notification: {
          text: "[redacted:subagent-notification:ses_export]",
          state: "completed",
          launchID: "launch_1",
          messageID: "msg_claim",
          claimedAt: 40,
        },
        budgetScopes: [
          {
            kind: "child",
            id: "ses_child",
            budget: BUDGET,
            spentUsd: 0.5,
            steps: 3,
            unpricedSteps: 0,
            codiumSteps: 1,
            costKind: "priced",
            stopped: { reason: "loop", message: "[redacted:subagent-stop-message:ses_export-0]" },
          },
        ],
        budget: BUDGET,
        mailbox: [
          {
            id: "mail_1",
            sender: "[redacted:subagent-mailbox-sender:ses_export-0]",
            text: "[redacted:subagent-mailbox-text:ses_export-0]",
            delivery: "steer",
            createdAt: 20,
            deliveredAt: 21,
            from: "user",
          },
        ],
        model: { providerID: "lmstudio", modelID: "test-model", variant: "high" },
        background: true,
        status: "completed",
        startedAt: 10,
        completedAt: 50,
        usage: { cost: 0.04, toolUses: 2, steps: 3, unpricedSteps: 1, codiumSteps: 1 },
        error: "[redacted:subagent-error:ses_export]",
        conversationID: "ses_parent",
        rootSessionID: "ses_root",
        requestID: "req_1",
        effort: "high",
        modelSource: "call",
        fork: {
          point: "[redacted:subagent-fork-point:ses_export]",
          callID: "call_fork",
          from: "[redacted:subagent-fork-from:ses_export]",
          warm: true,
        },
        structured: {
          schema: { redacted: "subagent-structured-schema:ses_export" },
          schemaHash: "hash_1",
          attempts: 1,
          valid: true,
        },
        delegatedScope: {
          id: "req_1",
          budget: BUDGET,
          spentUsd: 0.25,
          steps: 2,
          unpricedSteps: 0,
          codiumSteps: 0,
          stopped: { reason: "cap", message: "[redacted:subagent-stop-message:ses_export]" },
        },
        owner: { pid: 4242, boot: 7 },
        interruption: { at: 30, cause: "crash", reportedAt: 31, resumedAt: 32, dismissedAt: 33 },
        waiting: {
          kind: "question",
          requestID: "que_1",
          since: 25,
          expiresAt: 60,
          notedAt: 26,
          summary: "[redacted:subagent-waiting-summary:ses_export]",
        },
        stop: { by: "user", at: 45 },
        reports: { at: [35, 36], wakes: 1 },
        slotReason: "Waiting for a free subagent slot",
        isolation: {
          mode: "worktree",
          state: "changed",
          branch: "[redacted:subagent-isolation-branch:ses_export]",
          files: 2,
          additions: 9,
          deletions: 4,
          merged: ["[redacted:subagent-isolation-merged:ses_export-0]"],
          skipped: ["[redacted:subagent-isolation-skipped:ses_export-0]"],
          conflicts: ["[redacted:subagent-isolation-conflict:ses_export-0]"],
          error: "[redacted:subagent-isolation-error:ses_export]",
        },
        workflow: {
          role: "run",
          title: "[redacted:subagent-workflow-title:ses_export]",
          revision: 3,
          quiet: false,
          progress: { redacted: "subagent-workflow-progress:ses_export" },
        },
      },
      parentSessionId: "[redacted:session-metadata:ses_export]",
      note: { text: "[redacted:session-metadata:ses_export]", count: 3 },
    })
    // Each field keeps its type, so the record still reads as a lifecycle record after an import.
    expect(SubagentLifecycle.read({ metadata: sanitized.info.metadata })).toMatchObject({
      status: "completed",
      startedAt: 10,
      completedAt: 50,
      mailbox: [{ delivery: "steer", createdAt: 20 }],
      notification: { state: "completed", launchID: "launch_1" },
      structured: { schemaHash: "hash_1", attempts: 1 },
      waiting: { kind: "question", since: 25 },
      workflow: { role: "run", revision: 3 },
    })
    expect(source).toEqual(before)
  })

  test("a workflow agent's stage, phase, item, key and node are redacted", () => {
    const text = [
      "Stage for the refund agent",
      "Phase for the refund agent",
      "Item for the refund agent",
      "key-for-the-refund-agent",
      "Node for the refund agent",
    ]
    const sanitized = sanitizeLegacy(
      archive({
        metadata: {
          subagent: {
            ...steered().subagent,
            workflow: {
              role: "agent",
              runID: "wfr_1",
              stage: text[0],
              phase: text[1],
              item: text[2],
              key: text[3],
              node: text[4],
              round: 2,
              verifier: true,
              final: false,
              verified: true,
              output: "structured",
            },
          },
        },
      }),
    )
    expect(text.filter((value) => JSON.stringify(sanitized).includes(value))).toEqual([])
    expect(sanitized.info.metadata).toMatchObject({
      subagent: {
        workflow: {
          role: "agent",
          runID: "wfr_1",
          stage: "[redacted:subagent-workflow-stage:ses_export]",
          phase: "[redacted:subagent-workflow-phase:ses_export]",
          item: "[redacted:subagent-workflow-item:ses_export]",
          key: "[redacted:subagent-workflow-key:ses_export]",
          node: "[redacted:subagent-workflow-node:ses_export]",
          round: 2,
          verifier: true,
          final: false,
          verified: true,
          output: "structured",
        },
      },
    })
  })

  test("fields the allow-list does not name are redacted, whether a newer version, an older one or a client wrote them", () => {
    const record = steered().subagent
    const text = [
      "A newer version's note about the refund",
      "A newer version's object label",
      "An extra notification string",
      "A model note a client added",
      "/home/alice/.vector/worktrees/refund",
    ]
    const sanitized = sanitizeLegacy(
      archive({
        metadata: {
          subagent: {
            ...record,
            futureNote: text[0],
            futureObject: { label: text[1], n: 1 },
            futureCount: 5,
            notification: { ...record.notification, extra: text[2] },
            model: { ...record.model, note: text[3] },
            // A record written before I19 can still hold the isolation's absolute directory.
            isolation: { ...record.isolation, directory: text[4] },
          },
        },
      }),
    )
    expect(text.filter((value) => JSON.stringify(sanitized).includes(value))).toEqual([])
    expect(sanitized.info.metadata).toMatchObject({
      subagent: {
        futureNote: "[redacted:subagent-field:ses_export]",
        futureObject: { redacted: "subagent-field:ses_export" },
        // The allow-list redacts text. A number under an unnamed key stays; taskMetadata guards token figures (F43).
        futureCount: 5,
        notification: { extra: "[redacted:subagent-field:ses_export]", state: "completed" },
        model: { note: "[redacted:subagent-field:ses_export]", modelID: "test-model" },
        isolation: { directory: "[redacted:subagent-field:ses_export]", mode: "worktree", files: 2 },
      },
    })
  })

  test("an object or list under a kept field is redacted, since only a crafted archive holds one there", () => {
    const record = steered().subagent
    const text = [
      "A note a crafted archive hid under status",
      "A label a crafted archive hid under slotReason",
      "A string a crafted archive listed under callID",
      "A note a crafted archive hid under the isolation mode",
      "A note a crafted archive listed among the report times",
    ]
    const sanitized = sanitizeLegacy(
      archive({
        metadata: {
          subagent: {
            ...record,
            status: { note: text[0] },
            slotReason: { label: text[1], count: 1 },
            callID: [text[2], 7],
            isolation: { ...record.isolation, mode: { note: text[3] } },
            reports: { at: [35, { note: text[4] }], wakes: 1 },
          },
        },
      }),
    )
    expect(text.filter((value) => JSON.stringify(sanitized).includes(value))).toEqual([])
    expect(sanitized.info.metadata).toMatchObject({
      subagent: {
        status: { redacted: "subagent-field:ses_export" },
        slotReason: { redacted: "subagent-field:ses_export" },
        callID: ["[redacted:subagent-field:ses_export-0]", 7],
        isolation: { mode: { redacted: "subagent-field:ses_export" }, state: "changed", files: 2 },
        // A list of numbers under a kept field, the engine's own shape for reports.at, keeps its numbers.
        reports: { at: [35, { redacted: "subagent-field:ses_export-1" }], wakes: 1 },
        startedAt: 10,
      },
    })
  })

  test("a session's own metadata loses its strings and keeps its numbers without a lifecycle record", () => {
    const sanitized = sanitizeLegacy(
      archive({
        metadata: {
          note: "A client's private note",
          count: 2,
          flags: { background: true, empty: null },
          ids: ["client-private-id"],
          vector: { kind: "parallel-agent", parentSessionId: "ses_parent" },
        },
      }),
    )
    expect(sanitized.info.metadata).toEqual({
      note: "[redacted:session-metadata:ses_export]",
      count: 2,
      flags: { background: true, empty: null },
      ids: ["[redacted:session-metadata:ses_export-0]"],
      vector: {
        kind: "[redacted:session-metadata:ses_export]",
        parentSessionId: "[redacted:session-metadata:ses_export]",
      },
    })
    expect(sanitized.info.metadata).not.toHaveProperty("subagent")
  })

  test("an unsanitized export keeps the lifecycle text", () => {
    // run() prints localArchive's result for a legacy session, so without --sanitize it prints the archive as exported.
    const source = archive({ metadata: steered() })
    expect(source.info.metadata).toEqual(steered())
    expect(localArchive(source)).toBe(source)
    expect(localArchive(source, false)).toBe(source)
    expect(leaked(localArchive(source, false))).toEqual(Object.values(TEXT))
    // With --sanitize the same branch prints none of it, and the archive it read is unchanged.
    expect(leaked(localArchive(source, true))).toEqual([])
    expect(leaked(source)).toEqual(Object.values(TEXT))
  })

  test("the portable archive carries no session metadata", () => {
    const native = Schema.decodeUnknownSync(SessionArchive.Native)({
      format: "vector-session",
      version: 1,
      engine: "v2",
      info: {
        id: "ses_native",
        projectID: "project_export",
        title: "Native session title",
        cost: 0,
        tokens: tokens(1),
        time: { created: 1, updated: 2 },
        location: { directory: "/private/repo" },
        metadata: steered(),
      },
      messages: [],
    })
    // A native session has no metadata field, so a native archive cannot carry one.
    expect("metadata" in native.info).toBe(false)
    const portable = [
      SessionArchive.publicArchive(archive({ metadata: steered() })),
      SessionArchive.publicArchive(native),
    ]
    expect(portable.map((value) => Object.keys(value).sort())).toEqual([
      ["engine", "messages", "title", "version"],
      ["engine", "messages", "title", "version"],
    ])
    expect(leaked(portable)).toEqual([])
  })
})

// F44b: the pass-throughs a sanitized export used to keep. Each private value appears once, so a leak names its field,
// and the sanitized archive must still decode as an archive.
describe("sanitized export pass-throughs (F44b)", () => {
  const PRIVATE = {
    toolError: "ENOENT: /home/alice/secret-plan.md",
    retryMessage: "Rate limited for org alice-private",
    retryBody: "error: key sk-private-123 over quota",
    retryHeader: "x-request-id private-header-value",
    assistantMessage: "Provider rejected the prompt about the merger",
    assistantBody: "detail: merger memo text",
    structured: "The answer names the acquisition target",
    formatSchema: "acquisitionTarget",
    sessionPath: "/home/alice/projects/merger",
    permissionPattern: "/home/alice/projects/merger/**",
    shareURL: "https://share.example.test/private-share",
  }
  const user = {
    info: {
      id: "msg_user",
      sessionID: "ses_export",
      role: "user",
      time: { created: 1 },
      agent: "build",
      model: { providerID: "lmstudio", modelID: "test-model" },
      format: {
        type: "json_schema",
        schema: { type: "object", properties: { [PRIVATE.formatSchema]: { type: "string" } } },
        retryCount: 2,
      },
    },
    parts: [],
  }
  const assistant = (() => {
    const base = message("msg_failed", "lmstudio")
    return {
      info: {
        ...base.info,
        error: {
          name: "APIError",
          data: {
            message: PRIVATE.assistantMessage,
            statusCode: 400,
            isRetryable: false,
            responseBody: PRIVATE.assistantBody,
          },
        },
        structured: { answer: PRIVATE.structured },
      },
      parts: [
        ...base.parts,
        {
          id: "prt_tool_error",
          messageID: "msg_failed",
          sessionID: "ses_export",
          type: "tool",
          callID: "call_1",
          tool: "read",
          state: { status: "error", input: {}, error: PRIVATE.toolError, time: { start: 1, end: 2 } },
        },
        {
          id: "prt_retry",
          messageID: "msg_failed",
          sessionID: "ses_export",
          type: "retry",
          attempt: 1,
          error: {
            name: "APIError",
            data: {
              message: PRIVATE.retryMessage,
              statusCode: 429,
              isRetryable: true,
              responseBody: PRIVATE.retryBody,
              responseHeaders: { "x-request-id": PRIVATE.retryHeader },
            },
          },
          time: { created: 1 },
        },
        {
          id: "prt_compaction",
          messageID: "msg_failed",
          sessionID: "ses_export",
          type: "compaction",
          auto: true,
          tail_start_id: "msg_user",
        },
      ],
    }
  })()
  const source = () => {
    const base = archive({ messages: [user, assistant] })
    return Schema.decodeUnknownSync(SessionArchive.Legacy)({
      ...Schema.encodeSync(SessionArchive.Legacy)(base),
      info: {
        ...Schema.encodeSync(SessionArchive.Legacy)(base).info,
        workspaceID: "wrk_private",
        path: PRIVATE.sessionPath,
        share: { url: PRIVATE.shareURL },
        permission: [{ permission: "edit", pattern: PRIVATE.permissionPattern, action: "allow" }],
      },
    })
  }
  const present = (value: unknown) => {
    const text = JSON.stringify(value)
    return Object.entries(PRIVATE)
      .filter((entry) => text.includes(entry[1]))
      .map((entry) => entry[0])
  }

  test("the source archive holds every private value, so the checks below can see a leak", () => {
    expect(present(source())).toEqual(Object.keys(PRIVATE))
    expect(String(source().info.workspaceID)).toBe("wrk_private")
  })

  test("a sanitized export redacts each of them and still decodes as an archive", () => {
    const sanitized = sanitizeLegacy(source())
    expect(present(sanitized)).toEqual([])
    const decoded = Schema.decodeUnknownSync(SessionArchive.Legacy)(JSON.parse(JSON.stringify(sanitized)))
    expect(decoded.info.share).toBeUndefined()
    expect(decoded.info.workspaceID).toBeUndefined()
    expect(decoded.info.path).toBe("[redacted:session-path:ses_export]")
    expect(decoded.info.permission).toEqual([
      { permission: "edit", pattern: "[redacted:permission-pattern:ses_export-0]", action: "allow" },
    ])
    const [userMessage, assistantMessage] = decoded.messages
    expect(userMessage?.info.role === "user" && userMessage.info.format).toMatchObject({
      type: "json_schema",
      schema: { redacted: "format-schema:msg_user" },
    })
    if (assistantMessage?.info.role !== "assistant") throw new Error("expected the assistant message")
    expect(assistantMessage.info.error).toEqual({
      name: "APIError",
      data: {
        message: "[redacted:error-message:msg_failed]",
        statusCode: 400,
        isRetryable: false,
        responseBody: "[redacted:error-responseBody:msg_failed]",
      },
    })
    expect(assistantMessage.info.structured).toEqual({ redacted: "structured:msg_failed" })
    const parts = Object.fromEntries(assistantMessage.parts.map((part) => [part.id, part]))
    expect(parts.prt_tool_error).toMatchObject({
      state: { status: "error", error: "[redacted:tool-error:prt_tool_error]" },
    })
    expect(parts.prt_retry).toMatchObject({
      attempt: 1,
      error: {
        name: "APIError",
        data: {
          statusCode: 429,
          isRetryable: true,
          message: "[redacted:error-message:prt_retry]",
          responseBody: "[redacted:error-responseBody:prt_retry]",
          responseHeaders: { redacted: "error-responseHeaders:prt_retry" },
        },
      },
    })
    // An unnamed kind keeps only its identity, kind and non-text fields.
    expect(JSON.parse(JSON.stringify(parts.prt_compaction))).toEqual({
      id: "prt_compaction",
      messageID: "msg_failed",
      sessionID: "ses_export",
      type: "compaction",
      auto: true,
      tail_start_id: "msg_user",
    })
  })
})
