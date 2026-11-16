import { afterEach, describe, expect, setSystemTime, test } from "bun:test"
import { agentColor } from "@/components/editor-attribution"
import {
  activityFiles,
  createAgentFollow,
  directoryFollowSource,
  eventFiles,
  externalActivityEntries,
  followToastDue,
  latestTurn,
  messageAgent,
  sessionLineage,
  WATCHER_DEBOUNCE_MS,
  workspaceRelativePath,
  type AgentFollow,
  type FollowEnvelope,
  type FollowExternal,
  type FollowSource,
} from "./agent-follow"

const ROOT = "/repo"
const wait = (ms = 0) => new Promise<void>((resolve) => setTimeout(resolve, ms))
const live = new Set<AgentFollow>()

async function eventually(assert: () => void) {
  const deadline = performance.now() + 2_000
  for (;;) {
    try {
      assert()
      return
    } catch (error) {
      if (performance.now() >= deadline) throw error
    }
    await wait(5)
  }
}

afterEach(() => {
  for (const store of live) store.dispose()
  live.clear()
})

// A fake editor surface: `disk` is what the server would read, `loaded` is
// what the file context holds (and what the editor shows).
function harness(
  input: {
    follow?: boolean
    loaded?: Record<string, string>
    disk?: Record<string, string>
    external?: FollowExternal
    agents?: Record<string, string>
  } = {},
) {
  const disk: Record<string, string> = { ...input.disk }
  const loaded: Record<string, string> = { ...input.loaded }
  const listeners = new Set<(event: FollowEnvelope) => void>()
  const reads: string[] = []
  const sessionAgents: Record<string, string> = { ses_main: "build", ...input.agents }
  const source: FollowSource = {
    key: (file) => (file.startsWith(`${ROOT}/`) ? file.slice(ROOT.length + 1) : file),
    peek: (key) => loaded[key],
    read: async (key) => {
      reads.push(key)
      await wait()
      const text = disk[key]
      if (text !== undefined) loaded[key] = text
      return text
    },
  }
  const store = createAgentFollow({
    listen: (fn) => {
      listeners.add(fn)
      return () => listeners.delete(fn)
    },
    source,
    followAgent: () => input.follow ?? true,
    agents: () => [{ name: "build", color: "#00ff00" }],
    agentFor: (sessionID) => sessionAgents[sessionID],
    external: input.external ? () => input.external : undefined,
  })
  live.add(store)
  const emit = (type: string, properties: unknown) => {
    for (const fn of listeners) fn({ details: { type, properties } })
  }
  return { store, disk, loaded, reads, emit }
}

function part(input: {
  callID: string
  status: "pending" | "running" | "completed" | "error"
  tool?: string
  sessionID?: string
  messageID?: string
  input?: Record<string, unknown>
  end?: number
  metadata?: Record<string, unknown>
}) {
  const sessionID = input.sessionID ?? "ses_main"
  return {
    sessionID,
    part: {
      id: `prt_${input.callID}`,
      type: "tool",
      callID: input.callID,
      tool: input.tool ?? "edit",
      sessionID,
      messageID: input.messageID ?? "msg_1",
      state: {
        status: input.status,
        input: input.input ?? {},
        ...(input.metadata ? { metadata: input.metadata } : {}),
        time: { start: Date.now(), ...(input.end === undefined ? {} : { end: input.end }) },
      },
    },
  }
}

const edited = (file: string, extra: Record<string, unknown> = {}) => ({
  file: `${ROOT}/${file}`,
  sessionID: "ses_main",
  agent: "build",
  messageID: "msg_1",
  ...extra,
})

const editCall = (callID: string, file: string, oldString: string, newString: string, extra = {}) =>
  part({ callID, status: "running", input: { filePath: `${ROOT}/${file}`, oldString, newString }, ...extra })

describe("following a Vector agent's tool call", () => {
  test("a running edit opens the file with an editing cursor where the change will land", () => {
    const h = harness({ loaded: { "src/a.ts": "one\ntwo\nthree\n" }, disk: { "src/a.ts": "one\ntwo\nthree\n" } })
    h.emit("message.part.updated", editCall("c1", "src/a.ts", "two", "TWO"))

    expect(h.store.cursorsFor("src/a.ts")).toEqual([
      expect.objectContaining({
        state: "editing",
        line: 2,
        pending: { start: 2, end: 2 },
        agentId: "ses_main",
        agentName: "build",
        color: "#00ff00",
      }),
    ])
    expect(h.store.target()).toMatchObject({ path: "src/a.ts", line: 2, endLine: 2, agentName: "build" })
    expect(h.store.typingFor("src/a.ts")).toMatchObject({ agentName: "build", color: "#00ff00" })
    expect(h.store.following()).toMatchObject({ name: "build", path: "src/a.ts", state: "editing" })
    expect(h.reads).toEqual([])
  })

  test("ignores the pending state, which carries no input yet", () => {
    const h = harness({ loaded: { "src/a.ts": "a\n" } })
    h.emit("message.part.updated", part({ callID: "c1", status: "pending" }))
    expect(h.store.cursors()).toEqual([])
    expect(h.store.target()).toBeUndefined()
  })

  test("loads a file that was not open and then marks the landing zone", async () => {
    const h = harness({ disk: { "src/b.ts": "a\nb\n" } })
    h.emit("message.part.updated", editCall("c1", "src/b.ts", "b", "B"))
    expect(h.store.cursorsFor("src/b.ts")[0]).toMatchObject({ state: "editing", line: 1 })
    await wait(5)
    expect(h.reads).toContain("src/b.ts")
    expect(h.store.cursorsFor("src/b.ts")[0]).toMatchObject({ line: 2, pending: { start: 2, end: 2 } })
    expect(h.store.target()).toMatchObject({ path: "src/b.ts", line: 2 })
  })

  test("permission.asked switches the cursor to waiting, and an approval returns it to editing", () => {
    const h = harness({ loaded: { "src/a.ts": "one\ntwo\n" } })
    h.emit("message.part.updated", editCall("c1", "src/a.ts", "two", "TWO"))
    h.emit("permission.asked", {
      id: "per_1",
      sessionID: "ses_main",
      permission: "edit",
      patterns: [],
      metadata: {},
      always: [],
      tool: { messageID: "msg_1", callID: "c1" },
    })
    expect(h.store.cursorsFor("src/a.ts")[0]?.state).toBe("waiting")
    expect(h.store.following()?.state).toBe("waiting")

    h.emit("permission.replied", { sessionID: "ses_main", requestID: "per_1", reply: "once" })
    expect(h.store.cursorsFor("src/a.ts")[0]?.state).toBe("editing")
  })

  test("a rejected permission clears the pending cursor", () => {
    const h = harness({ loaded: { "src/a.ts": "one\ntwo\n" } })
    h.emit("message.part.updated", editCall("c1", "src/a.ts", "two", "TWO"))
    h.emit("permission.asked", { id: "per_1", sessionID: "ses_main", tool: { messageID: "msg_1", callID: "c1" } })
    h.emit("permission.replied", { sessionID: "ses_main", requestID: "per_1", reply: "reject" })
    expect(h.store.cursors()).toEqual([])
    expect(h.store.typingFor("src/a.ts")).toBeUndefined()
  })

  test("a permission asked before the running part arrives starts the cursor waiting", () => {
    const h = harness({ loaded: { "src/a.ts": "one\ntwo\n" } })
    h.emit("permission.asked", { id: "per_1", sessionID: "ses_main", tool: { messageID: "msg_1", callID: "c1" } })
    h.emit("message.part.updated", editCall("c1", "src/a.ts", "two", "TWO"))
    expect(h.store.cursorsFor("src/a.ts")[0]?.state).toBe("waiting")
  })

  test("an error part clears that call's pending cursor", () => {
    const h = harness({ loaded: { "src/a.ts": "one\ntwo\n" } })
    h.emit("message.part.updated", editCall("c1", "src/a.ts", "two", "TWO"))
    h.emit("message.part.updated", part({ callID: "c1", status: "error" }))
    expect(h.store.cursors()).toEqual([])
    expect(h.store.typingFor("src/a.ts")).toBeUndefined()
  })

  test("refreshTarget re-issues the current target so a newly opened editor reveals it", async () => {
    const h = harness({ loaded: { "src/a.ts": "one\ntwo\n" } })
    h.emit("message.part.updated", editCall("c1", "src/a.ts", "two", "TWO"))
    const first = h.store.target()!
    await wait(5)
    h.store.refreshTarget()
    expect(h.store.target()).toMatchObject({ path: first.path, line: first.line, agentId: first.agentId })
    expect(h.store.target()!.token).toBeGreaterThan(first.token)
  })
})

describe("landing an edit", () => {
  test("diffs against the text saved at call time even when the watcher reloaded first", async () => {
    // This case tests the captured baseline, independently of the diff's wall-clock budget.
    setSystemTime(new Date())
    try {
      const before = "a\nb\nc\nd\ne\nf\ng\n"
      const after = "a\nB\nc\nd\ne\nF\ng\n"
      const h = harness({ loaded: { "src/a.ts": before }, disk: { "src/a.ts": before } })
      h.emit(
        "message.part.updated",
        part({
          callID: "c1",
          status: "running",
          tool: "write",
          input: { filePath: `${ROOT}/src/a.ts`, content: after },
        }),
      )
      // The write lands and the project watcher reloads the buffer before
      // file.edited (which waits for the formatter) arrives.
      h.disk["src/a.ts"] = after
      h.loaded["src/a.ts"] = after
      h.emit("file.edited", edited("src/a.ts"))
      await eventually(() => {
        expect(h.store.attributionsFor("src/a.ts")).toEqual([
          expect.objectContaining({
            agentName: "build",
            ranges: [
              { start: 2, end: 2 },
              { start: 6, end: 6 },
            ],
          }),
        ])
      })
      expect(h.store.cursorsFor("src/a.ts")[0]).toMatchObject({ state: "landed", line: 2 })
      expect(h.store.cursorsFor("src/a.ts")[0]?.pending).toBeUndefined()
      expect(h.store.target()).toMatchObject({ path: "src/a.ts", line: 2, endLine: 2 })
    } finally {
      setSystemTime()
    }
  })

  test("the edit tool's own metadata update after landing does not reopen the call", async () => {
    const before = "a\nb\nc\nd\ne\nf\ng\n"
    const h = harness({ loaded: { "src/a.ts": before }, disk: { "src/a.ts": before } })
    h.emit("message.part.updated", editCall("c1", "src/a.ts", "g", "G"))
    h.disk["src/a.ts"] = "a\nb\nc\nd\ne\nf\nG\n"
    h.emit("file.edited", edited("src/a.ts"))
    await wait(5)
    expect(h.store.cursorsFor("src/a.ts")).toEqual([expect.objectContaining({ state: "landed", line: 7 })])

    // The edit tool publishes file.edited, then its metadata, which
    // republishes the same running part with the same input.
    h.emit("message.part.updated", editCall("c1", "src/a.ts", "g", "G"))
    expect(h.store.cursorsFor("src/a.ts")).toEqual([expect.objectContaining({ state: "landed", line: 7 })])
    expect(h.store.target()).toMatchObject({ path: "src/a.ts", line: 7 })

    // Nor does its completed part land it a second time.
    h.emit(
      "message.part.updated",
      part({
        callID: "c1",
        status: "completed",
        input: { filePath: `${ROOT}/src/a.ts`, oldString: "g", newString: "G" },
        end: Date.now(),
      }),
    )
    await wait(10)
    expect(h.store.cursorsFor("src/a.ts")).toEqual([expect.objectContaining({ state: "landed", line: 7 })])
    expect(h.reads).toEqual(["src/a.ts"])
  })

  test("the edit tool's post-write republish opens no call when its first running part was missed", async () => {
    const after = "a\nb\nC\n"
    const h = harness({ loaded: { "src/a.ts": after }, disk: { "src/a.ts": after } })
    // The first running update was coalesced away, so the store first sees the
    // part the edit tool republishes with its diff once the file is written.
    h.emit("message.part.updated", editCall("c1", "src/a.ts", "c", "C", { metadata: { diff: "@@", filediff: {} } }))
    expect(h.store.cursorsFor("src/a.ts")).toEqual([])
    expect(h.reads).toEqual([])

    // The completed part still lands it.
    h.emit(
      "message.part.updated",
      part({
        callID: "c1",
        status: "completed",
        input: { filePath: `${ROOT}/src/a.ts`, oldString: "c", newString: "C" },
        end: Date.now(),
      }),
    )
    await eventually(() =>
      expect(h.store.cursorsFor("src/a.ts")).toEqual([expect.objectContaining({ state: "landed", line: 3 })]),
    )
  })

  test("a read that lands after the write, before the formatter, is not taken as the before", async () => {
    // The file was not open, and the auto-approved write reached the disk
    // before the store's read did: that read holds the agent's unformatted text.
    const h = harness({ disk: { "src/a.ts": "import b\nimport a\n\nconst delta = 1\n" } })
    h.emit("message.part.updated", editCall("c1", "src/a.ts", "const gamma = 1", "const delta = 1"))
    await wait(5)
    expect(h.reads).toEqual(["src/a.ts"])
    expect(h.store.cursorsFor("src/a.ts")[0]?.pending).toBeUndefined()

    // The formatter then sorts the imports and leaves the agent's line alone.
    h.disk["src/a.ts"] = "import a\nimport b\n\nconst delta = 1\n"
    h.emit("file.edited", edited("src/a.ts"))
    await wait(5)
    expect(h.store.attributionsFor("src/a.ts")[0]?.ranges).toEqual([{ start: 4, end: 4 }])
    expect(h.store.cursorsFor("src/a.ts")[0]).toMatchObject({ state: "landed", line: 4 })
  })

  test("falls back to the tool input when the saved text was already the new text", async () => {
    // The auto-approved write reached the disk before the file finished loading.
    const h = harness({ disk: { "src/a.ts": "x\nfoo\ny\n" } })
    h.emit("message.part.updated", editCall("c1", "src/a.ts", "bar", "foo"))
    await wait(5)
    h.emit("file.edited", edited("src/a.ts"))
    await wait(5)
    expect(h.store.attributionsFor("src/a.ts")[0]?.ranges).toEqual([{ start: 2, end: 2 }])
  })

  test("attributes an edit whose call it never saw by diffing what was on screen", async () => {
    const h = harness({ loaded: { "src/a.ts": "one\ntwo\n" }, disk: { "src/a.ts": "one\nTWO\n" } })
    h.emit("file.edited", edited("src/a.ts", { messageID: "msg_other" }))
    await wait(5)
    expect(h.store.attributionsFor("src/a.ts")[0]).toMatchObject({ agentName: "build", ranges: [{ start: 2, end: 2 }] })
    expect(h.store.target()).toMatchObject({ path: "src/a.ts", line: 2 })
  })

  test("lands a completed call it never saw running from the call's input", async () => {
    const h = harness({ loaded: { "src/a.ts": "one\nTWO\n" }, disk: { "src/a.ts": "one\nTWO\n" } })
    h.emit(
      "message.part.updated",
      part({
        callID: "c1",
        status: "completed",
        input: { filePath: `${ROOT}/src/a.ts`, oldString: "two", newString: "TWO" },
        end: Date.now(),
      }),
    )
    await eventually(() => expect(h.store.attributionsFor("src/a.ts")[0]?.ranges).toEqual([{ start: 2, end: 2 }]))
  })

  test("ignores a completed call from long ago", async () => {
    const h = harness({ loaded: { "src/a.ts": "one\nTWO\n" }, disk: { "src/a.ts": "one\nTWO\n" } })
    h.emit(
      "message.part.updated",
      part({
        callID: "c1",
        status: "completed",
        input: { filePath: `${ROOT}/src/a.ts`, oldString: "two", newString: "TWO" },
        end: Date.now() - 60_000,
      }),
    )
    await wait(10)
    expect(h.store.attributions()).toEqual([])
    expect(h.store.cursors()).toEqual([])
  })

  test("follows every file an apply_patch touches", async () => {
    const patchText = [
      "*** Begin Patch",
      "*** Update File: src/a.ts",
      "@@",
      " one",
      "-two",
      "+TWO",
      "*** Add File: src/new.ts",
      "+hello",
      "*** End Patch",
    ].join("\n")
    const h = harness({ loaded: { "src/a.ts": "one\ntwo\n" }, disk: { "src/a.ts": "one\ntwo\n" } })
    h.emit("message.part.updated", part({ callID: "c1", status: "running", tool: "apply_patch", input: { patchText } }))
    expect(h.store.cursorsFor("src/a.ts")[0]).toMatchObject({ state: "editing", pending: { start: 1, end: 2 } })
    expect(h.store.cursorsFor("src/new.ts")[0]).toMatchObject({ state: "editing", line: 1 })
    expect(h.store.target()).toMatchObject({ path: "src/a.ts" })

    await wait(5)
    h.disk["src/a.ts"] = "one\nTWO\n"
    h.disk["src/new.ts"] = "hello"
    h.emit("file.edited", edited("src/a.ts"))
    h.emit("file.edited", edited("src/new.ts"))
    await wait(5)
    expect(h.store.attributionsFor("src/a.ts")[0]?.ranges).toEqual([{ start: 2, end: 2 }])
    expect(h.store.attributionsFor("src/new.ts")[0]?.ranges).toEqual([{ start: 1, end: 1 }])
  })
})

describe("several agents", () => {
  test("a subagent's child session gets its own colour and cursor", () => {
    const h = harness({ loaded: { "src/a.ts": "a\nb\n", "src/c.ts": "x\ny\n" }, agents: { ses_child: "explore" } })
    h.emit("message.part.updated", editCall("c1", "src/a.ts", "b", "B"))
    h.emit("message.part.updated", editCall("c2", "src/c.ts", "y", "Y", { sessionID: "ses_child", messageID: "msg_2" }))

    expect(h.store.cursorsFor("src/a.ts")[0]).toMatchObject({ agentId: "ses_main", color: "#00ff00" })
    expect(h.store.cursorsFor("src/c.ts")[0]).toMatchObject({
      agentId: "ses_child",
      agentName: "explore",
      color: agentColor("ses_child"),
    })
  })

  test("two sessions editing one file show two cursors", () => {
    const h = harness({ loaded: { "src/a.ts": "a\nb\nc\n" }, agents: { ses_child: "explore" } })
    h.emit("message.part.updated", editCall("c1", "src/a.ts", "a", "A"))
    h.emit("message.part.updated", editCall("c2", "src/a.ts", "c", "C", { sessionID: "ses_child", messageID: "msg_2" }))
    const cursors = h.store.cursorsFor("src/a.ts")
    expect(cursors.map((cursor) => [cursor.agentId, cursor.line])).toEqual([
      ["ses_main", 1],
      ["ses_child", 3],
    ])
  })

  test("a parallel workspace's events land under its own name, in its own scope", async () => {
    const h = harness()
    const texts: Record<string, string> = { "/w/iso/src/a.ts": "one\ntwo\n" }
    const disk: Record<string, string> = { "src/a.ts": "one\nTWO\n" }
    const source = directoryFollowSource({
      directory: "/w/iso",
      peek: (key) => texts[key],
      read: async (relative, key) => {
        texts[key] = disk[relative]!
        return texts[key]
      },
    })
    const identity = { id: "workspace:w1", name: "Refactor", color: "#a78bfa" }
    h.store.handle(
      {
        type: "message.part.updated",
        properties: part({
          callID: "w1",
          status: "running",
          sessionID: "ses_w",
          input: { filePath: "/w/iso/src/a.ts", oldString: "two", newString: "TWO" },
        }),
      },
      { source, identity },
    )
    expect(h.store.cursorsFor("/w/iso/src/a.ts")[0]).toMatchObject({
      agentName: "Refactor",
      scope: "/w/iso",
      state: "editing",
    })
    expect(h.store.target()).toBeUndefined()
    expect(h.store.targetFor("/w/iso")).toMatchObject({ path: "/w/iso/src/a.ts", line: 2 })

    h.store.handle(
      {
        type: "file.edited",
        properties: { file: "/w/iso/src/a.ts", sessionID: "ses_w", agent: "build", messageID: "msg_1" },
      },
      { source, identity },
    )
    await wait(5)
    expect(h.store.attributionsFor("/w/iso/src/a.ts")[0]).toMatchObject({
      agentName: "Refactor",
      ranges: [{ start: 2, end: 2 }],
    })
  })

  test("a parallel workspace's target leaves the main directory's target as it was", () => {
    const h = harness({ loaded: { "src/a.ts": "one\ntwo\n" } })
    h.emit("message.part.updated", editCall("c1", "src/a.ts", "two", "TWO"))
    const main = h.store.target()
    const source = directoryFollowSource({ directory: "/w/iso", peek: () => "x\ny\n", read: async () => "x\ny\n" })
    h.store.handle(
      {
        type: "message.part.updated",
        properties: part({
          callID: "w1",
          status: "running",
          sessionID: "ses_w",
          input: { filePath: "/w/iso/src/b.ts", oldString: "y", newString: "Y" },
        }),
      },
      { source, identity: { id: "workspace:w1", name: "Refactor", color: "#a78bfa" } },
    )
    h.store.refreshTarget("/w/iso")
    expect(h.store.targetFor("/w/iso")).toMatchObject({ path: "/w/iso/src/b.ts", line: 2 })
    expect(h.store.target()).toBe(main!)
  })
})

describe("following off", () => {
  test("attributes a loaded file but never opens, loads or places a cursor", async () => {
    const h = harness({
      follow: false,
      loaded: { "src/a.ts": "a\nb\n" },
      disk: { "src/a.ts": "a\nb\n", "src/z.ts": "z\n" },
    })
    h.emit("message.part.updated", editCall("c1", "src/a.ts", "b", "B"))
    expect(h.store.cursors()).toEqual([])
    expect(h.store.target()).toBeUndefined()

    h.disk["src/a.ts"] = "a\nB\n"
    h.emit("file.edited", edited("src/a.ts"))
    h.emit("file.edited", edited("src/z.ts"))
    await wait(5)
    expect(h.store.attributionsFor("src/a.ts")[0]?.ranges).toEqual([{ start: 2, end: 2 }])
    expect(h.store.cursors()).toEqual([])
    expect(h.store.target()).toBeUndefined()
    expect(h.reads).not.toContain("src/z.ts")
  })
})

describe("external agents", () => {
  test("the watcher attributes the file already on screen", async () => {
    const h = harness({
      loaded: { "src/a.ts": "one\ntwo\n" },
      disk: { "src/a.ts": "one\ntwo\n" },
      external: { label: "Codex", running: true },
    })
    h.disk["src/a.ts"] = "one\nTWO\n"
    h.emit("file.watcher.updated", { file: `${ROOT}/src/a.ts`, event: "change" })
    // The file context reloads the open file on the same event.
    h.loaded["src/a.ts"] = "one\nTWO\n"
    await eventually(() =>
      expect(h.store.attributionsFor("src/a.ts")).toEqual([
        expect.objectContaining({ agentName: "Codex", color: agentColor("Codex"), ranges: [{ start: 2, end: 2 }] }),
      ]),
    )
    expect(h.store.cursorsFor("src/a.ts")[0]).toMatchObject({ state: "landed", line: 2, agentName: "Codex" })
    expect(h.store.target()).toMatchObject({ path: "src/a.ts", line: 2 })
  })

  test("watcher events are not agent edits without an external agent", async () => {
    const h = harness({ loaded: { "src/a.ts": "one\n" }, disk: { "src/a.ts": "ONE\n" } })
    h.emit("file.watcher.updated", { file: `${ROOT}/src/a.ts`, event: "change" })
    await wait(WATCHER_DEBOUNCE_MS + 30)
    expect(h.store.attributions()).toEqual([])
  })

  test("a stopped runner's watcher events are ignored", async () => {
    const h = harness({
      loaded: { "src/a.ts": "one\n" },
      disk: { "src/a.ts": "ONE\n" },
      external: { label: "Codex", running: false },
    })
    h.emit("file.watcher.updated", { file: `${ROOT}/src/a.ts`, event: "change" })
    await wait(WATCHER_DEBOUNCE_MS + 30)
    expect(h.store.attributions()).toEqual([])
  })

  test("reported activity files open with the agent's cursor before the watcher fires", async () => {
    const h = harness({
      loaded: { "src/a.ts": "one\ntwo\n" },
      disk: { "src/a.ts": "one\ntwo\n" },
      external: { label: "Claude Code", running: true },
    })
    // What is already there when the store starts is history, not live.
    h.store.ingestActivity([{ id: "old", state: "done", files: ["src/old.ts"] }])
    expect(h.store.cursors()).toEqual([])

    h.store.ingestActivity([
      { id: "old", state: "done", files: ["src/old.ts"] },
      { id: "t1", state: "running", files: ["src/a.ts"] },
    ])
    expect(h.store.cursorsFor("src/a.ts")[0]).toMatchObject({ state: "editing", agentName: "Claude Code" })
    expect(h.store.target()).toMatchObject({ path: "src/a.ts" })

    // Without a watcher (web dev, WSL) the finished step still lands.
    h.disk["src/a.ts"] = "one\nTWO\n"
    h.store.ingestActivity([{ id: "t1", state: "done", files: ["src/a.ts"] }])
    await wait(700)
    expect(h.store.attributionsFor("src/a.ts")[0]).toMatchObject({
      agentName: "Claude Code",
      ranges: [{ start: 2, end: 2 }],
    })
    expect(h.store.cursorsFor("src/a.ts")[0]).toMatchObject({ state: "landed", line: 2 })
  })

  test("activity not read yet is not history: the first snapshot read is", async () => {
    const h = harness({ disk: { "src/old.ts": "old\n" }, external: { label: "Codex", running: true } })
    // The files view has not read the runner's record yet.
    h.store.ingestActivity(undefined)
    // Its first snapshot holds steps that finished before the view opened.
    h.store.ingestActivity([{ id: "old", state: "done", files: ["src/old.ts"] }])
    await wait(700)
    expect(h.store.cursors()).toEqual([])
    expect(h.store.attributions()).toEqual([])
    expect(h.store.target()).toBeUndefined()
    expect(h.reads).toEqual([])
  })

  test("a failed activity step clears its cursor", () => {
    const h = harness({ loaded: { "src/a.ts": "one\n" }, external: { label: "Codex", running: true } })
    // A snapshot that was read and is empty: the runner has done nothing yet,
    // so every step after it is live. (Not read yet would be undefined.)
    h.store.ingestActivity([])
    h.store.ingestActivity([{ id: "t1", state: "running", files: ["src/a.ts"] }])
    expect(h.store.cursors()).toHaveLength(1)
    h.store.ingestActivity([{ id: "t1", state: "failed", files: ["src/a.ts"] }])
    expect(h.store.cursors()).toEqual([])
  })
})

describe("helpers", () => {
  test("workspaceRelativePath keeps only paths inside the directory", () => {
    expect(workspaceRelativePath("/w/iso", "/w/iso/src/a.ts")).toBe("src/a.ts")
    expect(workspaceRelativePath("/w/iso/", "src/a.ts")).toBe("src/a.ts")
    expect(workspaceRelativePath("/w/iso", "./src/a.ts")).toBe("src/a.ts")
    expect(workspaceRelativePath("C:\\w\\iso", "C:\\w\\iso\\src\\a.ts")).toBe("src/a.ts")
    expect(workspaceRelativePath("/w/iso", "/other/a.ts")).toBeUndefined()
    expect(workspaceRelativePath("/w/iso", "../a.ts")).toBeUndefined()
    expect(workspaceRelativePath("/w/iso", "/w/iso")).toBeUndefined()
  })

  test("activityFiles reads relative paths defensively", () => {
    expect(activityFiles({ files: ["src/a.ts", "/abs.ts", "../up.ts", "./src/b.ts", 3, "src/a.ts"] })).toEqual([
      "src/a.ts",
      "src/b.ts",
    ])
    expect(activityFiles({ id: "x" })).toEqual([])
    expect(activityFiles(null)).toEqual([])
  })

  test("externalActivityEntries keeps steps that report files", () => {
    const turns = [
      {
        id: "turn1",
        activity: [
          { id: "a1", label: "Edit", kind: "tool", state: "running", files: ["src/a.ts"] },
          { id: "a2", label: "Thinking", kind: "thinking", state: "done" },
          { id: "a3", label: "Odd", state: "unknown", files: ["src/b.ts"] },
        ],
      },
      { id: "turn2" },
      null,
    ]
    expect(externalActivityEntries(turns)).toEqual([
      { id: "turn1:a1", label: "Edit", kind: "tool", state: "running", files: ["src/a.ts"] },
    ])
    expect(externalActivityEntries(undefined)).toEqual([])
  })

  test("eventFiles names the files an event touches", () => {
    expect(eventFiles({ type: "file.edited", properties: { file: "/r/a.ts" } })).toEqual(["/r/a.ts"])
    expect(eventFiles({ type: "file.watcher.updated", properties: { file: "/r/a.ts", event: "unlink" } })).toEqual([])
    const patchText = "*** Begin Patch\n*** Add File: src/n.ts\n+x\n*** Delete File: src/d.ts\n*** End Patch"
    expect(
      eventFiles({
        type: "message.part.updated",
        properties: part({ callID: "c", status: "running", tool: "apply_patch", input: { patchText } }),
      }),
    ).toEqual(["src/n.ts"])
    expect(eventFiles({ type: "message.part.updated", properties: { part: { type: "text", text: "hi" } } })).toEqual([])
  })

  test("directoryFollowSource keys files absolutely and skips build output", async () => {
    const reads: string[] = []
    const source = directoryFollowSource({
      directory: "/w/iso",
      excluded: ["node_modules"],
      peek: () => undefined,
      read: async (relative) => {
        reads.push(relative)
        return "x"
      },
    })
    expect(source.key("/w/iso/src/a.ts")).toBe("/w/iso/src/a.ts")
    expect(source.key("src/a.ts")).toBe("/w/iso/src/a.ts")
    expect(source.key("/w/iso/node_modules/x/y.js")).toBeUndefined()
    expect(source.key("/elsewhere/a.ts")).toBeUndefined()
    expect(await source.read("/w/iso/src/a.ts")).toBe("x")
    expect(reads).toEqual(["src/a.ts"])
  })

  test("messageAgent reads a loaded message, and latestTurn a session's current turn", () => {
    const messages = [
      { id: "msg_a", role: "user", agent: "build" },
      { id: "msg_b", role: "assistant", agent: "plan", parentID: "msg_a" },
      { id: "msg_c", role: "user", agent: "build" },
      { id: "msg_d", role: "assistant", agent: "build", parentID: "msg_c" },
    ]
    expect(messageAgent(messages, "msg_b")).toBe("plan")
    expect(messageAgent(messages, "missing")).toBeUndefined()
    expect(latestTurn(messages)).toBe("msg_c")
    expect(latestTurn([])).toBeUndefined()
    expect(latestTurn(undefined)).toBeUndefined()
  })

  test("sessionLineage walks up to the root and survives a cycle", () => {
    const parents: Record<string, string> = { ses_grandchild: "ses_child", ses_child: "ses_root" }
    expect(sessionLineage("ses_grandchild", (id) => parents[id])).toEqual(["ses_grandchild", "ses_child", "ses_root"])
    expect(sessionLineage("ses_root", (id) => parents[id])).toEqual(["ses_root"])
    const loop: Record<string, string> = { a: "b", b: "a" }
    expect(sessionLineage("a", (id) => loop[id])).toEqual(["a", "b"])
  })

  test("followToastDue allows one toast per turn, and one per busy stretch when turns are unknown", () => {
    expect(followToastDue(false, undefined, undefined)).toBe(true)
    expect(followToastDue(false, undefined, "msg_1")).toBe(true)
    expect(followToastDue(true, "msg_1", "msg_1")).toBe(false)
    expect(followToastDue(true, "msg_1", "msg_2")).toBe(true)
    expect(followToastDue(true, undefined, undefined)).toBe(false)
    expect(followToastDue(true, undefined, "msg_2")).toBe(false)
    expect(followToastDue(true, "msg_1", undefined)).toBe(false)
  })
})
