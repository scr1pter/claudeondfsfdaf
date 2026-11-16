export * as ConnectGithubAgentAdapter from "./github-agent"

import { constants } from "node:fs"
import { lstat, open } from "node:fs/promises"
import path from "node:path"
import { Effect } from "effect"
import semver from "semver"
import { GithubAgents } from "@vectordevai/core/github-agents"
import { CLI_PACKAGE, readWorkflowOptions } from "@vectordevai/core/review/workflow"
import type { Connect } from "@vectordevai/schema/connect"
import { InstanceState } from "@/effect/instance-state"
import type { ConnectAdapter } from "../adapter"

// @vector on GitHub as a member of connected tools, listed only (CW-22). It has no `handle`, so the hub refuses every
// hand-off to it as unknown before anything is read or asked, whoever asks (I8, I10). Its state comes from one bounded
// read of this repository's workflow file as a regular file: no link followed, no network, no Git process, no model.
// The `task` action (asking to post a /vector request) waits for the owner's yes, and whether `connect` is withheld on
// GitHub Actions (`GithubAgents.withheldOnActions`) is @vector's decision.

export const ID = "github-agent"

/** The most connect reads. The installer's largest file holds the schedule prompts (120 kB) three times. */
export const MAX_BYTES = 1_048_576

export const factory: ConnectAdapter.Factory = Effect.succeed({
  id: ID,
  owner: "vector-at-mention",
  describe: () =>
    Effect.gen(function* () {
      const ctx = yield* InstanceState.context
      // A folder outside Git has no repository, and its worktree "/" would read the filesystem root.
      if (ctx.worktree === "/") return member({ kind: "missing" })
      const workflow = yield* Effect.tryPromise(() => read(ctx.worktree)).pipe(
        Effect.orElseSucceed((): Workflow => ({ kind: "failed" })),
      )
      return member(workflow)
    }),
} satisfies ConnectAdapter.Adapter)

type Workflow =
  | { readonly kind: "missing" | "linked" | "not-file" | "oversized" | "failed" }
  | { readonly kind: "text"; readonly text: string }

type Pin =
  | { readonly kind: "pinned" | "below"; readonly version: string }
  | { readonly kind: "unpinned" | "unreadable" }

const FILE = GithubAgents.WORKFLOW_FILE
const PARTS = FILE.split("/")
const ANSWERS = "Answers @vector on pull requests from your own GitHub Actions."
const NO_POST = "Connect never posts to GitHub."

const REASONS = {
  missing: `Not set up in this repository (${FILE}).`,
  linked: `Connect reads ${FILE} only as a regular file, never through a link.`,
  "not-file": `${FILE} is not a regular file.`,
  oversized: `${FILE} is larger than the 1 MiB connect reads.`,
  failed: `Connect could not read ${FILE}.`,
  unpinned: `${FILE} does not pin a Vector CLI version.`,
  unreadable: `Connect could not read which Vector CLI version ${FILE} pins.`,
} as const

// The installer's `npm install -g` line for the CLI, as a step's `run:` or a line of a `run: |` block, as the desktop's
// own check reads it (desktop main/github-agents.ts). Schedule prompts are JSON on one line inside the header or an env
// value, so owner text never starts such a line. Other install commands and comments are ignored, as the desktop
// ignores them. A line without `@<version>` installs whatever is latest. A long `run:` folded by hand before the
// package name is not matched either, so a file whose install lines are all folded reads unreadable, never ready.
// The package name is @vector's own constant, so a rename there cannot leave this pattern behind.
const INSTALL = new RegExp(
  String.raw`^[ \t]*(?:-[ \t]+)?(?:run:[ \t]+)?['"]?npm install -g ${CLI_PACKAGE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:@([^\s'"]*))?(?=[\s'"]|$)`,
  "gm",
)

function member(workflow: Workflow): Connect.Member {
  const base = {
    id: ID,
    kind: "agent",
    title: "@vector on GitHub",
    summary: `${ANSWERS} ${NO_POST}`,
    owner: "vector-at-mention",
    place: "your-cloud",
    reach: "none",
  } as const
  if (workflow.kind === "missing") return { ...base, state: "not-installed", reason: REASONS.missing }
  if (workflow.kind !== "text") return { ...base, state: "unavailable", reason: REASONS[workflow.kind] }
  const found = pin(workflow.text)
  if (found.kind === "pinned")
    return { ...base, state: "ready", summary: `${ANSWERS} Pinned to ${found.version}. ${NO_POST}` }
  if (found.kind === "below")
    return {
      ...base,
      state: "unavailable",
      reason: `Pinned to ${found.version}; @vector needs Vector CLI ${GithubAgents.MIN_AGENTS_CLI} or newer.`,
    }
  return { ...base, state: "unavailable", reason: REASONS[found.kind] }
}

// Every install line must pin an exact version. The `# vector-workflow:` header is optional (the v2 workflow has none);
// one that @vector's own reader accepts must name an exact version and agree with the jobs, and one it does not accept
// is ignored, as the desktop ignores it, so a header option added by a newer CLI leaves the jobs to decide. The lowest
// version decides "below", as the desktop's cli-too-old does. MIN_AGENTS_CLI is read here, so a bump needs no change.
function pin(text: string): Pin {
  const specs = Array.from(text.matchAll(INSTALL), (match) => match[1])
  if (specs.length === 0) return { kind: "unreadable" }
  if (!specs.every(exact)) return { kind: "unpinned" }
  const header = readWorkflowOptions(text)?.version
  if (header !== undefined && !exact(header)) return { kind: "unreadable" }
  const versions = header === undefined ? specs : [...specs, header]
  const lowest = versions.reduce((low, version) => (semver.lt(version, low) ? version : low))
  if (semver.lt(lowest, GithubAgents.MIN_AGENTS_CLI)) return { kind: "below", version: lowest }
  if (new Set(versions).size > 1) return { kind: "unreadable" }
  return { kind: "pinned", version: lowest }
}

// Only an exact, bounded semver from the repository reaches the row, so repository text never adds words to it (I2).
function exact(spec: string | undefined): spec is string {
  return spec !== undefined && spec.length <= 64 && semver.valid(spec) === spec
}

// Each component under the worktree, the file included, is checked without following a link, and only a regular file
// is opened, with O_NOFOLLOW and O_NONBLOCK, so a link swapped in fails and a FIFO never blocks. After the read the walk
// runs again and must reach the same file (dev and ino), so a parent swapped for a link before the open, or a leaf link
// that a Windows runtime followed despite O_NOFOLLOW, reads `linked` or `failed`. Only a swap timed around that second
// walk escapes; Node has no per-component openat, and the read is bounded, local and only shown to the owner.
async function read(root: string): Promise<Workflow> {
  const before = await walk(root)
  if (before.kind !== "file") return before
  const handle = await open(
    path.join(root, ...PARTS),
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
  )
  try {
    const info = await handle.stat()
    if (!info.isFile()) return { kind: "not-file" }
    if (info.size > MAX_BYTES) return { kind: "oversized" }
    // One read may legally return less (a network filesystem, a signal), so it reads until the end or one byte past
    // the size, and only a file that grew or shrank while it was read differs from the size.
    const buffer = Buffer.alloc(info.size + 1)
    let count = 0
    while (count < buffer.length) {
      const result = await handle.read(buffer, count, buffer.length - count, count)
      if (result.bytesRead === 0) break
      count += result.bytesRead
    }
    if (count !== info.size) return { kind: "failed" }
    const after = await walk(root)
    if (after.kind === "linked") return after
    if (after.kind !== "file" || after.dev !== info.dev || after.ino !== info.ino) return { kind: "failed" }
    return { kind: "text", text: buffer.subarray(0, count).toString("utf8") }
  } finally {
    await handle.close()
  }
}

// The lstat of each component in order, stopping at the first that is missing or a link: the order and the early
// returns are the check, so it stays a loop.
async function walk(root: string) {
  for (const index of PARTS.keys()) {
    const info = await lstat(path.join(root, ...PARTS.slice(0, index + 1))).catch(absent)
    if (!info) return { kind: "missing" } as const
    if (info.isSymbolicLink()) return { kind: "linked" } as const
    if (index === PARTS.length - 1)
      return info.isFile() ? ({ kind: "file", dev: info.dev, ino: info.ino } as const) : ({ kind: "not-file" } as const)
  }
  return { kind: "missing" } as const
}

// ENOTDIR covers a parent that is a regular file.
const absent = (cause: unknown) =>
  typeof cause === "object" &&
  cause !== null &&
  "code" in cause &&
  (cause.code === "ENOENT" || cause.code === "ENOTDIR")
    ? undefined
    : Promise.reject(cause)
