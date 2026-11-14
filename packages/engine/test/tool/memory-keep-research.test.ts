import { ProviderV2 } from "@vectordevai/core/provider"
import { ModelV2 } from "@vectordevai/core/model"
import { CrossSpawnSpawner } from "@vectordevai/core/cross-spawn-spawner"
import { LayerNode } from "@vectordevai/core/effect/layer-node"
import { Ripgrep } from "@vectordevai/core/ripgrep"
import { Brain } from "@vectordevai/core/brain/brain"
import { ResearchStore } from "@vectordevai/core/research/store"
import { PermissionPolicy } from "@vectordevai/schema/permission-policy"
import { Effect } from "effect"
import { afterEach, describe, expect } from "bun:test"
import { Instruction } from "../../src/session/instruction"
import type { Tool } from "@/tool/tool"
import { MemoryTool } from "../../src/tool/memory"
import { ToolRegistry } from "@/tool/registry"
import { Session } from "@/session/session"
import { disposeAllInstances } from "../fixture/fixture"
import { MessageID, SessionID } from "../../src/session/schema"
import { testEffect } from "../lib/effect"

afterEach(async () => {
  await disposeAllInstances()
})

const it = testEffect(
  LayerNode.compile(
    LayerNode.group([
      ToolRegistry.node,
      CrossSpawnSpawner.node,
      Ripgrep.node,
      Brain.node,
      Instruction.node,
      Session.node,
      ResearchStore.node,
    ]),
  ),
)

type Ask = Parameters<Tool.Context["ask"]>[0]

// The memory tool, run with a context that records every ask and answers it the way `answer` says.
const memory = (asks: Ask[], answer: "yes" | "no" = "yes") =>
  Effect.gen(function* () {
    const registry = yield* ToolRegistry.Service
    const tool = (yield* registry.tools({
      providerID: ProviderV2.ID.openai,
      modelID: ModelV2.ID.make("gpt-5"),
      agent: { name: "build", mode: "primary" as const, permission: [], options: {} },
    })).find((item) => item.id === MemoryTool.id)
    if (!tool) throw new Error("Memory tool not found")
    return (params: Record<string, unknown>, sessionID: SessionID) =>
      tool.execute(params, {
        sessionID,
        messageID: MessageID.make(`msg_keep_${asks.length}`),
        callID: `call_keep_${asks.length}`,
        agent: "build",
        abort: AbortSignal.any([]),
        extra: { mayTrain: false },
        messages: [],
        metadata: () => Effect.void,
        ask: (request) => {
          asks.push(request)
          return answer === "yes" ? Effect.void : Effect.die(new Error("The user said no"))
        },
      } satisfies Tool.Context)
  })

// A run with one source, a note quoting it and a report citing the note: the report is held until it is kept.
const reported = (sessionID: string) =>
  Effect.gen(function* () {
    const store = yield* ResearchStore.Service
    const place = yield* (yield* Instruction.Service).place()
    const run = yield* store.start(place, {
      sessionID,
      question: "How much do heat pumps cut heating energy?",
      depth: "focused",
      scope: "web",
    })
    yield* store.addSource(place, run.id, {
      url: "https://homes.web.test/article",
      canonical: "https://homes.web.test/article",
      site: "homes.web.test",
      title: "homes field study",
      status: "read",
      chunks: [
        { text: "Results. Delivered heating energy fell by 61 percent compared with the gas boilers the homes had before.", chunk: 1 },
      ],
    })
    yield* store.note(place, run.id, {
      subquestion: "How much energy do heat pumps save?",
      claim: "Delivered heating energy fell by 61 percent",
      source: "S1",
      quote: "Delivered heating energy fell by 61 percent compared with the gas boilers",
    })
    yield* store.report(place, run.id, {
      title: "Heat pump savings",
      answer: "Delivered heating energy fell by 61 percent against gas boilers in the field study [N1].",
      sections: [{ heading: "Measured savings", body: "Delivered heating energy fell by 61 percent against gas boilers [N1]." }],
      open_questions: [],
    })
    return { store, place, run }
  })

describe("tool.memory keep", () => {
  it.instance("asked to save this session's research, the agent keeps it only after the user says yes, every time", () =>
    Effect.gen(function* () {
      const sessionID = SessionID.make("ses_keep_research")
      const { store, place, run } = yield* reported(sessionID)
      expect((yield* store.get(place, run.id))?.run.kept).toBe(false)

      const asks: Ask[] = []
      const keep = yield* memory(asks)
      const result = yield* keep({ action: "keep" }, sessionID)

      expect(asks).toHaveLength(1)
      expect(asks[0]?.permission).toBe(PermissionPolicy.RESEARCH_KEEP)
      expect(asks[0]?.always).toEqual([])
      expect(asks[0]?.patterns).toEqual([run.id])
      // No configuration or auto-accept answers it for the user.
      expect(PermissionPolicy.requiresApproval(asks[0]?.permission, asks[0]?.always, asks[0]?.patterns)).toBe(true)
      expect(PermissionPolicy.canAutoApprove(asks[0]?.permission, asks[0]?.always, asks[0]?.patterns)).toBe(false)
      expect(result.output).toContain("Kept \"How much do heat pumps cut heating energy?\"")
      expect((yield* store.get(place, run.id))?.run.kept).toBe(true)

      // Kept already: nothing to ask again.
      const again = yield* keep({ action: "keep", id: run.id }, sessionID)
      expect(asks).toHaveLength(1)
      expect(again.output).toContain("already kept")
    }),
  )

  it.instance("a no from the user keeps nothing", () =>
    Effect.gen(function* () {
      const sessionID = SessionID.make("ses_keep_research_no")
      const { store, place, run } = yield* reported(sessionID)
      const asks: Ask[] = []
      const keep = yield* memory(asks, "no")
      const exit = yield* Effect.exit(keep({ action: "keep" }, sessionID))
      expect(exit._tag).toBe("Failure")
      expect(asks).toHaveLength(1)
      expect((yield* store.get(place, run.id))?.run.kept).toBe(false)
    }),
  )

  it.instance("a run that is not here, or a session with no research, is refused without asking", () =>
    Effect.gen(function* () {
      const asks: Ask[] = []
      const keep = yield* memory(asks)
      const unknown = yield* keep({ action: "keep", id: "rsr_missing" }, SessionID.make("ses_keep_unknown"))
      expect(unknown.output).toBe("No research run rsr_missing here.")
      const none = yield* keep({ action: "keep" }, SessionID.make("ses_keep_none"))
      expect(none.output).toBe("This session has no research run to keep.")
      expect(asks).toHaveLength(0)
    }),
  )
})
