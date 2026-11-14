// How a surface outside a session hands a prompt to the composer on screen,
// and how that composer decides whether to take it. A surface whose prompt no
// composer takes starts a new task with it instead.

import type { Prompt } from "@/context/prompt"
import { ComputerMention } from "@/features/computer/mention"

export const COMPOSER_PROMPT_EVENT = "vector:composer-prompt"

export type ComposerPrompt = {
  text: string
  /** Send it straight away, starting the agent, instead of leaving it in the composer. */
  send: boolean
  /** A leading @Hands in the text becomes a real mention pill, so the message carries its marker. */
  mention?: "computer"
}

/** Hands a prompt to the session composer on screen. False when no composer took it. */
export function requestComposerPrompt(request: ComposerPrompt) {
  const event = new CustomEvent<ComposerPrompt>(COMPOSER_PROMPT_EVENT, { detail: request, cancelable: true })
  return !(globalThis.window?.dispatchEvent(event) ?? true)
}

/** What a composer puts in for a handed-over prompt: a computer mention becomes its pill, the rest stays text. */
export function handoffPrompt(request: ComposerPrompt): Prompt {
  if (request.mention === "computer") return ComputerMention.examplePrompt(request.text)
  return [{ type: "text", content: request.text, start: 0, end: request.text.length }]
}

/**
 * Lets a composer take the prompts other surfaces hand it. `take` returns false
 * to decline one (a composer holding an unsent draft keeps it), and the surface
 * then starts a new session with the prompt instead. Returns the unsubscribe.
 */
export function onComposerPrompt(take: (request: ComposerPrompt) => boolean) {
  const listener = (event: Event) => {
    // One composer takes each request, so two mounted at once never both send it.
    if (event.defaultPrevented || !(event instanceof CustomEvent)) return
    if (take(event.detail)) event.preventDefault()
  }
  globalThis.window?.addEventListener(COMPOSER_PROMPT_EVENT, listener)
  return () => globalThis.window?.removeEventListener(COMPOSER_PROMPT_EVENT, listener)
}

/**
 * Whether a composer can take a handed-over prompt. It declines while it holds
 * work the user has not sent (text, images, or line comments, which a submit
 * sends and then clears), and while its session takes no input: a subagent
 * session, or one waiting on a permission or a question, shows no message box.
 */
export function composerTakes(input: { dirty: boolean; context: readonly { comment?: string }[]; open: boolean }) {
  return input.open && !input.dirty && !input.context.some((item) => item.comment?.trim())
}

/**
 * Whether a composer still holds exactly the prompt handed to it. Only then is
 * it sent: never a composer the user has changed since, and never an empty
 * one, which a submit treats as Stop for a running turn.
 */
export function holdsHandoff(prompt: readonly { type: string; content?: string }[], text: string) {
  if (!text.trim()) return false
  if (prompt.some((part) => part.type !== "text")) return false
  return prompt.map((part) => part.content ?? "").join("") === text
}
