// Runtime evidence (VectorScope upgrade contract §1.2 `runtime.ts` and §4 VS-30, the core contract only; addendum A §3
// VS-30 and VS-27). Pure and browser-safe. Nothing calls it before the VS-30 executor, which lands after
// `self-evolving`, VS-12 and VS-18: it will run the project's tests, coverage and reproducers on the head and base
// commits in isolation, with per-operation consent through `--checks` (I-6, D10), and write these records from what it
// saw. Until then no check runs and no runner reads the `runtime` key.
//
// The code under review controls its own tests and everything they print (I-2), so test and coverage output is
// untrusted data, and only the exit codes the executor recorded decide. Only a differential between base and head
// counts [evidence §5.1, the oracle problem]: a reproducer that fails on head proves nothing unless it passes on base,
// it failed at an assertion, and that assertion states the finding rather than the change's intended behaviour. Only
// "confirmed" changes a finding (applyRuntimeVerdict); "contradicted" is evidence only and never drops, downgrades or
// un-verifies one (contract §1.2).

import { minimatch } from "minimatch"
import type { DiffFile } from "./diff"
import { isCodePath } from "./ignore"
import { isCoverageCommand } from "./permission"
import { TEST_PATHS } from "./trivial"
import type { Finding } from "./types"

export const RUNTIME_VERDICTS = Object.freeze(["confirmed", "inconclusive", "contradicted"] as const)
export type RuntimeVerdict = (typeof RUNTIME_VERDICTS)[number]

// Runs the executor itself stopped at one of RUNTIME_LIMITS, so their result is unknown.
export const RUNTIME_STOPS = Object.freeze(["timeout", "output-limit"] as const)
export type RuntimeStop = (typeof RUNTIME_STOPS)[number]

// Where a failing run failed: at an assertion of the test, or before or outside one (an import, a compile or a setup
// error). The executor sets it from its own runs' exit codes, never from what the run printed, which the code under
// review controls; how it tells them apart (for example a control run of the reproducer without its assertions) is
// executor work. A failing run without it is unlocated, and an unlocated failure never confirms.
export const RUNTIME_FAILURES = Object.freeze(["assertion", "error"] as const)
export type RuntimeFailure = (typeof RUNTIME_FAILURES)[number]

// Contract §4 VS-30 items 2 and 4: 120 s and 80 KB of output per command, at most 3 reproducer files, and each
// reproducer run twice on head and twice on base. Only `runs` is read here (runtimeVerdict); the executor enforces the
// others.
export const RUNTIME_LIMITS = Object.freeze({ commandMs: 120_000, outputBytes: 80 * 1024, reproducers: 3, runs: 2 })

// An exit status of 128 or more is a signal (128 + n, as a shell reports one) or not an ordinary status at all, such as
// a Windows NTSTATUS. Neither is a test's pass or fail: a kill for memory or time can differ between head and base, so
// such a run never confirms or contradicts anything.
export const SIGNAL_EXIT = 128

// parseLcov's bounds. `chars` is checked on the text it is given, so the executor still reads the report with a byte
// cap first; over `files` kept files or `lines` kept line entries the whole report is refused, never cut.
export const LCOV_LIMITS = Object.freeze({
  chars: 32 * 1024 * 1024,
  files: 20_000,
  lines: 1_000_000,
  lineChars: 4_096,
  lineNumber: 10_000_000,
})

// ChangedCoverage.uncovered holds at most this many lines; `changed` and `covered` stay exact.
export const MAX_UNCOVERED_LINES = 200

// Why checks did not run (I-6, contract §4 VS-30 "Done", addendum A §3 VS-30), so the executor and the notes never
// invent a reason. Their note text waits for wiring (D14).
export const CHECKS_NOT_RUN = Object.freeze([
  // Refused (I-6): no consent for this operation (declined, expired, already used, or bound to another head SHA or
  // command digest), someone else's pull request (`--pr`), a fork, an untrusted review, or a CI job.
  "no-consent",
  "pr",
  "fork",
  "untrusted",
  "ci",
  // A surface with no executor yet: the desktop before VS-10 and VS-12, the GitHub job before its unprivileged job.
  "surface-unsupported",
  // Uncommitted working-tree changes, which the executor cannot check out at a SHA yet.
  "uncommitted",
  // An environment that cannot keep I-6: the shell sandbox's offline() is unfiltered (Windows) or leaves loopback
  // reachable (seatbelt on macOS), or no isolated worktree can be made.
  "network-unfiltered",
  "isolation-unavailable",
  // The base commit is not in the checkout, or there is no merge base (a shallow clone).
  "base-unavailable",
  // Project blockers, Greptile's taxonomy [GP17] plus one: no allowed command fits the project, or its dependencies,
  // services, configuration or fixtures are not available offline.
  "no-command",
  "dependencies-unavailable",
  "services-unavailable",
  "config-unavailable",
  "fixtures-unavailable",
  // The reproducer pass: it returned none, its model call was refused by the route rules (privacy.ts, I-3), or a file
  // it returned was refused (outside the test paths, path traversal or a symlink).
  "no-reproducer",
  "route-refused",
  "reproducer-refused",
  // Stopped: a command over its time or output limit, the review's runtime budget spent, or the head moved mid-run.
  "timeout",
  "output-limit",
  "budget",
  "head-moved",
] as const)
export type ChecksNotRun = (typeof CHECKS_NOT_RUN)[number]

// Coverage of one changed file's added lines. `unmeasured` means the report has no record of the file, so nothing is
// known about it: it never reads as 0% or 100%.
export interface ChangedCoverage {
  path: string // the head path, as the diff names it
  changed: number // the added lines the report lists as executable
  covered: number // of those, the lines a test ran
  uncovered: number[] // the others, ascending, at most MAX_UNCOVERED_LINES
  unmeasured?: true
}

/**
 * One distinct outcome of one command on one side: `runs` runs that all ended the same way, with `ms` their total. The
 * executor writes one record per command, side and outcome (exit, failure and stop); runtimeVerdict refuses the same
 * outcome twice, so a run cannot be counted in two forms.
 * - `commit` is the SHA the run checked out; a record of another commit never decides.
 * - `coverage` belongs on head records only: it maps head lines (changedLineCoverage).
 * - `reproducerFor` is a Finding.id, set by the executor on the runs of a reproducer it wrote for that finding. Only
 *   those runs decide that finding's verdict; the project's suites and coverage runs never do.
 * - `output` is the end of what the run printed: untrusted, and redacted before it reaches any prompt.
 */
export interface RuntimeEvidence {
  command: string
  side: "head" | "base"
  commit: string
  exit: number
  ms: number
  runs: number
  failure?: RuntimeFailure // only on a failing record
  stopped?: RuntimeStop
  coverage?: ChangedCoverage[]
  reproducerFor?: string
  output?: string
}

/**
 * Whether a reproducer's failing assertion states the finding's trigger and impact, rather than the behaviour the
 * change means to introduce (a head-fails, base-passes test also "confirms" an intended change; contract §4 VS-30 item
 * 4). It is a necessary condition, never a sufficient one: only "tied" lets a verdict through, and the exit codes
 * still decide it. "tied" comes only from a trusted check that is independent of the reproducer's author,
 * deterministic or a separate pass that did not write the reproducer; it is never read from the reproducer, its output
 * or pull request text. Without such a check the tie is "unchecked", which never confirms or contradicts. Which check
 * that is stays executor work.
 */
export interface RuntimeTie {
  finding: string // the Finding.id the verdict is for
  assertion: "tied" | "untied" | "unchecked"
}

// A verdict, with the finding it was computed for, so it cannot be applied to another.
export interface RuntimeResult {
  finding: string
  verdict: RuntimeVerdict
}

export interface LcovFile {
  path: string // repository-relative
  lines: ReadonlyMap<number, number> // line number to hits
}

export interface LcovReport {
  files: LcovFile[]
  malformed: number // lines skipped as malformed
  tooLarge?: true // over LCOV_LIMITS: no file is reported
}

/**
 * The verdict on one finding from its reproducer's runs. "confirmed" when every head run failed at an assertion and
 * every base run passed; "contradicted" when every head run passed; otherwise, and whenever the evidence cannot decide,
 * "inconclusive". It cannot decide when:
 * - a side has no run of this finding's reproducer, or a run of another side or another commit than `commits` names
 *   (an empty commit names none);
 * - a run is stopped, ended with a signal (SIGNAL_EXIT), has a count or status that is not a whole number, or has a
 *   failure location though it passed;
 * - a command ran on one side only, or fewer than RUNTIME_LIMITS.runs times on a side, or an outcome is recorded twice;
 * - the tie is not "tied".
 * So mixed or flaky results, a head that fails beside a failing base, and an unlocated or non-assertion failure never
 * confirm. Coverage runs never count, whatever their records say.
 */
export function runtimeVerdict(
  head: readonly RuntimeEvidence[],
  base: readonly RuntimeEvidence[],
  tie: RuntimeTie,
  commits: { head: string; base: string },
): RuntimeResult {
  const result = (verdict: RuntimeVerdict): RuntimeResult => ({ finding: tie.finding, verdict })
  const ownHead = head.filter((record) => decides(record, tie.finding))
  const ownBase = base.filter((record) => decides(record, tie.finding))
  if (!complete(ownHead, "head", commits.head) || !complete(ownBase, "base", commits.base))
    return result("inconclusive")
  if (!sameCommands(ownHead, ownBase) || tie.assertion !== "tied") return result("inconclusive")
  if (ownHead.every((record) => record.exit === 0)) return result("contradicted")
  if (
    ownHead.every((record) => record.exit !== 0 && record.failure === "assertion") &&
    ownBase.every((record) => record.exit === 0)
  )
    return result("confirmed")
  return result("inconclusive")
}

// Only a confirmation for this very finding changes it: it is then verified, at runtime. Every other verdict returns the
// finding itself, so "contradicted" never drops, downgrades or un-verifies a finding (contract §1.2).
export function applyRuntimeVerdict<T extends Finding>(finding: T, result: RuntimeResult): T {
  if (result.verdict !== "confirmed" || result.finding !== finding.id) return finding
  return { ...finding, verified: true, verifiedBy: "runtime" }
}

/**
 * An lcov report's line coverage, by repository path. Only `SF:` and `DA:` lines are read; the other record types are
 * skipped, and any other line, a `DA:` line outside a record or out of bounds, an empty `SF:`, a line over
 * LCOV_LIMITS.lineChars and an `SF:` that opens before the previous record's `end_of_record` (which closes it, even
 * when that `SF:` is over the cap and so opens nothing) count as malformed. A record still open at the end is kept. A
 * file listed twice keeps each line's highest count.
 * - `cwd` is the directory the coverage command ran in, relative to the repository root (Bun writes paths relative to
 *   it: `SF:lib.ts`, `SF:../core/src/x.ts`), or absolute under `root`.
 * - `root` is the repository's absolute path, for reports that write absolute paths; without it they are skipped.
 * - `paths`, when given, keeps only those repository paths, so memory is bounded by what the caller needs.
 * A path outside the repository after normalising, with `/` or `\`, is skipped silently.
 */
export function parseLcov(
  text: string,
  input: { cwd?: string; root?: string; paths?: ReadonlySet<string> } = {},
): LcovReport {
  if (text.length > LCOV_LIMITS.chars) return tooLarge()
  const root = input.root === undefined ? undefined : input.root.replaceAll("\\", "/").replace(/\/+$/, "")
  const cwd = repoParts(input.cwd ?? "", [], root)
  const files = new Map<string, Map<number, number>>()
  // The scan is imperative on purpose: it walks the text by index, so a report of up to LCOV_LIMITS.chars is never
  // split into an array of lines and memory stays bounded by what is kept.
  let malformed = 0
  let entries = 0
  // Whether a record is open, and the lines of its file when that file is kept.
  let open = false
  let lines: Map<number, number> | undefined
  for (let start = 0; start < text.length; ) {
    const newline = text.indexOf("\n", start)
    const end = newline === -1 ? text.length : newline
    // A line over the cap is never copied out of the text. An over-cap `SF:` still closes the open record, as every
    // `SF:` does, so the `DA:` lines after it fall outside any record and never land in the previous file.
    if (end - start > LCOV_LIMITS.lineChars) {
      malformed++
      if (text.startsWith("SF:", start)) {
        if (open) malformed++
        open = false
        lines = undefined
      }
      start = end + 1
      continue
    }
    const line = text.slice(start, end).replace(/\r$/, "")
    start = end + 1
    if (line === "") continue
    if (line === "end_of_record") {
      open = false
      lines = undefined
      continue
    }
    if (line.startsWith("SF:")) {
      // An `SF:` before the previous record's end_of_record closes that record.
      if (open) malformed++
      open = line.length > 3
      if (!open) {
        malformed++
        lines = undefined
        continue
      }
      const path = repoPath(line.slice(3), cwd, root)
      lines = path !== undefined && (!input.paths || input.paths.has(path)) ? recordOf(files, path) : undefined
      if (files.size > LCOV_LIMITS.files) return tooLarge()
      continue
    }
    if (line.startsWith("DA:")) {
      const match = DA.exec(line)
      const number = match ? Number(match[1]) : 0
      if (!match || !open || number < 1 || number > LCOV_LIMITS.lineNumber) {
        malformed++
        continue
      }
      if (!lines) continue
      if (!lines.has(number)) entries++
      if (entries > LCOV_LIMITS.lines) return tooLarge()
      lines.set(number, Math.max(lines.get(number) ?? 0, Number(match[2])))
      continue
    }
    if (!LCOV_SKIPPED.has(line.slice(0, line.indexOf(":") + 1))) malformed++
  }
  return { files: [...files].map(([path, lines]) => ({ path, lines })), malformed }
}

/**
 * Coverage of each changed code file's added lines, in diff order: files that are not deleted or binary, are code
 * (isCodePath), lie outside TEST_PATHS and add at least one line, each by its head path. undefined when the report is
 * too large to read. `input` is parseLcov's `cwd` and `root`. A file the report has no record of is `unmeasured`.
 */
export function changedLineCoverage(
  lcov: string,
  files: readonly DiffFile[],
  input: { cwd?: string; root?: string } = {},
): ChangedCoverage[] | undefined {
  const mapped = files.filter(
    (file) => file.status !== "deleted" && !file.binary && isCodePath(file.path) && !isTestPath(file.path),
  )
  const added = mapped.map((file) => ({ path: file.path, lines: addedLines(file) })).filter((file) => file.lines.length)
  const report = parseLcov(lcov, { cwd: input.cwd, root: input.root, paths: new Set(added.map((file) => file.path)) })
  if (report.tooLarge) return undefined
  const measured = new Map(report.files.map((file) => [file.path, file.lines]))
  return added.map((file) => coverageOf(file.path, file.lines, measured.get(file.path)))
}

// The whole report refused, so no partial coverage reads as complete.
function tooLarge(): LcovReport {
  return { files: [], malformed: 0, tooLarge: true }
}

const DA = /^DA:(\d{1,10}),(\d{1,20})(?:,.*)?$/
// lcov's other record types, read as nothing.
const LCOV_SKIPPED = new Set(
  ["TN", "FN", "FNDA", "FNF", "FNH", "FNL", "FNA", "BRDA", "BRF", "BRH", "LF", "LH", "VER"].map((key) => `${key}:`),
)
// A run that may decide this finding: one of its own reproducer, never a coverage run, bare or with arguments.
function decides(record: RuntimeEvidence, finding: string) {
  return finding !== "" && record.reproducerFor === finding && !isCoverageCommand(record.command)
}

// Whether one side's runs can decide: at least one, all of that side and commit, none stopped or ended by a signal,
// whole counts and statuses, a failure location only on a failing run, no outcome recorded twice, and every command
// run at least RUNTIME_LIMITS.runs times.
function complete(records: readonly RuntimeEvidence[], side: RuntimeEvidence["side"], commit: string) {
  if (!records.length || !commit) return false
  const valid = records.every(
    (record) =>
      record.side === side &&
      record.commit === commit &&
      record.stopped === undefined &&
      Number.isInteger(record.runs) &&
      record.runs > 0 &&
      Number.isInteger(record.exit) &&
      record.exit >= 0 &&
      record.exit < SIGNAL_EXIT &&
      (record.failure === undefined || record.exit !== 0),
  )
  const outcomes = new Set(records.map((record) => JSON.stringify([record.command, record.exit, record.failure ?? ""])))
  return (
    valid &&
    outcomes.size === records.length &&
    [...runsOf(records).values()].every((runs) => runs >= RUNTIME_LIMITS.runs)
  )
}

function sameCommands(head: readonly RuntimeEvidence[], base: readonly RuntimeEvidence[]) {
  const headRuns = runsOf(head)
  const baseRuns = runsOf(base)
  return headRuns.size === baseRuns.size && [...headRuns.keys()].every((command) => baseRuns.has(command))
}

// Runs per command.
function runsOf(records: readonly RuntimeEvidence[]) {
  return records.reduce(
    (runs, record) => runs.set(record.command, (runs.get(record.command) ?? 0) + record.runs),
    new Map<string, number>(),
  )
}

// A report path as a repository path, or undefined when it lies outside the repository.
function repoPath(raw: string, cwd: string[] | undefined, root: string | undefined) {
  const parts = repoParts(raw, cwd, root)
  return parts?.length ? parts.join("/") : undefined
}

// A path's segments from the repository root: an absolute path under `root`, or a relative one joined onto `from`.
// undefined when it leaves the repository, is absolute without a `root`, or is relative without a `from`.
function repoParts(raw: string, from: string[] | undefined, root: string | undefined): string[] | undefined {
  const path = raw.replaceAll("\\", "/")
  if (!ABSOLUTE.test(path)) return from && normalised(path, from)
  if (root === undefined || (path !== root && !path.startsWith(`${root}/`))) return undefined
  return normalised(path.slice(root.length + 1), [])
}

const ABSOLUTE = /^(?:\/|[A-Za-z]:)/

// `.` and empty segments dropped and `..` applied, starting at `from`; undefined when `..` would leave the root. The
// accumulator is changed in place, so a hostile path of thousands of segments stays linear.
function normalised(path: string, from: string[]): string[] | undefined {
  return path.split("/").reduce<string[] | undefined>(
    (parts, part) => {
      if (!parts || part === "" || part === ".") return parts
      if (part === "..") return parts.pop() === undefined ? undefined : parts
      parts.push(part)
      return parts
    },
    [...from],
  )
}

function recordOf(files: Map<string, Map<number, number>>, path: string) {
  const known = files.get(path)
  if (known) return known
  const lines = new Map<number, number>()
  files.set(path, lines)
  return lines
}

function isTestPath(path: string) {
  return TEST_PATHS.some((glob) => minimatch(path, glob, { dot: true, nocase: true }))
}

function addedLines(file: DiffFile) {
  return [
    ...new Set(
      file.hunks.flatMap((hunk) =>
        hunk.lines.flatMap((line) => (line.kind === "add" && line.newLine !== undefined ? [line.newLine] : [])),
      ),
    ),
  ].sort((a, b) => a - b)
}

function coverageOf(path: string, added: number[], lines: ReadonlyMap<number, number> | undefined): ChangedCoverage {
  if (!lines) return { path, changed: 0, covered: 0, uncovered: [], unmeasured: true }
  const changed = added.filter((line) => lines.has(line))
  const uncovered = changed.filter((line) => lines.get(line) === 0)
  return {
    path,
    changed: changed.length,
    covered: changed.length - uncovered.length,
    uncovered: uncovered.slice(0, MAX_UNCOVERED_LINES),
  }
}
