import { describe, expect, test } from "bun:test"
import type { Finding, PlacedFinding, PriorFinding, ReviewOutcome, Selection } from "@vectordevai/core/review/types"
import { renderLocalReview, type LocalTarget, type RenderInput } from "../../src/cli/cmd/review.render"

// Golden terminal output for `vector review` (section 1.7).

const MERGE_BASE = "1a2b3c4" + "0".repeat(33)
const HEAD = "d4e5f6a" + "0".repeat(33)
const LAST = "9f8e7d6" + "0".repeat(33)

const branch: LocalTarget = {
  kind: "branch",
  label: "feature/refresh",
  baseRef: "main",
  mergeBase: MERGE_BASE,
  head: HEAD,
  branch: "feature/refresh",
}

const finding = (overrides: Partial<Finding>): Finding => ({
  id: "000000000000",
  path: "src/auth/refresh.ts",
  line: 1,
  side: "RIGHT",
  severity: "concern",
  category: "bug",
  title: "A finding",
  body: "",
  confidence: 0.9,
  source: "review",
  ...overrides,
})

const placed = (overrides: Partial<Finding>, suggestionAllowed = false): PlacedFinding => {
  const value = finding(overrides)
  return { ...value, anchor: { path: value.path, side: value.side, line: value.line, hunk: 0 }, suggestionAllowed }
}

const prior = (overrides: Partial<PriorFinding>): PriorFinding => ({
  id: "111111111111",
  where: "summary",
  path: "src/auth/storage.ts",
  line: 22,
  side: "RIGHT",
  severity: "concern",
  category: "bug",
  title: "Sessions from older builds are dropped",
  sha: "9f8e7d6",
  status: "open",
  ...overrides,
})

const selection = (overrides: Partial<Selection> = {}): Selection => ({
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
})

const outcome = (overrides: Partial<ReviewOutcome> = {}): ReviewOutcome => ({
  report: { summary: "", risk: "low", files: [], findings: [] },
  selection: selection(),
  skipped: [],
  cost: {
    costUsd: 0,
    input: 48_200,
    output: 3_100,
    reasoning: 0,
    cacheRead: 0,
    cacheWrite: 0,
    kind: "priced",
    model: "openai/gpt-4.1",
  },
  durationMs: 112_000,
  base: MERGE_BASE,
  head: HEAD,
  mode: "full",
  unreviewed: [],
  specialists: [{ name: "review", status: "ok", steps: 4 }],
  sessions: ["ses_a1", "ses_b2"],
  stats: { files: 7, additions: 212, deletions: 61 },
  notes: [],
  ...overrides,
})

const render = (input: Partial<RenderInput> & Pick<RenderInput, "outcome">) =>
  renderLocalReview({
    target: branch,
    limits: { maxCostUsd: 2, maxSteps: 30, timeoutMinutes: 12 },
    ...input,
  })

describe("renderLocalReview", () => {
  test("prints the section 1.7 layout", () => {
    const text = render({
      since: LAST,
      outcome: outcome({
        skipped: [
          { path: "bun.lock", reason: "lockfile" },
          { path: "dist/auth.js", reason: "build-output" },
        ],
        selection: selection({
          risk: "medium",
          inline: [
            placed({ line: 88, title: "Rotation retries forever on a 401", body: "It never gives up." }),
            placed(
              {
                line: 52,
                severity: "blocking",
                title: "Refresh can restore a session after logout",
                body: "`rotate()` writes the new token after logout may have run. `logout()` in `src/auth/client.ts:31` neither waits for nor cancels a pending rotation.",
                suggestion: '  if (this.state !== "signed-in") return\n  await this.store.write(next)',
              },
              true,
            ),
          ],
          outsideDiff: [
            {
              ...finding({ path: "src/api/session.ts", line: 88, title: "readSession() still expects the old shape" }),
              reason: "file-not-in-diff",
            },
          ],
          nits: [
            finding({
              path: "src/auth/storage.ts",
              line: 18,
              severity: "nit",
              title: "`openDB` is imported but never used",
            }),
            finding({
              path: "src/auth/storage.ts",
              line: 40,
              severity: "nit",
              title: "The retry counter is never read",
            }),
            finding({ path: "src/auth/client.ts", line: 9, severity: "nit", title: "Comment describes the old flow" }),
          ],
          stillOpen: [prior({})],
          fixed: [prior({ id: "222222222222", line: 40, status: "fixed", fixedIn: "d4e5f6a" })],
        }),
      }),
    })

    expect(text).toBe(
      [
        "Vectorscope review · feature/refresh vs main (merge-base 1a2b3c4) · 7 files, +212 −61",
        "Risk: Medium · 1 blocking · 2 concerns · 3 nits",
        "",
        "src/auth/refresh.ts",
        "  52  Blocking  Refresh can restore a session after logout",
        "      rotate() writes the new token after logout may have run. logout() in src/auth/client.ts:31 …",
        "      suggestion:",
        '      │   if (this.state !== "signed-in") return',
        "      │   await this.store.write(next)",
        "  88  Concern   Rotation retries forever on a 401",
        "",
        "Outside the changed lines",
        "  src/api/session.ts:88  Concern  readSession() still expects the old shape",
        "",
        "Nits (3)  src/auth/storage.ts:18 openDB is imported but never used · …",
        "Not reviewed: bun.lock (lockfile) · dist/auth.js (build output)",
        "Since last local review (9f8e7d6): 1 fixed · 1 still open",
        "",
        "openai/gpt-4.1 · $0.00 · 48.2k in / 3.1k out · 1m 52s · sessions: ses_a1, ses_b2",
        "",
      ].join("\n"),
    )
  })

  test("says when nothing was found, with the priced cost and cached tokens", () => {
    const text = render({
      outcome: outcome({
        stats: { files: 1, additions: 3, deletions: 0 },
        sessions: ["ses_1"],
        cost: {
          costUsd: 0.21,
          input: 17_200,
          output: 3_100,
          reasoning: 0,
          cacheRead: 31_000,
          cacheWrite: 0,
          kind: "priced",
          model: "anthropic/claude-sonnet-4-5",
        },
      }),
    })
    expect(text).toBe(
      [
        "Vectorscope review · feature/refresh vs main (merge-base 1a2b3c4) · 1 file, +3 −0",
        "Risk: Low · No issues found",
        "",
        "anthropic/claude-sonnet-4-5 · $0.21 · 48.2k in, 31.0k of it cached / 3.1k out · 1m 52s · sessions: ses_1",
        "",
      ].join("\n"),
    )
  })

  test("words the subscription and unknown costs as the summary comment does", () => {
    const plan = render({ outcome: outcome({ cost: { ...outcome().cost!, kind: "plan", model: "openai/gpt-5" } }) })
    expect(plan).toContain("openai/gpt-5 · subscription sign-in, no per-token price · 48.2k in / 3.1k out")
    const unknown = render({ outcome: outcome({ cost: { ...outcome().cost!, kind: "unknown", model: "x/y" } }) })
    expect(unknown).toContain("x/y · cost unknown: no price is listed for this model · 48.2k in / 3.1k out")
  })

  test("a free model's review says so, and a review with several passes lists what each spent", () => {
    const free = render({
      outcome: outcome({ cost: { ...outcome().cost!, kind: "free", model: "openrouter/m:free" } }),
    })
    expect(free).toContain("openrouter/m:free · free · 48.2k in / 3.1k out")
    const text = render({
      outcome: outcome({
        cost: { ...outcome().cost!, kind: "priced", costUsd: 0.0154, model: "a/cheap + b/strong" },
        passes: [
          { name: "review", model: "a/cheap", costUsd: 0.0123, input: 40_100, output: 2_000, cacheRead: 0 },
          { name: "verify", model: "b/strong", costUsd: 0.0031, input: 9_200, output: 400, cacheRead: 0 },
        ],
      }),
    })
    expect(text.trimEnd().split("\n").at(-1)).toBe(
      "By pass: review $0.01 (40.1k in / 2.0k out) · double-check $0.0031 (9.2k in / 400 out)",
    )
  })

  test("a partial review names the files it did not reach and how to continue", () => {
    const text = render({
      resumable: true,
      outcome: outcome({ partial: "budget", unreviewed: ["a.ts", "b.ts"] }),
    })
    expect(text.split("\n")[2]).toBe(
      "Partial review: stopped at the $2.00 budget. Not reviewed: a.ts, b.ts. Run `vector review` again to review them.",
    )
    const failed = render({
      outcome: outcome({
        partial: "model-error",
        specialists: [
          { name: "review", status: "ok", steps: 3 },
          { name: "security", status: "failed", steps: 0, detail: "APIError: 400 Bad Request" },
        ],
      }),
    })
    expect(failed.split("\n")[2]).toBe(
      "Partial review: the security reviewer could not finish (APIError: 400 Bad Request).",
    )
  })

  test("uncommitted changes are shown against HEAD, removed lines with a minus sign", () => {
    const text = render({
      target: { kind: "uncommitted", label: "uncommitted changes", baseRef: "HEAD", mergeBase: HEAD, head: HEAD },
      outcome: outcome({
        stats: { files: 1, additions: 1, deletions: 1 },
        selection: selection({
          inline: [placed({ path: "a.ts", line: 12, side: "LEFT", title: "A check was removed" })],
        }),
      }),
    })
    expect(text.split("\n")[0]).toBe("Vectorscope review · uncommitted changes vs HEAD (d4e5f6a) · 1 file, +1 −1")
    expect(text).toContain("a.ts\n  −12  Concern   A check was removed\n")
  })

  test("model text cannot write escape sequences to the terminal", () => {
    const text = render({
      outcome: outcome({
        selection: selection({
          inline: [
            placed({
              severity: "blocking",
              title: "Title \x1b]0;pwned\x07 here",
              body: "Body \x1b[2J\x9b1m text",
              suggestion: "fix()\x1b[31m",
            }),
          ],
          elsewhere: [finding({ path: "b\x1b[1m.ts", line: 3, title: "Elsewhere" })],
        }),
        notes: ["`src/x.ts` has a generated-file header that its base does not, so Vectorscope reviewed it anyway."],
      }),
    })
    expect(text).not.toMatch(/[]/)
    expect(text).toContain("Title ]0;pwned here")
    expect(text).toContain("Elsewhere in this change\n  b[1m.ts:3  Concern  Elsewhere")
    expect(text).toContain(
      "src/x.ts has a generated-file header that its base does not, so Vectorscope reviewed it anyway.",
    )
  })

  test("findings hidden by --min-severity say their severity on the compact line", () => {
    const text = render({
      outcome: outcome({
        selection: selection({ nits: [finding({ path: "a.ts", line: 4, title: "Missing timeout" })] }),
      }),
    })
    expect(text).toContain("Below the severity bar (1)  a.ts:4 Concern Missing timeout")
  })

  test("a range shows its first and last line", () => {
    const value = placed({ line: 7, title: "displayName drops await" })
    const text = render({
      outcome: outcome({
        selection: selection({ inline: [{ ...value, anchor: { ...value.anchor, startLine: 6 } }] }),
      }),
    })
    expect(text).toContain("  6–7  Concern   displayName drops await")
  })

  test("colour is only added when asked for", () => {
    const value = outcome({ selection: selection({ inline: [placed({ severity: "blocking", title: "Bad" })] }) })
    expect(render({ outcome: value })).not.toContain("\x1b[")
    expect(render({ outcome: value, color: true })).toContain("\x1b[91m\x1b[1mBlocking")
  })
})

test("Codium footer and passes omit legacy numbers while mixed own passes retain theirs", () => {
  const raw = {
    ...outcome().cost!,
    model: "vector-plan/vector-flash",
    kind: "codium" as const,
    costUsd: 99,
    input: 987654,
  }
  const codium = {
    name: "review" as const,
    model: raw.model,
    costKind: "codium" as const,
    costUsd: 99,
    input: 987654,
    output: 1234,
    cacheRead: 0,
  }
  const only = render({ outcome: outcome({ cost: raw, passes: [codium, { ...codium, name: "security" }] }) })
  expect(only).toContain("Vector Codium · vector-flash · Codium · 1m 52s")
  expect(only).toContain("review: Codium")
  expect(only).not.toContain("987")
  expect(only).not.toContain("$99")
  const mixed = render({
    outcome: outcome({
      cost: { ...raw, kind: "priced", codium: true, costUsd: 0.12, model: "openai/gpt-4.1 + vector-plan/vector-flash" },
      passes: [
        codium,
        {
          name: "verify",
          model: "openai/gpt-4.1",
          costKind: "priced",
          costUsd: 0.12,
          input: 100,
          output: 20,
          cacheRead: 0,
        },
      ],
    }),
  })
  expect(mixed).toContain("$0.12")
  expect(mixed).toContain("100 in / 20 out")
  expect(mixed).toContain("Codium")
  expect(mixed).not.toContain("987")
  // Label plan §2: the Codium model reads "Vector Codium · <model>", never its vector-plan id.
  expect(mixed).toContain("openai/gpt-4.1 + Vector Codium · vector-flash · $0.12 + Codium · 1m 52s")
  expect(mixed).not.toContain("vector-plan")
})
