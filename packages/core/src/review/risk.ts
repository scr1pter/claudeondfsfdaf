// Change risk (VectorScope upgrade contract §1.2 and §4 VS-28 item 1, as amended by addendum A VS-39 items 1 to 3, 7
// and 8). Pure and browser-safe. Nothing calls it before VS-28 wiring, which computes the band inside Review.run under
// `depth: "auto"` and plans the passes from it (plan.ts planDepth). The band chooses review depth and nothing else: it
// never feeds Selection.risk (select.ts computeRisk) or the sticky header's "Risk:" (format.ts), and it is never posted
// as a prediction. Its reasons go to the run's notes once wired; whether they reach `--json` waits for Q28.
//
// Three axes [REPORT §5.4]:
// - likelihood: log2 of the changed lines, with directory spread and entropy as bounded tie-breakers [G2-2, RP12];
// - reach: files that depend on the changed code (VS-25's or VS-36's gated dependents), banded at PR-Agent's thresholds
//   [RP8], and missing when no slice was built;
// - impact: raise-only flags for a security-sensitive path and a deletion-heavy code change [RP6, RP7].
// History (churn, fix commits and reverts) is explanation text only, with zero weight [RP4, RP10, RP19, G2-9]. Every
// weight below is additive and documented; the cutpoints are PR-population percentiles (RISK_CUTPOINTS).

import { minimatch } from "minimatch"
import type { DiffFile } from "./diff"
import { isCodePath, isSensitivePath } from "./ignore"
import { TEST_PATHS } from "./trivial"

export const RISK_BANDS = Object.freeze(["low", "medium", "high"] as const)
// Its own type, not types.ts Risk: that one is Selection.risk's, which this band never feeds.
export type RiskBand = (typeof RISK_BANDS)[number]

export const REACH_BANDS = Object.freeze(["narrow", "moderate", "wide"] as const)
export type ReachBand = (typeof REACH_BANDS)[number]

// Narrow up to 3 dependent files, moderate up to 25, wide above. PR-Agent defines these for dependent projects only
// [RP8]; using them for dependent files is inference, a starting point that Phase A's reach fit replaces (VS-39 item 1).
export const REACH_THRESHOLDS = Object.freeze({ narrow: 3, moderate: 25 })

export const RISK_IMPACT_FLAGS = Object.freeze(["sensitive", "deletion-heavy"] as const)
export type RiskImpactFlag = (typeof RISK_IMPACT_FLAGS)[number]

// A change is deletion-heavy when its code files outside the test paths lose more lines than they gain, and at least
// this many. Both the rule and the threshold are inference: commits that add no lines are never labelled buggy under
// SZZ [RP6], so size alone under-ranks a change that removes guards (risk note §8, "deletion-heavy code change").
export const DELETION_HEAVY = Object.freeze({ minLines: 20 })

// The likelihood score's tie-breakers: each adds at most `weight`, reached at `cap` extra directories or `cap` bits of
// entropy, so together they add at most 0.5, half a doubling of the changed lines.
export const RISK_TIE_BREAKERS = Object.freeze({
  dirs: Object.freeze({ weight: 0.25, cap: 7 }),
  entropy: Object.freeze({ weight: 0.25, cap: 3 }),
})

// A score above `medium` is at least medium, above `high` high; a score exactly at a cutpoint takes the lower band.
// Seeded 2026-11-07 by research/risk_seed.py (script/vectorscope-eval) from numstat only (no code, no labels) of the
// AACR-Bench permissive positives (alibaba/aacr-bench at ee9d7fe; 131 of 140 PRs, the 9 whose commits GitHub no longer
// serves left out): round two's numstats, written by the command in research/aacr2.sh (`git diff --no-renames
// --numstat` from the merge base), at the 50th and 85th percentiles of this score, linearly interpolated (6.8783 and
// 9.1100), then rounded. With these rounded values, 15.3% of those PRs and 48.8% of their changed lines are high, and
// 50.4% of PRs and 11.4% of lines low, so the seed meets Phase A's bounds of at most 20% of PRs and 50% of lines high.
// With no tie-breaker, medium starts above about 117 changed lines and high above about 552. The seed holds until Q27
// and Q10 are answered; a per-repository refit after 200 PRs replaces it there (VS-39 item 2).
export const RISK_CUTPOINTS = Object.freeze({ medium: 6.88, high: 9.11 })

// Features a surface may not have: history needs commits CI does not fetch by default (fetch-depth 1), and dependents
// need the impact slice. riskOf lists the absent ones in this order.
export const RISK_OPTIONAL_FEATURES = Object.freeze(["churn", "fixCommits", "reverts", "dependents"] as const)
export type RiskOptionalFeature = (typeof RISK_OPTIONAL_FEATURES)[number]

// Word-anchored, so "prefix", "debug", "fixture" and "fixup" do not match [RP4, G2-9]. A revert is its own feature.
export const FIX_SUBJECT = /\b(?:fix(?:e[sd]|ing)?|bugs?|bug-?fix(?:e[sd]|ing)?|hotfix(?:e[sd]|ing)?)\b/i
export const REVERT_SUBJECT = /\brevert(?:s|ed|ing)?\b/i

export interface RiskHistory {
  churn: number // distinct commits that touched the changed files in the gatherer's window
  fixCommits: number // of them, subjects that match FIX_SUBJECT and not REVERT_SUBJECT
  reverts: number // of them, subjects that match REVERT_SUBJECT
}

export interface RiskFeatures {
  added: number
  deleted: number
  files: number
  dirs: number // distinct parent directories; the repository root counts as one
  entropy: number // Shannon entropy, in bits, of each file's share of the changed lines
  sensitive: boolean // a path or old path isSensitivePath holds for, as planSpecialists reads it
  codeAdded: number // lines added in code files outside the test paths: what the deletion-heavy flag reads
  codeDeleted: number
  testDelta: number // lines added plus deleted in test files
  testOnly: boolean // at least one file, and every one a test file, those the review skips included when given
  churn?: number
  fixCommits?: number
  reverts?: number
  dependents?: number // gated dependent files from the impact slice; absent when the slice is off
}

export interface RiskAssessment {
  band: RiskBand
  likelihood: { score: number; band: RiskBand }
  reach?: ReachBand
  impact: RiskImpactFlag[] // the flags that hold; a test-only change ignores them
  testOnly: boolean
  reasons: string[]
  missing: RiskOptionalFeature[]
}

/**
 * The features of a change, from the files the review covers: the same set planSpecialists gets, after classifyFiles.
 * A file's changed lines are its additions plus deletions, so a binary file, whose counts both parsers leave at 0, adds
 * none. A file is a test file when its path matches TEST_PATHS, and so does its old path when it has one.
 * `extra.changed` is every file the change touched, the ones classifyFiles leaves out included. Test-only reads it
 * beside `files`, so a non-test file the review skips (ignored, generated, vendored, binary or a deletion with no patch)
 * keeps the change from being test-only, as VS-39 item 1 defines it: no non-test file changed. Without it, test-only
 * reads `files` alone.
 */
export function riskFeatures(
  files: readonly Pick<DiffFile, "path" | "oldPath" | "additions" | "deletions">[],
  extra: { history?: RiskHistory; dependents?: number; changed?: readonly Pick<DiffFile, "path" | "oldPath">[] } = {},
): RiskFeatures {
  const lines = files.map((file) => count(file.additions) + count(file.deletions))
  const total = lines.reduce((sum, value) => sum + value, 0)
  const tests = files.map(isTestFile)
  const code = files.map(
    (file, index) => !tests[index] && (isCodePath(file.path) || (!!file.oldPath && isCodePath(file.oldPath))),
  )
  const touched = [...files, ...(extra.changed ?? [])]
  return {
    added: files.reduce((sum, file) => sum + count(file.additions), 0),
    deleted: files.reduce((sum, file) => sum + count(file.deletions), 0),
    files: files.length,
    dirs: new Set(files.map((file) => dirname(file.path))).size,
    // Summed as 0 − Σ p·log2 p, so a one-file change has an entropy of 0, never −0.
    entropy: lines
      .filter((value) => value > 0)
      .reduce((sum, value) => sum - (value / total) * Math.log2(value / total), 0),
    sensitive: files.some((file) => isSensitivePath(file.path) || (!!file.oldPath && isSensitivePath(file.oldPath))),
    codeAdded: files.reduce((sum, file, index) => sum + (code[index] ? count(file.additions) : 0), 0),
    codeDeleted: files.reduce((sum, file, index) => sum + (code[index] ? count(file.deletions) : 0), 0),
    testDelta: lines.reduce((sum, value, index) => sum + (tests[index] ? value : 0), 0),
    testOnly: touched.length > 0 && touched.every(isTestFile),
    ...(extra.history
      ? { churn: extra.history.churn, fixCommits: extra.history.fixCommits, reverts: extra.history.reverts }
      : {}),
    ...(extra.dependents === undefined ? {} : { dependents: extra.dependents }),
  }
}

/**
 * History counts from commit subjects: one subject per distinct commit that touched the changed files in the window the
 * caller read (VS-28 wiring's bounded 90-day window). A subject that matches REVERT_SUBJECT counts as a revert only,
 * never as a fix, so the revert of a fix is one revert.
 */
export function countHistory(subjects: readonly string[]): RiskHistory {
  return {
    churn: subjects.length,
    fixCommits: subjects.filter((subject) => !REVERT_SUBJECT.test(subject) && FIX_SUBJECT.test(subject)).length,
    reverts: subjects.filter((subject) => REVERT_SUBJECT.test(subject)).length,
  }
}

/**
 * The band of a change, with plain reasons and the features it lacked. The likelihood band comes from the score's
 * cutpoints. The impact flags and the reach only raise it: a sensitive path, or a deletion-heavy code change, makes it
 * at least medium, and a sensitive path with wide reach makes it high. Only a test-only change is lowered, to low.
 * Neither the test delta nor history ever moves it. `cutpoints` is for tests and the deferred per-repository refit.
 */
export function riskOf(
  features: RiskFeatures,
  cutpoints: { medium: number; high: number } = RISK_CUTPOINTS,
): RiskAssessment {
  const score = likelihoodScore(features)
  const likely = score > cutpoints.high ? "high" : score > cutpoints.medium ? "medium" : "low"
  const reach = features.dependents === undefined ? undefined : reachOf(count(features.dependents))
  const impact = RISK_IMPACT_FLAGS.filter((flag) =>
    flag === "sensitive" ? features.sensitive : deletionHeavy(features),
  )
  const floor = features.sensitive && reach === "wide" ? "high" : impact.length > 0 ? "medium" : "low"
  const band = features.testOnly ? "low" : RISK_BANDS[Math.max(RISK_BANDS.indexOf(likely), RISK_BANDS.indexOf(floor))]
  return {
    band,
    likelihood: { score, band: likely },
    ...(reach ? { reach } : {}),
    impact,
    testOnly: features.testOnly,
    reasons: reasons(features, likely, reach, impact),
    missing: RISK_OPTIONAL_FEATURES.filter((feature) => features[feature] === undefined),
  }
}

// log2(1 + changed lines), plus each tie-breaker's capped share of its weight.
function likelihoodScore(features: RiskFeatures) {
  const dirs = RISK_TIE_BREAKERS.dirs
  const entropy = RISK_TIE_BREAKERS.entropy
  return (
    Math.log2(1 + count(features.added) + count(features.deleted)) +
    (dirs.weight * Math.min(Math.max(count(features.dirs) - 1, 0), dirs.cap)) / dirs.cap +
    (entropy.weight * Math.min(count(features.entropy), entropy.cap)) / entropy.cap
  )
}

function reachOf(dependents: number): ReachBand {
  if (dependents <= REACH_THRESHOLDS.narrow) return "narrow"
  if (dependents <= REACH_THRESHOLDS.moderate) return "moderate"
  return "wide"
}

function deletionHeavy(features: RiskFeatures) {
  const deleted = count(features.codeDeleted)
  return deleted > count(features.codeAdded) && deleted >= DELETION_HEAVY.minLines
}

// Plain reasons in a fixed order, built from counts and fixed text only: never a path, branch name or commit subject,
// which the change's author controls (I-2). Untuned wording (I-13).
function reasons(
  features: RiskFeatures,
  likely: RiskBand,
  reach: ReachBand | undefined,
  impact: readonly RiskImpactFlag[],
) {
  const tests = count(features.testDelta)
  const history = [
    features.churn === undefined
      ? undefined
      : plural(count(features.churn), "commit", "commits") + " touched these files",
    features.fixCommits === undefined ? undefined : plural(count(features.fixCommits), "fix commit", "fix commits"),
    features.reverts === undefined ? undefined : plural(count(features.reverts), "revert", "reverts"),
  ].filter((part) => part !== undefined)
  const floors = features.testOnly
    ? ["Only test files changed, so the band is low."]
    : [
        impact.includes("sensitive") ? "A security-sensitive path changed, so the band is at least medium." : undefined,
        impact.includes("deletion-heavy")
          ? `More code lines were deleted (${count(features.codeDeleted)}) than added (${count(features.codeAdded)}), so the band is at least medium.`
          : undefined,
        impact.includes("sensitive") && reach === "wide"
          ? "A security-sensitive path changed and the reach is wide, so the band is high."
          : undefined,
      ]
  return [
    `${plural(count(features.added) + count(features.deleted), "changed line", "changed lines")} in ${plural(count(features.files), "file", "files")} across ${plural(count(features.dirs), "directory", "directories")}: ${likely} by size and spread.`,
    reach
      ? `${plural(count(features.dependents ?? 0), "file depends", "files depend")} on the changed code: ${reach} reach.`
      : undefined,
    ...floors,
    tests > 0 && !features.testOnly
      ? `${tests} of the changed lines ${tests === 1 ? "is" : "are"} in test files; tests never lower the band.`
      : undefined,
    history.length ? `History, which does not change the band: ${history.join(", ")}.` : undefined,
  ].filter((reason) => reason !== undefined)
}

function isTestFile(file: Pick<DiffFile, "path" | "oldPath">) {
  return [file.path, ...(file.oldPath ? [file.oldPath] : [])].every((path) =>
    TEST_PATHS.some((glob) => minimatch(path, glob, { dot: true, nocase: true })),
  )
}

// A count read from outside: anything negative, or not a finite number, reads as 0.
function count(value: number) {
  return Number.isFinite(value) && value > 0 ? value : 0
}

function plural(value: number, one: string, many: string) {
  return `${value} ${value === 1 ? one : many}`
}

// The POSIX dirname, with "" for a file at the repository root.
function dirname(path: string) {
  return path.slice(0, Math.max(0, path.lastIndexOf("/")))
}
