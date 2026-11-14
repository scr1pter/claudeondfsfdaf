import { Schema } from "effect"
import type { AgentPart as MessageAgentPart, FilePart, Part, TextPart } from "@vectordevai/sdk/v2"
import { Computer } from "@vectordevai/schema/computer"
import { Hands } from "@vectordevai/schema/hands"
import type { AgentPart, ComputerPart, FileAttachmentPart, ImageAttachmentPart, Prompt } from "@/context/prompt"

type Inline =
  | {
      type: "file"
      start: number
      end: number
      value: string
      path: string
      selection?: {
        startLine: number
        endLine: number
        startChar: number
        endChar: number
      }
    }
  | {
      type: "agent"
      start: number
      end: number
      value: string
      name: string
    }
  | {
      type: "computer"
      start: number
      end: number
      value: string
      app?: { key: string; name: string }
    }

function selectionFromFileUrl(url: string): Extract<Inline, { type: "file" }>["selection"] {
  const queryIndex = url.indexOf("?")
  if (queryIndex === -1) return undefined
  const params = new URLSearchParams(url.slice(queryIndex + 1))
  const startLine = Number(params.get("start"))
  const endLine = Number(params.get("end"))
  if (!Number.isFinite(startLine) || !Number.isFinite(endLine)) return undefined
  return {
    startLine,
    endLine,
    startChar: 0,
    endChar: 0,
  }
}

function textPartValue(parts: Part[]) {
  const candidates = parts
    .filter((part): part is TextPart => part.type === "text")
    .filter((part) => !part.synthetic && !part.ignored)
  return candidates.reduce((best: TextPart | undefined, part) => {
    if (!best) return part
    if (part.text.length > best.text.length) return part
    return best
  }, undefined)
}

/**
 * Extract prompt content from message parts for restoring into the prompt input.
 * This is used by undo to restore the original user prompt.
 */
export function extractPromptFromParts(parts: Part[], opts?: { directory?: string; attachmentName?: string }): Prompt {
  const textPart = textPartValue(parts)
  const text = textPart?.text ?? ""
  const directory = opts?.directory
  const attachmentName = opts?.attachmentName ?? "attachment"

  const toRelative = (path: string) => {
    if (!directory) return path

    const prefix = directory.endsWith("/") ? directory : directory + "/"
    if (path.startsWith(prefix)) return path.slice(prefix.length)

    if (path.startsWith(directory)) {
      const next = path.slice(directory.length)
      if (next.startsWith("/")) return next.slice(1)
      return next
    }

    return path
  }

  const inline: Inline[] = []
  const images: ImageAttachmentPart[] = []
  const markers: Computer.MentionMarker[] = []

  for (const part of parts) {
    // Only a schema-valid synthetic marker restores a computer pill; nothing is inferred from typed "@" text.
    if (Schema.is(Computer.MentionPart)(part)) {
      markers.push(part.metadata[Hands.MARKER])
      continue
    }

    if (part.type === "file") {
      const filePart = part as FilePart
      const sourceText = filePart.source?.text
      if (sourceText) {
        const value = sourceText.value
        const start = sourceText.start
        const end = sourceText.end
        let path = value
        if (value.startsWith("@")) path = value.slice(1)
        if (!value.startsWith("@") && filePart.source && "path" in filePart.source) {
          path = filePart.source.path
        }
        inline.push({
          type: "file",
          start,
          end,
          value,
          path: toRelative(path),
          selection: selectionFromFileUrl(filePart.url),
        })
        continue
      }

      if (filePart.url.startsWith("data:")) {
        images.push({
          type: "image",
          id: filePart.id,
          filename: filePart.filename ?? attachmentName,
          mime: filePart.mime,
          dataUrl: filePart.url,
        })
      }
    }

    if (part.type === "agent") {
      const agentPart = part as MessageAgentPart
      const source = agentPart.source
      if (!source) continue
      inline.push({
        type: "agent",
        start: source.start,
        end: source.end,
        value: source.value,
        name: agentPart.name,
      })
    }
  }

  inline.sort((a, b) => {
    if (a.start !== b.start) return a.start - b.start
    return a.end - b.end
  })

  // File and agent pills keep their recorded places first.
  const placed: Inline[] = []
  let cursor = 0
  for (const item of inline) {
    if (item.start < 0 || item.end < item.start) continue

    const expected = item.value
    if (!expected) continue

    const mismatch = item.end > text.length || item.start < cursor || text.slice(item.start, item.end) !== expected
    const start = mismatch ? text.indexOf(expected, cursor) : item.start
    if (start === -1) continue
    const end = mismatch ? start + expected.length : item.end

    placed.push({ ...item, start, end })
    cursor = end
  }

  // Each marker, in order, takes the next exact "@Name" in text no other pill holds. One with no such text restores
  // no pill, and that text stays plain.
  const claimed = (start: number, end: number) => placed.some((item) => start < item.end && end > item.start)
  let from = 0
  for (const marker of markers) {
    const value = marker.kind === "feature" ? `@${Hands.MENTION}` : `@${marker.name}`
    const start = unclaimed(text, value, from, claimed)
    if (start === undefined) continue
    placed.push({
      type: "computer",
      start,
      end: start + value.length,
      value,
      ...(marker.kind === "app" ? { app: { key: marker.key, name: marker.name } } : {}),
    })
    from = start + value.length
  }

  const result: Prompt = []
  let position = 0

  const pushText = (content: string) => {
    if (!content) return
    result.push({
      type: "text",
      content,
      start: position,
      end: position + content.length,
    })
    position += content.length
  }

  const pushFile = (item: Extract<Inline, { type: "file" }>) => {
    const content = item.value
    const attachment: FileAttachmentPart = {
      type: "file",
      path: item.path,
      content,
      start: position,
      end: position + content.length,
      selection: item.selection,
    }
    result.push(attachment)
    position += content.length
  }

  const pushAgent = (item: Extract<Inline, { type: "agent" }>) => {
    const content = item.value
    const mention: AgentPart = {
      type: "agent",
      name: item.name,
      content,
      start: position,
      end: position + content.length,
    }
    result.push(mention)
    position += content.length
  }

  const pushComputer = (item: Extract<Inline, { type: "computer" }>) => {
    const content = item.value
    const mention: ComputerPart = {
      type: "computer",
      content,
      start: position,
      end: position + content.length,
      ...(item.app ? { app: { ...item.app } } : {}),
    }
    result.push(mention)
    position += content.length
  }

  let consumed = 0
  for (const item of placed.toSorted((a, b) => a.start - b.start)) {
    pushText(text.slice(consumed, item.start))

    if (item.type === "file") pushFile(item)
    if (item.type === "agent") pushAgent(item)
    if (item.type === "computer") pushComputer(item)

    consumed = item.end
  }

  pushText(text.slice(consumed))

  if (result.length === 0) {
    result.push({ type: "text", content: "", start: 0, end: 0 })
  }

  if (images.length === 0) return result
  return [...result, ...images]
}

const WORD = /[\p{L}\p{N}_]/u

// The first place from `from` where `value` stands whole (not the start of a longer word) outside claimed text.
function unclaimed(text: string, value: string, from: number, claimed: (start: number, end: number) => boolean) {
  for (let at = text.indexOf(value, from); at !== -1; at = text.indexOf(value, at + 1)) {
    if (!claimed(at, at + value.length) && !WORD.test(text[at + value.length] ?? "")) return at
  }
}
