// A useful initial title prevents a separate model request. Only the first typed line or a caller-supplied label
// belongs here: attachment contents and hidden task instructions must not become a session title.
export function initialSessionTitle(text: string, fallbacks: readonly string[] = []) {
  const source = [text, ...fallbacks].map((value) => value.trim()).find((value) => value.length > 0)
  if (!source) return undefined
  // Match the engine's provisional title input bound; large pasted prompts need no extra full-text arrays.
  const first = source.slice(0, 1500).split("\n")[0].trim().replace(/\s+/g, " ")
  const characters = Array.from(first)
  return characters.length > 50 ? `${characters.slice(0, 50).join("")}...` : first
}
