import { describe, expect, test } from "bun:test"
import { SessionEvent } from "@vectordevai/core/session/event"
import { Integration } from "@vectordevai/schema/integration"
import { LocalEvent } from "@vectordevai/schema/local-event"
import { MemoryEvent } from "@vectordevai/schema/memory-event"
import { Pty } from "@vectordevai/schema/pty"
import { Research } from "@vectordevai/schema/research"
import { EventManifest as SchemaEventManifest } from "@vectordevai/schema/event-manifest"
import { Todo } from "@/session/todo"
import { EventManifest } from "@/event-manifest"

describe("public event manifest", () => {
  test("contains every latest public wire type once", () => {
    expect(EventManifest.Definitions).toBe(SchemaEventManifest.Definitions)
    expect(EventManifest.Latest).toBe(SchemaEventManifest.Latest)
    expect(EventManifest.Durable).toBe(SchemaEventManifest.Durable)
    expect(EventManifest.Latest.size).toBe(100)
    expect(EventManifest.Latest.get("provider.unavailable")).toBe(Integration.Event.Unavailable)
    expect(EventManifest.Latest.get("session.next.ancillary.usage")).toBe(SessionEvent.AncillaryUsage)
    expect(EventManifest.Latest.get("session.next.step.ended")).toBe(SessionEvent.Step.Ended)
    expect(EventManifest.Latest.get("session.next.step.resumed")).toBe(SessionEvent.Step.Resumed)
    expect(EventManifest.Latest.get("session.next.ancillary.usage")).toBe(SessionEvent.AncillaryUsage)
    expect(EventManifest.Latest.get("todo.updated")).toBe(Todo.Event.Updated)
    expect(EventManifest.Latest.get("research.updated")).toBe(Research.Event.Updated)
    expect(EventManifest.Latest.get("local.updated")).toBe(LocalEvent.Updated)
    expect(EventManifest.Latest.get("local.blocked")).toBe(LocalEvent.Blocked)
    expect(EventManifest.Latest.get("memory.learned")).toBe(MemoryEvent.Learned)
    expect(EventManifest.Latest.get("pty.revealed")).toBe(Pty.Event.Revealed)
    expect(EventManifest.Latest.has("ide.installed")).toBe(false)
    expect(EventManifest.Latest.has("server.connected")).toBe(true)
    expect(EventManifest.Latest.has("global.disposed")).toBe(true)
  })

  test("contains only the current step settlement versions, and the version 1 ancillary usage builds before wrote", () => {
    expect(EventManifest.Durable.size).toBe(41)
    expect(EventManifest.Durable.get("session.next.ancillary.usage.2")).toBe(SessionEvent.AncillaryUsage)
    expect(EventManifest.Durable.get("session.next.ancillary.usage.1")).toBe(SessionEvent.AncillaryUsageV1)
    expect(EventManifest.Durable.get("session.next.step.resumed.1")).toBe(SessionEvent.Step.Resumed)
    expect(EventManifest.Durable.has("session.next.step.ended.1")).toBe(false)
    expect(EventManifest.Durable.get("session.next.step.ended.2")).toBe(SessionEvent.Step.Ended)
  })
})
