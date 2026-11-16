import { describe, expect, test } from "bun:test"
import { GithubAgents } from "@vectordevai/core/github-agents"
import { DEFAULT_MENTIONS, parseReviewCommand } from "@vectordevai/core/review/command"
import { parseUnifiedDiff } from "@vectordevai/core/review/diff"
import {
  classifyPrior,
  decodeState,
  emptyState,
  encodeState,
  escapeVectorMarkers,
  findingMarker,
  findSticky,
  followAlso,
  inlineTitle,
  MAX_STATE_CHARS,
  mergePrior,
  monthKey,
  nextState,
  parseFindingMarker,
  parseReviewMarker,
  priorFromComment,
  priorFromState,
  pruneState,
  readState,
  reviewMarker,
  setFindingStatus,
  stateMarker,
  SUMMARY_MARKER,
  teamPatterns,
  type ClassifyContext,
} from "@vectordevai/core/review/state"
import type {
  Finding,
  PlacedFinding,
  PriorFinding,
  ReviewCost,
  ReviewState,
  Selection,
  SummaryFinding,
} from "@vectordevai/core/review/types"

const HEAD = "e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4"
const OLD = "d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3"
const BASE = "0123456789abcdef0123456789abcdef01234567"
const NOW = Date.UTC(2026, 8, 14, 14, 2)

function summaryFinding(i: number, overrides: Partial<SummaryFinding> = {}): SummaryFinding {
  return {
    id: i.toString(16).padStart(12, "0"),
    path: `src/file${i}.ts`,
    line: i + 1,
    side: "RIGHT",
    severity: "concern",
    category: "bug",
    title: `Finding number ${i}`,
    sha: "a1b2c3d",
    status: "open",
    ...overrides,
  }
}

function base64url(text: string) {
  const bytes = new TextEncoder().encode(text)
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "")
}

function rawJson(payload: string): Record<string, unknown> {
  const padded = payload.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (payload.length % 4)) % 4)
  return JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(padded), (c) => c.charCodeAt(0))))
}

const FULL: ReviewState = {
  v: 1,
  head: HEAD,
  base: BASE,
  reviews: 3,
  costUsd: 0.37,
  tokens: [48_200, 3_100],
  month: { key: "2026-09", costUsd: 1.25 },
  unreviewed: ["src/a.ts", "src/file1.ts"],
  failed: true,
  notedHead: OLD,
  inlinePosted: 4,
  inflight: { run: "8f3c21aa", head: HEAD, at: 1_757_858_520_000, costUsd: 0.12 },
  findings: [
    summaryFinding(1),
    summaryFinding(2, { side: "LEFT", severity: "nit", category: "style", status: "fixed", fixedIn: "e5f6a7b" }),
    summaryFinding(3, { path: "src/file1.ts", status: "dismissed" }),
  ],
}

describe("encodeState and decodeState", () => {
  test("round-trip every field", () => {
    expect(decodeState(encodeState(FULL))).toEqual(FULL)
    expect(decodeState(encodeState(emptyState()))).toEqual(emptyState())
  })

  test("use base64url, short keys and a shared path table", () => {
    const encoded = encodeState(FULL)
    expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/)
    const raw = rawJson(encoded)
    expect(Object.keys(raw).sort()).toEqual(["b", "c", "f", "h", "i", "m", "n", "p", "r", "s", "t", "u", "v", "x"])
    expect(raw.p).toEqual(["src/file1.ts", "src/file2.ts", "src/a.ts"])
    expect(raw.u).toEqual([2, 0])
  })

  test("Codium review counts use k while c remains dollars and old states stay readable", () => {
    const state = { ...FULL, codiumReviews: 2 }
    const raw = rawJson(encodeState(state))
    expect(raw.k).toBe(2)
    expect(raw.c).toBe(0.37)
    expect(decodeState(encodeState(state))).toEqual(state)
    delete raw.k
    expect(decodeState(base64url(JSON.stringify(raw)))).toEqual(FULL)
    expect(decodeState(encodeState({ ...FULL, codiumReviews: 0 }))?.codiumReviews).toBe(0)
  })

  test.each([-1, "4", null, 2.9])("Codium counts decode leniently without changing dollars: %j", (value) => {
    const raw = { ...rawJson(encodeState(FULL)), k: value }
    const decoded = decodeState(base64url(JSON.stringify(raw)))
    expect(decoded?.codiumReviews).toBe(value === 2.9 ? 2 : 0)
    expect(decoded?.costUsd).toBe(FULL.costUsd)
  })

  test("cap titles at 60 characters", () => {
    const state = { ...emptyState(), findings: [summaryFinding(1, { title: "x".repeat(90) })] }
    expect(decodeState(encodeState(state))?.findings[0]?.title).toBe("x".repeat(60))
  })

  test("return undefined for garbage", () => {
    expect(decodeState("")).toBeUndefined()
    expect(decodeState("%%%")).toBeUndefined()
    expect(decodeState("AAAA")).toBeUndefined()
    expect(decodeState(base64url("[1,2]"))).toBeUndefined()
    expect(decodeState(base64url('{"v":2,"r":1}'))).toBeUndefined()
    expect(decodeState("__4")).toBeUndefined() // not UTF-8
  })

  test("keep the other places a finding names, after fixedIn or in its place", () => {
    const state: ReviewState = {
      ...emptyState(),
      findings: [
        summaryFinding(1, { also: [40, 90] }),
        summaryFinding(2, { status: "fixed", fixedIn: "e5f6a7b", also: [7] }),
        summaryFinding(3),
      ],
    }
    expect(decodeState(encodeState(state))).toEqual(state)
    // A state written before places were kept, and a malformed list, read as no places.
    const raw = rawJson(encodeState(state))
    const entries = raw.s as unknown[][]
    entries[0]![10] = ["40", -1, 2.5]
    expect(decodeState(base64url(JSON.stringify(raw)))?.findings[0]?.also).toBeUndefined()
  })

  test("skip a malformed finding entry and keep the rest", () => {
    const payload = base64url(
      JSON.stringify({
        v: 1,
        r: 1,
        c: 0,
        t: [0, 0],
        u: [0, 9],
        i: 0,
        s: [
          ["zz", 0, 1, 0, 0, 0, "bad id", "a1b2c3d", 0],
          ["00000000000a", 0, 5, 0, 1, 1, "kept", "a1b2c3d", 0],
          ["00000000000b", 0, 5, 0, 7, 1, "bad severity", "a1b2c3d", 0],
        ],
        p: ["src/a.ts"],
      }),
    )
    const state = decodeState(payload)
    expect(state?.findings.map((finding) => finding.title)).toEqual(["kept"])
    expect(state?.unreviewed).toEqual(["src/a.ts"])
  })
})

describe("pruneState", () => {
  const tier = (finding: SummaryFinding) =>
    finding.status !== "open" ? 0 : finding.severity === "nit" ? 1 : finding.severity === "concern" ? 2 : 3

  test("100 findings with 200-character paths fit in 16,000 characters, dropped in the stated order", () => {
    const findings = Array.from({ length: 100 }, (_, i) =>
      summaryFinding(i, {
        path: `src/${"x".repeat(180)}/${String(i).padStart(3, "0")}${"y".repeat(9)}.ts`,
        title: "t".repeat(80),
        status: i < 30 ? (["fixed", "dismissed", "outdated"] as const)[i % 3] : "open",
        fixedIn: i < 30 && i % 3 === 0 ? "e5f6a7b" : undefined,
        severity: i < 30 ? "concern" : i < 60 ? "nit" : i < 80 ? "concern" : "blocking",
      }),
    )
    expect(findings[0]?.path).toHaveLength(200)
    const state: ReviewState = { ...emptyState(), head: HEAD, base: BASE, findings }
    const encoded = encodeState(state)
    expect(encoded.length).toBeLessThanOrEqual(MAX_STATE_CHARS)

    const kept = decodeState(encoded)!.findings
    expect(kept.length).toBeGreaterThan(20)
    expect(kept.length).toBeLessThanOrEqual(60)
    // Dropped: the oldest closed findings first, then the oldest nits, then the oldest of the rest.
    const victims = findings
      .map((finding, index) => ({ index, tier: tier(finding) }))
      .sort((a, b) => a.tier - b.tier || a.index - b.index)
      .map((victim) => victim.index)
    const dropped = new Set(victims.slice(0, findings.length - kept.length))
    expect(kept.map((finding) => finding.id)).toEqual(
      findings.filter((_, index) => !dropped.has(index)).map((finding) => finding.id),
    )
    expect(kept.every((finding) => finding.title.length === 60)).toBe(true)
    expect(kept.some((finding) => finding.status !== "open")).toBe(false)
    expect(kept.some((finding) => finding.severity === "nit")).toBe(false)
  })

  test("caps the count at 60 by dropping closed findings first", () => {
    const findings = Array.from({ length: 65 }, (_, i) =>
      summaryFinding(i, i % 13 === 0 ? { status: "fixed", fixedIn: "e5f6a7b" } : {}),
    )
    const pruned = pruneState({ ...emptyState(), findings })
    expect(pruned.findings).toHaveLength(60)
    expect(pruned.findings.every((finding) => finding.status === "open")).toBe(true)
  })

  test("trims unreviewed only when nothing else is left to drop", () => {
    const unreviewed = Array.from({ length: 1_000 }, (_, i) => `src/${"p".repeat(90)}/${i}.ts`)
    const pruned = pruneState({ ...emptyState(), unreviewed })
    expect(encodeState(pruned).length).toBeLessThanOrEqual(MAX_STATE_CHARS)
    expect(pruned.unreviewed.length).toBeGreaterThan(0)
    expect(pruned.unreviewed).toEqual(unreviewed.slice(0, pruned.unreviewed.length))
    expect(pruneState(FULL)).toEqual(FULL)
  })
})

describe("markers", () => {
  test("the last state marker in the sticky wins, even when it is garbage", () => {
    const first = { ...emptyState(), reviews: 1 }
    const second = { ...emptyState(), reviews: 2 }
    expect(readState(`x\n${stateMarker(first)}\n${SUMMARY_MARKER}\n${stateMarker(second)}`)?.reviews).toBe(2)
    expect(readState(`${stateMarker(first)}\n<!-- vector-review:state v1 AAAA -->`)).toBeUndefined()
    expect(readState("no marker")).toBeUndefined()
  })

  test("the sticky is the oldest bot comment with the summary marker", () => {
    const comments = [
      { id: 5, body: `a person's copy ${SUMMARY_MARKER}`, user: { login: "someone" } },
      { id: 9, body: `a forged newer one ${SUMMARY_MARKER}`, user: { login: "github-actions[bot]" } },
      { id: 7, body: `the real one ${SUMMARY_MARKER}`, user: { login: "github-actions[bot]" } },
      { id: 3, body: "no marker", user: { login: "github-actions[bot]" } },
      { id: 1, body: null, user: null },
    ]
    expect(findSticky(comments, "github-actions[bot]")?.id).toBe(7)
    expect(findSticky(comments, "vector-bot")).toBeUndefined()
  })

  test("escapeVectorMarkers makes Vector markers inert and leaves other comments", () => {
    const text =
      "a <!-- vector-review:state v1 AAAA --> b <!--vector-finding v1 --> <!--   VECTOR-review:summary --> <!-- other -->"
    expect(escapeVectorMarkers(text)).toBe(
      "a &lt;!-- vector-review:state v1 AAAA --> b &lt;!--vector-finding v1 --> &lt;!--   VECTOR-review:summary --> <!-- other -->",
    )
    expect(readState(escapeVectorMarkers(stateMarker(FULL)))).toBeUndefined()
    const marker = findingMarker({
      id: "3f9a1c07be21",
      severity: "concern",
      category: "bug",
      sha: "a1b2c3d",
      status: "open",
      words: [],
    })
    expect(parseFindingMarker(escapeVectorMarkers(marker))).toBeUndefined()
  })

  test("the finding marker has the design's shape", () => {
    expect(
      findingMarker({
        id: "3f9a1c07be21",
        severity: "blocking",
        category: "bug",
        sha: "d4e5f6a7b8c9",
        status: "open",
        words: ["logout", "refresh", "restore", "session"],
      }),
    ).toBe("<!-- vector-finding v1 id=3f9a1c07be21 sev=b cat=bug sha=d4e5f6a st=o t=logout,refresh,restore,session -->")
    const base = {
      id: "3f9a1c07be21",
      severity: "nit" as const,
      category: "docs" as const,
      sha: "a1b2c3d",
      words: ["a", "b", "c", "d", "e", "f", "g"],
    }
    expect(findingMarker({ ...base, status: "fixed", fixedIn: HEAD })).toContain(" st=f:e5f6a7b t=a,b,c,d,e,f -->")
    expect(findingMarker({ ...base, status: "dismissed" })).toContain(" sev=n cat=docs sha=a1b2c3d st=d ")
    expect(findingMarker({ ...base, status: "outdated", words: [] })).toEndWith(" st=x -->")
  })

  test("parseFindingMarker reads every status, and only the last marker", () => {
    for (const status of ["open", "fixed", "dismissed", "outdated"] as const) {
      const marker = {
        id: "3f9a1c07be21",
        severity: "concern" as const,
        category: "security" as const,
        sha: "a1b2c3d",
        status,
        words: ["token"],
        ...(status === "fixed" ? { fixedIn: "e5f6a7b" } : {}),
      }
      expect(parseFindingMarker(`text\n${findingMarker(marker)}`)).toEqual(marker)
    }
    const older = findingMarker({
      id: "000000000001",
      severity: "nit",
      category: "bug",
      sha: "a1b2c3d",
      status: "open",
      words: [],
    })
    const newer = findingMarker({
      id: "000000000002",
      severity: "nit",
      category: "bug",
      sha: "a1b2c3d",
      status: "open",
      words: [],
    })
    expect(parseFindingMarker(`${older}\n${newer}`)?.id).toBe("000000000002")
    expect(
      parseFindingMarker("<!-- vector-finding v1 id=3f9a1c07be21 sev=b cat=nonsense sha=a1b2c3d st=o -->"),
    ).toBeUndefined()
  })

  test("setFindingStatus rewrites only the comment's own marker", () => {
    const marker = findingMarker({
      id: "3f9a1c07be21",
      severity: "concern",
      category: "bug",
      sha: "a1b2c3d",
      status: "open",
      words: ["x"],
    })
    const body = `**Concern** · Title\n\nbody\n${marker}`
    expect(setFindingStatus(body, "dismissed")).toBe(body.replace("st=o", "st=d"))
    expect(setFindingStatus(body, "fixed", HEAD)).toBe(body.replace("st=o", "st=f:e5f6a7b"))
    expect(setFindingStatus(body, "outdated")).toBe(body.replace("st=o", "st=x"))
    expect(setFindingStatus("no marker", "dismissed")).toBe("no marker")
  })

  test("the review marker", () => {
    const marker = reviewMarker(HEAD, "8f3c21aa")
    expect(marker).toBe("<!-- vector-review:review head=e5f6a7b run=8f3c21aa -->")
    expect(parseReviewMarker(`Vectorscope review of \`e5f6a7b\`.\n${marker}`)).toEqual({ head: "e5f6a7b", run: "8f3c21aa" })
    expect(parseReviewMarker("nothing")).toBeUndefined()
  })

  test("inlineTitle reads open and fixed comments", () => {
    expect(inlineTitle("**Blocking** · Refresh can restore a session after logout\n\nbody")).toBe(
      "Refresh can restore a session after logout",
    )
    expect(inlineTitle("Nit · Unused import")).toBe("Unused import")
    expect(inlineTitle("**Fixed in `e5f6a7b`.** ~~Refresh can restore~~\n\nbody")).toBe("Refresh can restore")
    expect(inlineTitle("Something else")).toBeUndefined()
  })
})

describe("earlier findings", () => {
  const marker = (id: string, status: PriorFinding["status"] = "open") =>
    findingMarker({ id, severity: "concern", category: "bug", sha: "a1b2c3d", status, words: ["builds", "dropped"] })

  test("priorFromComment rebuilds an inline finding from its comment", () => {
    const body = `**Concern** · Sessions from older builds are dropped\n\nbody\n\n<sub>bug</sub>\n${marker("3f9a1c07be21")}`
    expect(priorFromComment({ id: 123, body, path: "src/auth/storage.ts", line: 22, threadId: "T_1" })).toEqual({
      id: "3f9a1c07be21",
      where: "inline",
      path: "src/auth/storage.ts",
      line: 22,
      side: "RIGHT",
      severity: "concern",
      category: "bug",
      title: "Sessions from older builds are dropped",
      sha: "a1b2c3d",
      status: "open",
      commentId: 123,
      threadId: "T_1",
    })
    expect(priorFromComment({ id: 1, body: "no marker", path: "a.ts", line: 1 })).toBeUndefined()
  })

  test("an earlier finding's other places are read from its comment and follow the code to this head", () => {
    const body = `**Concern** · Store write is not awaited\n\nExplained.\n\nThe same problem is also at lines 40, 90 and 120.\n\n<sub>bug</sub>\n${marker("3f9a1c07be21")}`
    const prior = priorFromComment({ id: 123, body, path: "src/a.ts", line: 12 })!
    expect(prior.also).toEqual([40, 90, 120])
    const changes = parseUnifiedDiff(
      [
        "diff --git a/src/a.ts b/src/a.ts",
        "index 1111111..2222222 100644",
        "--- a/src/a.ts",
        "+++ b/src/a.ts",
        "@@ -0,0 +1,2 @@",
        "+// one",
        "+// two",
        "@@ -90 +92 @@",
        "-  store.write(next)",
        "+  await store.write(next)",
        "",
      ].join("\n"),
    )
    expect(followAlso(prior, changes).also).toEqual([42, 122])
    expect(followAlso({ ...prior, side: "LEFT" }, changes).also).toEqual([40, 90, 120])
    expect(priorFromComment({ id: 1, body: body.replace(/The same[^\n]*\n\n/, ""), path: "src/a.ts", line: 12 })?.also).toBeUndefined()
  })

  test("priorFromState moves lines to this head, and a deleted line becomes null", () => {
    const changes = parseUnifiedDiff(
      [
        "diff --git a/src/a.ts b/src/a.ts",
        "index 1111111..2222222 100644",
        "--- a/src/a.ts",
        "+++ b/src/a.ts",
        "@@ -10 +10,3 @@",
        "-old ten",
        "+new ten",
        "+new eleven",
        "+new twelve",
        "",
      ].join("\n"),
    )
    const state: ReviewState = {
      ...emptyState(),
      findings: [
        summaryFinding(1, { path: "src/a.ts", line: 5 }),
        summaryFinding(2, { path: "src/a.ts", line: 20 }),
        summaryFinding(3, { path: "src/a.ts", line: 10 }),
        summaryFinding(4, { path: "src/b.ts", line: 30, status: "fixed", fixedIn: "e5f6a7b" }),
      ],
    }
    const prior = priorFromState(state, changes)
    expect(prior.map((entry) => entry.line)).toEqual([5, 22, null, 30])
    expect(prior[3]).toMatchObject({ where: "summary", status: "fixed", fixedIn: "e5f6a7b" })
    expect(priorFromState(state).map((entry) => entry.line)).toEqual([5, 20, 10, 30])
  })

  test("priorFromState follows a renamed file, and nextState keeps its new path", () => {
    const changes = parseUnifiedDiff(
      [
        "diff --git a/src/old.ts b/src/new.ts",
        "similarity index 90%",
        "rename from src/old.ts",
        "rename to src/new.ts",
        "index 1111111..2222222 100644",
        "--- a/src/old.ts",
        "+++ b/src/new.ts",
        "@@ -1,2 +1,4 @@",
        "+// moved",
        "+",
        " const x = 1",
        " const y = 2",
        "",
      ].join("\n"),
    )
    const state: ReviewState = {
      ...emptyState(),
      head: OLD,
      findings: [summaryFinding(1, { path: "src/old.ts", line: 10 })],
    }
    const prior = priorFromState(state, changes)
    expect(prior[0]).toMatchObject({ path: "src/new.ts", line: 12 })
    const next = nextState(state, { head: HEAD, base: BASE, mode: "incremental", now: NOW, prior })
    expect(next.findings.map((finding) => [finding.path, finding.line])).toEqual([["src/new.ts", 12]])
  })

  test("mergePrior prefers comments, and the newest comment for an id", () => {
    const fromState = priorFromState({
      ...emptyState(),
      findings: [summaryFinding(1, { id: "00000000000a" }), summaryFinding(2, { id: "00000000000b" })],
    })
    const comment = (id: string, commentId: number, status: PriorFinding["status"]) =>
      priorFromComment({ id: commentId, body: `**Concern** · t\n${marker(id, status)}`, path: "src/x.ts", line: 3 })!
    const merged = mergePrior(fromState, [
      comment("00000000000c", 12, "open"),
      comment("00000000000a", 5, "open"),
      comment("00000000000c", 9, "outdated"),
    ])
    expect(merged.map((entry) => [entry.id, entry.where, entry.commentId, entry.status])).toEqual([
      ["00000000000b", "summary", undefined, "open"],
      ["00000000000a", "inline", 5, "open"],
      ["00000000000c", "inline", 12, "open"],
    ])
  })

  test("mergePrior keeps an open summary entry over a fixed or superseded comment with the same id", () => {
    const fromState = priorFromState({
      ...emptyState(),
      findings: [summaryFinding(1, { id: "00000000000a", severity: "blocking" })],
    })
    const comment = (status: PriorFinding["status"]) =>
      priorFromComment({
        id: 5,
        body: `**Concern** · t\n${marker("00000000000a", status)}`,
        path: "src/x.ts",
        line: 3,
      })!
    const merged = (status: PriorFinding["status"]) =>
      mergePrior(fromState, [comment(status)]).map((entry) => [entry.where, entry.status, entry.severity])
    expect(merged("outdated")).toEqual([["summary", "open", "blocking"]])
    expect(merged("fixed")).toEqual([["summary", "open", "blocking"]])
    expect(merged("open")).toEqual([["inline", "open", "concern"]])
  })

  test("teamPatterns reads dismissed markers across the repository", () => {
    const dismissed = (id: string, words: string[], category: "style" | "docs" = "style") =>
      `body\n${findingMarker({ id, severity: "concern", category, sha: "a1b2c3d", status: "dismissed", words })}`
    const comments = [
      { path: "src/ui/button.tsx", body: dismissed("000000000001", ["button", "color"]) },
      { path: "src/ui/button.tsx", body: dismissed("000000000002", ["button", "color"]) },
      { path: "README.md", body: dismissed("000000000003", ["typo"], "docs") },
      { path: "src/a.ts", body: marker("000000000004") },
      { path: "src/b.ts", body: "no marker" },
    ]
    expect(teamPatterns(comments)).toEqual([
      { category: "style", dir: "src/ui", words: ["button", "color"] },
      { category: "docs", dir: "", words: ["typo"] },
    ])
    expect(teamPatterns(comments, 1)).toHaveLength(1)
  })
})

describe("classifyPrior", () => {
  const diff = (hunk: string[]) =>
    parseUnifiedDiff(
      [
        "diff --git a/src/auth/storage.ts b/src/auth/storage.ts",
        "index 1111111..2222222 100644",
        "--- a/src/auth/storage.ts",
        "+++ b/src/auth/storage.ts",
        ...hunk,
        "",
      ].join("\n"),
    )
  const near = diff(["@@ -22,2 +22,3 @@", " const a = 1", "+const b = 2", " const c = 3"])
  const far = diff(["@@ -200,2 +200,3 @@", " const a = 1", "+const b = 2", " const c = 3"])
  const deleted = parseUnifiedDiff(
    [
      "diff --git a/src/auth/storage.ts b/src/auth/storage.ts",
      "deleted file mode 100644",
      "index 1111111..0000000",
      "--- a/src/auth/storage.ts",
      "+++ /dev/null",
      "@@ -1,2 +0,0 @@",
      "-line one",
      "-line two",
      "",
    ].join("\n"),
  )

  const prior: PriorFinding = {
    id: "3f9a1c07be21",
    where: "inline",
    path: "src/auth/storage.ts",
    line: 22,
    side: "RIGHT",
    severity: "concern",
    category: "bug",
    title: "Sessions from older builds are dropped",
    sha: "a1b2c3d",
    status: "open",
    commentId: 123,
  }
  const guarded: PriorFinding = { ...prior, severity: "blocking", category: "security" }
  const writers = new Set(["alice", "bob"])
  const ctx = (overrides: Partial<ClassifyContext> = {}): ClassifyContext => ({
    head: HEAD,
    changes: far,
    isWriter: (login) => writers.has(login.toLowerCase()),
    prAuthor: "carol",
    ...overrides,
  })

  test("a writer's thumbs-down dismisses it", () => {
    const thread = { resolved: false, reactions: [{ content: "THUMBS_DOWN", users: ["mallory", "bob"] }] }
    expect(classifyPrior(prior, ctx({ thread }))).toEqual({ ...prior, status: "dismissed", dismissedBy: "bob" })
  })

  test("an outsider's thumbs-down is ignored", () => {
    const thread = { resolved: false, reactions: [{ content: "-1", users: ["mallory"] }] }
    expect(classifyPrior(prior, ctx({ thread }))).toEqual(prior)
  })

  test("the author's won't-fix reply dismisses a concern", () => {
    for (const body of [
      "Won't fix, this is intended.",
      "won’t fix",
      "WONTFIX",
      "False positive: see tests",
      "/vector dismiss",
    ]) {
      const thread = { resolved: false, replies: [{ author: "carol", body }] }
      expect(classifyPrior(prior, ctx({ thread })).status).toBe("dismissed")
    }
    const thread = { resolved: false, replies: [{ author: "mallory", body: "not an issue" }] }
    expect(classifyPrior(prior, ctx({ thread })).status).toBe("open")
  })

  test("reads /vector dismiss with the route job's parser", () => {
    const status = (body: string) =>
      classifyPrior(prior, ctx({ thread: { resolved: false, replies: [{ author: "carol", body }] } })).status
    // A GitHub quote-reply starts with the quoted comment.
    const quoted = "> **Concern** · Sessions from older builds are dropped\n\n/vector dismiss"
    for (const body of ["/VX Dismiss", "/vector  dismiss", quoted]) {
      expect(parseReviewCommand(body, DEFAULT_MENTIONS).kind).toBe("dismiss")
      expect(status(body)).toBe("dismissed")
    }
    for (const body of ["/vector dismissal", "/vector review", "`/vector dismiss`"]) {
      expect(parseReviewCommand(body, DEFAULT_MENTIONS).kind).not.toBe("dismiss")
      expect(status(body)).toBe("open")
    }
  })

  // The route job reads the comment with the workflow's MENTIONS, the App handle included once the workflow bakes it
  // in, and answers that the dismissal is read on the next review. That review must read it with the same list.
  test("reads a dismissal with the workflow's mentions, the App handle included", () => {
    const mentions = GithubAgents.mentions("vector-fixture")
    const status = (body: string, list?: string[]) =>
      classifyPrior(
        prior,
        ctx({ thread: { resolved: false, replies: [{ author: "bob", body }] }, ...(list ? { mentions: list } : {}) }),
      ).status
    for (const body of ["@vector-fixture dismiss", "@Vector-Fixture  Dismiss", "/vector dismiss"]) {
      expect(parseReviewCommand(body, mentions).kind).toBe("dismiss")
      expect(status(body, mentions)).toBe("dismissed")
    }
    // Without the workflow's list, only the commands count, as before.
    expect(status("@vector-fixture dismiss")).toBe("open")
    expect(status("/vector dismiss")).toBe("dismissed")
    // A workflow that names no App handle leaves a literal @vector-fixture a plain mention.
    expect(status("@vector-fixture dismiss", GithubAgents.mentions())).toBe("open")
  })

  test("the author cannot dismiss a blocking security finding, even with write access", () => {
    const author = ctx({ prAuthor: "alice" })
    for (const thread of [
      { resolved: false, replies: [{ author: "alice", body: "Not an issue." }] },
      { resolved: false, reactions: [{ content: "THUMBS_DOWN", users: ["alice"] }] },
      { resolved: true, resolvedBy: "alice" },
    ])
      expect(classifyPrior(guarded, { ...author, thread })).toEqual({ ...guarded, authorDismissed: true })
    const writer = { resolved: false, reactions: [{ content: "THUMBS_DOWN", users: ["bob"] }] }
    expect(classifyPrior(guarded, { ...author, thread: writer })).toMatchObject({
      status: "dismissed",
      dismissedBy: "bob",
    })
  })

  test("a writer resolving the thread with no change nearby dismisses it", () => {
    expect(classifyPrior(prior, ctx({ thread: { resolved: true, resolvedBy: "alice" } }))).toEqual({
      ...prior,
      status: "dismissed",
      dismissedBy: "alice",
    })
  })

  test("resolving the thread with a change nearby marks it fixed, whoever resolved it", () => {
    expect(classifyPrior(prior, ctx({ changes: near, thread: { resolved: true, resolvedBy: "mallory" } }))).toEqual({
      ...prior,
      status: "fixed",
      fixedIn: "e5f6a7b",
    })
  })

  test("the model saying fixed counts only with a change near the anchor", () => {
    const modelStatus = { status: "fixed" as const, reason: "guarded now" }
    expect(classifyPrior(prior, ctx({ modelStatus }))).toEqual(prior)
    expect(classifyPrior(prior, ctx({ modelStatus, changes: near })).status).toBe("fixed")
    // An outdated thread means the anchored code changed.
    expect(classifyPrior({ ...prior, line: null }, ctx({ modelStatus })).status).toBe("fixed")
  })

  test("a LEFT finding's base line is not checked against changes in the head", () => {
    const left: PriorFinding = { ...prior, side: "LEFT" }
    const fixed = { status: "fixed" as const, reason: "gone" }
    expect(classifyPrior(left, ctx({ changes: near, modelStatus: fixed })).status).toBe("open")
    expect(classifyPrior({ ...left, line: null }, ctx({ changes: near, modelStatus: fixed })).status).toBe("fixed")
  })

  test("a deleted file makes it outdated", () => {
    expect(classifyPrior(prior, ctx({ changes: deleted })).status).toBe("outdated")
    expect(classifyPrior(prior, ctx({ headText: null })).status).toBe("outdated")
  })

  test("only open findings change", () => {
    const dismissed = { ...prior, status: "dismissed" as const }
    expect(classifyPrior(dismissed, ctx({ changes: deleted }))).toBe(dismissed)
  })
})

describe("nextState", () => {
  const cost: ReviewCost = {
    costUsd: 0.21,
    input: 17_200,
    output: 3_100,
    reasoning: 0,
    cacheRead: 31_000,
    cacheWrite: 0,
    kind: "priced",
    model: "anthropic/claude-sonnet-4-5",
  }
  const finding = (overrides: Partial<Finding> = {}): Finding => ({
    id: "00000000000a",
    path: "src/api/session.ts",
    line: 88,
    side: "RIGHT",
    severity: "concern",
    category: "bug",
    title: "readSession() still expects the old shape",
    body: "b",
    confidence: 0.9,
    source: "review",
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
  const previous: ReviewState = {
    ...emptyState(),
    head: OLD,
    base: BASE,
    reviews: 1,
    costUsd: 0.1,
    tokens: [1_000, 100],
    month: { key: "2026-09", costUsd: 0.1 },
    unreviewed: ["src/a.ts"],
    inlinePosted: 3,
  }

  test("a first review records the run and the summary-only findings", () => {
    const next = nextState(undefined, {
      head: HEAD,
      base: BASE,
      mode: "full",
      now: NOW,
      cost,
      posted: 2,
      selection: selection({
        outsideDiff: [{ ...finding(), reason: "file-not-in-diff" }],
        nits: [finding({ id: "00000000000b", path: "src/a.ts", line: 3, severity: "nit", title: "x".repeat(80) })],
      }),
    })
    expect(next).toEqual({
      v: 1,
      head: HEAD,
      base: BASE,
      reviews: 1,
      costUsd: 0.21,
      tokens: [48_200, 3_100],
      month: { key: "2026-09", costUsd: 0.21 },
      unreviewed: [],
      inlinePosted: 2,
      findings: [
        {
          id: "00000000000a",
          path: "src/api/session.ts",
          line: 88,
          side: "RIGHT",
          severity: "concern",
          category: "bug",
          title: "readSession() still expects the old shape",
          sha: "e5f6a7b",
          status: "open",
        },
        {
          id: "00000000000b",
          path: "src/a.ts",
          line: 3,
          side: "RIGHT",
          severity: "nit",
          category: "bug",
          title: "x".repeat(60),
          sha: "e5f6a7b",
          status: "open",
        },
      ],
    })
  })

  test("a failed run keeps the head, sets failed, and still counts the money", () => {
    const next = nextState(previous, { head: HEAD, base: BASE, mode: "incremental", now: NOW, failed: true, cost })
    expect(next.head).toBe(OLD)
    expect(next.failed).toBe(true)
    expect(next.unreviewed).toEqual(["src/a.ts"])
    expect(next.costUsd).toBe(0.31)
    expect(next.month).toEqual({ key: "2026-09", costUsd: 0.31 })
    expect(next.reviews).toBe(2)
  })

  test("a partial run advances the head and records what it did not cover", () => {
    const next = nextState(
      { ...previous, failed: true },
      { head: HEAD, base: BASE, mode: "incremental", now: NOW, cost, unreviewed: ["src/b.ts", "src/b.ts"] },
    )
    expect(next.head).toBe(HEAD)
    expect(next.failed).toBeUndefined()
    expect(next.unreviewed).toEqual(["src/b.ts"])
    expect(next.inlinePosted).toBe(3)
  })

  test("a new month starts a new month total", () => {
    const next = nextState(
      { ...previous, month: { key: "2026-08", costUsd: 9 } },
      { head: HEAD, base: BASE, mode: "full", now: NOW, cost },
    )
    expect(next.month).toEqual({ key: "2026-09", costUsd: 0.21 })
    expect(monthKey(NOW)).toBe("2026-09")
  })

  test("a carry moves the head without counting a review", () => {
    const next = nextState(previous, { head: HEAD, base: BASE, mode: "carry", now: NOW })
    expect(next).toMatchObject({ head: HEAD, reviews: 1, costUsd: 0.1, tokens: [1_000, 100] })
  })

  test("Codium adds one review, no numeric usage, and preserves own dollars under c", () => {
    const next = nextState(previous, {
      head: HEAD,
      base: BASE,
      mode: "full",
      now: NOW,
      cost: { ...cost, kind: "codium", model: "vector-plan/vector-velocity", tokensOwnOnly: true },
    })
    expect(next).toMatchObject({ reviews: 2, codiumReviews: 1, costUsd: 0.1, tokens: [1_000, 100] })
    expect(next.month).toEqual(previous.month)
    const raw = rawJson(encodeState(next))
    expect(raw).toMatchObject({ c: 0.1, k: 1, t: [1_000, 100] })
    const carried = nextState(next, { head: HEAD, base: BASE, mode: "carry", now: NOW, cost })
    expect(carried).toMatchObject({ reviews: 2, codiumReviews: 1, costUsd: 0.1, tokens: [1_000, 100] })
  })

  test("failed Codium activity increments once and carry does not count it again", () => {
    const codium: ReviewCost = { ...cost, kind: "codium", model: "vector-plan/vector-velocity" }
    const failed = nextState(previous, { head: HEAD, base: BASE, mode: "full", now: NOW, cost: codium, failed: true })
    expect(failed).toMatchObject({ head: OLD, failed: true, reviews: 2, codiumReviews: 1, costUsd: 0.1 })
    const carried = nextState(failed, { head: HEAD, base: BASE, mode: "carry", now: NOW, cost: codium })
    expect(carried).toMatchObject({ reviews: 2, codiumReviews: 1, costUsd: 0.1, tokens: [1_000, 100] })
  })

  test.each([undefined, false, true])("mixed activity retains dollars and requires fresh token proof: %j", (proof) => {
    const next = nextState(previous, {
      head: HEAD,
      base: BASE,
      mode: "full",
      now: NOW,
      cost: { ...cost, kind: "unknown", codium: true, tokensOwnOnly: proof },
    })
    expect(next).toMatchObject({ reviews: 2, codiumReviews: 1, costUsd: 0.31 })
    expect(next.month).toEqual({ key: "2026-09", costUsd: 0.31 })
    expect(next.tokens).toEqual(proof ? [49_200, 3_200] : previous.tokens)
  })

  test("legacy Codium model prefixes exclude inseparable tokens and distinguish mixed own dollars", () => {
    const legacy = nextState(previous, {
      head: HEAD,
      base: BASE,
      mode: "full",
      now: NOW,
      cost: { ...cost, kind: "unknown", model: "vector-plan/vector-velocity + vector-plan/other" },
    })
    expect(legacy).toMatchObject({ reviews: 2, codiumReviews: 1, costUsd: 0.1, tokens: previous.tokens })
    const mixed = nextState(legacy, {
      head: HEAD,
      base: BASE,
      mode: "full",
      now: NOW,
      cost: { ...cost, model: "vector-plan/vector-velocity + anthropic/claude-sonnet-4-5" },
    })
    expect(mixed).toMatchObject({ reviews: 3, codiumReviews: 2, costUsd: 0.31, tokens: previous.tokens })
    const own = nextState(mixed, { head: HEAD, base: BASE, mode: "full", now: NOW, cost })
    expect(own).toMatchObject({ reviews: 4, codiumReviews: 2, costUsd: 0.52, tokens: [49_200, 3_200] })
  })

  test("explicit mixed activity retains own cost even if the selected model is Codium", () => {
    const next = nextState(undefined, {
      head: HEAD,
      base: BASE,
      mode: "full",
      now: NOW,
      cost: { ...cost, kind: "unknown", model: "vector-plan/vector-velocity", codium: true, tokensOwnOnly: true },
    })
    expect(next).toMatchObject({ reviews: 1, codiumReviews: 1, costUsd: 0.21, tokens: [48_200, 3_100] })
  })

  test("earlier summary findings take their new status and line, and an inline comment takes over an id", () => {
    const state: ReviewState = {
      ...previous,
      findings: [
        summaryFinding(1, { id: "000000000001" }),
        summaryFinding(2, { id: "000000000002" }),
        summaryFinding(3, { id: "000000000003" }),
      ],
    }
    const prior = priorFromState(state).map((entry) =>
      entry.id === "000000000001"
        ? { ...entry, status: "fixed" as const, fixedIn: HEAD }
        : entry.id === "000000000002"
          ? { ...entry, line: 40 }
          : entry,
    )
    const raised: PlacedFinding = {
      ...finding({ id: "000000000003", severity: "blocking" }),
      anchor: { path: "src/file3.ts", side: "RIGHT", line: 4, hunk: 0 },
      suggestionAllowed: false,
    }
    const next = nextState(state, {
      head: HEAD,
      base: BASE,
      mode: "incremental",
      now: NOW,
      cost,
      prior,
      selection: selection({ inline: [raised] }),
    })
    expect(next.findings.map((entry) => [entry.id, entry.status, entry.line, entry.fixedIn])).toEqual([
      ["000000000001", "fixed", 2, "e5f6a7b"],
      ["000000000002", "open", 40, undefined],
    ])
  })

  test("clears inflight and keeps the noted head", () => {
    const next = nextState(
      { ...previous, notedHead: OLD, inflight: { run: "r1", head: HEAD, at: NOW, costUsd: 0.05 } },
      { head: HEAD, base: BASE, mode: "full", now: NOW, cost },
    )
    expect(next.inflight).toBeUndefined()
    expect(next.notedHead).toBe(OLD)
    expect(nextState(previous, { head: HEAD, base: BASE, mode: "full", now: NOW, notedHead: HEAD }).notedHead).toBe(
      HEAD,
    )
  })
})
