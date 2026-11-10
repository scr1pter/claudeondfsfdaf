import { beforeAll, describe, expect, mock, test } from "bun:test"
import type { Part } from "@vectordevai/sdk/v2"
import { readPartText } from "./message-part-text"
import {
  copyPartID,
  groupParts,
  isPendingQuestion,
  runOpen,
  runPartIDs,
  sameGroups,
  type PartGroup,
} from "./message-part-group"

let getToolInfo: typeof import("./message-part").getToolInfo

beforeAll(async () => {
  // Bun loads Solid's server build, where the router and the tooltips' popper cannot load, and the markdown worker URL
  // is a Vite import. getToolInfo uses none of them.
  mock.module("./markdown-shiki.worker.ts?worker&url", () => ({ default: "" }))
  mock.module("@solidjs/router", () => ({ useLocation: () => ({ pathname: "" }) }))
  mock.module("@vectordevai/ui/tooltip", () => ({ Tooltip: () => undefined, TooltipKeybind: () => undefined }))
  mock.module("@vectordevai/ui/v2/tooltip-v2", () => ({ TooltipV2: () => undefined }))
  getToolInfo = (await import("./message-part")).getToolInfo
})

describe("getToolInfo for terminal", () => {
  test("names the terminal by its title, then its command, its id or the action", () => {
    expect(getToolInfo("terminal", { action: "open", title: "dev server", command: "npm run dev" })).toEqual({
      icon: "console",
      title: "Terminal",
      subtitle: "dev server",
    })
    expect(getToolInfo("terminal", { action: "open", command: "npm run dev" }).subtitle).toBe("npm run dev")
    expect(getToolInfo("terminal", { action: "read", id: "pty_1" }).subtitle).toBe("pty_1")
    expect(getToolInfo("terminal", { action: "list" }).subtitle).toBe("list")
  })

  test("shows the text a type call types and the keys a keys call presses", () => {
    expect(getToolInfo("terminal", { action: "type", id: "pty_1", text: "npm test", enter: true }).subtitle).toBe(
      "npm test ⏎",
    )
    expect(getToolInfo("terminal", { action: "type", id: "pty_1", text: "y\nrm -rf build" }).subtitle).toBe(
      "y ⏎ rm -rf build",
    )
    expect(getToolInfo("terminal", { action: "type", id: "pty_1", text: "", enter: true }).subtitle).toBe("⏎")
    expect(getToolInfo("terminal", { action: "keys", id: "pty_1", keys: ["ctrl-c", "up", "enter"] }).subtitle).toBe(
      "ctrl-c up enter",
    )
    expect(getToolInfo("terminal", { action: "keys", id: "pty_1", keys: [] }).subtitle).toBe("pty_1")
  })
})

describe("readPartText", () => {
  test("returns empty string when accum is undefined and part text is undefined", () => {
    expect(readPartText(undefined, { id: "part_1" })).toBe("")
  })

  test("returns trimmed part text when accum is undefined", () => {
    expect(readPartText(undefined, { id: "part_1", text: "  hello  " })).toBe("hello")
  })

  test("prefers accum value over part text when accum has a hit", () => {
    expect(readPartText({ part_1: "  from accum  " }, { id: "part_1", text: "from part" })).toBe("from accum")
  })

  test("falls back to part text when accum misses", () => {
    expect(readPartText({ other_part: "ignored" }, { id: "part_1", text: "  from part  " })).toBe("from part")
  })

  test("returns empty string for whitespace-only text", () => {
    expect(readPartText(undefined, { id: "part_1", text: "   \n\t  " })).toBe("")
  })

  test("trims leading and trailing whitespace", () => {
    expect(readPartText(undefined, { id: "part_1", text: "\n  body  \n" })).toBe("body")
  })
})

const tool = (id: string, name: string, messageID = "m1"): Part => ({
  id,
  sessionID: "s1",
  messageID,
  type: "tool",
  callID: `call-${id}`,
  tool: name,
  state: { status: "pending", input: {}, raw: "" },
})
const text = (id: string, messageID = "m1"): Part => ({ id, sessionID: "s1", messageID, type: "text", text: id })
const reasoning = (id: string, messageID = "m1"): Part => ({
  id,
  sessionID: "s1",
  messageID,
  type: "reasoning",
  text: id,
  time: { start: 0 },
})
const items = (...parts: Part[]) => parts.map((part) => ({ messageID: part.messageID, part }))
const part = (id: string, messageID = "m1"): PartGroup => ({
  key: `part:${messageID}:${id}`,
  type: "part",
  ref: { messageID, partID: id },
})
// "m2/t1" names a part of message m2; a bare id belongs to m1.
const refs = (...ids: string[]) =>
  ids.map((id) => {
    const [messageID, partID] = id.includes("/") ? id.split("/") : ["m1", id]
    return { messageID: messageID!, partID: partID! }
  })
const context = (...ids: string[]): PartGroup => ({
  key: `context:${refs(ids[0]!)[0]!.partID}`,
  type: "context",
  refs: refs(...ids),
})
const run = (...ids: string[]): PartGroup => ({
  key: `computer:${refs(ids[0]!)[0]!.partID}`,
  type: "computer",
  refs: refs(...ids),
})
const keys = (groups: PartGroup[]) => groups.map((group) => group.key)

// Pinned against the grouping before computer runs existed: ordinary sessions must keep every key and boundary, or
// every row of every session remounts.
describe("groupParts without computer parts", () => {
  test("ordinary parts each keep a part key", () => {
    expect(groupParts(items(text("t1"), tool("b1", "bash"), reasoning("r1"), text("t2")))).toEqual([
      part("t1"),
      part("b1"),
      part("r1"),
      part("t2"),
    ])
  })

  test("a single context tool is a context group of one", () => {
    expect(groupParts(items(text("t1"), tool("g1", "grep"), text("t2")))).toEqual([
      part("t1"),
      context("g1"),
      part("t2"),
    ])
  })

  test("a context run spanning messages is keyed by its first member", () => {
    expect(
      groupParts(items(tool("r1", "read", "m1"), tool("g1", "glob", "m2"), tool("l1", "list", "m2"), text("t1", "m2"))),
    ).toEqual([context("m1/r1", "m2/g1", "m2/l1"), part("t1", "m2")])
  })

  test("a context run at the end is flushed, and text between context tools splits them", () => {
    expect(groupParts(items(tool("r1", "read"), text("t1"), tool("r2", "read"), tool("g2", "grep")))).toEqual([
      context("r1"),
      part("t1"),
      context("r2", "g2"),
    ])
  })

  test("the open flag changes nothing without a computer run", () => {
    const parts = items(text("t1"), tool("r1", "read"), tool("b1", "bash"), text("t2"))
    expect(groupParts(parts, true)).toEqual(groupParts(parts))
    expect(groupParts([])).toEqual([])
  })
})

describe("groupParts computer runs", () => {
  test("computer parts and the text between them form one run", () => {
    expect(
      groupParts(
        items(
          text("lead"),
          tool("c1", "computer"),
          text("t2"),
          reasoning("r2"),
          tool("c2", "computer"),
          text("t3"),
          tool("c3", "computer"),
          text("done"),
        ),
      ),
    ).toEqual([part("lead"), run("c1", "t2", "r2", "c2", "t3", "c3"), part("done")])
  })

  test("a run continues across assistant messages", () => {
    expect(groupParts(items(tool("c1", "computer", "m1"), text("t2", "m2"), tool("c2", "computer", "m2")))).toEqual([
      run("m1/c1", "m2/t2", "m2/c2"),
    ])
  })

  test("a non-computer tool part splits the run and the notes before it stay ordinary rows", () => {
    expect(
      groupParts(items(tool("c1", "computer"), text("t2"), tool("b1", "bash"), text("t3"), tool("c2", "computer"))),
    ).toEqual([run("c1"), part("t2"), part("b1"), part("t3"), run("c2")])
  })

  test("a context tool closes the run before its own group", () => {
    expect(groupParts(items(tool("c1", "computer"), tool("r1", "read"), tool("c2", "computer")))).toEqual([
      run("c1"),
      context("r1"),
      run("c2"),
    ])
  })

  test("while the turn works, notes after the latest step stay in the run until something else follows", () => {
    const live = items(tool("c1", "computer"), text("t2"))
    expect(groupParts(live, true)).toEqual([run("c1", "t2")])
    expect(groupParts(live)).toEqual([run("c1"), part("t2")])
    expect(groupParts(items(tool("c1", "computer"), text("t2"), tool("b1", "bash")), true)).toEqual([
      run("c1"),
      part("t2"),
      part("b1"),
    ])
  })

  // A provider turn streams its narration before its tool call. Replaying a live run must never mount a note as its
  // own row and then remove it: the card keeps its key and the notes stay in it until the turn ends.
  test("a live run grows in place without inserting and removing a row per step", () => {
    const c1 = tool("c1", "computer")
    const t2 = text("t2")
    const c2 = tool("c2", "computer")
    const t3 = text("t3")
    const states = [[c1], [c1, t2], [c1, t2, c2], [c1, t2, c2, t3]].map((parts) => groupParts(items(...parts), true))
    expect(states.map(keys)).toEqual([["computer:c1"], ["computer:c1"], ["computer:c1"], ["computer:c1"]])
    expect(states.at(-1)).toEqual([run("c1", "t2", "c2", "t3")])
    expect(groupParts(items(c1, t2, c2, t3))).toEqual([run("c1", "t2", "c2"), part("t3")])
  })

  // A question renders nothing until it is answered, so it never reaches groupParts and cannot close the run by
  // following it. The agent's words leading up to it must show while it waits, not hide in the collapsed card.
  test("a question the turn waits on closes the live run, so the words before it are their own row", () => {
    const question = (status: "pending" | "running" | "completed" | "error"): Part => ({
      id: "q1",
      sessionID: "s1",
      messageID: "m1",
      type: "tool",
      callID: "call-q1",
      tool: "question",
      state:
        status === "pending"
          ? { status, input: {}, raw: "" }
          : status === "running"
            ? { status, input: {}, time: { start: 0 } }
            : status === "completed"
              ? { status, input: {}, output: "", title: "", metadata: {}, time: { start: 0, end: 1 } }
              : { status, input: {}, error: "dismissed", time: { start: 0, end: 1 } },
    })
    const c1 = tool("c1", "computer")
    const t2 = text("t2")
    for (const status of ["pending", "running"] as const) {
      expect(isPendingQuestion(question(status))).toBe(true)
      expect(runOpen(true, [[c1], [t2, question(status)]])).toBe(false)
      expect(groupParts(items(c1, t2), runOpen(true, [[c1, t2, question(status)]]))).toEqual([run("c1"), part("t2")])
    }
    for (const status of ["completed", "error"] as const) {
      expect(isPendingQuestion(question(status))).toBe(false)
      expect(runOpen(true, [[c1, t2, question(status)]])).toBe(true)
    }
    expect(isPendingQuestion(tool("b1", "bash"))).toBe(false)
    expect(runOpen(true, [[c1, t2, tool("b1", "bash")]])).toBe(true)
    expect(runOpen(false, [[c1, t2]])).toBe(false)
    expect(runOpen(undefined, [[c1, t2]])).toBe(false)
    expect(groupParts(items(c1, t2), runOpen(true, [[c1, t2]]))).toEqual([run("c1", "t2")])
  })

  test("toggling reasoning summaries changes the run's members but not its key", () => {
    const shown = groupParts(items(tool("c1", "computer"), reasoning("r2"), tool("c2", "computer")))
    const hidden = groupParts(items(tool("c1", "computer"), tool("c2", "computer")))
    expect(keys(shown)).toEqual(keys(hidden))
    expect(sameGroups(shown, hidden)).toBe(false)
  })

  test("sameGroups compares computer groups by key, type and members", () => {
    const a = groupParts(items(tool("c1", "computer"), text("t2"), tool("c2", "computer")))
    expect(sameGroups(a, groupParts(items(tool("c1", "computer"), text("t2"), tool("c2", "computer"))))).toBe(true)
    expect(sameGroups(a, groupParts(items(tool("c1", "computer"), tool("c2", "computer"))))).toBe(false)
    expect(sameGroups([run("c1")], [{ ...context("c1"), key: "computer:c1" }])).toBe(false)
  })
})

// The copy button also carries the turn's details and reply footer, so it lands on a text part with its own row, or on
// the last note when every text is inside run cards, whose card then draws it.
describe("copyPartID", () => {
  test("a note inside a run card takes the turn's copy target only when no text has a row of its own", () => {
    const turn = [text("t1"), tool("c1", "computer"), text("t2"), tool("c2", "computer")]
    const groups = groupParts(items(...turn))
    expect(groups).toEqual([part("t1"), run("c1", "t2", "c2")])
    expect(copyPartID([turn], runPartIDs(groups))).toBe("t1")
    // Text after the run is its own row once the turn ends, so it is the target.
    const closed = [...turn, text("t3")]
    expect(copyPartID([closed], runPartIDs(groupParts(items(...closed))))).toBe("t3")
    // A turn whose only text is inside runs keeps its footer on the last note, which its run card draws.
    const inside = [tool("c1", "computer"), text("t2"), tool("c2", "computer"), text("t3"), tool("c3", "computer")]
    const held = runPartIDs(groupParts(items(...inside)))
    expect(held.has("t3")).toBe(true)
    expect(copyPartID([inside], held)).toBe("t3")
    // A turn of only tool calls has none.
    const tools = [tool("c1", "computer"), tool("c2", "computer")]
    expect(copyPartID([tools], runPartIDs(groupParts(items(...tools))))).toBeUndefined()
  })

  test("the target is the turn's last text with its own row across messages, skipping empty text", () => {
    const first = [text("t1"), tool("c1", "computer")]
    const second = [text("t2", "m2"), tool("c2", "computer", "m2"), text("t3", "m2")]
    const blank = { ...text("t4", "m2"), text: "  " }
    const groups = groupParts(items(...first, ...second))
    expect(copyPartID([first, [...second, blank]], runPartIDs(groups))).toBe("t3")
    expect(
      copyPartID([first, second.slice(0, 2)], runPartIDs(groupParts(items(...first, ...second.slice(0, 2))))),
    ).toBe("t1")
    // Without a run every text part has its own row, as before runs existed.
    expect(copyPartID([[text("t1"), tool("r1", "read"), text("t2")]], runPartIDs([]))).toBe("t2")
  })
})
