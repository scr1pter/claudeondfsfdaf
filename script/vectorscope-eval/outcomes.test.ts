import { afterAll, describe, expect, test } from "bun:test"
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, hkdfSync } from "node:crypto"
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import {
  emptyState,
  findingMarker,
  stateMarker,
  SUMMARY_MARKER,
  type FindingMarker,
} from "../../packages/core/src/review/state"
import { DEFAULT_CONFIDENCE, independentDifference, proportion, wilson } from "../../packages/core/src/review/eval"
import { RISK_CUTPOINTS, riskOf, type RiskBand, type RiskFeatures } from "../../packages/core/src/review/risk"
import { DISMISSAL_WHY } from "../../packages/core/src/review/team"
import type { PriorFinding, ReviewState } from "../../packages/core/src/review/types"
import { UNTRUSTED_GIT, untrustedGitEnv } from "./dataset"
import {
  agentStratum,
  AUDIT_DRAW,
  AUDIT_FILE,
  AUDIT_INFO,
  AUDIT_PER_LABEL,
  AUDIT_QUESTION,
  AUDIT_SCHEMA,
  auditKey,
  auditLabels,
  auditSample,
  bulkResolved,
  collect,
  findingOutcome,
  FIX_LABEL,
  fixKind,
  ghArgs,
  ghReader,
  deletedLineKind,
  hashLogin,
  hashName,
  LATENT_KILL_PRECISION,
  LATENT_MIN_DROPS,
  latentDrops,
  latentForecast,
  LEDGER_DAYS,
  LEDGER_SCHEMA,
  LEDGER_SCHEMA_V1,
  ledgerProblem,
  likelyBand,
  localGit,
  main,
  matured,
  MEASUREMENT_RULE,
  MIN_EXPECTED,
  MIN_MATURED,
  MIN_SETTLED,
  MAX_FILTERED_BLAME_LINES,
  MAX_FIX_LOCATIONS,
  MAX_LABELS_BYTES,
  MAX_LATENT_DROPS,
  MAX_LEDGER_PULLS,
  MIN_PULLS,
  MIN_VOLUME,
  NO_DISMISSAL_REASON,
  NO_DROPS,
  NO_DROPS_READ,
  NOT_FIX_LABEL,
  OUTCOMES,
  outcomeReport,
  READ_ONLY_GIT,
  RECURRENCE_DAYS,
  renderOutcomes,
  REPORT_FILE,
  revertsOf,
  revertTargets,
  SEALED_LEDGER,
  subjectCounts,
  THREAD_COMMENTS_QUERY,
  THREADS_QUERY,
  v1LedgerProblem,
  V1_UNAVAILABLE,
  WRITER_PERMISSIONS,
  Z_ALPHA,
  Z_POWER,
  type AuditEntry,
  type AuditLabels,
  type AuditSample,
  type CohortRow,
  type GitHubRead,
  type LatentDrop,
  type LatentOutcome,
  type LedgerFinding,
  type LedgerFix,
  type LedgerFixCommit,
  type LedgerPull,
  type LedgerPullV1,
  type MeasurementRule,
  type Outcome,
  type OutcomeLedger,
  type OutcomeLedgerV1,
  type PullStratum,
} from "./outcomes"
import { REPO_ROOT } from "./paths"
import { OUTCOME_LEDGER_FILE, PUBLIC_KEY_ENV, seal, unseal, type Sealed } from "./seal"

// The outcome ledger (VS-46a) over synthetic data only: a fake GitHub client that records every call, and git
// repositories built here under the temporary directory. Q30 is open, so nothing here reads a real repository, spawns
// gh or sends anything.

const root = mkdtempSync(join(tmpdir(), "vectorscope-outcomes-"))
afterAll(() => rmSync(root, { recursive: true, force: true }))

const DAY = 86_400_000
const NOW = Date.UTC(2026, 10, 7, 12)
const REPOSITORY = "acme/widgets"
const BOT = "vector-app[bot]"
const KEY = new Uint8Array(32).fill(7)
const OWNER = generateKeyPairSync("rsa", {
  modulusLength: 3072,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
})
const isBot = (login: string) => /\[bot\]$/i.test(login)
const writers = new Set(["alice", "dev"])
const isWriter = (login: string) => writers.has(login.toLowerCase())

function prior(overrides: Partial<PriorFinding> = {}): PriorFinding {
  return {
    id: "abcdefabcdef",
    where: "inline",
    path: "src/app.ts",
    line: 10,
    side: "RIGHT",
    severity: "concern",
    category: "bug",
    title: "A finding",
    sha: "1234567",
    status: "open",
    commentId: 1,
    ...overrides,
  }
}

function outcome(
  input: PriorFinding,
  thread?: Parameters<typeof findingOutcome>[0]["thread"],
  extra: Partial<Parameters<typeof findingOutcome>[0]> = {},
) {
  return findingOutcome({ prior: input, ...(thread ? { thread } : {}), author: "dev", isBot, isWriter, ...extra })
}

describe("per-finding outcomes", () => {
  test("a fix is confirmed only when someone neither a bot nor the PR author resolved its thread", () => {
    const fixed = prior({ status: "fixed", fixedIn: "abcdef1" })
    expect(outcome(fixed, { resolved: true, resolvedBy: "alice" })).toEqual({
      outcome: "fixed-confirmed-by-thread",
      humanEngaged: true,
      resolver: "writer",
    })
    expect(outcome(fixed, { resolved: true, resolvedBy: "carol" })).toMatchObject({
      outcome: "fixed-confirmed-by-thread",
      resolver: "other",
    })
    // The PR author's own resolve, even by a writer, is self-resolved, never a confirmation [FL9, FL10].
    expect(outcome(fixed, { resolved: true, resolvedBy: "Dev" })).toEqual({
      outcome: "fixed-self-resolved",
      humanEngaged: false,
      resolver: "author",
    })
    // The job resolves the thread itself when it marks a finding fixed (github.review.ts).
    expect(outcome(fixed, { resolved: true, resolvedBy: BOT })).toEqual({
      outcome: "fixed-model-only",
      humanEngaged: false,
      resolver: "bot",
    })
    expect(outcome(fixed, { resolved: false })).toEqual({ outcome: "fixed-model-only", humanEngaged: false })
    expect(outcome(prior({ where: "summary", status: "fixed", commentId: undefined })).outcome).toBe("fixed-model-only")
  })

  test("a dismissal marker gives the role; without one the job's own rule attributes it", () => {
    const dismissed = prior({ status: "dismissed" })
    expect(outcome(dismissed, undefined, { dismissal: { by: "w", why: "fp", hash: "a".repeat(12) } }).outcome).toBe(
      "dismissed-writer",
    )
    expect(
      outcome(
        dismissed,
        { resolved: true, resolvedBy: "alice" },
        { dismissal: { by: "a", why: "fp", hash: "a".repeat(12) } },
      ).outcome,
    ).toBe("dismissed-author")
    // The author is a writer here too: the author rule comes first.
    expect(outcome(dismissed, { resolved: false, reactions: [{ content: "THUMBS_DOWN", users: ["dev"] }] })).toEqual({
      outcome: "dismissed-author",
      humanEngaged: false,
      dismissedBy: "dev",
    })
    expect(outcome(dismissed, { resolved: true, resolvedBy: "alice" })).toEqual({
      outcome: "dismissed-writer",
      humanEngaged: true,
      resolver: "writer",
      dismissedBy: "alice",
    })
    expect(
      outcome(dismissed, { resolved: false, replies: [{ author: "alice", body: "False positive, this is fine." }] }),
    ).toMatchObject({ outcome: "dismissed-writer", dismissedBy: "alice" })
    // A non-writer's signal, a bot's, or none at all: the dismissal is unattributed, never a writer's or the author's.
    expect(outcome(dismissed, { resolved: true, resolvedBy: "carol" }).outcome).toBe("dismissed-unattributed")
    expect(outcome(dismissed, { resolved: true, resolvedBy: "helper[bot]" }, { isWriter: () => true }).outcome).toBe(
      "dismissed-unattributed",
    )
    expect(outcome(prior({ where: "summary", status: "dismissed", commentId: undefined })).outcome).toBe(
      "dismissed-unattributed",
    )
    // A blocking security finding the author alone tried to dismiss stays unattributed, as the job guards it.
    const guarded = prior({ status: "dismissed", severity: "blocking", category: "security" })
    expect(outcome(guarded, { resolved: true, resolvedBy: "dev" }).outcome).toBe("dismissed-unattributed")
  })

  test("an open finding is acknowledged by a reply that is not a dismissal or by a positive reaction", () => {
    const open = prior()
    expect(outcome(open, { resolved: false, replies: [{ author: "carol", body: "Good catch, will fix." }] })).toEqual({
      outcome: "acknowledged",
      humanEngaged: true,
    })
    expect(outcome(open, { resolved: false, replies: [{ author: "carol", body: "false positive" }] })).toEqual({
      outcome: "open-at-merge",
      humanEngaged: true,
    })
    expect(outcome(open, { resolved: false, replies: [{ author: "carol", body: "/vector dismiss" }] }).outcome).toBe(
      "open-at-merge",
    )
    // GraphQL spells reactions as uppercase enums.
    expect(outcome(open, { resolved: false, reactions: [{ content: "THUMBS_UP", users: ["carol"] }] }).outcome).toBe(
      "acknowledged",
    )
    expect(outcome(open, { resolved: false, reactions: [{ content: "ROCKET", users: ["dev"] }] })).toEqual({
      outcome: "acknowledged",
      humanEngaged: false,
    })
    expect(outcome(open, { resolved: false, reactions: [{ content: "HEART", users: [BOT] }] }).outcome).toBe(
      "open-at-merge",
    )
    expect(outcome(open, { resolved: false, reactions: [{ content: "EYES", users: ["carol"] }] })).toEqual({
      outcome: "open-at-merge",
      humanEngaged: true,
    })
    expect(outcome(open).outcome).toBe("open-at-merge")
    expect(outcome(prior({ status: "outdated" })).outcome).toBe("outdated")
  })

  test("human engagement leaves out the PR author and every bot", () => {
    expect(outcome(prior(), { resolved: false, replies: [{ author: "DEV", body: "Will fix." }] })).toEqual({
      outcome: "acknowledged",
      humanEngaged: false,
    })
    expect(outcome(prior(), { resolved: false, replies: [{ author: "helper[bot]", body: "Will fix." }] })).toEqual({
      outcome: "open-at-merge",
      humanEngaged: false,
    })
    expect(
      outcome(prior(), { resolved: false, reactions: [{ content: "LAUGH", users: ["carol"] }] }).humanEngaged,
    ).toBe(true)
    expect(outcome(prior({ status: "fixed" }), { resolved: true, resolvedBy: "carol" }).humanEngaged).toBe(true)
  })

  test("a deleted (ghost) account, which GraphQL names with an empty login, is nobody", () => {
    expect(outcome(prior(), { resolved: false, replies: [{ author: "", body: "Good catch, will fix." }] })).toEqual({
      outcome: "open-at-merge",
      humanEngaged: false,
    })
    expect(outcome(prior(), { resolved: false, reactions: [{ content: "THUMBS_UP", users: [""] }] })).toEqual({
      outcome: "open-at-merge",
      humanEngaged: false,
    })
    expect(outcome(prior({ status: "fixed" }), { resolved: true, resolvedBy: "" })).toEqual({
      outcome: "fixed-model-only",
      humanEngaged: false,
    })
  })

  test("bulk resolutions: five or more threads one actor resolved with no reply and no fix", () => {
    const entries = (count: number, options: { by?: (index: number) => string; reply?: string; fixed?: number } = {}) =>
      Array.from({ length: count }, (_, index) => ({
        prior: prior({
          id: `bulk${String(index).padStart(8, "0")}`,
          commentId: index + 1,
          status: index === options.fixed ? "fixed" : "open",
        }),
        thread: {
          resolved: true,
          resolvedBy: options.by?.(index) ?? "alice",
          replies: index === 0 && options.reply ? [{ author: options.reply, body: "why" }] : [],
        },
      }))
    expect(bulkResolved(entries(5), isBot).size).toBe(5)
    expect(bulkResolved(entries(4), isBot).size).toBe(0)
    expect(bulkResolved(entries(6, { by: () => "helper[bot]" }), isBot).size).toBe(0)
    expect(bulkResolved(entries(5, { reply: "carol" }), isBot).size).toBe(0)
    expect(bulkResolved(entries(5, { fixed: 0 }), isBot).size).toBe(0)
    // A bot's reply does not stop a batch, and case does not split an actor.
    expect(bulkResolved(entries(5, { reply: BOT, by: (index) => (index % 2 ? "ALICE" : "alice") }), isBot).size).toBe(5)
    expect(bulkResolved(entries(5, { by: (index) => (index % 2 ? "bob" : "alice") }), isBot).size).toBe(0)
  })

  test("agent authorship comes only from the trusted record; untrusted signals only split a PR out", () => {
    const pull = { number: 5, author: { login: "dev", type: "User" }, coAuthors: [] }
    expect(agentStratum(pull, new Set())).toBe("human")
    expect(agentStratum(pull, new Set([5]))).toBe("agent")
    expect(agentStratum({ ...pull, author: { login: "maker[bot]", type: "Bot" } }, new Set())).toBe("agent-signal")
    expect(agentStratum({ ...pull, author: { login: "maker", type: "Bot" } }, new Set([5]))).toBe("agent")
    expect(
      agentStratum({ ...pull, coAuthors: ["helper[bot] <1+helper[bot]@users.noreply.github.com>"] }, new Set()),
    ).toBe("agent-signal")
    expect(agentStratum({ ...pull, commitAuthors: [{ login: "maker", type: "Bot" }] }, new Set())).toBe("agent-signal")
    expect(agentStratum({ ...pull, coAuthors: ["Carol <carol@example.invalid>"] }, new Set())).toBe("human")
  })
})

describe("post-merge labels", () => {
  test("revert targets: git's sha form and GitHub's PR form, this repository only", () => {
    const sha = "a".repeat(40)
    expect(revertTargets({ subject: 'Revert "Add auth"', body: `This reverts commit ${sha}.` }, REPOSITORY)).toEqual({
      shas: [sha],
      pulls: [],
    })
    expect(
      revertTargets(
        { subject: 'Revert "Add auth" (#9)', body: "Reverts Acme/Widgets#2\nReverts other/repo#3" },
        REPOSITORY,
      ),
    ).toEqual({ shas: [], pulls: [2] })
    expect(revertTargets({ subject: "Add a thing", body: "" }, REPOSITORY)).toEqual({ shas: [], pulls: [] })
  })

  test("a merge reverts what the commits it brought in revert, outside its own branch", () => {
    const base = "a".repeat(40)
    const own = "b".repeat(40)
    const merge = {
      subject: "Merge pull request #5 from acme/revert-2-add-auth",
      body: 'Revert "Add auth"',
      merged: [
        { sha: "c".repeat(40), message: `Revert "Add auth (#2)"\n\nThis reverts commit ${base}.\n` },
        // The author backing out a work-in-progress commit of the same branch reverts nothing on the base.
        { sha: "d".repeat(40), message: `Revert "wip"\n\nThis reverts commit ${own}.\n` },
        { sha: own, message: "wip\n" },
        { sha: "e".repeat(40), message: "Reverts acme/widgets#2\n" },
      ],
    }
    expect(revertTargets(merge, REPOSITORY)).toEqual({ shas: [], pulls: [] })
    expect(revertsOf(merge, REPOSITORY)).toEqual({ shas: [base], pulls: [2] })
    expect(revertsOf({ ...merge, merged: [] }, REPOSITORY)).toEqual({ shas: [], pulls: [] })
  })

  test("a fix: never a revert, then a fix label, then a word-anchored title", () => {
    expect(fixKind({ subject: 'Revert "fix: crash"' }, { labels: ["bug"], title: "fix: crash" })).toBeUndefined()
    expect(fixKind({ subject: "Merge pull request #4" }, { labels: [], title: 'Revert "fix: crash"' })).toBeUndefined()
    expect(fixKind({ subject: "Handle it (#4)" }, { labels: ["type: bug"], title: "Handle it" })).toBe("label")
    expect(fixKind({ subject: "Handle it (#4)" }, { labels: ["not a bug"], title: "Handle it" })).toBeUndefined()
    expect(fixKind({ subject: "x" }, { labels: [], title: "Fix the crash" })).toBe("title")
    expect(fixKind({ subject: "fix: crash" })).toBe("title")
    expect(fixKind({ subject: "Add debug logging" })).toBeUndefined()
    // A known undercount: a fix whose subject mentions reverting is never counted.
    expect(fixKind({ subject: "fix: do not revert the cache" })).toBeUndefined()
    // A merge commit's subject names the source branch, so a merged PR is judged by its title.
    const merge = { subject: "Merge pull request #7 from acme/fix-revert-button", parents: ["1", "2"] }
    expect(fixKind(merge, { labels: ["bug"], title: "Fix the undo button" })).toBe("label")
    expect(fixKind(merge, { labels: [], title: "Fix the undo button" })).toBe("title")
    expect(fixKind(merge, { labels: ["bug"], title: 'Revert "Add auth"' })).toBeUndefined()
    expect(fixKind(merge)).toBeUndefined()
    // A squash or rebased commit's own subject still counts.
    expect(fixKind({ ...merge, parents: ["1"] }, { labels: ["bug"], title: "Fix the undo button" })).toBeUndefined()
  })

  test("fix labels: bug-fix variants count, a doubt or a negation does not", () => {
    const fix = (label: string) => FIX_LABEL.test(label) && !NOT_FIX_LABEL.test(label)
    for (const label of ["bug", "bugfix", "bug-fix", "type: bug", "kind/regression", "Hotfix", "bugs"])
      expect(fix(label)).toBe(true)
    for (const label of [
      "not a bug",
      "not-a-bug",
      "bug?",
      "debug",
      "invalid bug",
      "wontfix",
      "duplicate",
      "enhancement",
    ])
      expect(fix(label)).toBe(false)
  })

  test("a PR has matured exactly 90 days after its merge", () => {
    expect(matured(NOW - 90 * DAY, NOW)).toBe(true)
    expect(matured(NOW - 90 * DAY + 1, NOW)).toBe(false)
    expect(matured(NOW - 89 * DAY, NOW)).toBe(false)
    expect(matured(NOW - 91 * DAY, NOW)).toBe(true)
  })
})

describe("privacy and read-only access", () => {
  test("logins hash case-insensitively, under a per-run key", () => {
    expect(hashLogin("Alice", KEY)).toBe(hashLogin("alice", KEY))
    expect(hashLogin("alice", KEY)).toMatch(/^[0-9a-f]{16}$/)
    expect(hashLogin("alice", new Uint8Array(32).fill(8))).not.toBe(hashLogin("alice", KEY))
    expect(hashLogin("bob", KEY)).not.toBe(hashLogin("alice", KEY))
  })

  test("gh arguments: GET under the repository only, and read queries only", () => {
    expect(ghArgs({ kind: "get", path: "/repos/acme/widgets/pulls?state=closed&page=1" }, REPOSITORY)).toEqual([
      "api",
      "--method",
      "GET",
      "-H",
      "Accept: application/vnd.github+json",
      "/repos/acme/widgets/pulls?state=closed&page=1",
    ])
    expect(ghArgs({ kind: "get", path: "/repos/ACME/Widgets" }, REPOSITORY)).toContain("/repos/ACME/Widgets")
    for (const path of [
      "/repos/acme/other/pulls",
      "/repos/acme/widgets/../other/pulls",
      "/repos/acme/widgets/%2e%2E/x",
      "/repos/acme/widgets//pulls",
      "/repos/{owner}/{repo}/pulls",
      "/repos/acme/widgets/pulls x",
      "repos/acme/widgets",
      "/user",
      "/repos/acme/widgets/pulls?x=$(id)",
      "/repos/acme/widgets/pulls#top",
    ])
      expect(() => ghArgs({ kind: "get", path }, REPOSITORY)).toThrow()
    const query = ghArgs(
      { kind: "query", document: THREADS_QUERY, variables: { owner: "acme", number: 3 } },
      REPOSITORY,
    )
    expect(query.slice(0, 4)).toEqual(["api", "graphql", "-f", `query=${THREADS_QUERY}`])
    expect(query.slice(4)).toEqual(["-f", "owner=acme", "-F", "number=3"])
    // -F reads @file values, so a string never goes through it.
    expect(
      ghArgs({ kind: "query", document: THREADS_QUERY, variables: { cursor: "@/etc/passwd" } }, REPOSITORY),
    ).toEqual(expect.arrayContaining(["-f", "cursor=@/etc/passwd"]))
    for (const document of [
      "mutation { resolveReviewThread(input: {threadId: 1}) { thread { id } } }",
      "query { a } mutation { b }",
      "subscription { x }",
      "{ viewer { login } }",
    ])
      expect(() => ghArgs({ kind: "query", document, variables: {} }, REPOSITORY)).toThrow()
    expect(() => ghArgs({ kind: "query", document: THREADS_QUERY, variables: { number: 1.5 } }, REPOSITORY)).toThrow()
    expect(() => ghArgs({ kind: "query", document: THREADS_QUERY, variables: { query: "x" } }, REPOSITORY)).toThrow()
  })

  test("the gh reader runs gh with those arguments only, and a failed read throws", async () => {
    const seen: string[][] = []
    const reader = ghReader(REPOSITORY, async (args) => {
      seen.push(args)
      return { code: 0, stdout: '{"default_branch":"main"}', stderr: "" }
    })
    expect(await reader.get("/repos/acme/widgets")).toEqual({ default_branch: "main" })
    expect(seen[0]).toEqual(ghArgs({ kind: "get", path: "/repos/acme/widgets" }, REPOSITORY))
    await expect(reader.get("/repos/acme/other")).rejects.toThrow()
    expect(seen.length).toBe(1)
    const failing = ghReader(REPOSITORY, async () => ({ code: 1, stdout: "", stderr: "HTTP 404" }))
    await expect(failing.get("/repos/acme/widgets")).rejects.toThrow("HTTP 404")
  })

  test("git runs read-only subcommands only", () => {
    const repo = fixtureRepo("readonly")
    const git = localGit(repo.dir)
    expect(git(["rev-parse", "--is-shallow-repository"]).trim()).toBe("false")
    for (const args of [
      ["fetch"],
      ["push"],
      ["checkout", "main"],
      ["config", "user.name", "x"],
      ["config", "--get-regexp", "x", "y"],
      ["diff", "--output=/tmp/x", "HEAD"],
      ["diff", "--ext-diff", "HEAD"],
      ["blame", "--textconv", "HEAD", "--", "src/app.ts"],
      ["-c", "core.pager=x", "log"],
    ])
      expect(() => git(args)).toThrow()
    expect(READ_ONLY_GIT).toEqual(["rev-parse", "config", "log", "diff", "blame"])
  })

  test("a path after -- is only a path, whatever a PR author named it", () => {
    const dir = join(root, "odd-names")
    mkdirSync(dir, { recursive: true })
    fixtureGit(dir, ["init", "-q"])
    write(dir, { "-o": "a\nb\n", "--output=x": "c\n" })
    commitAll(dir, ["Odd names"], NOW - 10 * DAY)
    const git = localGit(dir)
    expect(git(["blame", "--line-porcelain", "--first-parent", "-L", "1,2", "HEAD", "--", "-o"])).toContain(
      "filename -o",
    )
    expect(git(["blame", "--line-porcelain", "-L", "1,1", "HEAD", "--", "--output=x"])).toContain("filename --output=x")
    expect(() => git(["log", "-o", "--", "x"])).toThrow()
    expect(() => git(["diff", "--output=/tmp/x", "HEAD", "--", "-o"])).toThrow()
  })

  test("a textconv driver in the clone's own config never runs on diff or blame", () => {
    const dir = join(root, "textconv")
    mkdirSync(dir, { recursive: true })
    fixtureGit(dir, ["init", "-q"])
    writeFileSync(join(dir, ".gitattributes"), "*.txt diff=evil\n")
    writeFileSync(join(dir, "f.txt"), "a\nb\n")
    commitAll(dir, ["one"], NOW - 10 * DAY)
    writeFileSync(join(dir, "f.txt"), "a\nB\n")
    commitAll(dir, ["two"], NOW - 9 * DAY)
    const sentinel = join(root, "textconv-ran")
    fixtureGit(dir, ["config", "diff.evil.textconv", `sh -c 'touch ${sentinel}; cat "$1"' -`])
    // The control: plain git runs the driver, so the setup would show it.
    fixtureGit(dir, ["blame", "--porcelain", "-L", "1,1", "HEAD", "--", "f.txt"])
    expect(existsSync(sentinel)).toBe(true)
    rmSync(sentinel)
    fixtureGit(dir, ["diff", "HEAD~1", "HEAD"])
    expect(existsSync(sentinel)).toBe(true)
    rmSync(sentinel)
    const git = localGit(dir)
    expect(git(["diff", "--unified=0", "-M", "HEAD~1", "HEAD"])).toContain("-b")
    expect(git(["blame", "--line-porcelain", "--first-parent", "-L", "1,2", "HEAD~1", "--", "f.txt"])).toContain(
      "filename f.txt",
    )
    expect(git(["log", "--first-parent", "--format=%H", "HEAD"]).trim().split("\n").length).toBe(2)
    expect(existsSync(sentinel)).toBe(false)
  })

  test("a shallow or partial clone is refused before GitHub is read", async () => {
    const source = fixtureRepo("source")
    const shallow = join(root, "shallow")
    fixtureGit(root, ["clone", "-q", "--depth", "1", `file://${source.dir}`, shallow])
    const recorder = fakeGitHub(source.world)
    await expect(
      collect(input(), { github: recorder.github, git: localGit(shallow), now: NOW, key: KEY }),
    ).rejects.toThrow("shallow")
    const partial = fixtureRepo("partial")
    fixtureGit(partial.dir, ["config", "remote.origin.promisor", "true"])
    await expect(
      collect(input(), { github: recorder.github, git: localGit(partial.dir), now: NOW, key: KEY }),
    ).rejects.toThrow("partial")
    expect(recorder.calls).toEqual([])
  })
})

describe("collection over a synthetic repository", () => {
  test("outcomes, reverts, fixes, escapes and later fixes, with no login, title, path or body kept", async () => {
    const repo = fixtureRepo("collect")
    const recorder = fakeGitHub(repo.world)
    const ledger = await collect(input(), { github: recorder.github, git: localGit(repo.dir), now: NOW, key: KEY })
    expect(ledger.schema).toBe(LEDGER_SCHEMA)
    expect(ledger.problems).toEqual([])
    expect(ledger.expires).toBe(new Date(NOW + LEDGER_DAYS * DAY).toISOString())
    // The README edit five days ago is the newest commit on the clone's base branch.
    expect(ledger.observedUntil).toBe(new Date(NOW - 5 * DAY).toISOString())
    expect(ledger.pulls.map((pull) => pull.number)).toEqual([1, 2, 3, 4, 6])
    const pull = (number: number) => ledger.pulls.find((entry) => entry.number === number)!
    expect(pull(1)).toMatchObject({
      author: hashLogin("dev-one", KEY),
      stratum: "human",
      reviewed: true,
      humanReview: true,
      cycleHours: 48,
      reviews: 2,
      rereviews: 1,
      costUsd: 0.5,
      statePruned: false,
      truncated: false,
      matured: true,
      fixes: [{ days: 80, lines: 1, kind: "label" }],
      lines: { edited: 1, flagged: 0, escaped: 1, unreviewed: 0, skipped: 0 },
    })
    expect(pull(1).band).toBeDefined()
    expect(pull(1).revertedDays).toBeUndefined()
    // Reverted ten days after its merge: neither positive nor clean, so no line counts.
    expect(pull(2)).toMatchObject({
      stratum: "agent-signal",
      humanReview: false,
      matured: true,
      revertedDays: 10,
      fixes: [],
    })
    expect(pull(2).lines).toBeUndefined()
    // #4 edits app.ts line 25 (three lines from a finding), line 3 of a file whose name git quotes non-ASCII in (next
    // to a finding), and line 9 of a file whose name git quotes even under core.quotePath=false (a line a summary
    // finding also names): all three are flagged.
    expect(pull(3)).toMatchObject({
      matured: true,
      fixes: [{ days: 30, lines: 3, kind: "label" }],
      lines: { edited: 3, flagged: 3, escaped: 0, unreviewed: 0, skipped: 0 },
    })
    expect(pull(4)).toMatchObject({ reviewed: false, humanReview: true, matured: true, fixes: [] })
    expect(pull(6)).toMatchObject({ stratum: "agent", matured: false })
    expect(pull(6).fixes).toBeUndefined()

    const finding = (id: string) => ledger.findings.find((entry) => entry.id === id)!
    expect(ledger.findings.map((entry) => [entry.pr, entry.id]).toSorted()).toEqual(
      [
        [1, "aaaaaaaaaaa1"],
        [1, "bbbbbbbbbbb1"],
        [1, "ccccccccccc1"],
        [2, "ddddddddddd2"],
        [3, "ddddddddddd3"],
        [3, "a0a0a0a0a0a3"],
        [3, "b0b0b0b0b0b3"],
        [6, "eeeeeeeeeee6"],
      ].toSorted(),
    )
    expect(finding("aaaaaaaaaaa1")).toEqual({
      pr: 1,
      id: "aaaaaaaaaaa1",
      where: "summary",
      severity: "concern",
      category: "bug",
      outcome: "open-at-merge",
      stratum: "human",
      humanEngaged: false,
      laterFixed: false,
    })
    expect(finding("bbbbbbbbbbb1")).toMatchObject({
      outcome: "fixed-confirmed-by-thread",
      resolver: "writer",
      humanEngaged: true,
      laterFixed: false,
    })
    expect(finding("ccccccccccc1")).toMatchObject({
      outcome: "dismissed-author",
      dismisser: hashLogin("dev-one", KEY),
      humanEngaged: true, // carol's thumbs-up on the comment
    })
    expect(finding("ddddddddddd2")).toMatchObject({ outcome: "outdated", stratum: "agent-signal" })
    expect(finding("ddddddddddd2").laterFixed).toBeUndefined()
    expect(finding("ddddddddddd3")).toMatchObject({ outcome: "acknowledged", humanEngaged: true, laterFixed: true })
    expect(finding("a0a0a0a0a0a3")).toMatchObject({ outcome: "open-at-merge", humanEngaged: false, laterFixed: true })
    expect(finding("b0b0b0b0b0b3")).toMatchObject({ where: "summary", outcome: "open-at-merge", laterFixed: true })
    expect(finding("eeeeeeeeeee6")).toMatchObject({
      outcome: "fixed-self-resolved",
      stratum: "agent",
      resolver: "author",
    })

    const text = JSON.stringify(ledger)
    for (const secret of [
      "dev-one",
      "alice",
      "carol",
      "bob",
      "agent-account",
      "Add feature one",
      "Handle the crash",
      "src/app.ts",
      "Good catch",
      "vector-finding",
      "one 12",
      "caf",
      "say ",
    ])
      expect(text).not.toContain(secret)

    // Every request was a GET under the repository or one of the two fixed queries; the paged comments were read.
    for (const call of recorder.calls) {
      if (call.kind === "get") expect(() => ghArgs({ kind: "get", path: call.path }, REPOSITORY)).not.toThrow()
      if (call.kind === "query") expect([THREADS_QUERY, THREAD_COMMENTS_QUERY]).toContain(call.document)
    }
    expect(
      recorder.calls.filter((call) => call.kind === "query" && call.document === THREAD_COMMENTS_QUERY).length,
    ).toBe(1)
    expect(recorder.calls.some((call) => call.kind === "get" && call.path.includes("/collaborators/alice/"))).toBe(true)
  })

  test("the call cap truncates PRs instead of reading past it, and says so", async () => {
    const repo = fixtureRepo("capped")
    const recorder = fakeGitHub(repo.world)
    const ledger = await collect(input(), {
      github: recorder.github,
      git: localGit(repo.dir),
      now: NOW,
      key: KEY,
      maxCalls: 3,
    })
    expect(ledger.pulls.every((pull) => pull.truncated)).toBe(true)
    expect(ledger.findings).toEqual([])
    expect(ledger.problems.some((problem) => problem.includes("API call cap"))).toBe(true)
    expect(recorder.calls.length).toBeLessThanOrEqual(3)
  })

  test("the call cap holds for every cap, and no read past it is sent", async () => {
    const repo = fixtureRepo("caps")
    for (const cap of [1, 2, 3, 10, 50, 205, 250]) {
      const recorder = fakeGitHub(repo.world)
      const ledger = await collect(input(), {
        github: recorder.github,
        git: localGit(repo.dir),
        now: NOW,
        key: KEY,
        maxCalls: cap,
      })
      expect(recorder.calls.length).toBeLessThanOrEqual(cap)
      // Whatever the cap, the ledger passes its own schema-2 check, as collect requires before it seals one.
      expect(ledgerProblem(ledger, NOW)).toBeUndefined()
      if (cap === 1) expect(ledger.problems[0]).toContain("merged-PR listing")
      if (cap === 205) expect(ledger.pulls.filter((pull) => !pull.truncated).map((pull) => pull.number)).toEqual([1])
    }
  })

  test("a clone whose base branch lacks a PR GitHub lists as merged is refused before any PR is read", async () => {
    const repo = fixtureRepo("stale")
    const late = {
      ...repo.world.pulls[0],
      number: 9,
      labels: [{ name: "bug" }],
      merged_at: new Date(NOW - DAY / 2).toISOString(),
      updated_at: new Date(NOW - DAY / 3).toISOString(),
      merge_commit_sha: "9".repeat(40),
    }
    for (const pulls of [
      // A fix merged after --until that the clone was fetched before: later reverts and fixes would be missing.
      [...repo.world.pulls, late],
      // A PR inside the window.
      repo.world.pulls.map((item) => (item.number === 3 ? { ...item, merge_commit_sha: "f".repeat(40) } : item)),
    ]) {
      const recorder = fakeGitHub({ ...repo.world, pulls })
      await expect(
        collect(input(), { github: recorder.github, git: localGit(repo.dir), now: NOW, key: KEY }),
      ).rejects.toThrow("fetch the base branch (git fetch origin main)")
      // The repository and the merged-PR listing only.
      expect(recorder.calls.length).toBe(2)
    }
    // A clone with every listed PR, collected 60 days after its history ends: maturity is measured to that end.
    const later = await collect(input(), {
      github: fakeGitHub(repo.world).github,
      git: localGit(repo.dir),
      now: NOW + 60 * DAY,
      key: KEY,
    })
    expect(later.observedUntil).toBe(new Date(NOW - 5 * DAY).toISOString())
    expect(later.pulls.map((pull) => [pull.number, pull.matured])).toEqual([
      [1, true],
      [2, true],
      [3, true],
      [4, true],
      [6, false],
    ])
  })

  test("a revert merged from a branch with GitHub's merge message reverts the PR it names", async () => {
    const repo = fixtureRepo("revert-merge", { revertMerge: true })
    const ledger = await collect(input(), {
      github: fakeGitHub(repo.world).github,
      git: localGit(repo.dir),
      now: NOW,
      key: KEY,
    })
    expect(ledger.problems).toEqual([])
    expect(ledger.pulls.map((pull) => pull.number)).toEqual([1, 2, 5, 3, 4, 6])
    const pull = (number: number) => ledger.pulls.find((entry) => entry.number === number)!
    // Reverted ten days after its merge, and the revert PR (labelled bug, titled as no revert) is no fix of it.
    expect(pull(2)).toMatchObject({ matured: true, revertedDays: 10, fixes: [] })
    expect(pull(2).lines).toBeUndefined()
    expect(ledger.findings.find((entry) => entry.id === "ddddddddddd2")!.laterFixed).toBeUndefined()
    expect(pull(5)).toMatchObject({ reviewed: false, matured: true, fixes: [] })
    expect(pull(5).revertedDays).toBeUndefined()
    expect(pull(1).lines).toEqual({ edited: 1, flagged: 0, escaped: 1, unreviewed: 0, skipped: 0 })
  })
})

describe("the report", () => {
  test("rates need 50 settled findings; smaller cells keep their count and interval", () => {
    const at = (blocking: number) => {
      const ledger = synthetic([
        ...repeat(MIN_VOLUME, () => finding(1, "acknowledged")),
        ...repeat(blocking, () => finding(1, "fixed-confirmed-by-thread", { severity: "blocking" })),
      ])
      return outcomeReport(ledger)
    }
    const small = at(MIN_SETTLED - 1)
    expect(small.resolution!.bySeverity.blocking!.confirmedFix).toMatchObject({ count: 49, total: 49, value: null })
    expect(small.resolution!.bySeverity.blocking!.confirmedFix.interval).not.toBeNull()
    expect(small.gradient.shares.blocking).toMatchObject({ count: 49, value: null })
    const enough = at(MIN_SETTLED)
    expect(enough.resolution!.bySeverity.blocking!.confirmedFix.value).toBe(1)
    expect(enough.gradient.shares.blocking!.value).toBe(1)
  })

  test("below 200 settled human-stratum findings in the last 90 days, only the gradient is reported", () => {
    expect(outcomeReport(synthetic(repeat(MIN_VOLUME, () => finding(1, "acknowledged")))).volume).toEqual({
      settled90: MIN_VOLUME,
      decision: "full",
    })
    const few = outcomeReport(synthetic(repeat(MIN_VOLUME - 1, () => finding(1, "acknowledged"))))
    expect(few.volume.decision).toBe("gradient-only")
    expect(few.resolution).toBeUndefined()
    expect(few.bands).toBeUndefined()
    expect(few.gradient).toBeDefined()
    // Settled findings on a PR merged before the 90 days do not count, and neither do other strata or open ones.
    const old = synthetic(repeat(MIN_VOLUME, () => finding(2, "acknowledged")))
    expect(outcomeReport(old).volume).toEqual({ settled90: 0, decision: "gradient-only" })
    const other = synthetic([
      ...repeat(MIN_VOLUME - 1, () => finding(1, "acknowledged")),
      finding(1, "acknowledged", { stratum: "agent-signal" }),
      finding(1, "open-at-merge"),
      finding(1, "fixed-model-only"),
    ])
    expect(outcomeReport(other).volume.decision).toBe("gradient-only")
  })

  test("untrusted splits only exclude: the same outcomes, left out of the human stratum", () => {
    const findings = [
      ...repeat(10, () => finding(1, "fixed-confirmed-by-thread", { severity: "blocking" })),
      ...repeat(10, () => finding(1, "acknowledged", { severity: "blocking" })),
    ]
    const split = findings.map((entry, index) => (index < 5 ? { ...entry, stratum: "agent-signal" as const } : entry))
    const human = outcomeReport(synthetic(findings))
    const excluded = outcomeReport(synthetic(split))
    expect(excluded.findings.byOutcome).toEqual(human.findings.byOutcome)
    expect(excluded.gradient.shares.blocking).toMatchObject({ count: 5, total: 15 })
    expect(excluded.split["agent-signal"]["fixed-confirmed-by-thread"]).toBe(5)
    expect(human.gradient.shares.blocking).toMatchObject({ count: 10, total: 20 })
  })

  test("the sensitivity row counts model-only and self-resolved fixes as fixed", () => {
    const report = outcomeReport(
      synthetic([
        finding(1, "fixed-confirmed-by-thread", { severity: "blocking" }),
        finding(1, "fixed-model-only", { severity: "blocking" }),
        finding(1, "fixed-self-resolved", { severity: "blocking" }),
        finding(1, "dismissed-writer", { severity: "blocking" }),
      ]),
    )
    expect(report.gradient.shares.blocking).toMatchObject({ count: 1, total: 2 })
    expect(report.sensitivity.shares.blocking).toMatchObject({ count: 3, total: 4 })
  })

  test("a reverted PR is neither positive nor clean for the fix rate", () => {
    const pulls = [
      pullOf(10, 200, { band: "high", revertedDays: 10, fixes: [{ days: 20, lines: 1, kind: "label", commit: 0 }] }),
      ...repeat(49, (index) => pullOf(100 + index, 200, { band: "high", fixes: [] })),
    ]
    const report = outcomeReport(
      synthetic(
        repeat(MIN_VOLUME, () => finding(1, "acknowledged")),
        pulls,
      ),
    )
    expect(report.bands!.rows.high.fixed[90]).toMatchObject({ count: 0, total: 49 })
    expect(report.bands!.rows.high.reverted[90]).toMatchObject({ count: 1, total: 50 })
  })

  test("band separation needs 200 matured PRs, then compares the low and high bands' intervals", () => {
    const report = (low: number, high: number, highPulls = MIN_MATURED / 2, reverts = [0, 0]) =>
      outcomeReport(
        synthetic(
          repeat(MIN_VOLUME, () => finding(1, "acknowledged")),
          [
            ...repeat(MIN_MATURED / 2, (index) =>
              pullOf(1000 + index, 200, {
                band: "low",
                fixes: index < low ? [{ days: 5, lines: 1, kind: "title", commit: 0 }] : [],
                ...(index >= MIN_MATURED / 2 - reverts[0] ? { revertedDays: 30 } : {}),
              }),
            ),
            ...repeat(highPulls, (index) =>
              pullOf(2000 + index, 200, {
                band: "high",
                fixes: index < high ? [{ days: 5, lines: 1, kind: "title", commit: 0 }] : [],
                ...(index >= highPulls - reverts[1] ? { revertedDays: 30 } : {}),
              }),
            ),
          ],
        ),
      )
    const bands = (low: number, high: number, highPulls = MIN_MATURED / 2) =>
      report(low, high, highPulls).bands!.separation
    expect(bands(10, 12)).toBe("overlap")
    expect(bands(0, 100)).toBe("separated")
    // 199 matured PRs with a band (the synthetic ledger's own matured PR has none).
    expect(bands(0, 99, MIN_MATURED / 2 - 1)).toBe("too-few")
    expect(renderOutcomes(outcomeReport(synthetic(repeat(MIN_VOLUME, () => finding(1, "acknowledged")))))).toContain(
      "Separation: too-few",
    )
    // 7 fixes over 200 PRs expect 3.5 in each band: fewer than 10, so no verdict (VS-46c item 1).
    const few = report(3, 4).bands!
    expect(few).toMatchObject({ separation: "underpowered", label: "unfiltered" })
    expect(few.expected.unfiltered).toEqual({ low: 3.5, high: 3.5 })
    expect(renderOutcomes(report(3, 4))).toContain(
      "Separation: underpowered, on the unfiltered follow-up-fix (SZZ-based, size-biased, unaudited) label. Fewer than 10 expected positives in the low or the high band: no verdict, not yet.",
    )
    // 10 and 12 fixes expect 11 in each band: enough to compare, and the bands overlap.
    expect(report(10, 12).bands!.expected.unfiltered).toEqual({ low: 11, high: 11 })
    // The sentence holds on a /1 ledger too, which has no measurement verdict to point to.
    expect(renderOutcomes(report(10, 12))).toContain(
      "Separation: overlap, on the unfiltered follow-up-fix (SZZ-based, size-biased, unaudited) label. The low and high bands' intervals overlap. That alone is not a verdict, only not yet.\n",
    )
    // Reverts decide when both bands expect at least 10 (item 2): 30 in each band of 100 overlap, 5 against 60 do not.
    const reverted = report(0, 0, MIN_MATURED / 2, [30, 30]).bands!
    expect(reverted).toMatchObject({
      separation: "overlap",
      label: "revert",
      expected: { revert: { low: 30, high: 30 } },
    })
    expect(report(0, 0, MIN_MATURED / 2, [5, 60]).bands).toMatchObject({ separation: "separated", label: "revert" })
    expect(renderOutcomes(report(0, 0, MIN_MATURED / 2, [5, 60]))).toContain(
      "Separation: separated, on the revert label. The low and high bands' intervals do not overlap.",
    )
    // A band's expected reverts are its PRs times the pooled rate: 20 reverts expect 10 in each band, 19 expect 9.5, and
    // then the fix label decides (underpowered, with no fix).
    expect(report(0, 0, MIN_MATURED / 2, [10, 10]).bands).toMatchObject({ label: "revert", separation: "overlap" })
    expect(report(0, 0, MIN_MATURED / 2, [9, 10]).bands).toMatchObject({
      label: "unfiltered",
      separation: "underpowered",
      expected: { revert: { low: 9.5, high: 9.5 } },
    })
    // Both bands must reach 10: with 150 high PRs, 20 reverts over 250 expect 8 in low and 12 in high.
    expect(report(0, 0, 150, [5, 15]).bands).toMatchObject({
      label: "unfiltered",
      expected: { revert: { low: 8, high: 12 } },
    })
  })

  test("the rendering opens with the internal-measurement line and its expiry", () => {
    const text = renderOutcomes(outcomeReport(synthetic([finding(1, "acknowledged")])))
    expect(
      text.startsWith(
        "# Outcome ledger report\n\nInternal measurement: no accuracy or comparative claim (D12). Sealed; expires 2027-05-06.",
      ),
    ).toBe(true)
    expect(text).toContain("only the severity gradient is reported")
    expect(text).toContain("| Severity | Share | Steps | Cycle p50 / p90 (h) |")
    expect(text).toContain("| concern | 0/1 [")
  })

  test("every rate is paired with cycle time over its own PRs", () => {
    const report = outcomeReport(
      synthetic(
        [
          ...repeat(MIN_VOLUME, () => finding(1, "acknowledged")),
          finding(3, "dismissed-writer", { severity: "blocking" }),
        ],
        [
          pullOf(3, 100, {
            cycleHours: 10,
            humanReview: false,
            lines: { edited: 1, flagged: 0, escaped: 1, unreviewed: 0, skipped: 0 },
          }),
        ],
      ),
    )
    expect(report.gradient.cycle).toEqual({ blocking: { p50: 10, p90: 10 }, concern: { p50: 48, p90: 48 }, nit: null })
    expect(report.humanPresence!.cycle).toEqual({ withHuman: { p50: 48, p90: 48 }, withoutHuman: { p50: 10, p90: 10 } })
    expect(report.escapes!.cycle).toEqual({ p50: 10, p90: 10 })
    expect(report.laterFixed!["dismissed-writer"].cycle).toEqual({ p50: 10, p90: 10 })
    expect(report.laterFixed!["open-at-merge"]).toEqual({
      share: expect.objectContaining({ count: 0, total: 0 }),
      cycle: null,
    })
    expect(report.writerDismissal!.cycle).not.toBeNull()
    expect(report.rereviews!.cycle).not.toBeNull()
    const text = renderOutcomes(report)
    expect(text).toContain("| blocking | 0/1 [")
    expect(text).toContain("| 10.0 / 10.0 |")
    expect(text).toContain("(cycle p50 / p90 10.0 / 10.0 h)")
    for (const line of text
      .split("\n")
      .filter((row) => /^- (Human presence|Writer|Escapes|Later|Re-reviews)/.test(row)))
      expect(line).toContain("cycle p50 / p90")
  })
})

describe("expiry", () => {
  const ledger = (overrides: Partial<OutcomeLedger> = {}) => ({ ...synthetic([]), ...overrides })
  test("a ledger opens until its expiry, which may be at most 180 days after a collection that is not in the future", () => {
    expect(ledgerProblem(ledger(), NOW)).toBeUndefined()
    const expires = Date.parse(ledger().expires)
    expect(ledgerProblem(ledger(), expires - 1)).toBeUndefined()
    expect(ledgerProblem(ledger(), expires)).toContain("expired")
    expect(ledgerProblem(ledger({ expires: new Date(NOW + (LEDGER_DAYS + 1) * DAY).toISOString() }), NOW)).toContain(
      "more than 180 days",
    )
    expect(
      ledgerProblem(
        ledger({ collectedAt: new Date(NOW + DAY).toISOString(), expires: new Date(NOW + 100 * DAY).toISOString() }),
        NOW,
      ),
    ).toContain("after now")
    expect(ledgerProblem(ledger({ expires: new Date(NOW - DAY).toISOString() }), NOW)).toContain("before")
    expect(ledgerProblem(ledger(), NOW - 2 * DAY)).toContain("after now")
    expect(ledgerProblem(ledger(), NOW - 60_000)).toBeUndefined()
    expect(ledgerProblem(ledger({ expires: "soon" }), NOW)).toContain("no expiry")
    expect(ledgerProblem({ ...ledger(), schema: "other" }, NOW)).toContain("not a")
    expect(ledgerProblem({ ...ledger(), pulls: "x" }, NOW)).toContain("malformed")
  })

  test("every entry the report reads is checked before it reads any", () => {
    const place = { path: "0123456789abcdef", fn: "fedcba9876543210" }
    const fixCommit = {
      date: "2026-07-10",
      kind: "label",
      deleted: { code: 1, blank: 0, comment: 0 },
      locations: [place],
    }
    const ledger = (overrides: Record<string, unknown> = {}) => ({
      ...synthetic([finding(1, "acknowledged")]),
      fixCommits: [fixCommit],
      ...overrides,
    })
    const kinds = { code: 1, blank: 1, comment: 0, whitespace: 0, moved: 1 }
    const fix = { days: 5, lines: 3, kind: "label", commit: 0, deleted: kinds }
    const filtered = { days: 5, lines: 1, kind: "label", commit: 0, location: place }
    const agent = (entries: { fixes: unknown[]; fixesFiltered: unknown[] }, extra: Record<string, unknown> = {}) =>
      ledger({ pulls: [{ ...pullOf(1, 200), stratum: "agent", ...entries, ...extra }] })
    expect(ledgerProblem(ledger(), NOW)).toBeUndefined()
    for (const bad of [
      ledger({ findings: [{ ...finding(1, "acknowledged"), outcome: "lost" }] }),
      ledger({ findings: [{ ...finding(1, "acknowledged"), stratum: "robot" }] }),
      ledger({ findings: [{ ...finding(1, "acknowledged"), severity: "critical" }] }),
      ledger({ findings: [{ ...finding(1, "acknowledged"), category: "vibes" }] }),
      ledger({ findings: [{ ...finding(1, "acknowledged"), pr: "1" }] }),
      ledger({ pulls: [{ ...pullOf(1, 30), cycleHours: "48" }] }),
      ledger({ pulls: [{ ...pullOf(1, 30), mergedAt: "yesterday" }] }),
      ledger({ pulls: [{ ...pullOf(1, 30), band: "extreme" }] }),
      ledger({ pulls: [{ ...pullOf(1, 30), reviews: -1 }] }),
      ledger({ merged: undefined }),
      ledger({ repository: 7 }),
      ledger({ observedUntil: undefined }),
      ledger({ problems: [1] }),
      // Schema 2's entries and the rules that tie them together.
      ledger({ subjects: undefined }),
      ledger({ subjects: { commits: 3, fix: -1, revert: 0 } }),
      ledger({ subjects: { commits: 3, fix: 2, revert: 2 } }),
      ledger({ fixCommits: undefined }),
      ledger({ fixCommits: [{ ...fixCommit, date: "soon" }] }),
      ledger({ fixCommits: [{ ...fixCommit, date: "2026-07-10T12:00:00.000Z" }] }),
      ledger({ fixCommits: [{ ...fixCommit, locations: [{ path: "src/app.ts" }] }] }),
      ledger({ fixCommits: [{ ...fixCommit, locations: repeat(MAX_FIX_LOCATIONS + 1, () => place) }] }),
      ledger({ pulls: [{ ...pullOf(1, 30), band: "high", score: 1 }] }),
      ledger({ pulls: [{ ...pullOf(1, 30), added: 3, deleted: 1 }] }),
      ledger({ pulls: [{ ...pullOf(1, 30), unreviewedFiles: undefined }] }),
      ledger({ pulls: [{ ...pullOf(1, 30), reviewed: false }] }),
      ledger({ pulls: [{ ...pullOf(1, 200), fixesFiltered: undefined }] }),
      ledger({ pulls: [{ ...pullOf(1, 200), filteredIncomplete: true, fixes: undefined, fixesFiltered: undefined }] }),
      ledger({ pulls: [{ ...pullOf(1, 200), fixes: [{ ...fix, deleted: { ...kinds, moved: 0 } }] }] }),
      ledger({ pulls: [{ ...pullOf(1, 200), fixes: [{ days: 5, lines: 1, kind: "label", commit: 0 }] }] }),
      ledger({ pulls: [{ ...pullOf(1, 200), fixesFiltered: [{ ...filtered, lines: 0 }] }] }),
      ledger({ pulls: [{ ...pullOf(1, 200), fixesFiltered: [{ ...filtered, location: { path: "SRC" } }] }] }),
      ledger({ pulls: [{ ...pullOf(1, 200), fixes: [{ ...fix, sameAgent: true }] }] }),
      ledger({ pulls: [{ ...pullOf(1, 200), stratum: "agent", fixes: [fix] }] }),
      // A fix entry names a fix commit of this ledger, of its own kind.
      ledger({ pulls: [{ ...pullOf(1, 200), fixes: [{ ...fix, commit: undefined }] }] }),
      ledger({ pulls: [{ ...pullOf(1, 200), fixes: [{ ...fix, commit: 1 }] }] }),
      ledger({ pulls: [{ ...pullOf(1, 200), fixesFiltered: [{ ...filtered, commit: -1 }] }] }),
      ledger({ pulls: [{ ...pullOf(1, 200), fixes: [{ ...fix, kind: "title" }] }] }),
      ledger({ pulls: [{ ...pullOf(1, 200), fixesFiltered: [filtered] }], fixCommits: [] }),
      // A missing same-agent flag needs the mark, the mark needs a missing flag, and both need an agent PR.
      agent({ fixes: [{ ...fix, sameAgent: true }], fixesFiltered: [filtered] }),
      agent({ fixes: [{ ...fix, sameAgent: true }], fixesFiltered: [] }, { sameAgentIncomplete: true }),
      ledger({ pulls: [{ ...pullOf(1, 200), fixes: [fix], sameAgentIncomplete: true }] }),
      ledger({ pulls: [{ ...pullOf(1, 30), stratum: "agent", sameAgentIncomplete: true }] }),
      // VS-46c's sealed rule, within its bounds when present, and a banded PR's score.
      ledger({ rule: null }),
      ledger({ rule: { ...MEASUREMENT_RULE, margin: 0 } }),
      ledger({ rule: { ...MEASUREMENT_RULE, margin: 1 } }),
      ledger({ rule: { ...MEASUREMENT_RULE, margin: Number.NaN } }),
      ledger({ rule: { ...MEASUREMENT_RULE, overhead: 0.3 } }),
      ledger({ rule: { ...MEASUREMENT_RULE, seed: -1 } }),
      ledger({ rule: { ...MEASUREMENT_RULE, seed: 2 ** 32 } }),
      ledger({ rule: { ...MEASUREMENT_RULE, seed: 1.5 } }),
      ledger({ rule: { ...MEASUREMENT_RULE, replicates: 99 } }),
      ledger({ rule: { ...MEASUREMENT_RULE, replicates: 10_001 } }),
      ledger({ rule: { margin: 0.05, overhead: 0.2, seed: 1 } }),
      ledger({ pulls: [withoutScore(pullOf(1, 200, { band: "low" }))] }),
      ledger({ pulls: [{ ...pullOf(1, 200), score: 3 }] }),
      // More PRs than the merged-PR listing can read, which would also leave the bootstrap's cost unbounded.
      ledger({ pulls: repeat(MAX_LEDGER_PULLS + 1, (index) => pullOf(index + 1, 30)) }),
    ])
      expect(ledgerProblem(bad, NOW)).toContain("malformed")
    // SF-03's collection sealed /2 ledgers without a rule: they still open, and the report applies the config's.
    const { rule, ...ruleless } = ledger()
    expect(rule).toEqual(MEASUREMENT_RULE)
    // What collection writes passes: kinds that sum to the lines, both labels, and an agent PR's same-agent flags.
    for (const good of [
      ledger({ pulls: [{ ...pullOf(1, 200), fixes: [fix], fixesFiltered: [filtered] }] }),
      ledger({ pulls: [pullOf(1, 200, { band: "low", score: 3 })] }),
      ledger({
        pulls: [
          {
            ...pullOf(1, 200),
            stratum: "agent",
            fixes: [{ ...fix, sameAgent: false }],
            fixesFiltered: [{ ...filtered, sameAgent: true }],
          },
        ],
      }),
      ledger({
        pulls: [
          { ...pullOf(1, 200), filteredIncomplete: true, fixes: [{ days: 5, lines: 1, kind: "label", commit: 0 }] },
        ],
      }),
      ledger({ fixCommits: [fixCommit, { ...fixCommit, locations: [], capped: true }] }),
      ledger({
        pulls: [{ ...pullOf(1, 200), fixes: [{ ...fix, commit: 1, kind: "title" }] }],
        fixCommits: [fixCommit, { ...fixCommit, kind: "title" }],
      }),
      agent({ fixes: [fix, { ...fix, sameAgent: false }], fixesFiltered: [filtered] }, { sameAgentIncomplete: true }),
      // A rule other than this source's still opens: the report applies the sealed one.
      ledger({ rule: { margin: 0.3, overhead: 0.5, seed: 0xffffffff, replicates: 100 } }),
      ledger({ rule: { ...MEASUREMENT_RULE, overhead: 0.1, replicates: 10_000, seed: 0 } }),
      ruleless,
      ledger({ pulls: repeat(MAX_LEDGER_PULLS, (index) => pullOf(index + 1, 30)) }),
    ])
      expect(ledgerProblem(good, NOW)).toBeUndefined()
    expect(ledgerProblem(ledger({ observedUntil: new Date(NOW + DAY).toISOString() }), NOW)).toContain(
      "history ends after",
    )
  })
})

describe("the command line", () => {
  test("collect refuses, before any read, in Actions, without a sealing key, and for an output a commit could reach", async () => {
    const repo = fixtureRepo("refusals")
    const recorder = fakeGitHub(repo.world)
    const gitCalls: string[][] = []
    const git = (args: readonly string[]) => {
      gitCalls.push([...args])
      return localGit(repo.dir)(args)
    }
    const out = join(root, "refusal-out")
    const deps = (env: Record<string, string | undefined>) => ({
      env,
      github: recorder.github,
      git,
      now: NOW,
      key: KEY,
    })
    const keyed = { [PUBLIC_KEY_ENV]: OWNER.publicKey }
    const args = (extra: string[] = [], target = out) => [
      "collect",
      "--repository",
      REPOSITORY,
      "--repo-dir",
      repo.dir,
      "--since",
      "2026-04-01",
      "--out",
      target,
      ...extra,
    ]
    const refused = async (argv: string[], env: Record<string, string | undefined>, text: string) => {
      const result = await main(argv, deps(env))
      expect(result.code).not.toBe(0)
      expect(result.stderr).toContain(text)
    }
    await refused(args(), { ...keyed, GITHUB_ACTIONS: "true" }, "never runs in GitHub Actions")
    await refused(args(), {}, PUBLIC_KEY_ENV)
    await refused(args(), { [PUBLIC_KEY_ENV]: "not a key" }, "Nothing was read")
    const small = generateKeyPairSync("rsa", { modulusLength: 1024 }).publicKey.export({ type: "spki", format: "pem" })
    await refused(args(), { [PUBLIC_KEY_ENV]: String(small) }, "3072")
    await refused(args([], join(repo.dir, "ledger")), keyed, "never committed")
    await refused(args([], join(REPO_ROOT, "..ledger")), keyed, "never committed")
    const tree = join(root, "a-work-tree")
    mkdirSync(join(tree, ".git"), { recursive: true })
    await refused(args([], join(tree, "deep", "out")), keyed, "never committed")
    // A symbolic link into a work tree, or into the clone, does not carry the output past the check.
    mkdirSync(join(tree, "deep"), { recursive: true })
    symlinkSync(join(tree, "deep"), join(root, "into-tree"))
    await refused(args([], join(root, "into-tree", "out")), keyed, "never committed")
    symlinkSync(repo.dir, join(root, "into-clone"))
    await refused(args([], join(root, "into-clone", "ledger")), keyed, "never committed")
    // A bare clone has no work tree, so only the clone check refuses an output inside it.
    const bare = join(root, "refusals-bare.git")
    fixtureGit(root, ["clone", "-q", "--bare", `file://${repo.dir}`, bare])
    await refused(
      args([], join(bare, "ledger")).map((arg) => (arg === repo.dir ? bare : arg)),
      keyed,
      "never committed",
    )
    await refused(args([], "relative/out"), keyed, "absolute")
    const record = join(repo.dir, "agents.json")
    writeFileSync(record, JSON.stringify({ repository: REPOSITORY, pulls: [6] }))
    await refused(args(["--agent-prs", record]), keyed, "not trusted")
    await refused(args(["--agent-prs", join(root, "into-clone", "agents.json")]), keyed, "not trusted")
    const garbled = join(root, "agents-garbled.json")
    writeFileSync(garbled, "{ repository: acme/widgets")
    await refused(args(["--agent-prs", garbled]), keyed, "--agent-prs is not valid JSON")
    await refused(args(["--agent-prs", join(root, "agents-none.json")]), keyed, "no readable file")
    const elsewhere = join(root, "agents-other.json")
    writeFileSync(elsewhere, JSON.stringify({ repository: "acme/other", pulls: [6] }))
    await refused(args(["--agent-prs", elsewhere]), keyed, "not acme/widgets")
    writeFileSync(elsewhere, JSON.stringify({ repository: REPOSITORY, pulls: ["6"] }))
    await refused(args(["--agent-prs", elsewhere]), keyed, "positive integers")
    await refused(args(["--since", "2026-13-01"]), keyed, "YYYY-MM-DD")
    await refused(args(["--bot", "not a login"]), keyed, "--bot")
    mkdirSync(join(root, "taken"), { recursive: true })
    writeFileSync(join(root, "taken", SEALED_LEDGER), "{}")
    await refused(args([], join(root, "taken")), keyed, "already exists")
    expect(recorder.calls).toEqual([])
    expect(gitCalls).toEqual([])
    expect(existsSync(out)).toBe(false)
  })

  test("collect writes only the sealed ledger and prints counts; open checks the expiry and writes the report", async () => {
    const repo = fixtureRepo("cli")
    const recorder = fakeGitHub(repo.world)
    const out = join(root, "cli-out")
    const record = join(root, "cli-agents.json")
    writeFileSync(record, JSON.stringify({ repository: REPOSITORY, pulls: [6] }))
    const result = await main(
      [
        "collect",
        "--repository",
        REPOSITORY,
        "--repo-dir",
        repo.dir,
        "--since",
        "2026-04-01",
        // Read as vector-app[bot]: the User account vector-app's thread on #1 is still not a finding.
        "--bot",
        "vector-app",
        "--agent-prs",
        record,
        "--out",
        out,
      ],
      { env: { [PUBLIC_KEY_ENV]: OWNER.publicKey }, github: recorder.github, now: NOW, key: KEY },
    )
    expect(result.stderr).toBe("")
    expect(result.code).toBe(0)
    expect(result.stdout).toContain("Collected 5 merged PR(s) (0 truncated), 8 finding(s) and 0 problem(s)")
    expect(readdirSync(out)).toEqual([SEALED_LEDGER])
    expect(statSync(out).mode & 0o777).toBe(0o700)
    expect(statSync(join(out, SEALED_LEDGER)).mode & 0o777).toBe(0o600)
    const sealedText = readFileSync(join(out, SEALED_LEDGER), "utf8")
    for (const plain of [LEDGER_SCHEMA, REPOSITORY, "fixed-confirmed-by-thread", hashLogin("dev-one", KEY)])
      expect(sealedText).not.toContain(plain)
    const files = unseal(JSON.parse(sealedText) as Sealed, OWNER.privateKey)
    expect(Object.keys(files)).toEqual([OUTCOME_LEDGER_FILE])
    const ledger = JSON.parse(files[OUTCOME_LEDGER_FILE]!.toString("utf8")) as OutcomeLedger
    expect(ledger.findings.length).toBe(8)
    expect(ledger.collectedAt).toBe(new Date(NOW).toISOString())

    const keyFile = join(root, "owner.pem")
    writeFileSync(keyFile, OWNER.privateKey)
    const opened = join(root, "opened")
    const open = await main(["open", join(out, SEALED_LEDGER), keyFile, opened], { now: NOW + DAY, env: {} })
    expect(open.code).toBe(0)
    expect(open.stdout).toContain("delete these files by then")
    expect(readdirSync(opened)).toEqual([REPORT_FILE])
    expect(readFileSync(join(opened, REPORT_FILE), "utf8")).toStartWith("# Outcome ledger report")
    expect(statSync(opened).mode & 0o777).toBe(0o700)
    expect(statSync(join(opened, REPORT_FILE)).mode & 0o777).toBe(0o600)
    const withLedger = join(root, "opened-ledger")
    expect(
      (await main(["open", join(out, SEALED_LEDGER), keyFile, withLedger, "--ledger"], { now: NOW, env: {} })).code,
    ).toBe(0)
    expect(readdirSync(withLedger).toSorted()).toEqual([OUTCOME_LEDGER_FILE, REPORT_FILE].toSorted())
    expect(statSync(join(withLedger, OUTCOME_LEDGER_FILE)).mode & 0o777).toBe(0o600)

    // Input that cannot be opened is refused with a message, before anything is written.
    const cannot = async (sealedFile: string, key: string, text: string) => {
      const target = join(root, "opened-refused")
      const result = await main(["open", sealedFile, key, target], { now: NOW, env: {} })
      expect(result).toMatchObject({ code: 1, stdout: "" })
      expect(result.stderr).toContain(text)
      expect(existsSync(target)).toBe(false)
    }
    const garbled = join(root, "garbled.sealed.json")
    writeFileSync(garbled, "{ not json")
    await cannot(garbled, keyFile, "not valid JSON")
    await cannot(join(root, "no-such.sealed.json"), keyFile, "Cannot read the sealed file")
    await cannot(join(out, SEALED_LEDGER), join(root, "no-such.pem"), "Cannot read the private key")
    const stranger = join(root, "stranger.pem")
    writeFileSync(
      stranger,
      generateKeyPairSync("rsa", { modulusLength: 3072 }).privateKey.export({ type: "pkcs8", format: "pem" }),
    )
    await cannot(join(out, SEALED_LEDGER), stranger, "The key does not open this file")
    const notKey = join(root, "not-a-key.pem")
    writeFileSync(notKey, "hello")
    await cannot(join(out, SEALED_LEDGER), notKey, "The key does not open this file")
    const sealedAs = (name: string, payload: string) => {
      const path = join(root, name)
      writeFileSync(path, JSON.stringify(seal({ [OUTCOME_LEDGER_FILE]: Buffer.from(payload) }, OWNER.publicKey)))
      return path
    }
    await cannot(sealedAs("bad-json.sealed.json", "{ oops"), keyFile, "it is not valid JSON")
    const lost = { ...ledger, findings: ledger.findings.map((entry) => ({ ...entry, outcome: "lost" })) }
    await cannot(sealedAs("bad-entry.sealed.json", JSON.stringify(lost)), keyFile, "malformed")
    await cannot(
      sealedAs("no-merged.sealed.json", JSON.stringify({ ...ledger, merged: undefined })),
      keyFile,
      "malformed",
    )
    // A symbolic link into a work tree does not carry the report there.
    const tree = join(root, "open-work-tree")
    mkdirSync(join(tree, ".git"), { recursive: true })
    mkdirSync(join(tree, "deep"), { recursive: true })
    symlinkSync(join(tree, "deep"), join(root, "open-into-tree"))
    expect(
      (
        await main(["open", join(out, SEALED_LEDGER), keyFile, join(root, "open-into-tree", "report")], {
          now: NOW,
          env: {},
        })
      ).code,
    ).toBe(2)
    expect(existsSync(join(tree, "deep", "report"))).toBe(false)

    const late = join(root, "opened-late")
    const expired = await main(["open", join(out, SEALED_LEDGER), keyFile, late], {
      now: NOW + LEDGER_DAYS * DAY,
      env: {},
    })
    expect(expired.code).toBe(1)
    expect(expired.stderr).toContain("expired")
    expect(existsSync(late)).toBe(false)
    expect(
      (await main(["open", join(out, SEALED_LEDGER), keyFile, join(REPO_ROOT, "..opened")], { now: NOW, env: {} }))
        .code,
    ).toBe(2)
    expect(
      (await main(["open", join(out, SEALED_LEDGER), keyFile, opened], { now: NOW, env: { GITHUB_ACTIONS: "true" } }))
        .code,
    ).toBe(1)
  })

  test("collect seals no ledger its own schema-2 check refuses", async () => {
    const repo = fixtureRepo("cli-unsealable")
    // A listing no GitHub sends, which collection reads and the decoder refuses: a PR numbered below 1.
    const world = {
      ...repo.world,
      pulls: repo.world.pulls.map((pull) => (pull.number === 2 ? { ...pull, number: -2 } : pull)),
    }
    const out = join(root, "cli-unsealable-out")
    const result = await main(
      ["collect", "--repository", REPOSITORY, "--repo-dir", repo.dir, "--since", "2026-04-01", "--out", out],
      { env: { [PUBLIC_KEY_ENV]: OWNER.publicKey }, github: fakeGitHub(world).github, now: NOW, key: KEY },
    )
    expect(result).toMatchObject({ code: 1, stdout: "" })
    expect(result.stderr).toContain(
      "The collected ledger fails its own check (the ledger is malformed): it was not sealed. Nothing was written.",
    )
    expect(existsSync(out)).toBe(false)
  })
})

describe("what the ledger may load and what it reuses", () => {
  // Every relative import, followed transitively (type-only imports load nothing and are left out by the scan). The
  // isolation layer comes from dataset.ts, whose core config.ts import brings in the privacy policy's catalog and
  // local-mode helpers: none of them sends anything.
  test("its import graph reaches no model-sending, provider, session, tool, MCP or Brain module", () => {
    const transpiler = new Bun.Transpiler({ loader: "ts" })
    const seen = new Set<string>()
    const bare = new Set<string>()
    const visit = (file: string) => {
      if (seen.has(file)) return
      seen.add(file)
      for (const entry of transpiler.scan(readFileSync(file, "utf8")).imports) {
        if (!entry.path.startsWith(".")) {
          bare.add(entry.path)
          continue
        }
        const base = resolve(dirname(file), entry.path).replace(/\.js$/, "")
        const found = [base, `${base}.ts`, `${base}.tsx`, join(base, "index.ts")].find(
          (candidate) => existsSync(candidate) && statSync(candidate).isFile(),
        )
        if (!found) throw new Error(`${file} imports ${entry.path}, which does not resolve`)
        visit(found)
      }
    }
    visit(join(import.meta.dir, "outcomes.ts"))
    const files = [...seen].map((file) => file.slice(REPO_ROOT.length + 1))
    for (const name of [
      "run.ts",
      "replay.ts",
      "ci.ts",
      "budget.ts",
      "fixture.ts",
      "desktop.ts",
      "judge.ts",
      "report.ts",
    ])
      expect(files).not.toContain(`script/vectorscope-eval/${name}`)
    expect(files.filter((file) => file.startsWith("script/")).toSorted()).toEqual(
      ["dataset.ts", "outcomes.ts", "paths.ts", "seal.ts"].map((name) => `script/vectorscope-eval/${name}`),
    )
    expect(
      files.filter(
        (file) =>
          !file.startsWith("packages/core/src/") &&
          !file.startsWith("packages/schema/src/") &&
          !file.startsWith("script/vectorscope-eval/"),
      ),
    ).toEqual([])
    expect(files.filter((file) => /(?:provider|session|tool|mcp|brain|llm)/i.test(file))).toEqual([])
    // Nothing reached can send a request, and only the ledger's gh and git readers and dataset.ts's git start a process.
    expect(files.filter((file) => /\bfetch\(/.test(readFileSync(join(REPO_ROOT, file), "utf8")))).toEqual([])
    expect(
      files
        .filter((file) => /spawn|execFile|child_process/.test(readFileSync(join(REPO_ROOT, file), "utf8")))
        .toSorted(),
    ).toEqual(["script/vectorscope-eval/dataset.ts", "script/vectorscope-eval/outcomes.ts"])
    expect(
      [...bare].filter(
        (name) =>
          !name.startsWith("node:") &&
          !["minimatch", "effect"].includes(name) &&
          !name.startsWith("@vectordevai/schema/"),
      ),
    ).toEqual([])
  })

  test("writer permissions are the review job's", () => {
    const source = readFileSync(join(REPO_ROOT, "packages/engine/src/cli/cmd/github.review-api.ts"), "utf8")
    const literal = /export const WRITE_PERMISSIONS: readonly Permission\[\] = \[([^\]]*)\]/.exec(source)?.[1] ?? ""
    expect([...literal.matchAll(/"([a-z]+)"/g)].map((match) => match[1])).toEqual([...WRITER_PERMISSIONS])
  })

  test("no runner draws review depth at random (VS-46 item 7)", () => {
    for (const file of [
      "packages/engine/src/review/run.ts",
      "packages/core/src/review/plan.ts",
      "packages/core/src/review/risk.ts",
      "packages/core/src/review/config.ts",
      "packages/app/src/features/pull-requests/ai-review.ts",
    ])
      expect(readFileSync(join(REPO_ROOT, file), "utf8")).not.toMatch(
        /Math\.random|randomInt|getRandomValues|randomBytes/,
      )
  })

  test("every outcome is named once", () => {
    expect(new Set(OUTCOMES).size).toBe(OUTCOMES.length)
  })
})

// The digests VS-46a's ledger and report gave on these synthetic histories, printed at f8543197 before schema 2: the v1
// fields of a schema-2 ledger, and every v1 report section, must stay byte-identical (addendum B §1.8, §1.9). Report
// sections are pinned one by one, so SF-04's rewording of the band-separation sentence re-pins only that section, and
// BAND_TABLE holds the rest of it to VS-46a's bytes.
const GRADIENT_ONLY = {
  "## Severity gradient": "109c7965eb66acfcbd2ad2180533b3d65f6ec3e4cf617ddcbfe1683e51318a02",
  "## Split out": "836cdacae23c82582f4256cfa1b3b43d2a012c1105ac1b4aff9ceafab685d08e",
}
const V1_DIGESTS = {
  collect: {
    ledger: "5050ae094062071fa08b7167749f8afa2d6c6f2d07e20b4f738409e1af11e3db",
    report: { "#": "a2440abf8af9dfd3046f9c4605a82ad807b5284d220da76210e00660522b20e5", ...GRADIENT_ONLY },
    calls: 32,
  },
  revertMerge: {
    ledger: "867098113c47c233d9c33c660d7881246fc6b0734cbdd8a4584df11c8f575fa2",
    report: { "#": "527f98a748b140e8b642297252fbcea65d1a222b7aa5ac419706db1b1eb34546", ...GRADIENT_ONLY },
    calls: 36,
  },
  later: {
    ledger: "fbc83dcbbb6860b89e93bba3a3a4b82255138da3d35712546bb68812972e498d",
    report: { "#": "b6510367b6135abcda17e94db1e823855cba65697e748758ab7eb386acd42408", ...GRADIENT_ONLY },
    calls: 32,
  },
  full: {
    "#": "8d3ebf400a8096a86bfbabbbc2d2da498475810f8720b6155756e6d032f6a766",
    "## Severity gradient": "22eee9e73613e5b4b1b8bb2af94adca274c8bdcdf748f64a20e724b2b5c7d1ca",
    "## Split out": "84e13e3fba075e2d22018dbfe0cf46ec2151fd73351c334def93755a1fbc3f02",
    "## Resolution": "3cfab86799e6ad2397561ab0875c587637d91c293306a61986067199964af3f5",
    // Re-pinned by VS-46c (SF-04): only the separation sentence moved (BAND_TABLE). VS-46a's was e2e6a8f127c1…
    "## Risk band against post-merge outcomes": "4aedb769cecbdf94112273533bcde100a007e4e49c4d6e96d33359a0fb5125b3",
    "## Problems": "8e8e3bcac7208276ebec51e8620f0058d2d87a558b70dfcff4fc14bc983e3a57",
  },
}

// The band section up to "Separation: ": VS-46a's table and its fix-rate sentence, which VS-46c leaves as they were.
const BAND_TABLE = "9d719ac7cfa29e5c66650a5776de2900559db1dbbc42a0f4cb76254f69258b1d"
const bandTable = (text: string) => {
  const part = text
    .split(/(?=\n## )/)
    .find((entry) => entry.startsWith("\n## Risk band against post-merge outcomes\n"))!
  return part.slice(0, part.indexOf("Separation: "))
}

describe("schema 2 collection (VS-46c, VS-46d)", () => {
  test("the v1 fields and report sections are byte-identical to VS-46a's", async () => {
    for (const [name, repo, now] of [
      ["collect", fixtureRepo("v1-collect"), NOW],
      ["revertMerge", fixtureRepo("v1-revert-merge", { revertMerge: true }), NOW],
      ["later", fixtureRepo("v1-later"), NOW + 60 * DAY],
    ] as const) {
      const recorder = fakeGitHub(repo.world)
      const ledger = await collect(input(), { github: recorder.github, git: localGit(repo.dir), now, key: KEY })
      expect(ledger.schema).toBe(LEDGER_SCHEMA)
      expect(digest(JSON.stringify(v1Of(ledger)))).toBe(V1_DIGESTS[name].ledger)
      // These histories are gradient-only, where a schema-2 report adds no section, so all of it is VS-46a's.
      const text = renderOutcomes(outcomeReport(ledger))
      expect(v1Only(text)).toBe(text)
      expect(sectionDigests(text)).toEqual(V1_DIGESTS[name].report)
      // The filtered pass adds no GitHub call on these histories: every commit it blames is one the v1 pass mapped.
      expect(recorder.calls.length).toBe(V1_DIGESTS[name].calls)
    }
    const full = fullSynthetic()
    const text = renderOutcomes(outcomeReport(full))
    // VS-46c changes only the separation sentence: the table and the fix-rate sentence before it keep VS-46a's bytes.
    expect(text).toContain(
      "Separation: underpowered, on the unfiltered follow-up-fix (SZZ-based, size-biased, unaudited) label.",
    )
    expect(digest(bandTable(text))).toBe(BAND_TABLE)
    expect(sectionDigests(v1Only(text))).toEqual(V1_DIGESTS.full)
    expect(text.split(/(?=\n## )/).map((part, index) => (index ? part.slice(1, part.indexOf("\n", 1)) : "#"))).toEqual([
      "#",
      ...MEASUREMENT_HEADINGS.slice(0, 2),
      "## Severity gradient",
      "## Split out",
      "## Resolution",
      "## Risk band against post-merge outcomes",
      ...MEASUREMENT_HEADINGS.slice(2),
      ...LABEL_HEADINGS,
      ...COHORT_HEADINGS,
      "## Problems",
    ])
    // The same ledger read as schema 1: every v1 section as before, and each VS-46c and VS-46d section unavailable.
    const legacy = renderOutcomes(outcomeReport(v1Of(full)))
    expect(sectionDigests(v1Only(legacy))).toEqual(V1_DIGESTS.full)
    expect(v1Only(legacy)).toBe(v1Only(text))
    expect(legacy).toContain(
      `${[...MEASUREMENT_HEADINGS, ...LABEL_HEADINGS, ...COHORT_HEADINGS].map((heading) => `\n${heading}\n\n${V1_UNAVAILABLE}\n`).join("")}\n## Problems\n`,
    )
    expect(legacy).not.toContain("## Schema 2 sections")
  })

  test("sizes, subjects, fix commits and the filtered label on the synthetic repository", async () => {
    const repo = fixtureRepo("schema2")
    const ledger = await collect(input(), {
      github: fakeGitHub(repo.world).github,
      git: localGit(repo.dir),
      now: NOW,
      key: KEY,
    })
    expect(ledgerProblem(ledger, NOW)).toBeUndefined()
    // VS-46c's rule, as the report config had it at collection, sealed with the ledger.
    expect(ledger.rule).toEqual(MEASUREMENT_RULE)
    expect(ledger.rule).not.toBe(MEASUREMENT_RULE)
    const pull = (number: number) => ledger.pulls.find((entry) => entry.number === number)!
    // The merged PR's reviewed files, as riskFeatures counts them: #3's lockfile is not reviewed.
    expect(ledger.pulls.map((entry) => [entry.number, entry.added, entry.deleted])).toEqual([
      [1, 10, 0],
      [2, 5, 0],
      [3, 30, 0],
      [4, 4, 4],
      [6, 5, 0],
    ])
    // Reviewed PRs only: #3's state left one file unreviewed. #1 has a writer's thread reply and a thread comment by the
    // User account named like the App (its author's issue comment is not counted); #3 has bob's thread reply and
    // carol's review with a body.
    expect(ledger.pulls.map((entry) => [entry.number, entry.unreviewedFiles, entry.humanComments])).toEqual([
      [1, 0, 2],
      [2, 0, 0],
      [3, 1, 2],
      [4, undefined, undefined],
      [6, 0, 0],
    ])
    // Seven first-parent commits in the window, none fix-prefixed ("Handle the crash" is a fix by its label only).
    expect(ledger.subjects).toEqual({ commits: 7, fix: 0, revert: 1 })
    const at = (path: string, fn?: string) => ({
      path: hashName("path", path, KEY),
      ...(fn ? { fn: hashName("fn", fn, KEY) } : {}),
    })
    // #4's four hunks, each with git's funcname (the line before the hunk, as no diff driver is set).
    expect(ledger.fixCommits).toEqual([
      {
        date: new Date(NOW - 120 * DAY).toISOString().slice(0, 10),
        kind: "label",
        deleted: { code: 4, blank: 0, comment: 0 },
        locations: [at("src/app.ts", "one 11"), at("src/app.ts", "three 24"), at(CAFE, "cafe 2"), at(QUOTED, "hi 8")],
      },
    ])
    const kinds = (code: number) => ({ code, blank: 0, comment: 0, whitespace: 0, moved: 0 })
    // Both labels name #4's fix commit by its index in fixCommits.
    expect(pull(1).fixes).toEqual([{ days: 80, lines: 1, kind: "label", commit: 0, deleted: kinds(1) }])
    expect(pull(1).fixesFiltered).toEqual([
      { days: 80, lines: 1, kind: "label", commit: 0, location: at("src/app.ts", "one 11") },
    ])
    // Three lines in three files, one each: the first in diff order is the location.
    expect(pull(3).fixes).toEqual([{ days: 30, lines: 3, kind: "label", commit: 0, deleted: kinds(3) }])
    expect(pull(3).fixesFiltered).toEqual([
      { days: 30, lines: 3, kind: "label", commit: 0, location: at("src/app.ts", "three 24") },
    ])
    expect(pull(2)).toMatchObject({ fixes: [], fixesFiltered: [] })
    // Not matured: neither label.
    expect(pull(6).fixesFiltered).toBeUndefined()
    // #6 is in the trusted record, but it has no fix to flag.
    expect(ledger.pulls.every((entry) => entry.filteredIncomplete === undefined)).toBe(true)
    const text = JSON.stringify(ledger)
    for (const secret of ["src/app.ts", "one 11", "three 24", "cafe 2", "hi 8", "caf", "say "])
      expect(text).not.toContain(secret)
    // Paths and function headers are hashed apart from logins and from each other, and case-sensitively.
    expect(new Set([hashLogin("src", KEY), hashName("path", "src", KEY), hashName("fn", "src", KEY)]).size).toBe(3)
    expect(hashName("path", "SRC", KEY)).not.toBe(hashName("path", "src", KEY))

    const reverted = fixtureRepo("schema2-merge", { revertMerge: true })
    const merge = await collect(input(), {
      github: fakeGitHub(reverted.world).github,
      git: localGit(reverted.dir),
      now: NOW,
      key: KEY,
    })
    // The revert branch's merge counts by its title line, "Remove auth for now": no revert-prefixed subject is left.
    expect(merge.subjects).toEqual({ commits: 7, fix: 0, revert: 0 })
  })

  test("a fix commit keeps at most MAX_FIX_LOCATIONS locations, and says when it had more", async () => {
    const dir = join(root, "many-places")
    mkdirSync(dir, { recursive: true })
    fixtureGit(dir, ["init", "-q"])
    const blocks = (value: string) =>
      textOf(
        Array.from({ length: MAX_FIX_LOCATIONS + 3 }, (_, index) => [`block${index}:`, `  ${value} ${index}`]).flat(),
      )
    write(dir, { "src/many.yml": blocks("old"), "README.md": "many\n" })
    commitAll(dir, ["Initial"], NOW - 300 * DAY)
    write(dir, { "README.md": "many, and more\n" })
    const c30 = commitAll(dir, ["Add more (#30)"], NOW - 200 * DAY)
    write(dir, { "src/many.yml": blocks("new") })
    const c31 = commitAll(dir, ["fix: every block (#31)"], NOW - 150 * DAY)
    const world = plainWorld(
      [
        listing(30, 200, "Add more", { login: "dev-one" }, c30),
        listing(31, 150, "fix: every block", { login: "dev-two" }, c31),
      ],
      { 30: [prFile("README.md", 1, 1)], 31: [prFile("src/many.yml", MAX_FIX_LOCATIONS + 3, MAX_FIX_LOCATIONS + 3)] },
    )
    const ledger = await collect(filterInput([]), {
      github: fakeGitHub(world).github,
      git: localGit(dir),
      now: NOW,
      key: KEY,
    })
    expect(ledgerProblem(ledger, NOW)).toBeUndefined()
    expect(ledger.fixCommits.length).toBe(1)
    const commit = ledger.fixCommits[0]
    expect(commit.deleted).toEqual({ code: MAX_FIX_LOCATIONS + 3, blank: 0, comment: 0 })
    expect(commit.capped).toBe(true)
    // The first ones in diff order, each block's own funcname (the yml has no driver: the line before the hunk).
    expect(commit.locations).toEqual(
      Array.from({ length: MAX_FIX_LOCATIONS }, (_, index) => ({
        path: hashName("path", "src/many.yml", KEY),
        fn: hashName("fn", `block${index}:`, KEY),
      })),
    )
  })

  test("subject counts: fix-prefixed and revert-prefixed lines, GitHub merges by their title, inside the window", () => {
    const window = { since: NOW - DAY, until: NOW + DAY }
    const commit = (subject: string, extra: { body?: string; merge?: boolean; at?: number } = {}) => ({
      at: extra.at ?? NOW,
      parents: extra.merge ? ["1".repeat(40), "2".repeat(40)] : ["1".repeat(40)],
      subject,
      body: extra.body ?? "",
    })
    const count = (...commits: ReturnType<typeof commit>[]) => subjectCounts(commits, window)
    for (const subject of ["fix: x", "fix(core): x", "Fix rounding", "Bugfix: x", "hotfix x", "  fixes the build"])
      expect(count(commit(subject))).toEqual({ commits: 1, fix: 1, revert: 0 })
    for (const subject of ["fixup! x", "prefix the name", "debug the parser", "Add a fix for x", "Fixture update"])
      expect(count(commit(subject))).toEqual({ commits: 1, fix: 0, revert: 0 })
    // A revert is never also a fix.
    for (const subject of ['Revert "Fix crash"', "revert: x", "Reverts the change"])
      expect(count(commit(subject))).toEqual({ commits: 1, fix: 0, revert: 1 })
    const merged = "Merge pull request #7 from acme/fix-revert-button"
    expect(count(commit(merged, { merge: true, body: "Add the button\n\nDetails." }))).toEqual({
      commits: 1,
      fix: 0,
      revert: 0,
    })
    expect(count(commit(merged, { merge: true, body: "Fix the button" }))).toEqual({ commits: 1, fix: 1, revert: 0 })
    expect(count(commit(merged, { merge: true, body: "Revert the button" }))).toEqual({
      commits: 1,
      fix: 0,
      revert: 1,
    })
    // No title line, or a commit that is not a merge: the subject, which starts with "Merge".
    expect(count(commit(merged, { merge: true }))).toEqual({ commits: 1, fix: 0, revert: 0 })
    expect(count(commit(merged, { merge: true, body: "\nFix later" }))).toEqual({ commits: 1, fix: 0, revert: 0 })
    expect(count(commit(merged, { body: "Fix the button" }))).toEqual({ commits: 1, fix: 0, revert: 0 })
    expect(
      count(
        commit("fix: a", { at: window.since - 1 }),
        commit("fix: b", { at: window.since }),
        commit("fix: c", { at: window.until }),
        commit("fix: d", { at: window.until + 1 }),
      ),
    ).toEqual({ commits: 2, fix: 2, revert: 0 })
  })

  test("deleted-line kinds come from a fixed prefix table per language", () => {
    for (const [path, text] of [
      ["src/a.ts", ""],
      ["src/a.ts", "  \t\r"],
      ["notes.xyz", "   "],
    ])
      expect(deletedLineKind(path, text)).toBe("blank")
    for (const [path, text] of [
      ["src/a.ts", "// x"],
      ["src/a.ts", "  /* x"],
      ["src/a.ts", " * x"],
      ["src/a.ts", "*/"],
      ["src/a.go", "// x"],
      ["src/a.py", "    # x"],
      ["db/a.sql", "-- x"],
      ["src/a.erl", "% x"],
      ["src/a.vue", "<!-- x -->"],
      ["src/a.vue", "// x"],
      ["docs/a.md", "<!-- x -->"],
      ["src/a.css", "/* x */"],
      ["src/a.scss", "// x"],
      ["src/a.php", "# x"],
      ["infra/a.tf", "# x"],
      ["Dockerfile", "# x"],
      ["Makefile", "# x"],
      [".gitignore", "# x"],
      ["src/a.lisp", "; x"],
      ["src/a.ps1", "<# x"],
    ])
      expect(deletedLineKind(path, text)).toBe("comment")
    for (const [path, text] of [
      ["src/a.c", "#include <x>"],
      ["src/a.c", "*ptr = 1;"],
      ["src/a.rs", "#[derive(Debug)]"],
      ["src/a.php", "#[Attr]"],
      ["src/a.ts", "--x;"],
      ["src/a.ts", "x = 1 // trailing"],
      ["src/a.css", "// not a CSS comment"],
      ["docs/a.md", "# A heading"],
      ["notes.xyz", "# x"],
      ["CMakeLists.txt", "# x"],
      ["bin/run.py", "#!/usr/bin/env python3"],
      // A backslash is part of a git path's name on every system: this file is named build\Makefile, not Makefile.
      ["build\\Makefile", "# x"],
    ])
      expect(deletedLineKind(path, text)).toBe("code")
  })

  test("the filtered label: -w, blank and comment-only lines, and the kinds of every blamed line", async () => {
    const repo = filterRepo("filter")
    const git = recordingGit(repo.dir)
    const ledger = await collect(filterInput([10, 12, 14]), {
      github: fakeGitHub(repo.world).github,
      git: git.git,
      now: NOW,
      key: KEY,
    })
    expect(ledgerProblem(ledger, NOW)).toBeUndefined()
    expect(ledger.problems).toEqual([])
    const pull = (number: number) => ledger.pulls.find((entry) => entry.number === number)!
    const kinds = (counts: Partial<Record<keyof NonNullable<LedgerFix["deleted"]>, number>>) => ({
      code: 0,
      blank: 0,
      comment: 0,
      whitespace: 0,
      moved: 0,
      ...counts,
    })
    const calc = { path: hashName("path", "src/calc.ts", KEY), fn: hashName("fn", CALC_HEADER, KEY) }
    const tool = { path: hashName("path", "src/tool.py", KEY), fn: hashName("fn", TUNE_HEADER, KEY) }
    // #12 deletes #10's comment, blank line and the py comment, edits #10's rate line and #include, and deletes two
    // lines #11 only reindented: the unfiltered blame gives #10 five lines and #11 two; the filtered one gives #10 the
    // rate line, the #include and the reindented console line, and #11 none (its other line goes to a direct commit).
    // `commit` is each fix's index in fixCommits: #12, #13, #14 and #15 in history order.
    expect(pull(10).fixes).toEqual([
      {
        days: 50,
        lines: 5,
        kind: "label",
        commit: 0,
        deleted: kinds({ code: 2, blank: 1, comment: 2 }),
        sameAgent: true,
      },
      { days: 60, lines: 1, kind: "title", commit: 1, deleted: kinds({ code: 1 }), sameAgent: false },
      { days: 70, lines: 1, kind: "label", commit: 2, deleted: kinds({ code: 1 }), sameAgent: false },
    ])
    expect(pull(10).fixesFiltered).toEqual([
      { days: 50, lines: 3, kind: "label", commit: 0, location: calc, sameAgent: true },
      { days: 60, lines: 1, kind: "title", commit: 1, location: calc, sameAgent: false },
      { days: 70, lines: 1, kind: "label", commit: 2, location: tool, sameAgent: false },
    ])
    expect(pull(11).fixes).toEqual([
      { days: 30, lines: 2, kind: "label", commit: 0, deleted: kinds({ whitespace: 2 }) },
      { days: 55, lines: 1, kind: "title", commit: 3, deleted: kinds({ code: 1 }) },
    ])
    expect(pull(11).fixesFiltered).toEqual([{ days: 55, lines: 1, kind: "title", commit: 3, location: calc }])
    for (const entry of ledger.pulls)
      for (const fix of entry.fixes ?? []) {
        const deleted = fix.deleted!
        expect(deleted.code + deleted.blank + deleted.comment + deleted.whitespace + deleted.moved).toBe(fix.lines)
      }
    expect(ledger.subjects).toEqual({ commits: 8, fix: 3, revert: 0 })
    const entry = { path: hashName("path", "src/main.c", KEY) }
    expect(ledger.fixCommits).toEqual([
      { date: day(150), kind: "label", deleted: { code: 4, blank: 1, comment: 2 }, locations: [calc, entry, tool] },
      { date: day(140), kind: "title", deleted: { code: 1, blank: 0, comment: 0 }, locations: [calc] },
      { date: day(130), kind: "label", deleted: { code: 1, blank: 0, comment: 0 }, locations: [tool] },
      { date: day(125), kind: "title", deleted: { code: 1, blank: 0, comment: 0 }, locations: [calc] },
    ])
    // Only read-only git. One whole-file -w -M -C blame per fix and file with a deleted code line (#12's py file has
    // only a comment), one -w blame where the two disagree, and the unfiltered blames by line run, as before.
    expect(git.calls.every((args) => (READ_ONLY_GIT as readonly string[]).includes(args[0]))).toBe(true)
    const blames = git.calls.filter((args) => args[0] === "blame")
    const filtered = blames.filter((args) => args.includes("-C"))
    expect(filtered.map((args) => args.slice(-1)[0])).toEqual([
      "src/calc.ts",
      "src/main.c",
      "src/calc.ts",
      "src/tool.py",
      "src/calc.ts",
    ])
    for (const args of filtered) {
      expect(args.slice(0, 6)).toEqual(["blame", "--line-porcelain", "--first-parent", "-w", "-M", "-C"])
      expect(args).not.toContain("-L")
    }
    const spaced = blames.filter((args) => args.includes("-w") && !args.includes("-C"))
    expect(spaced.map((args) => args.slice(0, 4).concat(args.slice(-1)))).toEqual([
      ["blame", "--line-porcelain", "--first-parent", "-w", "src/calc.ts"],
    ])
    const plain = blames.filter((args) => !args.includes("-w"))
    expect(plain.length).toBe(7)
    for (const args of plain) expect(args.slice(0, 4)).toEqual(["blame", "--line-porcelain", "--first-parent", "-L"])
  })

  test("moved lines: -M -C blames a block moved within a file and to another file on its original PR", async () => {
    const repo = moveRepo("move")
    const ledger = await collect(filterInput([]), {
      github: fakeGitHub(repo.world).github,
      git: localGit(repo.dir),
      now: NOW,
      key: KEY,
    })
    expect(ledgerProblem(ledger, NOW)).toBeUndefined()
    const pull = (number: number) => ledger.pulls.find((entry) => entry.number === number)!
    expect(ledger.pulls.map((entry) => [entry.number, entry.added, entry.deleted])).toEqual([
      [20, 10, 0],
      [21, 10, 10],
      [22, 2, 2],
    ])
    // Without -M -C both edited lines are the mover's; with them, the original PR's, one in each file.
    expect(pull(21).fixes).toEqual([
      {
        days: 20,
        lines: 2,
        kind: "label",
        commit: 0,
        deleted: { code: 0, blank: 0, comment: 0, whitespace: 0, moved: 2 },
      },
    ])
    expect(pull(21).fixesFiltered).toEqual([])
    expect(pull(20).fixes).toEqual([])
    expect(pull(20).fixesFiltered).toEqual([
      {
        days: 70,
        lines: 2,
        kind: "label",
        commit: 0,
        location: { path: hashName("path", "src/app.ts", KEY), fn: hashName("fn", ALPHA[1], KEY) },
      },
    ])
    expect(pull(22)).toMatchObject({ fixes: [], fixesFiltered: [] })
  })

  test("same-agent comes from the trusted record only; untrusted markers only exclude", async () => {
    const repo = filterRepo("same-agent")
    const run = (trusted: number[]) =>
      collect(filterInput(trusted), {
        github: fakeGitHub(repo.world).github,
        git: localGit(repo.dir),
        now: NOW,
        key: KEY,
      })
    const flags = (ledger: OutcomeLedger, number: number) => {
      const entry = ledger.pulls.find((item) => item.number === number)!
      return [...(entry.fixes ?? []), ...(entry.fixesFiltered ?? [])].map((fix) => fix.sameAgent)
    }
    const trusted = await run([10, 12, 14])
    // #10 by agent-account: fixed by #12 (agent-account, trusted), by #13 (agent-account, not in the record: only the
    // record decides) and by #14 (trusted, another author).
    expect(trusted.pulls.find((entry) => entry.number === 10)!.stratum).toBe("agent")
    expect(flags(trusted, 10)).toEqual([true, false, false, true, false, false])
    // #11 is a bot's (agent-signal, untrusted), fixed by its own bot author's #15: never flagged.
    expect(trusted.pulls.find((entry) => entry.number === 11)!.stratum).toBe("agent-signal")
    expect(flags(trusted, 11)).toEqual([undefined, undefined, undefined])
    // A record naming #13 too makes it the same agent's.
    expect(flags(await run([10, 12, 13, 14]), 10)).toEqual([true, true, false, true, true, false])
    const none = await run([])
    expect(none.pulls.flatMap((entry) => [...(entry.fixes ?? []), ...(entry.fixesFiltered ?? [])])).not.toContainEqual(
      expect.objectContaining({ sameAgent: expect.anything() }),
    )
    expect(JSON.stringify(none)).not.toContain("sameAgent")
  })

  test("a filtered lookup past the call cap leaves v1 as it was and marks the PRs it could touch", async () => {
    const repo = filterRepo("filter-capped", { chores: 200 })
    const full = fakeGitHub(repo.world)
    const uncapped = await collect(filterInput([10, 12, 14]), {
      github: full.github,
      git: localGit(repo.dir),
      now: NOW,
      key: KEY,
    })
    // The filtered pass's only read: #12's -w blame puts a line #11 reindented on a direct commit before the window,
    // which no v1 read looked up.
    expect(full.calls.at(-1)).toEqual({ kind: "get", path: `/repos/${REPOSITORY}/commits/${repo.direct}/pulls` })
    expect(uncapped.problems).toEqual([])
    const capped = await collect(filterInput([10, 12, 14]), {
      github: fakeGitHub(repo.world).github,
      git: localGit(repo.dir),
      now: NOW,
      key: KEY,
      maxCalls: full.calls.length - 1,
    })
    expect(ledgerProblem(capped, NOW)).toBeUndefined()
    expect({ ...v1Of(capped), problems: [] }).toEqual({ ...v1Of(uncapped), problems: [] })
    expect(capped.problems).toEqual([
      "the API call cap was reached in the filtered blame: PRs marked filteredIncomplete have an incomplete filtered label",
    ])
    // #12's label window holds #10 and #11: neither gets #12's kinds or filtered entry, and both are marked.
    const pull = (ledger: OutcomeLedger, number: number) => ledger.pulls.find((entry) => entry.number === number)!
    expect(capped.pulls.filter((entry) => entry.filteredIncomplete).map((entry) => entry.number)).toEqual([10, 11])
    expect(pull(capped, 10).fixes!.map((fix) => fix.deleted === undefined)).toEqual([true, false, false])
    expect(pull(capped, 10).fixesFiltered).toEqual(pull(uncapped, 10).fixesFiltered!.slice(1))
    expect(pull(capped, 11).fixesFiltered).toEqual(pull(uncapped, 11).fixesFiltered)
    for (const number of [12, 13, 14, 15]) expect(pull(capped, number)).toEqual(pull(uncapped, number))
    expect(capped.fixCommits).toEqual(uncapped.fixCommits)
  })

  test("a fix whose own PR the call cap left unknown gets no same-agent flag, and its PR says so", async () => {
    const repo = ownCapRepo("own-capped")
    const full = fakeGitHub(repo.world)
    const uncapped = await collect(filterInput([30]), {
      github: full.github,
      git: localGit(repo.dir),
      now: NOW,
      key: KEY,
    })
    // The last read: the direct fix commit's own PR, after the 200 chores'.
    expect(full.calls.at(-1)).toEqual({ kind: "get", path: `/repos/${REPOSITORY}/commits/${repo.fix}/pulls` })
    const pull = (ledger: OutcomeLedger) => ledger.pulls.find((entry) => entry.number === 30)!
    expect(pull(uncapped).stratum).toBe("agent")
    // Looked up, with no PR: a direct commit is in no trusted record, so not the same agent's.
    expect(pull(uncapped).fixes).toEqual([
      {
        days: 50,
        lines: 1,
        kind: "title",
        commit: 0,
        deleted: { code: 1, blank: 0, comment: 0, whitespace: 0, moved: 0 },
        sameAgent: false,
      },
    ])
    expect(pull(uncapped).fixesFiltered!.map((fix) => fix.sameAgent)).toEqual([false])
    expect(pull(uncapped).sameAgentIncomplete).toBeUndefined()
    const capped = await collect(filterInput([30]), {
      github: fakeGitHub(repo.world).github,
      git: localGit(repo.dir),
      now: NOW,
      key: KEY,
      maxCalls: full.calls.length - 1,
    })
    expect(ledgerProblem(capped, NOW)).toBeUndefined()
    // v1 reads the commit by its subject either way, and says the cap stopped a lookup.
    expect({ ...v1Of(capped), problems: [] }).toEqual({ ...v1Of(uncapped), problems: [] })
    expect(capped.problems).toEqual(["the API call cap was reached: some commits were not mapped to PRs"])
    // Unknown, not "not the same agent": no flag on either label, and the PR is marked.
    const { sameAgent: _flag, ...unflagged } = pull(uncapped).fixes![0]
    expect(pull(capped).fixes).toEqual([unflagged])
    expect(pull(capped).fixesFiltered!.map((fix) => fix.sameAgent)).toEqual([undefined])
    expect(pull(capped).sameAgentIncomplete).toBe(true)
    expect(pull(capped).filteredIncomplete).toBeUndefined()
  })

  test("the filtered blame is whole-file only for reviewed files up to MAX_FILTERED_BLAME_LINES lines", async () => {
    const repo = boundRepo("bounded")
    const git = recordingGit(repo.dir)
    const ledger = await collect(filterInput([]), {
      github: fakeGitHub(repo.world).github,
      git: git.git,
      now: NOW,
      key: KEY,
    })
    expect(ledgerProblem(ledger, NOW)).toBeUndefined()
    expect(ledger.problems).toEqual([])
    const pull = (number: number) => ledger.pulls.find((entry) => entry.number === number)!
    const kinds = (code: number, whitespace: number) => ({ code, blank: 0, comment: 0, whitespace, moved: 0 })
    // Every edited line is still attributed, and nothing is marked: a bounded blame drops no line. The unfiltered blame
    // puts big.ts's line on #42, which only reindented it; the bounded -w -M -C blame and the bounded -w blame give it
    // back to #40.
    expect(pull(40).fixes).toEqual([{ days: 50, lines: 3, kind: "label", commit: 0, deleted: kinds(3, 0) }])
    expect(pull(40).fixesFiltered).toEqual([
      { days: 50, lines: 4, kind: "label", commit: 0, location: { path: hashName("path", "package-lock.json", KEY) } },
    ])
    expect(pull(42).fixes).toEqual([{ days: 30, lines: 1, kind: "label", commit: 0, deleted: kinds(0, 1) }])
    expect(pull(42).fixesFiltered).toEqual([])
    expect(ledger.pulls.every((entry) => entry.filteredIncomplete === undefined)).toBe(true)
    // The lockfile (a skip rule) is never measured; the others are, against the empty tree, with literal pathspecs.
    const probes = git.calls.filter((args) => args[0] === "diff" && args.includes("--numstat"))
    expect(probes.map((args) => args.slice(-1)[0])).toEqual([
      ":(literal)src/big.ts",
      ":(literal)src/edge.ts",
      ":(literal)src/small.ts",
    ])
    for (const args of probes)
      expect(args.slice(0, 3)).toEqual(["diff", "--numstat", "4b825dc642cb6eb9a060e54bf8d69288fbee4904"])
    // The lockfile and the file one line over the bound are blamed by the deleted line's run; the file at the bound and
    // the small one whole.
    const filtered = git.calls.filter((args) => args[0] === "blame" && args.includes("-C"))
    const ranges = (args: string[]) => [args.slice(-1)[0], args.includes("-L") ? args[args.indexOf("-L") + 1] : "whole"]
    expect(filtered.map(ranges)).toEqual([
      ["package-lock.json", "2,2"],
      ["src/big.ts", "3,3"],
      ["src/edge.ts", "whole"],
      ["src/small.ts", "whole"],
    ])
    // The -w blame of the disputed line is bounded the same way.
    expect(
      git.calls.filter((args) => args[0] === "blame" && args.includes("-w") && !args.includes("-C")).map(ranges),
    ).toEqual([["src/big.ts", "3,3"]])
  })

  test("a /1 ledger opens read-only, as v1, with every schema-2 section unavailable", async () => {
    const repo = fixtureRepo("legacy")
    const ledger = await collect(input(), {
      github: fakeGitHub(repo.world).github,
      git: localGit(repo.dir),
      now: NOW,
      key: KEY,
    })
    const legacy = v1Of(ledger)
    const keyFile = join(root, "legacy.pem")
    writeFileSync(keyFile, OWNER.privateKey)
    const sealedAs = (name: string, payload: unknown) => {
      const path = join(root, name)
      writeFileSync(
        path,
        JSON.stringify(seal({ [OUTCOME_LEDGER_FILE]: Buffer.from(JSON.stringify(payload)) }, OWNER.publicKey)),
      )
      return path
    }
    const open = async (sealed: string, target: string) =>
      main(["open", sealed, keyFile, join(root, target), "--ledger"], { now: NOW + DAY, env: {} })
    const opened = await open(sealedAs("legacy.sealed.json", legacy), "legacy-opened")
    expect(opened.code).toBe(0)
    expect(opened.stdout).toContain(`It is a ${LEDGER_SCHEMA_V1} ledger, opened read-only as v1`)
    const current = await open(sealedAs("current.sealed.json", ledger), "current-opened")
    expect(current.code).toBe(0)
    expect(current.stdout).not.toContain("read-only")
    const report = readFileSync(join(root, "legacy-opened", REPORT_FILE), "utf8")
    expect(v1Only(report)).toBe(readFileSync(join(root, "current-opened", REPORT_FILE), "utf8"))
    for (const heading of [...MEASUREMENT_HEADINGS, ...LABEL_HEADINGS, ...COHORT_HEADINGS])
      expect(report).toContain(`\n${heading}\n\n${V1_UNAVAILABLE}\n`)
    expect(report).not.toContain("## Schema 2 sections")
    // Written back as it was read: still schema 1, never upgraded.
    expect(readFileSync(join(root, "legacy-opened", OUTCOME_LEDGER_FILE), "utf8")).toBe(
      JSON.stringify(legacy, null, 2) + "\n",
    )

    // Collection's check refuses it; only open's v1 check reads it, with every v1 bound.
    expect(ledgerProblem(legacy, NOW)).toContain(`not a ${LEDGER_SCHEMA}`)
    expect(v1LedgerProblem(legacy, NOW)).toBeUndefined()
    expect(v1LedgerProblem(ledger, NOW)).toContain(`not a ${LEDGER_SCHEMA_V1}`)
    expect(v1LedgerProblem(legacy, NOW + LEDGER_DAYS * DAY)).toContain("expired")
    expect(v1LedgerProblem({ ...legacy, collectedAt: new Date(NOW + DAY).toISOString() }, NOW)).toContain("after now")
    expect(v1LedgerProblem({ ...legacy, pulls: [{ ...legacy.pulls[0], band: "extreme" }] }, NOW)).toContain("malformed")
    const { subjects, ...without } = ledger
    expect(subjects).toBeDefined()
    expect(ledgerProblem(without, NOW)).toContain("malformed")
    for (const [name, payload, text] of [
      ["legacy-expired", { ...legacy, expires: new Date(NOW + DAY / 2).toISOString() }, "expired"],
      ["legacy-malformed", { ...legacy, findings: "x" }, "malformed"],
      ["legacy-unknown", { ...legacy, schema: "vectorscope-outcomes/9" }, `not a ${LEDGER_SCHEMA}`],
    ] as const) {
      const result = await main(["open", sealedAs(`${name}.sealed.json`, payload), keyFile, join(root, name)], {
        now: NOW + DAY,
        env: {},
      })
      expect(result).toMatchObject({ code: 1, stdout: "" })
      expect(result.stderr).toContain(text)
      expect(existsSync(join(root, name))).toBe(false)
    }
  })

  test("collection makes no write and no model call on the filter and move histories", async () => {
    for (const [repo, trusted] of [
      [filterRepo("no-writes-filter"), [10, 12, 14]],
      [moveRepo("no-writes-move"), []],
    ] as const) {
      const recorder = fakeGitHub(repo.world)
      const git = recordingGit(repo.dir)
      const before = fixtureGit(repo.dir, ["status", "--porcelain", "--untracked-files=all"])
      const head = fixtureGit(repo.dir, ["rev-parse", "HEAD"])
      await collect(filterInput([...trusted]), { github: recorder.github, git: git.git, now: NOW, key: KEY })
      // Every request is a GET under the repository or one of the two fixed queries; the client has no other method.
      for (const call of recorder.calls) {
        if (call.kind === "get") expect(() => ghArgs({ kind: "get", path: call.path }, REPOSITORY)).not.toThrow()
        if (call.kind === "query") expect([THREADS_QUERY, THREAD_COMMENTS_QUERY]).toContain(call.document)
      }
      expect(git.calls.every((args) => (READ_ONLY_GIT as readonly string[]).includes(args[0]))).toBe(true)
      expect(fixtureGit(repo.dir, ["status", "--porcelain", "--untracked-files=all"])).toBe(before)
      expect(fixtureGit(repo.dir, ["rev-parse", "HEAD"])).toBe(head)
    }
  })
})

// VS-46c's measurement (addendum B §1.8) over synthetic schema-2 histories: 400 single-file PRs merged 200 days ago, no
// tie-breaker unless a group says so, and the filtered and unfiltered labels on the same PRs.
const BEATS: Group[] = [
  { band: "high", lines: 1000, count: 40, fixed: 10 },
  // Five lines score low, so a floor moved these to medium: here they are mostly positive.
  { band: "medium", lines: 5, count: 60, fixed: 50 },
  { band: "low", lines: 100, count: 150, fixed: 20 },
  { band: "low", lines: 10, count: 150, fixed: 20 },
]
const NO_BETTER: Group[] = [
  { band: "high", lines: 1000, count: 40, fixed: 10 },
  { band: "medium", lines: 5, count: 60, fixed: 0 },
  { band: "low", lines: 100, count: 150, fixed: 60 },
  { band: "low", lines: 10, count: 150, fixed: 30 },
]
const UNDECIDED: Group[] = [
  { band: "high", lines: 1000, count: 40, fixed: 10 },
  { band: "medium", lines: 5, count: 60, fixed: 16 },
  { band: "low", lines: 100, count: 150, fixed: 40 },
  { band: "low", lines: 10, count: 150, fixed: 34 },
]
const FEW: Group[] = [
  { band: "high", lines: 1000, count: 40, fixed: 1 },
  { band: "medium", lines: 5, count: 60, fixed: 2 },
  { band: "low", lines: 100, count: 150, fixed: 1 },
  { band: "low", lines: 10, count: 150, fixed: 1 },
]
const MOVED_REASON = "fewer than 10 expected positives among the PRs a floor or the test-only rule moved"

describe("the measurement rule (VS-46c)", () => {
  const measure = (ledger: OutcomeLedger) => outcomeReport(ledger).measurement!
  const at20 = (label: { capture: { overhead: number; interval: [number, number] | null }[] }) =>
    label.capture.find((row) => row.overhead === MEASUREMENT_RULE.overhead)!

  test("base rates and expected positives come before anything else", () => {
    const ledger = measured(BEATS)
    const report = outcomeReport(ledger)
    const base = report.measurement!.base
    expect(base.pulls).toBe(400)
    expect(base.subjects).toMatchObject({
      commits: 100,
      fix: { count: 20, value: 0.2 },
      revert: { count: 5, value: 0.05 },
    })
    expect(base.fixed[90]).toMatchObject({ count: 100, total: 400 })
    expect(base.filtered[90]).toMatchObject({ count: 100, total: 400 })
    expect(report.measurement!.labels.filtered.low.expected).toBe(75)
    expect(report.measurement!.labels.filtered.high.expected).toBe(10)
    const text = renderOutcomes(report)
    const rates = section(text, "## Outcome base rates")
    expect(rates).toContain("fix-prefixed 20/100 20.0% [")
    expect(rates).toContain("revert-prefixed 5/100 5.0% [")
    expect(rates).toContain("filtered follow-up fix 75.0 / 10.0.")
    expect(rates).toContain(
      "Deciding label: filtered follow-up fix, SZZ-based, size-biased and unaudited (VS-46d's audit has not run).",
    )
    // Every section in order: base rates and the MDE first, the rest after the band table.
    const problem = renderOutcomes(outcomeReport({ ...ledger, problems: ["PR #9: its files stopped at 3000"] }))
    const order = [
      ...MEASUREMENT_HEADINGS.slice(0, 2),
      "## Severity gradient",
      "## Risk band against post-merge outcomes",
    ]
    const after = [...MEASUREMENT_HEADINGS.slice(2), ...LABEL_HEADINGS, ...COHORT_HEADINGS, "## Problems"]
    expect([...order, ...after].map((heading) => problem.indexOf(`\n${heading}\n`))).toEqual(
      [...order, ...after].map((heading) => problem.indexOf(`\n${heading}\n`)).toSorted((a, b) => a - b),
    )
    expect(problem.indexOf("\n## Outcome base rates\n")).toBeGreaterThan(0)

    // A PR fixed on the unfiltered label only counts there, and a PR marked filteredIncomplete leaves the filtered
    // population and is counted.
    const [first, second, ...rest] = ledger.pulls.filter((pull) => (pull.fixesFiltered ?? []).length > 0)
    const changed = {
      ...ledger,
      pulls: ledger.pulls.map((pull) =>
        pull === first
          ? { ...pull, fixesFiltered: [] }
          : pull === second
            ? {
                ...pull,
                filteredIncomplete: true as const,
                fixes: [{ days: 5, lines: 1, kind: "label" as const, commit: 0 }],
              }
            : pull,
      ),
    }
    expect(rest.length).toBe(98)
    expect(ledgerProblem(changed, NOW)).toBeUndefined()
    const split = measure(changed)
    expect(split.base.fixed[90]).toMatchObject({ count: 100, total: 400 })
    expect(split.base.filtered[90]).toMatchObject({ count: 98, total: 399 })
    expect(split.base.filteredIncomplete).toBe(1)
    expect(split.labels.filtered).toMatchObject({ pulls: 399, positives: 98 })
    expect(split.labels.revert.pulls).toBe(400)
    expect(renderOutcomes(outcomeReport(changed))).toContain("(1 marked, left out)")

    // 60 reverts over 250 PRs expect 24 in each band of 100: reverts decide, with no SZZ flag.
    const reverted = measured([
      { band: "high", lines: 1000, count: 100, reverted: 30 },
      { band: "low", lines: 10, count: 100, reverted: 30 },
      { band: "medium", lines: 200, count: 50 },
    ])
    const decided = outcomeReport(reverted)
    expect(decided.measurement!.deciding).toBe("revert")
    expect(decided.measurement!.labels.revert.low.expected).toBe(24)
    expect(decided.bands!.label).toBe("revert")
    const revertRates = section(renderOutcomes(decided), "## Outcome base rates")
    expect(revertRates).toContain("Deciding label: revert, which carries no blame-size bias")
    expect(revertRates).not.toContain("SZZ-based")
    // Nor does the verdict, or the filtered label's capture table, when reverts decide.
    expect(section(renderOutcomes(decided), "## Measurement verdict")).toContain(
      ", on the revert label at the top 20%: band − size",
    )
    expect(section(renderOutcomes(decided), "## Capture against size")).toContain(
      "\nFiltered follow-up fix: 0 positives",
    )
    // Reverted PRs leave both fix labels' populations.
    expect(decided.measurement!.base.filtered[90].total).toBe(190)
    // Both bands must reach 10: 20 reverts over 250 PRs expect 8 in the 100 low and 12 in the 150 high.
    const oneBand = measure(
      measured([
        { band: "high", lines: 1000, count: 150, reverted: 15 },
        { band: "low", lines: 10, count: 100, reverted: 5 },
      ]),
    )
    expect(oneBand.labels.revert.low.expected).toBe(8)
    expect(oneBand.labels.revert.high.expected).toBe(12)
    expect(oneBand.deciding).toBe("filtered")
  })

  test("the minimum detectable effect is printed for the observed counts before any verdict", () => {
    // p = 0.2 over 400 PRs, 280 low and 60 high, and 60 moved.
    const report = outcomeReport(
      measured([
        { band: "high", lines: 1000, count: 60, fixed: 12 },
        { band: "medium", lines: 5, count: 60, fixed: 12 },
        { band: "low", lines: 10, count: 280, fixed: 56 },
      ]),
    )
    const filtered = report.measurement!.labels.filtered
    expect(filtered.rate).toBe(0.2)
    expect(filtered.mde).toBeCloseTo((Z_ALPHA + Z_POWER) * Math.sqrt(0.16 * (1 / 280 + 1 / 60)), 12)
    expect(filtered.mde).toBeCloseTo(0.1594, 4)
    expect(filtered.floorMoved).toMatchObject({ pulls: 60, positives: 12, expected: 12 })
    expect(filtered.floorMoved.mde).toBeCloseTo(0.1447, 4)
    // No revert: its rate is 0, so nothing is detectable.
    expect(report.measurement!.labels.revert.mde).toBeNull()
    const text = renderOutcomes(report)
    const row = "| filtered follow-up fix | 400 | 80 (20.0%) | 280 / 60 | 15.9 | 60 | 12.0 | 14.5 |"
    expect(text).toContain(row)
    expect(text).toContain("| revert | 400 | 0 (0.0%) | 280 / 60 | n/a | 60 | 0.0 | n/a |")
    expect(text.indexOf(row)).toBeLessThan(text.indexOf("Verdict:"))
    expect(text.indexOf("\n## Minimum detectable effect\n")).toBeLessThan(text.indexOf("\n## Severity gradient\n"))
    // Z_ALPHA is the two-sided quantile at DEFAULT_CONFIDENCE, the level Wilson and the bootstrap interval use: a Wilson
    // bound L solves (p - L)^2 = z^2 L (1 - L) / n.
    const lower = wilson(20, 100)![0]
    expect((Math.sqrt(100) * (0.2 - lower)) / Math.sqrt(lower * (1 - lower))).toBeCloseTo(Z_ALPHA, 6)
    expect(DEFAULT_CONFIDENCE).toBe(0.95)
  })

  test("synthetic histories reach each verdict", () => {
    const beats = measure(measured(BEATS))
    expect(beats).toMatchObject({ verdict: "beats-size", deciding: "filtered", reasons: [] })
    expect(at20(beats.labels.filtered).interval![0]).toBeGreaterThan(0)
    const noBetter = measure(measured(NO_BETTER))
    expect(noBetter).toMatchObject({ verdict: "no-better-than-size", reasons: [] })
    expect(at20(noBetter.labels.filtered).interval![1]).toBeLessThan(MEASUREMENT_RULE.margin)
    const undecided = measure(measured(UNDECIDED))
    expect(undecided).toMatchObject({ verdict: "undecided", reasons: [] })
    const straddle = at20(undecided.labels.filtered).interval!
    expect(straddle[0]).toBeLessThanOrEqual(0)
    expect(straddle[1]).toBeGreaterThanOrEqual(MEASUREMENT_RULE.margin)
    // Five positives: every comparison expects fewer than 10.
    const few = measure(measured(FEW))
    expect(few.verdict).toBe("underpowered")
    expect(few.reasons).toEqual(["fewer than 10 expected positives in the low or the high band", MOVED_REASON])
    // The fix label's expectation decides at exactly 10: BEATS' high band expects 10.0 and is not underpowered.
    expect(beats.labels.filtered.high.expected).toBe(MIN_EXPECTED)
    // Each verdict's sentence. The deciding follow-up-fix label is flagged in the verdict line itself, and in its
    // capture table's heading.
    const flagged = "filtered follow-up fix (SZZ-based, size-biased, unaudited)"
    const beatsText = renderOutcomes(outcomeReport(measured(BEATS)))
    expect(beatsText).toContain(`Verdict: beats-size, on the ${flagged} label at the top 20%: band − size +28.0 [`)
    expect(section(beatsText, "## Capture against size")).toContain(
      "\nFiltered follow-up fix (SZZ-based, size-biased, unaudited): 100 positives among 400 PRs.",
    )
    const noBetterText = section(renderOutcomes(outcomeReport(measured(NO_BETTER))), "## Measurement verdict")
    expect(noBetterText).toContain(`Verdict: no-better-than-size, on the ${flagged} label`)
    expect(noBetterText).toContain(
      "riskOf is documented as a size, reach and sensitivity heuristic for this repository",
    )
    // The reach caveat stands beside that sentence, not only in the depth section.
    expect(noBetterText).toContain("Reach is untested here, because the band is computed without dependents.")
    expect(renderOutcomes(outcomeReport(measured(UNDECIDED)))).toContain(
      "The interval neither lies above 0 nor wholly below the margin: not yet.",
    )
    expect(renderOutcomes(outcomeReport(measured(FEW)))).toContain(
      `Verdict: underpowered, on the ${flagged} label at the top 20%: band − size`,
    )
    // No banded PR at all: underpowered, printed as n/a, and nothing throws.
    const none = outcomeReport(measured([]))
    expect(none.measurement).toMatchObject({ verdict: "underpowered", base: { pulls: 0 } })
    expect(none.measurement!.reasons).toEqual([
      "fewer than 200 matured PRs with a band (0)",
      "fewer than 10 expected positives in the low or the high band",
      MOVED_REASON,
      "no bootstrap interval: no replicate held a positive",
    ])
    expect(none.measurement!.labels.filtered.capture.map((row) => row.pulls)).toEqual([0, 0, 0])
    expect(renderOutcomes(none)).toContain("| 10% | 0 | 0 (n/a), n/a | 0 (n/a), n/a | n/a | n/a | n/a; n/a |")
    // With no PR the bootstrap runs no replicate, so none is counted as skipped.
    expect(none.measurement!.labels.revert).toMatchObject({ ran: 0, replicates: 0 })
    expect(renderOutcomes(none)).toContain(
      "Replicates with no positive are skipped: revert none run (no PR), filtered follow-up fix none run (no PR).",
    )
  })

  test("an interval wholly inside (0, margin) beats size: the order of the rules decides it", () => {
    // Under a sealed margin of 0.5, BEATS' interval lies above 0 and below the margin at once.
    const wide = measure(measured(BEATS, { ...MEASUREMENT_RULE, margin: 0.5 }))
    const interval = at20(wide.labels.filtered).interval!
    expect(interval[0]).toBeGreaterThan(0)
    expect(interval[1]).toBeLessThan(0.5)
    expect(wide.verdict).toBe("beats-size")
  })

  test("only the PRs a floor or the test-only rule moved differ from size", () => {
    // riskOf itself: likelyBand is its likelihood band, and a PR is moved exactly when its band is not that one.
    const features = (lines: number, extra: Partial<RiskFeatures> = {}): RiskFeatures => ({
      added: lines,
      deleted: 0,
      files: 1,
      dirs: 1,
      entropy: 0,
      sensitive: false,
      codeAdded: lines,
      codeDeleted: 0,
      testDelta: 0,
      testOnly: false,
      ...extra,
    })
    const cases = [
      features(116), // log2(117) is below the medium cutpoint
      features(117),
      features(551), // log2(552) is below the high cutpoint
      features(552),
      features(10, { sensitive: true }), // raised to medium
      features(0, { deleted: 30, codeAdded: 0, codeDeleted: 30 }), // deletion-heavy: raised to medium
      features(1000, { testOnly: true, testDelta: 1000 }), // lowered to low
      features(1000, { sensitive: true }), // high either way
      features(110, { dirs: 8 }), // a tie-breaker carries it across the medium cutpoint: not moved
    ].map((entry) => riskOf(entry))
    expect(cases.map((assessed) => [assessed.likelihood.band, assessed.band])).toEqual([
      ["low", "low"],
      ["medium", "medium"],
      ["medium", "medium"],
      ["high", "high"],
      ["low", "medium"],
      ["low", "medium"],
      ["high", "low"],
      ["high", "high"],
      ["medium", "medium"],
    ])
    for (const assessed of cases) expect(likelyBand(assessed.likelihood.score)).toBe(assessed.likelihood.band)
    const assessedLedger = measured([])
    const fromRisk = {
      ...assessedLedger,
      pulls: [
        ...assessedLedger.pulls,
        ...cases.map((assessed, index) =>
          pullOf(500 + index, 200, { band: assessed.band, score: assessed.likelihood.score }),
        ),
      ],
    }
    expect(measure(fromRisk).labels.revert.floorMoved.pulls).toBe(
      cases.filter((assessed) => assessed.band !== assessed.likelihood.band).length,
    )
    // At a cutpoint the score takes the lower band, as riskOf reads it at the default cutpoints readPull uses.
    expect(likelyBand(RISK_CUTPOINTS.medium)).toBe("low")
    expect(likelyBand(RISK_CUTPOINTS.high)).toBe("medium")
    const cut = (band: "low" | "medium" | "high", score: number) =>
      measure({ ...assessedLedger, pulls: [...assessedLedger.pulls, pullOf(600, 200, { band, score })] }).labels.revert
        .floorMoved.pulls
    expect([cut("low", RISK_CUTPOINTS.medium), cut("medium", RISK_CUTPOINTS.medium)]).toEqual([0, 1])
    expect([cut("medium", RISK_CUTPOINTS.high), cut("high", RISK_CUTPOINTS.high)]).toEqual([0, 1])

    // BEATS' 60 five-line medium PRs are the moved ones. Positives are spread evenly through each group, PR numbers
    // ascending, so the first n PRs of a group of c with k positives hold floor(n k / c).
    const moved = measure(measured(BEATS)).labels.filtered
    expect(moved.floorMoved).toMatchObject({ pulls: 60, positives: 50, expected: 15 })
    // Top 40: the 40 high PRs either way. Top 80: the high PRs, then 40 moved PRs (33 positive) against 40 of the
    // 100-line PRs (5 positive). Top 200: all 60 moved and 100 of the 100-line PRs (13) against all 150 of those (20)
    // and 10 ten-line PRs (1).
    expect(moved.capture.map((row) => [row.pulls, row.band.captured, row.size.captured])).toEqual([
      [40, 10, 10],
      [80, 43, 15],
      [200, 73, 31],
    ])
    expect(moved.capture.map((row) => row.difference)).toEqual([0, 0.28, 0.42])
    expect(moved.capture.map((row) => row.random)).toEqual([0.1, 0.2, 0.5])
    expect(moved.capture[1].band.lines).toBeCloseTo((40 * 1000 + 40 * 5) / 56_800, 12)
    expect(moved.capture[1].size.lines).toBeCloseTo((40 * 1000 + 40 * 100) / 56_800, 12)

    // The unmoved twin: every band reset to its score's own. Both orders are then the same, every replicate's difference
    // is 0, and no moved PR expects a positive: underpowered by the floor rule, not no-better-than-size.
    const beats = measured(BEATS)
    const twin = measure({
      ...beats,
      pulls: beats.pulls.map((pull) => (pull.score === undefined ? pull : { ...pull, band: likelyBand(pull.score) })),
    })
    expect(twin.labels.filtered.floorMoved.pulls).toBe(0)
    expect(twin.labels.filtered.capture.map((row) => [row.difference, row.interval])).toEqual([
      [0, [0, 0]],
      [0, [0, 0]],
      [0, [0, 0]],
    ])
    expect(twin.verdict).toBe("underpowered")
    expect(twin.reasons).toEqual([MOVED_REASON])

    // Tie-breakers alone reorder PRs of one size (the band order takes the scored-up group first, size takes PR
    // numbers), so capture differs, but none is moved: underpowered by the floor rule.
    const ties = measure(
      measured([
        { band: "high", lines: 1000, count: 40, fixed: 10 },
        { band: "low", lines: 50, count: 180, fixed: 0 },
        { band: "low", lines: 50, count: 180, fixed: 90, score: Math.log2(51) + 0.4 },
      ]),
    )
    expect(ties.labels.filtered.floorMoved.pulls).toBe(0)
    expect(ties.labels.filtered.capture[1].difference).toBeGreaterThan(0)
    expect(ties.verdict).toBe("underpowered")
    expect(ties.reasons).toEqual([MOVED_REASON])
  })

  test("a resample's top takes exactly its share of draws, and at least one PR", () => {
    // Every PR positive: whichever PRs either order puts first, its top n draws hold n positives, so every replicate's
    // difference is 0. A PR drawn several times across a threshold counts only for its places under it.
    const all = measure(
      measured([
        { band: "high", lines: 1000, count: 40, fixed: 40 },
        { band: "medium", lines: 5, count: 60, fixed: 60 },
        { band: "low", lines: 100, count: 150, fixed: 150 },
        { band: "low", lines: 10, count: 150, fixed: 150 },
      ]),
    )
    expect(all.labels.filtered.floorMoved.pulls).toBe(60)
    expect(all.labels.filtered.capture.map((row) => row.interval)).toEqual([
      [0, 0],
      [0, 0],
      [0, 0],
    ])
    // Four PRs: round(0.4) would take none at 10%, so the top is at least one PR.
    const four = measure(measured([{ band: "low", lines: 10, count: 4, fixed: 2 }]))
    expect(four.labels.filtered.capture.map((row) => row.pulls)).toEqual([1, 1, 2])
  })

  test("the low-band miss rate, and Effort@20% as unavailable", () => {
    const report = outcomeReport(measured(BEATS))
    const miss = report.measurement!.labels.filtered.lowMiss
    expect(miss.positives).toMatchObject({ count: 40, total: 100, value: 0.4 })
    expect(miss.pulls).toBe(0.75)
    expect(miss.lines).toBeCloseTo((150 * 100 + 150 * 10) / 56_800, 12)
    // No revert: the low band holds none of none.
    expect(report.measurement!.labels.revert.lowMiss.positives).toMatchObject({ count: 0, total: 0, value: null })
    const capture = section(renderOutcomes(report), "## Capture against size")
    expect(capture).toContain(
      "filtered follow-up fix 40/100 40.0% [30.9%, 49.8%] of positives in the low band, which holds 75.0% of PRs and 29.0% of changed lines",
    )
    expect(capture).toContain(
      "- Effort@20% of order(files) inside matured multi-file PRs: unavailable: schema 2 records no per-file fix data.",
    )
    // The wide-reach floor and tie-breaker reordering are named for what they are here.
    expect(capture).toContain("the sensitive-with-wide-reach floor cannot fire here")
    expect(capture).toContain("(compared here, but not counted as moved)")
    expect(capture).toContain("60 of the 400 PRs were moved by a floor or the test-only rule")
  })

  test("the bootstrap is seeded: reruns are identical, and the sealed rule is the one applied", () => {
    const ledger = measured(BEATS)
    const sealed = JSON.stringify(ledger)
    const first = outcomeReport(ledger)
    const second = outcomeReport(ledger)
    expect(second).toEqual(first)
    expect(renderOutcomes(second)).toBe(renderOutcomes(first))
    // The report reads the ledger and changes none of it.
    expect(JSON.stringify(ledger)).toBe(sealed)
    const filtered = first.measurement!.labels.filtered
    expect(filtered).toMatchObject({ ran: MEASUREMENT_RULE.replicates, replicates: MEASUREMENT_RULE.replicates })
    // No revert: every replicate it ran held no positive.
    expect(first.measurement!.labels.revert).toMatchObject({ ran: MEASUREMENT_RULE.replicates, replicates: 0 })
    expect(renderOutcomes(first)).toContain(
      "Replicates with no positive are skipped: revert 2000, filtered follow-up fix 0.",
    )
    expect(first.measurement).toMatchObject({ rule: MEASUREMENT_RULE, sealed: true, differs: false })
    expect(section(renderOutcomes(first), "## Measurement verdict")).toContain(
      "pre-registered in the report config before any collection and sealed into this ledger when it was collected: a margin of 5.0",
    )
    // A /2 ledger SF-03's collection sealed carries no rule: the report applies the config's, says so, and measures
    // exactly as under the same rule sealed.
    const { rule, ...ruleless } = ledger
    expect(rule).toEqual(MEASUREMENT_RULE)
    expect(ledgerProblem(ruleless, NOW)).toBeUndefined()
    const unsealed = outcomeReport(ruleless)
    expect(unsealed.measurement).toEqual({ ...first.measurement!, sealed: false })
    const unsealedVerdict = section(renderOutcomes(unsealed), "## Measurement verdict")
    expect(unsealedVerdict).toContain(
      "pre-registered in the report config before any collection: a margin of 5.0 capture-share points",
    )
    expect(unsealedVerdict).toContain("No rule sealed in this ledger: the report config's rule applies.")
    expect(unsealedVerdict).not.toContain("sealed into this ledger")
    expect(section(renderOutcomes(first), "## Measurement verdict")).not.toContain("No rule sealed")
    // Another seed draws other resamples.
    const reseeded = measure(measured(BEATS, { ...MEASUREMENT_RULE, seed: MEASUREMENT_RULE.seed + 1 }))
    expect(reseeded.labels.filtered.capture.map((row) => row.interval)).not.toEqual(
      filtered.capture.map((row) => row.interval),
    )
    expect(reseeded.differs).toBe(true)
    // A sealed margin of 0.30 puts UNDECIDED's interval wholly below it, and the report says the rule is not the
    // config's.
    const margin = outcomeReport(measured(UNDECIDED, { ...MEASUREMENT_RULE, margin: 0.3 }))
    expect(margin.measurement).toMatchObject({ verdict: "no-better-than-size", differs: true })
    const verdict = section(renderOutcomes(margin), "## Measurement verdict")
    expect(verdict).toContain(
      "a margin of 30.0 capture-share points, read at the top 20%, with 2000 bootstrap replicates",
    )
    expect(verdict).toContain(
      "The report config's rule differs now (margin 5.0 points, top 20%, 2000 replicates, seed 46003): the sealed rule is the one applied.",
    )
    expect(section(renderOutcomes(first), "## Measurement verdict")).not.toContain("differs")
    // The verdict's overhead is the sealed one too.
    const top = measure(measured(BEATS, { ...MEASUREMENT_RULE, overhead: 0.1 }))
    expect(top.verdict).toBe("undecided")
  })

  test("the old sentence is gone, and no new section says never", () => {
    const texts = [
      renderOutcomes(outcomeReport(fullSynthetic())),
      renderOutcomes(outcomeReport(v1Of(fullSynthetic()))),
      ...[BEATS, NO_BETTER, UNDECIDED, FEW, []].map((groups) => renderOutcomes(outcomeReport(measured(groups)))),
      renderOutcomes(
        outcomeReport(
          measured([
            { band: "high", lines: 1000, count: 100, reverted: 30 },
            { band: "low", lines: 10, count: 100, reverted: 30 },
          ]),
        ),
      ),
    ]
    for (const text of texts) {
      expect(text).not.toContain("never enable")
      expect(text).not.toContain("history risk areas for it")
      for (const heading of [
        "## Risk band against post-merge outcomes",
        ...MEASUREMENT_HEADINGS,
        ...LABEL_HEADINGS,
        ...COHORT_HEADINGS,
      ])
        expect(section(text, heading)).not.toMatch(/\bnever\b/i)
    }
    expect(texts[0]).toContain("\n## Risk band against post-merge outcomes\n")
  })

  test("depth rows are suppressed below their power, and reach is untested", () => {
    // This asserts the stated rule and the absence of rows only: no depth assignment exists yet (VS-46 item 7), so
    // there is no row for the rule to suppress. SF-05 or VS-46 item 7 adds the case computed on data.
    const depth = section(renderOutcomes(outcomeReport(measured(BEATS))), "## Depth and reach")
    expect(depth).toContain("Post-merge outcomes are a monitor, not a gate, for lens and depth decisions (P3-7).")
    expect(depth).toContain("so no depth row is shown")
    expect(depth).toContain("a depth row is suppressed unless each depth compared has at least 10 expected positives")
    expect(depth).toContain("Reach is untested: the band here is computed without dependents")
    // No row: the section holds no table.
    expect(depth.split("\n").filter((line) => line.startsWith("|"))).toEqual([])
  })

  test("a /1 ledger shows every VS-46c section as unavailable", () => {
    const current = measured(BEATS)
    const legacy = outcomeReport(v1Of(current))
    expect(legacy.measurement).toBeUndefined()
    const text = renderOutcomes(legacy)
    for (const heading of MEASUREMENT_HEADINGS)
      expect(section(text, heading)).toBe(`\n${heading}\n\n${V1_UNAVAILABLE}\n`)
    // Its v1 sections are the /2 report's.
    expect(v1Only(text)).toBe(v1Only(renderOutcomes(outcomeReport(current))))
    // In the gradient-only decision too: a /1 report still names each section, a /2 report prints none.
    const gradient = { ...current, findings: [] }
    expect(renderOutcomes(outcomeReport(v1Of(gradient)))).toContain(`\n## Outcome base rates\n\n${V1_UNAVAILABLE}\n`)
    const plain = renderOutcomes(outcomeReport(gradient))
    expect(v1Only(plain)).toBe(plain)
    expect(outcomeReport(gradient).measurement).toBeUndefined()
  })

  test("a dry run on a sealed synthetic ledger prints every section and writes only the report", async () => {
    const keyFile = join(root, "measure.pem")
    writeFileSync(keyFile, OWNER.privateKey)
    const sealedFile = join(root, "measure.sealed.json")
    writeFileSync(
      sealedFile,
      JSON.stringify(seal({ [OUTCOME_LEDGER_FILE]: Buffer.from(JSON.stringify(measured(BEATS))) }, OWNER.publicKey)),
    )
    const sealedBytes = readFileSync(sealedFile)
    const listing = readdirSync(root).toSorted()
    const target = join(root, "measure-opened")
    const result = await main(["open", sealedFile, keyFile, target], { now: NOW + DAY, env: {} })
    expect(result).toMatchObject({ code: 0, stderr: "" })
    expect(readdirSync(target)).toEqual([REPORT_FILE])
    const report = readFileSync(join(target, REPORT_FILE), "utf8")
    for (const heading of [
      "## Severity gradient",
      "## Split out",
      "## Resolution",
      "## Risk band against post-merge outcomes",
      ...MEASUREMENT_HEADINGS,
      ...LABEL_HEADINGS,
      ...COHORT_HEADINGS,
    ])
      expect(report).toContain(`\n${heading}\n`)
    expect(report).toContain("Verdict: beats-size")
    // `open` reads no eval artifact, so the section says no drops were read, not that none were recorded.
    expect(section(report, "## Latent forecasts")).toContain(`Status: ${NO_DROPS_READ}.`)
    expect(report).not.toContain(NO_DROPS + ".")
    expect(readFileSync(sealedFile).equals(sealedBytes)).toBe(true)
    expect(readdirSync(root).toSorted()).toEqual([...listing, "measure-opened"].toSorted())
    // A ledger SF-03's collection sealed, with no rule, opens the same way under the config's rule.
    const { rule: _rule, ...ruleless } = measured(BEATS)
    const unsealedFile = join(root, "measure-ruleless.sealed.json")
    writeFileSync(
      unsealedFile,
      JSON.stringify(seal({ [OUTCOME_LEDGER_FILE]: Buffer.from(JSON.stringify(ruleless)) }, OWNER.publicKey)),
    )
    const ruleTarget = join(root, "measure-ruleless-opened")
    expect(await main(["open", unsealedFile, keyFile, ruleTarget], { now: NOW + DAY, env: {} })).toMatchObject({
      code: 0,
      stderr: "",
    })
    expect(readdirSync(ruleTarget)).toEqual([REPORT_FILE])
    expect(readFileSync(join(ruleTarget, REPORT_FILE), "utf8")).toContain(
      "No rule sealed in this ledger: the report config's rule applies.",
    )
  })
})

// VS-46d items 1 to 4 (addendum B §1.9; SF-05a) over synthetic schema-2 histories and the collected filter, move and
// add-only histories. Every labels file here is a fixture: the owner's hand labels stay outside the repository.
describe("the label audit and label quality (VS-46d, SF-05a)", () => {
  const quality = (ledger: OutcomeLedger, audit?: { sample: AuditSample; labels: AuditLabels }) =>
    outcomeReport(ledger, audit).labelQuality!
  const keyFile = join(root, "audit.pem")
  writeFileSync(keyFile, OWNER.privateKey)
  const sealTo = (name: string, payload: unknown) => {
    const path = join(root, name)
    writeFileSync(
      path,
      JSON.stringify(seal({ [OUTCOME_LEDGER_FILE]: Buffer.from(JSON.stringify(payload)) }, OWNER.publicKey)),
    )
    return path
  }
  // Read through the decoder open uses, so the answers are what `open --labels` would read.
  const labelsOf = (file: unknown) => {
    const read = auditLabels(JSON.stringify(file), REPOSITORY, NOW + DAY)
    if (typeof read === "string") throw new Error(read)
    return read.answers
  }

  test("the audit sample is seeded and deterministic, with stable hashed ids", async () => {
    const ledger = measured(BEATS)
    const sample = auditSample(ledger, KEY)
    expect(sample).toMatchObject({
      schema: AUDIT_SCHEMA,
      repository: REPOSITORY,
      branch: "main",
      collectedAt: ledger.collectedAt,
      expires: ledger.expires,
      question: AUDIT_QUESTION,
    })
    // The filtered label's own population: the measurement's.
    const filtered = outcomeReport(ledger).measurement!.labels.filtered
    expect(sample.population).toEqual({ positives: filtered.positives, negatives: filtered.pulls - filtered.positives })
    expect(sample.population).toEqual({ positives: 100, negatives: 300 })
    const positives = sample.entries.filter((entry) => entry.label === "positive")
    const negatives = sample.entries.filter((entry) => entry.label === "negative")
    expect([positives.length, negatives.length]).toEqual([AUDIT_DRAW, AUDIT_DRAW])
    expect(sample.entries).toEqual([...positives, ...negatives])
    for (const group of [positives, negatives])
      expect(group.map((entry) => entry.id)).toEqual(group.map((entry) => entry.id).toSorted())
    const ids = sample.entries.map((entry) => entry.id)
    expect(ids.every((id) => /^[0-9a-f]{16}$/.test(id))).toBe(true)
    expect(new Set(ids).size).toBe(ids.length)
    for (const entry of sample.entries) {
      expect(Object.keys(entry)).toEqual(["id", "pr", "label", "filtered", "unfiltered", "fixInducing"])
      expect(entry.fixInducing).toBeNull()
    }
    // A positive shows its fixes with the fix commit's day; a negative has no filtered fix within 90 days.
    expect(positives[0].filtered).toEqual([{ date: "2026-07-10", days: 5, lines: 1, kind: "label" }])
    expect(positives[0].unfiltered).toEqual([{ date: "2026-07-10", days: 5, lines: 1, kind: "label" }])
    expect(negatives.every((entry) => !entry.filtered.length && !entry.unfiltered.length)).toBe(true)
    // The keyed hash orders the draw, not the PR numbers.
    const lowest = ledger.pulls
      .filter((pull) => (pull.fixesFiltered ?? []).length > 0)
      .map((pull) => pull.number)
      .toSorted((a, b) => a - b)
      .slice(0, AUDIT_DRAW)
    expect(positives.map((entry) => entry.pr).toSorted((a, b) => a - b)).not.toEqual(lowest)

    // A rerun, and the same PRs in reverse order, draw the same sample.
    expect(JSON.stringify(auditSample(ledger, KEY))).toBe(JSON.stringify(sample))
    expect(JSON.stringify(auditSample({ ...ledger, pulls: ledger.pulls.toReversed() }, KEY))).toBe(
      JSON.stringify(sample),
    )
    // A later ledger with 20 more PRs: every PR keeps its id, and each earlier PR it draws was in the earlier sample.
    const later = auditSample(measured([...BEATS, { band: "low", lines: 10, count: 20, fixed: 10 }]), KEY)
    const before = new Map(sample.entries.map((entry) => [entry.pr, entry.id]))
    const earlier = new Set(ledger.pulls.map((pull) => pull.number))
    expect(later.population).toEqual({ positives: 110, negatives: 310 })
    for (const entry of later.entries.filter((item) => earlier.has(item.pr)))
      expect(before.get(entry.pr)).toBe(entry.id)
    expect(later.entries.some((entry) => !earlier.has(entry.pr))).toBe(true)
    // Another key, or another repository, draws other ids; the repository is read case-insensitively.
    const disjoint = (other: AuditSample) => other.entries.every((entry) => !ids.includes(entry.id))
    expect(disjoint(auditSample(ledger, new Uint8Array(32).fill(8)))).toBe(true)
    expect(disjoint(auditSample({ ...ledger, repository: "acme/gadgets" }, KEY))).toBe(true)
    expect(auditSample({ ...ledger, repository: "Acme/Widgets" }, KEY).entries).toEqual(sample.entries)

    // Reverted and filteredIncomplete PRs are never drawn, and a label with fewer than AUDIT_DRAW PRs is taken whole:
    // 30 of these 40 high PRs are fixed, 4 of them among the 5 reverted, and the first 3 fixed are marked.
    const mixed = measured([
      { band: "high", lines: 1000, count: 40, fixed: 30, reverted: 5 },
      { band: "low", lines: 10, count: 100 },
    ])
    const marked = new Set(
      mixed.pulls
        .filter((pull) => (pull.fixesFiltered ?? []).length > 0)
        .slice(0, 3)
        .map((pull) => pull.number),
    )
    const small = auditSample(
      {
        ...mixed,
        pulls: mixed.pulls.map((pull) =>
          marked.has(pull.number) ? { ...pull, filteredIncomplete: true as const } : pull,
        ),
      },
      KEY,
    )
    const reverted = new Set(mixed.pulls.filter((pull) => pull.revertedDays !== undefined).map((pull) => pull.number))
    expect(reverted.size).toBe(5)
    expect(small.entries.some((entry) => reverted.has(entry.pr) || marked.has(entry.pr))).toBe(false)
    expect(small.population).toEqual({ positives: 23, negatives: 109 })
    expect(small.entries.filter((entry) => entry.label === "positive").length).toBe(23)
    expect(small.entries.filter((entry) => entry.label === "negative").length).toBe(AUDIT_DRAW)

    // The audit key comes from the private key itself: one key whatever its PEM encoding, another for another key, and
    // none that a holder of the public key, or of the PEM text alone, could derive.
    const key = auditKey(OWNER.privateKey)
    expect(key.length).toBe(32)
    expect(auditKey(createPrivateKey(OWNER.privateKey).export({ type: "pkcs1", format: "pem" }).toString())).toEqual(
      key,
    )
    const stranger = generateKeyPairSync("rsa", { modulusLength: 2048 })
      .privateKey.export({ type: "pkcs8", format: "pem" })
      .toString()
    expect(auditKey(stranger)).not.toEqual(key)
    const derived = (material: Buffer | string) => new Uint8Array(hkdfSync("sha256", material, "", AUDIT_INFO, 32))
    for (const material of [
      createPublicKey(OWNER.publicKey).export({ type: "spki", format: "der" }),
      createPublicKey(OWNER.publicKey).export({ type: "pkcs1", format: "der" }),
      OWNER.publicKey,
      OWNER.privateKey,
    ])
      expect(key).not.toEqual(derived(material))

    // Through open: two runs into two directories write the same file, the sample the owner's key draws.
    const sealedFile = sealTo("audit-twice.sealed.json", ledger)
    for (const name of ["audit-one", "audit-two"])
      expect(
        await main(["open", sealedFile, keyFile, join(root, name), "--audit"], { now: NOW + DAY, env: {} }),
      ).toMatchObject({ code: 0, stderr: "" })
    const text = readFileSync(join(root, "audit-one", AUDIT_FILE), "utf8")
    expect(readFileSync(join(root, "audit-two", AUDIT_FILE), "utf8")).toBe(text)
    expect(text).toBe(JSON.stringify(auditSample(ledger, key), null, 2) + "\n")
  })

  test("without a labels file every follow-up-fix rate is unaudited", () => {
    const report = outcomeReport(measured(BEATS))
    expect(report.labelQuality!.audit).toEqual({
      population: { positives: 100, negatives: 300, filteredIncomplete: 0 },
      sample: { positives: AUDIT_DRAW, negatives: AUDIT_DRAW },
      audited: false,
    })
    const text = renderOutcomes(report)
    const audit = section(text, "## Label audit")
    expect(audit).toContain(
      "Unaudited: no labels file was given (open --labels <file>). Every follow-up-fix rate in this report is unaudited, those without a mark of their own included: the filtered label's minimum detectable effect row and capture table, and, on the unfiltered label, the band table's Fixed 30 d and Fixed 90 d columns, the escapes and the later-fixed shares.",
    )
    expect(audit).toContain("Here a sample draws 60 positives and 60 negatives.")
    expect(audit).not.toContain("- Precision")
    expect(audit).not.toContain("This population has")
    const rates = section(text, "## Outcome base rates")
    expect(rates).toContain("- Unfiltered follow-up fix (VS-46a's label; unaudited), over the 400 not reverted")
    expect(rates).toContain("code lines only; unaudited), over the 400 not reverted")
    expect(rates).toContain(
      "- Deciding label: filtered follow-up fix, SZZ-based, size-biased and unaudited (VS-46d's audit has not run).",
    )
    expect(section(text, "## Measurement verdict")).toContain(
      "on the filtered follow-up fix (SZZ-based, size-biased, unaudited) label",
    )
    expect(section(text, "## Capture against size")).toContain(
      "\nFiltered follow-up fix (SZZ-based, size-biased, unaudited): 100 positives",
    )
    expect(section(text, "## Risk band against post-merge outcomes")).toContain(
      "on the unfiltered follow-up-fix (SZZ-based, size-biased, unaudited) label",
    )
    expect(section(text, "## Untraceable fixes")).toContain("Unaudited: the audit samples PRs, not fix commits.")
    expect(section(text, "## Filter reattribution")).toContain("Unaudited: these count the two labels' blamed lines")
    expect(section(text, "## Fix-edited lines per kLOC")).toContain(
      "The filtered columns are unaudited; the unfiltered columns are unaudited.",
    )
    expect(text).not.toMatch(/(?<!un)audited/i)
    // A gradient-only report adds no label section.
    const gradient = renderOutcomes(outcomeReport({ ...measured(BEATS), findings: [] }))
    expect(gradient).not.toContain("## Label audit")
    expect(v1Only(gradient)).toBe(gradient)
    // A population with fewer positives than the audit needs says so.
    expect(section(renderOutcomes(outcomeReport(measured(FEW))), "## Label audit")).toContain(
      "Unaudited: no labels file was given (open --labels <file>). This population has 5 positives and 395 negatives, so the audit cannot reach that yet.",
    )
  })

  test("a fixture labels file gives precision, the miss rate and weighted recall with Wilson intervals", async () => {
    const ledger = measured(BEATS)
    const sample = auditSample(ledger, KEY)
    // 40 of the first 50 positives and 5 of the first 50 negatives are fix-inducing; the last 10 of each are skipped, and
    // three answers name no sampled PR.
    const answers = (label: AuditEntry["label"], index: number) =>
      index >= AUDIT_PER_LABEL ? null : label === "positive" ? index < 40 : index < 5
    const answered = labelsFrom(sample, answers)
    const foreign = ["a", "b", "c"].map((digit) => ({ id: digit.repeat(16), fixInducing: true }))
    const labels = labelsOf({ ...answered, entries: [...answered.entries, ...foreign] })
    const audit = quality(ledger, { sample, labels }).audit
    expect(audit.audited).toBe(true)
    expect(audit.labels).toMatchObject({ positives: 50, negatives: 50, ignored: 3 })
    expect(audit.labels!.precision).toEqual(proportion(40, 50))
    expect(audit.labels!.omission).toEqual(proportion(5, 50))
    // Recall weights each label by this population's 100 positives and 300 negatives: 100 × 0.8 / (100 × 0.8 + 300 × 0.1).
    expect(audit.labels!.recall.value).toBeCloseTo(80 / 110, 12)
    // Composed from the 97.5% Wilson intervals of 40/50 and 5/50, so both hold at once with at least 95% (Bonferroni).
    expect(audit.labels!.recall.interval![0]).toBeCloseTo(RECALL_INTERVAL[0], 6)
    expect(audit.labels!.recall.interval![1]).toBeCloseTo(RECALL_INTERVAL[1], 6)
    const text = renderOutcomes(outcomeReport(ledger, { sample, labels }))
    const section1 = section(text, "## Label audit")
    expect(section1).toContain("Audited: 50 answered positives and 50 answered negatives, at least 50 of each.")
    expect(section1).toContain("- Precision (fix-inducing among the labelled positives): 40/50 80.0% [")
    expect(section1).toContain(
      "- Missed (fix-inducing among the labelled negatives: the label's miss rate): 5/50 10.0% [",
    )
    expect(section1).toContain(
      `- Recall, weighted by this population's 100 positives and 300 negatives: 72.7% [${(RECALL_INTERVAL[0] * 100).toFixed(1)}%, ${(RECALL_INTERVAL[1] * 100).toFixed(1)}%]. The interval is composed from each label's 97.5% Wilson interval, so both hold at once with at least 95% confidence (Bonferroni); it is not a Wilson interval of its own.`,
    )
    expect(section1).toContain(
      "- 3 labels name no PR in this sample and were ignored; a null answer counts as unlabelled.",
    )
    // The audit lifts the filtered label's marks only.
    expect(section(text, "## Measurement verdict")).toContain(
      "on the filtered follow-up fix (SZZ-based, size-biased, audited) label",
    )
    const rates = section(text, "## Outcome base rates")
    expect(rates).toContain(
      "- Deciding label: filtered follow-up fix, SZZ-based, size-biased and audited (VS-46d's audit: see Label audit).",
    )
    expect(rates).toContain("code lines only; audited), over the 400 not reverted")
    expect(rates).toContain("- Unfiltered follow-up fix (VS-46a's label; unaudited), over the 400 not reverted")
    expect(section(text, "## Risk band against post-merge outcomes")).toContain(
      "on the unfiltered follow-up-fix (SZZ-based, size-biased, unaudited) label",
    )
    expect(section(text, "## Fix-edited lines per kLOC")).toContain(
      "The filtered columns are audited; the unfiltered columns are unaudited.",
    )

    // One answer short of 50 negatives: not audited, recall shows only its interval, and the mark stays.
    const short = labelsOf(
      labelsFrom(sample, (label, index) => (label === "negative" && index === 0 ? null : answers(label, index))),
    )
    const unaudited = quality(ledger, { sample, labels: short }).audit
    expect(unaudited.audited).toBe(false)
    expect(unaudited.labels).toMatchObject({ positives: 50, negatives: 49 })
    expect(unaudited.labels!.recall.value).toBeNull()
    expect(unaudited.labels!.recall.interval).not.toBeNull()
    expect(unaudited.labels!.omission.value).toBeNull()
    const shortText = renderOutcomes(outcomeReport(ledger, { sample, labels: short }))
    expect(section(shortText, "## Label audit")).toContain(
      "Unaudited: the audit needs at least 50 labelled positives and 50 labelled negatives; it has 50 and 49. Every follow-up-fix rate",
    )
    expect(section(shortText, "## Measurement verdict")).toContain("(SZZ-based, size-biased, unaudited) label")
    // The audit ran, with too few answers: SF-04's "has not run" is only for a report without labels.
    expect(section(shortText, "## Outcome base rates")).toContain(
      "- Deciding label: filtered follow-up fix, SZZ-based, size-biased and unaudited (VS-46d's audit has too few answers: see Label audit).",
    )
    expect(shortText).not.toContain("audit has not run")
    // Skips within the margin still audit: every one of the 60 answered but one.
    const skipped = labelsOf(labelsFrom(sample, (label, index) => (index === 7 ? null : label === "positive")))
    expect(quality(ledger, { sample, labels: skipped }).audit).toMatchObject({
      audited: true,
      labels: { positives: AUDIT_DRAW - 1, negatives: AUDIT_DRAW - 1 },
    })
    // No fix-inducing answer on either label: audited, but recall has no value, and its interval runs from 0 to 1.
    const none = labelsOf(labelsFrom(sample, () => false))
    const empty = quality(ledger, { sample, labels: none }).audit
    expect(empty).toMatchObject({ audited: true, labels: { positives: AUDIT_DRAW, negatives: AUDIT_DRAW } })
    expect(empty.labels!.recall).toEqual({ value: null, interval: [0, 1] })
    expect(section(renderOutcomes(outcomeReport(ledger, { sample, labels: none })), "## Label audit")).toContain(
      "100 positives and 300 negatives: n/a [0.0%, 100.0%]. The interval",
    )
    // Answers on one label only: no stratum interval for the other, so recall has no interval, and no bracket is printed.
    const oneSided = labelsOf(labelsFrom(sample, (label) => (label === "positive" ? true : null)))
    const lopsided = quality(ledger, { sample, labels: oneSided }).audit
    expect(lopsided).toMatchObject({ audited: false, labels: { positives: AUDIT_DRAW, negatives: 0 } })
    expect(lopsided.labels!.recall).toEqual({ value: null, interval: null })
    expect(section(renderOutcomes(outcomeReport(ledger, { sample, labels: oneSided })), "## Label audit")).toContain(
      "100 positives and 300 negatives: n/a. The interval",
    )

    // The same answers through open --labels, against the sample the owner's key draws.
    const owned = auditSample(ledger, auditKey(OWNER.privateKey))
    const ownedFile = labelsFrom(owned, answers)
    const labelsFile = join(root, "audit-answers.json")
    writeFileSync(labelsFile, JSON.stringify(ownedFile, null, 2))
    const target = join(root, "audit-labelled")
    const opened = await main(
      ["open", sealTo("audit-labels.sealed.json", ledger), keyFile, target, "--labels", labelsFile],
      {
        now: NOW + DAY,
        env: {},
      },
    )
    expect(opened).toMatchObject({ code: 0, stderr: "" })
    expect(section(readFileSync(join(target, REPORT_FILE), "utf8"), "## Label audit")).toBe(
      section(renderOutcomes(outcomeReport(ledger, { sample: owned, labels: labelsOf(ownedFile) })), "## Label audit"),
    )
    expect(readdirSync(target)).toEqual([REPORT_FILE])
  })

  test("the untraceable share: fix commits that delete no line, or no code line", async () => {
    const repo = addOnlyRepo("add-only")
    const ledger = await collect(filterInput([]), {
      github: fakeGitHub(repo.world).github,
      git: localGit(repo.dir),
      now: NOW,
      key: KEY,
    })
    expect(ledgerProblem(ledger, NOW)).toBeUndefined()
    // #41 only adds a line, #42 deletes only #40's comment line, and #43 edits one of #40's code lines.
    expect(ledger.fixCommits.map((commit) => commit.deleted)).toEqual([
      { code: 0, blank: 0, comment: 0 },
      { code: 0, blank: 0, comment: 1 },
      { code: 1, blank: 0, comment: 0 },
    ])
    const pull = ledger.pulls.find((entry) => entry.number === 40)!
    expect(pull.fixes).toEqual([
      {
        days: 40,
        lines: 1,
        kind: "label",
        commit: 1,
        deleted: { code: 0, blank: 0, comment: 1, whitespace: 0, moved: 0 },
      },
      {
        days: 60,
        lines: 1,
        kind: "label",
        commit: 2,
        deleted: { code: 1, blank: 0, comment: 0, whitespace: 0, moved: 0 },
      },
    ])
    expect(pull.fixesFiltered!.map((fix) => [fix.days, fix.lines, fix.commit])).toEqual([[60, 1, 2]])
    const full = fullOf(ledger)
    expect(ledgerProblem(full, NOW)).toBeUndefined()
    expect(quality(full).untraceable).toEqual({
      commits: 3,
      unfiltered: { ...proportion(1, 3), value: null },
      filtered: { ...proportion(2, 3), value: null },
    })
    const text = section(renderOutcomes(outcomeReport(full)), "## Untraceable fixes")
    expect(text).toContain("Of the 3 fix commits the scan labelled")
    expect(text).toContain("those that deleted no line at all, which the unfiltered label cannot trace: 1/3 [")
    expect(text).toContain("those that deleted no code line, which the filtered label cannot trace: 2/3 [")
    expect(text).toContain(
      "The filtered count adds the fixes that delete only blank or comment lines to the add-only ones.",
    )
  })

  test("the filter's reattribution split, on SF-03's moved-lines and filter histories", async () => {
    const moveRepoOf = moveRepo("reattribution-move")
    const moved = fullOf(
      await collect(filterInput([]), {
        github: fakeGitHub(moveRepoOf.world).github,
        git: localGit(moveRepoOf.dir),
        now: NOW,
        key: KEY,
      }),
    )
    expect(ledgerProblem(moved, NOW)).toBeUndefined()
    expect(quality(moved).reattribution).toMatchObject({
      pulls: 3,
      filteredIncomplete: 0,
      lines: 2,
      kinds: { code: 0, blank: 0, comment: 0, whitespace: 0, moved: 2 },
      filtered: 2,
      gained: 2,
    })
    const movedText = section(renderOutcomes(outcomeReport(moved)), "## Filter reattribution")
    expect(movedText).toContain(
      "- Split into whitespace, comment and move: whitespace 0 (0.0%), comment 0 (0.0%), move 2 (100.0%).",
    )
    expect(movedText).toContain("- Reattributed or dropped: 2 (100.0%).")
    expect(movedText).toContain(
      "- The filtered label blames 2 lines on these PRs: the 0 code lines it keeps, and 2 gained, lines the unfiltered blame put on other commits.",
    )

    const filterRepoOf = filterRepo("reattribution-filter")
    const filter = fullOf(
      await collect(filterInput([10, 12, 14]), {
        github: fakeGitHub(filterRepoOf.world).github,
        git: localGit(filterRepoOf.dir),
        now: NOW,
        key: KEY,
      }),
    )
    expect(ledgerProblem(filter, NOW)).toBeUndefined()
    // T5's pinned kinds: #10's 5 + 1 + 1 lines and #11's 2 + 1; the filtered label gives #10 5 and #11 1.
    expect(quality(filter).reattribution).toMatchObject({
      pulls: 6,
      filteredIncomplete: 0,
      lines: 10,
      kinds: { code: 5, blank: 1, comment: 2, whitespace: 2, moved: 0 },
      filtered: 6,
      gained: 1,
    })
    const text = section(renderOutcomes(outcomeReport(filter)), "## Filter reattribution")
    expect(text).toContain(
      "- By kind: code 5 (50.0%), still the PR's under the filter; whitespace 2 (20.0%), put elsewhere by -w; moved 0 (0.0%), put elsewhere by -M and -C; comment 2 (20.0%) and blank 1 (10.0%), dropped as comment-only or blank lines.",
    )
    expect(text).toContain(
      "- Split into whitespace, comment and move: whitespace 2 (20.0%), comment 2 (20.0%), move 0 (0.0%). Blank lines, 1 (10.0%), are dropped by the blank and comment filter, not put elsewhere by -w, so they stand on their own.",
    )
    expect(text).toContain("- Reattributed or dropped: 5 (50.0%).")
    expect(text).toContain("No interval: lines cluster within fix commits.")
    // A PR marked filteredIncomplete leaves the split, and is counted.
    const marked = {
      ...filter,
      pulls: filter.pulls.map((entry) =>
        entry.number === 11 ? { ...entry, filteredIncomplete: true as const } : entry,
      ),
    }
    expect(ledgerProblem(marked, NOW)).toBeUndefined()
    expect(quality(marked).reattribution).toMatchObject({
      pulls: 5,
      filteredIncomplete: 1,
      lines: 7,
      kinds: { code: 4, blank: 1, comment: 2, whitespace: 0, moved: 0 },
      filtered: 5,
      gained: 1,
    })
    expect(section(renderOutcomes(outcomeReport(marked)), "## Filter reattribution")).toContain(
      "(1 marked filteredIncomplete, left out;",
    )
  })

  test("fix-edited lines per kLOC added, by band, over each label's population", () => {
    // Low: 100 PRs of 10 lines, 10 fixed. High: 100 of 1,000, 20 fixed, the last 10 reverted (2 of them fixed).
    // Medium: 50 of 200, none fixed.
    const groups: Group[] = [
      { band: "low", lines: 10, count: 100, fixed: 10 },
      { band: "high", lines: 1000, count: 100, fixed: 20, reverted: 10 },
      { band: "medium", lines: 200, count: 50 },
    ]
    const ledger = measured(groups)
    const density = quality(ledger).density
    expect(density.low.unfiltered).toEqual({ pulls: 100, added: 1000, lines: 10, perKloc: 10 })
    expect(density.high.unfiltered).toEqual({ pulls: 90, added: 90_000, lines: 18, perKloc: 0.2 })
    expect(density.medium.unfiltered).toEqual({ pulls: 50, added: 10_000, lines: 0, perKloc: 0 })
    expect(density.all.unfiltered).toEqual({ pulls: 240, added: 101_000, lines: 28, perKloc: 28_000 / 101_000 })
    for (const band of ["low", "medium", "high", "all"] as const)
      expect(density[band].filtered).toEqual(density[band].unfiltered)
    const text = section(renderOutcomes(outcomeReport(ledger)), "## Fix-edited lines per kLOC")
    expect(text).toContain("| low | 100 | 1.00 | 10 | 10.00 | 100 | 1.00 | 10 | 10.00 | 48.0 / 48.0 |")
    expect(text).toContain("| medium | 50 | 10.00 | 0 | 0.00 | 50 | 10.00 | 0 | 0.00 | 48.0 / 48.0 |")
    expect(text).toContain("| high | 90 | 90.00 | 18 | 0.20 | 90 | 90.00 | 18 | 0.20 | 48.0 / 48.0 |")
    expect(text).toContain("| all | 240 | 101.00 | 28 | 0.28 | 240 | 101.00 | 28 | 0.28 | 48.0 / 48.0 |")
    expect(text).toContain(
      "while a fix's blamed lines count every file it edited, skipped files such as lockfiles and generated files included",
    )
    expect(text).toContain("The filtered columns are unaudited; the unfiltered columns are unaudited.")
    // A fixed low PR marked filteredIncomplete leaves the filtered columns only.
    const first = ledger.pulls.find((pull) => pull.band === "low" && (pull.fixesFiltered ?? []).length > 0)!
    const marked = quality({
      ...ledger,
      pulls: ledger.pulls.map((pull) => (pull === first ? { ...pull, filteredIncomplete: true as const } : pull)),
    }).density
    expect(marked.low.filtered).toEqual({ pulls: 99, added: 990, lines: 9, perKloc: 9000 / 990 })
    expect(marked.low.unfiltered).toEqual(density.low.unfiltered)
    // An empty band has no rate.
    expect(
      section(renderOutcomes(outcomeReport(measured(groups.slice(0, 2)))), "## Fix-edited lines per kLOC"),
    ).toContain("| medium | 0 | 0.00 | 0 | n/a | 0 | 0.00 | 0 | n/a | n/a |")
  })

  test("a /1 ledger shows every label section as unavailable, and open refuses to audit it", async () => {
    const current = measured(BEATS)
    const legacy = outcomeReport(v1Of(current))
    expect(legacy.labelQuality).toBeUndefined()
    const gradient = outcomeReport(v1Of({ ...current, findings: [] }))
    expect(gradient.volume.decision).toBe("gradient-only")
    for (const text of [renderOutcomes(legacy), renderOutcomes(gradient)])
      for (const heading of LABEL_HEADINGS) expect(section(text, heading)).toBe(`\n${heading}\n\n${V1_UNAVAILABLE}\n`)
    const sealedFile = sealTo("audit-v1.sealed.json", v1Of(current))
    const labelsFile = join(root, "audit-v1-labels.json")
    writeFileSync(labelsFile, JSON.stringify(labelsFrom(auditSample(current, auditKey(OWNER.privateKey)), () => true)))
    for (const [name, extra] of [
      ["audit-v1-audit", ["--audit"]],
      ["audit-v1-labels", ["--labels", labelsFile]],
    ] as const) {
      const result = await main(["open", sealedFile, keyFile, join(root, name), ...extra], { now: NOW + DAY, env: {} })
      expect(result).toMatchObject({ code: 1, stdout: "" })
      expect(result.stderr).toContain(
        "--audit and --labels need a vectorscope-outcomes/2 ledger: a vectorscope-outcomes/1 ledger has no filtered label to audit. Nothing was written.",
      )
      expect(existsSync(join(root, name))).toBe(false)
    }
  })

  test("open writes the sample only when asked and never over answers, and reads labels without changing them", async () => {
    const ledger = measured(BEATS)
    const sealedFile = sealTo("writes.sealed.json", ledger)
    const gradientFile = sealTo("writes-gradient.sealed.json", { ...ledger, findings: [] })
    const owned = auditSample(ledger, auditKey(OWNER.privateKey))
    // 55 of each label answered: four in five positives and one in ten negatives fix-inducing.
    const answered = labelsFrom(owned, (label, index) =>
      index >= 55 ? null : label === "positive" ? index % 5 !== 0 : index % 10 === 0,
    )
    const answers = join(root, "writes-answers.json")
    writeFileSync(answers, JSON.stringify(answered, null, 2))
    const sooner = new Date(NOW + 30 * DAY).toISOString()
    const early = join(root, "writes-early.json")
    writeFileSync(early, JSON.stringify({ ...answered, expires: sooner }))
    const tree = join(root, "writes-tree")
    mkdirSync(join(tree, ".git"), { recursive: true })
    writeFileSync(join(tree, "labels.json"), JSON.stringify(answered))
    const bad = (name: string, payload: string) => {
      writeFileSync(join(root, `${name}.json`), payload)
      return join(root, `${name}.json`)
    }
    const malformed = `not a ${AUDIT_SCHEMA} file`
    const wrongRepository = bad("labels-repository", JSON.stringify({ ...answered, repository: "acme/gadgets" }))
    // Answers to PRs the new sample does not hold: two given, one skipped.
    const foreign = ["a", "b", "c"].map((digit, index) => ({
      id: digit.repeat(16),
      fixInducing: index === 2 ? null : index === 0,
    }))
    const extra = bad(
      "writes-extra-answers",
      JSON.stringify({ ...answered, entries: [...answered.entries, ...foreign] }),
    )
    // A dangling link named like the sample: the write would follow it out of the directory.
    const linked = join(root, "writes-link")
    const destination = join(root, "writes-link-destination.json")
    mkdirSync(linked)
    symlinkSync(destination, join(linked, AUDIT_FILE))
    const refusals = [
      ["refused-json", bad("labels-json", "{ not json"), "the labels file is not valid JSON"],
      [
        "refused-id",
        bad("labels-id", JSON.stringify({ ...answered, entries: [{ id: "XYZ", fixInducing: true }] })),
        malformed,
      ],
      [
        "refused-answer",
        bad(
          "labels-answer",
          JSON.stringify({ ...answered, entries: [{ ...answered.entries[0], fixInducing: "yes" }] }),
        ),
        malformed,
      ],
      [
        "refused-schema",
        bad("labels-schema", JSON.stringify({ ...answered, schema: "vectorscope-outcomes-audit/9" })),
        malformed,
      ],
      ["refused-repository", wrongRepository, 'the labels file is for "acme/gadgets", not acme/widgets'],
      [
        "refused-duplicate",
        bad("labels-duplicate", JSON.stringify({ ...answered, entries: [answered.entries[0], answered.entries[0]] })),
        "the labels file names one PR twice",
      ],
      [
        "refused-expired",
        bad("labels-expired", JSON.stringify({ ...answered, expires: new Date(NOW + DAY).toISOString() })),
        `the labels file expired on ${new Date(NOW + DAY).toISOString().slice(0, 10)}: delete it`,
      ],
      ["refused-missing", join(root, "no-such-labels.json"), "Cannot read the labels file"],
      // Valid answers padded past the ceiling: the size alone refuses it, before it is read.
      [
        "refused-large",
        bad("labels-large", JSON.stringify(answered) + " ".repeat(MAX_LABELS_BYTES)),
        `The labels file is too large: more than ${MAX_LABELS_BYTES} bytes. Nothing was written.`,
      ],
    ] as const
    const sealedBytes = readFileSync(sealedFile)
    const answerBytes = readFileSync(answers)
    const listing = readdirSync(root).toSorted()
    const open = (target: string, ...extra: string[]) =>
      main(["open", sealedFile, keyFile, join(root, target), ...extra], { now: NOW + DAY, env: {} })

    // --audit writes the sample beside the report, both for the owner alone.
    const audited = await open("writes-audit", "--audit")
    expect(audited).toMatchObject({ code: 0, stderr: "" })
    expect(audited.stdout).toContain(`Wrote ${REPORT_FILE} and ${AUDIT_FILE} to `)
    expect(audited.stdout).toContain(
      `Answer each fixInducing in ${AUDIT_FILE} (at least ${AUDIT_PER_LABEL} of each label) and pass the file back with --labels. It and your answers name PRs: keep them on this machine, and delete them by ${ledger.expires.slice(0, 10)}.`,
    )
    expect(readdirSync(join(root, "writes-audit")).toSorted()).toEqual([AUDIT_FILE, REPORT_FILE])
    for (const name of [AUDIT_FILE, REPORT_FILE])
      expect(statSync(join(root, "writes-audit", name)).mode & 0o777).toBe(0o600)
    // The owner answers in place; a second --audit into that directory is refused, and both files keep their bytes.
    writeFileSync(join(root, "writes-audit", AUDIT_FILE), JSON.stringify(answered, null, 2))
    const kept = [AUDIT_FILE, REPORT_FILE].map((name) => readFileSync(join(root, "writes-audit", name)))
    const again = await open("writes-audit", "--audit")
    expect(again).toMatchObject({ code: 1, stdout: "" })
    expect(again.stderr).toContain("already exists and may hold your answers")
    expect([AUDIT_FILE, REPORT_FILE].map((name) => readFileSync(join(root, "writes-audit", name)))).toEqual(kept)
    // A dangling link by that name is refused too, and nothing is created where it points.
    const link = await open("writes-link", "--audit")
    expect(link).toMatchObject({ code: 1, stdout: "" })
    expect(link.stderr).toContain("already exists and may hold your answers")
    expect(readdirSync(linked)).toEqual([AUDIT_FILE])
    expect(lstatSync(join(linked, AUDIT_FILE)).isSymbolicLink()).toBe(true)
    expect(existsSync(destination)).toBe(false)
    // Without --audit, only the report; with --ledger too, all three, named in the order written.
    const all = await open("writes-all", "--ledger", "--audit")
    expect(all.stdout).toContain(`Wrote ${REPORT_FILE}, ${OUTCOME_LEDGER_FILE} and ${AUDIT_FILE} to `)
    expect(readdirSync(join(root, "writes-all")).toSorted()).toEqual(
      [AUDIT_FILE, OUTCOME_LEDGER_FILE, REPORT_FILE].toSorted(),
    )

    // --labels reads the answers and writes only the report.
    const labelled = await open("writes-labelled", "--labels", answers)
    expect(labelled).toMatchObject({ code: 0, stderr: "" })
    expect(labelled.stdout).not.toContain("gradient-only")
    expect(readdirSync(join(root, "writes-labelled"))).toEqual([REPORT_FILE])
    expect(section(readFileSync(join(root, "writes-labelled", REPORT_FILE), "utf8"), "## Label audit")).toContain(
      "Audited: 55 answered positives and 55 answered negatives, at least 50 of each.",
    )
    // --audit with --labels carries the answers into the new sample, which expires no later than their file.
    const carriedAll = await open("writes-carried", "--audit", "--labels", answers)
    expect(carriedAll.code).toBe(0)
    expect(carriedAll.stdout).not.toContain("were not carried")
    expect(JSON.parse(readFileSync(join(root, "writes-carried", AUDIT_FILE), "utf8"))).toEqual(answered)
    // Answers to PRs outside the new sample are left behind, and open says how many; the skipped one is not counted.
    const extraOpened = await open("writes-extra", "--audit", "--labels", extra)
    expect(extraOpened).toMatchObject({ code: 0, stderr: "" })
    expect(extraOpened.stdout).toContain(
      " 2 of your answers name no PR in the new sample and were not carried into it; your labels file still holds them.",
    )
    expect(JSON.parse(readFileSync(join(root, "writes-extra", AUDIT_FILE), "utf8"))).toEqual(answered)
    const carried = await open("writes-early", "--audit", "--labels", early)
    expect(carried.stdout).toContain(`delete them by ${sooner.slice(0, 10)}.`)
    expect(JSON.parse(readFileSync(join(root, "writes-early", AUDIT_FILE), "utf8"))).toEqual({
      ...answered,
      expires: sooner,
    })
    // On a gradient-only ledger the labels are checked, and not used.
    const gradient = await main(["open", gradientFile, keyFile, join(root, "writes-gradient"), "--labels", answers], {
      now: NOW + DAY,
      env: {},
    })
    expect(gradient).toMatchObject({ code: 0, stderr: "" })
    expect(gradient.stdout).toContain(
      "The labels were checked but not used: this report is gradient-only (fewer than 200 settled human-stratum findings on PRs merged in the 90 days before collection), and the label sections follow the full report's volume rule.",
    )
    expect(readFileSync(join(root, "writes-gradient", REPORT_FILE), "utf8")).not.toContain("## Label audit")
    const gradientAudit = await main(["open", gradientFile, keyFile, join(root, "writes-gradient-audit"), "--audit"], {
      now: NOW + DAY,
      env: {},
    })
    expect(gradientAudit.stdout).toContain(
      "This report is gradient-only, so it has no label section yet: the label sections follow the full report's volume rule.",
    )
    expect(readdirSync(join(root, "writes-gradient-audit")).toSorted()).toEqual([AUDIT_FILE, REPORT_FILE])
    const unchecked = await main(
      ["open", gradientFile, keyFile, join(root, "writes-gradient-bad"), "--labels", wrongRepository],
      { now: NOW + DAY, env: {} },
    )
    expect(unchecked).toMatchObject({ code: 1, stdout: "" })
    expect(unchecked.stderr).toContain('the labels file is for "acme/gadgets"')

    // Every refusal writes nothing.
    const refused = async (name: string, extra: string[], code: number, text: string) => {
      const result = await open(name, ...extra)
      expect(result).toMatchObject({ code, stdout: "" })
      expect(result.stderr).toContain(text)
      expect(existsSync(join(root, name))).toBe(false)
    }
    await refused("refused-bare", ["--labels"], 2, "Give --labels as the path of your labels file.")
    // Not strict, parseArgs takes a following --audit as the labels path: refused, not run as an audit without labels.
    await refused("refused-option", ["--labels", "--audit"], 2, "Give --labels as the path of your labels file.")
    const outside = "--labels must be outside the VectorScope checkout and every git work tree"
    await refused("refused-tree", ["--labels", join(tree, "labels.json")], 2, outside)
    await refused("refused-checkout", ["--labels", join(REPO_ROOT, "package.json")], 2, outside)
    for (const [name, file, text] of refusals) await refused(name, ["--labels", file], 1, text)

    // Read only: the answers and the sealed ledger keep their bytes, and only the opened directories are new.
    expect(readFileSync(answers).equals(answerBytes)).toBe(true)
    expect(readFileSync(sealedFile).equals(sealedBytes)).toBe(true)
    expect(readdirSync(root).toSorted()).toEqual(
      [
        ...listing,
        "writes-audit",
        "writes-all",
        "writes-labelled",
        "writes-carried",
        "writes-extra",
        "writes-early",
        "writes-gradient",
        "writes-gradient-audit",
      ].toSorted(),
    )
  })
})

// VS-46d items 5 to 11 (addendum B §1.9; SF-05b) over synthetic schema-2 histories. Every drop artifact and latent
// outcome here is a fixture: no package joins drops to fixes yet.
describe("outcome strata, dismissals, agent split and latent scoring (VS-46d, SF-05b)", () => {
  const cohorts = (ledger: OutcomeLedger, latent?: readonly LatentOutcome[]) =>
    outcomeReport(ledger, undefined, latent).cohorts!
  const table = (text: string, title: string) => {
    const lines = text.split("\n")
    const start = lines.indexOf(`${title}:`)
    const end = lines.findIndex((line, index) => index > start + 2 && !line.startsWith("|"))
    return lines.slice(start + 2, end === -1 ? undefined : end)
  }
  const counts = (row: CohortRow) => [
    row.stratum,
    row.a.pulls,
    row.a.positives,
    row.b.pulls,
    row.b.positives,
    row.status,
  ]
  const differenceOf = (row: CohortRow) =>
    independentDifference(
      { count: row.a.positives, total: row.a.pulls },
      { count: row.b.positives, total: row.b.pulls },
    )

  // Within each band the clean and findings groups revert at the same rate (10% low, 40% high), while clean PRs sit
  // mostly in the low band, so the unstratified difference is negative. Band low holds 10- and 30-line PRs, and the
  // tercile of 30-line PRs holds low and high PRs. The medium band and the middle tercile are underpowered.
  const STRATA_GROUPS: CohortGroup[] = [
    { band: "low", lines: 10, count: 150, reverted: 15 },
    { band: "low", lines: 30, count: 100, reverted: 10, posted: true },
    { band: "high", lines: 30, count: 50, reverted: 20 },
    { band: "high", lines: 1000, count: 150, reverted: 60, posted: true },
    { band: "medium", lines: 200, count: 20, reverted: 2 },
    { band: "medium", lines: 200, count: 20, reverted: 2, posted: true },
  ]

  test("verdict against outcome within each band and size tercile, the raw difference labelled confounded by size", () => {
    const ledger = cohortLedger(STRATA_GROUPS)
    expect(ledgerProblem(ledger, NOW)).toBeUndefined()
    const found = cohorts(ledger)
    // 490 PRs: 150 of 10 lines, 150 of 30, 40 of 200 and 150 of 1,000. The cuts are the 164th and the 327th smallest.
    expect(found.size).toEqual({ cut: [30, 200], pulls: { small: 300, middle: 40, large: 150 } })
    const revert = found.verdict.labels.revert
    expect(revert.bands.map(counts)).toEqual([
      ["low", 150, 15, 100, 10, "shown"],
      ["medium", 20, 2, 20, 2, "underpowered"],
      ["high", 50, 20, 150, 60, "shown"],
    ])
    expect(revert.terciles.map(counts)).toEqual([
      ["small", 200, 35, 100, 10, "shown"],
      ["middle", 20, 2, 20, 2, "underpowered"],
      ["large", 0, 0, 150, 60, "empty"],
    ])
    expect(counts(revert.raw)).toEqual(["all", 220, 37, 270, 72, "shown"])
    // Equal rates within each band, a tercile that mixes bands, and a raw difference that measures where clean PRs sit.
    expect(revert.bands[0].difference!.difference).toBe(0)
    expect(revert.bands[2].difference!.difference).toBe(0)
    expect(revert.bands[0].difference).toEqual(differenceOf(revert.bands[0]))
    expect(revert.terciles[0].difference).toEqual(differenceOf(revert.terciles[0]))
    expect(revert.raw.difference).toEqual(differenceOf(revert.raw))
    expect(revert.raw.difference!.difference).toBeLessThan(-0.09)
    // Expected positives at each row's pooled rate: 25 of 250 in the low band, 80 of 200 in the high.
    expect(revert.bands[0].expected).toEqual({ a: 15, b: 10 })
    expect(revert.bands[2].expected).toEqual({ a: 20, b: 60 })
    expect(revert.bands[1].difference).toBeNull()
    // No PR of these groups was fixed, so the filtered label expects no positive anywhere.
    expect(found.verdict.labels.filtered.raw.status).toBe("underpowered")

    const text = section(renderOutcomes(outcomeReport(ledger)), "## Verdict against outcome")
    const label = "all PRs, unstratified: confounded by size"
    expect(text.split(label).length - 1).toBe(2)
    for (const title of [
      "Revert within 90 days",
      "Filtered follow-up fix within 90 days (SZZ-based, size-biased, unaudited)",
    ]) {
      const rows = table(text, title)
      expect(rows.length).toBe(9)
      expect(rows.at(-1)!.startsWith(`| ${label} |`)).toBe(true)
    }
    const rows = table(text, "Revert within 90 days")
    expect(rows[2]).toContain("| band low | 15/150 10.0% [")
    expect(rows[2]).toContain("| 15.0 / 10.0 | 0.0 [")
    expect(rows[3]).toMatch(
      /^\| band medium \| 2\/20 \[[^\]]+\] \| 2\/20 \[[^\]]+\] \| 2\.0 \/ 2\.0 \| underpowered \(not yet\) \| 48\.0 \/ 48\.0 \|$/,
    )
    expect(rows[7].startsWith("| tercile large | 0/0 | 60/150 40.0% [")).toBe(true)
    expect(rows[7].endsWith("| 0.0 / 60.0 | n/a | 48.0 / 48.0 |")).toBe(true)
    expect(rows[8]).toContain(`| ${label} | 37/220 16.8% [`)
    expect(text).toContain(
      "- Size terciles, by added plus deleted lines over every matured PR with a band, every stratum: small up to 30 lines (300 PRs), middle up to 200 (40), large above 200 (150).",
    )
    expect(text).toContain("so a raw difference measures size")
    expect(text).toContain("its difference is shown only when a stratified row of the same table shows one")
    expect(text).toContain("No depth assignment is recorded (VS-46 item 7), so there is no depth stratum.")
  })

  test("the raw difference is shown only beside a stratified one; each needs 50 PRs and 10 expected positives per group", () => {
    // Low: 60 PRs a group, 3 reverts each, so 3 expected: underpowered on expected positives. High: 16 of 40 clean
    // against 24 of 60, so 16 and 24 expected but 40 clean PRs: underpowered on PRs. Unstratified, both floors are met.
    const ledger = cohortLedger([
      { band: "low", lines: 10, count: 60, reverted: 3 },
      { band: "low", lines: 10, count: 60, reverted: 3, posted: true },
      { band: "high", lines: 1000, count: 40, reverted: 16 },
      { band: "high", lines: 1000, count: 60, reverted: 24, posted: true },
    ])
    expect(ledgerProblem(ledger, NOW)).toBeUndefined()
    const revert = cohorts(ledger).verdict.labels.revert
    expect(revert.bands.map(counts)).toEqual([
      ["low", 60, 3, 60, 3, "underpowered"],
      ["medium", 0, 0, 0, 0, "empty"],
      ["high", 40, 16, 60, 24, "underpowered"],
    ])
    expect(revert.bands[0].expected).toEqual({ a: 3, b: 3 })
    expect(revert.bands[2].expected).toEqual({ a: 16, b: 24 })
    expect(revert.terciles.map((row) => row.status)).toEqual(["underpowered", "underpowered", "empty"])
    expect(revert.raw).toMatchObject({ status: "unpaired", difference: null })
    expect(Math.min(revert.raw.a.pulls, revert.raw.b.pulls)).toBeGreaterThanOrEqual(MIN_PULLS)
    expect(Math.min(revert.raw.expected.a, revert.raw.expected.b)).toBeGreaterThanOrEqual(MIN_EXPECTED)
    const text = section(renderOutcomes(outcomeReport(ledger)), "## Verdict against outcome")
    expect(table(text, "Revert within 90 days").at(-1)).toContain(
      "| 20.9 / 25.1 | n/a: no stratified difference to set it beside |",
    )

    // Heavy ties: 60 PRs of 0 lines and 30 of 10 put both cuts at 0, so the middle tercile is empty.
    const tied = cohortLedger([
      { band: "low", lines: 0, count: 60 },
      { band: "low", lines: 10, count: 30, posted: true },
    ])
    const sized = cohorts(tied)
    expect(sized.size).toEqual({ cut: [0, 0], pulls: { small: 60, middle: 0, large: 30 } })
    expect(sized.verdict.labels.revert.terciles[1].status).toBe("empty")
    expect(sized.agent.labels.revert[1].status).toBe("empty")
    const tiedText = section(renderOutcomes(outcomeReport(tied)), "## Verdict against outcome")
    expect(table(tiedText, "Revert within 90 days")[6]).toBe("| tercile middle | 0/0 | 0/0 | 0.0 / 0.0 | n/a | n/a |")
    expect(tiedText).toContain("small up to 0 lines (60 PRs), middle up to 0 (0), large above 0 (30)")
    // The cuts are the ceil(n/3)-th and the ceil(2n/3)-th smallest: 2 and 4 of six PRs of 1 to 6 lines.
    const ranks = cohorts(cohortLedger(repeat(6, (index) => ({ band: "low" as const, lines: index + 1, count: 1 }))))
    expect(ranks.size).toEqual({ cut: [2, 4], pulls: { small: 2, middle: 2, large: 2 } })
  })

  test("the stratum is a proxy, labelled as one, over reviewed human PRs; the rest are left out and counted", () => {
    const ledger = cohortLedger([
      ...STRATA_GROUPS,
      { band: "low", lines: 10, count: 1, reviewed: false },
      { band: "low", lines: 10, count: 1, reviews: 0 },
      { band: "low", lines: 10, count: 1, unreviewed: 2 },
      { band: "high", lines: 1000, count: 1, filteredIncomplete: true },
      // Agent and agent-signal PRs, every one reverted: they would move the low band's clean rate if they entered.
      { band: "low", lines: 10, count: 5, reverted: 5, stratum: "agent" },
      { band: "low", lines: 10, count: 3, reverted: 3, stratum: "agent-signal" },
    ])
    expect(ledgerProblem(ledger, NOW)).toBeUndefined()
    const verdict = cohorts(ledger).verdict
    expect(verdict.proxy).toBe(true)
    expect(verdict.groups).toEqual({ clean: 221, findings: 270, incomplete: 1, unreviewed: 2 })
    expect(verdict.excluded).toEqual({ agent: 5, "agent-signal": 3 })
    expect(verdict.filteredIncomplete).toBe(1)
    // No agent or agent-signal PR enters either group, and the marked PR is clean on reverts but leaves the filtered rows.
    expect(counts(verdict.labels.revert.bands[0])).toEqual(["low", 150, 15, 100, 10, "shown"])
    expect(verdict.labels.filtered.bands[0].a.pulls).toBe(135)
    expect(counts(verdict.labels.revert.bands[2])).toEqual(["high", 51, 20, 150, 60, "shown"])
    expect(verdict.labels.filtered.bands[2].a.pulls).toBe(30)
    expect(counts(verdict.labels.revert.raw)).toEqual(["all", 221, 37, 270, 72, "shown"])
    // A reviewed PR with no unreviewed count is not clean: the proxy fails closed.
    const clean = ledger.pulls.find((pull) => pull.number === 10_000)!
    const { unreviewedFiles: _unreviewed, ...counted } = clean
    const missing = cohorts({ ...ledger, pulls: ledger.pulls.map((pull) => (pull === clean ? counted : pull)) })
    expect(missing.verdict.groups).toEqual({ clean: 220, findings: 270, incomplete: 2, unreviewed: 2 })
    // A pruned state may have lost summary findings, so a PR with none in the ledger is incomplete, not clean; one with
    // a finding in the ledger stays with findings.
    const posted = ledger.pulls.find((pull) => pull.number === 11_000)!
    expect(posted.unreviewedFiles).toBe(0)
    const pruned = cohorts({
      ...ledger,
      pulls: ledger.pulls.map((pull) => (pull === clean || pull === posted ? { ...pull, statePruned: true } : pull)),
    })
    expect(pruned.verdict.groups).toEqual({ clean: 220, findings: 270, incomplete: 2, unreviewed: 2 })

    const text = section(renderOutcomes(outcomeReport(ledger)), "## Verdict against outcome")
    expect(text).toContain("The verdict here is a proxy, labelled as one, because ReviewState records no verdict yet.")
    expect(text).toContain(
      "The exact clean-complete value from VS-32a's reviewVerdict replaces it only once SF-39 records the verdict in ReviewState and a later ledger collection field reads it, which is a /3.",
    )
    expect(text).toContain("a failed last run that left no file unreviewed reads as complete")
    expect(text).toContain(
      "its state was not pruned, and its last run left no file unreviewed; it is with findings (proxy) when",
    )
    expect(text).toContain(
      "A pruned state (at its finding cap or near its size limit) may have lost summary findings, so it reads incomplete.",
    )
    expect(text).toContain(
      "- Compared: the human-stratum matured PRs with a band that no read cut short, 221 clean (proxy) and 270 with findings (proxy). Left out: 2 unreviewed (no sticky state, or no completed review) and 1 incomplete (files left unreviewed, no count, or a pruned state); 5 agent-stratum PRs, which the agent-authored split reports on their own, because same-agent iteration confounds the follow-up-fix label; and 3 agent-signal PRs, whose markers are untrusted, so they only exclude. The filtered rows also leave out the PRs reverted within 90 days and 1 marked filteredIncomplete.",
    )
    const headers = text.split("\n").filter((line) => line.startsWith("| Stratum |"))
    expect(headers.length).toBe(2)
    for (const header of headers) {
      expect(header).toContain("| Clean, nothing posted (proxy) | With findings (proxy) |")
      // Every mention of either group carries the proxy label.
      expect(header.match(/\b(?:Clean|clean)\b(?!, nothing posted \(proxy\)| \(proxy\))/g)).toBeNull()
      expect(header.match(/\b[Ww]ith findings\b(?! \(proxy\))/g)).toBeNull()
    }
  })

  test("the filtered rows read audited only when SF-05a's audit is", () => {
    const ledger = measured(BEATS)
    const sample = auditSample(ledger, KEY)
    const answers = new Map(sample.entries.map((entry) => [entry.id, entry.label === "positive"]))
    const audited = renderOutcomes(outcomeReport(ledger, { sample, labels: answers }))
    expect(outcomeReport(ledger, { sample, labels: answers }).labelQuality!.audit.audited).toBe(true)
    // The same-agent share counts fix entries, which the audit does not sample, so it reads unaudited either way.
    const share = "SZZ-based and unaudited: the audit samples PRs, not fix entries."
    for (const heading of ["## Verdict against outcome", "## Agent-authored split"]) {
      const shared = heading === "## Agent-authored split" ? 1 : 0
      expect(section(audited, heading)).toContain("(SZZ-based, size-biased, audited):")
      expect(section(audited, heading).split("unaudited").length - 1).toBe(shared)
      expect(section(audited, heading).split(share).length - 1).toBe(shared)
      expect(section(renderOutcomes(outcomeReport(ledger)), heading)).toContain("(SZZ-based, size-biased, unaudited):")
    }
  })

  test("dismissal reasons by severity read unavailable, with VS-35b's gate, and point to the Resolution table", () => {
    const report = outcomeReport(measured(BEATS))
    expect(report.cohorts!.dismissals).toEqual({ reason: NO_DISMISSAL_REASON })
    const text = section(renderOutcomes(report), "## Dismissal reasons by severity")
    expect(text).toContain(
      `\nReasons: ${NO_DISMISSAL_REASON}. VS-35b's classes (${DISMISSAL_WHY.join(", ")}) come from`,
    )
    expect(text).toContain("has no caller until an owner-repository precision sample of at least 0.9 qualifies it")
    expect(text).toContain("dismissed-unattributed counts in the Resolution table above")
    // No count of its own: the role counts are the Resolution table's, and no reason is counted.
    expect(text.split("\n").filter((line) => line.startsWith("|"))).toEqual([])
    expect(renderOutcomes(report)).toContain("\n## Resolution\n")
  })

  test("the addressed rate states its definition and population, with cycle time, comment volume and D12", () => {
    const base = measured([])
    const ledger = {
      ...base,
      pulls: [
        ...base.pulls,
        pullOf(3, 100, { cycleHours: 10, humanComments: 5 }),
        pullOf(4, 100, { reviewed: false, cycleHours: 20 }),
        pullOf(5, 100, { truncated: true }),
      ],
      findings: [
        ...base.findings,
        ...repeat(30, () => finding(3, "fixed-confirmed-by-thread")),
        finding(4, "acknowledged"),
        // Not settled, not human, or on a truncated PR: none counts.
        ...repeat(5, () => finding(3, "fixed-self-resolved")),
        ...repeat(3, () => finding(3, "fixed-confirmed-by-thread", { stratum: "agent" })),
        ...repeat(4, () => finding(5, "fixed-confirmed-by-thread")),
      ],
    }
    const addressed = cohorts(ledger).addressed
    expect(addressed.rate).toEqual(proportion(30, 231))
    expect(addressed.pulls).toBe(3)
    expect(addressed.comments).toMatchObject({ total: 6, p50: 3, missing: 1 })
    expect(addressed.comments.p90).toBeCloseTo(4.6, 9)
    expect(addressed.cycle!.p50).toBe(20)
    expect(addressed.cycle!.p90).toBeCloseTo(42.4, 9)
    const text = section(renderOutcomes(outcomeReport(ledger)), "## Addressed rate")
    expect(text).toContain(
      "Definition: a finding is addressed when it was marked fixed and its thread was resolved by a person who is neither a bot nor the PR author (fixed-confirmed-by-thread).",
    )
    expect(text).toContain(
      "Population: the 231 settled human-stratum findings on 3 PRs that no read cut short, merged in the window, matured or not",
    )
    expect(text).toContain("- Addressed: 30/231 13.0% [")
    expect(text).toContain("(cycle p50 / p90 20.0 / 42.4 h).")
    expect(text).toContain("on those PRs: 6 comments by people other than the PR author and the bots")
    expect(text).toContain("per PR, p50 / p90 3.0 / 4.6; 1 of the PRs carry no count (not reviewed).")
    expect(text).toContain(
      "Internal (D12): this rate is comparable only within this population under this definition, as a paired or A/B comparison on this repository. It is not comparable with any vendor's addressed, acceptance or resolution rate, or with any other population's.",
    )
  })

  test("human review by band covers every banded PR that no read cut short, matured or not", () => {
    const grouped = cohortLedger([
      { band: "low", lines: 10, count: 40, humanReview: false },
      { band: "low", lines: 10, count: 20 },
      { band: "high", lines: 1000, count: 30 },
    ])
    const ledger = {
      ...grouped,
      pulls: [
        ...grouped.pulls,
        pullOf(5, 10, { band: "low" }),
        pullOf(6, 200, { band: "high", humanReview: false, truncated: true }),
      ],
    }
    expect(ledgerProblem(ledger, NOW)).toBeUndefined()
    const rows = cohorts(ledger).humanReview
    expect(rows.low).toMatchObject({ pulls: 61, rate: proportion(21, 61) })
    expect(rows.medium).toMatchObject({ pulls: 0, rate: proportion(0, 0) })
    expect(rows.high).toMatchObject({ pulls: 30, rate: { ...proportion(30, 30), value: null } })
    expect(rows.all).toMatchObject({ pulls: 91, rate: proportion(51, 91) })
    const text = section(renderOutcomes(outcomeReport(ledger)), "## Human review by band")
    expect(text).toContain("| low | 61 | 21/61 34.4% [")
    expect(text).toContain("| medium | 0 | 0/0 | n/a |")
    expect(text).toContain("| all | 91 | 51/91 56.0% [")
    expect(text).toContain("cheap proxy for whether repository rules change scrutiny (P3-2), and evidence for Q28")
  })

  // Agent groups by trusted record, a human group of each size, and an agent-signal group. 10 and 1,000 lines: the cuts
  // are 10 and 1,000, so the small tercile holds the 10-line PRs and the middle the 1,000-line ones.
  const AGENT_GROUPS: CohortGroup[] = [
    { band: "low", lines: 10, count: 10, fixed: 4, stratum: "agent", sameAgent: true },
    { band: "high", lines: 1000, count: 10, fixed: 3, stratum: "agent", sameAgent: false },
    { band: "low", lines: 10, count: 10, fixed: 2, stratum: "agent" },
    { band: "low", lines: 10, count: 15, fixed: 3 },
    { band: "high", lines: 1000, count: 15, fixed: 3 },
    { band: "low", lines: 10, count: 5, fixed: 5, stratum: "agent-signal" },
  ]

  test("the agent-authored split within terciles, from the trusted record; agent signals only exclude", () => {
    const ledger = cohortLedger(AGENT_GROUPS)
    expect(ledgerProblem(ledger, NOW)).toBeUndefined()
    const agent = cohorts(ledger).agent
    expect(cohorts(ledger).size).toEqual({ cut: [10, 1000], pulls: { small: 40, middle: 25, large: 0 } })
    expect(agent.excluded).toBe(5)
    expect(agent.labels.filtered.map(counts)).toEqual([
      ["small", 20, 6, 15, 3, "underpowered"],
      ["middle", 10, 3, 15, 3, "underpowered"],
      ["large", 0, 0, 0, 0, "empty"],
    ])
    expect(agent.labels.revert.map(counts)).toEqual([
      ["small", 20, 0, 15, 0, "underpowered"],
      ["middle", 10, 0, 15, 0, "underpowered"],
      ["large", 0, 0, 0, 0, "empty"],
    ])
    // Same-agent follow-ups removed: the same agent's fixes make no positive, another's do, and the two PRs only unknown
    // fixes could make positive are left out.
    expect(agent.labels.filteredOther.map(counts)).toEqual([
      ["small", 18, 0, 15, 3, "underpowered"],
      ["middle", 10, 3, 15, 3, "underpowered"],
      ["large", 0, 0, 0, 0, "empty"],
    ])
    expect(agent.unknown).toBe(2)
    // 4 same-agent fixes, 3 another's and 2 unknown, on both labels.
    expect(agent.sameAgent).toEqual({
      filtered: { share: { count: 4, total: 7, value: null, interval: null }, unknown: 2 },
      unfiltered: { share: { count: 4, total: 7, value: null, interval: null }, unknown: 2 },
    })

    // An untrusted signal only excludes: a human PR turned agent-signal leaves the human group, and the agent group is
    // as it was.
    const signal = cohorts({
      ...ledger,
      pulls: ledger.pulls.map((pull) =>
        pull.number === 13_000 ? { ...pull, stratum: "agent-signal" as const } : pull,
      ),
    }).agent
    expect(signal.excluded).toBe(6)
    expect(signal.labels.filtered.map(counts)[0]).toEqual(["small", 20, 6, 14, 3, "underpowered"])
    expect(signal.labels.filtered.map((row) => row.a)).toEqual(agent.labels.filtered.map((row) => row.a))
    // An agent-signal PR's own outcomes change no row.
    const quiet = cohorts({
      ...ledger,
      pulls: ledger.pulls.map((pull) =>
        pull.stratum === "agent-signal" ? { ...pull, fixes: [], fixesFiltered: [], revertedDays: 5 } : pull,
      ),
    }).agent
    expect(quiet).toEqual(agent)

    const text = section(renderOutcomes(outcomeReport(ledger)), "## Agent-authored split")
    expect(text).toContain("Untrusted markers only exclude: the 5 agent-signal PRs enter neither group.")
    expect(text).toContain("There is no unstratified row.")
    expect(text).toContain("and 2 agent PRs are left out")
    expect(text).toContain(
      "filtered label 4/7, with 2 unknown and left out; unfiltered label 4/7, with 2 unknown and left out. No interval: fix entries cluster within PRs and fix commits. SZZ-based and unaudited: the audit samples PRs, not fix entries.",
    )
    expect(text).toContain(
      "\nFiltered follow-up fix within 90 days, same-agent follow-ups removed (SZZ-based, size-biased, unaudited):\n",
    )
    expect(text).toContain("This is evidence for Q41, which is the owner's; this report decides nothing.")
    expect(text).not.toContain("confounded by size")
  })

  test("recurrence is descriptive, with a strict merge day, the PR's own fix left out and the lookback truncation", () => {
    const hash = (digit: string) => digit.repeat(16)
    const [P, Q, R, S, T, U, W, X, Y, K, Z, F] = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "a", "b", "f"].map(hash)
    const commit = (days: number, locations: LedgerFixCommit["locations"], capped = false): LedgerFixCommit => ({
      date: day(days),
      kind: "label",
      deleted: { code: 1, blank: 0, comment: 0 },
      locations,
      ...(capped ? { capped: true as const } : {}),
    })
    const fixCommits = [
      commit(195, [{ path: P, fn: F }]), // 0: A's own fix
      commit(300, [{ path: P, fn: F }]), // 1: an earlier fix in P's function F
      commit(250, [{ path: Q }], true), // 2: capped
      commit(200, [{ path: R }]), // 3: on the merge day
      commit(566, [{ path: S }]), // 4: 366 days before the merge
      commit(565, [{ path: T }]), // 5: 365 days before
      commit(300, [{ path: U, fn: F }]), // 6: F in another file
      commit(300, [{ path: Y }]), // 7: Y, no funcname
      commit(250, [{ path: W }]), // 8: C's own fix, dated as if before its merge
      commit(190, []), // 9: the other PRs' own fix
      commit(190, [{ path: K }, { path: P, fn: F }]), // 10: I's own fix, editing K and P's F
    ]
    const pr = (number: number, daysAgo: number, filtered: { commit: number; path: string; fn?: string }, own = 9) =>
      pullOf(number, daysAgo, {
        band: "low",
        fixes: [
          {
            days: 5,
            lines: 1,
            kind: "label",
            commit: own,
            deleted: { code: 1, blank: 0, comment: 0, whitespace: 0, moved: 0 },
          },
        ],
        fixesFiltered: [
          {
            days: 5,
            lines: 1,
            kind: "label",
            commit: filtered.commit,
            location: { path: filtered.path, ...(filtered.fn ? { fn: filtered.fn } : {}) },
          },
        ],
      })
    const base = measured([])
    const ledger: OutcomeLedger = {
      ...base,
      pulls: [
        ...base.pulls,
        pr(20, 200, { commit: 0, path: P, fn: F }, 0), // A: file and function
        pr(21, 200, { commit: 8, path: W }, 8), // C: only its own fix touched W
        pr(22, 200, { commit: 9, path: R }), // D: R's fix is on the merge day
        pr(23, 200, { commit: 9, path: S }), // E: S's fix is 366 days before
        pr(24, 200, { commit: 9, path: T }), // E2: T's fix is 365 days before
        pr(25, 200, { commit: 9, path: X, fn: F }), // F: F exists only in another file
        pr(26, 200, { commit: 9, path: Y }), // G: a file match, with no funcname on either side
        pr(27, 600, { commit: 9, path: Z }), // H: the first merge
        pr(28, 200, { commit: 10, path: K }, 10), // I: its own fix commit also edits P's F
      ],
      fixCommits,
    }
    expect(ledgerProblem(ledger, NOW)).toBeUndefined()
    const recurrence = cohorts(ledger).recurrence
    const shares = (side: { fixes: number; file: { count: number }; fn: { count: number } }) => [
      side.fixes,
      side.file.count,
      side.fn.count,
    ]
    // Filtered, at each entry's own location: A, E2 and G match a file, and A alone a function.
    expect(shares(recurrence.labels.filtered)).toEqual([9, 3, 1])
    // Unfiltered, at every location of its fix commit: A and I, both in P's F.
    expect(shares(recurrence.labels.unfiltered)).toEqual([9, 2, 2])
    // H's lookback starts before the first merge (its own), so the full columns leave it out.
    expect(recurrence.first).toBe(day(600))
    expect(shares(recurrence.labels.filtered.full)).toEqual([8, 3, 1])
    expect(shares(recurrence.labels.unfiltered.full)).toEqual([8, 2, 2])
    expect(recurrence.capped).toBe(1)
    expect(recurrence.labels.filtered.file).toEqual({ count: 3, total: 9, value: null, interval: null })
    expect(RECURRENCE_DAYS).toBe(365)

    const text = section(renderOutcomes(outcomeReport(ledger)), "## Recurrence")
    expect(text).toContain("VS-46d item 10, descriptive only:")
    expect(text).toContain("so it gates nothing; L6 waits on the Q9 ablation alone.")
    expect(text).toContain(`the scan keeps fix commits only after the window's first merge (${day(600)})`)
    expect(text).toContain("- 1 fix commits had more than 32 locations and keep only their first 32")
    expect(text).toContain("| filtered | 9 | 3/9 | 1/9 | 8 | 3/8 | 1/8 |")
    expect(text).toContain("| unfiltered | 9 | 2/9 | 2/9 | 8 | 2/8 | 2/8 |")
    expect(text).toContain("No interval: fix entries cluster within PRs and fix commits.")
  })

  // A local eval artifact's drops: 100 recorded 120 days before NOW and 5 recorded 30 days before, alternating bug and
  // security, with fields the reader ignores.
  const dropAt = (days: number) => new Date(NOW - days * DAY).toISOString()
  const fixtureDrop = (index: number, days: number): LatentDrop => ({
    path: `src/file-${index}.ts`,
    base: { sha: "a".repeat(40), start: 3, end: 7 },
    class: index % 2 ? "security" : "bug",
    fingerprint: index.toString(16).padStart(12, "0"),
    at: dropAt(days),
  })
  const ARTIFACT = {
    startedAt: dropAt(120),
    variant: "engine:baseline",
    drops: [...repeat(100, (index) => fixtureDrop(index, 120)), ...repeat(5, (index) => fixtureDrop(100 + index, 30))],
  }
  // An artifact's drops, or the test fails with the reader's reason.
  const dropsOf = (artifact: unknown) => {
    const drops = latentDrops(artifact)
    if (typeof drops === "string") throw new Error(drops)
    return drops
  }
  // The fixture's join: each drop with the days to its first fix, as the unbuilt join would give them.
  const joined = (drops: readonly LatentDrop[], days: (index: number) => number | undefined): LatentOutcome[] =>
    drops.map((drop, index) => {
      const fixed = days(index)
      return fixed === undefined ? { drop } : { drop, fixedDays: fixed }
    })

  test("latent scoring on a fixture artifact, and its kill rule", () => {
    const drops = dropsOf({ ...ARTIFACT, drops: ARTIFACT.drops.map((drop) => ({ ...drop, note: "ignored" })) })
    expect(drops).toEqual(ARTIFACT.drops)
    expect(latentDrops({ startedAt: dropAt(1) })).toEqual([])
    const valid = ARTIFACT.drops[0]
    for (const [artifact, reason] of [
      [null, "the artifact is not an object"],
      [[valid], "the artifact is not an object"],
      ["drops", "the artifact is not an object"],
      [{ drops: "x" }, "the artifact holds a malformed drop"],
      [{ drops: repeat(MAX_LATENT_DROPS + 1, () => valid) }, `the artifact holds more than ${MAX_LATENT_DROPS} drops`],
      [{ drops: [{ ...valid, base: { ...valid.base, sha: "a".repeat(39) } }] }, "the artifact holds a malformed drop"],
      [{ drops: [{ ...valid, base: { ...valid.base, end: 2 } }] }, "the artifact holds a malformed drop"],
      [{ drops: [{ ...valid, base: { ...valid.base, start: 0 } }] }, "the artifact holds a malformed drop"],
      [{ drops: [{ ...valid, class: "pre-existing" }] }, "the artifact holds a malformed drop"],
      [{ drops: [{ ...valid, class: "bug|injected" }] }, "the artifact holds a malformed drop"],
      [{ drops: [{ ...valid, fingerprint: "xyz" }] }, "the artifact holds a malformed drop"],
      [{ drops: [{ ...valid, at: "yesterday" }] }, "the artifact holds a malformed drop"],
      // Date.parse reads these, but not by the ECMAScript format: `at` is a UTC instant as toISOString writes it.
      [{ drops: [{ ...valid, at: "Nov 15 2026" }] }, "the artifact holds a malformed drop"],
      [{ drops: [{ ...valid, at: "2026-11-15" }] }, "the artifact holds a malformed drop"],
      [{ drops: [{ ...valid, at: "2026-11-15T10:00:00+02:00" }] }, "the artifact holds a malformed drop"],
      [{ drops: [{ ...valid, at: "2026-13-15T10:00:00Z" }] }, "the artifact holds a malformed drop"],
      [{ drops: [{ ...valid, path: "" }] }, "the artifact holds a malformed drop"],
      [{ drops: [{ ...valid, path: "p".repeat(4097) }] }, "the artifact holds a malformed drop"],
    ] as const)
      expect(latentDrops(artifact)).toBe(reason)
    expect(latentDrops({ drops: repeat(MAX_LATENT_DROPS, () => valid) })).toHaveLength(MAX_LATENT_DROPS)
    expect(dropsOf({ drops: [{ ...valid, at: "2026-11-15T10:00:00Z" }] })[0].at).toBe("2026-11-15T10:00:00Z")

    // 9 of the 100 matured drops fixed within 90 days, and every unmatured one: precision 9%, the criterion met.
    expect([LATENT_KILL_PRECISION, LATENT_MIN_DROPS]).toEqual([0.1, 100])
    const nine = joined(drops, (index) => (index < 9 || index >= 100 ? 10 : undefined))
    const met = latentForecast(nine, NOW)
    expect(met).toEqual({
      status: "kill-met",
      drops: 105,
      repeated: 0,
      matured: 100,
      precision: { count: 9, total: 100, value: 0.09, interval: null },
      byClass: [
        { class: "bug", matured: 50, fixed: 5 },
        { class: "security", matured: 50, fixed: 4 },
      ],
    })
    // 10 fixed is precision 10%, not under it. A fix after 91 days or on the drop's own day is no hit; one at 90 is.
    const ten = latentForecast(
      joined(drops, (index) => (index < 9 ? 10 : index === 9 ? 90 : index === 10 ? 91 : index === 11 ? 0 : undefined)),
      NOW,
    )
    expect(ten).toMatchObject({ status: "kill-not-met", matured: 100, precision: { count: 10, total: 100 } })
    // 99 matured drops are too few, whatever they show.
    expect(
      latentForecast(
        joined(drops.slice(1), () => undefined),
        NOW,
      ),
    ).toMatchObject({
      status: "too-few",
      matured: 99,
      precision: { count: 0, total: 99, value: null },
    })
    expect(latentForecast([], NOW).status).toBe("no-drops")
    expect(latentForecast(undefined, NOW)).toEqual({
      status: "not-read",
      drops: 0,
      repeated: 0,
      matured: 0,
      precision: { count: 0, total: 0, value: null, interval: null },
      byClass: [],
    })
    // Every outcome is checked before any is scored: one malformed outcome refuses them all.
    for (const bad of [
      { drop: drops[0], fixedDays: Number.NaN },
      { drop: drops[0], fixedDays: -1 },
      { drop: drops[0], fixedDays: Number.POSITIVE_INFINITY },
      { drop: { ...drops[0], at: "Nov 15 2026" }, fixedDays: 10 },
      { drop: { ...drops[0], base: { ...drops[0].base, end: 1 } } },
    ])
      expect(latentForecast([...nine, bad], NOW)).toEqual({ ...latentForecast(undefined, NOW), status: "refused" })
    expect(latentForecast([...nine.slice(1), { drop: drops[0], fixedDays: 0.5 }], NOW).precision.count).toBe(9)
    expect(latentForecast([...nine.slice(1), { drop: drops[0], fixedDays: undefined }], NOW).precision.count).toBe(8)
    // A drop matures 90 days after it was recorded.
    expect(latentForecast(nine, NOW - 31 * DAY).matured).toBe(0)
    expect(latentForecast(nine, NOW + 60 * DAY).matured).toBe(105)
    // One defect dropped on several reviews counts once, at its earliest drop: a later repeat of a fixed drop adds
    // nothing, and an earlier, fixed repeat of an unfixed one makes it fixed.
    const later = { drop: { ...drops[0], at: dropAt(100) } }
    expect(latentForecast([...nine, later], NOW)).toEqual({ ...met, repeated: 1 })
    const earlier = { drop: { ...drops[50], at: dropAt(130) }, fixedDays: 20 }
    expect(latentForecast([...nine, earlier], NOW)).toMatchObject({
      status: "kill-not-met",
      drops: 105,
      repeated: 1,
      matured: 100,
      precision: { count: 10 },
    })
    // On a tie, the first in input order.
    expect(latentForecast([...nine, { drop: drops[50], fixedDays: 5 }], NOW).precision.count).toBe(9)

    // Through the report: outcomeReport takes the joined drops, and open passes none.
    const ledger = measured([])
    const text = section(renderOutcomes(outcomeReport(ledger, undefined, nine)), "## Latent forecasts")
    expect(text).toContain(
      "Status: kill criterion met (precision under 10% on at least 100 matured drops); the decision is the owner's.",
    )
    expect(text).toContain(
      "- Drops: 105 distinct (0 further drops of a fingerprint already counted), 100 matured; fixed within 90 days 9/100 9.0%.",
    )
    expect(text).toContain("| bug | 50 | 5 |\n| security | 50 | 4 |")
    expect(text).toContain("It reads only local eval artifacts, and no GitHub state or markers, which are public.")
    expect(text).toContain("on one repository the stream may not reach 100 matured drops")
    // With no outcomes given, as open gives none, the report says none were read; given and empty, none recorded.
    const unread = section(renderOutcomes(outcomeReport(ledger)), "## Latent forecasts")
    expect(unread).toContain("\nStatus: no drops read: open reads no eval artifact and no join is built.\n")
    expect(unread).not.toContain(NO_DROPS + ".")
    expect(unread).not.toContain("- Drops:")
    expect(outcomeReport(ledger).cohorts!.latent).toMatchObject({ status: "not-read", drops: 0, matured: 0 })
    const none = section(renderOutcomes(outcomeReport(ledger, undefined, [])), "## Latent forecasts")
    expect(none).toContain(`\nStatus: ${NO_DROPS}.\n`)
    expect(none).not.toContain("- Drops:")
    expect(outcomeReport(ledger, undefined, []).cohorts!.latent).toMatchObject({ status: "no-drops", drops: 0 })
    const refused = section(
      renderOutcomes(outcomeReport(ledger, undefined, [...nine, { drop: drops[0], fixedDays: -1 }])),
      "## Latent forecasts",
    )
    expect(refused).toContain(
      "\nStatus: refused: a latent outcome is malformed (a drop latentDrops would refuse, or a fixedDays that is not a finite number of days at or above 0), so none is scored.\n",
    )
    expect(refused).not.toContain("- Drops:")
  })

  test("a /1 ledger shows every SF-05b section as unavailable, in both decisions, and a gradient-only /2 report none", () => {
    const current = cohortLedger(STRATA_GROUPS)
    const outcomes = joined(dropsOf(ARTIFACT), () => 10)
    const legacy = outcomeReport(v1Of(current), undefined, outcomes)
    expect(legacy.cohorts).toBeUndefined()
    const gradient = outcomeReport(v1Of({ ...current, findings: [] }), undefined, outcomes)
    expect(gradient.volume.decision).toBe("gradient-only")
    for (const text of [renderOutcomes(legacy), renderOutcomes(gradient)])
      for (const heading of COHORT_HEADINGS) expect(section(text, heading)).toBe(`\n${heading}\n\n${V1_UNAVAILABLE}\n`)
    expect(v1Only(renderOutcomes(legacy))).toBe(v1Only(renderOutcomes(outcomeReport(current))))
    // A /2 ledger in the gradient-only decision adds no section, latent drops or not.
    const plain = outcomeReport({ ...current, findings: [] }, undefined, outcomes)
    expect(plain.cohorts).toBeUndefined()
    const text = renderOutcomes(plain)
    expect(v1Only(text)).toBe(text)
  })

  test("the report writes nothing: frozen inputs give the same report as their copies", () => {
    const ledger = cohortLedger([...STRATA_GROUPS, ...AGENT_GROUPS.slice(0, 3)])
    const outcomes = joined(dropsOf(ARTIFACT), (index) => (index < 9 ? 10 : undefined))
    const copies = { ledger: structuredClone(ledger), outcomes: structuredClone(outcomes) }
    deepFreeze(ledger)
    deepFreeze(outcomes)
    const report = outcomeReport(ledger, undefined, outcomes)
    expect(report).toEqual(outcomeReport(copies.ledger, undefined, copies.outcomes))
    expect(renderOutcomes(report)).toBe(renderOutcomes(outcomeReport(copies.ledger, undefined, copies.outcomes)))
    expect(ledger).toEqual(copies.ledger)
    expect(outcomes).toEqual(copies.outcomes)
  })
})

// The 97.5% Wilson intervals of 40/50 and 5/50 composed into recall over 100 positives and 300 negatives, printed from
// core wilson when SF-05a was built.
const RECALL_INTERVAL = [0.47999287872607554, 0.885109284327646] as const

// A collected history lifted into the full decision, which VS-46d's sections need as VS-46c's do: PR 1, merged 30 days
// before collection, with MIN_VOLUME acknowledged findings.
function fullOf(ledger: OutcomeLedger): OutcomeLedger {
  return {
    ...ledger,
    pulls: [pullOf(1, 30), ...ledger.pulls],
    findings: [...ledger.findings, ...repeat(MIN_VOLUME, () => finding(1, "acknowledged"))],
  }
}

// A sample answered as `answer` says, by label and by place among that label's entries (in id order): the labels file
// the owner would pass back.
function labelsFrom(
  sample: AuditSample,
  answer: (label: AuditEntry["label"], index: number) => boolean | null,
): AuditSample {
  const positives = sample.entries.filter((entry) => entry.label === "positive").length
  return {
    ...sample,
    entries: sample.entries.map((entry, index) => ({
      ...entry,
      fixInducing: answer(entry.label, entry.label === "positive" ? index : index - positives),
    })),
  }
}

const day = (days: number) => new Date(NOW - days * DAY).toISOString().slice(0, 10)

const digest = (text: string) => createHash("sha256").update(text).digest("hex")

// One digest per report section, keyed by its heading ("#" for the opening lines), so a later package that changes one
// section re-pins only that one.
function sectionDigests(text: string) {
  return Object.fromEntries(
    text
      .split(/(?=\n## )/)
      .map((part, index) => [index === 0 ? "#" : part.slice(1, part.indexOf("\n", 1)), digest(part)]),
  )
}

// A schema-2 ledger's v1 part, keys in their order: the schema named /1, and every schema-2 field left out.
function v1Of(ledger: OutcomeLedger): OutcomeLedgerV1 {
  const { subjects: _subjects, fixCommits: _fixCommits, rule: _rule, ...rest } = ledger
  return { ...rest, schema: LEDGER_SCHEMA_V1, pulls: ledger.pulls.map(v1Pull) }
}

function v1Pull(pull: LedgerPull): LedgerPullV1 {
  const {
    added: _added,
    deleted: _deleted,
    unreviewedFiles: _unreviewed,
    humanComments: _comments,
    fixesFiltered: _filtered,
    filteredIncomplete: _incomplete,
    sameAgentIncomplete: _unknown,
    ...rest
  } = pull
  return {
    ...rest,
    ...(pull.fixes ? { fixes: pull.fixes.map((fix) => ({ days: fix.days, lines: fix.lines, kind: fix.kind })) } : {}),
  }
}

// VS-46c's sections, in their order: a /2 report in the full decision prints them, a /1 report prints each as
// V1_UNAVAILABLE.
const MEASUREMENT_HEADINGS = [
  "## Outcome base rates",
  "## Minimum detectable effect",
  "## Capture against size",
  "## Measurement verdict",
  "## Depth and reach",
]

// VS-46d items 1 to 4's sections (SF-05a), in their order after VS-46c's: a /2 report in the full decision prints them,
// a /1 report prints each as V1_UNAVAILABLE.
const LABEL_HEADINGS = [
  "## Label audit",
  "## Untraceable fixes",
  "## Filter reattribution",
  "## Fix-edited lines per kLOC",
]

// VS-46d items 5 to 11's sections (SF-05b), in their order after SF-05a's: a /2 report in the full decision prints them,
// a /1 report prints each as V1_UNAVAILABLE.
const COHORT_HEADINGS = [
  "## Verdict against outcome",
  "## Dismissal reasons by severity",
  "## Addressed rate",
  "## Human review by band",
  "## Agent-authored split",
  "## Recurrence",
  "## Latent forecasts",
]

// A report without its schema-2 sections.
function v1Only(text: string) {
  return text
    .split(/(?=\n## )/)
    .filter(
      (part) =>
        ![...MEASUREMENT_HEADINGS, ...LABEL_HEADINGS, ...COHORT_HEADINGS].some((heading) =>
          part.startsWith(`\n${heading}\n`),
        ),
    )
    .join("")
}

// The text of one report section, its heading line included.
function section(text: string, heading: string) {
  return text.split(/(?=\n## )/).find((part) => part.startsWith(`\n${heading}\n`)) ?? ""
}

// A full-decision ledger that reaches every v1 report section: 200 settled human-stratum findings, each severity and
// outcome, the split strata, line counts, 200 banded matured PRs whose low and high intervals overlap, and a problem.
function fullSynthetic(): OutcomeLedger {
  const severities = ["blocking", "concern", "nit"] as const
  const ledger = synthetic(
    [
      ...repeat(MIN_VOLUME, (index) => finding(1, "acknowledged", { severity: severities[index % 3] })),
      ...repeat(60, (index) =>
        finding(3, index % 2 ? "fixed-confirmed-by-thread" : "dismissed-writer", {
          severity: "blocking",
          ...(index % 2 ? {} : { dismisser: index % 4 ? "1".repeat(16) : "2".repeat(16) }),
          laterFixed: index % 3 === 0,
        }),
      ),
      finding(3, "open-at-merge", { laterFixed: true, category: "security" }),
      finding(3, "dismissed-author", { laterFixed: false }),
      finding(3, "dismissed-unattributed", { laterFixed: true }),
      finding(3, "fixed-self-resolved", { humanEngaged: false }),
      finding(3, "fixed-model-only", { humanEngaged: false }),
      finding(3, "outdated"),
      finding(4, "fixed-confirmed-by-thread", { stratum: "agent" }),
      finding(4, "acknowledged", { stratum: "agent-signal" }),
      finding(4, "dismissed-writer", { stratum: "bulk" }),
    ],
    [
      pullOf(3, 100, {
        cycleHours: 10,
        humanReview: false,
        reviews: 3,
        rereviews: 2,
        costUsd: 1.25,
        lines: { edited: 4, flagged: 1, escaped: 2, unreviewed: 1, skipped: 0 },
      }),
      pullOf(4, 120, { stratum: "agent", reviewed: false, cycleHours: 5 }),
      ...repeat(MIN_MATURED / 2, (index) =>
        pullOf(1000 + index, 200, {
          band: "low",
          fixes: index < 10 ? [{ days: 5, lines: 1, kind: "title", commit: 0 }] : [],
          ...(index === 0 ? { revertedDays: 20 } : {}),
        }),
      ),
      ...repeat(MIN_MATURED / 2, (index) =>
        pullOf(2000 + index, 200, {
          band: index % 5 ? "high" : "medium",
          fixes: index < 12 ? [{ days: 40, lines: 2, kind: "label", commit: 0 }] : [],
        }),
      ),
    ],
  )
  return { ...ledger, problems: ["PR #9: its comments stopped at 30 pages"] }
}

// ---------------------------------------------------------------------------------------------------------------
// Synthetic ledgers

function synthetic(findings: LedgerFinding[], pulls: LedgerPull[] = []): OutcomeLedger {
  return {
    schema: LEDGER_SCHEMA,
    repository: REPOSITORY,
    branch: "main",
    collectedAt: new Date(NOW).toISOString(),
    observedUntil: new Date(NOW).toISOString(),
    expires: new Date(NOW + LEDGER_DAYS * DAY).toISOString(),
    merged: { since: new Date(NOW - 300 * DAY).toISOString(), until: new Date(NOW).toISOString() },
    logins: "hmac-sha256/per-run",
    pulls: [pullOf(1, 30), pullOf(2, 91), ...pulls],
    findings,
    subjects: { commits: 0, fix: 0, revert: 0 },
    fixCommits: [],
    rule: { ...MEASUREMENT_RULE },
    problems: [],
  }
}

// A banded PR's default size: one file, no tie-breaker, so its score is log2(1 + lines) and its band is the score's own.
const BAND_LINES = { low: 10, medium: 200, high: 1000 } as const

function pullOf(number: number, daysAgo: number, extra: Partial<LedgerPull> = {}): LedgerPull {
  return {
    number,
    author: "0".repeat(16),
    stratum: "human",
    reviewed: true,
    humanReview: true,
    createdAt: new Date(NOW - daysAgo * DAY - 2 * DAY).toISOString(),
    mergedAt: new Date(NOW - daysAgo * DAY).toISOString(),
    cycleHours: 48,
    reviews: 1,
    rereviews: 0,
    costUsd: 0.1,
    statePruned: false,
    truncated: false,
    matured: daysAgo >= 90,
    ...(daysAgo >= 90 ? { fixes: [], fixesFiltered: [] } : {}),
    ...(extra.band ? { score: Math.log2(1 + BAND_LINES[extra.band]), added: BAND_LINES[extra.band], deleted: 0 } : {}),
    ...(extra.reviewed === false ? {} : { unreviewedFiles: 0, humanComments: 1 }),
    ...extra,
  }
}

// A group of single-file PRs for measured(): `fixed` of them (spread evenly, PR numbers ascending) have a filtered and
// an unfiltered fix, the last `reverted` were reverted, and `score` overrides log2(1 + lines).
interface Group {
  band: RiskBand
  lines: number
  count: number
  fixed?: number
  reverted?: number
  score?: number
}

// A full-decision schema-2 ledger for VS-46c: MIN_VOLUME acknowledged findings on PR 1, subjects {100, 20, 5}, one label
// fix commit, and each group's PRs merged 200 days ago, numbered from 10,000 + 1,000 times the group's index.
function measured(groups: readonly Group[], rule: MeasurementRule = MEASUREMENT_RULE): OutcomeLedger {
  const pulls = groups.flatMap((group, at) =>
    repeat(group.count, (index) => {
      const fixed = evenly(index, group.count, group.fixed ?? 0)
      const fix = { days: 5, lines: 1, kind: "label" as const, commit: 0 }
      return pullOf(10_000 + at * 1000 + index, 200, {
        band: group.band,
        score: group.score ?? Math.log2(1 + group.lines),
        added: group.lines,
        deleted: 0,
        fixes: fixed ? [{ ...fix, deleted: { code: 1, blank: 0, comment: 0, whitespace: 0, moved: 0 } }] : [],
        fixesFiltered: fixed ? [{ ...fix, location: { path: "0123456789abcdef" } }] : [],
        ...(index >= group.count - (group.reverted ?? 0) ? { revertedDays: 30 } : {}),
      })
    }),
  )
  return {
    ...synthetic(
      repeat(MIN_VOLUME, () => finding(1, "acknowledged")),
      pulls,
    ),
    subjects: { commits: 100, fix: 20, revert: 5 },
    fixCommits: [{ date: "2026-07-10", kind: "label", deleted: { code: 1, blank: 0, comment: 0 }, locations: [] }],
    rule: { ...rule },
  }
}

// Whether the PR at `index` of `count` is one of `k` spread evenly through them: the first n hold floor(n k / count).
function evenly(index: number, count: number, k: number) {
  return Math.floor(((index + 1) * k) / count) > Math.floor((index * k) / count)
}

// A group for cohortLedger: measured()'s group, with the fields VS-46d items 5 to 9 read. `posted` gives each PR one
// acknowledged finding of its stratum; `sameAgent` goes on every fix entry of an agent group, and without it each agent
// PR with a fix is marked sameAgentIncomplete, as collection marks one.
interface CohortGroup extends Group {
  posted?: boolean
  stratum?: PullStratum
  reviewed?: boolean
  reviews?: number
  unreviewed?: number
  humanReview?: boolean
  filteredIncomplete?: boolean
  sameAgent?: boolean
}

// measured()'s ledger with each group's fields on its PRs, as collection records them, so ledgerProblem passes it.
function cohortLedger(groups: readonly CohortGroup[]): OutcomeLedger {
  const ledger = measured(groups)
  const groupOf = (pull: LedgerPull) =>
    pull.number >= 10_000 ? groups[Math.floor((pull.number - 10_000) / 1000)] : undefined
  const pulls = ledger.pulls.map((pull): LedgerPull => {
    const group = groupOf(pull)
    if (!group) return pull
    const { unreviewedFiles: _unreviewed, humanComments: _comments, ...rest } = pull
    const stratum = group.stratum ?? "human"
    const reviewed = group.reviewed ?? true
    const flag = stratum === "agent" && group.sameAgent !== undefined ? { sameAgent: group.sameAgent } : {}
    return {
      ...rest,
      stratum,
      reviewed,
      humanReview: group.humanReview ?? true,
      reviews: group.reviews ?? 1,
      ...(reviewed ? { unreviewedFiles: group.unreviewed ?? 0, humanComments: 1 } : {}),
      fixes: (pull.fixes ?? []).map((fix) => ({ ...fix, ...flag })),
      fixesFiltered: (pull.fixesFiltered ?? []).map((fix) => ({ ...fix, ...flag })),
      ...(group.filteredIncomplete ? { filteredIncomplete: true as const } : {}),
      ...(stratum === "agent" && group.sameAgent === undefined && (pull.fixes ?? []).length
        ? { sameAgentIncomplete: true as const }
        : {}),
    }
  })
  return {
    ...ledger,
    pulls,
    findings: [
      ...ledger.findings,
      ...pulls.flatMap((pull) =>
        groupOf(pull)?.posted ? [finding(pull.number, "acknowledged", { stratum: pull.stratum })] : [],
      ),
    ],
  }
}

// Freezes a value and everything it holds, so any write to it throws (the test file is a module, so strict mode).
function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    Object.values(value).forEach(deepFreeze)
    Object.freeze(value)
  }
  return value
}

function withoutScore(pull: LedgerPull): LedgerPull {
  const { score: _score, ...rest } = pull
  return rest
}

function finding(pr: number, result: Outcome, extra: Partial<LedgerFinding> = {}): LedgerFinding {
  return {
    pr,
    id: "0".repeat(12),
    where: "inline",
    severity: "concern",
    category: "bug",
    outcome: result,
    stratum: "human",
    humanEngaged: true,
    ...extra,
  }
}

function repeat<T>(count: number, make: (index: number) => T): T[] {
  return Array.from({ length: count }, (_, index) => make(index))
}

// ---------------------------------------------------------------------------------------------------------------
// The synthetic repository and its GitHub

function input() {
  return {
    repository: REPOSITORY,
    since: NOW - 210 * DAY,
    until: NOW - DAY,
    bots: [BOT],
    agentPulls: new Set([6]),
  }
}

// Fixture repositories are built without the user's or the system's git config (so no hook or signing runs), with a
// fixed identity and dates taken from NOW.
function fixtureGit(dir: string, args: string[], at?: number) {
  const date =
    at === undefined
      ? {}
      : { GIT_AUTHOR_DATE: `@${Math.floor(at / 1000)} +0000`, GIT_COMMITTER_DATE: `@${Math.floor(at / 1000)} +0000` }
  const result = Bun.spawnSync(
    [
      "git",
      ...UNTRUSTED_GIT,
      "-c",
      "commit.gpgsign=false",
      "-c",
      "init.defaultBranch=main",
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      ...args,
    ],
    { cwd: dir, env: { ...untrustedGitEnv(), ...date }, stdin: "ignore", stdout: "pipe", stderr: "pipe" },
  )
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr.toString()}`)
  return result.stdout.toString().trim()
}

function commitAll(dir: string, message: string[], at: number) {
  fixtureGit(dir, ["add", "-A"])
  fixtureGit(dir, ["commit", "-q", ...message.flatMap((part) => ["-m", part])], at)
  return fixtureGit(dir, ["rev-parse", "HEAD"])
}

function write(dir: string, files: Record<string, string | null>) {
  for (const [path, text] of Object.entries(files)) {
    const file = join(dir, path)
    if (text === null) {
      rmSync(file)
      continue
    }
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, text)
  }
}

const range = (from: number, to: number, word: string) =>
  Array.from({ length: to - from + 1 }, (_, index) => `${word} ${from + index}`)
const textOf = (lines: string[]) => lines.join("\n") + "\n"

const CAFE = "src/caf\u00e9.ts"
const QUOTED = 'src/say "hi".ts'

// main, one squash commit per PR except #3, which is a merge commit of a feature branch:
//   c0 (300 days ago) base; #1 (200) adds app.ts lines 11-20; #2 (180) adds auth.ts; a direct revert of #2 (170), or
//   with `revertMerge` a revert branch merged as #5 (labelled bug, titled as no revert); #3 (151 on its branch, merged
//   150) adds lines 21-30, a lockfile and two files whose names git quotes; #4 (120, labelled bug) edits app.ts lines
//   12 and 25, line 3 of the first and line 9 of the second; #6 (60) adds lines 31-35; a README edit (5) ends the
//   history. Blame along the first parent puts #3's lines on its merge commit, not its branch commit.
function fixtureRepo(name: string, options: { revertMerge?: boolean } = {}) {
  const dir = join(root, name)
  mkdirSync(dir, { recursive: true })
  fixtureGit(dir, ["init", "-q"])
  const base = range(1, 10, "base")
  const one = [...base, ...range(11, 20, "one")]
  const three = [...one, ...range(21, 30, "three")]
  const fixed = three.map((line, index) => (index === 11 ? "fixed 12" : index === 24 ? "fixed 25" : line))
  const cafe = range(1, 10, "cafe")
  const hi = range(1, 10, "hi")
  const at = (days: number) => NOW - days * DAY
  write(dir, { "src/app.ts": textOf(base), "README.md": "widgets\n" })
  commitAll(dir, ["Initial"], at(300))
  write(dir, { "src/app.ts": textOf(one) })
  const c1 = commitAll(dir, ["Add feature one (#1)"], at(200))
  write(dir, { "src/auth.ts": textOf(range(1, 5, "auth")) })
  const c2 = commitAll(dir, ["Add auth (#2)"], at(180))
  const c3 = options.revertMerge ? revertBranch(dir, c2, at) : undefined
  if (!options.revertMerge) {
    write(dir, { "src/auth.ts": null })
    commitAll(dir, ['Revert "Add auth (#2)"', `This reverts commit ${c2}.`], at(170))
  }
  fixtureGit(dir, ["checkout", "-q", "-b", "three"])
  write(dir, {
    "src/app.ts": textOf(three),
    "package-lock.json": "{}\n",
    [CAFE]: textOf(cafe),
    [QUOTED]: textOf(hi),
  })
  commitAll(dir, ["Add feature three"], at(151))
  fixtureGit(dir, ["checkout", "-q", "main"])
  fixtureGit(dir, ["merge", "-q", "--no-ff", "-m", "Merge pull request #3 from acme/three", "three"], at(150))
  const c4 = fixtureGit(dir, ["rev-parse", "HEAD"])
  write(dir, {
    "src/app.ts": textOf(fixed),
    [CAFE]: textOf(cafe.map((line, index) => (index === 2 ? "fixed cafe 3" : line))),
    [QUOTED]: textOf(hi.map((line, index) => (index === 8 ? "fixed hi 9" : line))),
  })
  const c5 = commitAll(dir, ["Handle the crash (#4)"], at(120))
  write(dir, { "src/app.ts": textOf([...fixed, ...range(31, 35, "six")]) })
  const c6 = commitAll(dir, ["Add six (#6)"], at(60))
  write(dir, { "README.md": "widgets, and how to build them\n" })
  commitAll(dir, ["Update the README"], at(5))
  return { dir, world: world({ c1, c2, c4, c5, c6, ...(c3 ? { c3 } : {}) }, at) }
}

// A revert of #2 on its own branch, merged with --no-ff under GitHub's merge message: the revert sits on the second
// parent, and the first-parent message names no target.
function revertBranch(dir: string, c2: string, at: (days: number) => number) {
  fixtureGit(dir, ["checkout", "-q", "-b", "revert-2-add-auth"])
  fixtureGit(dir, ["revert", "--no-edit", c2], at(171))
  fixtureGit(dir, ["checkout", "-q", "main"])
  fixtureGit(
    dir,
    [
      "merge",
      "-q",
      "--no-ff",
      "-m",
      "Merge pull request #5 from acme/revert-2-add-auth",
      "-m",
      "Remove auth for now",
      "revert-2-add-auth",
    ],
    at(170),
  )
  return fixtureGit(dir, ["rev-parse", "HEAD"])
}

// The filtered label's history, one squash commit per PR: base (300 days ago); a direct commit (230, before the
// window's first merge) adds a line; #10 (200, agent-account) adds a comment, a blank line, two values and a flag block
// to calc.ts, a comment and a line to tool.py and an #include to main.c; #11 (180, helper[bot]) reindents the direct
// line and the flag block and adds a value; optional chores (170); #12 (150, agent-account, labelled bug) deletes the
// direct line, the comment, the blank line, the py comment and the reindented console line, and edits the rate line and
// the #include; #13 (140, agent-account, "Fix rounding") deletes #10's cap; #14 (130, other-agent, labelled bug) edits
// #10's py line; #15 (125, helper[bot], "fix: ...") deletes #11's value; a README edit (5) ends the history.
const CALC_HEADER = "export function computeRate(input) {"
const TUNE_HEADER = "def tune(value):"
const AGENT = { login: "agent-account" }
const HELPER = { login: "helper[bot]", type: "Bot" }

function filterRepo(name: string, options: { chores?: number } = {}) {
  const dir = join(root, name)
  mkdirSync(dir, { recursive: true })
  fixtureGit(dir, ["init", "-q"])
  const at = (days: number) => NOW - days * DAY
  const calc = (lines: string[]) =>
    textOf([
      CALC_HEADER,
      "  const base = input.base",
      "  const factor = input.factor",
      ...lines,
      "  return base * factor",
      "}",
    ])
  write(dir, {
    "src/calc.ts": calc([]),
    "src/tool.py": textOf([TUNE_HEADER, "    return value"]),
    "src/main.c": textOf(["int main(void) {", "  return 0;", "}"]),
    "README.md": "calc\n",
  })
  commitAll(dir, ["Initial"], at(300))
  write(dir, { "src/calc.ts": calc(["  const directValue = 1"]) })
  const direct = commitAll(dir, ["Tune the calculator"], at(230))
  write(dir, {
    "src/calc.ts": calc([
      "  const directValue = 1",
      "  // the rate is the base times the factor",
      "",
      "  const rateValue = base * factor",
      "  const capValue = Math.min(rateValue, 100)",
      "  if (input.flag) {",
      '    console.log("flagged")',
      "  }",
    ]),
    "src/tool.py": textOf([TUNE_HEADER, "    # tune later", "    value = value * 2", "    return value"]),
    "src/main.c": textOf(["#include <stdio.h>", "int main(void) {", "  return 0;", "}"]),
  })
  const c10 = commitAll(dir, ["Add the rate (#10)"], at(200))
  write(dir, {
    "src/calc.ts": calc([
      "    const directValue = 1",
      "  // the rate is the base times the factor",
      "",
      "  const rateValue = base * factor",
      "  const capValue = Math.min(rateValue, 100)",
      "  const botValue = rateValue + 1",
      "    if (input.flag) {",
      '      console.log("flagged")',
      "    }",
    ]),
  })
  const c11 = commitAll(dir, ["Reindent the flag block (#11)"], at(180))
  repeat(options.chores ?? 0, (index) =>
    fixtureGit(dir, ["commit", "-q", "--allow-empty", "-m", `Chore ${index}`], at(170)),
  )
  write(dir, {
    "src/calc.ts": calc([
      "  const rateValue = base * factor * 1",
      "  const capValue = Math.min(rateValue, 100)",
      "  const botValue = rateValue + 1",
      "    if (input.flag) {",
      "    }",
    ]),
    "src/tool.py": textOf([TUNE_HEADER, "    value = value * 2", "    return value"]),
    "src/main.c": textOf(["#include <stdlib.h>", "int main(void) {", "  return 0;", "}"]),
  })
  const c12 = commitAll(dir, ["fix: tidy the rate (#12)"], at(150))
  write(dir, {
    "src/calc.ts": calc([
      "  const rateValue = base * factor * 1",
      "  const botValue = rateValue + 1",
      "    if (input.flag) {",
      "    }",
    ]),
  })
  const c13 = commitAll(dir, ["Fix rounding (#13)"], at(140))
  write(dir, { "src/tool.py": textOf([TUNE_HEADER, "    value = value * 3", "    return value"]) })
  const c14 = commitAll(dir, ["Handle the overflow (#14)"], at(130))
  write(dir, {
    "src/calc.ts": calc(["  const rateValue = base * factor * 1", "    if (input.flag) {", "    }"]),
  })
  const c15 = commitAll(dir, ["fix: drop the bot value (#15)"], at(125))
  write(dir, { "README.md": "calc, and how to run it\n" })
  commitAll(dir, ["Update the README"], at(5))
  return {
    dir,
    direct,
    world: plainWorld(
      [
        listing(10, 200, "Add the rate", AGENT, c10),
        listing(11, 180, "Reindent the flag block", HELPER, c11),
        listing(12, 150, "fix: tidy the rate", AGENT, c12, ["bug"]),
        listing(13, 140, "Fix rounding", AGENT, c13),
        listing(14, 130, "Handle the overflow", { login: "other-agent" }, c14, ["bug"]),
        listing(15, 125, "fix: drop the bot value", HELPER, c15),
      ],
      {
        10: [prFile("src/calc.ts", 7), prFile("src/tool.py", 2), prFile("src/main.c", 1)],
        11: [prFile("src/calc.ts", 5, 4)],
        12: [prFile("src/calc.ts", 1, 5), prFile("src/tool.py", 0, 1), prFile("src/main.c", 1, 1)],
        13: [prFile("src/calc.ts", 0, 1)],
        14: [prFile("src/tool.py", 1, 1)],
        15: [prFile("src/calc.ts", 0, 1)],
      },
    ),
  }
}

function filterInput(trusted: number[]) {
  return {
    repository: REPOSITORY,
    since: NOW - 250 * DAY,
    until: NOW - DAY,
    bots: [BOT],
    agentPulls: new Set(trusted),
  }
}

// Moved lines: #20 (200 days ago) adds a block after app.ts's first line and another at the end of other.ts; #21 (150)
// moves the first to the end of app.ts and the second into target.ts; #22 (130, labelled bug) edits one line of each.
// Each block line has fewer alphanumeric characters than git's move threshold (20) and each block more, so blame finds
// a moved line's origin only over the whole file: a single-line -L range leaves it on the mover.
const ALPHA = ["alphaOne = 11", "alphaTwo = 22", "alphaThree = 33", "alphaFour = 44", "alphaFive = 55"]
const BETA = ["betaOne = 101", "betaTwo = 202", "betaThree = 303", "betaFour = 404", "betaFive = 505"]

function moveRepo(name: string) {
  const dir = join(root, name)
  mkdirSync(dir, { recursive: true })
  fixtureGit(dir, ["init", "-q"])
  const at = (days: number) => NOW - days * DAY
  const header = 'export const header = "the application module"'
  const base = Array.from({ length: 10 }, (_, index) => `export const base${index} = "a base line that stays put"`)
  const other = ['export const otherOne = "other one"', 'export const otherTwo = "other two"']
  const target = ['export const targetOne = "target one"', 'export const targetTwo = "target two"']
  const edited = (lines: string[]) => lines.map((line, index) => (index === 2 ? `${line} // edited` : line))
  write(dir, {
    "src/app.ts": textOf([header, ...base]),
    "src/other.ts": textOf(other),
    "src/target.ts": textOf(target),
    "README.md": "moves\n",
  })
  commitAll(dir, ["Initial"], at(300))
  write(dir, { "src/app.ts": textOf([header, ...ALPHA, ...base]), "src/other.ts": textOf([...other, ...BETA]) })
  const c20 = commitAll(dir, ["Add the blocks (#20)"], at(200))
  write(dir, {
    "src/app.ts": textOf([header, ...base, ...ALPHA]),
    "src/other.ts": textOf(other),
    "src/target.ts": textOf([...target, ...BETA]),
  })
  const c21 = commitAll(dir, ["Move the blocks (#21)"], at(150))
  write(dir, {
    "src/app.ts": textOf([header, ...base, ...edited(ALPHA)]),
    "src/target.ts": textOf([...target, ...edited(BETA)]),
  })
  const c22 = commitAll(dir, ["Handle the edge (#22)"], at(130))
  write(dir, { "README.md": "moves, and why\n" })
  commitAll(dir, ["Update the README"], at(5))
  return {
    dir,
    world: plainWorld(
      [
        listing(20, 200, "Add the blocks", { login: "dev-one" }, c20),
        listing(21, 150, "Move the blocks", { login: "dev-two" }, c21),
        listing(22, 130, "Handle the edge", { login: "dev-three" }, c22, ["bug"]),
      ],
      {
        20: [prFile("src/app.ts", 5), prFile("src/other.ts", 5)],
        21: [prFile("src/app.ts", 5, 5), prFile("src/other.ts", 0, 5), prFile("src/target.ts", 5)],
        22: [prFile("src/app.ts", 1, 1), prFile("src/target.ts", 1, 1)],
      },
    ),
  }
}

// The untraceable share: base (300 days ago) holds a clamp function; #40 (200) adds a limit function with a comment
// line; #41 (180, labelled bug, "fix: add a null check") only adds a line; #42 (160, labelled bug) deletes only the
// comment line; #43 (140, labelled bug) edits one of #40's code lines; a README edit (5) ends the history.
function addOnlyRepo(name: string) {
  const dir = join(root, name)
  mkdirSync(dir, { recursive: true })
  fixtureGit(dir, ["init", "-q"])
  const at = (days: number) => NOW - days * DAY
  const clamp = ["export function clamp(value) {", "  return value", "}"]
  const limit = (lines: string[]) => textOf([...clamp, "export function limit(value) {", ...lines, "}"])
  write(dir, { "src/limit.ts": textOf(clamp), "README.md": "limits\n" })
  commitAll(dir, ["Initial"], at(300))
  write(dir, { "src/limit.ts": limit(["  // keep the value under the cap", "  return Math.min(value, 100)"]) })
  const c40 = commitAll(dir, ["Add the limit (#40)"], at(200))
  write(dir, {
    "src/limit.ts": limit([
      "  if (value === null) return 0",
      "  // keep the value under the cap",
      "  return Math.min(value, 100)",
    ]),
  })
  const c41 = commitAll(dir, ["fix: add a null check (#41)"], at(180))
  write(dir, { "src/limit.ts": limit(["  if (value === null) return 0", "  return Math.min(value, 100)"]) })
  const c42 = commitAll(dir, ["Drop a stale note (#42)"], at(160))
  write(dir, { "src/limit.ts": limit(["  if (value === null) return 0", "  return Math.min(value, 99)"]) })
  const c43 = commitAll(dir, ["Handle the cap (#43)"], at(140))
  write(dir, { "README.md": "limits, and why\n" })
  commitAll(dir, ["Update the README"], at(5))
  return {
    dir,
    world: plainWorld(
      [
        listing(40, 200, "Add the limit", { login: "dev-one" }, c40),
        listing(41, 180, "fix: add a null check", { login: "dev-two" }, c41, ["bug"]),
        listing(42, 160, "Drop a stale note", { login: "dev-two" }, c42, ["bug"]),
        listing(43, 140, "Handle the cap", { login: "dev-three" }, c43, ["bug"]),
      ],
      {
        40: [prFile("src/limit.ts", 4)],
        41: [prFile("src/limit.ts", 1)],
        42: [prFile("src/limit.ts", 0, 1)],
        43: [prFile("src/limit.ts", 1, 1)],
      },
    ),
  }
}

// A fix commit's own PR at the call cap: #30 (200 days ago, agent-account) adds two values; 200 chores (170) that v1
// looks up; a direct commit (150, no PR) titled as a fix edits one of #30's values; a README edit (5) ends the history.
function ownCapRepo(name: string) {
  const dir = join(root, name)
  mkdirSync(dir, { recursive: true })
  fixtureGit(dir, ["init", "-q"])
  const at = (days: number) => NOW - days * DAY
  const calc = (lines: string[]) => textOf([CALC_HEADER, ...lines, "  return input", "}"])
  write(dir, { "src/calc.ts": calc([]), "README.md": "calc\n" })
  commitAll(dir, ["Initial"], at(300))
  write(dir, { "src/calc.ts": calc(["  const thirtyValue = 30", "  const otherValue = 31"]) })
  const c30 = commitAll(dir, ["Add the values (#30)"], at(200))
  repeat(200, (index) => fixtureGit(dir, ["commit", "-q", "--allow-empty", "-m", `Chore ${index}`], at(170)))
  write(dir, { "src/calc.ts": calc(["  const thirtyValue = 32", "  const otherValue = 31"]) })
  const fix = commitAll(dir, ["fix: correct the value"], at(150))
  write(dir, { "README.md": "calc, and how to run it\n" })
  commitAll(dir, ["Update the README"], at(5))
  return {
    dir,
    fix,
    world: plainWorld([listing(30, 200, "Add the values", AGENT, c30)], { 30: [prFile("src/calc.ts", 2)] }),
  }
}

// The filtered blame's bound: base (300 days ago) holds a lockfile, a file one line over MAX_FILTERED_BLAME_LINES, one
// at it and a small one; #40 (200) edits one line of each; #42 (180) only reindents big.ts's; #41 (150, labelled bug)
// edits the same four lines again.
function boundRepo(name: string) {
  const dir = join(root, name)
  mkdirSync(dir, { recursive: true })
  fixtureGit(dir, ["init", "-q"])
  const at = (days: number) => NOW - days * DAY
  const values = (word: string, count: number, edited: number, note: string, indent = "") =>
    textOf(
      Array.from({ length: count }, (_, index) =>
        index + 1 === edited && note
          ? `${indent}export const ${word}${index + 1} = ${index + 1} // ${note}`
          : `export const ${word}${index + 1} = ${index + 1}`,
      ),
    )
  const files = (note: string, indent = "") => ({
    "package-lock.json": textOf(["{", `  "name": "bounded${note ? `-${note}` : ""}",`, '  "lockfileVersion": 3', "}"]),
    "src/big.ts": values("big", MAX_FILTERED_BLAME_LINES + 1, 3, note, indent),
    "src/edge.ts": values("edge", MAX_FILTERED_BLAME_LINES, 4, note),
    "src/small.ts": values("small", 5, 2, note),
  })
  write(dir, { ...files(""), "README.md": "bounded\n" })
  commitAll(dir, ["Initial"], at(300))
  write(dir, files("forty"))
  const c40 = commitAll(dir, ["Tune the values (#40)"], at(200))
  write(dir, files("forty", "  "))
  const c42 = commitAll(dir, ["Reindent the value (#42)"], at(180))
  write(dir, files("fixed"))
  const c41 = commitAll(dir, ["Handle the overflow (#41)"], at(150))
  write(dir, { "README.md": "bounded, and why\n" })
  commitAll(dir, ["Update the README"], at(5))
  const edited = ["package-lock.json", "src/big.ts", "src/edge.ts", "src/small.ts"].map((path) => prFile(path, 1, 1))
  return {
    dir,
    world: plainWorld(
      [
        listing(40, 200, "Tune the values", { login: "dev-one" }, c40),
        listing(42, 180, "Reindent the value", { login: "dev-three" }, c42),
        listing(41, 150, "Handle the overflow", { login: "dev-two" }, c41, ["bug"]),
      ],
      { 40: edited, 42: [prFile("src/big.ts", 1, 1)], 41: edited },
    ),
  }
}

// A merged PR as the listing gives it.
function listing(
  number: number,
  days: number,
  title: string,
  author: { login: string; type?: string },
  sha: string,
  labels: string[] = [],
) {
  const at = NOW - days * DAY
  return {
    number,
    title,
    user: { login: author.login, type: author.type ?? "User" },
    labels: labels.map((label) => ({ name: label })),
    created_at: new Date(at - 2 * DAY).toISOString(),
    merged_at: new Date(at).toISOString(),
    updated_at: new Date(at + 3_600_000).toISOString(),
    merge_commit_sha: sha,
    base: { ref: "main" },
  }
}

// A GitHub with merged PRs and their files only: no state, so nothing is reviewed.
function plainWorld(pulls: Record<string, unknown>[], files: Record<number, unknown[]>): World {
  return { pulls, comments: {}, threads: {}, moreComments: {}, files, reviews: {}, commits: {}, permissions: {} }
}

// The ledger's own read-only git, recording every call.
function recordingGit(dir: string) {
  const calls: string[][] = []
  const git = localGit(dir)
  return {
    calls,
    git: (args: readonly string[]) => {
      calls.push([...args])
      return git(args)
    },
  }
}

interface World {
  pulls: Record<string, unknown>[]
  comments: Record<number, unknown[]>
  threads: Record<number, unknown[]>
  moreComments: Record<string, unknown[]>
  files: Record<number, unknown[]>
  reviews: Record<number, unknown[]>
  commits: Record<number, unknown[]>
  permissions: Record<string, string>
}

function world(
  shas: Record<"c1" | "c2" | "c4" | "c5" | "c6", string> & { c3?: string },
  at: (days: number) => number,
): World {
  const listed = (number: number, days: number, title: string, author: string, sha: string, labels: string[] = []) => ({
    number,
    title,
    user: { login: author, type: "User" },
    labels: labels.map((label) => ({ name: label })),
    created_at: new Date(at(days) - 2 * DAY).toISOString(),
    merged_at: new Date(at(days)).toISOString(),
    updated_at: new Date(at(days) + 3_600_000).toISOString(),
    merge_commit_sha: sha,
    base: { ref: "main" },
  })
  const sticky = (state: ReviewState) => ({
    id: 900,
    body: `${SUMMARY_MARKER}\n**Vector review**\n\n${stateMarker(state)}`,
    user: { login: BOT },
  })
  const one: ReviewState = {
    ...emptyState(),
    head: shas.c1,
    reviews: 2,
    costUsd: 0.5,
    findings: [
      {
        id: "aaaaaaaaaaa1",
        path: "src/app.ts",
        line: 20,
        side: "RIGHT",
        severity: "concern",
        category: "bug",
        title: "Summary concern",
        sha: shas.c1.slice(0, 7),
        status: "open",
      },
    ],
  }
  return {
    pulls: [
      listed(1, 200, "Add feature one", "dev-one", shas.c1),
      listed(2, 180, "Add auth", "dev-two", shas.c2),
      listed(3, 150, "Add feature three", "dev-three", shas.c4),
      listed(4, 120, "Handle the crash", "dev-four", shas.c5, ["bug"]),
      ...(shas.c3 ? [listed(5, 170, "Remove auth for now", "dev-two", shas.c3, ["bug"])] : []),
      listed(6, 60, "Add six", "agent-account", shas.c6),
      // Merged before the window, and closed without a merge: neither is read.
      listed(8, 250, "Old", "dev-one", "e".repeat(40)),
      { ...listed(7, 100, "Closed", "dev-one", "d".repeat(40)), merged_at: null },
    ],
    comments: {
      1: [{ id: 1, body: "Thanks", user: { login: "dev-one" } }, sticky(one)],
      2: [sticky({ ...emptyState(), reviews: 1 })],
      3: [
        sticky({
          ...emptyState(),
          reviews: 1,
          unreviewed: ["src/other.ts"],
          // A summary finding whose other named line (9) is the one #4 fixes.
          findings: [
            {
              id: "b0b0b0b0b0b3",
              path: QUOTED,
              line: 1,
              side: "RIGHT",
              severity: "concern",
              category: "bug",
              title: "Summary concern",
              sha: "1234567",
              status: "open",
              also: [9],
            },
          ],
        }),
      ],
      6: [sticky({ ...emptyState(), reviews: 1 })],
    },
    threads: {
      1: [
        threadNode({
          id: "T1",
          line: 17,
          resolvedBy: { login: "alice" },
          more: true,
          comments: [
            commentNode(
              101,
              inline({ id: "bbbbbbbbbbb1", severity: "blocking", status: "fixed", fixedIn: "abcdef1" }),
              { login: "vector-app", bot: true },
            ),
          ],
        }),
        threadNode({
          id: "T2",
          line: 19,
          comments: [
            commentNode(
              102,
              inline({ id: "ccccccccccc1", severity: "nit", status: "dismissed" }),
              { login: "vector-app", bot: true },
              [
                { content: "THUMBS_DOWN", users: [{ login: "dev-one" }] },
                { content: "THUMBS_UP", users: [{ login: "carol" }] },
              ],
            ),
          ],
        }),
        // Another bot's thread is never read as a finding, and neither is a User account named like the App, at the
        // line #4 fixes.
        threadNode({
          id: "T9",
          line: 5,
          comments: [commentNode(109, inline({ id: "fffffffffff9" }), { login: "other-bot", bot: true })],
        }),
        threadNode({
          id: "T10",
          line: 12,
          comments: [commentNode(110, inline({ id: "c0c0c0c0c0c1" }), { login: "vector-app" })],
        }),
      ],
      2: [
        threadNode({
          id: "T4",
          line: null,
          originalLine: 3,
          path: "src/auth.ts",
          comments: [
            commentNode(104, inline({ id: "ddddddddddd2", status: "outdated" }), { login: "vector-app", bot: true }),
          ],
        }),
      ],
      3: [
        threadNode({
          id: "T3",
          line: 22,
          comments: [
            commentNode(103, inline({ id: "ddddddddddd3" }), { login: "vector-app", bot: true }),
            commentNode(203, "Good catch, will fix.", { login: "bob" }),
          ],
        }),
        // A file name git quotes, and a reply from a deleted (ghost) account, which acknowledges nothing.
        threadNode({
          id: "T6",
          line: 2,
          path: CAFE,
          comments: [
            commentNode(107, inline({ id: "a0a0a0a0a0a3" }), { login: "vector-app", bot: true }),
            commentNode(207, "Good catch, will fix.", { login: "" }),
          ],
        }),
      ],
      6: [
        threadNode({
          id: "T5",
          line: 32,
          resolvedBy: { login: "agent-account" },
          comments: [
            commentNode(106, inline({ id: "eeeeeeeeeee6", status: "fixed", fixedIn: "abcdef1" }), {
              login: "vector-app",
              bot: true,
            }),
          ],
        }),
      ],
    },
    moreComments: { T1: [commentNode(201, "Fixed it, thanks.", { login: "alice" })] },
    files: {
      1: [prFile("src/app.ts", 10)],
      2: [prFile("src/auth.ts", 5)],
      3: [prFile("src/app.ts", 10), prFile("package-lock.json", 1), prFile(CAFE, 10), prFile(QUOTED, 10)],
      4: [prFile("src/app.ts", 2, 2), prFile(CAFE, 1, 1), prFile(QUOTED, 1, 1)],
      6: [prFile("src/app.ts", 5)],
    },
    reviews: {
      // On reviewed #3: a person's review with a body counts as a comment; an empty body, the author's own and a bot's
      // do not.
      3: [
        { user: { login: "carol", type: "User" }, state: "COMMENTED", body: "Looks right to me." },
        { user: { login: "dave", type: "User" }, state: "APPROVED", body: "" },
        { user: { login: "erin", type: "User" }, state: "APPROVED", body: "  \n" },
        { user: { login: "dev-three", type: "User" }, state: "COMMENTED", body: "Answering the review." },
        { user: { login: "helper[bot]", type: "Bot" }, state: "COMMENTED", body: "Automated note." },
      ],
      4: [{ user: { login: "alice", type: "User" }, state: "APPROVED" }],
    },
    commits: {
      2: [
        {
          commit: { message: "Add auth\n\nCo-authored-by: helper[bot] <1+helper[bot]@users.noreply.github.com>" },
          author: { login: "dev-two", type: "User" },
        },
      ],
    },
    permissions: { alice: "write", "dev-one": "write", bob: "read" },
  }
}

function prFile(filename: string, additions: number, deletions = 0) {
  return { filename, status: "modified", additions, deletions, patch: `@@ -1,0 +1,${additions} @@\n+x` }
}

function inline(marker: Partial<FindingMarker> & { id: string }) {
  return `**Concern** · A synthetic finding\n\nSome text.\n\n${findingMarker({
    severity: "concern",
    category: "bug",
    sha: "1234567",
    status: "open",
    words: ["a", "synthetic", "finding"],
    ...marker,
  })}`
}

function threadNode(input: {
  id: string
  line: number | null
  originalLine?: number
  path?: string
  resolvedBy?: { login: string }
  more?: boolean
  comments: unknown[]
}) {
  return {
    id: input.id,
    isResolved: !!input.resolvedBy,
    isOutdated: input.line === null,
    path: input.path ?? "src/app.ts",
    line: input.line,
    originalLine: input.originalLine ?? input.line,
    diffSide: "RIGHT",
    resolvedBy: input.resolvedBy ? { __typename: "User", login: input.resolvedBy.login } : null,
    comments: { pageInfo: { hasNextPage: !!input.more, endCursor: input.more ? "next" : null }, nodes: input.comments },
  }
}

function commentNode(
  id: number,
  body: string,
  author: { login: string; bot?: boolean },
  reactions: { content: string; users: { login: string; bot?: boolean }[] }[] = [],
) {
  const actor = (who: { login: string; bot?: boolean }) => ({ __typename: who.bot ? "Bot" : "User", login: who.login })
  return {
    fullDatabaseId: String(id),
    body,
    author: actor(author),
    reactionGroups: reactions.map((group) => ({ content: group.content, reactors: { nodes: group.users.map(actor) } })),
  }
}

type Call =
  | { kind: "get"; path: string }
  | { kind: "query"; document: string; variables: Readonly<Record<string, string | number>> }

// A recording GitHub with only the two read methods; anything it does not know is an error.
function fakeGitHub(data: World): { github: GitHubRead; calls: Call[] } {
  const calls: Call[] = []
  const github: GitHubRead = {
    async get(path) {
      calls.push({ kind: "get", path })
      const url = new URL(`https://api.invalid${path}`)
      const page = Number(url.searchParams.get("page") ?? "1")
      const paged = (items: unknown[] | undefined) => (page === 1 ? (items ?? []) : [])
      const parts = url.pathname.split("/").slice(4)
      const number = Number(parts[1])
      if (!parts.length) return { default_branch: "main" }
      if (parts[0] === "pulls" && parts.length === 1) return paged(data.pulls)
      if (parts[0] === "issues" && parts[2] === "comments") return paged(data.comments[number])
      if (parts[0] === "pulls" && parts[2] === "files") return paged(data.files[number])
      if (parts[0] === "pulls" && parts[2] === "reviews") return paged(data.reviews[number])
      if (parts[0] === "pulls" && parts[2] === "commits") return paged(data.commits[number])
      if (parts[0] === "collaborators") {
        const level = data.permissions[decodeURIComponent(parts[1] ?? "")]
        if (!level) throw new Error("HTTP 404")
        return { permission: level, role_name: level }
      }
      if (parts[0] === "commits" && parts[2] === "pulls") return []
      throw new Error(`unexpected GET ${path}`)
    },
    async query(document, variables) {
      calls.push({ kind: "query", document, variables })
      if (document === THREADS_QUERY)
        return {
          data: {
            repository: {
              pullRequest: {
                reviewThreads: {
                  pageInfo: { hasNextPage: false, endCursor: null },
                  nodes: data.threads[Number(variables.number)] ?? [],
                },
              },
            },
          },
        }
      if (document === THREAD_COMMENTS_QUERY)
        return {
          data: {
            node: {
              comments: {
                pageInfo: { hasNextPage: false, endCursor: null },
                nodes: data.moreComments[String(variables.id)] ?? [],
              },
            },
          },
        }
      throw new Error("unexpected query")
    },
  }
  return { github, calls }
}
