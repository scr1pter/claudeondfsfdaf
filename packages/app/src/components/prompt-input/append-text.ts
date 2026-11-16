import type { ContentPart, ImageAttachmentPart, Prompt } from "@/context/prompt"

type Inline = Exclude<ContentPart, ImageAttachmentPart>

/**
 * The prompt after dictation adds a transcript: every file, agent and computer pill keeps its place and identity,
 * images stay last, and the transcript follows the last text after one space. Undefined for a blank transcript.
 */
export function appendPromptText(prompt: Prompt, transcript: string): { prompt: Prompt; cursor: number } | undefined {
  const addition = transcript.trim()
  if (!addition) return
  const inline = prompt.filter((part): part is Inline => part.type !== "image")
  const images = prompt.filter((part): part is ImageAttachmentPart => part.type === "image")
  // Only the trailing whitespace before the transcript collapses into the one space that joins them.
  const last = inline.at(-1)
  const trimmed = last?.type === "text" ? last.content.trimEnd() : undefined
  const kept =
    trimmed === undefined ? inline : [...inline.slice(0, -1), ...(trimmed ? [{ ...last!, content: trimmed }] : [])]
  const joined = kept.some((part) => part.content) ? ` ${addition}` : addition
  const tail = kept.at(-1)
  const parts: Inline[] =
    tail?.type === "text"
      ? [...kept.slice(0, -1), { ...tail, content: tail.content + joined }]
      : [...kept, { type: "text", content: joined, start: 0, end: 0 }]
  let position = 0
  const next = parts.map((part): Inline => {
    const start = position
    position += part.content.length
    if (part.type === "computer" && part.app) return { ...part, app: { ...part.app }, start, end: position }
    return { ...part, start, end: position }
  })
  return { prompt: [...next, ...images], cursor: position }
}
