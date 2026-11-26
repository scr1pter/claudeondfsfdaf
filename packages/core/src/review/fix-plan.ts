// VS-12c and VS-12d (SF-09, SF-10b): the fixes a review outcome offers and their bounded Git text patch, shared by the
// CLI's apply step (engine cli/cmd/review.fix.ts) and the desktop's fix actions (app features/vectorscope/local-fix.ts),
// so both build byte-identical proposals by one rule. Pure and browser-safe: no Node module, no Buffer. The trusted
// executor (engine review/fix.ts) checks every path, digest and patch again before it writes anything.

import { structuredPatch } from "diff"
import { applyFixPatch } from "./diff"
import { FIX_LIMITS } from "./fix-proposal"
import { MAX_FIX_HUNKS } from "./guardrail"
import { REDACTED } from "./redact"
import type { FailureClass, ReviewConfig, ReviewOutcome, Severity } from "./types"

// `start`..`end` are the head lines a "lines" fix replaces; a patch fix names its own hunks and is placed at `start`.
// `label` is what the review said of the finding: a legacy finding's severity, or a strict one's failure class (a strict
// finding has no severity).
export type FixCandidate = {
  id: string
  path: string
  start: number
  end: number
  label: Severity | FailureClass
  title: string
  kind: "lines" | "patch"
  text: string
}
export type FixLeft = { unverified: number; unfixable: number; unlisted: number; unchecked: number }
export type FixCandidates = { source: string; none: string; fixes: FixCandidate[]; left: FixLeft }
export type FixSkipped = { id: string; path: string; reason: string }
export type FixPlannedFile = {
  path: string
  before: Uint8Array
  after: Uint8Array
  patch: string
  additions: number
  deletions: number
}
export type FixPlan = { files: FixPlannedFile[]; used: FixCandidate[]; skipped: FixSkipped[] }

/**
 * The fixes this run's outcome offers. A strict result (VS-27c) is the source when there is one: its findings are
 * verified by construction, and only a suggestion or a patch the guardrail checked is taken, never an unchecked one.
 * Without it, the legacy selection's listed findings that the verify pass confirmed (`verified`) and whose suggestion
 * is committable as is (`suggestionAllowed`); a legacy `patch` is never taken, since only the strict decoder sets one
 * and only the strict guardrail checks it. Confidence and severity never choose a fix.
 */
export function fixCandidates(outcome: Pick<ReviewOutcome, "selection" | "strict">, head: string): FixCandidates {
  const strict = outcome.strict
  if (strict) {
    const current = strict.head === head
    const fixes = (current ? strict.findings : []).flatMap((finding): FixCandidate[] =>
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
  const fixes = inline.flatMap((finding): FixCandidate[] =>
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

function sortCandidates(fixes: FixCandidate[]) {
  return fixes.toSorted((a, b) =>
    a.path !== b.path ? (a.path < b.path ? -1 : 1) : a.start !== b.start ? a.start - b.start : a.id < b.id ? -1 : 1,
  )
}

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
export function planEdits(
  fixes: readonly FixCandidate[],
  heads: ReadonlyMap<string, Uint8Array | undefined>,
  config: Pick<ReviewConfig, "holdback"> = {},
): FixPlan {
  const skipped: FixSkipped[] = []
  const skip = (group: readonly FixCandidate[], reason: string) =>
    skipped.push(...group.map((fix) => ({ id: fix.id, path: fix.path, reason })))
  // A file none of whose fixes can be used: they are left out, with why.
  const drop = (group: readonly FixCandidate[], reason: string): [] => {
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
    const before = bytes && !bytes.includes(0) ? utf8(bytes) : undefined
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
    if (config.holdback === "secrets" && writesPlaceholder(before, chosen))
      return drop(chosen, `its fix writes the ${REDACTED} placeholder into the file`)
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
        const bytes = total.bytes + encoder.encode(item.file.patch).length
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

/**
 * The bytes as text when they are well-formed UTF-8, else undefined: Node's isUtf8 rule without Node. A decoder that
 * is not fatal replaces every ill-formed sequence (overlong forms, surrogates, code points past U+10FFFF, a truncated
 * tail) with U+FFFD, so the text encodes back to exactly these bytes only when there was none. A leading byte order
 * mark is kept (ignoreBOM), as the executor keeps it.
 */
function utf8(bytes: Uint8Array) {
  const text = decoder.decode(bytes)
  const again = encoder.encode(text)
  return again.length === bytes.length && again.every((byte, index) => byte === bytes[index]) ? text : undefined
}

/** The proposal contract's path rule (fix-proposal.ts `filePath`), in UTF-8 bytes; the executor checks it again. */
export function fixPath(file: string) {
  return (
    encoder.encode(file).length <= FIX_LIMITS.pathBytes &&
    /^[A-Za-z0-9_@+.,/-]+$/.test(file) &&
    file.split("/").every((part) => part !== "" && part !== "." && part !== ".." && part.toLowerCase() !== ".git")
  )
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

/** Line fixes in line order, each kept only when it starts after the last kept one ends. */
function nonOverlapping(group: readonly FixCandidate[]) {
  return group
    .toSorted((a, b) => a.start - b.start)
    .reduce<FixCandidate[]>((kept, fix) => {
      const last = kept.at(-1)
      return last && fix.start <= last.end ? kept : [...kept, fix]
    }, [])
}

/**
 * The head text with each range replaced by its suggestion, normalized as a committable suggestion is (diff.ts
 * suggestionAllowed): CRLF to LF and one trailing newline dropped. A file without a final newline keeps none.
 */
function linesText(before: string, fixes: readonly FixCandidate[]) {
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

// Read the proposed edits at their original locations. A generated diff could align a new placeholder with the
// same text elsewhere, making a replacement look like a deletion. An unchanged line can keep its literal marker.
function writesPlaceholder(before: string, fixes: readonly FixCandidate[]) {
  const original = before.split("\n")
  return fixes.some((fix) => {
    if (!fix.text.includes(REDACTED)) return false
    const lines = fix.text.replace(/\r\n/g, "\n").split("\n")
    if (fix.kind === "patch") return lines.some((line) => line.startsWith("+") && line.includes(REDACTED))
    return lines.some(
      (line, offset) =>
        line.includes(REDACTED) && (fix.start + offset > fix.end || line !== original[fix.start + offset - 1]),
    )
  })
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
