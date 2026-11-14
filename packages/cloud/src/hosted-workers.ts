// The hosted deploy workflow's checks on Vector's two Cloudflare Workers (contract WP A58, §6.2
// `vector-hosted-deploy.yml`): the Remote relay (WP A39) and the ops Worker (WP A46). Before anything is deployed the
// workflow checks, for each Worker it deploys:
// - `config <target>`: the committed wrangler.jsonc names the right Worker, its kill-flag namespace carries a real id
//   (the owner replaces the zero placeholder and commits it, owner step 11), and no secret's name sits in its plain
//   `vars`, where a deploy would publish it;
// - `secrets <target>`: every secret the Worker needs has been set by the owner with `wrangler secret put`. The input
//   is `wrangler secret list --format json`, which answers names only. The workflow never sets, changes, deletes or
//   reads a secret's value, and this file prints only the names that are missing.

import { readFile } from "node:fs/promises"
import path from "node:path"

export const WORKERS = {
  relay: {
    directory: "packages/relay",
    name: "vector-remote-relay",
    namespaces: ["REMOTE_FLAGS"],
    secrets: ["TICKET_PUBLIC_KEYS", "INTERNAL_SECRET", "ACCOUNT_KEY"],
    guide: "docs/vector/owner-actions/remote.md",
  },
  ops: {
    directory: "packages/ops-worker",
    name: "vector-ops",
    namespaces: ["OPS_FLAGS"],
    secrets: ["INTERNAL_SECRET", "ACCOUNT_KEY"],
    guide: "docs/vector/owner-actions/hosted-ops.md",
  },
} as const

export type WorkerTarget = keyof typeof WORKERS

export function isWorkerTarget(value: unknown): value is WorkerTarget {
  return value === "relay" || value === "ops"
}

const NAMESPACE_ID = /^[a-f0-9]{32}$/

/** wrangler.jsonc as JSON: line and block comments removed outside strings, then parsed strictly. */
export function parseJsonc(text: string): unknown {
  let out = ""
  let index = 0
  while (index < text.length) {
    const char = text[index]!
    if (char === '"') {
      const start = index
      index++
      while (index < text.length && text[index] !== '"') index += text[index] === "\\" ? 2 : 1
      if (index >= text.length) throw new Error("An unterminated string in the configuration.")
      index++
      out += text.slice(start, index)
      continue
    }
    if (char === "/" && text[index + 1] === "/") {
      while (index < text.length && text[index] !== "\n") index++
      continue
    }
    if (char === "/" && text[index + 1] === "*") {
      const end = text.indexOf("*/", index + 2)
      if (end < 0) throw new Error("An unterminated comment in the configuration.")
      index = end + 2
      continue
    }
    out += char
    index++
  }
  return JSON.parse(out)
}

const record = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined

/** What stops this Worker's committed configuration from being deployed; empty when nothing does. */
export function configProblems(target: WorkerTarget, text: string): string[] {
  const worker = WORKERS[target]
  let parsed: Record<string, unknown> | undefined
  try {
    parsed = record(parseJsonc(text))
  } catch {
    parsed = undefined
  }
  if (!parsed) return [`${worker.directory}/wrangler.jsonc could not be read.`]
  const problems: string[] = []
  if (parsed.name !== worker.name) problems.push(`The Worker must be named ${worker.name}.`)
  const namespaces = Array.isArray(parsed.kv_namespaces) ? parsed.kv_namespaces.map(record) : []
  for (const binding of worker.namespaces) {
    const found = namespaces.filter((entry) => entry?.binding === binding)
    const id = found[0]?.id
    if (found.length !== 1) problems.push(`The ${binding} namespace must be bound exactly once.`)
    else if (typeof id !== "string" || !NAMESPACE_ID.test(id) || /^0+$/.test(id))
      problems.push(
        `Replace the ${binding} placeholder id in ${worker.directory}/wrangler.jsonc with the namespace you created, ` +
          `and commit it (${worker.guide}).`,
      )
  }
  const vars = record(parsed.vars) ?? {}
  const exposed = worker.secrets.filter((name) => name in vars)
  if (exposed.length) problems.push(`Secrets must never be plain vars: ${exposed.join(", ")}.`)
  return problems
}

/**
 * The secrets the owner has not set, from `wrangler secret list --format json` (an array of `{name, type}`).
 * Undefined when the answer cannot be read, which the workflow treats as a failure.
 */
export function missingSecrets(target: WorkerTarget, output: string): string[] | undefined {
  const text = output.trim()
  const start = text.indexOf("[")
  const end = text.lastIndexOf("]")
  if (start < 0 || end < start) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(text.slice(start, end + 1))
  } catch {
    return undefined
  }
  if (!Array.isArray(parsed)) return undefined
  const names = new Set<string>()
  for (const entry of parsed) {
    const name = record(entry)?.name
    if (typeof name !== "string") return undefined
    names.add(name)
  }
  return WORKERS[target].secrets.filter((name) => !names.has(name))
}

async function main(argv: readonly string[]) {
  const [command, target] = argv
  if (!isWorkerTarget(target)) {
    console.error("Name the Worker: relay or ops.")
    return 1
  }
  const worker = WORKERS[target]
  if (command === "config") {
    const root = path.resolve(import.meta.dir, "../../..")
    const text = await readFile(path.join(root, worker.directory, "wrangler.jsonc"), "utf8").catch(() => "")
    const problems = configProblems(target, text)
    for (const problem of problems) console.error(problem)
    if (!problems.length) console.log(`${worker.name}: configuration ready to deploy.`)
    return problems.length ? 1 : 0
  }
  if (command === "secrets") {
    const missing = missingSecrets(target, await new Response(Bun.stdin.stream()).text())
    if (!missing) {
      console.error(`Could not read ${worker.name}'s secret names. Set them with wrangler secret put first (${worker.guide}).`)
      return 1
    }
    if (missing.length) {
      console.error(
        `${worker.name} is missing secrets the owner sets with wrangler secret put: ${missing.join(", ")} (${worker.guide}).`,
      )
      return 1
    }
    console.log(`${worker.name}: every secret it needs is set.`)
    return 0
  }
  console.error("Usage: bun hosted-workers.ts config|secrets relay|ops")
  return 1
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)))
