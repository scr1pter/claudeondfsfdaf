import { describe, expect, test } from "bun:test"
import type { MemoryBootstrap, MemoryDistillResult, MemorySettings } from "@vectordevai/sdk/v2/client"
import type { ModelPlanStatus } from "@vectordevai/core/model-plan-status"
import {
  askBrainConsent,
  boundedBootstrap,
  brainConsentKey,
  brainControls,
  brainAccessible,
  brainOffered,
  runBrainBootstrap,
  saveBrainConsent,
} from "./memory-brain-model"
import { distillEstimateLabel } from "./memory-documents-model"

function settings(patch: Partial<MemorySettings> = {}): MemorySettings {
  return {
    learning: true,
    repositoryDocs: true,
    keepOriginals: false,
    facets: { format: true, workflow: true, vocabulary: true, tooling: true, sources: true, style: true },
    modelLearner: "local-only",
    skills: "review",
    skillDrafter: "local-only",
    workflow: "apply",
    workflowExplore: false,
    codiumHelpers: "ask",
    distillation: false,
    ...patch,
  }
}
const subscribed: Pick<ModelPlanStatus.Status, "signedIn" | "access" | "plan" | "error" | "listed"> = {
  signedIn: true,
  access: true,
  listed: ["brain"],
  plan: { id: "vector-50", name: "Pro", renewsAt: 1900000000000, cancelAtPeriodEnd: false },
}
function preview(): MemoryBootstrap {
  return {
    type: "ready",
    queued: 4,
    pending: 1,
    maxTokens: 7500,
    documents: [
      {
        id: "first",
        title: "README",
        estimate: { enabled: true, sections: 2, model: "local/test", costKind: "free", input: 500, output: 4000 },
      },
      {
        id: "held",
        title: "Held",
        estimate: { enabled: true, sections: 0, refused: { reason: "held", message: "Needs your review." } },
      },
      { id: "empty", title: "Already covered", estimate: { enabled: true, sections: 0, model: "local/test" } },
      {
        id: "second",
        title: "Architecture",
        estimate: { enabled: true, sections: 3, model: "vector-plan/actual-floor", costKind: "codium" },
      },
    ],
  }
}
function result(model: string): MemoryDistillResult {
  return {
    model,
    sessionID: "hidden-helper",
    records: [],
    duplicate: 0,
    dropped: { quote: 0, scan: 0, invalid: 0 },
    costKind: "free",
  }
}

describe("Brain consent", () => {
  test("old engines hide the controls and subscription alone grants no consent", () => {
    const old = settings({ codiumHelpers: undefined })
    expect(brainControls(old)).toBe(false)
    expect(askBrainConsent({ settings: old, status: subscribed, presented: false })).toBe(false)
    const current = Object.freeze(settings())
    expect(askBrainConsent({ settings: current, status: subscribed, presented: false })).toBe(true)
    expect(current.codiumHelpers).toBe("ask")
    for (const choice of ["on", "off"] as const)
      expect(
        askBrainConsent({ settings: settings({ codiumHelpers: choice }), status: subscribed, presented: false }),
      ).toBe(false)
  })

  test("asks only with confirmed access and a plan, and remembers presentation by account and engine", () => {
    for (const status of [
      undefined,
      { ...subscribed, access: false },
      { ...subscribed, plan: undefined },
      { ...subscribed, error: "unavailable" },
    ])
      expect(askBrainConsent({ settings: settings(), status, presented: false })).toBe(false)
    const key = brainConsentKey("local", " OWNER@example.test ")
    const saved = JSON.parse(JSON.stringify({ [key]: true })) as Record<string, boolean>
    expect(
      askBrainConsent({
        settings: settings(),
        status: subscribed,
        presented: saved[brainConsentKey("local", "owner@example.test")] === true,
      }),
    ).toBe(false)
    expect(brainConsentKey("other-engine", "owner@example.test")).not.toBe(key)
    expect(brainConsentKey("local", "someone@example.test")).not.toBe(key)
    expect(settings().codiumHelpers).toBe("ask")
  })

  test("Codium controls and prompts require the listed Brain capability without gating own-model settings", () => {
    for (const status of [
      undefined,
      { ...subscribed, listed: undefined },
      { ...subscribed, listed: [] },
      { ...subscribed, listed: ["vault"] as ModelPlanStatus.Status["listed"] },
      { ...subscribed, error: "unavailable" },
      { ...subscribed, signedIn: false },
    ]) {
      expect(brainOffered(status)).toBe(false)
      expect(askBrainConsent({ settings: settings(), status, presented: false })).toBe(false)
    }
    expect(brainOffered(subscribed)).toBe(true)
    expect(brainAccessible(subscribed)).toBe(true)
    expect(brainOffered({ ...subscribed, access: false })).toBe(true)
    expect(brainAccessible({ ...subscribed, access: false })).toBe(false)
    expect(brainControls(settings({ distillation: true }))).toBe(true)
  })

  test("an explicit answer persists only the matching owner setting after checking current capability", async () => {
    const writes: unknown[] = []
    let authoritative = settings()
    const ports = {
      current: () => true,
      available: async () => true,
      read: async () => ({ data: authoritative }),
      write: async (change: { codiumHelpers: "on" | "off" }) => {
        writes.push(change)
        authoritative = { ...authoritative, ...change }
        return { data: authoritative }
      },
    }
    expect((await saveBrainConsent("on", ports)).state).toBe("saved")
    expect(writes).toEqual([{ codiumHelpers: "on" }])
    expect(authoritative.distillation).toBe(false)
    expect(authoritative.skillDrafter).toBe("local-only")
    expect((await saveBrainConsent("off", ports)).state).toBe("saved")
    expect(authoritative.codiumHelpers).toBe("off")
    expect(
      (await saveBrainConsent("on", { ...ports, read: async () => ({ data: settings({ codiumHelpers: undefined }) }) }))
        .state,
    ).toBe("unavailable")
    expect(writes).toHaveLength(2)
  })

  test("failed saves can be retried and stale account/engine reads never authorize a write", async () => {
    let writes = 0,
      current = true
    const ports = {
      current: () => current,
      available: async () => true,
      read: async () => ({ data: settings() }),
      write: async () => {
        writes++
        return { error: "temporary" }
      },
    }
    expect((await saveBrainConsent("on", ports)).state).toBe("failed")
    expect((await saveBrainConsent("on", ports)).state).toBe("failed")
    expect(writes).toBe(2)
    expect(
      (
        await saveBrainConsent("on", {
          ...ports,
          read: async () => {
            current = false
            return { data: settings() }
          },
        })
      ).state,
    ).toBe("changed")
    expect(writes).toBe(2)
    current = true
    expect(
      (await saveBrainConsent("off", { ...ports, write: async () => ({ data: settings({ codiumHelpers: "on" }) }) }))
        .state,
    ).toBe("failed")
  })

  test("a fresh listing refusal blocks enabling while an explicit Off still saves", async () => {
    let writes = 0
    const ports = {
      current: () => true,
      available: async () => brainAccessible({ ...subscribed, listed: [] }),
      read: async () => ({ data: settings() }),
      write: async (change: { codiumHelpers: "on" | "off" }) => {
        writes++
        return { data: settings(change) }
      },
    }
    expect((await saveBrainConsent("on", ports)).state).toBe("unavailable")
    expect(writes).toBe(0)
    expect((await saveBrainConsent("off", ports)).state).toBe("saved")
    expect(writes).toBe(1)
  })
})

describe("confirmed Bootstrap preview", () => {
  test("runs only eligible documents sequentially with the exact previewed model and bound", async () => {
    const requests: unknown[] = [],
      returned: string[] = []
    let active = 0,
      maximum = 0
    const outcome = await runBrainBootstrap(preview(), {
      current: () => true,
      send: async (request) => {
        active++
        maximum = Math.max(maximum, active)
        requests.push(request)
        await Promise.resolve()
        active--
        return { data: result(request.model) }
      },
      result: (title) => returned.push(title),
    })
    expect(outcome).toEqual({ completed: 2, state: "done" })
    expect(maximum).toBe(1)
    expect(requests).toEqual([
      { documentID: "first", model: "local/test", maxTokens: 7500 },
      { documentID: "second", model: "vector-plan/actual-floor", maxTokens: 7500 },
    ])
    expect(returned).toEqual(["README", "Architecture"])
    // pending is only a refresh hint; the controller never discovers or runs another document itself.
    expect(requests).toHaveLength(2)
  })

  test("refuses oversized, duplicate or changed preview boundaries before any model call", async () => {
    let calls = 0
    const ports = {
      current: () => true,
      send: async () => {
        calls++
        return { data: result("local/test") }
      },
      result: () => {},
    }
    for (const value of [
      { ...preview(), maxTokens: 30000 },
      { ...preview(), documents: [...preview().documents, preview().documents[0]!] },
      { ...preview(), documents: [preview().documents[0]!, preview().documents[0]!] },
      { ...preview(), pending: -1 },
    ]) {
      expect(boundedBootstrap(value)).toBe(false)
      expect((await runBrainBootstrap(value, ports)).state).toBe("invalid")
    }
    expect(calls).toBe(0)
  })

  test("a settings/server change or failed request stops the remaining requests", async () => {
    let stillCurrent = true,
      calls = 0
    const first = await runBrainBootstrap(preview(), {
      current: () => stillCurrent,
      send: async () => {
        calls++
        stillCurrent = false
        return { data: result("local/test") }
      },
      result: () => {},
    })
    expect(first).toEqual({ completed: 1, state: "changed" })
    expect(calls).toBe(1)
    const failed = await runBrainBootstrap(preview(), {
      current: () => true,
      send: async () => ({ error: "failed" }),
      result: () => {
        throw new Error("No successful result")
      },
    })
    expect(failed).toEqual({ completed: 0, state: "failed" })
    expect(
      await runBrainBootstrap(preview(), {
        current: () => false,
        send: async () => {
          throw new Error("Must not send")
        },
        result: () => {},
      }),
    ).toEqual({ completed: 0, state: "changed" })
  })

  test("the preview names the actual Codium floor without exposing its token or price estimates", () => {
    const estimate = { ...preview().documents[3]!.estimate, input: 7500, output: 4000, lowUsd: 0.2, highUsd: 0.4 }
    expect(distillEstimateLabel(estimate)).toBe("Runs on vector-plan/actual-floor (Codium).")
    expect(distillEstimateLabel(estimate)).not.toMatch(/7500|4000|\$|tokens/i)
    expect(distillEstimateLabel(preview().documents[0]!.estimate)).toContain("local/test")
  })

  test("a model failure in a successful HTTP response preserves partial proposals and stops the batch", async () => {
    const partial: MemoryDistillResult = {
      ...result("local/test"),
      error: "The model stopped early.",
      records: [
        {
          id: "proposal",
          document: "first",
          passage: "passage",
          section: "setup",
          kind: "requirement",
          subject: "Runtime",
          card: "Use the documented runtime.",
          quote: "Use the documented runtime.",
          fields: {},
          status: "proposed",
          confidence: 1,
          origin: "distilled",
          userEdited: false,
          pinned: false,
          uses: 0,
          createdAt: 1,
          updatedAt: 1,
        },
      ],
    }
    let requests = 0
    const returned: MemoryDistillResult[] = []
    expect(
      await runBrainBootstrap(preview(), {
        current: () => true,
        send: async () => {
          requests++
          return { data: partial }
        },
        result: (_title, data) => returned.push(data),
      }),
    ).toEqual({ completed: 1, state: "failed" })
    expect(requests).toBe(1)
    expect(returned).toEqual([partial])
    expect(returned[0]!.records[0]!.status).toBe("proposed")
  })

  test("fresh Codium listing checks stop a confirmed Codium request while own-provider documents still work", async () => {
    const sent: string[] = []
    const outcome = await runBrainBootstrap(preview(), {
      current: async (estimate) => estimate.costKind !== "codium" || brainAccessible({ ...subscribed, listed: [] }),
      send: async (request) => {
        sent.push(request.documentID)
        return { data: result(request.model) }
      },
      result: () => {},
    })
    expect(sent).toEqual(["first"])
    expect(outcome).toEqual({ completed: 1, state: "changed" })
  })
})
