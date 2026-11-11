export * as ConnectFix from "./fix"

import { realpath } from "node:fs/promises"
import path from "node:path"
import { Effect, Schema } from "effect"
import { Connect } from "@vectordevai/schema/connect"
import { ConnectFindings } from "@vectordevai/core/connect/findings"
import { ConnectFrame } from "@vectordevai/core/connect/frame"
import { ConnectPolicy } from "@vectordevai/core/connect/policy"
import { SessionID } from "@/session/schema"
import type { ConnectAdapter } from "./adapter"

// Fixing VectorScope findings through connected tools (CW-07). The Vector agent does the fixing, until VectorScope has
// a fix mode of its own: `here` hands the agent a brief and it fixes the findings itself, under its own permissions
// and file locks; `worktree` starts the hidden connect_fix child in an isolated worktree, through the task tool, with
// the owned-path rule's files as its only writable paths and a checked JSON answer. Either way the chosen findings are
// held to the owned-path rule first, and the user is asked `connect_write` once for the batch, naming the findings;
// that question is always asked (PermissionPolicy.requiresApproval), so no rule, saved approval or auto-accept answers
// it. Merging a fix child's worktree asks `connect_write` again, with the diff (TaskIsolation.merge). Nothing a
// reviewer model wrote chooses the files, the agent or the commands: the findings travel inside the labelled
// untrusted block, and the child's answer is read as data.

/** What a fix needs besides the request: the review it fixes and what the reviewed target changes now. */
export interface Input {
  readonly request: Connect.FixRequest
  readonly context: ConnectAdapter.HandoffContext
  /** The review whose findings are fixed, found in the requester's session. */
  readonly source: Connect.Run
  /** The repository's top level, where review paths start. */
  readonly root: string
  /** What the reviewed target changes now, relative to `root`. */
  readonly changed: readonly string[]
}

const isSessionID = Schema.is(SessionID)

/** Fixes the chosen findings of a review, as the request's mode says. */
export const run = Effect.fnUntraced(function* (input: Input) {
  const { request, context, source } = input
  const target = targetOf(source)
  const wanted = new Set(request.findings)
  const chosen = (source.result?.findings ?? []).filter((finding) => wanted.has(finding.id))
  const plan = ConnectPolicy.fixable({ findings: chosen, changed: input.changed })
  // The task tool names a child's files relative to the folder Vector works in, so a worktree fix keeps only the
  // files beneath it.
  const placed =
    request.mode === "worktree"
      ? yield* Effect.promise(() => within(input.root, request.directory, plan))
      : { ...plan, owned: plan.paths }
  if (placed.findings.length === 0)
    return yield* refusal(
      "input",
      `None of the chosen findings can be fixed through connect: ${placed.skipped
        .slice(0, 10)
        .map((skip) => `${skip.id} (${skip.reason})`)
        .join("; ")}.`,
    )
  if (request.mode === "worktree" && !context.launch)
    return yield* refusal(
      "unavailable",
      "Connect can fix findings in a worktree only from a tool call that can start the fix child.",
    )

  // One question for the batch, naming the findings and the files; asked every time, never saved.
  yield* context.progress({ pass: "fix", message: "Asking to fix" })
  yield* context.ask(
    ConnectPolicy.writeConsent({
      kind: "fix",
      run: source.id,
      findings: placed.findings,
      paths: placed.paths,
      mode: request.mode,
    }),
  )
  const notes = skipNotes(placed.skipped)

  if (request.mode === "here")
    return {
      state: "completed",
      summary: clip(
        `The user approved fixing ${plural(placed.findings.length, "finding")} from ${source.id} in your checkout. Nothing has changed yet: make each fix yourself, in ${plural(placed.paths.length, "file")}.`,
        Connect.MAX_SUMMARY,
      ),
      findings: placed.findings.map((finding) => ({ ...finding, status: "fixing" as const })),
      sessions: [],
      notes,
      target,
    } satisfies Connect.Result

  yield* context.progress({ pass: "fix", message: "Fixing in an isolated worktree" })
  const launched = yield* context.launch!({
    title: `Fix ${plural(placed.findings.length, "finding")} from ${source.id}`,
    prompt: brief({ source: source.id, target, findings: placed.findings, owned: placed.owned }),
    ownedPaths: placed.owned,
    schema: ConnectPolicy.FIX_SCHEMA,
  })
  const answer = ConnectPolicy.fixAnswer(launched.answer, new Set(placed.findings.map((finding) => finding.id)))
  const claimed = new Set(answer.fixed)
  const sessions = launched.sessionID && isSessionID(launched.sessionID) ? [launched.sessionID] : []
  const said =
    launched.state === "completed"
      ? [
          `The fix child says it fixed ${answer.fixed.length} of ${placed.findings.length} and skipped ${answer.skipped.length}; that is its own claim, so check its changes before they are merged.`,
        ]
      : []
  return {
    state: launched.state === "error" ? "failed" : launched.state === "cancelled" ? "cancelled" : "completed",
    summary: clip(worktreeSummary(source.id, placed.findings.length, launched), Connect.MAX_SUMMARY),
    findings: placed.findings.map((finding) => ({
      ...finding,
      status: claimed.has(finding.id) ? ("fixing" as const) : ("open" as const),
    })),
    sessions,
    notes: [...notes, ...said].slice(0, 100),
    target,
  } satisfies Connect.Result
})

/** The review target a fix works from. */
export function targetOf(source: Connect.Run): Connect.Target {
  if (source.result?.target) return source.result.target
  return source.request.action === "review" ? source.request.target : { kind: "uncommitted" }
}

/**
 * The fix child's brief: Vector's own lines, then the findings in the labelled untrusted block. The files it may write
 * are the owned-path rule's, and the task tool lists them again in its assignment.
 */
export function brief(input: {
  readonly source: string
  readonly target: Connect.Target
  readonly findings: readonly Connect.Finding[]
  readonly owned: readonly string[]
}): string {
  return [
    `Fix findings that VectorScope reported in its review ${input.source} of ${ConnectFindings.targetWords(input.target)}. The user approved fixing them in this isolated worktree.`,
    `Change only these files: ${input.owned.join(", ")}. Every other file is outside your assignment.`,
    "Confirm each finding in the code before you change anything, and skip any you cannot confirm or that needs another file.",
    "You may run only the project's own test and typecheck commands, without flags; each one asks the user first. Every other command and every network tool is denied.",
    "Answer with the ids of the findings you fixed, and each id you skipped with a short reason.",
    "",
    ConnectFrame.briefBlock(input.findings),
  ].join("\n")
}

/** What a worktree fix did, in Vector's words: the child's state and its worktree's, never the child's own text. */
function worktreeSummary(run: string, count: number, launched: ConnectAdapter.FixLaunched): string {
  const what = `The fix child for ${plural(count, "finding")} from ${run}`
  if (launched.state === "background")
    return `${what} moved to the background; its report arrives as a task note. Nothing reaches your files until its worktree is merged.`
  if (launched.state === "cancelled") return `${what} was stopped. Nothing reached your files.`
  const isolation = launched.isolation
  const kept =
    isolation && isolation.files > 0
      ? ` Its worktree keeps ${plural(isolation.files, "changed file")} (+${isolation.additions} −${isolation.deletions}), not in your files yet.`
      : ""
  if (launched.state === "error") return `${what} failed.${kept || " Nothing reached your files."}`
  if (isolation?.state === "changed") return `${what} finished.${kept} Merging them asks you again, with the diff.`
  if (isolation?.state === "unchanged") return `${what} finished and changed no files.`
  return `${what} finished.${kept || " Nothing reached your files yet."}`
}

/** Vector's notes for the findings a fix leaves out. */
function skipNotes(skipped: readonly ConnectPolicy.FixSkip[]): string[] {
  return skipped
    .slice(0, 50)
    .map((skip) => clip(`Not fixed through connect: ${skip.id}, because ${skip.reason}.`, 1_000))
}

/**
 * The fixable findings whose files lie beneath `directory`, with each owned path named relative to it, as the task
 * tool reads owned paths. A finding whose file lies elsewhere in the repository is left out with a reason.
 */
async function within(root: string, directory: string, plan: ReturnType<typeof ConnectPolicy.fixable>) {
  const top = await realpath(root).catch(() => path.resolve(root))
  const home = await realpath(directory).catch(() => path.resolve(directory))
  const relative = (file: string) => {
    const value = path.relative(home, path.join(top, file))
    if (!value || value === ".." || value.startsWith(`..${path.sep}`) || path.isAbsolute(value)) return undefined
    return value.split(path.sep).join("/")
  }
  const owned = new Map(
    plan.paths.flatMap((file) => {
      const named = relative(file)
      return named ? [[file, named] as const] : []
    }),
  )
  const findings = plan.findings.filter((finding) => owned.has(ConnectPolicy.normalizePath(finding.path) ?? ""))
  const outside = plan.findings
    .filter((finding) => !findings.includes(finding))
    .map((finding) => ({ id: finding.id, reason: "its file lies outside the folder Vector works in" }))
  return {
    findings,
    skipped: [...plan.skipped, ...outside],
    paths: [...owned.keys()],
    owned: [...owned.values()],
  }
}

function refusal(code: Connect.RefusalCode, message: string) {
  return Effect.fail(new Connect.Refusal({ code, message: clip(message, Connect.MAX_SUMMARY) }))
}

function plural(count: number, noun: string) {
  return `${count} ${noun}${count === 1 ? "" : "s"}`
}

function clip(value: string, max: number) {
  return value.length <= max ? value : value.slice(0, max - 1) + "…"
}
