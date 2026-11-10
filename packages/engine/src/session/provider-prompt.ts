/**
 * The file in `session/prompt/` whose text a model with this API id gets as its provider prompt (SystemPrompt.provider
 * picks by it). A pure function of the id in a module with no imports, so the prompt evolution harness can tell which
 * prompt a live model gets without loading the engine.
 */
export function providerPromptFile(apiID: string) {
  if (apiID.includes("gpt-4") || apiID.includes("o1") || apiID.includes("o3")) return "beast.txt"
  if (apiID.includes("gpt")) return apiID.includes("codex") ? "codex.txt" : "gpt.txt"
  if (apiID.includes("gemini-")) return "gemini.txt"
  if (apiID.includes("claude")) return "anthropic.txt"
  if (apiID.toLowerCase().includes("trinity")) return "trinity.txt"
  if (apiID.toLowerCase().includes("kimi")) return "kimi.txt"
  return "default.txt"
}
