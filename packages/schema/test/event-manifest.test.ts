import { describe, expect, test } from "bun:test"
import { FileSystem, Integration, Permission, Project, Reference, Session, Workspace } from "../src"
import { EventManifest } from "../src/event-manifest"
import { IdeEvent } from "../src/ide-event"
import { MemoryEvent } from "../src/memory-event"
import { Research } from "../src/research"
import { SessionEvent } from "../src/session-event"
import { SessionTodo } from "../src/session-todo"
import { SessionV1 } from "../src/session-v1"
import { WorkspaceEvent } from "../src/workspace-event"

describe("public event manifest", () => {
  test("owns the complete public event surface", () => {
    expect(EventManifest.ServerDefinitions.length).toBe(65)
    expect(EventManifest.Definitions.length).toBe(100)
    expect(SessionV1.Event.Definitions).toEqual([
      SessionV1.Event.Created,
      SessionV1.Event.Updated,
      SessionV1.Event.Deleted,
      SessionV1.Event.MessageUpdated,
      SessionV1.Event.MessageRemoved,
      SessionV1.Event.PartUpdated,
      SessionV1.Event.PartRemoved,
      SessionV1.Event.PartDelta,
      SessionV1.Event.Diff,
      SessionV1.Event.Error,
    ])
    expect(EventManifest.Latest.size).toBe(100)
    expect(EventManifest.Durable.size).toBe(41)
  })

  test("uses canonical definitions for current public events", () => {
    expect(EventManifest.Durable.get("session.next.ancillary.usage.2")).toBe(SessionEvent.AncillaryUsage)
    expect(EventManifest.Durable.get("session.next.ancillary.usage.1")).toBe(SessionEvent.AncillaryUsageV1)
    expect(EventManifest.Latest.get("session.next.ancillary.usage")).toBe(SessionEvent.AncillaryUsage)
    expect(Session.Event).toBe(SessionEvent)
    expect(Session.Event.Definitions).toBe(SessionEvent.Definitions)
    expect(Workspace.Event).toBe(WorkspaceEvent)
    expect(Workspace.Event.Definitions).toBe(WorkspaceEvent.Definitions)
    expect(EventManifest.Latest.get("session.next.step.ended")).toBe(SessionEvent.Step.Ended)
    expect(EventManifest.Durable.get("session.next.step.resumed.1")).toBe(SessionEvent.Step.Resumed)
    expect(EventManifest.Latest.get("todo.updated")).toBe(SessionTodo.Event.Updated)
    expect(EventManifest.Latest.get("memory.learned")).toBe(MemoryEvent.Learned)
    expect(EventManifest.Latest.get("research.updated")).toBe(Research.Event.Updated)
    expect(EventManifest.Latest.get("project.updated")).toBe(Project.Event.Updated)
    expect(Project.Event.Definitions).toEqual([Project.Event.Updated])
    expect(FileSystem.Event.Definitions).toEqual([FileSystem.Event.Edited])
    expect(Integration.Event.Definitions).toEqual([
      Integration.Event.Updated,
      Integration.Event.ConnectionUpdated,
      Integration.Event.Unavailable,
    ])
    expect(Permission.Event.Definitions).toEqual([Permission.Event.Asked, Permission.Event.Replied])
    expect(Reference.Event.Definitions).toEqual([Reference.Event.Updated])
    expect(EventManifest.Latest.has("ide.installed")).toBe(false)
    expect(IdeEvent.Definitions).toEqual([IdeEvent.Installed])
    expect(EventManifest.Latest.get("session.next.revert.staged")).toBe(SessionEvent.RevertEvent.Staged)
    expect(EventManifest.Latest.get("session.next.revert.cleared")).toBe(SessionEvent.RevertEvent.Cleared)
    expect(EventManifest.Latest.get("session.next.revert.committed")).toBe(SessionEvent.RevertEvent.Committed)
    // The durable session block ends with the revert events, so the V1 live tail starts right after them.
    expect(EventManifest.Definitions.slice(46, 52)).toEqual([
      SessionEvent.RevertEvent.Staged,
      SessionEvent.RevertEvent.Cleared,
      SessionEvent.RevertEvent.Committed,
      SessionV1.Event.PartDelta,
      SessionV1.Event.Diff,
      SessionV1.Event.Error,
    ])
    expect(EventManifest.Durable.has("session.next.step.ended.1")).toBe(false)
    expect(EventManifest.Durable.get("session.next.step.ended.2")).toBe(SessionEvent.Step.Ended)
    expect(EventManifest.Durable.get("session.next.revert.committed.1")).toBe(SessionEvent.RevertEvent.Committed)
  })
})
