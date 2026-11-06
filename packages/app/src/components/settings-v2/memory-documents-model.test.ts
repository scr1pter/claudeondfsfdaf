import { describe, expect, test } from "bun:test"
import type { MemoryDocument, MemoryModelStatus } from "@vectordevai/sdk/v2/client"
import {
  anchorLine,
  anchorMethodLabel,
  anchorStatusLabel,
  codeLinks,
  evidence,
  historyLine,
  reviewRows,
  usageLabel,
  versionDiffLabel,
  addedLabel,
  bytes,
  DROP,
  FORGET,
  KEEP_ORIGINALS,
  REPOSITORY_DOCS,
  documentHoldLabel,
  documentList,
  documentMeta,
  documentsSummary,
  heldLabel,
  highlight,
  kindCounts,
  needsLook,
  needsLookCount,
  notApplicableLabel,
  originLabel,
  outlineRows,
  pageHeading,
  pageList,
  pausable,
  polling,
  precheck,
  recordKindLabel,
  recordStatusLabel,
  recordUsage,
  refusal,
  refusalLabel,
  DISTILL,
  distillCostLabel,
  distilledLabel,
  distillEstimateLabel,
  suggestedBy,
  suggestion,
  suggestionsLabel,
  reindexable,
  replaceable,
  resumable,
  statusLabel,
  statusTone,
  steps,
  tokens,
  uploadMode,
  visibilityLabel,
  warningLabel,
  MODEL_DONE,
  MODEL_DOWNLOADS_OFF,
  MODEL_FALLBACK_UNVERIFIED,
  checkLabel,
  embeddedLabel,
  megabytes,
  modelHeadline,
  modelLicense,
  modelOffer,
  modelPolling,
  modelBusy,
  offerModel,
  runsLabel,
  shortSha,
  sourceLabel,
  type DocumentHold,
  type DocumentStatus,
  type DocumentWarning,
  type RecordKind,
  type Refusal,
} from "./memory-documents-model"

const stats = {
  tokens: 140_210,
  read: 212,
  sections: 31,
  passages: 400,
  records: 120,
  kinds: {
    requirement: 12,
    constraint: 4,
    decision: 0,
    contract: 3,
    procedure: 0,
    term: 0,
    entity: 0,
    fact: 0,
    question: 1,
  },
  held: 0,
  linked: 0,
  embedded: 0,
}

function doc(input: Partial<MemoryDocument> = {}): MemoryDocument {
  return {
    id: "dabc12345",
    ordinal: 1,
    version: 1,
    name: "api-spec.pdf",
    title: "API spec",
    format: "pdf",
    origin: "upload",
    visibility: "private",
    status: "searchable",
    bytes: 1_468_006,
    pages: 212,
    unread: [],
    stored: false,
    stats,
    warnings: [],
    createdAt: 0,
    updatedAt: 0,
    ...input,
  }
}

const STATUSES: DocumentStatus[] = [
  "queued",
  "reading",
  "linking",
  "searchable",
  "embedding",
  "ready",
  "partial",
  "held",
  "failed",
  "superseded",
]
const HOLDS: DocumentHold[] = [
  "web",
  "mcp",
  "subagent",
  "untrusted-repository",
  "guest",
  "instruction-like",
  "hidden-unicode",
  "hidden-text",
  "suggested",
]
const WARNINGS: DocumentWarning[] = [
  "truncated",
  "scanned",
  "ocr",
  "ocr-incomplete",
  "encrypted",
  "macros-ignored",
  "external-links",
  "secrets-removed",
  "tables-approximate",
]
const REFUSALS: Refusal[] = [
  "too-large",
  "unsupported",
  "encrypted",
  "empty",
  "secret",
  "invalid",
  "limit",
  "guest",
  "forgotten",
  "not-found",
  "outside",
  "busy",
  "version",
]
const KINDS: RecordKind[] = [
  "requirement",
  "constraint",
  "decision",
  "contract",
  "procedure",
  "term",
  "entity",
  "fact",
  "question",
]

describe("documents page model", () => {
  test("names every status the way the list shows it", () => {
    expect(STATUSES.map((status) => statusLabel(doc({ status, hold: "instruction-like" })))).toEqual([
      "Queued",
      "Reading",
      "Linking to code",
      "Searchable",
      "Searchable",
      "Ready",
      "Partly read",
      "Held for your review: parts of it read like instructions to an AI",
      "Could not read",
      "Replaced by a newer version",
    ])
    expect(statusLabel(doc({ status: "partial", unread: [3, 4] }))).toBe("Scanned pages skipped")
    expect(statusLabel(doc({ status: "partial", warnings: ["scanned"] }))).toBe("Scanned pages skipped")
    expect(statusLabel(doc({ status: "reading", paused: true }))).toBe("Paused")
    // A finished document that was paused once reads as finished.
    expect(statusLabel(doc({ status: "ready", paused: true }))).toBe("Ready")
  })

  test("gives each status a tone for its dot", () => {
    expect(STATUSES.map((status) => statusTone({ status }))).toEqual([
      "busy",
      "busy",
      "busy",
      "good",
      "good",
      "good",
      "waiting",
      "waiting",
      "problem",
      "idle",
    ])
    expect(statusTone({ status: "reading", paused: true })).toBe("idle")
  })

  test("says why a document waits, for every hold", () => {
    const labels = HOLDS.map(documentHoldLabel)
    expect(new Set(labels).size).toBe(HOLDS.length)
    expect(documentHoldLabel("instruction-like")).toBe("parts of it read like instructions to an AI")
    expect(documentHoldLabel("untrusted-repository")).toBe("this repository's settings are not trusted yet")
    expect(documentHoldLabel(undefined)).toBe("Vector could not check where it came from")
  })

  test("explains every warning, naming the scanned pages", () => {
    expect(new Set(WARNINGS.map((warning) => warningLabel(warning))).size).toBe(WARNINGS.length)
    expect(warningLabel("scanned", { unread: [9, 3, 4, 5] })).toBe(
      "Scanned pages (p.3-5, 9) have no readable text. Local OCR may be unavailable or could not recognize them.",
    )
    expect(pageList([1, 2, 3, 7, 9, 10])).toBe("p.1-3, 7, 9-10")
  })

  test("shows a stepper that only lists what applies", () => {
    expect(steps(doc({ status: "reading", stats: { ...stats, read: 40 } }))).toEqual([
      { label: "Read 40/212 pages", state: "active" },
      { label: "Structured", state: "pending" },
    ])
    expect(steps(doc({ status: "queued", stats: { ...stats, read: 0 } }))[0]).toEqual({
      label: "Read 0/212 pages",
      state: "pending",
    })
    expect(steps(doc())).toEqual([
      { label: "Read 212/212 pages", state: "done" },
      { label: "Structured 31 sections", state: "done" },
    ])
    // Code links and the search model show up once they apply.
    expect(
      steps(doc({ status: "embedding", embedModel: "arctic", stats: { ...stats, linked: 23, embedded: 213 } })),
    ).toEqual([
      { label: "Read 212/212 pages", state: "done" },
      { label: "Structured 31 sections", state: "done" },
      { label: "Linked 23 files", state: "done" },
      { label: "Meaning 40%", state: "active" },
    ])
    expect(steps(doc({ status: "linking" }))[2]).toEqual({ label: "Linking to code", state: "active" })
    // Formats without pages say "Read" alone, and one section is one.
    expect(steps(doc({ format: "markdown", pages: undefined, stats: { ...stats, sections: 1 } }))).toEqual([
      { label: "Read", state: "done" },
      { label: "Structured 1 section", state: "done" },
    ])
    expect(steps(doc({ format: "pptx", pages: 12, stats: { ...stats, read: 12 } }))[0]?.label).toBe("Read 12/12 slides")
    expect(steps(doc({ status: "failed" }))[0]?.state).toBe("pending")
    expect(steps(doc({ status: "held" }))[0]?.state).toBe("done")
  })

  test("describes a document in one line", () => {
    expect(documentMeta(doc({ createdAt: 0 }), 2 * 86_400_000)).toBe(
      "PDF · 212 pages · 1.4 MB · about 140,000 tokens if sent · You added this 2 days ago",
    )
    expect(
      documentMeta(
        doc({
          format: "markdown",
          pages: undefined,
          bytes: 2048,
          origin: "repository",
          stats: { ...stats, tokens: 512 },
        }),
        0,
      ),
    ).toBe("Markdown · 2 KB · about 510 tokens if sent · From this repository's docs today")
    expect(bytes(900)).toBe("900 B")
    expect(bytes(64 * 1024 * 1024)).toBe("64 MB")
    expect(tokens(139_920)).toBe("140,000")
    expect(tokens(4_321)).toBe("4,300")
  })

  test("counts what waits for the user, whole documents and held passages", () => {
    const documents = [
      doc({ id: "d1", title: "Held", status: "held", hold: "hidden-text" }),
      doc({ id: "d2", title: "Spec", stats: { ...stats, held: 3 } }),
      doc({ id: "d3", title: "Fine" }),
      doc({ id: "d4", title: "Old", status: "superseded", stats: { ...stats, held: 2 } }),
    ]
    expect(needsLook(documents)).toEqual([
      { document: "d1", title: "Held", text: "Held for your review: it has text a reader would not see", count: 1 },
      { document: "d2", title: "Spec", text: "3 passages held for your review, the rest is in use", count: 3 },
    ])
    expect(needsLookCount(documents)).toBe(4)
    expect(heldLabel([], true)).toBe("")
    expect(heldLabel([{ hold: "instruction-like" }], false)).toBe(
      "1 passage is held for your review and never reaches the agent: parts of it read like instructions to an AI.",
    )
    expect(heldLabel([{ hold: "instruction-like" }, { hold: "hidden-text" }, { hold: "instruction-like" }], true)).toBe(
      "3 passages are held for your review and never reach the agent: parts of it read like instructions to an AI; it has text a reader would not see. They are marked in Pages.",
    )
    expect(documentsSummary({ documents, indexing: false })).toBe(
      "3 documents · 4 to look at · only the parts a request needs are sent",
    )
    expect(documentsSummary({ documents: [], indexing: false })).toBe("No documents yet")
    expect(documentsSummary({ documents: [doc({ status: "reading" })], indexing: true })).toBe(
      "1 document · 1 being read · only the parts a request needs are sent",
    )
  })

  test("polls only while something is read or the search model downloads", () => {
    const model = { state: "absent" as const }
    expect(polling(undefined)).toBe(false)
    expect(polling({ indexing: false, model })).toBe(false)
    expect(polling({ indexing: true, model })).toBe(true)
    expect(polling({ indexing: false, model: { state: "downloading" } })).toBe(true)
    expect(polling({ indexing: false, model: { state: "ready" } })).toBe(false)
    // An engine that answers without a model status (or at all) is not polled, and does not break the page.
    expect(polling({ indexing: false } as Parameters<typeof polling>[0])).toBe(false)
    expect(documentList({})).toBeUndefined()
    expect(documentList({ documents: "x" })).toBeUndefined()
    expect(documentList(undefined)).toBeUndefined()
    const list = { documents: [], indexing: false, model, settings: {}, limits: {}, worker: {} }
    expect(documentList(list)).toBe(list as never)
  })

  test("offers pause, resume and reindex only where they apply", () => {
    expect(pausable({ status: "reading" })).toBe(true)
    expect(pausable({ status: "ready" })).toBe(false)
    expect(pausable({ status: "reading", paused: true })).toBe(false)
    expect(resumable({ status: "reading", paused: true })).toBe(true)
    expect(reindexable({ status: "ready", stored: false })).toBe(false)
    expect(reindexable({ status: "ready", stored: true })).toBe(true)
    expect(reindexable({ status: "ready", stored: false, sourcePath: "/repo/docs/a.md" })).toBe(true)
    expect(reindexable({ status: "superseded", stored: true })).toBe(false)
    expect(replaceable({ status: "ready", origin: "upload" })).toBe(true)
    expect(replaceable({ status: "ready", origin: "chat" })).toBe(true)
    expect(replaceable({ status: "ready", origin: "repository" })).toBe(false)
    expect(replaceable({ status: "superseded", origin: "upload" })).toBe(false)
  })

  test("refuses what the engine would refuse, before sending it", () => {
    expect(precheck({ name: "diagram.png", size: 10 })).toBe(
      "Attach images to a message so the model can look at them. Vector does not read text in images.",
    )
    expect(precheck({ name: "Spec.DOC", size: 10 })).toBe(
      "Vector reads .docx, not .doc. Save it as .docx and add that.",
    )
    expect(precheck({ name: "deck.ppt", size: 10 })).toBe(
      "Vector reads .pptx, not .ppt. Save it as .pptx and add that.",
    )
    expect(precheck({ name: "docs.zip", size: 10 })).toContain("archives")
    expect(precheck({ name: "setup.exe", size: 10 })).toContain("programs")
    expect(precheck({ name: "empty.md", size: 0 })).toBe("empty.md is empty.")
    expect(precheck({ name: "huge.pdf", size: 65 * 1024 * 1024 })).toBe(
      "huge.pdf is 65 MB. Vector keeps documents of up to 64 MB.",
    )
    expect(precheck({ name: "spec.pdf", size: 64 * 1024 * 1024 })).toBeUndefined()
    expect(precheck({ name: "notes.md", size: 10 })).toBeUndefined()
  })

  test("sends a path only to its own engine, and only when it knows the path", () => {
    expect(uploadMode({ builtin: true, path: "/Users/a/spec.pdf" })).toBe("path")
    expect(uploadMode({ builtin: true })).toBe("bytes")
    expect(uploadMode({ builtin: false, path: "/Users/a/spec.pdf" })).toBe("bytes")
  })

  test("words every refusal, with the engine's own message where it gave one", () => {
    const labels = REFUSALS.map((reason) => refusalLabel(reason, undefined, "spec.pdf"))
    expect(new Set(labels).size).toBe(REFUSALS.length)
    expect(refusalLabel("version", "spec.pdf is already document 1 (v1). Add it again with replace…", "spec.pdf")).toBe(
      "spec.pdf is already here. Read this file as its next version? Your edits, pins and links carry over.",
    )
    expect(refusalLabel("unsupported", "Save it as .docx.", "a.doc")).toBe("Save it as .docx.")
    expect(refusalLabel("encrypted", undefined, "a.pdf")).toBe(
      "This file is password protected. Vector doesn't ask for document passwords; add an unprotected copy.",
    )
    expect(
      refusal({ name: "MemoryError", data: { code: "refused", reason: "version", message: "already here" } }),
    ).toEqual({
      reason: "version",
      message: "already here",
    })
    expect(refusal({ name: "MemoryTooLargeError", data: { message: "At most 64 MB." } })).toEqual({
      message: "At most 64 MB.",
    })
    expect(refusal({ data: { reason: "made-up", message: "x" } })).toEqual({ message: "x" })
    expect(refusal(new Error("offline"))).toEqual({ message: "offline" })
    expect(refusal(undefined)).toEqual({})
    expect(addedLabel({ type: "unchanged" }, "a.md")).toBe("a.md is already here, unchanged.")
    expect(addedLabel({ type: "queued" }, "a.md")).toContain("Reading a.md")
    expect(addedLabel({ type: "version" }, "a.md")).toContain("new version")
  })

  test("counts records by kind, largest first, and names each kind", () => {
    expect(kindCounts(stats.kinds)).toBe("12 requirements · 4 constraints · 3 contracts · 1 open question")
    expect(kindCounts({})).toBe("Nothing learned from it yet")
    expect(KINDS.map((kind) => recordKindLabel(kind))).toEqual([
      "Requirement",
      "Constraint",
      "Decision",
      "Contract",
      "Procedure",
      "Term",
      "Entity",
      "Fact",
      "Open question",
    ])
    expect(notApplicableLabel("requirement")).toBe("Not a requirement")
    expect(notApplicableLabel("entity")).toBe("Not an entity")
    expect(notApplicableLabel("question")).toBe("Not an open question")
  })

  test("describes a record's use and state", () => {
    expect(recordUsage({ uses: 0 })).toBe("Not used yet")
    expect(recordUsage({ uses: 1 })).toBe("Used in 1 run")
    expect(recordUsage({ uses: 4 })).toBe("Used in 4 runs")
    // Once answers cited it, or the agent opened it, the runs that did and how many passed their checks.
    expect(recordUsage({ uses: 9, runs: 4, passed: 3 })).toBe("Used in 4 runs · 3 passed")
    expect(recordUsage({ uses: 2, runs: 1, passed: 0 })).toBe("Used in 1 run · 0 passed")
    expect(recordStatusLabel({ status: "active", pinned: true, userEdited: true })).toBe("Pinned · Edited by you")
    expect(recordStatusLabel({ status: "active", pinned: false, userEdited: false })).toBe("")
    expect(
      recordStatusLabel({ status: "quarantined", hold: "instruction-like", pinned: false, userEdited: false }),
    ).toBe("Held for your review: parts of it read like instructions to an AI")
    expect(recordStatusLabel({ status: "archived", pinned: false, userEdited: false })).toBe(
      "Not used: you set it aside",
    )
  })

  test("lists the outline with pages and marks sections with unread pages", () => {
    expect(
      outlineRows(
        {
          outline: [
            { id: "s1", heading: "Limits", path: "3 Limits", level: 2, pageStart: 12, pageEnd: 15 },
            { id: "s2", heading: "Retries", path: "3 Limits > 3.2 Retries", level: 3, pageStart: 14 },
            { id: "s3", heading: "", path: "", level: 2 },
          ],
        },
        [13],
      ),
    ).toEqual([
      { id: "s1", heading: "Limits", level: 0, pages: "pp.12-15", unread: true },
      { id: "s2", heading: "Retries", level: 1, pages: "p.14", unread: false },
      { id: "s3", heading: "Untitled section", level: 0, pages: "", unread: false },
    ])
  })

  test("cuts a passage where its records sit, clamping and skipping overlaps", () => {
    expect(
      highlight({
        text: "Clients must retry at most 3 times. Uploads are at most 50 MB.",
        records: [
          { id: "r2", kind: "constraint", start: 36, end: 62 },
          { id: "r1", kind: "requirement", start: 0, end: 35 },
          { id: "r3", kind: "fact", start: 30, end: 36 },
          { id: "r4", kind: "fact", start: 80, end: 90 },
        ],
      }),
    ).toEqual([
      { text: "Clients must retry at most 3 times.", record: { id: "r1", kind: "requirement" } },
      { text: " ", record: { id: "r3", kind: "fact" } },
      { text: "Uploads are at most 50 MB.", record: { id: "r2", kind: "constraint" } },
    ])
    expect(highlight({ text: "Plain.", records: [] })).toEqual([{ text: "Plain." }])
    expect(pageHeading({ page: 3, pages: 9, unread: true })).toBe(
      "Page 3 of 9: no readable text was extracted from this scanned page.",
    )
  })

  test("says repository docs are shared like the repository's memory, and only documents the user adds are private", () => {
    expect(REPOSITORY_DOCS).toContain("not private")
    expect(REPOSITORY_DOCS).toContain("shared like the repository's memory")
    expect(DROP.private).toStartWith("Documents you add")
    expect(visibilityLabel("repository")).toContain("also with guests")
  })

  test("says what a record is linked to, how, and whether the code still says it", () => {
    const anchor = {
      id: 7,
      owner: "rk2m4q7x9a1bc",
      path: "src/upload.ts",
      symbol: "MAX_UPLOAD_BYTES",
      line: 2,
      method: "constant" as const,
      weight: 0.8,
      value: { raw: "64 * 1024 * 1024", value: 67108864, unit: "B" },
      status: "fresh" as const,
      origin: "extracted" as const,
      checkedAt: 1,
    }
    expect(anchorLine(anchor)).toBe(
      "src/upload.ts:2 MAX_UPLOAD_BYTES · sets the value (64 * 1024 * 1024) · unchanged since Vector linked it",
    )
    expect(
      anchorLine({
        ...anchor,
        method: "path",
        symbol: undefined,
        line: undefined,
        value: undefined,
        status: "missing",
      }),
    ).toBe("src/upload.ts · is the file it names · gone from the code")
    expect(evidence("Uploads are capped by MAX_UPLOAD_BYTES per file.", "MAX_UPLOAD_BYTES")).toEqual([
      { text: "Uploads are capped by ", mark: false },
      { text: "MAX_UPLOAD_BYTES", mark: true },
      { text: " per file.", mark: false },
    ])
    expect(evidence("GET /v1/users/{id} returns 404.", "GET /v1/users/*")).toEqual([
      { text: "GET /v1/users/{id} returns 404.", mark: false },
    ])
    expect(evidence("No name here.", undefined)).toEqual([{ text: "No name here.", mark: false }])
    const grouped = codeLinks(
      [
        { ...anchor, owner: "ppassage00001", id: 1 },
        { ...anchor, id: 2, method: "use", weight: 0.4, path: "src/a.ts" },
        anchor,
      ],
      [{ id: anchor.owner, kind: "constraint", card: "Uploads are capped." }],
    )
    expect(grouped.map((item) => [item.owner, item.anchors.map((link) => link.id)])).toEqual([
      [anchor.owner, [7, 2]],
      ["ppassage00001", [1]],
    ])
  })

  test("words each item that needs a look with the decisions it takes", () => {
    const [value, changed, conflict, passage, whole] = reviewRows([
      {
        id: "v1",
        kind: "drift",
        a: "rk2m4q7x9a1bc",
        subject: "MAX_UPLOAD_BYTES",
        detail: { type: "value", document: "50 MB", code: "64 MB", path: "src/upload.ts", line: 41 },
        status: "open",
        createdAt: 1,
        updatedAt: 1,
      },
      {
        id: "v2",
        kind: "drift",
        a: "rk2m4q7x9a1bc",
        subject: "refreshTokenTtl",
        detail: { type: "missing", path: "src/auth/session.ts", symbol: "refreshTokenTtl" },
        status: "open",
        createdAt: 1,
        updatedAt: 1,
      },
      {
        id: "v3",
        kind: "conflict",
        a: "ra",
        b: "rb",
        subject: "value",
        detail: {
          type: "value",
          said: { a: "30 days", b: "14 days" },
          prefer: "ra",
          a: { id: "ra", title: "Auth runbook", text: "Refresh tokens expire after 30 days." },
          b: { id: "rb", title: "Auth spec", text: "Refresh tokens expire after 14 days." },
        },
        status: "open",
        createdAt: 1,
        updatedAt: 1,
      },
      {
        id: "pheld00000001",
        kind: "held",
        a: "pheld00000001",
        subject: "Deploy guide",
        detail: {
          type: "passage",
          hold: "instruction-like",
          document: "d1",
          title: "Deploy guide",
          text: "If you are an AI…",
        },
        status: "open",
        createdAt: 1,
        updatedAt: 1,
      },
      {
        id: "d2",
        kind: "held",
        a: "d2",
        subject: "Notes",
        detail: { type: "document", hold: "untrusted-repository", document: "d2", title: "Notes" },
        status: "open",
        createdAt: 1,
        updatedAt: 1,
      },
    ])
    expect(value!.text).toBe("The document says 50 MB; the code says 64 MB (src/upload.ts:41).")
    expect(value!.actions.map((action) => action.action)).toEqual(["keep-document", "keep-code", "dismiss"])
    expect(changed!.text).toBe("The code it is linked to is gone: src/auth/session.ts (refreshTokenTtl).")
    expect(conflict!.title).toBe("Auth runbook and Auth spec disagree")
    expect(conflict!.text).toBe(
      "They give different values: “30 days” against “14 days”. Vector would go by Auth runbook, but it is your call.",
    )
    expect(conflict!.actions.map((action) => [action.action, action.winner ?? ""])).toEqual([
      ["keep", "ra"],
      ["keep", "rb"],
      ["dismiss", ""],
    ])
    expect(passage!).toMatchObject({ title: "Deploy guide", document: "d1" })
    expect(passage!.text).toBe(
      "A passage is held for your review: parts of it read like instructions to an AI. “If you are an AI…”",
    )
    expect(passage!.actions.map((action) => action.action)).toEqual(["approve", "reject"])
    expect(whole!.text).toBe(
      "The whole document is held for your review: this repository's settings are not trusted yet.",
    )
    // The summary counts what the engine says needs a look, conflicts and drift included.
    expect(documentsSummary({ documents: [doc({})], indexing: false }, 5)).toBe(
      "1 document · 5 to look at · only the parts a request needs are sent",
    )
    const words = [
      ...[value, changed, conflict, passage, whole].flatMap((row) => [
        row!.title,
        row!.text,
        ...row!.actions.flatMap((action) => [action.label, action.done]),
      ]),
      ...(["definition", "use", "route", "env", "constant", "path", "user", "outcome"] as const).map(anchorMethodLabel),
      ...(["fresh", "drifted", "missing"] as const).map(anchorStatusLabel),
    ]
    for (const word of words) expect(word.toLowerCase()).not.toContain("project")
  })

  test("a new version says what it changed and keeps what the user did; History tells each step", () => {
    const diff = {
      version: 2,
      previous: "dprevious",
      added: { requirement: 4, constraint: 1 },
      changed: { requirement: 1, constraint: 1 },
      removed: { term: 1 },
      unchanged: { contract: 27 },
      edits: 3,
      pins: 2,
    }
    expect(versionDiffLabel(diff)).toBe(
      "Version 2: +4 requirements, +1 constraint, 2 changed, 1 removed, 27 unchanged; your 3 edits and 2 pins are kept.",
    )
    expect(versionDiffLabel({ ...diff, added: {}, changed: {}, removed: {}, unchanged: {}, edits: 1, pins: 0 })).toBe(
      "Version 2: nothing Vector learned changed; your 1 edit is kept.",
    )
    const at = Date.UTC(2026, 9, 21)
    expect(historyLine({ at, action: "version", actor: "vector", detail: diff })).toBe(versionDiffLabel(diff))
    expect(historyLine({ at, action: "added", actor: "user", detail: { version: 1 } })).toBe("Added")
    expect(historyLine({ at, action: "added", actor: "agent", detail: { version: 1 } })).toBe("Kept by the agent")
    expect(historyLine({ at, action: "added", actor: "vector", detail: { version: 1 } })).toBe(
      "Read from the repository",
    )
    expect(
      historyLine({
        at,
        action: "changed",
        actor: "vector",
        record: "r1",
        detail: { version: 2, before: "30 s", after: "60 s" },
      }),
    ).toBe("Changed in version 2: “30 s” became “60 s”")
    expect(
      historyLine({
        at,
        action: "linked",
        actor: "vector",
        record: "r1",
        detail: { path: "src/billing/invoice.ts", added: true },
      }),
    ).toBe("Linked to src/billing/invoice.ts when the code landed")
    expect(
      historyLine({ at, action: "linked", actor: "user", record: "r1", detail: { path: "src/a.ts", symbol: "run" } }),
    ).toBe("You linked it to src/a.ts run")
    expect(historyLine({ at, action: "pinned", actor: "user", record: "r1" })).toBe("You pinned it")
    expect(historyLine({ at, action: "made-memory", actor: "user", record: "r1" })).toBe("You made it a memory")
    expect(historyLine({ at, action: "kind", actor: "user", record: "r1", detail: { after: "constraint" } })).toBe(
      "You made it a constraint",
    )
    expect(usageLabel({ runs: 4, passed: 3, reverted: 1 })).toBe(
      "Used in 4 runs in the last 30 days · 3 passed their checks · 1 undone",
    )
    expect(usageLabel({ runs: 0, passed: 0, reverted: 0 })).toBe(
      "No run has cited or opened its cards in the last 30 days.",
    )
    const words = [
      versionDiffLabel(diff),
      usageLabel({ runs: 4, passed: 3, reverted: 1 }),
      ...[
        "added",
        "version",
        "changed",
        "linked",
        "unlinked",
        "edited",
        "pinned",
        "unpinned",
        "not-applicable",
        "forget",
        "restored",
        "made-memory",
      ].flatMap((action) =>
        (["user", "agent", "vector"] as const).map((actor) =>
          historyLine({ at, action, actor, detail: { path: "a.ts", version: 2 } }),
        ),
      ),
    ]
    for (const word of words) expect(word.toLowerCase()).not.toContain("project")
  })

  test("never says project", () => {
    const words = [
      FORGET,
      KEEP_ORIGINALS,
      REPOSITORY_DOCS,
      ...Object.values(DROP),
      ...STATUSES.map((status) => statusLabel(doc({ status }))),
      ...HOLDS.map(documentHoldLabel),
      ...WARNINGS.map((warning) => warningLabel(warning, { unread: [1] })),
      ...REFUSALS.map((reason) => refusalLabel(reason, undefined, "a.pdf")),
      ...(["upload", "chat", "agent", "repository", "cli"] as const).map(originLabel),
      visibilityLabel("private"),
      visibilityLabel("repository"),
    ]
    expect(words.length).toBeGreaterThan(40)
    for (const word of words) expect(word.toLowerCase()).not.toContain("project")
  })

  test("finding more with a model says what goes, what it may cost, and what is kept, and never more", () => {
    const estimate = {
      enabled: true,
      model: "anthropic/claude-sonnet-4",
      sections: 3,
      input: 12_431,
      output: 4_000,
      costKind: "priced" as const,
      lowUsd: 0.0398,
      highUsd: 0.0973,
    }
    expect(distillEstimateLabel(estimate)).toBe(
      "Vector would send 3 sections (about 12,000 tokens) to anthropic/claude-sonnet-4, with up to 4,000 tokens back. About $0.04 to $0.10 at catalog rates.",
    )
    // The document page offers no choice of model: it asks the default one, which the estimate names.
    expect(DISTILL).toStartWith("Your default model reads the sections where Vector's rules found little.")
    expect(DISTILL).not.toMatch(/you choose/i)
    expect(distillCostLabel({ costKind: "free" })).toBe("The model is free.")
    expect(distillCostLabel({ costKind: "unknown" })).toBe(
      "The model has no listed price, so Vector cannot estimate what it costs.",
    )
    expect(distillCostLabel({ costKind: "priced", lowUsd: 0.0012, highUsd: 0.004 })).toBe(
      "About $0.0012 to $0.0040 at catalog rates.",
    )
    // A refusal says why in the engine's words, and nothing is sent.
    expect(
      distillEstimateLabel({
        enabled: true,
        refused: { reason: "may-train", message: "Documents are withheld from models that may train on prompts." },
        sections: 0,
        input: 0,
        output: 4_000,
      }),
    ).toBe("Documents are withheld from models that may train on prompts.")
    const record = { origin: "distilled" as const, status: "proposed" as const }
    expect(
      distilledLabel({
        model: "lmstudio/test-model",
        records: [record, record] as never,
        dropped: { invalid: 0, quote: 1, scan: 0 },
      }),
    ).toBe(
      "2 suggestions from lmstudio/test-model, waiting below for you to keep or drop. Dropped 1 suggestion that did not hold up against the document.",
    )
    expect(distilledLabel({ model: "m", records: [], dropped: { invalid: 0, quote: 0, scan: 0 } })).toBe(
      "No suggestions from m held their quotes.",
    )
    expect(suggestionsLabel(12, "m")).toBe("12 suggestions from m")
    expect(suggestion(record)).toBe(true)
    expect(suggestion({ origin: "extracted", status: "proposed" })).toBe(false)
    expect(suggestion({ origin: "distilled", status: "active" })).toBe(false)
    expect(recordStatusLabel({ ...record, hold: undefined, userEdited: false, pinned: false })).toBe(
      "Suggested by a model: keep it or drop it",
    )
    const history = [
      {
        at: 2,
        action: "distilled",
        actor: "user" as const,
        detail: {
          model: "lmstudio/test-model",
          kept: 2,
          tokens: { input: 1_400, output: 160 },
          cost: 0.0042,
          costKind: "priced",
        },
      },
      { at: 1, action: "kept-suggestions", actor: "user" as const, detail: { count: 2 } },
    ]
    expect(suggestedBy(history)).toBe("lmstudio/test-model")
    expect(history.map(historyLine)).toEqual([
      "You asked lmstudio/test-model to find more: 2 suggestions kept (1,560 tokens, $0.0042)",
      "You kept 2 suggestions from a model",
    ])
    const [row] = reviewRows([
      {
        id: "r1",
        kind: "held",
        a: "r1",
        subject: "Billing",
        detail: {
          type: "record",
          document: "d1",
          title: "Billing",
          text: "Refunds are approved by a support lead",
          suggested: true,
        },
        status: "open",
        createdAt: 0,
        updatedAt: 0,
      },
    ])
    expect(row!.text).toBe(
      "A model suggested a record from it. Keep it if the document says so. “Refunds are approved by a support lead”",
    )
    expect(row!.actions.map((action) => action.label)).toEqual(["Keep", "Drop"])
    for (const word of [DISTILL, distillEstimateLabel(estimate), row!.text, ...history.map(historyLine)]) {
      expect(word.toLowerCase()).not.toContain("project")
      expect(word.toLowerCase()).not.toContain("exactly")
    }
  })
})

describe("the search model card", () => {
  const arctic = {
    id: "arctic-embed-xs-q8",
    label: "Search by meaning",
    description: "Snowflake Arctic Embed XS, int8: finds passages that say what a request means in other words.",
    license: "Apache-2.0",
    owner: "Snowflake",
    source: "https://huggingface.co/Snowflake/snowflake-arctic-embed-xs/tree/d8c86521100d3556476a063fc2342036d45c106f",
    revision: "d8c86521100d3556476a063fc2342036d45c106f",
    bytes: 23_686_074,
    fallback: 91_100_713,
    sha256: "e6aa5e656466a73d7c3111e9a3378bd13e5b93af30eaac2b3f13fd56692589a1",
    installed: false,
  }
  const granite = {
    ...arctic,
    id: "granite-small-r2-q8",
    label: "Code-aware",
    owner: "IBM (ONNX conversion by onnx-community)",
    bytes: 54_633_923,
    preview: "Preview: its check vectors are not pinned in this build.",
  }
  const options = [arctic, granite]

  test("says what search uses in each state, and what the download is before it starts", () => {
    expect(modelHeadline({ state: "absent", options })).toBe(
      "Searching by keywords and code links. Download the 24 MB model to search by meaning.",
    )
    expect(modelHeadline({ state: "downloading", progress: 0.41, total: 23_686_074, options })).toBe(
      "Downloading 41% of 24 MB…",
    )
    expect(modelHeadline({ state: "verifying", options })).toContain("Checking")
    expect(modelHeadline({ state: "ready", model: "arctic-embed-xs-q8", options })).toBe(
      "Searching documents by meaning, keywords and code links, all on this computer.",
    )
    expect(modelHeadline({ state: "failed", error: "it gave other vectors", options })).toBe(
      "The model cannot be used on this computer: it gave other vectors. Until then Vector searches by keywords and code links.",
    )
    expect(modelHeadline(undefined)).toContain("not available")
    expect(modelOffer(arctic)).toBe(
      "Search by meaning: a one-time 24 MB download, then it runs on this computer with no network.",
    )
    expect(modelLicense(granite)).toBe("IBM (ONNX conversion by onnx-community) · Apache-2.0")
    expect(megabytes(91_100_713)).toBe("91 MB")
    expect(shortSha(arctic.sha256)).toBe("e6aa5e656466a73d…")
  })

  // The fallback's full-precision graph has never been run with this build, so where it is offered or in use, it says so.
  test("labels the full-precision fallback as not yet verified", () => {
    expect(MODEL_FALLBACK_UNVERIFIED).toStartWith("Not yet verified:")
    expect(MODEL_DONE.fallback).toBe("Downloading the full-precision model, which is not yet verified.")
  })

  test("counts what is searchable by meaning, says when it is paused, and how the model was checked here", () => {
    expect(embeddedLabel({ state: "ready", embedded: { done: 412, total: 1_000 } })).toBe(
      "412 of 1,000 passages and records in this repository searchable by meaning (41%). The rest is embedded in the background.",
    )
    expect(embeddedLabel({ state: "ready", paused: true, embedded: { done: 412, total: 1_000 } })).toContain(
      "Paused: the rest waits until you resume.",
    )
    expect(embeddedLabel({ state: "ready", embedded: { done: 3, total: 3 } })).toBe(
      "3 of 3 passages and records in this repository searchable by meaning (100%)",
    )
    expect(embeddedLabel({ state: "absent", embedded: { done: 0, total: 3 } })).toBeUndefined()
    expect(checkLabel({ check: { by: "vectors", lowest: 0.99987, needed: 0.995 } })).toBe(
      "Checked on this computer against its pinned vectors: lowest match 1.000, needs 0.995.",
    )
    expect(checkLabel({ check: { by: "ranking", lowest: 1, needed: 0 } })).toContain("ranks its test sentences")
    expect(runsLabel({ worker: { mode: "in-process", reason: "it did not start" } })).toBe(
      "It does not run here: Vector's background reader is not running (it did not start).",
    )
    expect(runsLabel({ worker: { mode: "worker" } })).toBeUndefined()
    expect(sourceLabel({ source: "mirror" })).toBe("Downloaded from Vector's copy of the pinned files.")
  })

  test("offers the download once there are documents, and never where downloads are off or once answered", () => {
    const list = (model: MemoryModelStatus, documents = [{ id: "d1" } as MemoryDocument]) => ({ documents, model })
    expect(offerModel(list({ state: "absent", options }), false)).toBe(
      "Search these documents by meaning too: a one-time 24 MB download, then it runs on this computer.",
    )
    expect(offerModel(list({ state: "absent", options }), true)).toBeUndefined()
    expect(offerModel(list({ state: "absent", options }, []), false)).toBeUndefined()
    expect(offerModel(list({ state: "absent", downloads: false, options }), false)).toBeUndefined()
    expect(offerModel(list({ state: "ready", options }), false)).toBeUndefined()
  })

  test("download notices finish when the model is ready or fails, even while document embedding continues", () => {
    expect(modelBusy({ state: "downloading" })).toBe(true)
    expect(modelBusy({ state: "verifying" })).toBe(true)
    const embedding: MemoryModelStatus = { state: "ready", embedded: { done: 1, total: 4 } }
    expect(modelPolling(embedding)).toBe(true)
    expect(modelBusy(embedding)).toBe(false)
    expect(modelBusy({ state: "failed" })).toBe(false)
    expect(modelBusy({ state: "absent" })).toBe(false)
    expect(modelBusy(undefined)).toBe(false)
  })

  test("keeps asking while it downloads, checks or embeds, and stops when paused or done", () => {
    expect(modelPolling({ state: "downloading" })).toBe(true)
    expect(modelPolling({ state: "verifying" })).toBe(true)
    expect(modelPolling({ state: "ready", embedded: { done: 1, total: 4 } })).toBe(true)
    expect(modelPolling({ state: "ready", paused: true, embedded: { done: 1, total: 4 } })).toBe(false)
    expect(modelPolling({ state: "ready", embedded: { done: 4, total: 4 } })).toBe(false)
    expect(modelPolling({ state: "absent" })).toBe(false)
    expect(polling({ indexing: false, model: { state: "ready", embedded: { done: 1, total: 4 } } })).toBe(true)
  })

  test("says repository, and makes no promise it cannot keep", () => {
    const words = [
      modelHeadline({ state: "absent", options }),
      modelHeadline({ state: "ready", options }),
      modelOffer(arctic),
      MODEL_DOWNLOADS_OFF,
      ...Object.values(MODEL_DONE),
      embeddedLabel({ state: "ready", embedded: { done: 1, total: 2 } })!,
    ]
    for (const word of words) {
      expect(word.toLowerCase()).not.toContain("project")
      expect(word).not.toMatch(/\bexactly\b|never exceeds|absolute privacy|fully offline/i)
    }
  })
})
