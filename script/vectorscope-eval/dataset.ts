#!/usr/bin/env bun
import { createHash } from "node:crypto"
import { existsSync } from "node:fs"
import { devNull } from "node:os"
import { join, resolve } from "node:path"
import { parseArgs } from "node:util"
import { FAILURE_CLASSES, FAILURE_MECHANISMS } from "../../packages/core/src/review/types"

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
// each pass's own labels, and retires the cross-file trait for labels.crossFile.
export const SCHEMA = "vectorscope-dataset/2"

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
}

export interface Annotation {
  status: (typeof ANNOTATION_STATUSES)[number]
  // A pass's labels record the VS-22a labels it gave, by the case's own defect ids (a defect it did not label is left
  // out), so the two passes can be compared after the case's labels settle (Cohen's kappa on failureClass, VS-22b).
  passes: {
    pass: number
    method: string
    date: string
    labels?: { defects: Pick<Defect, "id" | "failureClass" | "mechanism" | "pendingQ4">[]; crossFile?: boolean }
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
  }
  fix?: { sha: string; date: string; change?: string }
  labels: {
    defects: Defect[]
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

// Everything a reviewer under test may be given for a case: the repository and the candidate's two commits. The
// labels, the fix, dates, provenance, the split and even the case id stay out, so a prompt or tool view built from it
// cannot leak them.
export interface CaseView {
  repository: string
  base: string
  head: string
}

export function caseView(item: Case): CaseView {
  return { repository: item.repository.url, base: item.candidate.base, head: item.candidate.head }
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
function sourceFilesOf(defect: Record<string, unknown> | undefined, tests: unknown) {
  const cited = [
    ...(Array.isArray(defect?.locations) ? defect.locations : []),
    ...(Array.isArray(defect?.alternatives) ? defect.alternatives : []),
  ]
  return new Set(
    cited
      .map((location) => record(location)?.path)
      .filter(
        (path) => typeof path === "string" && !(Array.isArray(tests) && tests.includes(path)) && !TEST_PATH.test(path),
      ),
  )
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

// VS-22a's labels of one defect, on the case or in one pass's own record. Each is optional: absent means not yet
// labelled.
function classProblems(label: string, defect: Record<string, unknown>) {
  return [
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
    ...need(
      new Set(recordedNumbers).size === recordedNumbers.length,
      `${label}: a pass records its own labels in more than one entry`,
    ),
    ...need(
      recorded.length === 0 || annotation.status === "draft" || new Set(recordedNumbers).size >= 2,
      `${label}: a ${String(annotation.status)} label whose passes record their own labels needs two passes that do`,
    ),
    ...need(
      annotation.agreed !== true || recorded.every((pass) => agrees(record(pass?.labels), labels)),
      `${label}: agreed is true, but a pass's own labels differ from the case's labels`,
    ),
  ]
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
}

// Checks each case against a local clone of its repository, read-only. `locate` maps a repository URL to a local
// directory, or undefined when there is none; nothing is fetched.
export function objectProblems(manifest: Pick<Manifest, "cases">, locate: (url: string) => string | undefined) {
  const entries = manifest.cases.map((item) => ({ item, dir: locate(item.repository.url) }))
  return {
    checked: entries.filter((entry) => entry.dir).map((entry) => entry.item.id),
    unchecked: entries.filter((entry) => !entry.dir).map((entry) => entry.item.id),
    problems: entries.flatMap((entry) => (entry.dir ? caseObjectProblems(entry.item, entry.dir) : [])),
  } satisfies ObjectCheck
}

function caseObjectProblems(item: Case, dir: string): string[] {
  const label = `case ${item.id}`
  const git = (...args: string[]) => {
    const result = Bun.spawnSync(["git", ...UNTRUSTED_GIT, "-C", dir, ...args], {
      env: untrustedGitEnv(),
      stdout: "pipe",
      stderr: "pipe",
    })
    return { ok: result.exitCode === 0, out: result.stdout.toString() }
  }
  const commits = [
    { name: "candidate.base", sha: item.candidate.base },
    { name: "candidate.head", sha: item.candidate.head },
    ...(item.fix ? [{ name: "fix.sha", sha: item.fix.sha }] : []),
  ]
  const missing = commits.filter((commit) => git("cat-file", "-t", commit.sha).out.trim() !== "commit")
  if (missing.length) return missing.map((commit) => `${label}: ${commit.name} ${commit.sha} is not a commit in ${dir}`)

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
  const locations = item.labels.defects.flatMap((defect) =>
    [...defect.locations, ...defect.alternatives].map((location) => ({ defect: defect.id, location })),
  )
  return [
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
        return [`${label}: defect ${entry.defect} cites ${entry.location.path}, which is not in the candidate head`]
      const total = shown.out.replace(/\n$/, "").split("\n").length
      const last = entry.location.endLine ?? entry.location.line
      return need(
        last <= total,
        `${label}: defect ${entry.defect} cites ${entry.location.path}:${entry.location.line}${entry.location.endLine ? `-${entry.location.endLine}` : ""}, past the end of the file (${total} lines)`,
      )
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
    `Targets (VS-22b, reported, not enforced): ${bugs.length}/${TARGETS.bugs} bug cases; by class ${FAILURE_CLASSES.map((name) => `${name} ${bugs.filter((item) => item.labels.defects.some((defect) => defect.failureClass === name)).length}/${TARGETS.perClass}`).join(", ")}; cross-file ${bugs.filter((item) => item.labels.crossFile === true).length}/${TARGETS.crossFile}; runnable (passed) ${bugs.filter((item) => item.labels.runnable?.status === "passed").length}/${TARGETS.runnable}; ${controls.length}/${TARGETS.controls} controls; ${trivial.length}/${TARGETS.trivial} trivial controls; ${bugs.filter((item) => item.traits?.includes("trivial-looking")).length}/${TARGETS.trivialLooking} trivial-looking bug cases; ${adversarial.length}/${TARGETS.adversarial} adversarial.`,
    `Labels: ${ANNOTATION_STATUSES.map((status) => `${statuses.filter((entry) => entry === status).length} ${status}`).join(", ")}`,
    manifest.freeze
      ? `Freeze: held-out cases frozen on ${manifest.freeze.date} (${manifest.freeze.digest}).`
      : `Freeze: not frozen. ${heldDraft ? `${heldDraft} held-out case(s) still need settled labels (two passes that agreed, or the owner's adjudication); ` : ""}freeze before any prompt tuning by recording ${digest}.`,
    objects
      ? `Objects: ${objects.checked.length} case(s) checked against local mirrors${objects.unchecked.length ? `; no mirror for ${objects.unchecked.join(", ")}` : ""}.`
      : "Objects: not checked against local mirrors (none given).",
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
