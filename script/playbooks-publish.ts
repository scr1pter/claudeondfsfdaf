// The owner's tool for Vector Playbooks (WP A36): checks a playbook, publishes a version of it, lists what is published
// and takes a playbook out of the library.
//
//   bun script/playbooks-publish.ts check <file.json>...
//   bun script/playbooks-publish.ts publish <file.json> --version <major.minor.patch> --mode live|test
//   bun script/playbooks-publish.ts list --mode live|test
//   bun script/playbooks-publish.ts withdraw <name> --mode live|test
//
// A playbook is one saved-workflow JSON file named after the playbook: vector-<words>.json. `check` runs the publish
// check alone (packages/core/src/playbooks/check.ts) and needs no settings, so CI and the playbooks' own repository can
// run it on every change: every command the playbook names must pass the skill command allowlist. `publish` runs the
// same check, uploads the file once to the media bucket (VECTOR_R2_ACCOUNT_ID and VECTOR_R2_MEDIA_*) at
// playbooks/<name>/<version>.json (playbooks/test/… for the test store) through a presigned upload that signs its exact
// size, and then records it in the library of one Stripe mode's Codium store (KV_REST_API_URL and KV_REST_API_TOKEN, or
// UPSTASH_REDIS_REST_*). A published version never changes, in the library or the bucket: a fix is a higher version.
// `withdraw` stops new download links at once; a link already given expires within 10 minutes. No setting is printed.
import { createHash } from "node:crypto"
import { readFile } from "node:fs/promises"
import path from "node:path"
import type { StripeMode } from "../api/_lib/model-plan-stripe"
import {
  playbookObjectKey,
  publishPlan,
  readPlaybook,
  readPlaybooks,
  recordPlaybook,
  withdrawPlaybook,
} from "../api/_lib/playbooks"
import { presignR2, r2Configured } from "../api/_lib/r2-presign"
import { PlaybookCheck } from "../packages/core/src/playbooks/check"
import { Playbooks } from "../packages/schema/src/playbooks"

export type PlaybooksPublishArguments =
  | { command: "check"; files: string[] }
  | { command: "publish"; file: string; version: string; mode: StripeMode }
  | { command: "list"; mode: StripeMode }
  | { command: "withdraw"; name: string; mode: StripeMode }

const USAGE = "Usage: bun script/playbooks-publish.ts <check|publish|list|withdraw> [file.json|name] [options]"
const VALUED = new Set(["version", "mode"])
const UPLOAD_SECONDS = 300

/** Reads the command line, or throws with what is wrong. */
export function parsePlaybooksArguments(argv: readonly string[]): PlaybooksPublishArguments {
  const positional: string[] = []
  const flags: Record<string, string> = {}
  for (let index = 0; index < argv.length; index++) {
    const value = argv[index]!
    if (!value.startsWith("--")) {
      positional.push(value)
      continue
    }
    const name = value.slice(2)
    const next = argv[index + 1]
    if (!VALUED.has(name) || next === undefined || next.startsWith("--") || name in flags)
      throw new Error(`Unknown, repeated or empty option ${value}.`)
    flags[name] = next
    index++
  }
  const [command, ...rest] = positional
  const allowed: Record<string, string[]> = {
    check: [],
    publish: ["version", "mode"],
    list: ["mode"],
    withdraw: ["mode"],
  }
  const permitted = command ? allowed[command] : undefined
  if (!permitted) throw new Error(USAGE)
  const extra = Object.keys(flags).find((name) => !permitted.includes(name))
  if (extra) throw new Error(`--${extra} does not go with ${command}.`)
  if (command === "check") {
    if (!rest.length) throw new Error("Usage: bun script/playbooks-publish.ts check <file.json>...")
    return { command, files: rest }
  }
  const mode = flags.mode
  if (mode !== "live" && mode !== "test") throw new Error("--mode is live or test.")
  if (command === "list") {
    if (rest.length) throw new Error(USAGE)
    return { command, mode }
  }
  if (rest.length !== 1) throw new Error(USAGE)
  if (command === "withdraw") {
    if (!Playbooks.validName(rest[0])) throw new Error("A playbook's name is vector- and lower-case words.")
    return { command, name: rest[0]!, mode }
  }
  if (!flags.version || !Playbooks.validVersion(flags.version))
    throw new Error("publish needs --version major.minor.patch, like 1.0.0.")
  return { command: "publish", file: rest[0]!, version: flags.version, mode }
}

/** The playbook a file holds: its name (the file name without .json) and the check's result. */
export function checkPlaybookFile(
  file: string,
  bytes: Uint8Array,
  env?: Record<string, string | undefined>,
): { name: string; result: PlaybookCheck.Result } {
  const base = path.basename(file)
  if (!base.endsWith(".json"))
    return {
      name: base,
      result: { ok: false, issues: [{ path: "", message: "A playbook's file is named <name>.json." }] },
    }
  const name = base.slice(0, -".json".length)
  return { name, result: PlaybookCheck.validate({ name, bytes, ...(env ? { env } : {}) }) }
}

function issueLines(file: string, issues: readonly PlaybookCheck.Issue[]) {
  return issues.map((issue) => `${file}${issue.path ? ` ${issue.path}` : ""}: ${issue.message}`)
}

type Options = {
  fetcher?: typeof fetch
  now?: number
  read?: (file: string) => Promise<Uint8Array>
  env?: Record<string, string | undefined>
}

/** What the command prints, as lines. A refusal throws, with every reason in its message. */
export async function runPlaybooksPublish(input: PlaybooksPublishArguments, options: Options = {}): Promise<string[]> {
  const read = options.read ?? (async (file: string) => new Uint8Array(await readFile(file)))
  const now = options.now ?? Date.now()
  const fetcher = options.fetcher ?? fetch
  switch (input.command) {
    case "check": {
      const lines: string[] = []
      const problems: string[] = []
      for (const file of input.files) {
        const { name, result } = checkPlaybookFile(file, await read(file), options.env)
        if (!result.ok) problems.push(...issueLines(file, result.issues))
        else
          lines.push(
            `${file}: ${name} passes. Commands: ${result.commands.length ? result.commands.join(", ") : "none"}.`,
          )
      }
      if (problems.length) throw new Error(problems.join("\n"))
      return lines
    }
    case "list": {
      const records = await readPlaybooks({ mode: input.mode, fetcher })
      if (!records.length) return [`No playbooks are published (${input.mode} store).`]
      return [
        `${records.length} playbook${records.length === 1 ? "" : "s"} published (${input.mode} store)${records.length < Playbooks.MINIMUM ? `; Playbooks can be listed from ${Playbooks.MINIMUM}` : ""}:`,
        ...records.map(
          (record) =>
            `  ${record.name} ${record.version}  sha256 ${record.sha256.slice(0, 12)}…  ${record.bytes} bytes  ${new Date(record.publishedAt).toISOString().slice(0, 10)}`,
        ),
      ]
    }
    case "withdraw": {
      const removed = await withdrawPlaybook(input.name, { mode: input.mode, fetcher })
      return [
        removed
          ? `${input.name} is withdrawn (${input.mode} store): no new download links; links already given expire within ${Playbooks.LINK_SECONDS / 60} minutes.`
          : `${input.name} was not published (${input.mode} store).`,
      ]
    }
    case "publish":
      return publish(input, { read, now, fetcher, env: options.env })
  }
}

async function publish(
  input: Extract<PlaybooksPublishArguments, { command: "publish" }>,
  options: {
    read: (file: string) => Promise<Uint8Array>
    now: number
    fetcher: typeof fetch
    env?: Record<string, string | undefined>
  },
) {
  const bytes = await options.read(input.file)
  const { name, result } = checkPlaybookFile(input.file, bytes, options.env)
  if (!result.ok) throw new Error(issueLines(input.file, result.issues).join("\n"))
  if (!r2Configured("media"))
    throw new Error("Publishing needs the media bucket: set VECTOR_R2_ACCOUNT_ID and VECTOR_R2_MEDIA_*.")
  if (
    !(process.env.KV_REST_API_URL?.trim() || process.env.UPSTASH_REDIS_REST_URL?.trim()) ||
    !(process.env.KV_REST_API_TOKEN?.trim() || process.env.UPSTASH_REDIS_REST_TOKEN?.trim())
  )
    throw new Error("Publishing needs the Codium store: set KV_REST_API_URL and KV_REST_API_TOKEN.")
  const sha256 = createHash("sha256").update(bytes).digest("hex")
  const store = { mode: input.mode, fetcher: options.fetcher }
  const plan = publishPlan(await readPlaybook(name, store), { name, version: input.version, sha256 })
  if (plan.kind === "refused") throw new Error(plan.message)
  if (plan.kind === "same")
    return [`${name} ${input.version} is already published with this file (${input.mode} store).`]
  const library = await readPlaybooks(store)
  if (!library.some((record) => record.name === name) && library.length >= Playbooks.MAX_LISTED)
    throw new Error(
      `The library holds ${Playbooks.MAX_LISTED} playbooks, the most one listing names. Withdraw one first.`,
    )
  const key = playbookObjectKey(name, input.version, input.mode)
  await upload(key, bytes, options.fetcher, options.now)
  await recordPlaybook(
    { v: 1, name, version: input.version, sha256, bytes: bytes.byteLength, key, publishedAt: options.now },
    store,
  )
  return [
    `${name} ${input.version} published (${input.mode} store): ${bytes.byteLength} bytes, sha256 ${sha256}.`,
    `Commands it names: ${result.commands.length ? result.commands.join(", ") : "none"}.`,
  ]
}

/**
 * Puts the file in the media bucket once. A file already at that key is left alone when it is the same file (a rerun
 * after the library write failed) and refused when it is not, so a version never changes even after it was withdrawn.
 */
async function upload(key: string, bytes: Uint8Array, fetcher: typeof fetch, now: number) {
  const head = presignR2("media", { method: "HEAD", key, expiresIn: UPLOAD_SECONDS, now })
  const existing = await fetcher(head.url, {
    method: "HEAD",
    redirect: "error",
    signal: AbortSignal.timeout(30_000),
  }).catch(() => undefined)
  if (!existing) throw new Error("The media bucket could not be reached.")
  if (existing.ok) {
    // R2's ETag for a single upload is the file's MD5.
    const etag = existing.headers.get("etag")?.replace(/"/g, "").toLowerCase()
    if (etag === createHash("md5").update(bytes).digest("hex")) return
    throw new Error(`${key} already holds another file. A published version never changes: publish a higher version.`)
  }
  if (existing.status !== 404) throw new Error(`The media bucket answered ${existing.status} when checking ${key}.`)
  const put = presignR2("media", {
    method: "PUT",
    key,
    expiresIn: UPLOAD_SECONDS,
    contentLength: bytes.byteLength,
    contentType: "application/json",
    now,
  })
  const answer = await fetcher(put.url, {
    method: "PUT",
    headers: put.headers,
    // A copy typed as an ArrayBuffer view, which fetch's body type wants.
    body: bytes.slice(),
    redirect: "error",
    signal: AbortSignal.timeout(60_000),
  }).catch(() => undefined)
  if (!answer?.ok) throw new Error(`The upload of ${key} failed${answer ? ` (${answer.status})` : ""}.`)
}

if (import.meta.main) {
  try {
    for (const line of await runPlaybooksPublish(parsePlaybooksArguments(process.argv.slice(2)))) console.log(line)
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  }
}
