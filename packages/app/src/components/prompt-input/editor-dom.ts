import type { AgentPart, ComputerPart, FileAttachmentPart, Prompt } from "@/context/prompt"

const MAX_BREAKS = 200

export function createTextFragment(content: string): DocumentFragment {
  const fragment = document.createDocumentFragment()
  let breaks = 0
  for (const char of content) {
    if (char !== "\n") continue
    breaks += 1
    if (breaks > MAX_BREAKS) {
      const tail = content.endsWith("\n")
      const text = tail ? content.slice(0, -1) : content
      if (text) fragment.appendChild(document.createTextNode(text))
      if (tail) fragment.appendChild(document.createElement("br"))
      return fragment
    }
  }

  const segments = content.split("\n")
  segments.forEach((segment, index) => {
    if (segment) {
      fragment.appendChild(document.createTextNode(segment))
    }
    if (index < segments.length - 1) {
      fragment.appendChild(document.createElement("br"))
    }
  })
  return fragment
}

export function getNodeLength(node: Node): number {
  if (node.nodeType === Node.ELEMENT_NODE && (node as HTMLElement).tagName === "BR") return 1
  return (node.textContent ?? "").replace(/\u200B/g, "").length
}

export function getTextLength(node: Node): number {
  if (node.nodeType === Node.TEXT_NODE) return (node.textContent ?? "").replace(/\u200B/g, "").length
  if (node.nodeType === Node.ELEMENT_NODE && (node as HTMLElement).tagName === "BR") return 1
  let length = 0
  for (const child of Array.from(node.childNodes)) {
    length += getTextLength(child)
  }
  return length
}

export function getCursorPosition(parent: HTMLElement): number {
  const selection = window.getSelection()
  if (!selection || selection.rangeCount === 0) return 0
  const range = selection.getRangeAt(0)
  if (!parent.contains(range.startContainer)) return 0
  const preCaretRange = range.cloneRange()
  preCaretRange.selectNodeContents(parent)
  preCaretRange.setEnd(range.startContainer, range.startOffset)
  return getTextLength(preCaretRange.cloneContents())
}

export function setCursorPosition(parent: HTMLElement, position: number) {
  let remaining = position
  let node = parent.firstChild
  while (node) {
    const length = getNodeLength(node)
    const isText = node.nodeType === Node.TEXT_NODE
    const isPill =
      node.nodeType === Node.ELEMENT_NODE &&
      ["file", "agent", "computer"].includes((node as HTMLElement).dataset.type ?? "")
    const isBreak = node.nodeType === Node.ELEMENT_NODE && (node as HTMLElement).tagName === "BR"

    if (isText && remaining <= length) {
      const range = document.createRange()
      const selection = window.getSelection()
      range.setStart(node, remaining)
      range.collapse(true)
      selection?.removeAllRanges()
      selection?.addRange(range)
      return
    }

    if ((isPill || isBreak) && remaining <= length) {
      const range = document.createRange()
      const selection = window.getSelection()
      if (remaining === 0) {
        range.setStartBefore(node)
      }
      if (remaining > 0 && isPill) {
        range.setStartAfter(node)
      }
      if (remaining > 0 && isBreak) {
        const next = node.nextSibling
        if (next && next.nodeType === Node.TEXT_NODE) {
          range.setStart(next, 0)
        }
        if (!next || next.nodeType !== Node.TEXT_NODE) {
          range.setStartAfter(node)
        }
      }
      range.collapse(true)
      selection?.removeAllRanges()
      selection?.addRange(range)
      return
    }

    remaining -= length
    node = node.nextSibling
  }

  const fallbackRange = document.createRange()
  const fallbackSelection = window.getSelection()
  const last = parent.lastChild
  if (last && last.nodeType === Node.TEXT_NODE) {
    const len = last.textContent ? last.textContent.length : 0
    fallbackRange.setStart(last, len)
  }
  if (!last || last.nodeType !== Node.TEXT_NODE) {
    fallbackRange.selectNodeContents(parent)
  }
  fallbackRange.collapse(false)
  fallbackSelection?.removeAllRanges()
  fallbackSelection?.addRange(fallbackRange)
}

export function setRangeEdge(parent: HTMLElement, range: Range, edge: "start" | "end", offset: number) {
  let remaining = offset
  const nodes = Array.from(parent.childNodes)

  for (const node of nodes) {
    const length = getNodeLength(node)
    const isText = node.nodeType === Node.TEXT_NODE
    const isPill =
      node.nodeType === Node.ELEMENT_NODE &&
      ["file", "agent", "computer"].includes((node as HTMLElement).dataset.type ?? "")
    const isBreak = node.nodeType === Node.ELEMENT_NODE && (node as HTMLElement).tagName === "BR"

    if (isText && remaining <= length) {
      if (edge === "start") range.setStart(node, remaining)
      if (edge === "end") range.setEnd(node, remaining)
      return
    }

    if ((isPill || isBreak) && remaining <= length) {
      if (edge === "start" && remaining === 0) range.setStartBefore(node)
      if (edge === "start" && remaining > 0) range.setStartAfter(node)
      if (edge === "end" && remaining === 0) range.setEndBefore(node)
      if (edge === "end" && remaining > 0) range.setEndAfter(node)
      return
    }

    remaining -= length
  }
}

export function createPill(part: FileAttachmentPart | AgentPart | ComputerPart) {
  const pill = document.createElement("span")
  pill.textContent = part.content
  pill.setAttribute("data-type", part.type)
  if (part.type === "file") {
    pill.setAttribute("data-path", part.path)
    if (part.mime) pill.setAttribute("data-mime", part.mime)
    if (part.filename) pill.setAttribute("data-filename", part.filename)
    if (part.url) pill.setAttribute("data-url", part.url)
    if (part.source?.type === "resource") {
      pill.setAttribute("data-source-type", part.source.type)
      pill.setAttribute("data-source-client-name", part.source.clientName)
      pill.setAttribute("data-source-uri", part.source.uri)
    }
  }
  if (part.type === "agent") pill.setAttribute("data-name", part.name)
  if (part.type === "computer" && part.app) {
    pill.setAttribute("data-app-key", part.app.key)
    pill.setAttribute("data-app-name", part.app.name)
  }
  pill.setAttribute("contenteditable", "false")
  pill.style.userSelect = "text"
  pill.style.cursor = "default"
  return pill
}

export const isNormalizedEditor = (editor: HTMLElement) =>
  Array.from(editor.childNodes).every((node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      const text = node.textContent ?? ""
      if (!text.includes("\u200B")) return true
      if (text !== "\u200B") return false

      const prev = node.previousSibling
      const next = node.nextSibling
      const prevIsBr = prev?.nodeType === Node.ELEMENT_NODE && (prev as HTMLElement).tagName === "BR"
      return !!prevIsBr && !next
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return false
    const el = node as HTMLElement
    if (el.dataset.type === "file") return true
    if (el.dataset.type === "agent") return true
    if (el.dataset.type === "computer")
      return el.getAttribute("contenteditable") === "false" && computerApp(el) !== false
    return el.tagName === "BR"
  })

export function parsePromptFromDOM(editor: HTMLElement): Prompt {
  const parts: Prompt = []
  let position = 0
  let buffer = ""

  const flushText = () => {
    let content = buffer
    if (content.includes("\r")) content = content.replace(/\r\n?/g, "\n")
    if (content.includes("\u200B")) content = content.replace(/\u200B/g, "")
    buffer = ""
    if (!content) return
    parts.push({ type: "text", content, start: position, end: position + content.length })
    position += content.length
  }

  const pushFile = (file: HTMLElement) => {
    const content = file.textContent ?? ""
    const source =
      file.dataset.sourceType === "resource" && file.dataset.sourceClientName && file.dataset.sourceUri
        ? {
            type: "resource" as const,
            text: {
              value: content,
              start: position,
              end: position + content.length,
            },
            clientName: file.dataset.sourceClientName,
            uri: file.dataset.sourceUri,
          }
        : undefined
    parts.push({
      type: "file",
      path: file.dataset.path!,
      content,
      start: position,
      end: position + content.length,
      ...(file.dataset.mime ? { mime: file.dataset.mime } : {}),
      ...(file.dataset.filename ? { filename: file.dataset.filename } : {}),
      ...(file.dataset.url ? { url: file.dataset.url } : {}),
      ...(source ? { source } : {}),
    })
    position += content.length
  }

  const pushAgent = (agent: HTMLElement) => {
    const content = agent.textContent ?? ""
    parts.push({
      type: "agent",
      name: agent.dataset.name!,
      content,
      start: position,
      end: position + content.length,
    })
    position += content.length
  }

  const visit = (node: Node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      buffer += node.textContent ?? ""
      return
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return

    const el = node as HTMLElement
    if (el.dataset.type === "file") {
      flushText()
      pushFile(el)
      return
    }
    if (el.dataset.type === "agent") {
      flushText()
      pushAgent(el)
      return
    }
    if (el.dataset.type === "computer") {
      const app = computerApp(el)
      const content = el.textContent ?? ""
      if (app === false || el.getAttribute("contenteditable") !== "false") {
        buffer += content
        return
      }
      flushText()
      parts.push({
        type: "computer",
        content,
        start: position,
        end: position + content.length,
        ...(app ? { app } : {}),
      })
      position += content.length
      return
    }
    if (el.tagName === "BR") {
      buffer += "\n"
      return
    }

    for (const child of Array.from(el.childNodes)) {
      visit(child)
    }
  }

  const children = Array.from(editor.childNodes)
  children.forEach((child, index) => {
    const isBlock = child.nodeType === Node.ELEMENT_NODE && ["DIV", "P"].includes((child as HTMLElement).tagName)
    visit(child)
    if (isBlock && index < children.length - 1) {
      buffer += "\n"
    }
  })

  flushText()

  if (parts.length === 0) parts.push({ type: "text", content: "", start: 0, end: 0 })
  return parts
}

// Missing both attributes denotes the feature pill. A partial app identity must stay ordinary text instead of
// silently becoming a different computer hint during normalization or a paste round-trip.
function computerApp(pill: HTMLElement): ComputerPart["app"] | false {
  const key = pill.dataset.appKey
  const name = pill.dataset.appName
  if (key === undefined && name === undefined) return undefined
  if (!key?.trim() || !name?.trim()) return false
  return { key, name }
}
