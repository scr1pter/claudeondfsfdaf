import { beforeAll, describe, expect, mock, test } from "bun:test"
import { readPartText } from "./message-part-text"

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
