import fs from "node:fs/promises"
import path from "node:path"
import { constants } from "node:fs"
import { spawn } from "node:child_process"
import { Effect } from "effect"
import { z } from "zod"
import { GithubAgents } from "@vectordevai/core/github-agents"
import { escapeVectorMarkers } from "@vectordevai/core/review/state"
import { GithubBundle } from "./github.bundle"
import { agentRoute } from "./github.agent"
import { GITHUB_ACTIONS_BOT, resolveGithubAuth, type GithubAuth } from "./github.auth"
import { prepareGithubGit } from "./github.git"
import { sanitizeActionsLog } from "./github.output"
import { redactCodiumReviewText } from "./github.review-codium"
import { githubFetch } from "./github.shared"
import { CliError } from "../effect-cmd"
import { boundedBinaryPatch } from "./github.patch-binary"

const REF = /^[^\x00-\x20\x7f~^:?*[\\]+$/
const SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/
const ID = /^[1-9]\d{0,19}$/
const REPOSITORY = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9_.-]{1,100}$/
const WRITERS = new Set(["admin", "maintain", "write"])

type PatchResult =
  | { ok: true; patch: string; paths: string[]; heldBack: string[] }
  | { ok: false; reason: "bytes" | "files" | "fileBytes" | "path" | "mode" | "symlink" | "format" }

function unsafePath(value: string) {
  return (
    value.length === 0 ||
    value.length > 4096 ||
    /[\x00-\x1f\x7f\\:]/.test(value) ||
    value.startsWith("/") ||
    value.split("/").some((part) => !part || part === "." || part === ".." || /^(?:\.git|git~1)[. ]*$/i.test(part))
  )
}

function protectedPath(value: string) {
  return (
    value
      .split("/")[0]
      ?.replace(/[. ]+$/, "")
      .toLowerCase() === ".github"
  )
}

function unsafeLink(name: string, target: string) {
  return /[\x00-\x1f\x7f\\]/.test(target) || path.win32.isAbsolute(target) || GithubBundle.linkLeavesTree(name, target)
}

/** Decode Git's C-quoted path, including UTF-8 octal escapes, without evaluating or interpreting shell text. */
function gitPath(value: string) {
  if (!value.startsWith('"')) return value
  if (!value.endsWith('"')) return undefined
  const bytes: number[] = []
  for (let index = 1; index < value.length - 1; index++) {
    const char = value[index]!
    if (char !== "\\") {
      bytes.push(...Buffer.from(char))
      continue
    }
    const escaped = value[++index]
    const simple: Record<string, string> = {
      '"': '"',
      "\\": "\\",
      a: "\x07",
      b: "\b",
      t: "\t",
      n: "\n",
      v: "\v",
      f: "\f",
      r: "\r",
    }
    if (escaped && simple[escaped] !== undefined) bytes.push(...Buffer.from(simple[escaped]!))
    else {
      const octal = /^[0-7]{1,3}/.exec(value.slice(index))?.[0]
      if (!octal) return undefined
      const byte = Number.parseInt(octal, 8)
      if (byte > 255) return undefined
      bytes.push(byte)
      index += octal.length - 1
    }
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(bytes))
}

function diffPaths(line: string) {
  const value = line.slice("diff --git ".length)
  const candidates = [...value.matchAll(/ (?="?b\/)/g)].flatMap((match) => {
    const left = gitPath(value.slice(0, match.index))
    const right = gitPath(value.slice(match.index + 1))
    return left?.startsWith("a/") && right?.startsWith("b/") ? [[left.slice(2), right.slice(2)]] : []
  })
  return candidates.length === 1 ? candidates[0] : undefined
}

/** The publisher independently holds back protected paths; a bundle's path lists grant no authority. */
export function validatePatch(patch: string): PatchResult {
  if (Buffer.byteLength(patch) > GithubAgents.PATCH_LIMITS.bytes) return { ok: false, reason: "bytes" }
  if (!patch) return { ok: true, patch: "", paths: [], heldBack: [] }
  if (!patch.startsWith("diff --git ") || patch.includes("\0")) return { ok: false, reason: "format" }
  const blocks = patch.split(/(?=^diff --git )/m).filter(Boolean)
  const paths = new Set<string>()
  const heldBack = new Set<string>()
  const accepted: string[] = []
  for (const block of blocks) {
    const lines = block.split("\n")
    let names: string[] | undefined
    try {
      names = diffPaths(lines[0]!)
    } catch {
      return { ok: false, reason: "path" }
    }
    if (!names || names.some(unsafePath)) return { ok: false, reason: "path" }
    const headers: string[] = []
    for (const line of lines.slice(1)) {
      if (line.startsWith("@@") || line === "GIT binary patch") break
      const file = /^(?:---|\+\+\+) (.*)$/.exec(line)
      const rename = /^(?:rename|copy) (?:from|to) (.*)$/.exec(line)
      if (file && file[1] !== "/dev/null") {
        let value: string | undefined
        try {
          value = gitPath(file[1]!.replace(/\t.*$/, ""))
        } catch {
          return { ok: false, reason: "path" }
        }
        if (!value || !/^[ab]\//.test(value)) return { ok: false, reason: "path" }
        headers.push(value.slice(2))
      }
      if (rename) {
        let value: string | undefined
        try {
          value = gitPath(rename[1]!)
        } catch {
          return { ok: false, reason: "path" }
        }
        if (!value) return { ok: false, reason: "path" }
        headers.push(value)
      }
    }
    if (headers.some((name) => unsafePath(name) || !names!.includes(name))) return { ok: false, reason: "path" }
    const modes = lines.flatMap(
      (line) =>
        /^(?:new file mode|deleted file mode|old mode|new mode) ([0-7]{6})$/.exec(line)?.[1] ??
        /^index [0-9a-f]+\.\.[0-9a-f]+ ([0-7]{6})$/.exec(line)?.[1] ??
        [],
    )
    if (modes.some((mode) => !["100644", "100755", "120000"].includes(mode))) return { ok: false, reason: "mode" }
    if (modes.includes("120000") && !lines.some((line) => line === "deleted file mode 120000")) {
      const added = lines
        .filter((line) => line.startsWith("+") && !line.startsWith("+++ "))
        .map((line) => line.slice(1))
      if (added.length !== 1 || unsafeLink(names[1]!, added[0]!)) return { ok: false, reason: "symlink" }
    }
    if (lines.some((line) => /^literal \d+$/.test(line) && Number(line.slice(8)) > GithubAgents.PATCH_LIMITS.fileBytes))
      return { ok: false, reason: "fileBytes" }
    if (!boundedBinaryPatch(block, GithubAgents.PATCH_LIMITS.fileBytes)) return { ok: false, reason: "fileBytes" }
    for (const name of names) paths.add(name)
    if (paths.size > GithubAgents.PATCH_LIMITS.files) return { ok: false, reason: "files" }
    if (names.some(protectedPath)) {
      names.filter(protectedPath).forEach((name) => heldBack.add(name))
      continue
    }
    accepted.push(block)
  }
  return { ok: true, patch: accepted.join(""), paths: [...paths], heldBack: [...heldBack] }
}

/** Public model text cannot close another issue, forge Vector markers or notify a GitHub account. */
export function sanitizeModelText(text: string) {
  return escapeVectorMarkers(text)
    .replace(/[\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/g, "")
    .replace(/`/g, "'")
    .replace(
      /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\b(?=[^\r\n]{0,256}(?:#\d|https?:\/\/github\.com\/[^\s/]+\/[^\s/]+\/(?:issues|pull)\/\d))/gi,
      "",
    )
    .replace(
      /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\b[\s*_~:]*?(?=(?:#\d|[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+#\d|https?:\/\/github\.com\/[^\s/]+\/[^\s/]+\/(?:issues|pull)\/\d))/gi,
      "",
    )
    .replace(/@([A-Za-z0-9](?:[A-Za-z0-9-]{0,98}[A-Za-z0-9])?)/g, "`@$1`")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
}

export interface PublishRoute extends GithubBundle.BundleRoute {
  baseSha: string
  repository: string
  repositoryId: string
  runId: string
  defaultBranch: string
  eventName: string
}

export function publishRouting(input: {
  event: { name?: string; payload: unknown }
  env: Readonly<Record<string, string | undefined>>
  head: string
  headRef?: string
}): PublishRoute {
  const env = input.env
  if (
    !SHA.test(input.head) ||
    !REPOSITORY.test(env.GITHUB_REPOSITORY ?? "") ||
    !ID.test(env.GITHUB_RUN_ID ?? "") ||
    !ID.test(env.GITHUB_REPOSITORY_ID ?? "") ||
    !ID.test(env.GITHUB_RUN_ATTEMPT || "1") ||
    !["codium", "own-key"].includes(env.VECTOR_MODE ?? "") ||
    env.VECTOR_ROUTE_KIND !== "task"
  )
    throw new Error("The publish route is unavailable.")
  const payload = z
    .object({ repository: z.object({ full_name: z.string(), default_branch: z.string() }) })
    .parse(input.event.payload)
  if (payload.repository.full_name !== env.GITHUB_REPOSITORY || !REF.test(payload.repository.default_branch))
    throw new Error("The publish repository identity is unavailable.")
  const routed = agentRoute({ name: input.event.name, payload: input.event.payload }, env)
  if ("refused" in routed) throw new Error("The event does not authorize publishing.")
  const route = routed.route
  if (
    route.thread !== env.VECTOR_THREAD ||
    env.VECTOR_ROUTE_REF !== input.head ||
    (route.kind === "pr" || route.kind === "issue"
      ? String(route.number) !== env.VECTOR_ROUTE_PR
      : !!env.VECTOR_ROUTE_PR)
  )
    throw new Error("The publish route does not match the checkout.")
  if (route.kind === "pr" && (!input.headRef || !REF.test(input.headRef)))
    throw new Error("The pull request branch is unavailable.")
  return {
    mode: env.VECTOR_MODE as "codium" | "own-key",
    kind: route.kind,
    thread: route.thread,
    baseSha: input.head,
    ...(route.kind === "pr" ? { pr: route.number, headRef: input.headRef } : {}),
    ...(route.kind === "issue" ? { issue: route.number } : {}),
    ...(route.kind === "schedule" ? { scheduleId: route.scheduleId } : {}),
    repository: env.GITHUB_REPOSITORY!,
    repositoryId: env.GITHUB_REPOSITORY_ID!,
    runId: env.GITHUB_RUN_ID!,
    defaultBranch: payload.repository.default_branch,
    eventName: input.event.name ?? "",
  }
}

export function routingAgrees(summary: GithubBundle.RunSummary, route: PublishRoute) {
  return ["mode", "kind", "thread", "baseSha", "pr", "issue", "headRef", "scheduleId"].every(
    (key) => summary[key as keyof GithubBundle.RunSummary] === route[key as keyof PublishRoute],
  )
}

export const REFUSAL_COMMENT = {
  "not-bound": "Connect this repository in Vector Settings → GitHub or at vectordev.ai/account#github.",
  suspended: "Connect this repository again in Vector Settings → GitHub.",
  "update-required": GithubBundle.UPDATE_ADVICE,
  "binding-unavailable":
    "Codium isn't available for this repository right now; the account that connected it can check Settings → GitHub in Vector.",
  "not-in-plan": "This automation is unavailable for this repository right now.",
  "service-off": "Codium agents are off right now.",
  "source-unavailable": "Vector could not start this repository task.",
  runner: "Codium runs need GitHub-hosted runners.",
  hours: "Agent time for this repository is used up right now.",
  "at-once": "Vector is already running the tasks this repository can start at once; try again when one finishes.",
  scheduled: "This repository has reached its automation limit for today.",
  denied: "Vector could not authorize this repository task.",
  "needs-app": "Ask Vector in a pull request conversation comment instead of an inline review comment.",
  unavailable: "Vector could not start this repository task right now.",
} as const satisfies Record<Exclude<GithubAgents.MintStatus, "ok">, string>

export interface PublishPull {
  number: number
  author: string
  draft?: boolean
  head: { sha: string; ref: string; repositoryId: string }
  base: { ref: string; repositoryId: string }
}

export interface PublishApi {
  pull: (number: number) => Promise<PublishPull>
  thread: (
    number: number,
    pr: boolean,
  ) => Promise<{
    writersOnly: boolean
    comments: { id: number; body: string; login: string }[]
  }>
  comment: (number: number, body: string) => Promise<void>
  openPulls: (head: string, base: string) => Promise<PublishPull[]>
  schedulePulls?: (base: string) => Promise<PublishPull[]>
  createPull: (input: {
    head: string
    base: string
    title: string
    body: string
    draft: boolean
  }) => Promise<{ number: number }>
  updatePull: (number: number, input: { title: string; body: string; draft: boolean }) => Promise<void>
}

export type PublishGit = (args: string[], input?: string) => Promise<{ code: number; output: Buffer }>

/** No process inherits a provider credential, repository hook, global Git configuration or credential helper. */
export function createPublishGit(directory: string, authEnv: Record<string, string> = {}): PublishGit {
  return (args, input) =>
    new Promise((resolve, reject) => {
      const child = spawn(
        "git",
        [
          "-c",
          "core.hooksPath=/dev/null",
          "-c",
          "core.fsmonitor=false",
          "-c",
          "commit.gpgsign=false",
          "-c",
          "tag.gpgsign=false",
          "-c",
          "gc.auto=0",
          "-c",
          "maintenance.auto=false",
          "-c",
          "credential.helper=",
          "-c",
          "core.askPass=",
          "-c",
          "core.quotePath=true",
          ...args,
        ],
        {
          cwd: directory,
          env: {
            PATH: process.env.PATH,
            LANG: "C.UTF-8",
            GIT_CONFIG_NOSYSTEM: "1",
            GIT_CONFIG_GLOBAL: "/dev/null",
            GIT_CONFIG_PARAMETERS: "",
            GIT_CONFIG_COUNT: "0",
            GIT_TERMINAL_PROMPT: "0",
            GIT_TRACE: "0",
            GIT_TRACE_CURL: "0",
            GIT_CURL_VERBOSE: "0",
            GIT_TRACE_PACKET: "0",
            GIT_TRACE2: "0",
            ...authEnv,
          },
          stdio: ["pipe", "pipe", "pipe"],
        },
      )
      const chunks: Buffer[] = []
      let bytes = 0
      let overflow = false
      const timeout = setTimeout(() => child.kill("SIGKILL"), 120_000)
      child.stdout.on("data", (chunk: Buffer) => {
        bytes += chunk.length
        if (bytes > 20_000_000) {
          overflow = true
          child.kill("SIGKILL")
        } else chunks.push(chunk)
      })
      // Repository/network diagnostics can quote credentials or repository-controlled text. Only the exit status is used.
      child.stderr.resume()
      child.once("error", (error) => {
        clearTimeout(timeout)
        reject(error)
      })
      child.once("close", (code) => {
        clearTimeout(timeout)
        if (overflow) reject(new Error("Git output exceeded the publisher's limit."))
        else resolve({ code: code ?? 1, output: Buffer.concat(chunks) })
      })
      child.stdin.on("error", () => {})
      child.stdin.end(input)
    })
}

async function gitText(git: PublishGit, args: string[], input?: string) {
  const result = await git(args, input)
  if (result.code !== 0) throw new Error("The validated Git operation could not complete.")
  return result.output.toString("utf8").trim()
}

async function bundleFile(directory: string, name: string, limit: number) {
  const filename = path.join(directory, name)
  const handle = await fs.open(filename, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const info = await handle.stat()
    if (!info.isFile() || info.nlink !== 1 || info.size > limit) throw new Error("The run bundle is unavailable.")
    const content = Buffer.alloc(limit + 1)
    const read = await handle.read(content, 0, content.length, 0)
    if (read.bytesRead > limit) throw new Error("The run bundle is unavailable.")
    return content.subarray(0, read.bytesRead).toString("utf8")
  } finally {
    await handle.close()
  }
}

async function readBundle(directory: string) {
  const info = await fs.lstat(directory)
  if (!info.isDirectory() || info.isSymbolicLink() || (await fs.realpath(directory)) !== path.resolve(directory))
    throw new Error("The run bundle is unavailable.")
  const entries = await fs.readdir(directory)
  if (
    entries.length !== 2 ||
    entries.some((name) => !GithubAgents.BUNDLE_FILES.includes(name as "patch.diff" | "summary.json"))
  )
    throw new Error("The run bundle has unexpected files.")
  const raw: unknown = JSON.parse(await bundleFile(directory, "summary.json", GithubAgents.PATCH_LIMITS.summaryBytes))
  // A malicious summary can claim ready changes alongside a stop. The strict schema still checks every field,
  // but that contradiction can only be repaired toward a draft, never toward a ready pull request.
  const conservative =
    raw &&
    typeof raw === "object" &&
    !Array.isArray(raw) &&
    "outcome" in raw &&
    raw.outcome === "changes" &&
    ("stop" in raw || ("draft" in raw && raw.draft === true))
      ? { ...raw, outcome: "draft", draft: true }
      : raw
  const summary = GithubBundle.parseRunSummary(JSON.stringify(conservative))
  if (!summary) throw new Error("The run summary is unavailable.")
  return { summary, patch: await bundleFile(directory, "patch.diff", GithubAgents.PATCH_LIMITS.bytes) }
}

function botOwned(pull: PublishPull, route: PublishRoute, bots: readonly string[]) {
  return (
    bots.includes(pull.author) &&
    pull.base.repositoryId === route.repositoryId &&
    pull.head.repositoryId === pull.base.repositoryId &&
    pull.head.ref.startsWith("vector/") &&
    pull.head.ref !== route.defaultBranch &&
    REF.test(pull.head.ref)
  )
}

async function validateStaged(git: PublishGit, base: string) {
  const raw = await gitText(git, ["diff", "--cached", "--raw", "-z", "--no-renames", "--no-abbrev", base, "--"])
  const fields = raw.split("\0").filter(Boolean)
  if (fields.length % 2 || fields.length / 2 > GithubAgents.PATCH_LIMITS.files)
    throw new Error("The staged patch is invalid.")
  for (let index = 0; index < fields.length; index += 2) {
    const meta = /^:([0-7]{6}) ([0-7]{6}) [0-9a-f]{40,64} ([0-9a-f]{40,64}) [A-Z]$/.exec(fields[index]!)
    const name = fields[index + 1]!
    if (!meta || unsafePath(name) || protectedPath(name) || [meta[1], meta[2]].includes("160000"))
      throw new Error("The staged patch contains a protected path.")
    if (meta[2] === "000000") continue
    if (!["100644", "100755", "120000"].includes(meta[2]!)) throw new Error("The staged patch has an invalid mode.")
    const bytes = Number(await gitText(git, ["cat-file", "-s", meta[3]!]))
    if (!Number.isSafeInteger(bytes) || bytes > GithubAgents.PATCH_LIMITS.fileBytes)
      throw new Error("A staged file is too large.")
    if (meta[2] === "120000" && unsafeLink(name, await gitText(git, ["cat-file", "blob", meta[3]!])))
      throw new Error("A staged symlink leaves the repository.")
  }
  return fields.length / 2
}

/** Trusted infrastructure supplies both authorization and Git. The untrusted bundle supplies no destination. */
export async function publishBundle(input: {
  env: Readonly<Record<string, string | undefined>>
  event: { name?: string; payload: unknown }
  bundleDirectory: string
  git: PublishGit
  api: PublishApi
  authorize: (
    app: boolean,
  ) => Promise<{ auth: GithubAuth; api: PublishApi; git: PublishGit; dispose: () => Promise<void> }>
  log?: (line: string) => void
}) {
  const env = input.env
  const clean = (text: string) =>
    env.VECTOR_MODE === "codium" ? redactCodiumReviewText(sanitizeModelText(text)) : sanitizeModelText(text)
  const log = (line: string) => (input.log ?? console.log)(sanitizeActionsLog(clean(line)))
  const head = await gitText(input.git, ["rev-parse", "--verify", "HEAD^{commit}"])
  const routed = agentRoute({ name: input.event.name, payload: input.event.payload }, env)
  if ("refused" in routed) throw new Error("The event does not authorize publishing.")
  const pull = routed.route.kind === "pr" ? await input.api.pull(routed.route.number!) : undefined
  const route = publishRouting({ ...input, head, headRef: pull?.head.ref })
  const number = route.issue ?? route.pr
  const thread = number === undefined ? undefined : await input.api.thread(number, route.kind === "pr")
  const handle = (env.MENTIONS?.split(",").find((value) => /^@[a-z0-9][a-z0-9-]{0,99}$/.test(value)) ?? "").slice(1)
  const bots = [GITHUB_ACTIONS_BOT, ...(handle ? [`${handle}[bot]`] : [])]
  const schedulePrefix = route.kind === "schedule" ? `vector/schedule-${route.scheduleId}-` : undefined
  // Stable ids may themselves contain hyphens and digits. A prefix alone would reuse daily-123's PR for daily.
  const sameSchedule = (candidate: PublishPull) =>
    schedulePrefix !== undefined &&
    botOwned(candidate, route, bots) &&
    candidate.base.ref === route.defaultBranch &&
    candidate.head.ref.startsWith(schedulePrefix) &&
    /^[1-9]\d{0,19}-[1-9]\d{0,19}$(?![\s\S])/.test(candidate.head.ref.slice(schedulePrefix.length))
  const scheduled =
    schedulePrefix && input.api.schedulePulls
      ? (await input.api.schedulePulls(route.defaultBranch)).find(sameSchedule)
      : undefined
  const scheduleThread = scheduled ? await input.api.thread(scheduled.number, true) : undefined
  const comment = async (text: string, marker?: string) => {
    const body = `${clean(text)}${marker ? `\n\n${marker}` : ""}`
    if (number === undefined) log(text)
    else await input.api.comment(number, body)
  }
  const status = GithubAgents.MINT_STATUS.find((value) => value === env.VECTOR_AGENT_STATUS)
  if (!status) {
    await comment(REFUSAL_COMMENT.unavailable)
    return { outcome: "refused" as const }
  }
  if (status !== "ok") {
    const marker = "<!-- vector:at-once -->"
    if (
      status !== "at-once" ||
      !thread?.comments.slice(-20).some((entry) => bots.includes(entry.login) && entry.body.includes(marker))
    )
      await comment(
        `${REFUSAL_COMMENT[status]} See https://vectordev.ai/docs/vectorscope#github.`,
        status === "at-once" ? marker : undefined,
      )
    return { outcome: "refused" as const }
  }
  if (
    pull &&
    (pull.head.repositoryId !== pull.base.repositoryId || pull.base.repositoryId !== env.GITHUB_REPOSITORY_ID)
  ) {
    await comment("Vector cannot publish this task from a fork's pull request.")
    return { outcome: "refused" as const }
  }
  const bundle = await readBundle(input.bundleDirectory).catch(() => undefined)
  if (!bundle || !routingAgrees(bundle.summary, route)) {
    await comment("Vector could not safely read this run's result; retry the repository task.")
    return { outcome: "failed" as const }
  }
  const patch = validatePatch(bundle.patch)
  if (!patch.ok) {
    await comment("Vector held back this result because its patch could not be validated.")
    return { outcome: "failed" as const }
  }
  const summary = bundle.summary
  const held = patch.heldBack.length
    ? `\n\n<details><summary>Held-back GitHub configuration</summary>\n\n${patch.heldBack.map((name) => `- \`${clean(name)}\``).join("\n")}\n\n</details>`
    : ""
  const reason =
    summary.stop !== undefined || summary.draft
      ? `\n\nVector stopped early: ${GithubBundle.describeStop(summary.stop, summary.limit).reason}.`
      : ""
  if (!patch.patch || summary.outcome === "no-changes" || summary.outcome === "failed") {
    await comment(`${summary.comment || "Vector made no changes."}${reason}${held}`)
    return { outcome: summary.outcome, heldBack: patch.heldBack }
  }
  if (await gitText(input.git, ["status", "--porcelain", "--untracked-files=all"])) {
    await comment("Vector could not safely apply this result because the publishing checkout changed.")
    return { outcome: "failed" as const }
  }
  const serverStarted =
    input.event.name === "workflow_dispatch" &&
    z
      .object({
        sender: z.object({ login: z.string(), type: z.string().optional() }),
        inputs: z.object({ ticket: z.string().optional() }).optional(),
      })
      .safeParse(input.event.payload)
  const dispatchedByBot =
    serverStarted &&
    serverStarted.success &&
    serverStarted.data.sender.type === "Bot" &&
    /\[bot\]$/.test(serverStarted.data.sender.login) &&
    !!serverStarted.data.inputs?.ticket
  const useApp =
    env.VECTOR_GITHUB_AUTH === "app" &&
    input.event.name !== "pull_request_review_comment" &&
    !dispatchedByBot &&
    (thread?.writersOnly ?? scheduleThread?.writersOnly ?? true)
  const authority = await input.authorize(useApp)
  try {
    const git = authority.git
    const api = authority.api
    if ((await git(["apply", "--check", "--index", "--binary", "--whitespace=nowarn", "-"], patch.patch)).code !== 0) {
      await comment("Vector could not apply this result cleanly; retry the repository task.")
      return { outcome: "failed" as const }
    }
    await gitText(git, ["apply", "--index", "--binary", "--whitespace=nowarn", "-"], patch.patch)
    if (!(await validateStaged(git, route.baseSha))) {
      await comment(`Vector made no publishable changes.${held}`)
      return { outcome: "no-changes" as const, heldBack: patch.heldBack }
    }
    const title = clean(summary.title || "Vector repository task")
      .replace(/[\r\n]/g, " ")
      .slice(0, 256)
    const email =
      authority.auth.source === "app"
        ? `${authority.auth.botId}+${authority.auth.botLogin}@users.noreply.github.com`
        : "41898282+github-actions[bot]@users.noreply.github.com"
    await gitText(git, [
      "-c",
      `user.name=${authority.auth.botLogin}`,
      "-c",
      `user.email=${email}`,
      "commit",
      "--no-verify",
      "-m",
      title,
    ])
    let commit = await gitText(git, ["rev-parse", "HEAD"])
    const freshPr = route.pr === undefined ? undefined : await api.pull(route.pr)
    let schedule = scheduled ? await api.pull(scheduled.number) : undefined
    let scheduleMoved = false
    if (schedule) {
      if (!sameSchedule(schedule)) schedule = undefined
      else {
        await gitText(git, [
          "fetch",
          "--no-tags",
          "--no-recurse-submodules",
          "origin",
          `refs/heads/${schedule.head.ref}`,
        ])
        if ((await gitText(git, ["rev-parse", "FETCH_HEAD"])) !== schedule.head.sha) {
          scheduleMoved = true
          schedule = undefined
        } else {
          // The latest automation result replaces its pending proposal, preserving both the earlier proposal's
          // history and this run's source as parents. No merge tool, hook or repository code is executed.
          const tree = await gitText(git, ["write-tree"])
          commit = await gitText(git, [
            "-c",
            `user.name=${authority.auth.botLogin}`,
            "-c",
            `user.email=${email}`,
            "commit-tree",
            tree,
            ...[...new Set([schedule.head.sha, route.baseSha])].flatMap((parent) => ["-p", parent]),
            "-m",
            title,
          ])
        }
      }
    }
    const fresh = freshPr ?? schedule
    const stoppedDraft = summary.outcome !== "changes" || summary.draft || summary.stop !== undefined
    let draft = stoppedDraft || fresh?.draft === true || scheduleMoved
    const owned =
      schedule ??
      (fresh && botOwned(fresh, route, bots) && fresh.head.sha === route.baseSha && !stoppedDraft ? fresh : undefined)
    const ownsHead = owned !== undefined
    const newBranch = `vector/${route.kind === "schedule" ? `schedule-${route.scheduleId}` : route.kind === "pr" ? `pr${route.pr}` : route.kind === "issue" ? `issue${route.issue}` : "dispatch"}-${route.runId}-${env.GITHUB_RUN_ATTEMPT || "1"}`
    let branch = ownsHead ? owned.head.ref : newBranch
    let base = fresh ? (ownsHead ? fresh.base.ref : fresh.head.ref) : route.defaultBranch
    if (fresh && !ownsHead) draft = true
    let reused = owned?.number
    let pushed = false
    for (let attempt = 0; attempt < 3; attempt++) {
      const result = await git([
        "push",
        ...(reused === undefined ? [`--force-with-lease=refs/heads/${branch}:`] : []),
        "origin",
        `${commit}:refs/heads/${branch}`,
      ])
      if (result.code === 0) {
        pushed = true
        break
      }
      const remote = await git(["ls-remote", "--heads", "origin", `refs/heads/${branch}`])
      if (remote.code === 0 && remote.output.toString("utf8").split(/\s/)[0] === commit) {
        pushed = true
        break
      }
      if (reused !== undefined) {
        // A moved owned head is never overwritten. Preserve the result on a fresh branch and offer it into that head.
        branch = newBranch
        base = route.kind === "schedule" ? route.defaultBranch : fresh!.head.ref
        reused = undefined
        draft = true
      }
    }
    if (!pushed) throw new Error("The result branch could not be pushed safely.")
    const rid = GithubAgents.RUN_ID_PATTERN.test(env.VECTOR_RUN_ID ?? "") ? env.VECTOR_RUN_ID : undefined
    const body = `${clean(summary.body)}${reason}${held}${route.issue ? `\n\nCloses #${route.issue}` : ""}${authority.auth.source === "github" ? "\n\nCI did not run automatically for this GITHUB_TOKEN publish." : ""}${rid ? `\n\n<!-- vector:rid ${rid} -->` : ""}`
    if (reused === undefined) {
      const existing = (await api.openPulls(branch, base)).find(
        (candidate) => botOwned(candidate, route, bots) && candidate.head.ref === branch,
      )
      if (existing) {
        reused = existing.number
        draft ||= existing.draft === true
        await api.updatePull(reused, { title, body, draft })
      } else reused = (await api.createPull({ head: branch, base, title, body, draft })).number
    } else await api.updatePull(reused, { title, body, draft })
    await comment(
      `${summary.comment || "Vector published the repository changes."}\n\nhttps://github.com/${route.repository}/pull/${reused}${reason}${held}`,
    )
    return {
      outcome: draft ? ("draft" as const) : ("changes" as const),
      pullRequest: reused,
      branch,
      heldBack: patch.heldBack,
    }
  } finally {
    await authority.dispose()
  }
}

export async function createPublishApi(input: {
  token: string
  repository: string
  baseUrl?: string
}): Promise<PublishApi> {
  const { Octokit } = await import("@octokit/rest")
  const [owner, repo] = input.repository.split("/") as [string, string]
  const github = new Octokit({
    auth: input.token,
    baseUrl: input.baseUrl,
    request: { fetch: githubFetch, timeout: 20_000 },
  })
  type Pull = {
    number: number
    user?: { login: string } | null
    draft?: boolean
    head: { sha: string; ref: string; repo?: { id: number } | null }
    base: { ref: string; repo: { id: number } }
  }
  const pull = (value: Pull): PublishPull => ({
    number: value.number,
    author: value.user?.login ?? "",
    draft: value.draft ?? false,
    head: { sha: value.head.sha, ref: value.head.ref, repositoryId: String(value.head.repo?.id ?? "") },
    base: { ref: value.base.ref, repositoryId: String(value.base.repo.id) },
  })
  return {
    pull: async (number) => pull((await github.rest.pulls.get({ owner, repo, pull_number: number })).data),
    thread: async (number, pr) => {
      const issue = (await github.rest.issues.get({ owner, repo, issue_number: number })).data
      const comments: { id: number; body: string; login: string }[] = []
      const authors = new Set<string>([issue.user?.login ?? ""])
      let complete = true
      for (let page = 1; page <= 10; page++) {
        const found = (
          await github.rest.issues.listComments({ owner, repo, issue_number: number, per_page: 100, page })
        ).data
        comments.push(
          ...found.map((entry) => ({ id: entry.id, body: entry.body ?? "", login: entry.user?.login ?? "" })),
        )
        found.forEach((entry) => authors.add(entry.user?.login ?? ""))
        if (found.length < 100) break
        if (page === 10) complete = false
      }
      if (pr) {
        for (let page = 1; page <= 10; page++) {
          const found = (
            await github.rest.pulls.listReviewComments({ owner, repo, pull_number: number, per_page: 100, page })
          ).data
          found.forEach((entry) => authors.add(entry.user?.login ?? ""))
          if (found.length < 100) break
          if (page === 10) complete = false
        }
        for (let page = 1; page <= 10; page++) {
          const found = (await github.rest.pulls.listReviews({ owner, repo, pull_number: number, per_page: 100, page }))
            .data
          found.filter((entry) => entry.body?.trim()).forEach((entry) => authors.add(entry.user?.login ?? ""))
          if (found.length < 100) break
          if (page === 10) complete = false
        }
      }
      const permissions = await Promise.all(
        [...authors].map(async (username) => {
          if (!username) return false
          const result = await github.rest.repos
            .getCollaboratorPermissionLevel({ owner, repo, username })
            .catch(() => undefined)
          return (
            result !== undefined && (WRITERS.has(result.data.permission) || WRITERS.has(result.data.role_name ?? ""))
          )
        }),
      )
      return { comments, writersOnly: complete && permissions.every(Boolean) }
    },
    comment: async (number, body) => {
      await github.rest.issues.createComment({ owner, repo, issue_number: number, body })
    },
    openPulls: async (head, base) =>
      (
        await github.rest.pulls.list({ owner, repo, head: `${owner}:${head}`, base, state: "open", per_page: 100 })
      ).data.map(pull),
    schedulePulls: async (base) => {
      const found: PublishPull[] = []
      for (let page = 1; page <= 10; page++) {
        const entries = (await github.rest.pulls.list({ owner, repo, base, state: "open", per_page: 100, page })).data
        found.push(...entries.map(pull))
        if (entries.length < 100) break
      }
      return found
    },
    createPull: async (request) => {
      const created = await github.rest.pulls.create({ owner, repo, ...request })
      return { number: created.data.number }
    },
    updatePull: async (number, request) => {
      if (request.draft) {
        const current = (await github.rest.pulls.get({ owner, repo, pull_number: number })).data
        if (!current.draft)
          await github.graphql(
            "mutation VectorDraft($id: ID!) { convertPullRequestToDraft(input: {pullRequestId: $id}) { pullRequest { id } } }",
            { id: current.node_id },
          )
      }
      await github.rest.pulls.update({ owner, repo, pull_number: number, title: request.title, body: request.body })
    },
  }
}

/** Runs without a project instance: configuration, plugins, repository instructions and model services never load. */
export const githubPublish = Effect.fn("Cli.github.publish")(function* () {
  return yield* Effect.tryPromise({
    try: async () => {
      const env = process.env
      if (
        env.GITHUB_ACTIONS !== "true" ||
        env.VECTOR_PURE !== "1" ||
        env.VECTOR_DISABLE_PROJECT_CONFIG !== "1" ||
        !env.RUNNER_TEMP ||
        !env.VECTOR_REPO_DIR ||
        !env.VECTOR_BUNDLE_DIR ||
        !env.GITHUB_WORKSPACE ||
        !env.GITHUB_TOKEN ||
        !REPOSITORY.test(env.GITHUB_REPOSITORY ?? "") ||
        !env.GITHUB_EVENT_PATH
      )
        throw new Error("The publishing environment is unavailable.")
      const runner = await fs.realpath(env.RUNNER_TEMP)
      const directory = await fs.realpath(env.VECTOR_REPO_DIR)
      const bundleDirectory = path.resolve(env.VECTOR_BUNDLE_DIR)
      if (
        (await fs.realpath(process.cwd())) !== runner ||
        directory !== (await fs.realpath(env.GITHUB_WORKSPACE)) ||
        !bundleDirectory.startsWith(`${runner}${path.sep}`)
      )
        throw new Error("The publishing paths are unavailable.")
      const eventFile = await fs.lstat(env.GITHUB_EVENT_PATH)
      if (!eventFile.isFile() || eventFile.size > 2_000_000) throw new Error("The event is unavailable.")
      const payload: unknown = JSON.parse(await fs.readFile(env.GITHUB_EVENT_PATH, "utf8"))
      const repository = env.GITHUB_REPOSITORY!
      const git = createPublishGit(directory)
      const api = await createPublishApi({ token: env.GITHUB_TOKEN, repository, baseUrl: env.GITHUB_API_URL })
      return publishBundle({
        env,
        event: { name: env.GITHUB_EVENT_NAME, payload },
        bundleDirectory,
        git,
        api,
        authorize: async (app) => {
          const { setSecret } = await import("@actions/core")
          const auth = await resolveGithubAuth({
            purpose: "publish",
            repository,
            env: { ...env, VECTOR_GITHUB_AUTH: app ? "app" : "github", USE_GITHUB_TOKEN: app ? "false" : "true" },
            ...(app ? {} : { providedToken: env.GITHUB_TOKEN }),
          })
          try {
            const authorized = await prepareGithubGit({
              auth,
              identity: false,
              mask: setSecret,
              run: async (args, extra) => {
                const result = await createPublishGit(directory, extra)(args)
                return { exitCode: result.code, text: () => result.output.toString("utf8") }
              },
            })
            return {
              auth,
              api: await createPublishApi({ token: auth.token, repository, baseUrl: env.GITHUB_API_URL }),
              git: createPublishGit(directory, authorized.env),
              dispose: () => auth.dispose(),
            }
          } catch (error) {
            await auth.dispose()
            throw error
          }
        },
      })
    },
    catch: () => new CliError({ message: "Vector could not safely publish this repository task.", exitCode: 1 }),
  })
})
