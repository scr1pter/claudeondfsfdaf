import { describe, expect, test } from "bun:test"
import path from "path"
import {
  buildFixedEdit,
  buildInlineBody,
  buildNoteBody,
  buildReviewBody,
  buildRunningBody,
  buildSummaryBody,
  capBody,
  costWording,
  fenceFor,
  formatDuration,
  formatUsd,
  inlineLeads,
  MAX_BODY_CHARS,
  noteAlreadyReviewed,
  noteFailed,
  noteForcePush,
  noteGeneratedHeader,
  noteGeneratedHeaders,
  noteInlineCap,
  noteLowConfidence,
  noteMonthBudget,
  noteMoved,
  noteNothingToReview,
  notePartial,
  notePrBudget,
  noteRebase,
  noteSuperseded,
  noteTooLarge,
  sanitizeModelMarkdown,
  type SummaryInput,
} from "@vectordevai/core/review/format"
import { emptyState, parseFindingMarker, readState } from "@vectordevai/core/review/state"
import type {
  AnchorFailure,
  Finding,
  PlacedFinding,
  PriorFinding,
  ReviewCost,
  ReviewState,
  Selection,
} from "@vectordevai/core/review/types"

// Golden bodies live in fixtures/format-<name>.golden.txt. Run with UPDATE_GOLDEN=1 to rewrite them, then read
// every changed file against the copy in sections 1.1–1.4 of the design.
const fixtures = path.join(import.meta.dir, "fixtures")
async function golden(name: string, actual: string) {
  const file = path.join(fixtures, `format-${name}.golden.txt`)
  if (process.env.UPDATE_GOLDEN) await Bun.write(file, actual)
  expect(actual).toBe(await Bun.file(file).text())
}

const ZWSP = String.fromCharCode(0x200b)
const HEAD = "d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3"
const SINCE = "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0"
const NEWER = "e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4"
const BASE = "0123456789abcdef0123456789abcdef01234567"
const REPO = { owner: "o", repo: "r" }
const RUN_URL = "https://github.com/o/r/actions/runs/42"
const STARTED = Date.UTC(2026, 8, 14, 14, 2)

const STATE: ReviewState = {
  ...emptyState(),
  head: HEAD,
  base: BASE,
  reviews: 2,
  costUsd: 0.37,
  tokens: [60_000, 5_000],
  inlinePosted: 3,
}

const usage = { input: 17_200, output: 3_100, reasoning: 0, cacheRead: 31_000, cacheWrite: 0 }
const priced: ReviewCost = { ...usage, costUsd: 0.21, kind: "priced", model: "anthropic/claude-sonnet-4-5" }
const plain = { input: 48_200, output: 3_100, reasoning: 0, cacheRead: 0, cacheWrite: 0, costUsd: 0 }
const zeroCost: ReviewCost = { ...plain, kind: "priced", model: "openai/gpt-4.1" }
const plan: ReviewCost = { ...plain, kind: "plan", model: "openai/gpt-5" }
const unknown: ReviewCost = { ...plain, kind: "unknown", model: "provider/model" }

function finding(overrides: Partial<Finding>): Finding {
  return {
    id: "000000000000",
    path: "src/auth/refresh.ts",
    line: 1,
    side: "RIGHT",
    severity: "concern",
    category: "bug",
    title: "Title",
    body: "",
    confidence: 0.8,
    source: "review",
    ...overrides,
  }
}

function placed(f: Finding, suggestionAllowed = false): PlacedFinding {
  return { ...f, anchor: { path: f.path, side: f.side, line: f.line, hunk: 0 }, suggestionAllowed }
}

function prior(overrides: Partial<PriorFinding>): PriorFinding {
  return {
    id: "000000000000",
    where: "inline",
    path: "src/auth/refresh.ts",
    line: 1,
    side: "RIGHT",
    severity: "concern",
    category: "bug",
    title: "Title",
    sha: "a1b2c3d",
    status: "open",
    ...overrides,
  }
}

function selection(overrides: Partial<Selection> = {}): Selection {
  return {
    inline: [],
    outsideDiff: [],
    elsewhere: [],
    nits: [],
    overflow: [],
    stillOpen: [],
    fixed: [],
    dismissed: [],
    reappeared: [],
    raised: [],
    dropped: [],
    risk: "low",
    ...overrides,
  }
}

const blocking = placed(
  finding({
    id: "3f9a1c07be21",
    line: 52,
    severity: "blocking",
    title: "Refresh can restore a session after logout",
    body: "`rotate()` awaits the token request and then writes the result unconditionally. If `logout()` runs while that request is in flight (the user clicks Sign out during a slow refresh), line 52 writes a fresh token for a signed-out user. `logout()` in `src/auth/client.ts:31` neither waits for nor cancels a pending rotation.",
    suggestion: '    if (this.state !== "signed-in") return\n    await this.store.write(next)',
    confidence: 0.86,
    verified: true,
    rule: "Auth state changes must be race-free",
  }),
  true,
)
const concern = placed(
  finding({
    id: "5b2e8d41c09a",
    line: 88,
    title: "Rotation retries forever on a 401",
    body: "The retry loop treats a 401 like a network error and never gives up.",
  }),
)
const outside: Finding & { reason: AnchorFailure } = {
  ...finding({
    id: "7c1d9e2f3a4b",
    path: "src/api/session.ts",
    line: 88,
    title: "`readSession()` still expects the old stored shape",
    body: "This PR changes what `storage.ts` writes, and this reader was not updated.",
  }),
  reason: "file-not-in-diff",
}
const elsewhere = finding({ id: "8d2e0f3a4b5c", line: 12, title: "Retry delay is not capped" })
const nits = [
  finding({
    id: "9e3f1a4b5c6d",
    path: "src/auth/storage.ts",
    line: 18,
    severity: "nit",
    title: "`openDB` is imported but never used",
  }),
  finding({
    id: "9e3f1a4b5c6e",
    path: "src/auth/storage.ts",
    line: 30,
    severity: "nit",
    title: "Comment still says localStorage",
  }),
  finding({
    id: "9e3f1a4b5c6f",
    path: "src/auth/client.ts",
    line: 5,
    severity: "nit",
    title: "Imports are out of order",
  }),
]

const report = {
  summary:
    "This change adds refresh-token rotation to the auth client and moves session storage from localStorage to IndexedDB. Rotation can race with logout, and sessions saved by older builds are not migrated.",
  files: [
    { path: "src/auth/refresh.ts", note: "Rotation loop; races logout" },
    { path: "src/auth/storage.ts", note: "IndexedDB adapter replaces localStorage" },
    { path: "src/auth/client.ts", note: "Wires the adapter in" },
    { path: "src/not/in/diff.ts", note: "A file the model made up" },
  ],
}
const files = [
  { path: "src/auth/refresh.ts", additions: 84, deletions: 12 },
  { path: "src/auth/storage.ts", additions: 40, deletions: 31 },
  { path: "src/auth/client.ts", additions: 9, deletions: 3 },
  { path: "test/auth/refresh.test.ts", additions: 60, deletions: 0 },
  { path: "test/auth/storage.test.ts", additions: 22, deletions: 4 },
  { path: "docs/auth.md", additions: 10, deletions: 2 },
  { path: "src/auth/README.md", additions: 3, deletions: 1 },
]
const skipped = [
  { path: "bun.lock", reason: "lockfile" as const },
  { path: "dist/auth.js", reason: "build-output" as const },
  { path: "assets/logo.png", reason: "binary" as const },
]

const FULL: SummaryInput = {
  repo: REPO,
  pr: 7,
  head: HEAD,
  baseRef: "main",
  mode: "full",
  report,
  selection: selection({ inline: [blocking, concern], outsideDiff: [outside], nits, risk: "high" }),
  files,
  skipped,
  cost: priced,
  durationMs: 112_000,
  prTotal: { costUsd: 0.21, reviews: 1 },
  runUrl: RUN_URL,
  state: STATE,
}

const INCREMENTAL: SummaryInput = {
  ...FULL,
  mode: "incremental",
  since: SINCE,
  selection: selection({
    inline: [blocking, concern],
    outsideDiff: [outside],
    elsewhere: [elsewhere],
    nits,
    stillOpen: [
      prior({
        id: "0a1b2c3d4e5f",
        path: "src/auth/storage.ts",
        line: 22,
        title: "Sessions from older builds are dropped",
        commentId: 123,
      }),
    ],
    fixed: [
      prior({
        id: "1b2c3d4e5f6a",
        line: 40,
        title: "Token stored before it is validated",
        status: "fixed",
        fixedIn: "d4e5f6a",
      }),
      prior({
        id: "2c3d4e5f6a7b",
        path: "src/auth/client.ts",
        line: 12,
        title: "Unhandled rejection on network error",
        status: "fixed",
        fixedIn: "c3d4e5f",
      }),
    ],
    dismissed: [
      prior({
        id: "3d4e5f6a7b8c",
        path: "src/auth/client.ts",
        line: 9,
        title: "Refresh request has no timeout",
        status: "dismissed",
        dismissedBy: "alice",
      }),
    ],
    dropped: [{ reason: "low-confidence", count: 2 }],
    risk: "medium",
  }),
  prTotal: { costUsd: 0.37, reviews: 2 },
}

const NO_FINDINGS: SummaryInput = {
  repo: REPO,
  pr: 7,
  head: HEAD,
  baseRef: "main",
  mode: "full",
  report: { summary: "Renames a helper and updates its two callers.", files: [] },
  selection: selection(),
  files: [
    { path: "src/util/format.ts", additions: 4, deletions: 4 },
    { path: "src/app.ts", additions: 2, deletions: 2 },
  ],
  cost: zeroCost,
  durationMs: 48_000,
  prTotal: { costUsd: 0, reviews: 1 },
  runUrl: RUN_URL,
  state: STATE,
}

// Bot text never puts a space directly before /vector, and commands always appear inside backticks.
function followsWordingRule(body: string) {
  expect(body).not.toMatch(/(^|\s)\/(vector|vx)\b/m)
  for (const match of body.matchAll(/.\/vector\b/g)) expect(match[0][0]).toBe("`")
}

describe("the summary comment", () => {
  test("a full review", async () => {
    const body = buildSummaryBody(FULL)
    await golden("full", body)
    expect(readState(body)).toEqual(STATE)
    followsWordingRule(body)
  })

  test("an incremental review, as in section 1.2", async () => {
    const body = buildSummaryBody(INCREMENTAL)
    await golden("incremental", body)
    expect(body).toContain("**1 blocking · 2 concerns** on the changed lines · 3 nits below")
    // New: the two inline findings, the one outside the diff and the one elsewhere; nits are not counted.
    expect(body).toContain("**Since last review** (`a1b2c3d` → `d4e5f6a`): 2 fixed · 1 still open · 4 new")
    expect(body).toContain("| `src/auth/refresh.ts` | 84 | 12 | Rotation loop; races logout |")
    expect(body).toContain("_4 more files changed (tests and docs)._")
    expect(body).toContain(
      "- **Concern** · `src/auth/storage.ts:22` · Sessions from older builds are dropped ([comment](https://github.com/o/r/pull/7#discussion_r123))",
    )
    expect(body).toContain("- `src/auth/client.ts:12` · Unhandled rejection on network error · fixed in `c3d4e5f`")
    expect(body).toContain(`- \`src/auth/client.ts:9\` · Refresh request has no timeout · dismissed by @${ZWSP}alice`)
    expect(body).toContain(
      "- **Concern** · `src/auth/refresh.ts:12` · Retry delay is not capped. Not in the code changed since the last review, so it is listed here rather than posted as a comment.",
    )
    expect(body).toContain("_2 lower-confidence notes were left out._")
    expect(body).toContain("`bun.lock` lockfile · `dist/auth.js` build output · `assets/logo.png` binary")
    expect(body).toContain(
      "<sub>Reviewed `d4e5f6a` against `main` · incremental from `a1b2c3d` · anthropic/claude-sonnet-4-5 · $0.21 (48.2k in, 31.0k of it cached / 3.1k out) · 1m 52s · this pull request: $0.37 over 2 reviews · [workflow run](https://github.com/o/r/actions/runs/42)</sub>",
    )
    expect(body).not.toContain("A file the model made up")
    followsWordingRule(body)
  })

  test("a partial review", async () => {
    const banner = notePartial({
      reason: "budget",
      reviewed: 9,
      total: 14,
      unreviewed: ["a.ts", "b.ts"],
      maxCostUsd: 2,
    })
    expect(banner).toBe(
      "**Partial review.** Stopped at the $2.00 budget after 9 of 14 files. Not reviewed: `a.ts`, `b.ts`. The next run reviews them, or comment `/vector review` to continue now.",
    )
    const body = buildSummaryBody({ ...FULL, banners: [banner] })
    await golden("partial", body)
    expect(body).toContain(`## Vectorscope review · Risk: High\n\n> ${banner}\n\n`)
  })

  test("no findings, with a known zero-dollar cost", async () => {
    const body = buildSummaryBody(NO_FINDINGS)
    await golden("no-findings", body)
    expect(body).toContain("**No issues found** on the changed lines.")
    expect(body).toContain("_2 files changed (code)._")
    expect(body).toContain("openai/gpt-4.1 · $0.00 (48.2k in / 3.1k out) · 48s · this pull request: 1 review")
  })

  test("the cost wording for subscription and unknown prices", () => {
    const footer = (cost: ReviewCost) =>
      buildSummaryBody({ ...NO_FINDINGS, cost })
        .split("\n")
        .find((line) => line.startsWith("<sub>Reviewed"))
    expect(footer(plan)).toBe(
      "<sub>Reviewed `d4e5f6a` against `main` · full review · openai/gpt-5 · subscription sign-in, no per-token price (48.2k in / 3.1k out) · 48s · this pull request: 1 review · [workflow run](https://github.com/o/r/actions/runs/42)</sub>",
    )
    expect(footer(unknown)).toContain(
      "· provider/model · cost unknown: pricing or complete usage is unavailable (48.2k in / 3.1k out) ·",
    )
  })

  test("a review superseded by a newer commit", async () => {
    await golden("superseded", buildSummaryBody({ ...FULL, notes: [noteSuperseded(NEWER)] }))
  })

  test("a file newly marked generated", async () => {
    const body = buildSummaryBody({
      ...NO_FINDINGS,
      notes: [noteGeneratedHeader("src/auth.ts")],
      skipped: [
        { path: "src/gen/client.ts", reason: "generated", additions: 120 },
        { path: "package-lock.json", reason: "lockfile" },
        { path: "src/gen/one.ts", reason: "generated", additions: 1 },
      ],
    })
    await golden("generated-header", body)
    expect(body).toContain(
      "`src/gen/client.ts` generated (+120 lines) · `src/gen/one.ts` generated (+1 line) · `package-lock.json` lockfile",
    )
  })

  test("comments moved to the summary after a 422", async () => {
    const moved = [concern, blocking].map((finding) => ({ ...finding, reason: "line-outside-diff" as const }))
    const body = buildSummaryBody({
      ...FULL,
      selection: selection({ outsideDiff: [outside, ...moved], nits, risk: "high" }),
      notes: [noteMoved(2)],
    })
    await golden("moved", body)
    expect(body).toContain("<details><summary>Outside the changed lines (3)</summary>")
  })

  test("the desktop form has no markers or commands and lists every finding with its fix as a diff", async () => {
    const body = buildSummaryBody({ ...FULL, form: "desktop" })
    await golden("desktop", body)
    expect(body).not.toContain("vector-review:")
    expect(body).not.toContain("/vector")
    expect(body).not.toContain("```suggestion")
    expect(body).toContain("**Blocking** · `src/auth/refresh.ts:52` · Refresh can restore a session after logout")
  })
})

describe("the desktop form with line comments", () => {
  test("does not list the findings that went out as line comments", () => {
    const body = buildSummaryBody({ ...FULL, form: "desktop", inlinePosted: true })
    expect(body).not.toContain("**Blocking** · `src/auth/refresh.ts:52` · Refresh can restore a session after logout")
    expect(body).toContain("## Vectorscope review")
    expect(body).not.toContain("vector-review:")
  })
})

describe("running and note bodies", () => {
  test("the first run shows only the Reviewing line", () => {
    const body = buildRunningBody({ head: HEAD, startedAt: STARTED, state: STATE })
    expect(body.split("\n").slice(0, 4)).toEqual([
      "## Vectorscope review · Reviewing `d4e5f6a`…",
      "",
      "This comment shows the results when the review finishes, usually in 2–5 minutes.",
      "",
    ])
    expect(readState(body)).toEqual(STATE)
  })

  test("a later run keeps the results, quotes the Reviewing line above them, and replaces the state", async () => {
    const inflight: ReviewState = { ...STATE, inflight: { run: "r2", head: NEWER, at: STARTED, costUsd: 0 } }
    const body = buildRunningBody({
      previous: buildSummaryBody(FULL),
      head: NEWER,
      startedAt: STARTED,
      state: inflight,
    })
    await golden("running-later", body)
    expect(body).toContain("## Vectorscope review · Risk: High\n\n> Reviewing `e5f6a7b`… (started 14:02 UTC)\n\n")
    expect(readState(body)).toEqual(inflight)
    expect(body.match(/vector-review:state/g)).toHaveLength(1)
    // Running again replaces the quoted line rather than stacking a second one.
    const again = buildRunningBody({ previous: body, head: NEWER, startedAt: STARTED + 60_000, state: inflight })
    expect(again.match(/> Reviewing/g)).toHaveLength(1)
    expect(again).toContain("(started 14:03 UTC)")
  })

  test("too large, with no earlier results", async () => {
    const note = noteTooLarge({
      files: 412,
      lines: 18_230,
      maxFiles: 300,
      maxLines: 5_000,
      estimate: { low: 1.1, high: 4.8 },
    })
    expect(note).toBe(
      "Too large to review automatically: 412 files and 18,230 changed lines (limits: 300 files, 5,000 lines). Comment `/vector review full` to review it anyway; with the current model that costs about $1.10–$4.80.",
    )
    await golden("too-large", buildNoteBody({ note, state: STATE }))
  })

  test("the month budget, above earlier results", async () => {
    const note = noteMonthBudget({ maxUsd: 50, spentUsd: 50.4, reviews: 61, month: "2026-09" })
    expect(note).toBe(
      "Reviews are paused for this repository until October 1: this month's $50.00 review budget is used (at least $50.40 across 61 pull requests). Raise `REVIEW_MAX_COST_USD_PER_MONTH` in `.github/workflows/vector.yml` to continue.",
    )
    const body = buildNoteBody({ previous: buildSummaryBody(FULL), note, state: STATE })
    await golden("month-budget", body)
    expect(body.startsWith(`## Vectorscope review · Risk: High\n\n> ${note}\n\nThis change adds`)).toBe(true)
  })

  test("a failed review says what its reviewers used before it stopped", () => {
    expect(
      noteFailed("HTTP 500 from the provider.", {
        costUsd: 0.21,
        input: 17_200,
        output: 3_100,
        reasoning: 0,
        cacheRead: 31_000,
        cacheWrite: 0,
        kind: "priced",
        model: "anthropic/claude-sonnet-4-5",
      }),
    ).toBe(
      "Vector could not finish this review: HTTP 500 from the provider. Used before it stopped: anthropic/claude-sonnet-4-5 · $0.21 (48.2k in, 31.0k of it cached / 3.1k out). Comment `/vector review` to try again.",
    )
  })

  test("a model error after a first run that never finished", async () => {
    const note = noteFailed("The provider returned 529 Overloaded.")
    expect(note).toBe(
      "Vector could not finish this review: The provider returned 529 Overloaded. Comment `/vector review` to try again.",
    )
    const running = buildRunningBody({ head: HEAD, startedAt: STARTED, state: STATE })
    await golden("model-error", buildNoteBody({ previous: running, note, state: STATE }))
  })

  test("a rebase with no change to the pull request's own diff", async () => {
    const note = noteRebase("main")
    expect(note).toBe("Rebased onto `main` with no change to this pull request's own diff; nothing new to review.")
    await golden("rebase-only", buildNoteBody({ previous: buildSummaryBody(INCREMENTAL), note, state: STATE }))
  })
})

describe("notes", () => {
  test("the copy in section 1.1 and 1.2", () => {
    expect(noteNothingToReview()).toBe("Nothing to review: every changed file is a lockfile, generated, or ignored.")
    expect(notePrBudget({ maxUsd: 10, spentUsd: 10.24, reviews: 9 })).toBe(
      "Automatic reviews stopped: this pull request has used its $10.00 review budget ($10.24 over 9 reviews). Comment `/vector review` to run another.",
    )
    expect(noteAlreadyReviewed(HEAD)).toBe(
      "`d4e5f6a` was already reviewed. Comment `/vector review full` to review it again.",
    )
    expect(noteSuperseded(NEWER)).toBe(
      "A newer commit (`e5f6a7b`) arrived during this review. Vectorscope reviews it next.",
    )
    expect(noteForcePush(SINCE, 3)).toBe(
      "History was rewritten since `a1b2c3d`; Vectorscope reviewed the 3 files whose changes differ.",
    )
    expect(noteLowConfidence(2)).toBe("_2 lower-confidence notes were left out._")
    expect(noteGeneratedHeader("src/auth.ts")).toBe(
      "`src/auth.ts` gained a generated-file header in this pull request, so Vectorscope reviewed it anyway.",
    )
    // The path comes from the pull request, so it can neither close the code span nor carry a marker.
    expect(noteGeneratedHeader("src/a`b<!-- vector-review:summary -->.ts")).toBe(
      "`src/a'b&lt;!-- vector-review:summary -->.ts` gained a generated-file header in this pull request, so Vectorscope reviewed it anyway.",
    )
    expect(noteMoved(2)).toBe(
      "Vector could not attach 2 comments to lines; they are listed under Outside the changed lines.",
    )
    expect(noteInlineCap(25, "pr")).toBe(
      "This pull request reached its 25 inline comments. Further findings are listed here.",
    )
  })

  test("variants", () => {
    expect(noteTooLarge({ files: 301, lines: 10, maxFiles: 300, maxLines: 5_000 })).toEndWith(
      "Comment `/vector review full` to review it anyway.",
    )
    expect(noteMonthBudget({ maxUsd: 50, spentUsd: 51, reviews: 1, month: "2026-12" })).toContain("until January 1:")
    expect(notePartial({ reason: "steps", unreviewed: [], maxSteps: 30 })).toBe(
      "**Partial review.** Stopped at the 30-step limit. Comment `/vector review` to continue now.",
    )
    expect(
      notePartial({ reason: "timeout", reviewed: 3, total: 4, unreviewed: ["x.ts"], timeoutMinutes: 12 }),
    ).toContain("Stopped at the 12-minute time limit after 3 of 4 files. Not reviewed: `x.ts`.")
    expect(notePartial({ reason: "model-error", unreviewed: [], detail: "security: timed out" })).toBe(
      "**Partial review.** One reviewer could not finish: security: timed out. Comment `/vector review` to try again.",
    )
  })

  test("an error is one short line, and cannot mention anyone", () => {
    const note = noteFailed(`@alice broke it\n${"x".repeat(500)}`)
    expect(note).not.toContain("\n")
    expect(note).toContain(`@${ZWSP}alice`)
    expect(note.length).toBeLessThan(300)
  })
})

describe("inline comments", () => {
  test("the comment in section 1.4", () => {
    expect(buildInlineBody(blocking, { head: HEAD, trust: "trusted", repo: REPO })).toBe(
      [
        "**Blocking** · Refresh can restore a session after logout",
        "",
        "`rotate()` awaits the token request and then writes the result unconditionally. If `logout()` runs while that request is in flight (the user clicks Sign out during a slow refresh), line 52 writes a fresh token for a signed-out user. `logout()` in `src/auth/client.ts:31` neither waits for nor cancels a pending rotation.",
        "",
        "```suggestion",
        '    if (this.state !== "signed-in") return',
        "    await this.store.write(next)",
        "```",
        "",
        '<sub>bug · confidence 0.86 · verified · rule from .vector/review.md: "Auth state changes must be race-free" · reply `/vector fix` to have Vector apply this</sub>',
        "<!-- vector-finding v1 id=3f9a1c07be21 sev=b cat=bug sha=d4e5f6a st=o t=logout,refresh,restore,session -->",
      ].join("\n"),
    )
  })

  test("a comment posted from the desktop does not offer the /vector fix command", () => {
    const body = buildInlineBody(blocking, { head: HEAD, trust: "trusted", repo: REPO, commands: false })
    expect(body).not.toContain("/vector fix")
    expect(body).toContain("```suggestion")
  })

  test("untrusted mode has no /vector fix line, and an unconfirmed fix is a diff block", () => {
    const body = buildInlineBody(
      { ...blocking, verified: false },
      { head: HEAD, trust: "untrusted", suggestion: "diff" },
    )
    expect(body).not.toContain("/vector fix")
    expect(body).not.toContain("```suggestion")
    expect(body).toContain(
      '```diff\n+    if (this.state !== "signed-in") return\n+    await this.store.write(next)\n```',
    )
    expect(body).toContain("<sub>bug · confidence 0.86 · rule from")
  })

  test("the fence grows when the suggestion contains backticks", () => {
    const suggestion = "const fence = ```md```"
    expect(fenceFor(suggestion)).toBe("````")
    const body = buildInlineBody({ ...concern, suggestion }, { head: HEAD, trust: "trusted", suggestion: "commit" })
    expect(body).toContain("````suggestion\nconst fence = ```md```\n````")
  })

  test("a lead line for a finding that returned or was raised", () => {
    const leads = inlineLeads({ reappeared: ["000000000001"], raised: [{ id: "000000000002", was: "concern" }] }, [
      prior({ id: "000000000001", status: "fixed", fixedIn: "abc1234def" }),
      prior({ id: "000000000002", sha: "a1b2c3d9" }),
    ])
    expect(leads).toEqual({
      "000000000001": "Returned after being fixed in `abc1234`",
      "000000000002": "Raised to Blocking (was a Concern in `a1b2c3d`)",
    })
    const body = buildInlineBody(concern, { head: HEAD, trust: "trusted", lead: leads["000000000001"] })
    expect(body.split("\n").slice(0, 3)).toEqual([
      "**Concern** · Rotation retries forever on a 401",
      "",
      "_Returned after being fixed in `abc1234`_",
    ])
  })

  test("the fixed edit collapses the suggestion and marks the finding fixed", () => {
    const body = buildInlineBody(blocking, { head: HEAD, trust: "trusted" })
    const edited = buildFixedEdit(body, NEWER)
    expect(edited.split("\n")[0]).toBe("**Fixed in `e5f6a7b`.** ~~Refresh can restore a session after logout~~")
    expect(edited).not.toContain("```suggestion")
    expect(edited).toContain(
      '<details><summary>Original suggestion</summary>\n\n```diff\n+    if (this.state !== "signed-in") return\n+    await this.store.write(next)\n```\n</details>',
    )
    expect(parseFindingMarker(edited)).toMatchObject({ id: "3f9a1c07be21", status: "fixed", fixedIn: "e5f6a7b" })
    expect(buildFixedEdit(edited, NEWER)).toBe(edited)
  })
})

describe("the review body", () => {
  test("section 1.3", () => {
    expect(
      buildReviewBody({
        head: HEAD,
        run: "8f3c21aa",
        inline: [blocking, concern],
        summaryUrl: "https://github.com/o/r/pull/7#issuecomment-123",
      }),
    ).toBe(
      "Vectorscope review of `d4e5f6a`: 1 blocking issue and 1 concern on the changed lines. [Summary](https://github.com/o/r/pull/7#issuecomment-123)\n<!-- vector-review:review head=d4e5f6a run=8f3c21aa -->",
    )
    expect(buildReviewBody({ head: HEAD, run: "8f3c21aa", inline: [], continued: true })).toBe(
      "Vectorscope review of `d4e5f6a` (continued).\n<!-- vector-review:review head=d4e5f6a run=8f3c21aa -->",
    )
    const many = [blocking, blocking, concern, concern, concern]
    expect(buildReviewBody({ head: HEAD, run: "r", inline: many })).toStartWith(
      "Vectorscope review of `d4e5f6a`: 2 blocking issues and 3 concerns on the changed lines.\n",
    )
  })
})

describe("sanitizeModelMarkdown", () => {
  test("removes images and raw HTML", () => {
    expect(sanitizeModelMarkdown("See ![diagram](https://evil.example/x.png) here", REPO)).toBe("See diagram here")
    expect(sanitizeModelMarkdown("<img src=x onerror=alert(1)> and <details>", REPO)).toBe(
      "&lt;img src=x onerror=alert(1)> and &lt;details>",
    )
  })

  test("keeps only links into this repository", () => {
    expect(
      sanitizeModelMarkdown(
        "[docs](https://evil.example/phish) and [code](https://github.com/o/r/blob/main/a.ts#L3)",
        REPO,
      ),
    ).toBe("docs and [code](https://github.com/o/r/blob/main/a.ts#L3)")
    expect(sanitizeModelMarkdown("[near miss](https://github.com/o/r2/x)", REPO)).toBe("near miss")
    expect(sanitizeModelMarkdown("[code](https://github.com/o/r/x)")).toBe("code")
    expect(sanitizeModelMarkdown("Visit https://evil.example/a?b=c. Or <https://evil.example>", REPO)).toBe(
      "Visit `https://evil.example/a?b=c`. Or `https://evil.example`",
    )
    expect(sanitizeModelMarkdown("See https://github.com/o/r/pull/7.", REPO)).toBe("See https://github.com/o/r/pull/7.")
    expect(sanitizeModelMarkdown("[x]: https://evil.example", REPO)).toBe("\\[x]: `https://evil.example`")
  })

  test("neutralizes mentions and commands, but not e-mail addresses or code", () => {
    expect(sanitizeModelMarkdown("Ping @alice and @org/team, not me@example.com", REPO)).toBe(
      `Ping @${ZWSP}alice and @${ZWSP}org/team, not me@example.com`,
    )
    expect(sanitizeModelMarkdown("Code `@alice <b>` stays", REPO)).toBe("Code `@alice <b>` stays")
    expect(sanitizeModelMarkdown("Try /vector fix now", REPO)).toBe(`Try /${ZWSP}vector fix now`)
    expect(sanitizeModelMarkdown(`Already @${ZWSP}safe`, REPO)).toBe(`Already @${ZWSP}safe`)
  })

  test("escapes comments, so model text can never carry a marker", () => {
    expect(sanitizeModelMarkdown("<!-- vector-review:state v1 AAAA -->", REPO)).toBe(
      "&lt;!-- vector-review:state v1 AAAA -->",
    )
    expect(sanitizeModelMarkdown("```html\n<!-- vector-finding v1 x -->\n<b>ok</b>\n```", REPO)).toBe(
      "```html\n&lt;!-- vector-finding v1 x -->\n<b>ok</b>\n```",
    )
  })

  test("a suggestion fence in model text becomes a plain one, and an open fence is closed", () => {
    expect(sanitizeModelMarkdown("```suggestion\nrm -rf /\n```", REPO)).toBe("```\nrm -rf /\n```")
    expect(sanitizeModelMarkdown("```js\nunclosed", REPO)).toBe("```js\nunclosed\n```")
  })

  const IMG = '<img src="https://evil.example/p.png">'

  test("where GitHub could see code spans differently, the whole text is sanitized", () => {
    expect(sanitizeModelMarkdown("See \\`" + IMG + "\\`", REPO)).not.toContain("<img")
    expect(sanitizeModelMarkdown("ping \\`@victim\\`", REPO)).toContain(`@${ZWSP}victim`)
    expect(sanitizeModelMarkdown("unmatched `@victim", REPO)).toBe(`unmatched \`@${ZWSP}victim`)
    // A code span cannot run across a blank line or into a line that starts HTML.
    expect(sanitizeModelMarkdown("`a\n\n" + IMG + "\n\nb`", REPO)).not.toContain("<img")
    expect(sanitizeModelMarkdown("`a\n" + IMG + " b`", REPO)).not.toContain("<img")
    expect(sanitizeModelMarkdown("Use `Array<string>` and `@types/node`", REPO)).toBe(
      "Use `Array<string>` and `@types/node`",
    )
  })

  test("a backtick fence with a backtick in its info string is prose", () => {
    expect(sanitizeModelMarkdown("``` x`y\n" + IMG + "\n```", REPO)).not.toContain("<img")
    expect(sanitizeModelMarkdown("~~~ x`y\n" + IMG + "\n~~~", REPO)).toBe("~~~ x`y\n" + IMG + "\n~~~")
  })

  test("a suggestion fence inside a quote or a list item becomes a plain one", () => {
    expect(sanitizeModelMarkdown("> ```suggestion\n> x\n> ```", REPO)).toBe("> ```\n> x\n> ```")
    expect(sanitizeModelMarkdown("- item\n    ```suggestion\n    x\n    ```", REPO)).not.toContain("suggestion")
    expect(sanitizeModelMarkdown("1. ~~~suggestion\n   x\n   ~~~", REPO)).not.toContain("suggestion")
  })

  test("a link that leaves the repository through dot segments, a user name, a port or plain http is dropped", () => {
    for (const url of [
      "https://github.com/o/r/../../login/oauth/authorize?client_id=X&scope=repo",
      "https://github.com/o/r/%2e%2e/%2e%2e/login",
      "https://user@github.com/o/r/x",
      "https://github.com:8443/o/r/x",
      "http://github.com/o/r/x",
      "https://github.com.evil.example/o/r",
    ])
      expect([url, sanitizeModelMarkdown(`[docs](${url})`, REPO)]).toEqual([url, "docs"])
    expect(sanitizeModelMarkdown("[r](https://github.com/O/R?tab=readme)", REPO)).toBe(
      "[r](https://github.com/O/R?tab=readme)",
    )
  })

  test("long runs of whitespace stay fast", () => {
    for (const text of ["[a](" + " ".repeat(20_000) + "x", "[a](x" + " ".repeat(20_000) + '"t"']) {
      const started = performance.now()
      sanitizeModelMarkdown(text, REPO)
      expect(performance.now() - started).toBeLessThan(100)
    }
  })

  test("text is clipped before it is sanitized, so a cut cannot leave HTML inside an open code span", () => {
    const tail = " `" + IMG + "`"
    const summary = buildSummaryBody({ ...FULL, report: { summary: "x".repeat(1_490) + tail, files: [] } })
    expect(summary).not.toContain("<img")
    const rule = buildInlineBody({ ...concern, rule: "r".repeat(190) + tail }, { head: HEAD, trust: "trusted" })
    expect(rule).not.toContain("<img")
    expect(noteFailed("e".repeat(190) + tail)).not.toContain("<img")
    const note = buildSummaryBody({
      ...FULL,
      report: { summary: "s", files: [{ path: "src/auth/refresh.ts", note: "n".repeat(95) + tail }] },
    })
    expect(note).not.toContain("<img")
  })
})

describe("capBody", () => {
  const manyNits = Array.from({ length: 3_000 }, (_, i) =>
    finding({
      id: i.toString(16).padStart(12, "0"),
      path: `src/n${i}.ts`,
      line: i + 1,
      severity: "nit",
      title: `Nit ${i} ${"x".repeat(40)}`,
    }),
  )
  const manyElsewhere = Array.from({ length: 50 }, (_, i) =>
    finding({
      id: (10_000 + i).toString(16).padStart(12, "0"),
      path: `src/e${i}.ts`,
      line: 1,
      title: `Elsewhere ${i}`,
      body: "y".repeat(200),
    }),
  )
  const input: SummaryInput = {
    ...INCREMENTAL,
    selection: selection({ nits: manyNits, elsewhere: manyElsewhere, risk: "low" }),
  }

  test("keeps the body at or under 60,000 characters, trimming nits first", () => {
    const body = buildSummaryBody(input)
    expect(body.length).toBeLessThanOrEqual(MAX_BODY_CHARS)
    expect(body).toContain("<details><summary>Nits (3000)</summary>")
    expect(body).toMatch(/- …and \d+ more\n<\/details>/)
    expect(body).toContain("Elsewhere 49")
    expect(readState(body)).toEqual(STATE)
  })

  test("many generated-header notes are one line, and notes are trimmed before the file table", () => {
    const paths = Array.from({ length: 3_000 }, (_, i) => `src/gen${i}.ts`)
    expect(noteGeneratedHeaders(paths)).toBe(
      "`src/gen0.ts`, `src/gen1.ts`, `src/gen2.ts` and 2,997 more gained a generated-file header in this pull request, so Vectorscope reviewed them anyway.",
    )
    expect(noteGeneratedHeaders(["a.ts"])).toBe(noteGeneratedHeader("a.ts"))
    expect(noteGeneratedHeaders([])).toBeUndefined()
    const body = capBody({ ...INCREMENTAL, notes: paths.map(noteGeneratedHeader) }, 20_000)
    expect(body.length).toBeLessThanOrEqual(20_000)
    expect(body).toMatch(/_…and [\d,]+ more notes\._/)
    expect(body).toContain("<sub>Reviewed `")
    expect(readState(body)).toEqual(STATE)
  })

  test("a fix too long for a comment is left out, with a line saying so", () => {
    const body = buildInlineBody(
      { ...concern, suggestion: "x".repeat(9_000) },
      { head: HEAD, trust: "trusted", suggestion: "diff" },
    )
    expect(body).toContain("_The suggested fix is too long to show here._")
    expect(body).not.toContain("```diff")
  })

  test("then elsewhere, and never the state", () => {
    const body = capBody(input, 12_000)
    expect(body.length).toBeLessThanOrEqual(12_000)
    expect(body).toContain("- …and 3000 more")
    expect(body).toContain("Elsewhere 0")
    expect(body).not.toContain("Elsewhere 49")
    expect(readState(body)).toEqual(STATE)
  })
})

describe("numbers and cost", () => {
  test("pure Codium wording and failure ignore raw numeric fields and missing usage", () => {
    const codium: ReviewCost = {
      ...priced,
      kind: "codium",
      model: "vector-plan/vector-velocity",
      partial: true,
      usageMissing: true,
      tokensOwnOnly: true,
    }
    expect(costWording(codium)).toBe("Vector Codium · vector-velocity · Codium")
    expect(noteFailed("timeout", codium)).toContain("Used before it stopped: Vector Codium · vector-velocity · Codium.")
    const body = buildSummaryBody({ head: HEAD, baseRef: "main", mode: "full", cost: codium })
    expect(body).toContain("· Vector Codium · vector-velocity · Codium</sub>")
    expect(body).not.toMatch(/\$|48\.2k|31\.0k|3\.1k|usage unavailable|cost unknown|Codium\s+\d/)
  })

  test.each([0, 0.4])("PR totals show Codium activity without printing its count or zero dollars: %j", (costUsd) => {
    const body = buildSummaryBody({
      head: HEAD,
      baseRef: "main",
      mode: "full",
      prTotal: { costUsd, reviews: 3, codiumReviews: 2 },
    })
    expect(body).toContain(`this pull request: ${costUsd ? "$0.40 + " : ""}Codium over 3 reviews`)
    expect(body).not.toMatch(/Codium\s+\d|\$0\.00/)
  })

  test("mixed fresh usage shows only attributed own figures alongside Codium", () => {
    expect(costWording({ ...priced, codium: true, tokensOwnOnly: true })).toBe(
      "anthropic/claude-sonnet-4-5 · $0.21 + Codium (48.2k in, 31.0k of it cached / 3.1k out)",
    )
    expect(costWording({ ...priced, codium: true, partial: true })).toBe(
      "anthropic/claude-sonnet-4-5 · at least $0.21 + Codium: a reply that stopped early reported no usage",
    )
    expect(costWording({ ...plan, codium: true })).toBe(
      "openai/gpt-5 · subscription sign-in, no per-token price + Codium",
    )
    expect(costWording({ ...zeroCost, kind: "free", codium: true })).toBe("openai/gpt-4.1 · free + Codium")
  })

  test.each([undefined, false])("mixed aggregate tokens are omitted without positive fresh proof: %j", (proof) => {
    const wording = costWording({ ...priced, codium: true, tokensOwnOnly: proof })
    expect(wording).toBe("anthropic/claude-sonnet-4-5 · $0.21 + Codium")
    expect(wording).not.toMatch(/cached| in| out|48\.2k|31\.0k|3\.1k/)
  })

  test("mixed unknown and missing usage preserve known own cost while explaining the gap", () => {
    expect(costWording({ ...unknown, codium: true, costUsd: 0.21 })).toBe(
      "provider/model · $0.21 + Codium · additional cost unknown: pricing or complete usage is unavailable",
    )
    expect(costWording({ ...unknown, codium: true, tokensOwnOnly: true })).toBe(
      "provider/model · cost unknown + Codium: pricing or complete usage is unavailable (48.2k in / 3.1k out)",
    )
    expect(costWording({ ...priced, codium: true, usageMissing: true })).toBe(
      "anthropic/claude-sonnet-4-5 · $0.21 + Codium · additional cost and token usage unavailable",
    )
  })

  test("legacy model prefixes identify pure and mixed Codium without relying on old cost kind", () => {
    expect(costWording({ ...priced, kind: "unknown", model: "vector-plan/vector-velocity" })).toBe(
      "Vector Codium · vector-velocity · Codium",
    )
    expect(costWording({ ...priced, model: "anthropic/claude-sonnet-4-5 + vector-plan/vector-velocity" })).toBe(
      "anthropic/claude-sonnet-4-5 + Vector Codium · vector-velocity · $0.21 + Codium",
    )
    expect(costWording({ ...priced, model: "other/vector-plan/model" })).toBe(
      "other/vector-plan/model · $0.21 (48.2k in, 31.0k of it cached / 3.1k out)",
    )
  })

  // Label plan §2: `vector-plan` is never printed as a provider name; a Codium model reads "Vector Codium · <model>".
  // Mixed wording keeps its "<models> · <own figure> + Codium" layout and renames only the Codium model's segment.
  test("a mixed review names its Codium models Vector Codium, never by the vector-plan id", () => {
    const mixed = "anthropic/claude-sonnet-4-5 + vector-plan/vector-velocity"
    const named = "anthropic/claude-sonnet-4-5 + Vector Codium · vector-velocity"
    const cost: ReviewCost = { ...priced, codium: true, model: mixed }
    const wordings = [
      costWording({ ...cost, tokensOwnOnly: true }),
      costWording({ ...cost, partial: true }),
      costWording({ ...cost, usageMissing: true }),
      costWording({ ...plan, codium: true, model: "openai/gpt-5 + vector-plan/vector-flash" }),
      costWording({ ...unknown, codium: true, costUsd: 0.21, model: "vector-plan/vector-flash + provider/model" }),
      noteFailed("timeout", cost),
      buildSummaryBody({ head: HEAD, baseRef: "main", mode: "full", cost }),
    ]
    expect(wordings.slice(0, 5)).toEqual([
      `${named} · $0.21 + Codium (48.2k in, 31.0k of it cached / 3.1k out)`,
      `${named} · at least $0.21 + Codium: a reply that stopped early reported no usage`,
      `${named} · $0.21 + Codium · additional cost and token usage unavailable`,
      "openai/gpt-5 + Vector Codium · vector-flash · subscription sign-in, no per-token price + Codium",
      "Vector Codium · vector-flash + provider/model · $0.21 + Codium · additional cost unknown: pricing or complete usage is unavailable",
    ])
    expect(wordings[5]).toContain(`Used before it stopped: ${named} · $0.21 + Codium.`)
    expect(wordings[6]).toContain(`· ${named} · $0.21 + Codium</sub>`)
    for (const wording of wordings) expect(wording).not.toContain("vector-plan")
  })

  test("costWording for every kind", () => {
    expect(costWording(priced)).toBe("anthropic/claude-sonnet-4-5 · $0.21 (48.2k in, 31.0k of it cached / 3.1k out)")
    expect(costWording(zeroCost)).toBe("openai/gpt-4.1 · $0.00 (48.2k in / 3.1k out)")
    expect(costWording(plan)).toBe("openai/gpt-5 · subscription sign-in, no per-token price (48.2k in / 3.1k out)")
    expect(costWording(unknown)).toBe(
      "provider/model · cost unknown: pricing or complete usage is unavailable (48.2k in / 3.1k out)",
    )
    expect(costWording({ ...priced, partial: true })).toBe(
      "anthropic/claude-sonnet-4-5 · at least $0.21: a reply that stopped early reported no usage (48.2k in, 31.0k of it cached / 3.1k out)",
    )
  })

  test("formatUsd and formatDuration", () => {
    expect(formatUsd(0.21)).toBe("$0.21")
    expect(formatUsd(10)).toBe("$10.00")
    expect(formatUsd(0.004)).toBe("$0.0040")
    expect(formatUsd(0)).toBe("$0.00")
    expect(formatDuration(112_000)).toBe("1m 52s")
    expect(formatDuration(48_000)).toBe("48s")
    expect(formatDuration(3_720_000)).toBe("1h 2m")
  })
})

test("free review footer says free, without an unknown price and without naming OpenRouter", () => {
  expect(costWording({ ...zeroCost, kind: "free", model: "vector/acme/coder:free" })).toBe(
    "vector/acme/coder · free (48.2k in / 3.1k out)",
  )
})
