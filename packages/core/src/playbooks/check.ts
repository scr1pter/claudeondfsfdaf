export * as PlaybookCheck from "./check"

import { Playbooks } from "@vectordevai/schema/playbooks"
import { SECRET_FILE } from "../brain/document/sniff"
import { BrainScan } from "../brain/scan"
import { allowed } from "./commands"

// The check every playbook passes before it is published (WP A36, `script/playbooks-publish.ts`). A playbook is a saved
// workflow: its stages are prompts the agent reads, so the commands it names are the code spans in its text. Every one
// of them must pass the skill command allowlist (`commands.ts`); every other code span must be a file inside the
// repository. Track B adds its workflow schema check on top once that schema is published; until then the file only has
// to be one JSON object.
//
// What is refused, in any string of the file (object keys too):
// - hidden characters (zero-width, bidirectional controls, tag characters), which a reviewer would not see;
// - a credential, by its shape, its name or the words beside it, and the value of any secret in `env`;
// - `!` followed by a backtick, the syntax command and skill files use to run a shell command before the model reads
//   the text;
// - a backtick that does not open and close a code span on one line, and a fenced block left open, so no command can
//   hide from this parser;
// - a code span that is neither a command the allowlist accepts nor a repository file, or that takes a template value
//   (`{{…}}`), which could turn an allowed command into any other;
// - in a fenced block, any line that is not an allowed command, unless the block is marked as data (json, yaml, text,
//   diff, markdown).

export type Issue = { readonly path: string; readonly message: string }
export type Result =
  | {
      readonly ok: true
      readonly name: string
      readonly commands: readonly string[]
      readonly files: readonly string[]
    }
  | { readonly ok: false; readonly issues: readonly Issue[] }

/** How deep the JSON may nest: a saved workflow needs far less, and a walk this deep stays within the stack. */
export const MAX_DEPTH = 32

/** Fenced blocks marked with one of these hold data the agent reads, not commands it runs. */
export const DATA_FENCES: ReadonlySet<string> = new Set([
  "json",
  "jsonc",
  "json5",
  "yaml",
  "yml",
  "text",
  "txt",
  "plain",
  "diff",
  "markdown",
  "md",
])

// Files whose names say they are run, not read: a code span naming one reads as an instruction to run it.
const RUNNABLE = /\.(?:sh|bash|zsh|fish|ksh|csh|ps1|psm1|bat|cmd|command|exe|msi|app|run|bin)$/i
const FILE = /^[A-Za-z0-9._@+-][A-Za-z0-9._@+*/-]*$/

/** Whether a code span names a file inside the repository rather than a command. */
export function repositoryFile(span: string) {
  if (!FILE.test(span) || !(span.includes("/") || /\.[A-Za-z0-9]{1,10}$/.test(span))) return false
  if (span.startsWith("./") || span.startsWith("-") || span.split("/").some((part) => part === ".." || part === "."))
    return false
  return !SECRET_FILE.test(span) && !RUNNABLE.test(span)
}

/**
 * Checks one playbook file. `name` is the playbook's name (its file name without `.json`), `bytes` the file exactly as
 * it will be published. `env` holds secrets whose values must not appear (the publisher's own environment by default).
 */
export function validate(input: {
  readonly name: string
  readonly bytes: Uint8Array
  readonly env?: Record<string, string | undefined>
}): Result {
  const issues: Issue[] = []
  if (!Playbooks.validName(input.name))
    issues.push({
      path: "",
      message: `A playbook's name is vector- and lower-case words joined by hyphens, at most ${Playbooks.NAME_MAX} characters.`,
    })
  if (input.bytes.byteLength === 0 || input.bytes.byteLength > Playbooks.MAX_BYTES)
    return {
      ok: false,
      issues: [...issues, { path: "", message: `A playbook is 1 byte to ${Playbooks.MAX_BYTES / 1024} KiB of JSON.` }],
    }
  let text: string
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(input.bytes)
  } catch {
    return { ok: false, issues: [...issues, { path: "", message: "A playbook is UTF-8 text." }] }
  }
  if (text.startsWith("\uFEFF"))
    return { ok: false, issues: [...issues, { path: "", message: "Save the playbook without a byte-order mark." }] }
  let document: unknown
  try {
    document = JSON.parse(text)
  } catch {
    return { ok: false, issues: [...issues, { path: "", message: "A playbook is one JSON document." }] }
  }
  if (!document || typeof document !== "object" || Array.isArray(document))
    return {
      ok: false,
      issues: [...issues, { path: "", message: "A playbook is one JSON object (a saved workflow)." }],
    }
  const commands = new Set<string>()
  const files = new Set<string>()
  const env = input.env ?? process.env
  const walk = (value: unknown, path: string, depth: number) => {
    if (depth > MAX_DEPTH) {
      issues.push({ path, message: `A playbook nests at most ${MAX_DEPTH} levels deep.` })
      return
    }
    if (typeof value === "string") return strings(value, path, env, issues, commands, files)
    if (!value || typeof value !== "object") return
    if (Array.isArray(value)) return value.forEach((item, index) => walk(item, `${path}/${index}`, depth + 1))
    for (const [key, item] of Object.entries(value)) {
      const at = `${path}/${pointer(key)}`
      strings(key, `${at} (name)`, env, issues, commands, files)
      walk(item, at, depth + 1)
    }
  }
  walk(document, "", 0)
  if (issues.length) return { ok: false, issues }
  return { ok: true, name: input.name, commands: [...commands].sort(), files: [...files].sort() }
}

function strings(
  text: string,
  path: string,
  env: Record<string, string | undefined>,
  issues: Issue[],
  commands: Set<string>,
  files: Set<string>,
) {
  if (BrainScan.hidden(text))
    issues.push({ path, message: "Hidden characters (zero-width, bidirectional or tag characters) are not allowed." })
  if (BrainScan.credential(text, { code: true }) || BrainScan.named(text, env, { code: true }).redacted)
    issues.push({ path, message: "A playbook never holds a secret: it names where one is kept, never its value." })
  if (text.includes("!`"))
    issues.push({ path, message: "`!` before a backtick runs a shell command when the text is loaded; not allowed." })
  const lines = text.split(/\r\n|\r|\n/)
  let fence: { marker: string; data: boolean } | undefined
  for (const line of lines) {
    const opening = /^\s*(`{3,}|~{3,})\s*([^\s`]*)[^`]*$/.exec(line)
    if (fence) {
      if (opening && opening[1]!.startsWith(fence.marker) && !opening[2] && line.trim() === opening[1]) {
        fence = undefined
        continue
      }
      if (fence.data || !line.trim()) continue
      command(line.trim(), path, issues, commands)
      continue
    }
    if (opening) {
      fence = { marker: opening[1]!, data: DATA_FENCES.has(opening[2]!.toLowerCase()) }
      continue
    }
    const spans = [...line.matchAll(/`([^`]+)`/g)].map((match) => match[1]!.trim())
    if (line.replace(/`[^`]+`/g, "").includes("`")) {
      issues.push({ path, message: "Every backtick opens and closes a code span on one line." })
      continue
    }
    for (const span of spans) {
      if (span.includes("{{") || span.includes("}}")) {
        issues.push({ path, message: `\`${span}\` takes a template value; a command in a playbook is written out.` })
        continue
      }
      if (repositoryFile(span)) {
        files.add(span)
        continue
      }
      command(span, path, issues, commands)
    }
  }
  if (fence) issues.push({ path, message: "A fenced block is left open." })
}

function command(text: string, path: string, issues: Issue[], commands: Set<string>) {
  if (text.includes("{{") || text.includes("}}")) {
    issues.push({ path, message: `\`${text}\` takes a template value; a command in a playbook is written out.` })
    return
  }
  if (allowed(text)) {
    commands.add(text)
    return
  }
  issues.push({
    path,
    message: `\`${text}\` is not a command a playbook may name. Commands are read-only (ls, cat, head, tail, wc, grep, rg, or git diff, status, log or show, on files inside the repository) or one test, lint, typecheck, build, check or verify command that never deploys, publishes, releases, pushes, uploads, installs or migrates.`,
  })
}

// JSON Pointer escaping, so a path names exactly one place.
function pointer(key: string) {
  return key.replace(/~/g, "~0").replace(/\//g, "~1")
}
