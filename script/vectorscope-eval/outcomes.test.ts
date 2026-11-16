import { afterAll, describe, expect, test } from "bun:test"
import { generateKeyPairSync } from "node:crypto"
import {
  existsSync,
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
import type { PriorFinding, ReviewState } from "../../packages/core/src/review/types"
import { UNTRUSTED_GIT, untrustedGitEnv } from "./dataset"
import {
  agentStratum,
  bulkResolved,
  collect,
  findingOutcome,
  FIX_LABEL,
  fixKind,
  ghArgs,
  ghReader,
  hashLogin,
  LEDGER_DAYS,
  LEDGER_SCHEMA,
  ledgerProblem,
  localGit,
  main,
  matured,
  MIN_MATURED,
  MIN_SETTLED,
  MIN_VOLUME,
  NOT_FIX_LABEL,
  OUTCOMES,
  outcomeReport,
  READ_ONLY_GIT,
  renderOutcomes,
  REPORT_FILE,
  revertsOf,
  revertTargets,
  SEALED_LEDGER,
  THREAD_COMMENTS_QUERY,
  THREADS_QUERY,
  WRITER_PERMISSIONS,
  type GitHubRead,
  type LedgerFinding,
  type LedgerPull,
  type Outcome,
  type OutcomeLedger,
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
      pullOf(10, 200, { band: "high", revertedDays: 10, fixes: [{ days: 20, lines: 1, kind: "label" }] }),
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
    const bands = (low: number, high: number, highPulls = MIN_MATURED / 2) =>
      outcomeReport(
        synthetic(
          repeat(MIN_VOLUME, () => finding(1, "acknowledged")),
          [
            ...repeat(MIN_MATURED / 2, (index) =>
              pullOf(1000 + index, 200, {
                band: "low",
                fixes: index < low ? [{ days: 5, lines: 1, kind: "title" }] : [],
              }),
            ),
            ...repeat(highPulls, (index) =>
              pullOf(2000 + index, 200, {
                band: "high",
                fixes: index < high ? [{ days: 5, lines: 1, kind: "title" }] : [],
              }),
            ),
          ],
        ),
      ).bands!.separation
    expect(bands(10, 12)).toBe("overlap")
    expect(bands(0, 100)).toBe("separated")
    // 199 matured PRs with a band (the synthetic ledger's own matured PR has none).
    expect(bands(0, 99, MIN_MATURED / 2 - 1)).toBe("too-few")
    expect(renderOutcomes(outcomeReport(synthetic(repeat(MIN_VOLUME, () => finding(1, "acknowledged")))))).toContain(
      "Separation: too-few",
    )
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
    const ledger = (overrides: Record<string, unknown> = {}) => ({
      ...synthetic([finding(1, "acknowledged")]),
      ...overrides,
    })
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
    ])
      expect(ledgerProblem(bad, NOW)).toContain("malformed")
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
    problems: [],
  }
}

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
    ...(daysAgo >= 90 ? { fixes: [] } : {}),
    ...extra,
  }
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
    reviews: { 4: [{ user: { login: "alice", type: "User" }, state: "APPROVED" }] },
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
