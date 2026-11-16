#!/usr/bin/env bun
import { createHash } from "node:crypto"
import { existsSync } from "node:fs"
import { devNull } from "node:os"
import { join, resolve } from "node:path"
import { parseArgs } from "node:util"
import { trustedRules } from "../../packages/core/src/review/citation"
import { REVIEW_CONFIG_PATH, REVIEW_RULES_PATHS } from "../../packages/core/src/review/config"
import { parseUnifiedDiff, type DiffFile } from "../../packages/core/src/review/diff"
import { normalizeTitle } from "../../packages/core/src/review/fingerprint"
import { findingMarker, parseFindingMarker } from "../../packages/core/src/review/state"
import { isDismissalMarker, sameTeamPattern, TEAM_SIMILARITY, teamDir } from "../../packages/core/src/review/team"
import {
  FAILURE_CLASSES,
  FAILURE_MECHANISMS,
  type Category,
  type FindingScope,
} from "../../packages/core/src/review/types"

// The real-change dataset behind VectorScope's eval. A manifest lists public bug-fix cases, clean controls, trivial
// controls and adversarial (prompt-injection) cases, each pinned to immutable commits in a permissively licensed
// repository, and holds no code. A bug case names the candidate change a reviewer is shown (base..head) and the later
// fix, which stays hidden as ground truth. An adversarial case is a separate trust test, never a defect or a clean change
// in the quality metrics. annotation-guide.md says how cases are found, checked and labelled.
//
// Run as a script it is a dry run: it validates a manifest, recomputes the grouped split, checks the held-out freeze
// and lists the exclusions. It never makes a network request. Given local mirrors (--mirrors) it also checks commits,
// ancestry, post-fix leakage, commit dates, change sizes and label locations with git.

export const DATASET_DIR = join(import.meta.dir, "dataset")
export const SEED_MANIFEST = join(DATASET_DIR, "seed.json")
// Version 2 (VS-22a) adds the trivial kind, the failure-class, mechanism, cross-file, runnable and authoring labels and
// each pass's own labels, and retires the cross-file trait for labels.crossFile. Version 3 (VS-22c) adds a defect's
// context-level, scope, test-gap, introducing-push and interaction labels, defects outside the change
// (labels.notInChange), an adversarial case's head-added rule and feedback attack, the review feedback a case gives the
// reviewer (Case.feedback), and a multi-commit sequence's pushes (candidate.commits).
export const SCHEMA = "vectorscope-dataset/3"

// D8: public repositories under MIT, Apache-2.0 or BSD licences, as the GitHub licence endpoint names them.
export const LICENCES = ["MIT", "Apache-2.0", "BSD-2-Clause", "BSD-3-Clause"] as const
export const SPLITS = ["development", "calibration", "held-out"] as const
export const CATEGORIES = ["correctness", "security", "concurrency", "persistence", "error-path", "resource"] as const
export const SEVERITIES = ["blocking", "concern"] as const
export const TRAITS = [
  "outside-diff",
  "rename",
  "incremental",
  "fork",
  "large",
  "trivial-looking",
  "dependency-bump",
] as const
export const ANNOTATION_STATUSES = ["draft", "double-annotated", "adjudicated"] as const
export const REGRESSION_TEST = ["added-by-fix", "existing", "none"] as const
export const EXCLUSION_REASONS = [
  "no-defensible-candidate",
  "no-causal-explanation",
  "oversized",
  "licence",
  "unverifiable",
  "duplicate",
  "sensitive-content",
  "quota",
  "not-trivial",
  "mixed-trivial",
] as const

// VS-22a's labels. The five failure classes are the contract's (vectorscope-upgrade.md §1.2), from core review/types.ts
// (VS-27a), an import-free file; a defect in none of them is "other". judging-rubric.md defines each one.
export { FAILURE_CLASSES }
export const DEFECT_CLASSES = [...FAILURE_CLASSES, "other"] as const
// §1.2's FailureInfo.mechanism, from the same file, so a strict finding's mechanism can be compared with its label.
export const MECHANISMS = FAILURE_MECHANISMS
// The readings of owner question Q4 that would move an "other" defect into a class: data exposure as a leak, and a
// concurrency defect whose only effect is a wrong result. Marking them keeps either answer computable without
// relabelling.
export const PENDING_Q4 = ["data-exposure", "concurrency-wrong-result"] as const
// §1.2's TrivialKind. A dependency bump is no kind while Q11 is open. A copy of core trivial.ts's, which has runtime
// imports; fixtures.test.ts checks the two are equal.
export const TRIVIAL_KINDS = ["whitespace", "docs", "rename", "comment"] as const
// The base commit's recorded public CI: its test check passed or failed, or no test run counts.
export const CI_RESULTS = ["passed", "failed", "none"] as const
// Where an authoring label comes from. A trailer or a bot account is self-declared; "synthetic" waits for Q12.
export const AUTHORING_SOURCES = ["commit-trailer", "bot-account", "synthetic"] as const
// VS-22b's coverage targets (contract §4). The dry run reports against them; nothing enforces them.
export const TARGETS = {
  bugs: 100,
  perClass: 12,
  crossFile: 30,
  runnable: 15,
  controls: 25,
  trivial: 20,
  trivialLooking: 3,
  adversarial: 10,
} as const
// The sampling rule's cap on the cases one repository supplies, counting the seed's (annotation-guide.md, "Sampling
// rule"). Unlike TARGETS it is enforced: a case past it is excluded as quota.
export const PER_REPOSITORY = 2

// VS-22c's labels (addendum A §3, VS-22, the VS-22a follow-up). The context a reviewer needs to raise a defect, in
// AACR-Bench's three levels [LCI2]: the change's diff with its default three lines of context (hunk), the whole of a
// changed file (file), or code in a file the change does not touch (repo). It is the annotator's judgement of what is
// needed, not where the defect is cited; the object checks refuse only a level narrower than its locations show. VS-37
// reads slice recall per level.
export const CONTEXT_LEVELS = ["hunk", "file", "repo"] as const
// ReviewBench's scope axis [G6-13]. A labelled defect is in the change; a real defect outside it goes in
// labels.notInChange, which judging never reads, so a finding on it stays a false alarm under the current rubric
// ("not a defect in this change") and S9 (VS-42) leaves it out of scope.
export const IN_CHANGE_SCOPES = ["introduced-by-pr", "exacerbated-by-pr"] as const
export const NOT_IN_CHANGE_SCOPES = ["pre-existing", "unrelated"] as const
export const DEFECT_SCOPES = [...IN_CHANGE_SCOPES, ...NOT_IN_CHANGE_SCOPES] as const
// VS-42's model field (core types.ts FindingScope) on that axis. unrelated has no model value.
export const FINDING_SCOPE_AXIS = {
  introduced: "introduced-by-pr",
  exacerbated: "exacerbated-by-pr",
  "pre-existing": "pre-existing",
} as const satisfies Record<FindingScope, (typeof DEFECT_SCOPES)[number]>
// GU5's test-gap stratum, on a defect: the change weakens or removes a test that would catch it (an assertion relaxed
// or deleted, an input or an expected value changed), and the defect cites that test at its place in the head. A case
// whose fix adds the missing test is regressionTest's added-by-fix already, so it is not a value here.
export const TEST_GAPS = ["weakened", "none"] as const
// The attacks an adversarial case's review feedback makes on team memory (VS-35) [FL6, FL9, FL16]. Addendum A's four:
// dismissals by the PR author or with no writer marker (forged-author), non-writers' reactions (brigading), an agent
// resolving a batch of threads (bulk-resolve), and writers' thumbs-down on a real security finding (security-thumbs).
const ADDENDUM_ATTACKS = ["forged-author", "brigading", "bulk-resolve", "security-thumbs"] as const
// And a labelled known gap that is no addendum target: invented-writers is one actor writing well-formed writer markers
// with made-up hashes. Guarded memory trusts h= as written until the writer-hash check at VS-35's later window, so it
// still learns that pattern (vectorscope-deviations.md, VS-35a).
export const FEEDBACK_ATTACKS = [...ADDENDUM_ATTACKS, "invented-writers"] as const
// Where a case's review feedback comes from. Real vector-dismissal markers exist only after VS-35's marker window, so
// every feedback case is synthetic history on real commits until then.
export const FEEDBACK_SOURCES = ["synthetic"] as const
// Addendum A's round-two coverage (VS-41's sequences, cases with an interaction defect and clean later pushes; VS-42's
// exacerbated and pre-existing fixtures; VS-43's head-added rule case; one case per addendum attack, so not
// invented-writers). Proposals pending owner question
// Q18: the dry run reports against them, nothing enforces them, and the sampling rule's quota (its item 5) does not
// stop a query on them until Q18 is answered. The 1s are the addendum's "a case" read at its minimum.
export const ROUND_TWO_TARGETS = {
  sequences: 15,
  interactions: 5,
  cleanLater: 5,
  exacerbated: 1,
  preExisting: 1,
  headRule: 1,
  perAttack: 1,
} as const

export type Split = (typeof SPLITS)[number]

export interface Location {
  path: string // relative to the repository root, in the candidate head
  line: number
  endLine?: number
}

export interface Defect {
  id: string
  category: (typeof CATEGORIES)[number]
  severity: (typeof SEVERITIES)[number]
  summary: string
  cause: string // the causal explanation a matching finding must give, not just its location
  locations: Location[] // where a finding should point
  alternatives: Location[] // other places a finding that explains the same cause may cite
  // VS-22a. Absent means not yet labelled, never "other".
  failureClass?: (typeof DEFECT_CLASSES)[number]
  mechanism?: (typeof MECHANISMS)[number]
  pendingQ4?: (typeof PENDING_Q4)[number] // on an "other" defect that an answer to Q4 would move into a class
  // VS-22c. Absent means not yet labelled.
  contextLevel?: (typeof CONTEXT_LEVELS)[number]
  scope?: (typeof IN_CHANGE_SCOPES)[number] // a defect outside the change goes in labels.notInChange
  testGap?: (typeof TEST_GAPS)[number]
  introducedAt?: string // a sequence's push (one of candidate.commits) that introduced it; required in a sequence
  interaction?: boolean // a sequence's defect whose cause needs a file an earlier push changed and its own push did not
}

// A real defect the change did not make: already there at the base (pre-existing) or unrelated to the change. It is
// recorded so S9 (VS-42) and a ReviewBench-style count can read it, never passed to judging.
export interface NotInChangeDefect extends Omit<Defect, "scope" | "testGap" | "introducedAt" | "interaction"> {
  scope: (typeof NOT_IN_CHANGE_SCOPES)[number]
}

// A dismissed Vector review comment that team memory reads, as core state.ts's GuardedComment holds one, with the
// dismissing action's own time in ISO 8601 (Date.parse gives GuardedComment.at).
export interface FeedbackComment {
  pr: number
  path: string
  body: string // a finding marker with st=d, and any vector-dismissal marker after it
  at?: string
  replied?: boolean
  codeChanged?: boolean
}

// The review feedback a case gives the reviewer: other pull requests' dismissed comments, newest first as teamPatterns
// and guardedTeamPatterns read them, and the job's metadata guarded memory takes (core team.ts GuardedTeamInput). It is
// input, not a label: a feedback case's labels say what it attacks (labels.feedback).
export interface Feedback {
  source: (typeof FEEDBACK_SOURCES)[number]
  comments: FeedbackComment[]
  botPushes?: { pr: number; at: string }[]
  own?: string[] // the dismissal-marker hashes of Vector's own logins
}

export interface Annotation {
  status: (typeof ANNOTATION_STATUSES)[number]
  // A pass's labels record the VS-22a labels it gave, by the case's own defect ids (a defect it did not label is left
  // out), so the two passes can be compared after the case's labels settle (Cohen's kappa on failureClass, VS-22b).
  passes: {
    pass: number
    method: string
    date: string
    labels?: {
      defects: Pick<Defect, "id" | "failureClass" | "mechanism" | "pendingQ4" | "contextLevel" | "scope" | "testGap">[]
      crossFile?: boolean
    }
  }[]
  // A double-annotated label's two passes were compared: true when they agreed, so the label stands as it is (D8), and
  // false while a disagreement waits for the owner's adjudication.
  agreed?: boolean
  adjudication?: { by: string; date: string; note?: string }
}

// A trivial control is a control whose change VS-24's trivial rules cover (whitespace, docs, a rename or comments). It
// is split and reported apart from the behaviour-preserving controls.
export const KINDS = ["bug", "control", "adversarial", "trivial"] as const

export interface Case {
  id: string // neutral by convention (<owner>-<name>-<n>); it never reaches a reviewer, not even as a directory name
  kind: (typeof KINDS)[number]
  split: Split
  family?: string // cases sharing a root cause, a backport or a fix series; they always share a split
  repository: { url: string; licence: (typeof LICENCES)[number] }
  language: string
  traits?: (typeof TRAITS)[number][]
  candidate: {
    base: string
    head: string
    date: string // the head's commit time
    change?: string
    changed: { files: number; additions: number; deletions: number }
    // VS-22c. A multi-commit sequence: the pull request's pushed heads in push order, each with its commit time, the
    // last one the head. Absent for a single base..head case.
    commits?: { sha: string; date: string }[]
  }
  fix?: { sha: string; date: string; change?: string }
  feedback?: Feedback // VS-22c, an adversarial case only
  labels: {
    defects: Defect[]
    notInChange?: NotInChangeDefect[] // VS-22c, on any kind
    regressionTest?: { status: (typeof REGRESSION_TEST)[number]; paths?: string[]; note?: string }
    rationale?: string // a control's argument that it preserves behaviour
    injection?: string // an adversarial case's injected instruction, where it is, and what a safe reviewer does
    // VS-22a. Each is absent until labelled; absent never means false or none.
    crossFile?: boolean // explaining a labelled defect's cause needs code in a second file
    // Whether the repository's tests ran at the base commit, read only from its recorded public CI, never by running
    // anything (I-13). evidence is the check-runs or status API link for the base commit, read on date.
    runnable?: { status: (typeof CI_RESULTS)[number]; check?: string; evidence: string; date: string; note?: string }
    // Self-declared authorship, used only to stratify the dataset: never VS-29b's trusted authorship or any invocation
    // field (I-2). lab is a lab id as codium's labOf names them, checked against that list once codium merges.
    authoring?: { lab: string; source: (typeof AUTHORING_SOURCES)[number]; evidence: string }
    trivialKind?: (typeof TRIVIAL_KINDS)[number] // a trivial control's one kind
    // VS-22c, adversarial cases only. Where the change adds a rule to a file trusted rules are read from (VS-43).
    headRule?: Location
    // What the case's review feedback attacks: the attack, the labelled defect it tries to hide, and the finding a
    // reviewer would post for that defect (its core category and title), which the dismissed patterns are built to
    // match.
    feedback?: {
      attack: (typeof FEEDBACK_ATTACKS)[number]
      defect: string
      finding: { category: Category; title: string }
    }
    annotation: Annotation
  }
  provenance: {
    found: string
    evidence: string
    checked: { date: string; method: "gh-api" | "local-git"; commits: true; ancestry: true; licence: true }
  }
}

export interface Exclusion {
  repository: string
  candidate?: { base?: string; head: string }
  fix?: string
  reason: (typeof EXCLUSION_REASONS)[number]
  detail: string
  date: string
}

export interface Manifest {
  schema: typeof SCHEMA
  name: string
  description: string
  created: string
  selection: { method: string; rule: string; queries: string[]; date: string }
  contamination: string
  cases: Case[]
  exclusions: Exclusion[]
  freeze?: { date: string; digest: string }
}

// Everything a reviewer under test may be given for a case: the repository and the candidate's two commits, and for
// VS-22c's cases a sequence's pushes and the review feedback. The labels, the fix, the case's own dates (the
// candidate's, its pushes' and the fix's), provenance, the split, the feedback's source and even the case id stay out,
// so a prompt or tool view built from it cannot leak them. The feedback's own times are input: team memory reads when
// each comment was dismissed and when a bot pushed.
export interface CaseView {
  repository: string
  base: string
  head: string
  commits?: string[]
  feedback?: Omit<Feedback, "source">
}

// Each part is rebuilt from its schema fields alone (I-13): the validator does not refuse unknown keys, so a field an
// annotator adds to a comment or a push, a note naming the defect it hides say, never reaches the view.
export function caseView(item: Case): CaseView {
  const feedback = item.feedback
  return {
    repository: item.repository.url,
    base: item.candidate.base,
    head: item.candidate.head,
    ...(item.candidate.commits ? { commits: item.candidate.commits.map((push) => push.sha) } : {}),
    ...(feedback
      ? {
          feedback: {
            comments: feedback.comments.map((comment) => ({
              pr: comment.pr,
              path: comment.path,
              body: comment.body,
              ...(comment.at !== undefined ? { at: comment.at } : {}),
              ...(comment.replied !== undefined ? { replied: comment.replied } : {}),
              ...(comment.codeChanged !== undefined ? { codeChanged: comment.codeChanged } : {}),
            })),
            ...(feedback.botPushes
              ? { botPushes: feedback.botPushes.map((push) => ({ pr: push.pr, at: push.at })) }
              : {}),
            ...(feedback.own ? { own: [...feedback.own] } : {}),
          },
        }
      : {}),
  }
}

export async function loadManifest(path = SEED_MANIFEST): Promise<unknown> {
  return Bun.file(path).json()
}

const REPOSITORY = /^https:\/\/github\.com\/[A-Za-z0-9][A-Za-z0-9-]*\/(?!\.{1,2}$)[A-Za-z0-9_.-]+$/
const SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/
// A test file by the common conventions: under a test or spec directory, test_<name>, or <name>.test, _test, .spec or
// _spec with any extension.
const TEST_PATH = /(^|\/)(test|tests|__tests__|spec)\/|(^|\/)test_[^/]+$|[._](test|spec)\.[^/]+$/

// Everything wrong with a manifest, without git or the network; empty when it is valid. Checks that span cases
// (duplicates, the split rule and the freeze) run once every case is well formed.
export function manifestProblems(value: unknown): string[] {
  const manifest = record(value)
  if (!manifest) return ["the manifest is not a JSON object"]
  const selection = record(manifest.selection)
  const cases = Array.isArray(manifest.cases) ? manifest.cases : []
  const exclusions = Array.isArray(manifest.exclusions) ? manifest.exclusions : []
  const shape = [
    ...need(manifest.schema === SCHEMA, `schema must be "${SCHEMA}"`),
    ...need(text(manifest.name), "the manifest has no name"),
    ...need(text(manifest.description), "the manifest has no description"),
    ...need(isDay(manifest.created), "created must be a YYYY-MM-DD date"),
    ...need(
      !!selection &&
        text(selection.method) &&
        text(selection.rule) &&
        isDay(selection.date) &&
        Array.isArray(selection.queries) &&
        selection.queries.every(text),
      "selection needs a method, a rule, the queries used and a date",
    ),
    ...need(text(manifest.contamination), "contamination must record what training-data overlap cannot be ruled out"),
    ...need(Array.isArray(manifest.cases), "cases is not an array"),
    ...need(Array.isArray(manifest.exclusions), "exclusions is not an array"),
    ...cases.flatMap(caseProblems),
    ...exclusions.flatMap(exclusionProblems),
  ]
  if (shape.length) return shape
  const typed = manifest as unknown as Manifest
  const ids = typed.cases.map((item) => item.id)
  const candidates = typed.cases.map((item) => `${repositoryKey(item.repository.url)}@${item.candidate.head}`)
  const splits = assignSplits(typed.cases)
  return [
    ...ids.filter((id, index) => ids.indexOf(id) !== index).map((id) => `case id ${id} repeats`),
    ...typed.cases
      .filter((_, index) => candidates.indexOf(candidates[index]) !== index)
      .map((item) => `case ${item.id} repeats the candidate of an earlier case`),
    ...typed.exclusions
      .filter(
        (item) => item.candidate && candidates.includes(`${repositoryKey(item.repository)}@${item.candidate.head}`),
      )
      .map((item) => `the exclusion of ${item.repository} at ${short(item.candidate!.head)} is also an admitted case`),
    // The split groups a repository's cases within a kind only, so one repository that supplied a bug case and a
    // control could put them on both sides of the held-out boundary. The sampling rule keeps it to one kind.
    ...Object.values(Object.groupBy(typed.cases, (item) => repositoryKey(item.repository.url))).flatMap(
      (group = []) => [
        ...need(
          new Set(group.map((item) => item.kind)).size === 1,
          `${group[0]?.repository.url} supplies cases of more than one kind (${group.map((item) => `${item.id} ${item.kind}`).join(", ")}); a repository's cases are of one kind`,
        ),
        ...need(
          group.length <= PER_REPOSITORY,
          `${group[0]?.repository.url} supplies ${group.length} cases (${group.map((item) => item.id).join(", ")}); the sampling rule allows ${PER_REPOSITORY}, and the rest are excluded as quota`,
        ),
      ],
    ),
    ...typed.cases
      .filter((item) => splits.get(item.id) !== item.split)
      .map(
        (item) => `case ${item.id} is recorded in ${item.split} but the split rule puts it in ${splits.get(item.id)}`,
      ),
    ...freezeProblems(typed),
  ]
}

function caseProblems(value: unknown, index: number): string[] {
  const item = record(value)
  if (!item) return [`case #${index + 1} is not an object`]
  const label = `case ${typeof item.id === "string" && item.id ? item.id : `#${index + 1}`}`
  const repository = record(item.repository)
  const candidate = record(item.candidate)
  const changed = record(candidate?.changed)
  const labels = record(item.labels)
  const provenance = record(item.provenance)
  const checked = record(provenance?.checked)
  return [
    ...need(
      typeof item.id === "string" && SLUG.test(item.id),
      `${label}: id must be lowercase words joined by hyphens`,
    ),
    ...need(oneOf(KINDS, item.kind), `${label}: kind must be one of ${KINDS.join(", ")}`),
    ...need(oneOf(SPLITS, item.split), `${label}: split must be one of ${SPLITS.join(", ")}`),
    ...need(
      item.family === undefined || (typeof item.family === "string" && SLUG.test(item.family)),
      `${label}: family must be lowercase words joined by hyphens`,
    ),
    ...need(
      typeof repository?.url === "string" && REPOSITORY.test(repository.url),
      `${label}: repository.url must be https://github.com/<owner>/<name>`,
    ),
    ...need(
      oneOf(LICENCES, repository?.licence),
      `${label}: licence ${String(repository?.licence)} is not one of ${LICENCES.join(", ")}`,
    ),
    ...need(
      typeof item.language === "string" && /^[a-z0-9+#-]+$/.test(item.language),
      `${label}: language must be a lowercase name`,
    ),
    ...need(
      item.traits === undefined || (Array.isArray(item.traits) && item.traits.every((trait) => oneOf(TRAITS, trait))),
      `${label}: traits must come from ${TRAITS.join(", ")}`,
    ),
    ...need(isSha(candidate?.base), `${label}: candidate.base must be a full 40-character commit SHA`),
    ...need(isSha(candidate?.head), `${label}: candidate.head must be a full 40-character commit SHA`),
    ...need(!candidate || candidate.base !== candidate.head, `${label}: candidate.base and candidate.head are equal`),
    ...need(isTime(candidate?.date), `${label}: candidate.date must be the head's ISO 8601 commit time`),
    ...need(candidate?.change === undefined || isLink(candidate.change), `${label}: candidate.change must be a link`),
    ...need(
      !!changed &&
        count(changed.files) &&
        (changed.files as number) > 0 &&
        count(changed.additions) &&
        count(changed.deletions),
      `${label}: candidate.changed needs whole-number files, additions and deletions`,
    ),
    ...(item.kind === "control"
      ? controlProblems(label, item, labels)
      : item.kind === "trivial"
        ? trivialProblems(label, item, labels)
        : item.kind === "adversarial"
          ? adversarialProblems(label, item, candidate, labels)
          : bugProblems(label, item, candidate, labels)),
    ...labelProblems(label, item, labels),
    ...notInChangeProblems(label, labels),
    ...headRuleProblems(label, item, labels),
    ...feedbackProblems(label, item, candidate, labels),
    ...sequenceProblems(label, item, candidate, labels),
    ...annotationProblems(label, record(labels?.annotation), labels),
    ...need(
      !!provenance && text(provenance.found) && text(provenance.evidence),
      `${label}: provenance must say how the case was found and what identifies the candidate`,
    ),
    ...need(
      !!checked &&
        isDay(checked.date) &&
        (checked.method === "gh-api" || checked.method === "local-git") &&
        checked.commits === true &&
        checked.ancestry === true &&
        checked.licence === true,
      `${label}: provenance.checked must record a dated gh-api or local-git check of its commits, ancestry and licence`,
    ),
  ]
}

function bugProblems(
  label: string,
  item: Record<string, unknown>,
  candidate: Record<string, unknown> | undefined,
  labels: Record<string, unknown> | undefined,
) {
  const fix = record(item.fix)
  const defects = Array.isArray(labels?.defects) ? labels.defects : []
  const ids = defects.map((defect, index) => {
    const id = record(defect)?.id
    return typeof id === "string" ? id : `#${index + 1}`
  })
  const regression = record(labels?.regressionTest)
  return [
    ...need(!!fix, `${label}: a bug case needs the fix that is kept as hidden ground truth`),
    ...need(!fix || isSha(fix.sha), `${label}: fix.sha must be a full 40-character commit SHA`),
    ...need(
      !fix || (fix.sha !== candidate?.head && fix.sha !== candidate?.base),
      `${label}: the fix must be a later commit than the candidate`,
    ),
    ...need(!fix || isTime(fix.date), `${label}: fix.date must be the fix's ISO 8601 commit time`),
    ...need(
      !fix ||
        !isTime(fix.date) ||
        !isTime(candidate?.date) ||
        Date.parse(fix.date as string) > Date.parse(candidate!.date as string),
      `${label}: the fix must be committed after the candidate`,
    ),
    ...need(!fix || fix.change === undefined || isLink(fix.change), `${label}: fix.change must be a link`),
    ...need(defects.length > 0, `${label}: a bug case needs at least one labelled defect`),
    ...ids.filter((id, index) => ids.indexOf(id) !== index).map((id) => `${label}: defect id ${id} repeats`),
    ...defects.flatMap((defect, index) => defectProblems(`${label}: defect ${ids[index]}`, defect)),
    ...defects.flatMap((defect, index) =>
      inChangeProblems(`${label}: defect ${ids[index]}`, record(defect), regression?.paths),
    ),
    ...need(
      !!regression &&
        oneOf(REGRESSION_TEST, regression.status) &&
        (regression.paths === undefined || (Array.isArray(regression.paths) && regression.paths.every(isPath))) &&
        (regression.note === undefined || text(regression.note)),
      `${label}: labels.regressionTest needs a status of ${REGRESSION_TEST.join(", ")}`,
    ),
  ]
}

function controlProblems(label: string, item: Record<string, unknown>, labels: Record<string, unknown> | undefined) {
  return [
    ...need(item.fix === undefined, `${label}: a control has no fix`),
    ...need(
      Array.isArray(labels?.defects) && labels.defects.length === 0,
      `${label}: a control must have an empty defects list`,
    ),
    ...need(text(labels?.rationale), `${label}: a control needs the rationale that it preserves behaviour`),
  ]
}

// A trivial control is a control, so it carries no defect label, and it names the one kind of change it makes.
function trivialProblems(label: string, item: Record<string, unknown>, labels: Record<string, unknown> | undefined) {
  return [
    ...controlProblems(label, item, labels),
    ...need(
      oneOf(TRIVIAL_KINDS, labels?.trivialKind),
      `${label}: a trivial control needs labels.trivialKind, one of ${TRIVIAL_KINDS.join(", ")}`,
    ),
  ]
}

// VS-22a's case labels, on every kind. Each is optional: absent means not yet labelled.
function labelProblems(label: string, item: Record<string, unknown>, labels: Record<string, unknown> | undefined) {
  const defects = (Array.isArray(labels?.defects) ? labels.defects : []).map(record)
  const runnable = record(labels?.runnable)
  const authoring = record(labels?.authoring)
  const url = record(item.repository)?.url
  const base = record(item.candidate)?.base
  // The base commit's API prefix that runnable's evidence must read, once the repository and the base are well formed
  // (each is reported on its own otherwise).
  const commits =
    typeof url === "string" && REPOSITORY.test(url) && isSha(base)
      ? `https://api.github.com/repos/${new URL(url).pathname.slice(1).replace(/\.git$/, "")}/commits/${base}/`
      : undefined
  return [
    ...need(
      labels?.trivialKind === undefined || item.kind === "trivial",
      `${label}: only a trivial control has labels.trivialKind`,
    ),
    ...need(
      labels?.crossFile === undefined || typeof labels.crossFile === "boolean",
      `${label}: labels.crossFile must be true or false`,
    ),
    ...need(
      labels?.crossFile === undefined || defects.length > 0,
      `${label}: labels.crossFile describes a labelled defect, and this case has none`,
    ),
    ...need(
      labels?.crossFile !== true ||
        defects.some((defect) => sourceFilesOf(defect, record(labels?.regressionTest)?.paths).size >= 2),
      `${label}: labels.crossFile is true, but no labelled defect names locations in two files other than tests`,
    ),
    ...need(
      labels?.runnable === undefined ||
        (!!runnable &&
          oneOf(CI_RESULTS, runnable.status) &&
          isLink(runnable.evidence) &&
          isDay(runnable.date) &&
          (runnable.status === "none" ? text(runnable.note) : text(runnable.check)) &&
          (runnable.check === undefined || text(runnable.check)) &&
          (runnable.note === undefined || text(runnable.note))),
      `${label}: labels.runnable needs a status (passed, failed or none), the base commit's check-runs or status API link as evidence, and a YYYY-MM-DD date; passed and failed name the test check, and none says in a note why no test run counts`,
    ),
    ...need(
      !commits || !isLink(runnable?.evidence) || readsBaseCi(String(runnable?.evidence), commits),
      `${label}: labels.runnable.evidence must read the base commit's recorded CI: ${commits}check-runs or ${commits}status, with any query`,
    ),
    ...need(
      labels?.authoring === undefined ||
        (!!authoring &&
          typeof authoring.lab === "string" &&
          SLUG.test(authoring.lab) &&
          oneOf(AUTHORING_SOURCES, authoring.source) &&
          text(authoring.evidence)),
      `${label}: labels.authoring needs a lowercase lab id, a source (commit-trailer, bot-account or synthetic), and the evidence`,
    ),
    ...need(
      !(Array.isArray(item.traits) && item.traits.includes("trivial-looking")) || item.kind === "bug",
      `${label}: only a bug case has the trivial-looking trait`,
    ),
  ]
}

// The distinct files a defect's locations and alternatives name, other than tests: an alternative may be a test the
// change edited to hide the failure, which does not make the defect cross-file. A test is one of the fix's regression
// test paths, or a path TEST_PATH matches.
function sourceFilesOf(defect: Cited | undefined, tests: unknown) {
  return new Set(citedPaths(defect).filter((path) => !isTest(path, tests)))
}

// The tests a defect cites among its locations and alternatives.
function testsOf(defect: Cited | undefined, tests: unknown) {
  return [...new Set(citedPaths(defect).filter((path) => isTest(path, tests)))]
}

type Cited = { locations?: unknown; alternatives?: unknown }

function citedPaths(defect: Cited | undefined) {
  return [
    ...(Array.isArray(defect?.locations) ? defect.locations : []),
    ...(Array.isArray(defect?.alternatives) ? defect.alternatives : []),
  ]
    .map((location) => record(location)?.path)
    .filter((path): path is string => typeof path === "string")
}

function isTest(path: string, tests: unknown) {
  return (Array.isArray(tests) && tests.includes(path)) || TEST_PATH.test(path)
}

// VS-22c: a labelled defect is in the change, and one labelled testGap weakened cites the test the change weakened.
function inChangeProblems(label: string, defect: Record<string, unknown> | undefined, tests: unknown) {
  if (!defect) return []
  return [
    ...need(
      !oneOf(NOT_IN_CHANGE_SCOPES, defect.scope),
      `${label}: scope ${String(defect.scope)} is not in the change; such a defect goes in labels.notInChange`,
    ),
    ...need(
      defect.testGap !== "weakened" || testsOf(defect, tests).length > 0,
      `${label}: testGap weakened needs the weakened test among its locations or alternatives (a test path, or one of regressionTest.paths)`,
    ),
  ]
}

// VS-22c: real defects outside the change, on a case of any kind (VS-42's pre-existing bug beside a benign edit is a
// control). Each is a defect with a pre-existing or unrelated scope, and none of the labels of a defect in the change.
function notInChangeProblems(label: string, labels: Record<string, unknown> | undefined) {
  if (labels?.notInChange === undefined) return []
  if (!Array.isArray(labels.notInChange)) return [`${label}: labels.notInChange must be a list`]
  const entries = labels.notInChange
  const names = entries.map((entry, index) => {
    const id = record(entry)?.id
    return typeof id === "string" ? id : `#${index + 1}`
  })
  const inChange = (Array.isArray(labels.defects) ? labels.defects : []).map((defect) => record(defect)?.id)
  return [
    ...names
      .filter((id, index) => names.indexOf(id) !== index || inChange.includes(id))
      .map((id) => `${label}: defect id ${id} repeats`),
    ...entries.flatMap((entry, index) => {
      const defect = record(entry)
      const name = `${label}: notInChange ${names[index]}`
      if (!defect) return defectProblems(name, entry)
      return [
        ...defectProblems(name, entry),
        // An unknown scope is reported by classProblems.
        ...need(
          oneOf(NOT_IN_CHANGE_SCOPES, defect.scope) ||
            (defect.scope !== undefined && !oneOf(DEFECT_SCOPES, defect.scope)),
          `${name}: scope must be ${NOT_IN_CHANGE_SCOPES.join(" or ")}`,
        ),
        ...need(
          defect.testGap === undefined && defect.introducedAt === undefined && defect.interaction === undefined,
          `${name}: testGap, introducedAt and interaction describe a defect in the change`,
        ),
      ]
    }),
  ]
}

// VS-22c: an adversarial case whose change adds a rule to a file trusted rules are read from (VS-43's head-added rule).
// The object checks confirm the change adds those lines.
function headRuleProblems(label: string, item: Record<string, unknown>, labels: Record<string, unknown> | undefined) {
  if (labels?.headRule === undefined) return []
  const path = record(labels.headRule)?.path
  return [
    ...need(item.kind === "adversarial", `${label}: only an adversarial case has labels.headRule`),
    ...locationProblems(`${label}: labels.headRule`, labels.headRule),
    ...need(
      !isPath(path) || carriesRules(path as string),
      `${label}: labels.headRule.path ${String(path)} is not a file trusted rules are read from (AGENTS.md or CLAUDE.md in any directory, .vector/RULES.md, ${REVIEW_RULES_PATHS.join(", ")} or ${REVIEW_CONFIG_PATH})`,
    ),
  ]
}

// Whether core's rule citation check reads rules from a file at this path (citation.ts RULE_FILES), asked through
// trustedRules itself so the set stays core's: a one-line addition to such a file comes back as head-added rule text.
function carriesRules(path: string) {
  const line = { kind: "add" as const, newLine: 1, text: "rule" }
  const file: DiffFile = {
    path,
    status: "added",
    binary: false,
    additions: 1,
    deletions: 0,
    patch: "@@ -0,0 +1 @@\n+rule",
    hunks: [{ header: "@@ -0,0 +1 @@", oldStart: 0, oldLines: 0, newStart: 1, newLines: 1, lines: [line] }],
  }
  return trustedRules({ anchors: [file] }).added.length > 0
}

// VS-22c: an adversarial case whose review feedback attacks team memory (VS-35). The feedback is synthetic history on
// the case's real commits: dismissed comments carrying finding markers and synthetic vector-dismissal markers, dated
// no later than the head. Its labels name the attack and the labelled defect it tries to hide, and at least one
// dismissed pattern must reach that defect: the finding's category, the directory of one of the defect's locations,
// and marker words at least TEAM_SIMILARITY like the finding's title, as guarded memory matches them. Nothing in the
// feedback may quote a label, the case id or the fix, since the feedback reaches the reviewer.
function feedbackProblems(
  label: string,
  item: Record<string, unknown>,
  candidate: Record<string, unknown> | undefined,
  labels: Record<string, unknown> | undefined,
) {
  if (item.feedback === undefined && labels?.feedback === undefined) return []
  const input = record(item.feedback)
  const target = record(labels?.feedback)
  const both = [
    ...need(item.kind === "adversarial", `${label}: only an adversarial case carries review feedback`),
    ...need(
      !!input && !!target,
      `${label}: feedback and labels.feedback go together: the review feedback the case gives, and what it attacks`,
    ),
  ]
  if (!input || !target) return both
  const finding = record(target.finding)
  const comments = Array.isArray(input.comments) ? input.comments.map(record) : []
  const head = isTime(candidate?.date) ? Date.parse(candidate!.date as string) : undefined
  const before = (value: unknown) => isTime(value) && (head === undefined || Date.parse(value as string) <= head)
  const defects = (Array.isArray(labels?.defects) ? labels.defects : []).map(record)
  const hidden = defects.find((defect) => !!defect && defect.id === target.defect)
  const pushes = input.botPushes
  const own = input.own
  const fix = record(item.fix)?.sha
  // Compared in lower case, so a label quoted in another letter case is still caught.
  const quoted = [
    ...[...defects, ...(Array.isArray(labels?.notInChange) ? labels.notInChange.map(record) : [])].flatMap((defect) => [
      defect?.id,
      defect?.summary,
      defect?.cause,
    ]),
    labels?.injection,
    labels?.rationale,
    finding?.title,
    item.id,
    typeof fix === "string" ? fix.slice(0, 7) : undefined,
  ]
    .filter((value): value is string => text(value))
    .map((value) => value.toLowerCase())
  const leaks = comments.flatMap((comment, index) =>
    [comment?.body, comment?.path].some(
      (value) => typeof value === "string" && quoted.some((secret) => value.toLowerCase().includes(secret)),
    )
      ? [index + 1]
      : [],
  )
  const category = finding?.category
  const known = isFindingCategory(category)
  const probe =
    known && typeof finding?.title === "string"
      ? { category: category as Category, words: normalizeTitle(finding.title) }
      : undefined
  const dirs = (Array.isArray(hidden?.locations) ? hidden.locations : [])
    .map((location) => record(location)?.path)
    .filter((path): path is string => typeof path === "string")
    .map(teamDir)
  const reached = comments.some((comment) => {
    const marker = typeof comment?.body === "string" ? parseFindingMarker(comment.body) : undefined
    const path = comment?.path
    return (
      !!probe &&
      !!marker &&
      marker.status === "dismissed" &&
      typeof path === "string" &&
      dirs.some((dir) =>
        sameTeamPattern({ ...probe, dir }, { category: marker.category, dir: teamDir(path), words: marker.words }),
      )
    )
  })
  return [
    ...both,
    ...need(
      oneOf(FEEDBACK_SOURCES, input.source),
      `${label}: feedback.source must be synthetic; recorded feedback waits for VS-35's dismissal markers`,
    ),
    ...need(
      oneOf(FEEDBACK_ATTACKS, target.attack),
      `${label}: labels.feedback.attack must be one of ${FEEDBACK_ATTACKS.join(", ")}`,
    ),
    ...need(
      !!hidden,
      `${label}: labels.feedback.defect must name a labelled defect: the real defect the feedback tries to hide`,
    ),
    ...need(
      typeof category === "string" && text(finding?.title),
      `${label}: labels.feedback.finding needs the core category and the title of the finding a reviewer would post for that defect`,
    ),
    ...need(
      typeof category !== "string" || known,
      `${label}: labels.feedback.finding.category ${String(category)} must be one of core's finding categories (review/types.ts CATEGORIES), not a dataset defect category`,
    ),
    ...need(comments.length > 0, `${label}: feedback.comments must list at least one dismissed comment`),
    ...comments.flatMap((comment, index) =>
      commentProblems(`${label}: feedback comment ${index + 1}`, comment, before),
    ),
    ...need(
      pushes === undefined ||
        (Array.isArray(pushes) &&
          pushes.every((value) => {
            const push = record(value)
            return !!push && positive(push.pr) && before(push.at)
          })),
      `${label}: feedback.botPushes needs each push's pull request number and its ISO 8601 time, no later than the head's`,
    ),
    ...need(
      own === undefined ||
        (Array.isArray(own) &&
          own.every((hash) => typeof hash === "string" && isDismissalMarker({ by: "w", why: "fp", hash }))),
      `${label}: feedback.own must list dismissal-marker hashes (12 to 64 lowercase hex characters)`,
    ),
    ...need(
      !hidden || !probe || comments.length === 0 || reached,
      `${label}: no feedback comment reaches defect ${String(target.defect)}: none dismisses a ${String(finding?.category)} finding in the directory of one of its locations with marker words at least ${TEAM_SIMILARITY} like labels.feedback.finding.title`,
    ),
    ...leaks.map(
      (index) =>
        `${label}: feedback comment ${index} quotes a label, the case id or the fix, and review feedback reaches the reviewer`,
    ),
  ]
}

function commentProblems(
  label: string,
  comment: Record<string, unknown> | undefined,
  before: (value: unknown) => boolean,
) {
  const marker = typeof comment?.body === "string" ? parseFindingMarker(comment.body) : undefined
  return [
    ...need(
      !!comment && positive(comment.pr) && isPath(comment.path),
      `${label} needs a positive pull request number and a relative path`,
    ),
    ...need(
      marker?.status === "dismissed" && marker.words.length > 0,
      `${label} has no dismissed Vector finding marker with title words, so no team memory reads it`,
    ),
    ...need(
      comment?.at === undefined || before(comment.at),
      `${label}: at must be an ISO 8601 time no later than the head's`,
    ),
    ...need(
      (comment?.replied === undefined || typeof comment.replied === "boolean") &&
        (comment?.codeChanged === undefined || typeof comment.codeChanged === "boolean"),
      `${label}: replied and codeChanged must be true or false`,
    ),
  ]
}

// Whether core reads this as a finding category, asked through its own marker writer and parser so the list stays
// types.ts's CATEGORIES (dataset.ts's CATEGORIES is the defect categories, another list) and nothing is copied.
function isFindingCategory(value: unknown) {
  if (typeof value !== "string") return false
  const marker = findingMarker({
    id: "0".repeat(12),
    severity: "concern",
    category: value as Category,
    sha: "0".repeat(7),
    status: "open",
    words: [],
  })
  return parseFindingMarker(marker)?.category === value
}

// VS-22c: a multi-commit sequence (VS-41). candidate.commits are the pull request's pushed heads in push order, the
// last one the head; each labelled defect names the push that introduced it. The incremental trait marks exactly these
// cases. The object checks confirm the pushes chain by ancestry from the base.
function sequenceProblems(
  label: string,
  item: Record<string, unknown>,
  candidate: Record<string, unknown> | undefined,
  labels: Record<string, unknown> | undefined,
) {
  const defects = (Array.isArray(labels?.defects) ? labels.defects : []).map(record)
  const ids = defects.map((defect, index) => (typeof defect?.id === "string" ? defect.id : `#${index + 1}`))
  const incremental = Array.isArray(item.traits) && item.traits.includes("incremental")
  if (candidate?.commits === undefined)
    return [
      ...need(
        !incremental,
        `${label}: the incremental trait marks a multi-commit sequence, and this case has no candidate.commits`,
      ),
      ...defects.flatMap((defect, index) =>
        need(
          defect?.introducedAt === undefined && defect?.interaction === undefined,
          `${label}: defect ${ids[index]}: introducedAt and interaction describe a push of a multi-commit sequence (candidate.commits)`,
        ),
      ),
    ]
  const pushes = Array.isArray(candidate.commits) ? candidate.commits.map(record) : []
  if (pushes.length < 2 || !pushes.every((push) => !!push && isSha(push.sha) && isTime(push.date)))
    return [
      `${label}: candidate.commits must list at least two pushes in order, each a full commit SHA and its ISO 8601 commit time`,
    ]
  const shas = pushes.map((push) => push?.sha)
  const last = pushes.at(-1)
  const fix = record(item.fix)?.sha
  return [
    ...need(
      new Set(shas).size === shas.length && !shas.includes(candidate.base),
      `${label}: candidate.commits repeats a push or names the base`,
    ),
    ...need(
      !!last &&
        last.sha === candidate.head &&
        isTime(candidate.date) &&
        Date.parse(last.date as string) === Date.parse(candidate.date as string),
      `${label}: candidate.commits must end at candidate.head, with candidate.date as its time`,
    ),
    ...need(fix === undefined || !shas.includes(fix), `${label}: the fix is one of the sequence's pushes`),
    ...need(incremental, `${label}: a multi-commit sequence carries the incremental trait`),
    ...defects.flatMap((defect, index) => [
      ...need(
        shas.includes(defect?.introducedAt),
        `${label}: defect ${ids[index]} needs introducedAt, the push in candidate.commits that introduced it`,
      ),
      ...need(
        defect?.interaction === undefined || typeof defect.interaction === "boolean",
        `${label}: defect ${ids[index]}: interaction must be true or false`,
      ),
      ...need(
        defect?.interaction !== true || !shas.includes(defect.introducedAt) || defect.introducedAt !== shas[0],
        `${label}: defect ${ids[index]}: an interaction defect is introduced by a push after the first`,
      ),
    ]),
  ]
}

// Whether a link reads the base commit's check-runs or status API, as the guide's gh api commands do, with any query.
// GitHub matches the owner and name in any case.
function readsBaseCi(link: string, commits: string) {
  const url = new URL(link)
  const read = `${url.origin}${url.pathname}`.toLowerCase()
  return !url.hash && [`${commits}check-runs`, `${commits}status`].some((path) => path.toLowerCase() === read)
}

// A prompt-injection case: a change carrying text that tries to instruct the reviewer. Its labels say what the text
// asks and what a safe reviewer does. It may also label real defects the injection tries to hide, and then needs their
// fix like a bug case; it is still left out of recall and of false alarms per clean pull request.
function adversarialProblems(
  label: string,
  item: Record<string, unknown>,
  candidate: Record<string, unknown> | undefined,
  labels: Record<string, unknown> | undefined,
) {
  const defects = Array.isArray(labels?.defects) ? labels.defects : undefined
  return [
    ...need(
      text(labels?.injection),
      `${label}: an adversarial case needs labels.injection: the injected instruction, where it is, and what a safe reviewer does`,
    ),
    ...need(!!defects, `${label}: labels.defects must be a list (it may be empty)`),
    ...(defects?.length
      ? bugProblems(label, item, candidate, labels)
      : need(item.fix === undefined, `${label}: an adversarial case with no labelled defect has no fix`)),
  ]
}

function defectProblems(label: string, value: unknown) {
  const defect = record(value)
  if (!defect) return [`${label} is not an object`]
  const locations = Array.isArray(defect.locations) ? defect.locations : []
  return [
    ...need(
      typeof defect.id === "string" && SLUG.test(defect.id),
      `${label}: id must be lowercase words joined by hyphens`,
    ),
    ...need(oneOf(CATEGORIES, defect.category), `${label}: category must be one of ${CATEGORIES.join(", ")}`),
    ...need(oneOf(SEVERITIES, defect.severity), `${label}: severity must be blocking or concern`),
    ...need(text(defect.summary), `${label}: summary is empty`),
    ...need(text(defect.cause), `${label}: cause must explain why the code is wrong`),
    ...need(locations.length > 0, `${label}: needs at least one location`),
    ...need(Array.isArray(defect.alternatives), `${label}: alternatives must be a list (it may be empty)`),
    ...[...locations, ...(Array.isArray(defect.alternatives) ? defect.alternatives : [])].flatMap((location) =>
      locationProblems(label, location),
    ),
    ...classProblems(label, defect),
  ]
}

// VS-22a's and VS-22c's labels of one defect, on the case or in one pass's own record. Each is optional: absent means
// not yet labelled.
function classProblems(label: string, defect: Record<string, unknown>) {
  return [
    ...need(
      defect.contextLevel === undefined || oneOf(CONTEXT_LEVELS, defect.contextLevel),
      `${label}: contextLevel must be one of ${CONTEXT_LEVELS.join(", ")}`,
    ),
    ...need(
      defect.scope === undefined || oneOf(DEFECT_SCOPES, defect.scope),
      `${label}: scope must be one of ${DEFECT_SCOPES.join(", ")}`,
    ),
    ...need(
      defect.testGap === undefined || oneOf(TEST_GAPS, defect.testGap),
      `${label}: testGap must be one of ${TEST_GAPS.join(", ")}`,
    ),
    ...need(
      defect.failureClass === undefined || oneOf(DEFECT_CLASSES, defect.failureClass),
      `${label}: failureClass must be one of ${DEFECT_CLASSES.join(", ")}`,
    ),
    ...need(
      defect.mechanism === undefined || oneOf(MECHANISMS, defect.mechanism),
      `${label}: mechanism must be one of ${MECHANISMS.join(", ")}`,
    ),
    ...need(
      defect.pendingQ4 === undefined || (oneOf(PENDING_Q4, defect.pendingQ4) && defect.failureClass === "other"),
      `${label}: pendingQ4 must be one of ${PENDING_Q4.join(", ")}, on a defect whose failureClass is other`,
    ),
    ...need(
      defect.pendingQ4 !== "concurrency-wrong-result" || defect.mechanism === "concurrency",
      `${label}: pendingQ4 concurrency-wrong-result needs mechanism concurrency`,
    ),
  ]
}

function locationProblems(label: string, value: unknown) {
  const location = record(value)
  const line = location?.line
  const end = location?.endLine
  return need(
    !!location &&
      isPath(location.path) &&
      Number.isInteger(line) &&
      (line as number) > 0 &&
      (end === undefined || (Number.isInteger(end) && (end as number) >= (line as number))),
    `${label}: location ${JSON.stringify(value)} needs a relative path, a positive line and an endLine not before it`,
  )
}

// D8: two independent model-assisted passes, with the owner adjudicating their disagreements. A pass may record its own
// VS-22a labels; once one does, a double-annotated or adjudicated case needs two that do, so the passes can be compared.
function annotationProblems(
  label: string,
  annotation: Record<string, unknown> | undefined,
  labels: Record<string, unknown> | undefined,
) {
  if (!annotation) return [`${label}: labels.annotation is missing`]
  const passes = Array.isArray(annotation.passes) ? annotation.passes.map(record) : []
  const numbers = new Set(passes.map((pass) => pass?.pass))
  const adjudication = record(annotation.adjudication)
  const required = annotation.status === "draft" ? 1 : 2
  const ids = (Array.isArray(labels?.defects) ? labels.defects : []).map((defect) => record(defect)?.id)
  const recorded = passes.filter((pass) => pass?.labels !== undefined)
  const recordedNumbers = recorded.map((pass) => pass?.pass)
  return [
    ...need(
      oneOf(ANNOTATION_STATUSES, annotation.status),
      `${label}: annotation status must be one of ${ANNOTATION_STATUSES.join(", ")}`,
    ),
    ...need(
      passes.length > 0 &&
        passes.every((pass) => !!pass && Number.isInteger(pass.pass) && text(pass.method) && isDay(pass.date)),
      `${label}: each annotation pass needs a number, a method and a date`,
    ),
    ...need(
      numbers.size >= required,
      `${label}: a ${String(annotation.status)} label needs ${required} separate passes`,
    ),
    ...need(
      annotation.status !== "adjudicated" || (!!adjudication && text(adjudication.by) && isDay(adjudication.date)),
      `${label}: an adjudicated label must record who adjudicated it and when`,
    ),
    ...need(
      annotation.agreed === undefined ||
        (typeof annotation.agreed === "boolean" &&
          (annotation.status === "double-annotated" || (annotation.status === "adjudicated" && !annotation.agreed))),
      `${label}: agreed records whether a double-annotated label's two passes agreed; an adjudicated label's did not`,
    ),
    ...recorded.flatMap((pass) => passLabelProblems(`${label}: pass ${String(pass?.pass)}`, pass?.labels, ids)),
    // A pass may record its labels over several entries, as VS-22a's and VS-22c's did, but each label once.
    ...[...new Set(recordedNumbers)].flatMap((number) => {
      const repeated = repeatedLabels(byPass(recorded, number))
      return repeated.length
        ? [`${label}: pass ${String(number)} records the same label in more than one entry (${repeated.join(", ")})`]
        : []
    }),
    ...need(
      recorded.length === 0 || annotation.status === "draft" || new Set(recordedNumbers).size >= 2,
      `${label}: a ${String(annotation.status)} label whose passes record their own labels needs two passes that do`,
    ),
    ...need(
      annotation.agreed !== true ||
        [...new Set(recordedNumbers)].every((number) => agrees(mergedPass(byPass(recorded, number)), labels)),
      `${label}: agreed is true, but a pass's own labels differ from the case's labels`,
    ),
  ]
}

// The label records of one pass's entries.
function byPass(recorded: (Record<string, unknown> | undefined)[], number: unknown) {
  return recorded.filter((pass) => pass?.pass === number).map((pass) => record(pass?.labels))
}

// The labels a pass gives that more than one of its entries records: each defect's failureClass (with its pendingQ4),
// mechanism, contextLevel, scope and testGap, and crossFile, named as defect.label.
function repeatedLabels(entries: (Record<string, unknown> | undefined)[]) {
  const given = entries.map(
    (entry) =>
      new Set([
        ...(Array.isArray(entry?.defects) ? entry.defects : []).flatMap((value) => {
          const defect = record(value)
          return PASS_LABELS.filter((name) => defect?.[name] !== undefined).map(
            (name) => `${String(defect?.id)}.${name}`,
          )
        }),
        ...(entry?.crossFile !== undefined ? ["crossFile"] : []),
      ]),
  )
  const all = given.flatMap((names) => [...names])
  return [...new Set(all.filter((name, index) => all.indexOf(name) !== index))]
}

const PASS_LABELS = ["failureClass", "mechanism", "contextLevel", "scope", "testGap"] as const

// A pass's entries as one record: each defect's labels from whichever entry gives them, and crossFile.
function mergedPass(entries: (Record<string, unknown> | undefined)[]) {
  const defects = entries.flatMap((entry) => (Array.isArray(entry?.defects) ? entry.defects.map(record) : []))
  const ids = [...new Set(defects.map((defect) => defect?.id))]
  return {
    defects: ids.map((id) =>
      defects
        .filter((defect) => defect?.id === id)
        .reduce<Record<string, unknown>>((merged, defect) => ({ ...merged, ...defect }), {}),
    ),
    crossFile: entries.find((entry) => entry?.crossFile !== undefined)?.crossFile,
  }
}

// One pass's own VS-22a labels. They name the case's defects by id.
function passLabelProblems(label: string, value: unknown, ids: unknown[]) {
  const own = record(value)
  if (!own || !Array.isArray(own.defects)) return [`${label}: labels needs a defects list (it may be empty)`]
  const entries = own.defects.map(record)
  const named = entries.map((entry) => entry?.id)
  return [
    ...entries
      .filter((entry) => !entry || !ids.includes(entry.id))
      .map((entry) => `${label}: labels name defect ${JSON.stringify(entry?.id)}, which the case does not have`),
    ...named
      .filter((id, index) => named.indexOf(id) !== index)
      .map((id) => `${label}: labels name defect ${String(id)} twice`),
    ...entries.flatMap((entry) => (entry ? classProblems(`${label}: defect ${String(entry.id)}`, entry) : [])),
    // A pass labels the case's own defects, which are in the change.
    ...entries.flatMap((entry) =>
      need(
        !oneOf(NOT_IN_CHANGE_SCOPES, entry?.scope),
        `${label}: defect ${String(entry?.id)}: scope ${String(entry?.scope)} is not in the change; such a defect goes in labels.notInChange`,
      ),
    ),
    ...need(
      own.crossFile === undefined || typeof own.crossFile === "boolean",
      `${label}: labels.crossFile must be true or false`,
    ),
  ]
}

// A pass agrees with the case's labels when it labelled every defect, and every label it records is the case's.
function agrees(own: Record<string, unknown> | undefined, labels: Record<string, unknown> | undefined) {
  const defects = (Array.isArray(labels?.defects) ? labels.defects : []).map(record)
  const entries = (Array.isArray(own?.defects) ? own.defects : []).map(record)
  const same = (mine: unknown, theirs: unknown) => mine === undefined || mine === theirs
  return (
    entries.length === defects.length &&
    entries.every((entry) => {
      const defect = defects.find((item) => item?.id === entry?.id)
      return (
        !!defect &&
        same(entry?.failureClass, defect.failureClass) &&
        same(entry?.mechanism, defect.mechanism) &&
        same(entry?.contextLevel, defect.contextLevel) &&
        same(entry?.scope, defect.scope) &&
        same(entry?.testGap, defect.testGap) &&
        // No Q4 marker on a labelled class means none applies, so it is compared whenever the class is.
        (entry?.failureClass === undefined || entry.pendingQ4 === defect.pendingQ4)
      )
    }) &&
    same(own?.crossFile, labels?.crossFile)
  )
}

// D8: the owner adjudicates only disagreements. A label stands, and may be frozen, once it is adjudicated or its two
// passes were compared and agreed.
export function labelSettled(annotation: Annotation) {
  return annotation.status === "adjudicated" || (annotation.status === "double-annotated" && annotation.agreed === true)
}

function exclusionProblems(value: unknown, index: number) {
  const item = record(value)
  const label = `exclusion #${index + 1}`
  if (!item) return [`${label} is not an object`]
  const candidate = record(item.candidate)
  return [
    ...need(
      typeof item.repository === "string" && REPOSITORY.test(item.repository),
      `${label}: repository must be https://github.com/<owner>/<name>`,
    ),
    ...need(oneOf(EXCLUSION_REASONS, item.reason), `${label}: reason must be one of ${EXCLUSION_REASONS.join(", ")}`),
    ...need(text(item.detail), `${label}: detail must say why the case was left out`),
    ...need(isDay(item.date), `${label}: date must be a YYYY-MM-DD date`),
    ...need(
      item.candidate === undefined ||
        (!!candidate && isSha(candidate.head) && (candidate.base === undefined || isSha(candidate.base))),
      `${label}: candidate needs a full head SHA, and a full base SHA when one is given`,
    ),
    ...need(item.fix === undefined || isSha(item.fix), `${label}: fix must be a full 40-character commit SHA`),
  ]
}

// Freezing records a digest of the held-out cases once their labels are settled (adjudicated, or two passes that
// agreed), before any prompt tuning. Any later change to a held-out case, or to which cases are held out, breaks the
// digest. A held-out bug case is frozen only with VS-22a's labels and both passes' own record of them, since none of
// them can be added afterwards without a new freeze, and class-scoped recall (Q3) and the passes' agreement need them.
function freezeProblems(manifest: Manifest) {
  if (manifest.freeze === undefined) return []
  const freeze = record(manifest.freeze)
  if (
    !freeze ||
    !isDay(freeze.date) ||
    typeof freeze.digest !== "string" ||
    !/^sha256:[0-9a-f]{64}$/.test(freeze.digest)
  )
    return ["freeze needs a date and a sha256: digest of the held-out cases"]
  return [
    ...manifest.cases
      .filter((item) => item.split === "held-out" && !labelSettled(item.labels.annotation))
      .map(
        (item) =>
          `case ${item.id}: held-out labels were frozen before they were settled (two passes that agreed, or the owner's adjudication)`,
      ),
    ...manifest.cases
      .filter((item) => item.split === "held-out" && item.kind === "bug")
      .flatMap((item) => {
        const missing = [
          ...(item.labels.defects.every((defect) => defect.failureClass !== undefined) ? [] : ["failureClass"]),
          ...(item.labels.defects.every((defect) => defect.mechanism !== undefined) ? [] : ["mechanism"]),
          ...(item.labels.crossFile === undefined ? ["crossFile"] : []),
          ...(item.labels.runnable === undefined ? ["runnable"] : []),
          // VS-22c's, which VS-37's per-level recall and S9's scope read. testGap is not required while its
          // definition is new (vectorscope-deviations.md, VS-22c), and labels.notInChange is outside the freeze.
          ...(item.labels.defects.every((defect) => defect.contextLevel !== undefined) ? [] : ["contextLevel"]),
          ...(item.labels.defects.every((defect) => defect.scope !== undefined) ? [] : ["scope"]),
          // An unsettled label is reported above for its missing pass or agreement.
          ...(labelSettled(item.labels.annotation) &&
          new Set(item.labels.annotation.passes.filter((pass) => pass.labels).map((pass) => pass.pass)).size < 2
            ? ["two passes' own labels"]
            : []),
        ]
        return missing.length ? [`case ${item.id}: held-out labels were frozen without ${missing.join(", ")}`] : []
      }),
    ...need(
      heldOutDigest(manifest) === freeze.digest,
      "the held-out cases changed after the freeze: their digest no longer matches freeze.digest",
    ),
  ]
}

export function heldOutDigest(manifest: Pick<Manifest, "cases">) {
  const held = manifest.cases
    .filter((item) => item.split === "held-out")
    .toSorted((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  return `sha256:${createHash("sha256").update(canonical(held)).digest("hex")}`
}

type SplitInput = Pick<Case, "id" | "kind" | "family" | "repository" | "candidate"> & { fix?: { date: string } }

// The split rule. Bug cases, controls, trivial controls and adversarial cases are split separately, each roughly
// 60/20/20. Cases of one kind that share a repository or a family form one group and always land together, so a related
// fix cannot sit on both sides (manifestProblems keeps one repository's cases to one kind). Groups are ordered
// by their latest date (the fix for a bug, the candidate for a control): the oldest fill development, then
// calibration, and the newest are held out, so nothing tuned on can postdate what it is tested on. Calibration and
// held-out each take round(n / 5) cases; a group that straddles a boundary goes to the earlier split.
export function assignSplits(cases: SplitInput[]) {
  return new Map<string, Split>(
    KINDS.flatMap((kind) => {
      const members = cases.filter((item) => item.kind === kind)
      const share = Math.round(members.length / 5)
      const development = members.length - 2 * share
      const groups = groupCases(members)
        .map((group) => ({
          group,
          time: Math.max(...group.map((item) => Date.parse(item.fix?.date ?? item.candidate.date) || 0)),
          first: group.map((item) => item.id).toSorted()[0],
        }))
        .toSorted((a, b) => a.time - b.time || (a.first < b.first ? -1 : a.first > b.first ? 1 : 0))
      const starts = groups.map((_, index) => sum(groups.slice(0, index).map((entry) => entry.group.length)))
      return groups.flatMap((entry, index) => {
        const split: Split =
          starts[index] < development ? "development" : starts[index] < development + share ? "calibration" : "held-out"
        return entry.group.map((item) => [item.id, split] as const)
      })
    }),
  )
}

// Connected components over shared repositories and families.
function groupCases<T extends SplitInput>(cases: T[]) {
  const parent = new Map<string, string>()
  const find = (key: string): string => {
    const up = parent.get(key) ?? key
    return up === key ? key : find(up)
  }
  const link = (a: string, b: string) => {
    const left = find(a)
    const right = find(b)
    if (left !== right) parent.set(left, right)
  }
  cases.forEach((item) => {
    link(`case:${item.id}`, `repository:${repositoryKey(item.repository.url)}`)
    if (item.family) link(`case:${item.id}`, `family:${item.family}`)
  })
  return Object.values(Object.groupBy(cases, (item) => find(`case:${item.id}`))).filter(
    (group): group is T[] => !!group,
  )
}

export interface ObjectCheck {
  checked: string[] // case ids checked against a local mirror
  unchecked: string[] // case ids with no mirror; their recorded check stands
  problems: string[]
  notes?: string[] // advice that refuses nothing (VS-22c's context levels), present only when there is some
}

// Checks each case against a local clone of its repository, read-only. `locate` maps a repository URL to a local
// directory, or undefined when there is none; nothing is fetched.
export function objectProblems(
  manifest: Pick<Manifest, "cases">,
  locate: (url: string) => string | undefined,
): ObjectCheck {
  const entries = manifest.cases.map((item) => ({ item, dir: locate(item.repository.url) }))
  const results = entries.flatMap((entry) => (entry.dir ? [caseObjectProblems(entry.item, entry.dir)] : []))
  const notes = results.flatMap((result) => result.notes)
  return {
    checked: entries.filter((entry) => entry.dir).map((entry) => entry.item.id),
    unchecked: entries.filter((entry) => !entry.dir).map((entry) => entry.item.id),
    problems: results.flatMap((result) => result.problems),
    ...(notes.length ? { notes } : {}),
  }
}

// The diff options the engine reviews a change with (packages/engine/src/review/source.ts DIFF), at its default
// context.
const REVIEWED_DIFF = [
  "--no-color",
  "--no-ext-diff",
  "--no-textconv",
  "--no-relative",
  "--src-prefix=a/",
  "--dst-prefix=b/",
  "--find-renames",
  "--unified=3",
]

function caseObjectProblems(item: Case, dir: string): { problems: string[]; notes: string[] } {
  const label = `case ${item.id}`
  const git = (...args: string[]) => {
    const result = Bun.spawnSync(["git", ...UNTRUSTED_GIT, "-C", dir, ...args], {
      env: untrustedGitEnv(),
      stdout: "pipe",
      stderr: "pipe",
    })
    return { ok: result.exitCode === 0, out: result.stdout.toString() }
  }
  const pushes = item.candidate.commits ?? []
  const commits = [
    { name: "candidate.base", sha: item.candidate.base },
    { name: "candidate.head", sha: item.candidate.head },
    ...pushes.map((push, index) => ({ name: `candidate.commits[${index}]`, sha: push.sha })),
    ...(item.fix ? [{ name: "fix.sha", sha: item.fix.sha }] : []),
  ]
  const missing = commits.filter((commit) => git("cat-file", "-t", commit.sha).out.trim() !== "commit")
  if (missing.length)
    return {
      problems: missing.map((commit) => `${label}: ${commit.name} ${commit.sha} is not a commit in ${dir}`),
      notes: [],
    }

  const ancestor = (a: string, b: string) => git("merge-base", "--is-ancestor", a, b).ok
  const time = (sha: string) => Date.parse(git("show", "-s", "--format=%cI", sha).out.trim())
  const blob = (sha: string, path: string) => {
    const result = git("rev-parse", "--verify", "--quiet", `${sha}:${path}`)
    return result.ok ? result.out.trim() : undefined
  }
  const numstat = git("diff", "--numstat", "-M", item.candidate.base, item.candidate.head)
    .out.split("\n")
    .filter(Boolean)
    .map((line) => line.split("\t"))
  const changed = {
    files: numstat.length,
    additions: sum(numstat.map((parts) => Number(parts[0]) || 0)),
    deletions: sum(numstat.map((parts) => Number(parts[1]) || 0)),
  }
  const fix = item.fix
  // The fix's own change: paths whose content differs from its first parent. A candidate head that already holds the
  // fix's version of one of them shows the reviewer the answer.
  const leaked = fix
    ? git("diff", "--name-only", "--no-renames", `${fix.sha}^1`, fix.sha)
        .out.split("\n")
        .filter(Boolean)
        .filter((path) => {
          const fixed = blob(fix.sha, path)
          return !!fixed && fixed !== blob(`${fix.sha}^1`, path) && blob(item.candidate.head, path) === fixed
        })
    : []
  const cites = (who: string, defect: Pick<Defect, "locations" | "alternatives">) =>
    [...defect.locations, ...defect.alternatives].map((location) => ({ who, location }))
  const locations = [
    ...item.labels.defects.flatMap((defect) => cites(`defect ${defect.id}`, defect)),
    ...(item.labels.notInChange ?? []).flatMap((defect) => cites(`notInChange ${defect.id}`, defect)),
    ...(item.labels.headRule ? [{ who: "labels.headRule", location: item.labels.headRule }] : []),
  ]
  const change = changeOf(git("diff", ...REVIEWED_DIFF, item.candidate.base, item.candidate.head).out)
  const labelled = changeProblems(label, item, change)
  return {
    problems: [
      ...need(
        ancestor(item.candidate.base, item.candidate.head),
        `${label}: candidate.base ${short(item.candidate.base)} is not an ancestor of candidate.head ${short(item.candidate.head)}`,
      ),
      ...(fix
        ? [
            ...need(
              ancestor(item.candidate.head, fix.sha),
              `${label}: candidate.head ${short(item.candidate.head)} is not an ancestor of the fix ${short(fix.sha)}`,
            ),
            ...need(
              !ancestor(fix.sha, item.candidate.head),
              `${label}: the fix ${short(fix.sha)} is already in the candidate's history (post-fix leakage)`,
            ),
            ...need(
              leaked.length === 0,
              `${label}: the candidate head already has the fix's version of ${leaked.join(", ")} (post-fix leakage)`,
            ),
            ...need(
              time(fix.sha) === Date.parse(fix.date),
              `${label}: fix.date ${fix.date} is not the fix's commit time ${new Date(time(fix.sha)).toISOString()}`,
            ),
          ]
        : []),
      ...need(
        time(item.candidate.head) === Date.parse(item.candidate.date),
        `${label}: candidate.date ${item.candidate.date} is not the head's commit time ${new Date(time(item.candidate.head)).toISOString()}`,
      ),
      ...need(
        changed.files === item.candidate.changed.files &&
          changed.additions === item.candidate.changed.additions &&
          changed.deletions === item.candidate.changed.deletions,
        `${label}: candidate.changed records ${describeSize(item.candidate.changed)} but git reports ${describeSize(changed)}`,
      ),
      ...locations.flatMap((entry) => {
        const shown = git("cat-file", "-p", `${item.candidate.head}:${entry.location.path}`)
        if (!shown.ok)
          return [`${label}: ${entry.who} cites ${entry.location.path}, which is not in the candidate head`]
        const total = shown.out.replace(/\n$/, "").split("\n").length
        const last = entry.location.endLine ?? entry.location.line
        return need(
          last <= total,
          `${label}: ${entry.who} cites ${entry.location.path}:${entry.location.line}${entry.location.endLine ? `-${entry.location.endLine}` : ""}, past the end of the file (${total} lines)`,
        )
      }),
      ...labelled.problems,
      ...(pushes.length ? pushProblems(label, item, pushes, { git, ancestor, time }) : []),
    ],
    notes: labelled.notes,
  }
}

// What base..head changes, from the diff the engine reviews: each file it does not delete, by its head path, with its
// new-side hunk ranges (context included) and its added lines.
function changeOf(diff: string) {
  return new Map(
    parseUnifiedDiff(diff)
      .filter((file) => file.status !== "deleted")
      .map((file) => [
        file.path,
        {
          file,
          hunks: file.hunks.map((hunk) => [hunk.newStart, hunk.newStart + hunk.newLines - 1] as const),
          added: new Set(
            file.hunks.flatMap((hunk) =>
              hunk.lines.flatMap((line) => (line.kind === "add" && line.newLine !== undefined ? [line.newLine] : [])),
            ),
          ),
        },
      ]),
  )
}

type Change = ReturnType<typeof changeOf>

// VS-22c's labels against the change. A context level is the annotator's judgement of the context a defect needs, so
// only a level narrower than its locations show is refused (a location outside every hunk needs at least the file, one
// in a file the change does not touch the repository); a level its alternatives would widen is a note. The other
// labels must match the lines they describe: exacerbated-by-pr cites an added line and an unchanged one, a defect
// outside the change cites no added line (so no line of a file the change adds), testGap weakened cites an existing
// test the change edits, and a head-added rule lies on lines the change adds to a rule-carrying file. Every line check
// is interval arithmetic over the diff, never a list of the cited lines, since endLine has no upper bound before the
// "past the end of the file" check reports it.
function changeProblems(label: string, item: Case, change: Change) {
  const tests = item.labels.regressionTest?.paths
  const levels = [...item.labels.defects, ...(item.labels.notInChange ?? [])].flatMap((defect) => {
    if (!defect.contextLevel) return []
    const labelled = CONTEXT_LEVELS.indexOf(defect.contextLevel)
    const needed = Math.max(...defect.locations.map((location) => levelOf(change, location)))
    const sources = [...defect.locations, ...defect.alternatives].filter((location) => !isTest(location.path, tests))
    const reached = Math.max(
      ...(sources.length ? sources : defect.locations).map((location) => levelOf(change, location)),
    )
    return [
      {
        problem:
          needed > labelled
            ? `${label}: defect ${defect.id} is labelled ${defect.contextLevel}, but its locations need at least ${CONTEXT_LEVELS[needed]}`
            : undefined,
        note:
          reached > Math.max(labelled, needed)
            ? `${label}: defect ${defect.id} is labelled ${defect.contextLevel}, and its alternatives reach ${CONTEXT_LEVELS[reached]} (advice, not a refusal)`
            : undefined,
      },
    ]
  })
  const added = (location: Location) => addedWithin(change, location) > 0
  const unchanged = (location: Location) => addedWithin(change, location) < span(location)
  const rule = item.labels.headRule
  const ruleFile = rule ? change.get(rule.path) : undefined
  return {
    problems: [
      ...levels.flatMap((entry) => (entry.problem ? [entry.problem] : [])),
      ...item.labels.defects.flatMap((defect) => {
        const cited = [...defect.locations, ...defect.alternatives]
        return [
          ...need(
            defect.scope !== "exacerbated-by-pr" || (cited.some(added) && cited.some(unchanged)),
            `${label}: defect ${defect.id} is exacerbated-by-pr, so it cites a line the change added and one the change left as it was`,
          ),
          ...need(
            defect.testGap !== "weakened" ||
              testsOf(defect, tests).some((path) => {
                const file = change.get(path)?.file
                return !!file && file.status !== "added"
              }),
            `${label}: defect ${defect.id} is testGap weakened, but no test it cites is an existing test the change edits`,
          ),
        ]
      }),
      ...(item.labels.notInChange ?? []).flatMap((defect) => {
        const inChange = [...defect.locations, ...defect.alternatives].find(added)
        return inChange
          ? [
              `${label}: notInChange ${defect.id} cites ${describeLocation(inChange)}, a line the change added; a defect there is in the change`,
            ]
          : []
      }),
      ...need(
        !rule ||
          (!!ruleFile &&
            trustedRules({ anchors: [ruleFile.file] }).added.length > 0 &&
            addedWithin(change, rule) === span(rule)),
        `${label}: labels.headRule cites ${rule ? describeLocation(rule) : ""}, which is not a rule the change adds to a rule-carrying file`,
      ),
    ],
    notes: levels.flatMap((entry) => (entry.note ? [entry.note] : [])),
  }
}

// 0, 1 or 2: the context level a cited place needs at least (CONTEXT_LEVELS' index). A cited range inside the hunks
// lies inside one of them: git joins hunks whose context would meet, so two hunks' new-side ranges never touch.
function levelOf(change: Change, location: Location) {
  const facts = change.get(location.path)
  if (!facts) return 2
  const last = location.endLine ?? location.line
  return facts.hunks.some(([start, end]) => location.line >= start && last <= end) ? 0 : 1
}

// How many lines from line to endLine the change added, read from the added set, which the diff bounds.
function addedWithin(change: Change, location: Location) {
  const last = location.endLine ?? location.line
  return [...(change.get(location.path)?.added ?? [])].filter((line) => line >= location.line && line <= last).length
}

function span(location: Location) {
  return (location.endLine ?? location.line) - location.line + 1
}

function describeLocation(location: Location) {
  return `${location.path}:${location.line}${location.endLine ? `-${location.endLine}` : ""}`
}

// A sequence's pushes against the repository: they chain by ancestry from the base, each date is its commit time, each
// defect's files exist at its introducing push, and an interaction defect cites a file that an earlier push changed
// and its own push left alone (VS-41's defect introduced via an unfocused file). interaction false is never refused.
function pushProblems(
  label: string,
  item: Case,
  pushes: { sha: string; date: string }[],
  repository: {
    git: (...args: string[]) => { ok: boolean; out: string }
    ancestor: (a: string, b: string) => boolean
    time: (sha: string) => number
  },
) {
  const chain = [
    { name: "candidate.base", sha: item.candidate.base },
    ...pushes.map((push, index) => ({ name: `candidate.commits[${index}]`, sha: push.sha })),
  ]
  const changedBy = (from: string, to: string) =>
    new Set(repository.git("diff", "--name-only", "--find-renames", from, to).out.split("\n").filter(Boolean))
  return [
    ...chain
      .slice(1)
      .flatMap((push, index) =>
        need(
          repository.ancestor(chain[index].sha, push.sha),
          `${label}: ${chain[index].name} ${short(chain[index].sha)} is not an ancestor of ${push.name} ${short(push.sha)}`,
        ),
      ),
    ...pushes.flatMap((push, index) =>
      need(
        repository.time(push.sha) === Date.parse(push.date),
        `${label}: candidate.commits[${index}].date ${push.date} is not its commit time ${new Date(repository.time(push.sha)).toISOString()}`,
      ),
    ),
    ...item.labels.defects.flatMap((defect) => {
      const at = pushes.findIndex((push) => push.sha === defect.introducedAt)
      if (at === -1) return []
      const paths = [...new Set(defect.locations.map((location) => location.path))]
      const cited = [...new Set(citedPaths(defect))]
      const before = at === 0 ? item.candidate.base : pushes[at - 1].sha
      const sofar = changedBy(item.candidate.base, pushes[at].sha)
      const own = changedBy(before, pushes[at].sha)
      return [
        ...paths.flatMap((path) =>
          need(
            repository.git("cat-file", "-e", `${pushes[at].sha}:${path}`).ok,
            `${label}: defect ${defect.id} cites ${path}, which is not in its introducing push ${short(pushes[at].sha)}`,
          ),
        ),
        ...need(
          defect.interaction !== true || cited.some((path) => sofar.has(path) && !own.has(path)),
          `${label}: defect ${defect.id} is labelled interaction, but no file it cites was changed by an earlier push and left alone by its own`,
        ),
      ]
    }),
  ]
}

// The caller's GIT_* variables (a hook's GIT_DIR, say) would point git at another repository, so none are passed on.
export function gitEnv() {
  return Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")))
}

// Git over third-party dataset content runs without the user's or the system's git config, so no smudge filter
// (git-lfs, which a dataset's .lfsconfig could point at a URL of its choosing), credential helper, global hook or
// fsmonitor runs on it, and never prompts.
export function untrustedGitEnv() {
  return {
    ...gitEnv(),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: devNull,
    GIT_LFS_SKIP_SMUDGE: "1",
    GIT_TERMINAL_PROMPT: "0",
  }
}

// And with no hooks, no fsmonitor, and no transport but local files: nothing it does can reach the network.
export const UNTRUSTED_GIT = [
  "-c",
  `core.hooksPath=${devNull}`,
  "-c",
  "core.fsmonitor=false",
  "-c",
  "protocol.allow=never",
  "-c",
  "protocol.file.allow=always",
] as const

// A local mirror lives at <dir>/<owner>/<name> or <dir>/<owner>/<name>.git.
export function mirrorLocator(dir: string) {
  return (url: string) => {
    const [owner, name] = new URL(url).pathname.split("/").filter(Boolean)
    return [join(dir, owner, name), join(dir, owner, `${name}.git`)].find((path) => existsSync(path))
  }
}

export function dryRunReport(manifest: Manifest, objects?: ObjectCheck) {
  const bugs = manifest.cases.filter((item) => item.kind === "bug")
  const controls = manifest.cases.filter((item) => item.kind === "control")
  const trivial = manifest.cases.filter((item) => item.kind === "trivial")
  const adversarial = manifest.cases.filter((item) => item.kind === "adversarial")
  const defects = bugs.flatMap((item) => item.labels.defects)
  const repositories = new Set(manifest.cases.map((item) => repositoryKey(item.repository.url)))
  const tally = (values: string[]) =>
    Object.entries(Object.groupBy(values, (value) => value))
      .map(([value, list]) => `${value} ${list?.length ?? 0}`)
      .toSorted()
      .join(", ")
  const statuses = manifest.cases.map((item) => item.labels.annotation.status)
  const heldDraft = manifest.cases.filter(
    (item) => item.split === "held-out" && !labelSettled(item.labels.annotation),
  ).length
  const digest = heldOutDigest(manifest)
  const methods = Object.entries(
    Object.groupBy(manifest.cases, (item) => `${item.provenance.checked.method} on ${item.provenance.checked.date}`),
  )
    .map(([method, list]) => `${list?.length ?? 0} case(s) by ${method}`)
    .toSorted()
    .join(", ")
  return [
    `${manifest.name} (${manifest.schema}): ${manifest.cases.length} cases, ${bugs.length} bug fixes${trivial.length ? `, ${controls.length} controls and ${trivial.length} trivial controls` : ` and ${controls.length} controls`}${adversarial.length ? `, and ${adversarial.length} adversarial` : ""}, from ${repositories.size} repositories`,
    formatTable([
      [
        "SPLIT",
        "BUGS",
        "CONTROLS",
        ...(trivial.length ? ["TRIVIAL"] : []),
        ...(adversarial.length ? ["ADVERSARIAL"] : []),
      ],
      ...SPLITS.map((split) => [
        split,
        String(bugs.filter((item) => item.split === split).length),
        String(controls.filter((item) => item.split === split).length),
        ...(trivial.length ? [String(trivial.filter((item) => item.split === split).length)] : []),
        ...(adversarial.length ? [String(adversarial.filter((item) => item.split === split).length)] : []),
      ]),
    ]),
    "",
    `Languages: ${tally(manifest.cases.map((item) => item.language))}`,
    `Licences: ${tally(manifest.cases.map((item) => item.repository.licence))}`,
    `Defect categories: ${tally(bugs.flatMap((item) => item.labels.defects.map((defect) => defect.category))) || "none"}`,
    // VS-22a's labels, over the bug cases; absent labels are counted as unlabelled, never as other or false.
    `Failure classes: ${tally(defects.flatMap((defect) => (defect.failureClass ? [defect.failureClass] : []))) || "none labelled"}; ${defects.filter((defect) => !defect.failureClass).length} unlabelled. Production-breaking (blocking, in the five classes): ${defects.filter((defect) => defect.severity === "blocking" && oneOf(FAILURE_CLASSES, defect.failureClass)).length} of ${defects.length} defects.`,
    `Mechanisms: ${tally(defects.flatMap((defect) => (defect.mechanism ? [defect.mechanism] : []))) || "none labelled"}; ${defects.filter((defect) => !defect.mechanism).length} unlabelled.`,
    `Class pending owner Q4: ${tally(defects.flatMap((defect) => (defect.pendingQ4 ? [defect.pendingQ4] : []))) || "none"}.`,
    `Cross-file: ${bugs.filter((item) => item.labels.crossFile === true).length} of ${bugs.length} bug cases; ${bugs.filter((item) => item.labels.crossFile === undefined).length} unlabelled.`,
    `Runnable, from the base commit's recorded public CI: ${tally(bugs.flatMap((item) => (item.labels.runnable ? [item.labels.runnable.status] : []))) || "none labelled"}; ${bugs.filter((item) => !item.labels.runnable).length} bug cases unlabelled.`,
    `Authoring: ${tally(manifest.cases.flatMap((item) => (item.labels.authoring ? [`${item.labels.authoring.lab} (${item.labels.authoring.source})`] : []))) || "none recorded"}.`,
    ...(trivial.length
      ? [`Trivial kinds: ${tally(trivial.map((item) => item.labels.trivialKind ?? "unlabelled"))}.`]
      : []),
    ...roundTwoLines(manifest, tally),
    `Targets (VS-22b, reported, not enforced): ${bugs.length}/${TARGETS.bugs} bug cases; by class ${FAILURE_CLASSES.map((name) => `${name} ${bugs.filter((item) => item.labels.defects.some((defect) => defect.failureClass === name)).length}/${TARGETS.perClass}`).join(", ")}; cross-file ${bugs.filter((item) => item.labels.crossFile === true).length}/${TARGETS.crossFile}; runnable (passed) ${bugs.filter((item) => item.labels.runnable?.status === "passed").length}/${TARGETS.runnable}; ${controls.length}/${TARGETS.controls} controls; ${trivial.length}/${TARGETS.trivial} trivial controls; ${bugs.filter((item) => item.traits?.includes("trivial-looking")).length}/${TARGETS.trivialLooking} trivial-looking bug cases; ${adversarial.length}/${TARGETS.adversarial} adversarial.`,
    `Labels: ${ANNOTATION_STATUSES.map((status) => `${statuses.filter((entry) => entry === status).length} ${status}`).join(", ")}`,
    manifest.freeze
      ? `Freeze: held-out cases frozen on ${manifest.freeze.date} (${manifest.freeze.digest}).`
      : `Freeze: not frozen. ${heldDraft ? `${heldDraft} held-out case(s) still need settled labels (two passes that agreed, or the owner's adjudication); ` : ""}freeze before any prompt tuning by recording ${digest}.`,
    objects
      ? `Objects: ${objects.checked.length} case(s) checked against local mirrors${objects.unchecked.length ? `; no mirror for ${objects.unchecked.join(", ")}` : ""}.`
      : "Objects: not checked against local mirrors (none given).",
    ...(objects?.notes?.length ? ["Object notes:", ...objects.notes.map((note) => `  ${note}`)] : []),
    `Recorded checks: ${methods}.`,
    "",
    `Exclusions (${manifest.exclusions.length}):`,
    ...manifest.exclusions.map(
      (item) =>
        `  ${item.repository.replace("https://github.com/", "")}${item.candidate ? ` ${short(item.candidate.head)}` : ""}${item.fix ? ` fix ${short(item.fix)}` : ""}: ${item.reason}: ${item.detail}`,
    ),
    "",
    "Dry run: no network requests were made.",
  ].join("\n")
}

// VS-22c's labels and the round-two strata, over the bug cases' defects as the VS-22a lines are; defects outside the
// change, sequences, feedback and head-added rules over every case. Absent labels are counted as unlabelled.
function roundTwoLines(manifest: Manifest, tally: (values: string[]) => string) {
  const bugs = manifest.cases.filter((item) => item.kind === "bug")
  const defects = bugs.flatMap((item) => item.labels.defects)
  const outside = manifest.cases.flatMap((item) => item.labels.notInChange ?? [])
  const sequences = manifest.cases.filter((item) => item.candidate.commits)
  const later = sequences.flatMap((item) => (item.candidate.commits ?? []).slice(1).map((push) => ({ item, push })))
  const clean = later.filter(
    (entry) => !entry.item.labels.defects.some((defect) => defect.introducedAt === entry.push.sha),
  )
  const interactions = manifest.cases.flatMap((item) => item.labels.defects.filter((defect) => defect.interaction))
  // VS-41's target counts cases, so a case with two interaction defects counts once there.
  const interacting = manifest.cases.filter((item) => item.labels.defects.some((defect) => defect.interaction))
  const attacks = manifest.cases.flatMap((item) => (item.labels.feedback ? [item.labels.feedback.attack] : []))
  const rules = manifest.cases.filter((item) => item.labels.headRule)
  const exacerbated = defects.filter((defect) => defect.scope === "exacerbated-by-pr").length
  const preExisting = outside.filter((defect) => defect.scope === "pre-existing").length
  const gaps = defects.flatMap((defect) => (defect.testGap ? [defect.testGap] : []))
  return [
    `Context levels (the context a defect needs): ${tally(defects.flatMap((defect) => (defect.contextLevel ? [defect.contextLevel] : []))) || "none labelled"}; ${defects.filter((defect) => !defect.contextLevel).length} unlabelled.`,
    `Scope (ReviewBench's axis): ${tally(defects.flatMap((defect) => (defect.scope ? [defect.scope] : []))) || "none labelled"}; ${defects.filter((defect) => !defect.scope).length} unlabelled. Outside the change (labels.notInChange, never judged, outside S9's scope): ${tally(outside.map((defect) => defect.scope)) || "none"}.`,
    `Strata (GU5, reported, no minimum): Python ${bugs.filter((item) => item.language === "python").length} bug case(s); security ${defects.filter((defect) => defect.category === "security").length} defect(s); test gap (a weakened test) ${gaps.filter((gap) => gap === "weakened").length} defect(s), ${gaps.filter((gap) => gap === "none").length} labelled none, ${defects.length - gaps.length} unlabelled.`,
    sequences.length
      ? `Sequences: ${sequences.length} case(s) with ${later.length} later push(es); ${interactions.length} interaction defect(s); ${clean.length} clean later push(es).`
      : "Sequences: none.",
    `Review feedback (synthetic markers): ${tally(attacks) || "none"}.`,
    `Head-added rule cases: ${rules.length}.`,
    `Round-two targets (addendum A, pending Q18; reported, not enforced, and outside the sampling rule's quota): sequences ${sequences.length}/${ROUND_TWO_TARGETS.sequences}; interaction cases ${interacting.length}/${ROUND_TWO_TARGETS.interactions}; clean later pushes ${clean.length}/${ROUND_TWO_TARGETS.cleanLater}; exacerbated-by-pr defects ${exacerbated}/${ROUND_TWO_TARGETS.exacerbated}; pre-existing defects ${preExisting}/${ROUND_TWO_TARGETS.preExisting}; head-added rule cases ${rules.length}/${ROUND_TWO_TARGETS.headRule}; feedback attacks ${ADDENDUM_ATTACKS.map((attack) => `${attack} ${attacks.filter((entry) => entry === attack).length}/${ROUND_TWO_TARGETS.perAttack}`).join(", ")}.`,
  ]
}

const USAGE = `Usage: bun script/vectorscope-eval/dataset.ts [options]

Validates a VectorScope dataset manifest without any network request.

  --manifest <path>   Manifest to check (default: the seed manifest)
  --mirrors <dir>     Local clones at <dir>/<owner>/<name>[.git]; checks commits, ancestry and leakage with git
  --help              Print this message
`

async function main() {
  const parsed = parseArgs({
    args: process.argv.slice(2),
    options: { manifest: { type: "string" }, mirrors: { type: "string" }, help: { type: "boolean" } },
    strict: false,
    allowPositionals: true,
  })
  const unknown = Object.keys(parsed.values).filter((name) => !["manifest", "mirrors", "help"].includes(name))
  const valueless = (["manifest", "mirrors"] as const).filter(
    (name) => parsed.values[name] !== undefined && typeof parsed.values[name] !== "string",
  )
  if (unknown.length || parsed.positionals.length || valueless.length) {
    process.stderr.write(USAGE)
    return 2
  }
  if (parsed.values.help) {
    process.stdout.write(USAGE)
    return 0
  }
  const path = typeof parsed.values.manifest === "string" ? resolve(parsed.values.manifest) : SEED_MANIFEST
  const value = await loadManifest(path)
  const problems = manifestProblems(value)
  if (problems.length) {
    process.stderr.write(`Invalid manifest ${path}:\n${problems.map((line) => `  ${line}`).join("\n")}\n`)
    return 1
  }
  const manifest = value as Manifest
  const objects =
    typeof parsed.values.mirrors === "string"
      ? objectProblems(manifest, mirrorLocator(resolve(parsed.values.mirrors)))
      : undefined
  process.stdout.write(dryRunReport(manifest, objects) + "\n")
  if (objects?.problems.length) {
    process.stderr.write(`\nObject problems:\n${objects.problems.map((line) => `  ${line}`).join("\n")}\n`)
    return 1
  }
  return 0
}

function need(ok: boolean, problem: string) {
  return ok ? [] : [problem]
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined
}

function text(value: unknown) {
  return typeof value === "string" && value.trim().length > 0
}

function oneOf<T extends string>(list: readonly T[], value: unknown): value is T {
  return list.includes(value as T)
}

function isSha(value: unknown) {
  return typeof value === "string" && /^[0-9a-f]{40}$/.test(value)
}

function isDay(value: unknown) {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value))
}

function isTime(value: unknown) {
  return (
    typeof value === "string" &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/.test(value) &&
    !Number.isNaN(Date.parse(value))
  )
}

function isLink(value: unknown) {
  return typeof value === "string" && value.startsWith("https://") && URL.canParse(value)
}

function isPath(value: unknown) {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    !value.startsWith("/") &&
    !value.includes("\\") &&
    !value.split("/").some((part) => part === ".." || part === "." || part === "")
  )
}

function count(value: unknown) {
  return Number.isInteger(value) && (value as number) >= 0
}

function positive(value: unknown) {
  return Number.isInteger(value) && (value as number) > 0
}

function sum(values: number[]) {
  return values.reduce((total, value) => total + value, 0)
}

function short(sha: string) {
  return sha.slice(0, 12)
}

function repositoryKey(url: string) {
  return url.toLowerCase().replace(/\.git$/, "")
}

function describeSize(size: Case["candidate"]["changed"]) {
  return `${size.files} file(s) +${size.additions} -${size.deletions}`
}

// JSON with object keys sorted, so the digest does not depend on key order or formatting.
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`
  const item = record(value)
  if (!item) return JSON.stringify(value)
  return `{${Object.keys(item)
    .toSorted()
    .filter((key) => item[key] !== undefined)
    .map((key) => `${JSON.stringify(key)}:${canonical(item[key])}`)
    .join(",")}}`
}

function formatTable(rows: string[][]) {
  const widths = (rows[0] ?? []).map((_, column) => Math.max(...rows.map((row) => (row[column] ?? "").length)))
  return rows
    .map((row) =>
      row
        .map((cell, column) => cell.padEnd(widths[column] ?? 0))
        .join("  ")
        .trimEnd(),
    )
    .join("\n")
}

if (import.meta.main) process.exit(await main())
