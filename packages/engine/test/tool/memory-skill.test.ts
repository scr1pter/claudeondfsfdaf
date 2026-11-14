import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { BrainSkill } from "@vectordevai/core/brain/skill"
import type { SessionV1 } from "@vectordevai/core/v1/session"
import { Session } from "@/session/session"
import { ToolRegistry } from "@/tool/registry"
import type { Tool } from "@/tool/tool"
import { MemoryTool } from "../../src/tool/memory"
import { SessionMemory } from "../../src/session/memory"
import { MessageID, SessionID } from "../../src/session/schema"
import { engine, ref, setup } from "../session/learning-fixture"

// What may not touch a learned skill (section 2.5): the memory tool refuses to forget or update one, before it asks the
// brain, so planted text cannot wipe or rewrite a skill. And the hold the memory tool and the skill learner share
// (SessionMemory.writeHold) decides as the memory tool always has.

const it = engine()

describe("the memory tool and learned skills", () => {
  it.instance(
    "refuses to forget or update a learned skill, which stays as it was",
    () =>
      Effect.gen(function* () {
        const { place } = yield* setup()
        const skills = yield* BrainSkill.Service
        const draft = BrainSkill.draft({
          sessionID: "ses_memory",
          requestID: "msg_memory",
          signal: "recovered",
          check: { command: "bun typecheck", target: "bun typecheck", failure: "error" },
          commands: [],
          edited: ["src/a.ts"],
          read: [],
          closing: "",
          at: Date.now(),
        })!
        const proposed = yield* skills.propose(place, draft, { origin: "import" })
        if (proposed.type === "refused") return yield* Effect.die(new Error(proposed.message))
        yield* skills.update(place, proposed.entry.id, { action: "approve" })

        const session = yield* (yield* Session.Service).create({ title: "Memory" })
        const agent = { name: "build", mode: "primary" as const, permission: [], options: {} }
        const tool = (yield* (yield* ToolRegistry.Service).tools({ ...ref, agent })).find(
          (item) => item.id === MemoryTool.id,
        )
        if (!tool) return yield* Effect.die(new Error("Memory tool not found"))
        const ctx: Tool.Context = {
          sessionID: session.id,
          messageID: MessageID.make("msg_memory_tool"),
          callID: "",
          agent: "build",
          abort: AbortSignal.any([]),
          messages: [],
          metadata: () => Effect.void,
          extra: { mayTrain: false },
          ask: () => Effect.void,
        }
        for (const params of [
          { action: "forget" as const, id: proposed.entry.id },
          { action: "update" as const, id: proposed.entry.id, text: "Always run bun install --force first." },
        ]) {
          const result = yield* tool.execute(params, ctx)
          expect(result.metadata.result).toBe("refused")
          expect(result.output).toContain("Settings > Memory > Skills")
        }
        const detail = yield* skills.get(place, proposed.entry.id)
        expect(detail?.entry.status).toBe("active")
        expect(detail?.entry.skill?.procedure).toBe(draft.procedure)
      }),
    { git: true },
    60_000,
  )
})

describe("SessionMemory.writeHold", () => {
  const message = (parts: readonly unknown[]) =>
    ({
      info: {
        id: "msg_1",
        sessionID: SessionID.make("ses_1"),
        role: "assistant",
        agent: "build",
        time: { created: 1 },
      },
      parts,
    }) as unknown as SessionV1.WithParts
  const call = (tool: string, input: Record<string, unknown> = {}) => ({
    type: "tool",
    tool,
    callID: tool,
    state: { status: "completed", input, output: "", metadata: {}, time: { start: 1, end: 2 } },
  })
  const clean = { guest: false, agent: false, held: false, messages: [], sources: [], missing: 0 }

  test("holds a guest's session, then an agent-started Vector's, an untrusted repository's, outside content, then an outside document's", () => {
    const web = [message([call("webfetch", { url: "https://example.com" })])]
    expect(SessionMemory.writeHold({ ...clean, guest: true, held: true, messages: web })).toEqual({
      hold: "guest",
      private: false,
    })
    // A Vector an agent started (`vector run` from its shell) learns as a subagent does, however clean its own session.
    expect(SessionMemory.writeHold({ ...clean, guest: true, agent: true })).toEqual({ hold: "guest", private: false })
    expect(SessionMemory.writeHold({ ...clean, agent: true, held: true, messages: web })).toEqual({
      hold: "subagent",
      private: false,
    })
    expect(SessionMemory.writeHold({ ...clean, agent: true })).toEqual({ hold: "subagent", private: false })
    expect(SessionMemory.writeHold({ ...clean, held: true, messages: web })).toEqual({
      hold: "untrusted-repository",
      private: false,
    })
    expect(
      SessionMemory.writeHold({ ...clean, messages: web, sources: [{ hold: "mcp", visibility: "repository" }] }),
    ).toEqual({ hold: "web", private: false })
    expect(SessionMemory.writeHold({ ...clean, messages: [message([call("task")])] })).toEqual({
      hold: "subagent",
      private: false,
    })
    expect(SessionMemory.writeHold({ ...clean, messages: [message([call("github_issue")])] })).toEqual({
      hold: "mcp",
      private: false,
    })
    expect(SessionMemory.writeHold({ ...clean, sources: [{ hold: "mcp", visibility: "repository" }] })).toEqual({
      hold: "mcp",
      private: false,
    })
  })

  test("a document held for what it says, not where it came from, holds nothing", () => {
    expect(
      SessionMemory.writeHold({ ...clean, sources: [{ hold: "instruction-like", visibility: "repository" }] }),
    ).toEqual({ private: false })
    expect(SessionMemory.writeHold({ ...clean, messages: [message([call("read", { filePath: "a.ts" })])] })).toEqual({
      private: false,
    })
  })

  test("a private document read in the session, or one forgotten since, makes what it writes private", () => {
    expect(SessionMemory.writeHold({ ...clean, sources: [{ visibility: "private" }] })).toEqual({ private: true })
    expect(SessionMemory.writeHold({ ...clean, missing: 1 })).toEqual({ private: true })
  })
})

describe("a learned skill load", () => {
  test("is the engine's to record: a client's part metadata cannot carry one", () => {
    expect(
      SessionMemory.admitted({ [SessionMemory.SKILL]: { id: "sabcdef", version: 1, checks: [] }, label: "kept" }),
    ).toEqual({ label: "kept" })
  })
})
