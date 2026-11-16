// VS-12c (SF-09): `vector review --apply`, the CLI's consented apply step. After a review of your own branch, the
// verified findings this run made with a fix Vector can apply become one fix proposal. The trusted executor
// (review/fix.ts) applies it in a separate checkout detached at the reviewed commit and, only if you approve that too,
// commits it to a new local branch. Each step is shown in full and asked separately; nothing is pushed and no command
// runs. Review mode gains nothing: the step runs after the review, from its in-memory outcome, never from PR text, a
// stored review or a score. Hidden, and honoured only with the global experimental.vectorscope setting (Q16/D14).

import { isUtf8 } from "node:buffer"
import type { Readable } from "node:stream"
import { createHash } from "node:crypto"
import { Cause, Effect, Layer } from "effect"
import { structuredPatch } from "diff"
import { FSUtil } from "@vectordevai/core/fs-util"
import { applyFixPatch } from "@vectordevai/core/review/diff"
import { createFixConsentPolicy, FIX_LIMITS, type FixProposal } from "@vectordevai/core/review/fix-proposal"
import { MAX_FIX_HUNKS } from "@vectordevai/core/review/guardrail"
import type { FailureClass, ReviewOutcome, Severity } from "@vectordevai/core/review/types"
import { AppNodeBuilderV1 } from "@/effect/app-node-builder-v1"
import { ReviewFix } from "@/review/fix"
import type { ReviewGit } from "@/review/git"
import type { LocalTarget } from "./review.render"

export type Ask = (question: string) => Promise<boolean>

export interface FixStepInput {
  git: ReviewGit.Client
  root: string
  target: LocalTarget
  outcome: ReviewOutcome
  say: (text: string) => void
  now: () => number
}

export interface FixStep {
  // Why --apply cannot run here, asked before anything is reviewed; undefined when it may.
  refusal: (env: Record<string, string | undefined>) => string | undefined
  // Why --apply cannot fix this branch (none when HEAD is detached), asked once it is known, still before the review.
  branchRefusal: (branch: string | undefined) => string | undefined
  // Never fails and never changes the review's result: it reports on stderr only.
  run: (input: FixStepInput) => Effect.Effect<void>
}

/**
 * The step `vector review --apply` runs: its questions on the terminal, and the executor built through the running
 * app's shared memo map (as control-plane/workspace.ts provides InstanceStore), so the task isolation registry, Git and
 * the process spawner it uses are the app's own.
 */
export function cliFixStep(input: { experimental: boolean; ask?: Ask }) {
  return fixStep({
    experimental: input.experimental,
    interactive: process.stdin.isTTY === true && process.stderr.isTTY === true,
    ask: input.ask ?? terminalAsk,
    executor: AppNodeBuilderV1.build(ReviewFix.node),
  })
}

export function fixStep(input: {
  experimental: boolean
  interactive: boolean
  ask: Ask
  executor: Layer.Layer<ReviewFix.Service, unknown>
}): FixStep {
  return {
    refusal: (env) => fixRefusal({ env, interactive: input.interactive, experimental: input.experimental }),
    branchRefusal: (branch) =>
      !branch
        ? "--apply needs a checked-out branch, and HEAD is detached. Nothing was reviewed."
        : !plainBranch(branch)
          ? "--apply needs a branch name of letters, digits and _ . / - that a fix proposal can name. Nothing was reviewed."
          : undefined,
    run: (step) =>
      runFixStep({ ...step, ask: input.ask }).pipe(
        Effect.provide(input.executor),
        // Every refusal is reported where it happens; what reaches here is a defect or the executor failing to start.
        Effect.catchCause((cause) =>
          Cause.hasInterruptsOnly(cause)
            ? Effect.interrupt
            : Effect.logError("the review fix step failed", { cause }).pipe(
                Effect.andThen(
                  Effect.sync(() =>
                    step.say(
                      "The fix step stopped with an unexpected error, which Vector logged. Your branch, index and files were not changed.",
                    ),
                  ),
                ),
              ),
        ),
      ),
  }
}

/** Why --apply may not run in this process, in the order a person can act on it; each refusal comes before a review. */
export function fixRefusal(input: {
  env: Record<string, string | undefined>
  interactive: boolean
  experimental: boolean
}) {
  if (!input.experimental)
    return "--apply is experimental: turn on experimental.vectorscope in your global Vector settings to use it. Nothing was reviewed."
  if (process.platform !== "linux") return "--apply is available on Linux only. Nothing was reviewed."
  if (ReviewFix.runnerContext(input.env)) return "--apply never runs in a CI job or a GitHub run. Nothing was reviewed."
  // The diff and every question go to stderr, so both ends must be a person's terminal.
  if (!input.interactive)
    return "--apply needs a terminal, on stdin and stderr, to show each step and ask before it. Nothing was reviewed."
  return undefined
}

/** A branch name the fix proposal contract accepts (fix-proposal.ts `branch`); the executor checks it again. */
export function plainBranch(name: string) {
  return (
    name.length <= 256 &&
    /^[A-Za-z0-9_./-]+$/.test(name) &&
    !name.includes("..") &&
    !name.includes("//") &&
    name
      .split("/")
      .every((part) => part !== "" && !part.startsWith(".") && !part.endsWith(".") && !part.endsWith(".lock"))
  )
}

/**
 * A yes or no on the terminal, typed to the question as it is shown: input typed before it is dropped first. Ctrl-C and
 * the end of input answer no, so the step's cleanup always runs. The review's own questions (the cost estimate,
 * --checks) keep their reader.
 */
export async function terminalAsk(
  question: string,
  streams: { input: TerminalInput; output: NodeJS.WritableStream; terminal?: boolean } = {
    input: process.stdin,
    output: process.stderr,
  },
) {
  const readline = await import("node:readline")
  if (!(await dropTypedAhead(streams.input))) return false
  return new Promise<boolean>((resolve) => {
    const rl = readline.createInterface({
      input: streams.input,
      output: streams.output,
      ...(streams.terminal === undefined ? {} : { terminal: streams.terminal }),
    })
    rl.on("SIGINT", () => {
      streams.output.write("\n")
      resolve(false)
      rl.close()
    })
    rl.on("close", () => resolve(false))
    rl.question(`${question} `, (answer) => {
      resolve(/^y(es)?$/i.test(answer.trim()))
      rl.close()
    })
  })
}

type TerminalInput = Readable & { isTTY?: boolean; isRaw?: boolean; setRawMode?: (mode: boolean) => unknown }

// How long input is read and dropped before a question; what a terminal already holds arrives at once.
const TYPED_AHEAD_MS = 100

/**
 * Drops what was typed before a question: keys pressed during the review, or a second "y" typed with the last answer,
 * would otherwise answer it before the person has read what it asks. A terminal is read raw meanwhile, so a line
 * typed without Enter goes too. False when that input ended or held a Ctrl-C, either of which answers no.
 */
async function dropTypedAhead(input: TerminalInput) {
  const raw = input.isTTY === true && input.isRaw !== true
  if (raw) input.setRawMode?.(true)
  const typed: string[] = []
  const drop = (chunk: unknown) => typed.push(String(chunk))
  input.on("data", drop)
  // A reader that closed earlier left the input paused, and a "data" listener alone does not resume it.
  input.resume()
  await new Promise((resolve) => setTimeout(resolve, TYPED_AHEAD_MS))
  input.off("data", drop)
  input.pause()
  if (raw) input.setRawMode?.(false)
  return !input.readableEnded && !typed.join("").includes("\u0003")
}

// How long an approval may wait for its step; each step runs right after its "y".
const CONSENT_MS = 60_000

const runFixStep = Effect.fn("Cli.review.fix")(function* (input: FixStepInput & { ask: Ask }) {
  const fix = yield* ReviewFix.Service
  const target = input.target
  if (target.kind !== "branch" || !target.branch)
    return input.say("Nothing was applied: --apply needs a review of a checked-out branch.")
  const found = fixCandidates(input.outcome, target.head)
  input.say(found.source)
  if (!found.fixes.length) return input.say(`Nothing to apply: ${found.none}${leftOut(found.left, [])}`)
  const planned = planEdits(found.fixes, yield* readHeads(input.git, input.root, target.head, found.fixes))
  if (!planned.files.length)
    return input.say(`Nothing to apply: no fix could be made into a patch.${leftOut(found.left, planned.skipped)}`)
  const identity = yield* commitIdentity(input.git, input.root)
  if (!person(identity))
    return input.say(
      "Nothing was applied: your Git user.name and user.email are not a plain name and address, so the fix could not be committed with them.",
    )
  return yield* Effect.gen(function* () {
    const placement = yield* fix.reserve({ head: target.head })
    return yield* offer({ fix, input, found, planned, placement, identity }).pipe(
      Effect.ensuring(cleanup(fix, placement, input.say)),
    )
  }).pipe(
    Effect.catchTag("ReviewFix.Refused", (error) =>
      Effect.sync(() => input.say(`Nothing was applied: ${error.message}`)),
    ),
  )
})

/** The proposal and its preview, then the apply and the commit, each asked and approved on its own. */
const offer = Effect.fnUntraced(function* (step: {
  fix: ReviewFix.Interface
  input: FixStepInput & { ask: Ask }
  found: Candidates
  planned: Planned
  placement: ReviewFix.Placement
  identity: ReviewFix.Identity
}) {
  const input = step.input
  const target = input.target
  const fixID = step.placement.fixID
  if (!(yield* sameRepository(input.git, input.root, step.placement.repository)))
    return input.say("Nothing was applied: the fix checkout belongs to another repository than the one reviewed.")
  const destination = `vector/fix-${fixID.slice(4, 12)}`
  const proposal: FixProposal = {
    version: 1,
    scope: {
      kind: "local",
      repository: step.placement.repository,
      worktree: step.placement.worktree,
      sourceBranch: target.branch!,
      // No ref of the base is read; a --base that is not a plain branch name is named by its commit.
      baseBranch: plainBranch(target.baseRef) ? target.baseRef : target.mergeBase,
      destinationBranch: destination,
    },
    base: target.mergeBase,
    head: target.head,
    findings: [...new Set(step.planned.used.map((fix) => fix.id))].sort(),
    files: step.planned.files.map((file) => ({
      path: file.path,
      preimage: `sha256:${sha256(file.before)}`,
      postimage: `sha256:${sha256(file.after)}`,
    })),
    patch: step.planned.files.map((file) => file.patch).join(""),
  }
  const preview = yield* step.fix.preview({ fixID, proposal })
  input.say(describe({ preview, target, found: step.found, planned: step.planned }))
  const applyQuestion =
    "Apply this patch in the separate fix checkout? Your checkout, index and files are not changed. (y/N)"
  if (!(yield* Effect.promise(() => input.ask(applyQuestion)))) return input.say("Nothing was applied.")
  const policy = createFixConsentPolicy(input.now)
  const actor = `local-cli:uid-${process.getuid?.() ?? "unknown"}`
  const apply = yield* Effect.promise(() => policy.approve(proposal, { kind: "apply" }, actor, CONSENT_MS))
  if (!apply.ok) return input.say(`Nothing was applied (the consent was refused: ${apply.reason}).`)
  yield* step.fix.apply({ fixID, proposal, consent: apply.consent, policy, actor })
  const message = commitMessage({ proposal, planned: step.planned, digest: preview.digest })
  input.say(`Applied in the fix checkout ${step.placement.worktree}.\nCommit message:\n${indent(message)}`)
  const commitQuestion = `Commit it as ${step.identity.name} <${step.identity.email}> to the new branch ${destination} in this repository? Your branch, index and files stay as they are; nothing is pushed. (y/N)`
  if (!(yield* Effect.promise(() => input.ask(commitQuestion))))
    return input.say("Not committed; the fix checkout is removed.")
  const operation = { kind: "commit" as const, message }
  const approved = yield* Effect.promise(() => policy.approve(proposal, operation, actor, CONSENT_MS))
  if (!approved.ok) return input.say(`Not committed (the consent was refused: ${approved.reason}).`)
  return yield* step.fix
    .commit({ fixID, proposal, operation, identity: step.identity, consent: approved.consent, policy, actor })
    .pipe(
      Effect.map((committed) =>
        input.say(
          [
            `Committed ${committed.commit.slice(0, 7)} on the new branch ${committed.branch}. Nothing was pushed.`,
            `To use it: git merge ${committed.branch} (or git cherry-pick ${committed.commit.slice(0, 7)}); push it yourself if you want it on a remote.`,
            `To review the fixed branch: git switch ${committed.branch}, then vector review --apply.`,
          ].join("\n"),
        ),
      ),
      Effect.catchTag("ReviewFix.Refused", (error) => Effect.sync(() => input.say(`Not committed: ${error.message}`))),
    )
})

/** Removes the placement whatever happened; one that is kept is reported with its path and why. */
const cleanup = (fix: ReviewFix.Interface, placement: ReviewFix.Placement, say: (text: string) => void) =>
  fix.cancel(placement.fixID).pipe(
    Effect.flatMap((result) =>
      result.removed
        ? Effect.void
        : Effect.sync(() => say(`The fix checkout ${placement.worktree} was kept: ${result.reason}`)),
    ),
    Effect.catchTag("ReviewFix.Refused", (error) =>
      Effect.sync(() =>
        say(
          `The fix checkout ${placement.worktree} could not be removed now (${error.message}); Vector removes it at its next start.`,
        ),
      ),
    ),
  )

/** Both directories belong to one Git repository (a linked worktree's common folder is its repository's). */
const sameRepository = Effect.fnUntraced(function* (git: ReviewGit.Client, root: string, repository: string) {
  const common = (cwd: string) =>
    git
      .run(["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd })
      .pipe(Effect.map((result) => (result.exitCode === 0 ? FSUtil.realpath(result.text().trim()) : undefined)))
  const mine = yield* common(root)
  return mine !== undefined && mine === (yield* common(repository))
})

/**
 * The commit's author and committer: your Git identity in the reviewed repository, field by field, or Vector's where
 * one is unset, as task commits do (task/isolation.ts `identity`, isolation-base.ts). The commit question names it.
 */
const commitIdentity = Effect.fnUntraced(function* (git: ReviewGit.Client, root: string) {
  const read = (key: string) =>
    git
      .run(["config", "--default", "", "--get", key], { cwd: root })
      .pipe(Effect.map((result) => (result.exitCode === 0 ? result.text().trim() : "")))
  return { name: (yield* read("user.name")) || "Vector", email: (yield* read("user.email")) || "bot@vectordev.ai" }
})

/** The executor's rule for a commit identity (review/fix.ts `person`), so a commit it would refuse is never offered. */
function person(identity: ReviewFix.Identity) {
  const plain = (value: string) =>
    value.length > 0 &&
    Buffer.byteLength(value) <= 256 &&
    value.isWellFormed() &&
    value.trim() === value &&
    !/[<>\0\r\n]/.test(value)
  return plain(identity.name) && plain(identity.email) && /^[^\s@]+@[^\s@]+$/.test(identity.email)
}

// `start`..`end` are the head lines a "lines" fix replaces; a patch fix names its own hunks and is placed at `start`.
// `label` is what the review said of the finding: a legacy finding's severity, or a strict one's failure class (a strict
// finding has no severity).
type Candidate = {
  id: string
  path: string
  start: number
  end: number
  label: Severity | FailureClass
  title: string
  kind: "lines" | "patch"
  text: string
}
type Left = { unverified: number; unfixable: number; unlisted: number; unchecked: number }
type Candidates = { source: string; none: string; fixes: Candidate[]; left: Left }
type Skipped = { id: string; path: string; reason: string }
type PlannedFile = {
  path: string
  before: Uint8Array
  after: Uint8Array
  patch: string
  additions: number
  deletions: number
}
type Planned = { files: PlannedFile[]; used: Candidate[]; skipped: Skipped[] }

/**
 * The fixes this run's outcome offers. A strict result (VS-27c) is the source when there is one: its findings are
 * verified by construction, and only a suggestion or a patch the guardrail checked is taken, never an unchecked one.
 * Without it, the legacy selection's listed findings that the verify pass confirmed (`verified`) and whose suggestion
 * is committable as is (`suggestionAllowed`); a legacy `patch` is never taken, since only the strict decoder sets one
 * and only the strict guardrail checks it. Confidence and severity never choose a fix.
 */
export function fixCandidates(outcome: ReviewOutcome, head: string): Candidates {
  const strict = outcome.strict
  if (strict) {
    const current = strict.head === head
    const fixes = (current ? strict.findings : []).flatMap((finding): Candidate[] =>
      finding.side === "RIGHT" && (finding.fix.kind === "suggestion" || finding.fix.kind === "patch")
        ? [
            {
              id: finding.id,
              path: finding.path,
              start: finding.line,
              end: finding.endLine ?? finding.line,
              label: finding.class,
              title: finding.title,
              kind: finding.fix.kind === "patch" ? "patch" : "lines",
              text: finding.fix.text,
            },
          ]
        : [],
    )
    return {
      source: "Fix source: the strict guardrail's verified findings, with the fixes it checked.",
      none: current
        ? "no verified finding has a checked suggestion or patch."
        : "the strict result is for another commit than the one reviewed.",
      fixes: sortCandidates(fixes),
      left: {
        unverified: 0,
        unfixable: 0,
        unlisted: 0,
        unchecked: strict.findings.filter((finding) => finding.fix.kind === "unchecked").length,
      },
    }
  }
  const inline = outcome.selection.inline
  const fixes = inline.flatMap((finding): Candidate[] =>
    finding.verified === true && finding.suggestionAllowed && finding.suggestion !== undefined
      ? [
          {
            id: finding.id,
            path: finding.anchor.path,
            start: finding.anchor.startLine ?? finding.anchor.line,
            end: finding.anchor.line,
            label: finding.severity,
            title: finding.title,
            kind: "lines",
            text: finding.suggestion,
          },
        ]
      : [],
  )
  return {
    source:
      "Fix source: this review's listed findings that its verify pass confirmed, with a suggestion that can be committed as is.",
    none: "no verified finding has a suggestion that can be committed as is.",
    fixes: sortCandidates(fixes),
    left: {
      unverified: inline.filter((finding) => finding.suggestion !== undefined && finding.verified !== true).length,
      unfixable: inline.filter(
        (finding) => finding.verified === true && (finding.suggestion === undefined || !finding.suggestionAllowed),
      ).length,
      unlisted: [...outcome.selection.overflow, ...outcome.selection.nits].filter(
        (finding) => finding.verified === true && finding.suggestion !== undefined,
      ).length,
      unchecked: 0,
    },
  }
}

function sortCandidates(fixes: Candidate[]) {
  return fixes.toSorted((a, b) =>
    a.path !== b.path ? (a.path < b.path ? -1 : 1) : a.start !== b.start ? a.start - b.start : a.id < b.id ? -1 : 1,
  )
}

/** The head bytes of each path a fix changes, through Git's single-blob read (never `cat-file --batch`). */
const readHeads = Effect.fnUntraced(function* (
  git: ReviewGit.Client,
  root: string,
  head: string,
  fixes: readonly Candidate[],
) {
  const paths = [...new Set(fixes.map((fix) => fix.path))].filter(fixPath)
  const read = yield* Effect.forEach(paths, (file) =>
    git
      .run(["cat-file", "blob", `${head}:${file}`], { cwd: root })
      .pipe(
        Effect.map(
          (result) =>
            [file, result.exitCode === 0 && !result.truncated ? new Uint8Array(result.stdout) : undefined] as const,
        ),
      ),
  )
  return new Map(read)
})

// The executor decodes the head the same way, so the postimage digests match (a byte order mark stays in the text).
const decoder = new TextDecoder("utf-8", { ignoreBOM: true })
const encoder = new TextEncoder()
// What a terminal may not show as it is: C0 and C1 controls but tab and newline (so CR too), DEL, Unicode format
// characters (bidi overrides and isolates, zero-width and invisible ones) and the line and paragraph separators. A file
// with any, at head or after the fix, is left out, so the diff a person approves reads as the bytes applied. A byte
// order mark that opens the file is the one exception.
const UNSHOWN = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F\p{Cf}\u2028\u2029]/u
const unshown = (text: string) => UNSHOWN.test(text.replace(/^\uFEFF/, ""))

/**
 * Each file's postimage from its fixes: a patch fix is the only fix for its file, a line fix that overlaps one kept
 * before it is left out, and the rest apply bottom-up. Capped at the proposal contract's finding, file, line and byte
 * limits: files are taken in path order, and one whose patch would take the total over the line or byte limit is left
 * out while the files after it can still fit, so a long review never makes the whole proposal unacceptable.
 */
export function planEdits(fixes: readonly Candidate[], heads: ReadonlyMap<string, Uint8Array | undefined>): Planned {
  const skipped: Skipped[] = []
  const skip = (group: readonly Candidate[], reason: string) =>
    skipped.push(...group.map((fix) => ({ id: fix.id, path: fix.path, reason })))
  // A file none of whose fixes can be used: they are left out, with why.
  const drop = (group: readonly Candidate[], reason: string): [] => {
    skip(group, reason)
    return []
  }
  skip(fixes.slice(FIX_LIMITS.findings), "over the proposal's finding limit")
  const admitted = fixes.slice(0, FIX_LIMITS.findings)
  skip(
    admitted.filter((fix) => !fixPath(fix.path)),
    "a path a fix proposal cannot name",
  )
  const byFile = Map.groupBy(
    admitted.filter((fix) => fixPath(fix.path)),
    (fix) => fix.path,
  )
  const files = [...byFile.entries()].flatMap(([file, group]) => {
    const bytes = heads.get(file)
    const before = bytes && !bytes.includes(0) && isUtf8(bytes) ? decoder.decode(bytes) : undefined
    if (!bytes || before === undefined)
      return drop(group, "the file is not UTF-8 text Vector can read at the reviewed commit")
    if (unshown(before)) return drop(group, "the file holds control or invisible characters, or CR line endings")
    const patch = group.find((fix) => fix.kind === "patch")
    const chosen = patch ? [patch] : nonOverlapping(group)
    skip(
      group.filter((fix) => !chosen.includes(fix)),
      patch ? "another fix changes this file" : "it overlaps another fix",
    )
    const after = patch ? patchText(before, file, patch.text) : linesText(before, chosen)
    if (after === undefined) return drop(chosen, "its fix does not apply to the reviewed commit")
    if (unshown(after)) return drop(chosen, "its fix adds control or invisible characters")
    if (after === before) return drop(chosen, "its fix changes nothing")
    return [
      {
        file: { path: file, before: bytes, after: encoder.encode(after), ...gitPatch(file, before, after) },
        used: chosen,
      },
    ]
  })
  const kept = files
    .toSorted((a, b) => (a.file.path < b.file.path ? -1 : 1))
    .reduce<{ items: typeof files; lines: number; bytes: number }>(
      (total, item) => {
        const lines = total.lines + item.file.additions + item.file.deletions
        const bytes = total.bytes + Buffer.byteLength(item.file.patch)
        const reason =
          total.items.length === FIX_LIMITS.files
            ? "over the proposal's file limit"
            : lines > FIX_LIMITS.lines || bytes > FIX_LIMITS.patchBytes
              ? "over the proposal's size limit"
              : undefined
        if (!reason) return { items: [...total.items, item], lines, bytes }
        skip(item.used, reason)
        return total
      },
      { items: [], lines: 0, bytes: 0 },
    ).items
  return { files: kept.map((item) => item.file), used: kept.flatMap((item) => item.used), skipped }
}

// The proposal contract's path rule (fix-proposal.ts `filePath`); the executor checks it again.
function fixPath(file: string) {
  return (
    Buffer.byteLength(file) <= FIX_LIMITS.pathBytes &&
    /^[A-Za-z0-9_@+.,/-]+$/.test(file) &&
    file.split("/").every((part) => part !== "" && part !== "." && part !== ".." && part.toLowerCase() !== ".git")
  )
}

/** Line fixes in line order, each kept only when it starts after the last kept one ends. */
function nonOverlapping(group: readonly Candidate[]) {
  return group
    .toSorted((a, b) => a.start - b.start)
    .reduce<Candidate[]>((kept, fix) => {
      const last = kept.at(-1)
      return last && fix.start <= last.end ? kept : [...kept, fix]
    }, [])
}

/**
 * The head text with each range replaced by its suggestion, normalized as a committable suggestion is (diff.ts
 * suggestionAllowed): CRLF to LF and one trailing newline dropped. A file without a final newline keeps none.
 */
function linesText(before: string, fixes: readonly Candidate[]) {
  const records: string[] = before.match(/[^\n]*\n|[^\n]+$/g) ?? []
  if (fixes.some((fix) => fix.start < 1 || fix.end < fix.start || fix.end > records.length)) return undefined
  return fixes
    .toSorted((a, b) => b.start - a.start)
    .reduce((lines, fix) => {
      const replacement = fix.text.replace(/\r\n/g, "\n").replace(/\n$/, "").split("\n")
      const open = fix.end === lines.length && !lines[lines.length - 1].endsWith("\n")
      const added = replacement.map((line, index) => (open && index === replacement.length - 1 ? line : `${line}\n`))
      return [...lines.slice(0, fix.start - 1), ...added, ...lines.slice(fix.end)]
    }, records)
    .join("")
}

/** A strict patch fix, applied as the guardrail checked it (S6: exact positions, at most MAX_FIX_HUNKS hunks). */
function patchText(before: string, file: string, patch: string) {
  const applied = applyFixPatch(before, patch, { path: file, maxHunks: MAX_FIX_HUNKS })
  return applied.ok ? applied.text : undefined
}

/**
 * Git's text patch of one modified file, in the contract's subset (fix-proposal.ts patchMatches): no index line, three
 * lines of context, jsdiff's hunks with the zero-count start one lower, and "\ No newline at end of file" kept.
 */
function gitPatch(file: string, before: string, after: string) {
  const hunks = structuredPatch(`a/${file}`, `b/${file}`, before, after, undefined, undefined, { context: 3 }).hunks
  const body = hunks.flatMap((hunk) => [
    `@@ -${hunk.oldLines === 0 ? hunk.oldStart - 1 : hunk.oldStart},${hunk.oldLines} +${hunk.newLines === 0 ? hunk.newStart - 1 : hunk.newStart},${hunk.newLines} @@`,
    ...hunk.lines,
  ])
  const changes = hunks.flatMap((hunk) => hunk.lines)
  return {
    patch: [`diff --git a/${file} b/${file}`, `--- a/${file}`, `+++ b/${file}`, ...body].join("\n") + "\n",
    additions: changes.filter((line) => line.startsWith("+")).length,
    deletions: changes.filter((line) => line.startsWith("-")).length,
  }
}

/** Everything the apply question covers: the fixes, the checkout, the branches, the destination, the commands, the patch. */
function describe(input: { preview: ReviewFix.Preview; target: LocalTarget; found: Candidates; planned: Planned }) {
  const preview = input.preview
  const count = input.planned.used.length
  const status = { added: "A", deleted: "D", modified: "M" } as const
  return [
    "",
    `Vector can apply ${count} verified ${count === 1 ? "fix" : "fixes"} from this review, all together:`,
    ...input.planned.used.map((fix) => `  ${fix.id}  ${fix.label}  ${fix.path}:${fix.start}  ${shown(fix.title)}`),
    ...leftOutLines(input.found.left, input.planned.skipped),
    `Fix checkout: ${preview.worktree} (separate from yours, detached at ${preview.head.slice(0, 7)})`,
    `Repository: ${preview.repository}`,
    `Branch: ${preview.sourceBranch} at ${preview.head.slice(0, 7)}; base ${input.target.baseRef} (${preview.base.slice(0, 7)})`,
    `Destination: a new branch ${preview.destinationBranch} in this repository, only if you approve the commit`,
    "Commands: none",
    "Files:",
    ...preview.files.map((file) => `  ${status[file.status]} ${file.path} (+${file.additions} -${file.deletions})`),
    `Proposal: ${preview.digest}`,
    "",
    preview.patch.replace(/\n$/, ""),
    "",
  ].join("\n")
}

function leftOutLines(left: Left, skipped: readonly Skipped[]) {
  return [
    ...(left.unverified ? [`Left out: ${left.unverified} with a suggestion the verify pass did not confirm.`] : []),
    ...(left.unfixable
      ? [`Left out: ${left.unfixable} verified without a suggestion that can be committed as is.`]
      : []),
    ...(left.unchecked ? [`Left out: ${left.unchecked} verified with a fix the guardrail could not check.`] : []),
    ...(left.unlisted
      ? [
          `Left out: ${left.unlisted} verified with a suggestion but not listed in detail; raise --max-comments or lower --min-severity to include them.`,
        ]
      : []),
    // A path that is left out can be any file name the diff holds, terminal controls included.
    ...skipped.map((item) => `Left out: ${item.id} (${shown(item.path)}): ${item.reason}.`),
  ]
}

function leftOut(left: Left, skipped: readonly Skipped[]) {
  const lines = leftOutLines(left, skipped)
  return lines.length ? `\n${lines.join("\n")}` : ""
}

/**
 * Only finding IDs, paths and lines, the reviewed commit and the proposal digest, so no model text or private review
 * context reaches the commit. Within the contract's message limit.
 */
function commitMessage(input: { proposal: FixProposal; planned: Planned; digest: string }) {
  const count = input.proposal.findings.length
  const head = [
    `Apply Vector review fixes for ${count} verified ${count === 1 ? "finding" : "findings"}`,
    "",
    `Reviewed commit: ${input.proposal.head}`,
    `Proposal: ${input.digest}`,
  ]
  const full = [...head, "", ...input.planned.used.map((fix) => `- ${fix.id} at ${fix.path}:${fix.start}`)].join("\n")
  return Buffer.byteLength(full) < FIX_LIMITS.messageBytes ? `${full}\n` : `${head.join("\n")}\n`
}

/** Model text as a terminal shows it: every control or format character escaped, and at most 160 characters. */
function shown(text: string) {
  const escaped = text.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, (char) => `\\u{${char.codePointAt(0)!.toString(16)}}`)
  return escaped.length > 160 ? `${escaped.slice(0, 159)}…` : escaped
}

function indent(text: string) {
  return text
    .replace(/\n$/, "")
    .split("\n")
    .map((line) => `  ${line}`)
    .join("\n")
}

function sha256(bytes: Uint8Array) {
  return createHash("sha256").update(bytes).digest("hex")
}
