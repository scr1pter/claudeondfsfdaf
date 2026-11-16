import { describe, expect, test } from "bun:test"
import type { ComputerPart, Prompt } from "@/context/prompt"
import { Hands } from "@vectordevai/schema/hands"
import {
  createPill,
  createTextFragment,
  getCursorPosition,
  getNodeLength,
  getTextLength,
  isNormalizedEditor,
  parsePromptFromDOM,
  setCursorPosition,
  setRangeEdge,
} from "./editor-dom"

describe("prompt-input editor dom", () => {
  test("createTextFragment preserves newlines with consecutive br nodes", () => {
    const fragment = createTextFragment("foo\n\nbar")
    const container = document.createElement("div")
    container.appendChild(fragment)

    expect(container.childNodes.length).toBe(4)
    expect(container.childNodes[0]?.textContent).toBe("foo")
    expect((container.childNodes[1] as HTMLElement).tagName).toBe("BR")
    expect((container.childNodes[2] as HTMLElement).tagName).toBe("BR")
    expect(container.childNodes[3]?.textContent).toBe("bar")
  })

  test("createTextFragment keeps trailing newline as terminal break", () => {
    const fragment = createTextFragment("foo\n")
    const container = document.createElement("div")
    container.appendChild(fragment)

    expect(container.childNodes.length).toBe(2)
    expect(container.childNodes[0]?.textContent).toBe("foo")
    expect((container.childNodes[1] as HTMLElement).tagName).toBe("BR")
  })

  test("createTextFragment avoids break-node explosion for large multiline content", () => {
    const content = Array.from({ length: 220 }, () => "line").join("\n")
    const fragment = createTextFragment(content)
    const container = document.createElement("div")
    container.appendChild(fragment)

    expect(container.childNodes.length).toBe(1)
    expect(container.childNodes[0]?.nodeType).toBe(Node.TEXT_NODE)
    expect(container.textContent).toBe(content)
  })

  test("createTextFragment keeps terminal break in large multiline fallback", () => {
    const content = `${Array.from({ length: 220 }, () => "line").join("\n")}\n`
    const fragment = createTextFragment(content)
    const container = document.createElement("div")
    container.appendChild(fragment)

    expect(container.childNodes.length).toBe(2)
    expect(container.childNodes[0]?.textContent).toBe(content.slice(0, -1))
    expect((container.childNodes[1] as HTMLElement).tagName).toBe("BR")
  })

  test("length helpers treat breaks as one char and ignore zero-width chars", () => {
    const container = document.createElement("div")
    container.appendChild(document.createTextNode("ab\u200B"))
    container.appendChild(document.createElement("br"))
    container.appendChild(document.createTextNode("cd"))

    expect(getNodeLength(container.childNodes[0]!)).toBe(2)
    expect(getNodeLength(container.childNodes[1]!)).toBe(1)
    expect(getTextLength(container)).toBe(5)
  })

  test("setCursorPosition and getCursorPosition round-trip with pills and breaks", () => {
    const container = document.createElement("div")
    const pill = document.createElement("span")
    pill.dataset.type = "file"
    pill.textContent = "@file"
    container.appendChild(document.createTextNode("ab"))
    container.appendChild(pill)
    container.appendChild(document.createElement("br"))
    container.appendChild(document.createTextNode("cd"))
    document.body.appendChild(container)

    setCursorPosition(container, 2)
    expect(getCursorPosition(container)).toBe(2)

    setCursorPosition(container, 7)
    expect(getCursorPosition(container)).toBe(7)

    setCursorPosition(container, 8)
    expect(getCursorPosition(container)).toBe(8)

    container.remove()
  })

  test("setCursorPosition and getCursorPosition round-trip across blank lines", () => {
    const container = document.createElement("div")
    container.appendChild(document.createTextNode("a"))
    container.appendChild(document.createElement("br"))
    container.appendChild(document.createElement("br"))
    container.appendChild(document.createTextNode("b"))
    document.body.appendChild(container)

    setCursorPosition(container, 2)
    expect(getCursorPosition(container)).toBe(2)

    setCursorPosition(container, 3)
    expect(getCursorPosition(container)).toBe(3)

    container.remove()
  })

  test("feature and app computer pills round-trip alongside file, resource, agent and multiline text", () => {
    const content = `@${Hands.MENTION}`
    const values: Prompt = [
      { type: "text", content: "Use ", start: 0, end: 0 },
      { type: "computer", content, start: 0, end: 0 },
      { type: "text", content: " in\n", start: 0, end: 0 },
      {
        type: "computer",
        content: "@Notes",
        app: { key: "app:macos:com.apple.notes", name: "Notes" },
        start: 0,
        end: 0,
      },
      { type: "file", content: "@src/index.ts", path: "src/index.ts", start: 0, end: 0 },
      { type: "agent", content: "@explore", name: "explore", start: 0, end: 0 },
      {
        type: "file",
        content: "@resource",
        path: "mcp://notes/resource",
        mime: "text/plain",
        filename: "notes.txt",
        url: "mcp://notes/resource",
        start: 0,
        end: 0,
        source: {
          type: "resource",
          clientName: "notes",
          uri: "notes://resource",
          text: { value: "@resource", start: 0, end: 0 },
        },
      },
      { type: "text", content: "\n", start: 0, end: 0 },
    ]
    let position = 0
    const expected = values.map((part) => {
      if (part.type === "image") return part
      const next = { ...part, start: position, end: position + part.content.length }
      position = next.end
      if (next.type === "file" && next.source?.type === "resource") {
        next.source = { ...next.source, text: { value: next.content, start: next.start, end: next.end } }
      }
      return next
    })
    const editor = document.createElement("div")
    for (const part of expected) {
      if (part.type === "image") continue
      editor.append(part.type === "text" ? createTextFragment(part.content) : createPill(part))
    }
    editor.append(document.createTextNode("\u200B"))
    expect(isNormalizedEditor(editor)).toBe(true)
    expect(parsePromptFromDOM(editor)).toEqual(expected)
    expect(editor.querySelectorAll('[data-type="computer"][contenteditable="false"]')).toHaveLength(2)
    expect(editor.querySelector('[data-type="computer"]')?.hasAttribute("data-app-key")).toBe(false)
  })

  test("computer names and keys remain literal data, and typing the same text does not create a pill", () => {
    const part: ComputerPart = {
      type: "computer",
      content: '@<img src=x onerror="run()">',
      start: 0,
      end: 28,
      app: { key: 'app:windows:c:\\Apps\\A&B".exe', name: '<img src=x onerror="run()">' },
    }
    part.end = part.content.length
    const editor = document.createElement("div")
    editor.append(createPill(part))
    expect(editor.querySelector("img")).toBeNull()
    expect(parsePromptFromDOM(editor)).toEqual([part])
    editor.replaceChildren(document.createTextNode(part.content))
    expect(parsePromptFromDOM(editor)).toEqual([{ type: "text", content: part.content, start: 0, end: part.end }])
  })

  test("partial or editable app pills normalize to text without becoming feature hints", () => {
    for (const attributes of [
      { "data-app-key": "app:macos:com.apple.notes" },
      { "data-app-name": "Notes" },
      { "data-app-key": "", "data-app-name": "Notes" },
      { "data-app-key": "app:macos:com.apple.notes", "data-app-name": "  " },
      { contenteditable: "true" },
    ]) {
      const editor = document.createElement("div")
      const pill = createPill({ type: "computer", content: "@Notes", start: 0, end: 6 })
      for (const [name, value] of Object.entries(attributes)) pill.setAttribute(name, value)
      editor.append("before ", pill, " after")
      expect(isNormalizedEditor(editor)).toBe(false)
      expect(parsePromptFromDOM(editor)).toEqual([{ type: "text", content: "before @Notes after", start: 0, end: 19 }])
    }
  })

  test("cursor and range edges treat computer pills atomically, including deletion", () => {
    const editor = document.createElement("div")
    const pill = createPill({
      type: "computer",
      content: "@Notes",
      start: 2,
      end: 8,
      app: { key: "app:macos:com.apple.notes", name: "Notes" },
    })
    editor.append("a ", pill, " z")
    document.body.append(editor)
    try {
      setCursorPosition(editor, 2)
      expect(getCursorPosition(editor)).toBe(2)
      setCursorPosition(editor, 3)
      expect(getCursorPosition(editor)).toBe(8)
      expect(window.getSelection()?.anchorNode).toBe(editor)
      setCursorPosition(editor, 8)
      expect(getCursorPosition(editor)).toBe(8)
      const range = document.createRange()
      setRangeEdge(editor, range, "start", 2)
      setRangeEdge(editor, range, "end", 4)
      expect(range.toString()).toBe("@Notes")
      range.deleteContents()
      expect(editor.querySelector('[data-type="computer"]')).toBeNull()
      expect(parsePromptFromDOM(editor)).toEqual([{ type: "text", content: "a  z", start: 0, end: 4 }])
    } finally {
      window.getSelection()?.removeAllRanges()
      editor.remove()
    }
  })
})
