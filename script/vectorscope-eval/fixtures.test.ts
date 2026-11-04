import { afterAll, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { parseUnifiedDiff } from "../../packages/core/src/review/diff"
import { buildReviewPrompt } from "../../packages/core/src/review/prompt"
import {
  assignSplits,
  caseView,
  dryRunReport,
  gitEnv,
  heldOutDigest,
  LICENCES,
  loadManifest,
  manifestProblems,
  mirrorLocator,
  objectProblems,
  type Case,
  type Manifest,
} from "./dataset"
import { fixtureProblems, fixtureView, listFixtures, loadFixture, promptInput, type Fixture } from "./fixture"

const names = await listFixtures()
const fixtures = await Promise.all(names.map(loadFixture))

describe("every fixture", () => {
  for (const fixture of fixtures)
    test(fixture.name, () => {
      expect(fixtureProblems(fixture)).toEqual([])
    })
})

describe("the fixture set", () => {
  test("has eight fixtures with one planted bug each and two clean ones", () => {
    expect(fixtures).toHaveLength(10)
    expect(fixtures.filter((fixture) => fixture.expected.length === 1)).toHaveLength(8)
    expect(fixtures.filter((fixture) => fixture.expected.length === 0)).toHaveLength(2)
  })

  test("planted bug ids are unique across fixtures", () => {
    const ids = fixtures.flatMap((fixture) => fixture.expected.map((expectation) => expectation.id))
    expect(new Set(ids).size).toBe(ids.length)
  })

  test("each fixture changes one to three files and 30 to 150 lines", () => {
    for (const fixture of fixtures) {
      const changed = fixture.files.reduce((sum, file) => sum + file.additions + file.deletions, 0)
      expect({ name: fixture.name, files: fixture.files.length >= 1 && fixture.files.length <= 3 }).toEqual({
        name: fixture.name,
        files: true,
      })
      expect({ name: fixture.name, changed: changed >= 30 && changed <= 150 }).toEqual({
        name: fixture.name,
        changed: true,
      })
    }
  })
})

describe("fixtureProblems", () => {
  const sample = fixtures.find((fixture) => fixture.name === "audit-log-pagination")!

  function withDiff(fixture: Fixture, diff: string): Fixture {
    return { ...fixture, diff, files: parseUnifiedDiff(diff) }
  }

  test("flags a hunk header whose counts are wrong", () => {
    const short = withDiff(sample, sample.diff.replace("@@ -14,11 +14,45 @@", "@@ -14,11 +14,40 @@"))
    expect(fixtureProblems(short).join("\n")).toContain("outside any hunk")
    const long = withDiff(sample, sample.diff.replace("@@ -14,11 +14,45 @@", "@@ -14,11 +14,47 @@"))
    expect(fixtureProblems(long).join("\n")).toContain("does not match its line counts")
  })

  test("flags a head copy that is not the post-image of the diff", () => {
    const edited = {
      ...sample,
      headFiles: sample.headFiles.map((file) => ({ ...file, text: file.text.replace("page * size", "page*size") })),
    }
    expect(fixtureProblems(edited)).toContain("head/src/admin/audit-log.ts is not the post-image of the diff")
    const shifted = {
      ...sample,
      headFiles: sample.headFiles.map((file) => ({ ...file, text: "// moved down a line\n" + file.text })),
    }
    expect(fixtureProblems(shifted)).toContain("head/src/admin/routes.ts is not the post-image of the diff")
  })

  test("flags missing and extra head copies", () => {
    const missing = { ...sample, headFiles: sample.headFiles.slice(1) }
    expect(fixtureProblems(missing)).toContain(`head/${sample.headFiles[0].path} is missing`)
    const extra = { ...sample, headFiles: [...sample.headFiles, { path: "src/other.ts", text: "export {}\n" }] }
    expect(fixtureProblems(extra)).toContain("head/src/other.ts is not changed by the diff")
  })

  test("flags an expectation that is not on an added line", () => {
    const planted = sample.expected[0]
    const context = { ...sample, expected: [{ ...planted, line: 1 }] }
    expect(fixtureProblems(context)).toContain(
      `expectation ${planted.id}: line 1 is not an added line of ${planted.path}`,
    )
    const elsewhere = { ...sample, expected: [{ ...planted, path: "src/admin/missing.ts" }] }
    expect(fixtureProblems(elsewhere).join("\n")).toContain("which the diff does not add or change")
    const backwards = { ...sample, expected: [{ ...planted, endLine: planted.line - 1 }] }
    expect(fixtureProblems(backwards).join("\n")).toContain(`endLine ${planted.line - 1}`)
  })
})

describe("the fixture prompt", () => {
  test("is the untrusted full review the runner has always sent", () => {
    const input = promptInput(fixtureView(fixtures[0]))
    expect({ mode: input.mode, trust: input.trust, maxComments: input.maxComments }).toEqual({
      mode: "full",
      trust: "untrusted",
      maxComments: 25,
    })
  })

  test("never contains a planted bug's label", () => {
    for (const fixture of fixtures) {
      const prompt = buildReviewPrompt(promptInput(fixtureView(fixture)))
      for (const expectation of fixture.expected) {
        expect({ fixture: fixture.name, leaked: prompt.includes(expectation.description) }).toEqual({
          fixture: fixture.name,
          leaked: false,
        })
        expect({ fixture: fixture.name, leaked: prompt.includes(expectation.id) }).toEqual({
          fixture: fixture.name,
          leaked: false,
        })
      }
    }
  })
})

// A local repository with a known history stands in for a public one, so the object checks run without a network:
//
//   main:  A ── B ── C ── D ── M ── R      B introduces the bug; M merges the fix; R reverts it
//                     └── F ──┘           F is the fix itself, on a topic branch
//   side:  A ── S                          S never reaches the fix
const repository = buildRepository()
afterAll(() => rmSync(repository.dir, { recursive: true, force: true }))

function buildRepository() {
  const dir = mkdtempSync(join(tmpdir(), "vectorscope-dataset-"))
  const env = {
    ...gitEnv(),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_AUTHOR_NAME: "Fixture",
    GIT_AUTHOR_EMAIL: "fixture@example.invalid",
    GIT_COMMITTER_NAME: "Fixture",
    GIT_COMMITTER_EMAIL: "fixture@example.invalid",
  }
  const git = (args: string[], date?: string) => {
    const stamp = date ? `@${Date.parse(date) / 1000} +0000` : undefined
    const result = Bun.spawnSync(["git", "-C", dir, ...args], {
      env: stamp ? { ...env, GIT_AUTHOR_DATE: stamp, GIT_COMMITTER_DATE: stamp } : env,
      stdout: "pipe",
      stderr: "pipe",
    })
    if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr.toString()}`)
    return result.stdout.toString().trim()
  }
  const commit = (message: string, date: string, files: Record<string, string>) => {
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(dirname(join(dir, path)), { recursive: true })
      writeFileSync(join(dir, path), text)
    }
    git(["add", "--all"])
    git(["commit", "--quiet", "-m", message], date)
    return git(["rev-parse", "HEAD"])
  }
  const clean = "def total(items):\n    return sum(item.price for item in items)\n"
  const buggy = "def total(items):\n    return sum(item.price for item in items[1:])\n"
  const fixed =
    "def total(items):\n    # every item counts, the first one too\n    return sum(item.price for item in items)\n"
  git(["init", "--quiet", "--initial-branch=main"])
  const A = commit("base", "2024-01-01T00:00:00Z", { "app.py": clean, README: "fixture\n" })
  const B = commit("candidate", "2024-01-02T00:00:00Z", { "app.py": buggy })
  const C = commit("unrelated", "2024-01-03T00:00:00Z", { README: "fixture repository\n" })
  git(["checkout", "--quiet", "-b", "topic"])
  const F = commit("fix", "2024-01-04T00:00:00Z", { "app.py": fixed, "test_app.py": "def test_total():\n    pass\n" })
  git(["checkout", "--quiet", "main"])
  const D = commit("docs", "2024-01-05T00:00:00Z", { "docs.txt": "docs\n" })
  git(["merge", "--quiet", "--no-ff", "--no-edit", "-m", "merge the fix", "topic"], "2024-01-06T00:00:00Z")
  const M = git(["rev-parse", "HEAD"])
  const R = commit("revert the fix", "2024-01-08T00:00:00Z", { "app.py": buggy })
  git(["checkout", "--quiet", "-b", "side", A])
  const S = commit("side", "2024-01-07T00:00:00Z", { "other.py": "x = 1\n" })
  git(["checkout", "--quiet", "main"])
  return { dir, A, B, C, D, F, M, R, S }
}

const draft = { status: "draft" as const, passes: [{ pass: 1, method: "model-assisted", date: "2026-11-03" }] }
const adjudicated = {
  status: "adjudicated" as const,
  passes: [
    { pass: 1, method: "model-assisted", date: "2026-11-03" },
    { pass: 2, method: "model-assisted", date: "2026-11-03" },
  ],
  adjudication: { by: "owner", date: "2026-11-04" },
}
const provenance = {
  found: "a local fixture repository",
  evidence: "the fixture's history",
  checked: {
    date: "2026-11-03",
    method: "local-git" as const,
    commits: true as const,
    ancestry: true as const,
    licence: true as const,
  },
}

const valid: Case = {
  id: "fixture-1",
  kind: "bug",
  split: "development",
  repository: { url: "https://github.com/example/fixture", licence: "MIT" },
  language: "python",
  candidate: {
    base: repository.A,
    head: repository.B,
    date: "2024-01-02T00:00:00Z",
    changed: { files: 1, additions: 1, deletions: 1 },
  },
  fix: { sha: repository.M, date: "2024-01-06T00:00:00Z" },
  labels: {
    defects: [
      {
        id: "skips-first-item",
        category: "correctness",
        severity: "blocking",
        summary: "total leaves out the first item.",
        cause: "items[1:] drops the first element, so its price is never added.",
        locations: [{ path: "app.py", line: 2 }],
        alternatives: [],
      },
    ],
    regressionTest: { status: "added-by-fix", paths: ["test_app.py"] },
    annotation: draft,
  },
  provenance,
}

function checkObjects(...cases: Case[]) {
  return objectProblems({ cases }, (url) => (url === valid.repository.url ? repository.dir : undefined))
}

function withCandidate(base: string, head: string, date: string): Case {
  return { ...valid, candidate: { ...valid.candidate, base, head, date } }
}

describe("dataset object checks against a local repository", () => {
  test("a well-formed case passes", () => {
    expect(checkObjects(valid)).toEqual({ checked: ["fixture-1"], unchecked: [], problems: [] })
  })

  test("a case with no local mirror is left unchecked, not failed", () => {
    const elsewhere = { ...valid, repository: { ...valid.repository, url: "https://github.com/example/other" } }
    expect(checkObjects(elsewhere)).toEqual({ checked: [], unchecked: ["fixture-1"], problems: [] })
  })

  test("mirrors are found at <dir>/<owner>/<name> or <name>.git", () => {
    const mirrors = mkdtempSync(join(tmpdir(), "vectorscope-mirrors-"))
    try {
      mkdirSync(join(mirrors, "example", "fixture"), { recursive: true })
      mkdirSync(join(mirrors, "example", "bare.git"), { recursive: true })
      const locate = mirrorLocator(mirrors)
      expect(locate("https://github.com/example/fixture")).toBe(join(mirrors, "example", "fixture"))
      expect(locate("https://github.com/example/bare")).toBe(join(mirrors, "example", "bare.git"))
      expect(locate("https://github.com/example/missing")).toBeUndefined()
    } finally {
      rmSync(mirrors, { recursive: true, force: true })
    }
  })

  test("flags missing objects", () => {
    const head = "f".repeat(40)
    expect(checkObjects(withCandidate(repository.A, head, valid.candidate.date)).problems).toEqual([
      `case fixture-1: candidate.head ${head} is not a commit in ${repository.dir}`,
    ])
    const fix = "e".repeat(40)
    expect(checkObjects({ ...valid, fix: { ...valid.fix!, sha: fix } }).problems).toEqual([
      `case fixture-1: fix.sha ${fix} is not a commit in ${repository.dir}`,
    ])
  })

  test("flags a base that is not an ancestor of the head", () => {
    const swapped = withCandidate(repository.B, repository.A, "2024-01-01T00:00:00Z")
    expect(checkObjects(swapped).problems.join("\n")).toContain(
      `candidate.base ${repository.B.slice(0, 12)} is not an ancestor of candidate.head ${repository.A.slice(0, 12)}`,
    )
  })

  test("flags a candidate the fix does not descend from", () => {
    const side = withCandidate(repository.A, repository.S, "2024-01-07T00:00:00Z")
    expect(checkObjects(side).problems.join("\n")).toContain(
      `candidate.head ${repository.S.slice(0, 12)} is not an ancestor of the fix ${repository.M.slice(0, 12)}`,
    )
  })

  test("flags a candidate head that already holds the fix", () => {
    // The fix's own branch head: a reviewer shown it would see the corrected code.
    const branch = withCandidate(repository.C, repository.F, "2024-01-04T00:00:00Z")
    const problems = checkObjects(branch).problems
    expect(problems).toContain(
      "case fixture-1: the candidate head already has the fix's version of app.py, test_app.py (post-fix leakage)",
    )
    expect(problems.join("\n")).not.toContain("is not an ancestor")
  })

  test("flags a manufactured reverse diff, where the fix is already in the candidate's history", () => {
    const reverted = withCandidate(repository.M, repository.R, "2024-01-08T00:00:00Z")
    const problems = checkObjects(reverted).problems.join("\n")
    expect(problems).toContain(`the fix ${repository.M.slice(0, 12)} is already in the candidate's history`)
    expect(problems).toContain(`is not an ancestor of the fix`)
  })

  test("flags dates, sizes and label locations that disagree with the repository", () => {
    const dated = { ...valid, candidate: { ...valid.candidate, date: "2024-01-02T00:00:01Z" } }
    expect(checkObjects(dated).problems.join("\n")).toContain(
      "candidate.date 2024-01-02T00:00:01Z is not the head's commit time",
    )
    const fixDated = { ...valid, fix: { ...valid.fix!, date: "2024-01-07T00:00:00Z" } }
    expect(checkObjects(fixDated).problems.join("\n")).toContain(
      "fix.date 2024-01-07T00:00:00Z is not the fix's commit time",
    )
    const sized = { ...valid, candidate: { ...valid.candidate, changed: { files: 2, additions: 1, deletions: 1 } } }
    expect(checkObjects(sized).problems).toContain(
      "case fixture-1: candidate.changed records 2 file(s) +1 -1 but git reports 1 file(s) +1 -1",
    )
    const defect = valid.labels.defects[0]
    const past = {
      ...valid,
      labels: { ...valid.labels, defects: [{ ...defect, alternatives: [{ path: "app.py", line: 2, endLine: 9 }] }] },
    }
    expect(checkObjects(past).problems).toContain(
      "case fixture-1: defect skips-first-item cites app.py:2-9, past the end of the file (2 lines)",
    )
    const absent = {
      ...valid,
      labels: { ...valid.labels, defects: [{ ...defect, locations: [{ path: "test_app.py", line: 1 }] }] },
    }
    expect(checkObjects(absent).problems).toContain(
      "case fixture-1: defect skips-first-item cites test_app.py, which is not in the candidate head",
    )
  })

  test("the view a reviewer is given holds no label, fix, date, provenance or split", () => {
    const view = caseView(valid)
    expect(view).toEqual({ repository: valid.repository.url, base: valid.candidate.base, head: valid.candidate.head })
    const shown = JSON.stringify(view)
    const hidden = [
      valid.id,
      valid.split,
      valid.fix!.sha,
      valid.fix!.date,
      valid.candidate.date,
      ...strings(valid.labels),
      ...strings(valid.provenance),
    ]
    expect(hidden.filter((value) => shown.includes(value))).toEqual([])
  })
})

function strings(value: unknown): string[] {
  if (typeof value === "string") return [value]
  if (Array.isArray(value)) return value.flatMap(strings)
  if (value && typeof value === "object") return Object.values(value).flatMap(strings)
  return []
}

function sha(n: number) {
  return n.toString(16).padStart(40, "0")
}

// A schema-valid case with made-up commits, for checks that need no repository.
function synthetic(
  index: number,
  options: { kind?: "bug" | "control"; repository?: string; family?: string; year?: number } = {},
): Case {
  const kind = options.kind ?? "bug"
  const date = `${options.year ?? 2010 + index}-01-01T00:00:00Z`
  const offset = kind === "bug" ? 0 : 500
  return {
    id: `${kind}-${index}`,
    kind,
    split: "development",
    ...(options.family ? { family: options.family } : {}),
    repository: { url: options.repository ?? `https://github.com/example/${kind}-${index}`, licence: "MIT" },
    language: "typescript",
    candidate: {
      base: sha(2 * (index + offset) + 1),
      head: sha(2 * (index + offset) + 2),
      date,
      changed: { files: 1, additions: 3, deletions: 1 },
    },
    ...(kind === "bug"
      ? { fix: { sha: sha(5000 + index), date: `${options.year ?? 2010 + index}-06-01T00:00:00Z` } }
      : {}),
    labels:
      kind === "bug"
        ? {
            defects: [
              {
                id: "defect",
                category: "correctness",
                severity: "concern",
                summary: `defect ${index}`,
                cause: `cause ${index}`,
                locations: [{ path: "src/index.ts", line: 3 }],
                alternatives: [],
              },
            ],
            regressionTest: { status: "none" },
            annotation: adjudicated,
          }
        : { defects: [], rationale: `rename ${index}`, annotation: adjudicated },
    provenance,
  }
}

function manifestOf(cases: Case[], extra: Partial<Manifest> = {}): Manifest {
  const splits = assignSplits(cases)
  return {
    schema: "vectorscope-dataset/1",
    name: "fixture",
    description: "A synthetic manifest.",
    created: "2026-11-03",
    selection: { method: "synthetic", rule: "made up for a test", queries: [], date: "2026-11-03" },
    contamination: "None: the commits are made up.",
    cases: cases.map((item) => ({ ...item, split: splits.get(item.id)! })),
    exclusions: [],
    ...extra,
  }
}

describe("dataset splits", () => {
  test("ten unrelated bug cases split 6/2/2, oldest fixes first and the newest held out", () => {
    const splits = assignSplits(Array.from({ length: 10 }, (_, index) => synthetic(index)))
    expect(Array.from({ length: 10 }, (_, index) => splits.get(`bug-${index}`))).toEqual([
      ...Array(6).fill("development"),
      "calibration",
      "calibration",
      "held-out",
      "held-out",
    ])
  })

  test("cases that share a family land in one split, even across repositories and years", () => {
    const cases = [
      ...Array.from({ length: 8 }, (_, index) => synthetic(index)),
      synthetic(8, { family: "shared-root-cause", year: 2001 }),
      synthetic(9, { family: "shared-root-cause" }),
    ]
    const splits = assignSplits(cases)
    expect(splits.get("bug-8")).toBe(splits.get("bug-9"))
    expect(splits.get("bug-8")).toBe("held-out")
  })

  test("cases from one repository land in one split", () => {
    const cases = [
      ...Array.from({ length: 8 }, (_, index) => synthetic(index)),
      synthetic(8, { repository: "https://github.com/example/bug-0", year: 2030 }),
    ]
    const splits = assignSplits(cases)
    expect(splits.get("bug-0")).toBe(splits.get("bug-8"))
  })

  test("a manifest that records one family across two splits is rejected", () => {
    const cases = [
      ...Array.from({ length: 8 }, (_, index) => synthetic(index)),
      synthetic(8, { family: "shared-root-cause", year: 2001 }),
      synthetic(9, { family: "shared-root-cause" }),
    ]
    const manifest = manifestOf(cases)
    expect(manifestProblems(manifest)).toEqual([])
    const split = {
      ...manifest,
      cases: manifest.cases.map((item) => (item.id === "bug-8" ? { ...item, split: "development" as const } : item)),
    }
    expect(manifestProblems(split)).toEqual([
      "case bug-8 is recorded in development but the split rule puts it in held-out",
    ])
  })

  test("controls are split on their own and do not move bug cases", () => {
    const bugs = Array.from({ length: 10 }, (_, index) => synthetic(index))
    const controls = Array.from({ length: 5 }, (_, index) => synthetic(index, { kind: "control" }))
    const alone = assignSplits(bugs)
    const together = assignSplits([...bugs, ...controls])
    expect(bugs.map((item) => together.get(item.id))).toEqual(bugs.map((item) => alone.get(item.id)))
    expect(controls.map((item) => together.get(item.id))).toEqual([
      "development",
      "development",
      "development",
      "calibration",
      "held-out",
    ])
  })
})

describe("dataset manifest validation", () => {
  test("rejects a licence outside MIT, Apache-2.0 and BSD", () => {
    const gpl = { ...synthetic(0), repository: { url: "https://github.com/example/gpl", licence: "GPL-3.0" } }
    expect(manifestProblems(manifestOf([gpl as unknown as Case]))).toEqual([
      `case bug-0: licence GPL-3.0 is not one of ${LICENCES.join(", ")}`,
    ])
  })

  test("rejects a repository that is not a public GitHub owner and name", () => {
    for (const url of [
      "https://gitlab.com/example/repo",
      "https://github.com/example/..",
      "git@github.com:example/repo",
    ]) {
      const item = { ...synthetic(0), repository: { url, licence: "MIT" as const } }
      expect(manifestProblems(manifestOf([item]))).toEqual([
        "case bug-0: repository.url must be https://github.com/<owner>/<name>",
      ])
    }
  })

  test("rejects abbreviated SHAs and a fix committed before its candidate", () => {
    const item = synthetic(0)
    const abbreviated = { ...item, candidate: { ...item.candidate, head: item.candidate.head.slice(0, 12) } }
    expect(manifestProblems(manifestOf([abbreviated]))).toEqual([
      "case bug-0: candidate.head must be a full 40-character commit SHA",
    ])
    const early = { ...item, fix: { ...item.fix!, date: "2009-01-01T00:00:00Z" } }
    expect(manifestProblems(manifestOf([early]))).toEqual(["case bug-0: the fix must be committed after the candidate"])
  })

  test("rejects repeated ids and repeated candidates", () => {
    const first = synthetic(0)
    const second = { ...synthetic(1), id: "bug-0" }
    expect(manifestProblems(manifestOf([first, second]))).toContain("case id bug-0 repeats")
    const copy = { ...synthetic(1), repository: first.repository, candidate: first.candidate }
    expect(manifestProblems(manifestOf([first, copy]))).toEqual(["case bug-1 repeats the candidate of an earlier case"])
  })

  test("a control has no fix and no defects, and a bug case needs both", () => {
    const control = synthetic(0, { kind: "control" })
    const withFix = { ...control, fix: synthetic(0).fix }
    expect(manifestProblems(manifestOf([withFix]))).toEqual(["case control-0: a control has no fix"])
    const bug = synthetic(0)
    const unlabelled = { ...bug, labels: { ...bug.labels, defects: [] } }
    expect(manifestProblems(manifestOf([unlabelled]))).toEqual([
      "case bug-0: a bug case needs at least one labelled defect",
    ])
  })

  test("an exclusion needs a known reason and cannot also be an admitted case", () => {
    const item = synthetic(0)
    const exclusion = {
      repository: item.repository.url,
      candidate: { head: item.candidate.head },
      reason: "quota" as const,
      detail: "left out",
      date: "2026-11-03",
    }
    expect(manifestProblems(manifestOf([item], { exclusions: [exclusion] }))).toEqual([
      `the exclusion of ${item.repository.url} at ${item.candidate.head.slice(0, 12)} is also an admitted case`,
    ])
    const unknown = { ...exclusion, candidate: undefined, reason: "boring" }
    expect(
      manifestProblems(manifestOf([item], { exclusions: [unknown as unknown as Manifest["exclusions"][number]] }))[0],
    ).toContain("exclusion #1: reason must be one of")
  })

  test("a frozen manifest validates until a held-out case changes", () => {
    const manifest = manifestOf(Array.from({ length: 10 }, (_, index) => synthetic(index)))
    const frozen = { ...manifest, freeze: { date: "2026-11-04", digest: heldOutDigest(manifest) } }
    expect(manifestProblems(frozen)).toEqual([])
    expect(dryRunReport(frozen)).toContain(`Freeze: held-out cases frozen on 2026-11-04 (${heldOutDigest(manifest)}).`)
    const relabel = (id: string) => ({
      ...frozen,
      cases: frozen.cases.map((item) =>
        item.id === id
          ? { ...item, labels: { ...item.labels, defects: [{ ...item.labels.defects[0], summary: "relabelled" }] } }
          : item,
      ),
    })
    expect(frozen.cases.find((item) => item.id === "bug-9")?.split).toBe("held-out")
    expect(manifestProblems(relabel("bug-9"))).toEqual([
      "the held-out cases changed after the freeze: their digest no longer matches freeze.digest",
    ])
    expect(manifestProblems(relabel("bug-0"))).toEqual([])
  })

  test("held-out labels cannot be frozen before they are adjudicated", () => {
    const cases = Array.from({ length: 10 }, (_, index) => ({
      ...synthetic(index),
      labels: { ...synthetic(index).labels, annotation: draft },
    }))
    const manifest = manifestOf(cases)
    expect(manifestProblems({ ...manifest, freeze: { date: "2026-11-04", digest: heldOutDigest(manifest) } })).toEqual([
      "case bug-8: held-out labels were frozen before they were adjudicated",
      "case bug-9: held-out labels were frozen before they were adjudicated",
    ])
  })
})

const seed = (await loadManifest()) as Manifest

describe("the seed manifest", () => {
  test("is valid", () => {
    expect(manifestProblems(seed)).toEqual([])
  })

  test("holds eight bug fixes and two clean controls from ten permissively licensed repositories", () => {
    expect(seed.cases.filter((item) => item.kind === "bug")).toHaveLength(8)
    expect(seed.cases.filter((item) => item.kind === "control")).toHaveLength(2)
    expect(new Set(seed.cases.map((item) => item.repository.url)).size).toBe(10)
    expect(seed.cases.every((item) => (LICENCES as readonly string[]).includes(item.repository.licence))).toBe(true)
  })

  test("records a read-only GitHub check of every case", () => {
    expect(seed.cases.map((item) => item.provenance.checked.method)).toEqual(Array(10).fill("gh-api"))
  })

  test("is not frozen, because its labels are a single draft pass", () => {
    expect(seed.freeze).toBeUndefined()
    expect(seed.cases.every((item) => item.labels.annotation.status === "draft")).toBe(true)
  })

  test("the dry run reports splits and exclusions without a network request", () => {
    const original = globalThis.fetch
    globalThis.fetch = Object.assign(
      () => {
        throw new Error("the dry run made a network request")
      },
      { preconnect: original.preconnect },
    ) as typeof fetch
    const report = (() => {
      try {
        return dryRunReport(seed)
      } finally {
        globalThis.fetch = original
      }
    })()
    expect(report).toContain("10 cases, 8 bug fixes and 2 controls, from 10 repositories")
    expect(report).toContain(`Exclusions (${seed.exclusions.length}):`)
    for (const exclusion of seed.exclusions)
      expect(report).toContain(exclusion.repository.replace("https://github.com/", ""))
    expect(report).toContain("Freeze: not frozen.")
    expect(report).toContain("Dry run: no network requests were made.")
  })
})
