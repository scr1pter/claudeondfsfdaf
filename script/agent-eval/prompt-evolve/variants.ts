// Prompt variants of Vector's own agents. A variant names the agent it changes and the built-in prompt it starts from
// (`base`, a repository path), then gives the whole new text (`text`, or a `file` beside the variant) or exact
// replacements in the base (`patches`). The harness hands the rendered text to `vector run` as
// `agent.<agent>.prompt`, which replaces the whole provider prompt block (packages/engine/src/session/llm/request.ts),
// so render applies the same explore rewrite SystemPrompt.provider does. Nothing here writes a prompt file: the owner
// promotes a winner by hand (README.md).

import { readdir } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"

export const REPO_ROOT = resolve(import.meta.dir, "../../..")
/** The variants kept with the harness. The owner's own can live anywhere (`--variants-dir`). */
export const DIR = join(import.meta.dir, "variants")
/** The provider prompts SystemPrompt.provider picks by model, and the specialists' own prompts. */
export const PROVIDER_PROMPTS = "packages/engine/src/session/prompt"
export const AGENT_PROMPTS = "packages/engine/src/agent/prompt"
/** The provider prompt the harness's model (anthropic/claude-sonnet-4-5) gets. */
export const HARNESS_BASE = `${PROVIDER_PROMPTS}/anthropic.txt`

export type Patch = { readonly find: string; readonly replace: string }

export type Variant = {
  readonly id: string
  readonly description: string
  readonly agent: string
  /** The built-in prompt this variant starts from, as a repository path. */
  readonly base: string
  /** The whole new text. */
  readonly text?: string
  /** A file holding the whole new text; `load` resolves it against the variant's own folder. */
  readonly file?: string
  /** Replacements in the text, each of which must match exactly once. */
  readonly patches?: readonly Patch[]
}

/** The text a variant puts where its base prompt was, as a request carries it. */
export async function render(variant: Variant, options: { readonly explore: boolean }) {
  const source = variant.text ?? (await Bun.file(variant.file ?? join(REPO_ROOT, variant.base)).text())
  const patched = (variant.patches ?? []).reduce((text, patch) => {
    const found = patch.find ? text.split(patch.find).length - 1 : 0
    if (found !== 1)
      throw new Error(
        `Variant ${variant.id}: a patch must match exactly once, and this one matches ${found} times: ${JSON.stringify(patch.find.slice(0, 80))}`,
      )
    return text.replace(patch.find, () => patch.replace)
  }, source)
  // An agent's own prompt reaches the model as it is; a provider prompt is rewritten when explore is not offered.
  if (options.explore || !variant.base.startsWith(`${PROVIDER_PROMPTS}/`)) return patched
  return patched.replaceAll('subagent_type "explore"', "a search specialist from the task tool's list")
}

/** The variants in a folder, one JSON file each. */
export async function load(dir: string) {
  const names = (await readdir(dir)).filter((name) => name.endsWith(".json")).toSorted()
  const variants = await Promise.all(
    names.map(async (name) => parse(await Bun.file(join(dir, name)).json(), join(dir, name))),
  )
  const ids = variants.map((variant) => variant.id)
  const twice = ids.find((id, at) => ids.indexOf(id) !== at)
  if (twice) throw new Error(`Two variants in ${dir} have the id ${twice}`)
  return variants
}

function parse(value: unknown, path: string): Variant {
  const item = (value ?? {}) as Record<string, unknown>
  const text = (key: string) => {
    if (typeof item[key] === "string" && item[key]) return item[key]
    throw new Error(`${path}: "${key}" must be a non-empty string`)
  }
  const id = text("id")
  if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) throw new Error(`${path}: the id must be lowercase letters, digits and hyphens`)
  const base = text("base")
  if (![PROVIDER_PROMPTS, AGENT_PROMPTS].includes(dirname(base)) || !base.endsWith(".txt"))
    throw new Error(`${path}: "base" must be a built-in prompt under ${PROVIDER_PROMPTS} or ${AGENT_PROMPTS}`)
  if (item.text !== undefined && item.file !== undefined) throw new Error(`${path}: give "text" or "file", not both`)
  const patches = item.patches ?? []
  if (
    !Array.isArray(patches) ||
    patches.some((patch) => typeof patch?.find !== "string" || typeof patch?.replace !== "string")
  )
    throw new Error(`${path}: "patches" must be a list of { find, replace } strings`)
  const file = typeof item.file === "string" ? resolve(dirname(path), item.file) : undefined
  return {
    id,
    description: text("description"),
    agent: text("agent"),
    base,
    ...(typeof item.text === "string" ? { text: item.text } : {}),
    ...(file ? { file } : {}),
    ...(patches.length ? { patches: patches as Patch[] } : {}),
  }
}
