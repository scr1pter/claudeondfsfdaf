// What Settings > Memory > Documents says about each document, kept apart from the page so the wording is tested and
// stays honest. Every word here is shown to the user: it says "repository", never the other word.

import type {
  MemoryAnchor,
  MemoryDistillEstimate,
  MemoryDistillResult,
  MemoryDocument,
  MemoryDocumentDetail,
  MemoryDocumentList,
  MemoryDocumentPage,
  MemoryModelOption,
  MemoryModelStatus,
  MemoryRecord,
  MemoryReviewItem,
} from "@vectordevai/sdk/v2/client"

export type DocumentStatus = MemoryDocument["status"]
export type DocumentHold = NonNullable<MemoryDocument["hold"]>
export type DocumentWarning = MemoryDocument["warnings"][number]
export type RecordKind = MemoryRecord["kind"]
export type Refusal =
  | "too-large"
  | "unsupported"
  | "encrypted"
  | "empty"
  | "secret"
  | "invalid"
  | "limit"
  | "guest"
  | "forgotten"
  | "not-found"
  | "outside"
  | "busy"
  | "version"

/** How often the page asks for progress while something is being read or downloaded. */
export const POLL = 2_000

/** The largest file the page sends; the engine refuses anything bigger. */
export const UPLOAD_BYTES = 64 * 1024 * 1024

/** What the drop zone and "Add documents…" take, by extension. */
export const DOCUMENT_EXTENSIONS = [
  "pdf",
  "docx",
  "docm",
  "pptx",
  "xlsx",
  "csv",
  "tsv",
  "md",
  "mdx",
  "markdown",
  "html",
  "htm",
  "json",
  "yaml",
  "yml",
  "txt",
  "rst",
  "adoc",
] as const

export const DOCUMENT_ACCEPT = DOCUMENT_EXTENSIONS.map((ext) => `.${ext}`).join(",")

const LEGACY_OFFICE: Record<string, string> = { doc: "docx", ppt: "pptx", xls: "xlsx" }
const IMAGES = new Set(["png", "jpg", "jpeg", "gif", "webp", "avif", "bmp", "tif", "tiff", "heic", "heif", "svg"])
const ARCHIVES = new Set(["zip", "tar", "gz", "tgz", "bz2", "xz", "7z", "rar", "dmg", "iso"])
const PROGRAMS = new Set(["exe", "msi", "app", "dll", "so", "dylib", "bin", "sh", "bat", "cmd", "ps1", "jar"])

/** Whether the page sends a file at all, and if not, why: the same answers the engine gives, without the upload. */
export function precheck(file: { name: string; size: number }) {
  const ext = extension(file.name)
  if (IMAGES.has(ext))
    return "Attach images to a message so the model can look at them. Vector does not read text in images."
  if (LEGACY_OFFICE[ext])
    return `Vector reads .${LEGACY_OFFICE[ext]}, not .${ext}. Save it as .${LEGACY_OFFICE[ext]} and add that.`
  if (ARCHIVES.has(ext)) return "Vector does not open archives. Add the documents inside it one by one."
  if (PROGRAMS.has(ext)) return "Vector only keeps documents, not programs or scripts."
  if (file.size === 0) return `${file.name} is empty.`
  if (file.size > UPLOAD_BYTES) return `${file.name} is ${bytes(file.size)}. Vector keeps documents of up to 64 MB.`
  return undefined
}

/**
 * How a dropped file reaches the engine: by its path when the app talks to its own engine on this computer and knows
 * where the file is (nothing is copied through the app), otherwise as the file's bytes.
 */
export function uploadMode(input: { builtin: boolean; path?: string }) {
  return input.builtin && input.path ? ("path" as const) : ("bytes" as const)
}

/** The status the list shows, in the user's words. */
export function statusLabel(document: Pick<MemoryDocument, "status" | "hold" | "paused" | "unread" | "warnings">) {
  if (document.paused && !done(document.status)) return "Paused"
  if (document.status === "queued") return "Queued"
  if (document.status === "reading") return "Reading"
  if (document.status === "linking") return "Linking to code"
  if (document.status === "searchable" || document.status === "embedding") return "Searchable"
  if (document.status === "ready") return "Ready"
  if (document.status === "held") return `Held for your review: ${documentHoldLabel(document.hold)}`
  if (document.status === "failed") return "Could not read"
  if (document.status === "superseded") return "Replaced by a newer version"
  if (document.unread.length > 0 || document.warnings.includes("scanned")) return "Scanned pages skipped"
  return "Partly read"
}

/** Whether the status reads as fine, in progress, waiting for the user, or a problem: it picks the dot's colour. */
export function statusTone(document: Pick<MemoryDocument, "status" | "paused">) {
  if (document.paused && !done(document.status)) return "idle" as const
  if (document.status === "held") return "waiting" as const
  if (document.status === "failed") return "problem" as const
  if (document.status === "partial") return "waiting" as const
  if (document.status === "superseded") return "idle" as const
  if (document.status === "searchable" || document.status === "ready" || document.status === "embedding")
    return "good" as const
  return "busy" as const
}

/** Why a whole document, or a passage of one, waits for the user, short enough to follow "Held for your review:". */
export function documentHoldLabel(hold: DocumentHold | undefined) {
  if (hold === "instruction-like") return "parts of it read like instructions to an AI"
  if (hold === "hidden-text") return "it has text a reader would not see"
  if (hold === "hidden-unicode") return "it contains hidden characters"
  if (hold === "untrusted-repository") return "this repository's settings are not trusted yet"
  if (hold === "suggested") return "Vector offered to keep it without you asking"
  if (hold === "web") return "it was kept in a session that read web content"
  if (hold === "mcp") return "it was kept in a session that used an MCP tool"
  if (hold === "subagent") return "a subagent kept it"
  if (hold === "guest") return "it was kept while an invited guest was in the session"
  return "Vector could not check where it came from"
}

export type Step = { label: string; state: "done" | "active" | "pending" }

/**
 * The progress line under a document: what is read, how it is structured, what code it links to and how much of it is
 * searchable by meaning. Steps that do not apply yet (no code links, no search model) are left out.
 */
export function steps(document: Pick<MemoryDocument, "status" | "format" | "pages" | "stats" | "embedModel">): Step[] {
  const order: readonly DocumentStatus[] = ["queued", "reading", "linking", "searchable", "embedding", "ready"]
  const at = order.indexOf(document.status)
  // Partial, held and superseded documents were read; a failed one was not.
  const past = (step: number) => (at === -1 ? document.status !== "failed" : at >= step)
  const unit = units(document.format)
  const total = document.stats.passages + document.stats.records
  return [
    {
      label:
        unit && document.pages
          ? `Read ${Math.min(document.stats.read, document.pages).toLocaleString()}/${document.pages.toLocaleString()} ${plural(document.pages, unit)}`
          : "Read",
      state: past(2) ? "done" : document.status === "reading" ? "active" : "pending",
    },
    {
      label: past(2) ? `Structured ${count(document.stats.sections, "section")}` : "Structured",
      state: past(2) ? "done" : "pending",
    },
    ...(document.stats.linked > 0 || document.status === "linking"
      ? [
          {
            label: document.stats.linked > 0 ? `Linked ${count(document.stats.linked, "file")}` : "Linking to code",
            state: past(3)
              ? ("done" as const)
              : document.status === "linking"
                ? ("active" as const)
                : ("pending" as const),
          },
        ]
      : []),
    ...(document.status === "embedding" || document.embedModel || document.stats.embedded > 0
      ? [
          {
            label: `Meaning ${total > 0 ? Math.min(100, Math.floor((document.stats.embedded / total) * 100)) : 0}%`,
            state:
              document.status === "ready"
                ? ("done" as const)
                : document.status === "embedding"
                  ? ("active" as const)
                  : ("pending" as const),
          },
        ]
      : []),
  ]
}

/** The line of facts under a document's title. */
export function documentMeta(
  document: Pick<MemoryDocument, "format" | "pages" | "bytes" | "stats" | "origin" | "createdAt">,
  now = Date.now(),
) {
  const unit = units(document.format)
  return [
    formatLabel(document.format),
    ...(unit && document.pages ? [count(document.pages, unit)] : []),
    bytes(document.bytes),
    ...(document.stats.tokens > 0 ? [`about ${tokens(document.stats.tokens)} tokens if sent`] : []),
    `${originLabel(document.origin)} ${ago(document.createdAt, now)}`,
  ].join(" · ")
}

export function formatLabel(format: MemoryDocument["format"]) {
  return {
    pdf: "PDF",
    docx: "Word",
    pptx: "PowerPoint",
    xlsx: "Excel",
    csv: "CSV",
    markdown: "Markdown",
    html: "HTML",
    json: "JSON",
    yaml: "YAML",
    openapi: "OpenAPI",
    text: "Text",
  }[format]
}

export function originLabel(origin: MemoryDocument["origin"]) {
  return {
    upload: "You added this",
    chat: "Remembered from a message",
    agent: "Vector kept this",
    repository: "From this repository's docs",
    cli: "Added from the command line",
    web: "A page Deep research read",
    research: "A Deep research report",
  }[origin]
}

/** What a document's visibility means for who may use it. */
export function visibilityLabel(visibility: MemoryDocument["visibility"]) {
  if (visibility === "repository")
    return "Part of this repository, so it is used like the repository's own files, also with guests."
  return "Private: kept from invited guests and from models that may train on prompts."
}

export function warningLabel(warning: DocumentWarning, document?: Pick<MemoryDocument, "unread">) {
  if (warning === "truncated") return "Vector read the first part only; the rest was past its limits."
  if (warning === "scanned")
    return document?.unread.length
      ? `Scanned pages (${pageList(document.unread)}) have no readable text. Local OCR may be unavailable or could not recognize them.`
      : "Some scanned pages have no readable text. Local OCR may be unavailable or could not recognize them."
  if (warning === "ocr")
    return "Text was recognized locally from scanned pages. Check important numbers and quotations against the original."
  if (warning === "ocr-incomplete")
    return "Local OCR could not read every scanned page. Check the unread pages and OCR setup before relying on full coverage."
  if (warning === "encrypted") return "Parts of it are password protected and were not read."
  if (warning === "macros-ignored") return "Its macros were ignored; they never run."
  if (warning === "external-links") return "Links to outside files were not followed."
  if (warning === "secrets-removed") return "Secrets in it were removed before anything was saved."
  return "Some tables were read approximately."
}

/**
 * What waits for the user across documents: whole documents held, and passages held inside documents that are
 * otherwise in use. Code drift and conflicts join this list when Vector checks them.
 */
export function needsLook(documents: readonly Pick<MemoryDocument, "id" | "title" | "status" | "hold" | "stats">[]) {
  return documents.flatMap((document) => {
    if (document.status === "superseded") return []
    if (document.status === "held")
      return [
        {
          document: document.id,
          title: document.title,
          text: `Held for your review: ${documentHoldLabel(document.hold)}`,
          count: 1,
        },
      ]
    if (document.stats.held > 0)
      return [
        {
          document: document.id,
          title: document.title,
          text: `${count(document.stats.held, "passage")} held for your review, the rest is in use`,
          count: document.stats.held,
        },
      ]
    return []
  })
}

export function needsLookCount(documents: Parameters<typeof needsLook>[0]) {
  return needsLook(documents).reduce((sum, item) => sum + item.count, 0)
}

/** What a document's page says about its held passages: how many, why, and where to read them. */
export function heldLabel(held: readonly { hold?: DocumentHold }[], paged: boolean) {
  if (held.length === 0) return ""
  const why = [...new Set(held.map((item) => documentHoldLabel(item.hold)))].join("; ")
  const one = held.length === 1
  return [
    `${one ? "1 passage is" : `${held.length} passages are`} held for your review and never ${one ? "reaches" : "reach"} the agent: ${why}.`,
    ...(paged ? [`${one ? "It is" : "They are"} marked in Pages.`] : []),
  ].join(" ")
}

/** The tab's one-line summary. `waiting` is the review list's count, when the engine gave one. */
export function documentsSummary(list: Pick<MemoryDocumentList, "documents" | "indexing">, waiting?: number) {
  const shown = list.documents.filter((document) => document.status !== "superseded")
  if (shown.length === 0) return "No documents yet"
  const busy = shown.filter((document) => statusTone(document) === "busy").length
  const looks = waiting ?? needsLookCount(shown)
  return [
    count(shown.length, "document"),
    ...(busy > 0 ? [`${busy} being read`] : []),
    ...(looks > 0 ? [`${looks} to look at`] : []),
    "only the parts a request needs are sent",
  ].join(" · ")
}

/**
 * Whether the page keeps asking for progress: while anything is read, the search model downloads, or documents are
 * still being embedded (and the user has not paused that).
 */
export function polling(list: Pick<MemoryDocumentList, "indexing" | "model"> | undefined) {
  if (!list) return false
  return list.indexing || modelPolling(list.model)
}

/**
 * The engine's answer when it is a document list. An engine from before documents answers this path some other way,
 * and the page then says documents are not available rather than failing.
 */
export function documentList(value: unknown): MemoryDocumentList | undefined {
  if (!value || typeof value !== "object" || !("documents" in value) || !Array.isArray(value.documents))
    return undefined
  return value as MemoryDocumentList
}

/** Pausing applies while a document is still being read or embedded; a finished one has nothing to pause. */
export function pausable(document: Pick<MemoryDocument, "status" | "paused">) {
  return !document.paused && !done(document.status)
}

export function resumable(document: Pick<MemoryDocument, "status" | "paused">) {
  return !!document.paused && !done(document.status)
}

/** Reading a document again needs what it was read from: a kept copy or the file it was added from. */
export function reindexable(document: Pick<MemoryDocument, "status" | "stored" | "sourcePath">) {
  return document.status !== "superseded" && (document.stored || !!document.sourcePath)
}

/**
 * Replacing reads another file as a document's next version, matched by its name. A repository doc is the file in the
 * repository, so it changes when that file does, never from here.
 */
export function replaceable(document: Pick<MemoryDocument, "status" | "origin">) {
  return document.status !== "superseded" && document.origin !== "repository"
}

export function approvable(document: Pick<MemoryDocument, "status">) {
  return document.status === "held"
}

// Statuses past reading, where Pause no longer applies.
function done(status: DocumentStatus) {
  return (
    status === "searchable" ||
    status === "ready" ||
    status === "partial" ||
    status === "held" ||
    status === "failed" ||
    status === "superseded"
  )
}

/** What the page says when the engine refused a file. Its message already names the file and says what to do. */
export function refusalLabel(reason: Refusal | undefined, message: string | undefined, name: string) {
  if (reason === "version")
    return `${name} is already here. Read this file as its next version? Your edits, pins and links carry over.`
  if (reason === "guest") return "Only the owner of this computer adds documents."
  if (reason === "busy") return "Vector is reading many documents at once. Add this one again in a minute."
  if (message) return message
  if (reason === "too-large") return `${name} is too large for Vector to read.`
  if (reason === "unsupported") return `Vector cannot read ${name}.`
  if (reason === "encrypted")
    return "This file is password protected. Vector doesn't ask for document passwords; add an unprotected copy."
  if (reason === "empty") return `${name} has no text Vector can read.`
  if (reason === "secret") return `${name} looks like a file of secrets, so Vector does not keep it.`
  if (reason === "limit") return "This repository holds the most documents Vector keeps. Forget some to add more."
  if (reason === "forgotten") return `You forgot ${name} earlier. Add it again here to keep it.`
  if (reason === "outside") return `${name} is outside this repository.`
  if (reason === "not-found") return `Vector could not find ${name}.`
  return `Vector could not read ${name}.`
}

/** Why the engine said no: its reason and message, from a MemoryError or a too-large answer the SDK returned. */
export function refusal(error: unknown): { reason?: Refusal; message?: string } {
  if (!error || typeof error !== "object") return {}
  const data = "data" in error && error.data && typeof error.data === "object" ? error.data : undefined
  const message =
    data && "message" in data && typeof data.message === "string"
      ? data.message
      : error instanceof Error
        ? error.message
        : undefined
  const reason =
    data && "reason" in data && typeof data.reason === "string"
      ? REFUSALS.find((item) => item === data.reason)
      : undefined
  return { ...(reason ? { reason } : {}), ...(message ? { message } : {}) }
}

const REFUSALS: readonly Refusal[] = [
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

/** What the page says once a file went in. */
export function addedLabel(result: { type: "queued" | "unchanged" | "version" }, name: string) {
  if (result.type === "unchanged") return `${name} is already here, unchanged.`
  if (result.type === "version") return `Reading ${name} as a new version. Your edits, pins and links carry over.`
  return `Reading ${name}. It is searchable in a few seconds; large files take longer.`
}

export const FORGET = "Forget this document for good? Its records, passages and links go too, also from old sessions."

export function forgottenLabel(title: string) {
  return `Forgot ${title}. Vector will not keep it again on its own; you can always add it again.`
}

export function recordKindLabel(kind: RecordKind, many = false) {
  const one = {
    requirement: "Requirement",
    constraint: "Constraint",
    decision: "Decision",
    contract: "Contract",
    procedure: "Procedure",
    term: "Term",
    entity: "Entity",
    fact: "Fact",
    question: "Open question",
  }[kind]
  return many ? `${one}s` : one
}

export const RECORD_KINDS: readonly RecordKind[] = [
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

/** "12 requirements · 4 constraints · 1 open question", largest first, nothing for kinds it has none of. */
export function kindCounts(kinds: Partial<Record<RecordKind, number>>) {
  const items = RECORD_KINDS.flatMap((kind) =>
    (kinds[kind] ?? 0) > 0 ? [{ kind, n: kinds[kind] ?? 0 }] : [],
  ).toSorted((a, b) => b.n - a.n || RECORD_KINDS.indexOf(a.kind) - RECORD_KINDS.indexOf(b.kind))
  if (items.length === 0) return "Nothing learned from it yet"
  return items
    .map((item) => `${item.n.toLocaleString()} ${recordKindLabel(item.kind, item.n !== 1).toLowerCase()}`)
    .join(" · ")
}

/** What the user can say about a record that Vector called the wrong kind: "Not a requirement". */
export function notApplicableLabel(kind: RecordKind) {
  const label = recordKindLabel(kind).toLowerCase()
  return `Not ${/^[aeiou]/.test(label) ? "an" : "a"} ${label}`
}

/**
 * "Used in 4 runs · 3 passed" once answers cited the record or the agent opened it (runs whose checks went green
 * passed); before that, how many requests it was brought into.
 */
export function recordUsage(record: Pick<MemoryRecord, "uses" | "runs" | "passed">) {
  if (record.runs) return `Used in ${count(record.runs, "run")} · ${(record.passed ?? 0).toLocaleString()} passed`
  if (!record.uses) return "Not used yet"
  return `Used in ${count(record.uses, "run")}`
}

/** What a new version changed: "+1 requirement, 2 changed, 1 removed, 9 unchanged; your 1 edit and 1 pin are kept." */
export function versionDiffLabel(diff: NonNullable<MemoryDocumentDetail["diff"]>) {
  const total = (kinds: Record<string, number>) => Object.values(kinds).reduce((sum, n) => sum + n, 0)
  const added = RECORD_KINDS.flatMap((kind) =>
    (diff.added[kind] ?? 0) > 0 ? [`+${count(diff.added[kind]!, recordKindLabel(kind).toLowerCase())}`] : [],
  )
  const parts = [
    ...added,
    ...(total(diff.changed) ? [`${total(diff.changed).toLocaleString()} changed`] : []),
    ...(total(diff.removed) ? [`${total(diff.removed).toLocaleString()} removed`] : []),
    ...(total(diff.unchanged) ? [`${total(diff.unchanged).toLocaleString()} unchanged`] : []),
  ]
  const kept = [...(diff.edits ? [count(diff.edits, "edit")] : []), ...(diff.pins ? [count(diff.pins, "pin")] : [])]
  const changes = parts.length ? parts.join(", ") : "nothing Vector learned changed"
  const yours = kept.length ? `; your ${kept.join(" and ")} ${diff.edits + diff.pins === 1 ? "is" : "are"} kept` : ""
  return `Version ${diff.version}: ${changes}${yours}.`
}

/** "Used in 4 runs · 3 passed · 1 undone", for the last 30 days, or that no run has used it. */
export function usageLabel(usage: MemoryDocumentDetail["usage"]) {
  if (!usage.runs) return "No run has cited or opened its cards in the last 30 days."
  return [
    `Used in ${count(usage.runs, "run")} in the last 30 days`,
    `${usage.passed.toLocaleString()} passed their checks`,
    ...(usage.reverted ? [`${usage.reverted.toLocaleString()} undone`] : []),
  ].join(" · ")
}

/** One step of a document's History, as a sentence. */
export function historyLine(event: MemoryDocumentDetail["history"][number]) {
  const detail = event.detail ?? {}
  const text = (value: unknown) => (typeof value === "string" ? value : "")
  const path = text(detail.path)
  const version = typeof detail.version === "number" ? detail.version : undefined
  if (event.action === "added")
    return event.actor === "agent"
      ? "Kept by the agent"
      : event.actor === "vector"
        ? "Read from the repository"
        : `Added${version && version > 1 ? ` as version ${version}` : ""}`
  if (event.action === "version")
    return typeof detail.version === "number" && typeof detail.previous === "string"
      ? versionDiffLabel(detail as NonNullable<MemoryDocumentDetail["diff"]>)
      : "A new version replaced the one before"
  if (event.action === "changed")
    return `Changed in version ${version ?? "?"}: “${text(detail.before)}” became “${text(detail.after)}”`
  if (event.action === "linked")
    return event.actor === "vector"
      ? `Linked to ${path} when the code landed`
      : `You linked it to ${path}${detail.symbol ? ` ${text(detail.symbol)}` : ""}`
  if (event.action === "unlinked") return `You unlinked ${path}`
  if (event.action === "edited") return "You edited its card"
  if (event.action === "pinned") return "You pinned it"
  if (event.action === "unpinned") return "You unpinned it"
  if (event.action === "kind") return `You made it ${recordArticle(text(detail.after))}`
  if (event.action === "not-applicable") return "You said it is not what Vector called it"
  if (event.action === "forget") return "You set it aside"
  if (event.action === "restored") return "You brought it back"
  if (event.action === "made-memory") return "You made it a memory"
  if (event.action === "distilled") return distilledLine(detail)
  if (event.action === "kept-suggestions")
    return `You kept ${typeof detail.count === "number" ? count(detail.count, "suggestion") : "the suggestions"} from a model`
  return event.action
}

// A run of a model over the document, on its History: what it kept and what the request spent.
function distilledLine(detail: Record<string, unknown>) {
  const model = typeof detail.model === "string" ? detail.model : "a model"
  const kept = typeof detail.kept === "number" ? detail.kept : 0
  const used = detail.tokens && typeof detail.tokens === "object" ? (detail.tokens as Record<string, unknown>) : {}
  const spent = [used.input, used.output].reduce<number>(
    (sum, value) => sum + (typeof value === "number" ? value : 0),
    0,
  )
  const cost = typeof detail.cost === "number" && detail.costKind === "priced" ? `, ${usd(detail.cost)}` : ""
  return `You asked ${model} to find more: ${kept === 0 ? "no suggestions" : count(kept, "suggestion")} kept (${spent.toLocaleString("en-US")} tokens${cost})`
}

/** When a step happened, as a short date. */
export function historyDate(at: number) {
  return new Date(at).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" })
}

function recordArticle(kind: string) {
  const label = RECORD_KINDS.includes(kind as RecordKind) ? recordKindLabel(kind as RecordKind).toLowerCase() : kind
  return `${/^[aeiou]/.test(label) ? "an" : "a"} ${label}`
}

/** Where a record comes from in its document. */
export function recordPlace(record: Pick<MemoryRecord, "page" | "section">) {
  return [...(record.page ? [`p.${record.page}`] : []), ...(record.section ? [record.section] : [])].join(" · ")
}

export function recordStatusLabel(
  record: Pick<MemoryRecord, "status" | "hold" | "userEdited" | "pinned"> & Partial<Pick<MemoryRecord, "origin">>,
) {
  if (record.origin === "distilled" && record.status === "proposed") return "Suggested by a model: keep it or drop it"
  if (record.status === "quarantined" || record.status === "proposed")
    return `Held for your review: ${documentHoldLabel(record.hold)}`
  if (record.status === "archived") return "Not used: you set it aside"
  return [record.pinned ? "Pinned" : "", record.userEdited ? "Edited by you" : ""].filter(Boolean).join(" · ")
}

export type OutlineRow = { id: string; heading: string; level: number; pages: string; unread: boolean }

/** The outline as the page lists it: indented headings with their pages, and whether a page in it was not read. */
export function outlineRows(detail: Pick<MemoryDocumentDetail, "outline">, unread: readonly number[]): OutlineRow[] {
  const top = Math.min(...detail.outline.map((section) => section.level), Infinity)
  return detail.outline.map((section) => ({
    id: section.id,
    heading: section.heading || "Untitled section",
    level: Math.max(0, section.level - (Number.isFinite(top) ? top : 0)),
    pages:
      section.pageStart === undefined
        ? ""
        : section.pageEnd === undefined || section.pageEnd === section.pageStart
          ? `p.${section.pageStart}`
          : `pp.${section.pageStart}-${section.pageEnd}`,
    unread:
      section.pageStart !== undefined &&
      unread.some((page) => page >= section.pageStart! && page <= (section.pageEnd ?? section.pageStart!)),
  }))
}

export type Span = { text: string; record?: { id: string; kind: RecordKind } }

/**
 * A passage's text cut where its records sit, so the page can mark them. Spans out of range are clamped, and one that
 * overlaps an earlier one only marks what is left of it.
 */
export function highlight(passage: Pick<MemoryDocumentPage["passages"][number], "text" | "records">): Span[] {
  const length = passage.text.length
  const marks = passage.records
    .map((record) => ({
      id: record.id,
      kind: record.kind,
      start: clamp(record.start, length),
      end: clamp(record.end, length),
    }))
    .filter((record) => record.end > record.start)
    .toSorted((a, b) => a.start - b.start || b.end - a.end)
  const state = { at: 0, spans: [] as Span[] }
  for (const mark of marks) {
    const start = Math.max(mark.start, state.at)
    if (start >= mark.end) continue
    if (start > state.at) state.spans.push({ text: passage.text.slice(state.at, start) })
    state.spans.push({ text: passage.text.slice(start, mark.end), record: { id: mark.id, kind: mark.kind } })
    state.at = mark.end
  }
  if (state.at < length || state.spans.length === 0) state.spans.push({ text: passage.text.slice(state.at) })
  return state.spans
}

/** What a page of the Pages view says above its text. */
export function pageHeading(page: Pick<MemoryDocumentPage, "page" | "pages" | "unread">) {
  if (page.unread) return `Page ${page.page} of ${page.pages}: no readable text was extracted from this scanned page.`
  return `Page ${page.page} of ${page.pages}`
}

/** "p.3, 7-9": scanned pages, compressed. */
export function pageList(pages: readonly number[]) {
  const sorted = [...new Set(pages)].toSorted((a, b) => a - b)
  const runs = sorted.reduce<{ start: number; end: number }[]>((all, page) => {
    const last = all.at(-1)
    if (last && page === last.end + 1) return [...all.slice(0, -1), { start: last.start, end: page }]
    return [...all, { start: page, end: page }]
  }, [])
  return `p.${runs.map((run) => (run.start === run.end ? `${run.start}` : `${run.start}-${run.end}`)).join(", ")}`
}

export const REPOSITORY_DOCS =
  "Vector reads this repository's READMEs, docs folder, decision records and API specs, in repositories you trust. Turning it off forgets what it read of them. Unlike documents you add, these are not private: they are shared like the repository's memory, with invited guests and with models that may train on prompts."

export const KEEP_ORIGINALS =
  "Keep a copy of each file you add on this computer, so Vector can read it again with a better reader. The copy is the file as you added it, secrets included; turning this off deletes the copies."

/** The drop zone's words. */
export const DROP = {
  idle: "Drop documents here, or add them from your computer",
  over: "Drop to add",
  formats: "PDF, Word, PowerPoint, Excel, Markdown, HTML, OpenAPI, JSON, YAML, CSV and text, up to 64 MB each",
  private:
    "Documents you add are read on this computer and stay private: kept from invited guests and from models that may train on prompts.",
}

export function bytes(size: number) {
  if (size < 1024) return `${size} B`
  if (size < 1024 * 1024) return `${Math.round(size / 1024)} KB`
  return `${(size / (1024 * 1024)).toFixed(size < 10 * 1024 * 1024 ? 1 : 0)} MB`
}

/** Token counts are estimates, so they are rounded the way they are read: "about 140,000". */
export function tokens(value: number) {
  const step = value >= 10_000 ? 1_000 : value >= 1_000 ? 100 : 10
  return Math.max(step, Math.round(value / step) * step).toLocaleString("en-US")
}

function ago(at: number, now: number) {
  const days = Math.floor((now - at) / 86_400_000)
  if (days <= 0) return "today"
  if (days === 1) return "yesterday"
  return `${days} days ago`
}

function units(format: MemoryDocument["format"]) {
  if (format === "pdf" || format === "docx") return "page"
  if (format === "pptx") return "slide"
  if (format === "xlsx") return "sheet"
  return undefined
}

function count(n: number, unit: string) {
  return `${n.toLocaleString()} ${plural(n, unit)}`
}

function plural(n: number, unit: string) {
  return n === 1 ? unit : `${unit}s`
}

function extension(name: string) {
  const at = name.lastIndexOf(".")
  return at === -1 ? "" : name.slice(at + 1).toLowerCase()
}

function clamp(value: number, length: number) {
  return Math.min(Math.max(0, value), length)
}

// --- Finding more with a model -------------------------------------------------------------------------------------

/**
 * What the estimate sheet says first: how a model is used here, and what is kept of what it says. The sheet asks the
 * default model, which the estimate names; only the terminal's --model picks another.
 */
export const DISTILL =
  "Your default model reads the sections where Vector's rules found little. Each suggestion must quote the document word for word or it is dropped, and what is kept waits here for you to keep or drop. Not for models that may train on prompts."

/** The estimate, before anything is sent: what would go, to which model, and what it may cost. */
export function distillEstimateLabel(estimate: MemoryDistillEstimate) {
  if (estimate.refused) return estimate.refused.message
  return `Vector would send ${count(estimate.sections, "section")} (about ${tokens(estimate.input)} tokens) to ${estimate.model ?? "the model"}, with up to ${tokens(estimate.output)} tokens back. ${distillCostLabel(estimate)}`
}

/** What a request may cost: at catalog rates for a priced model, and said plainly when there is no price. */
export function distillCostLabel(estimate: Pick<MemoryDistillEstimate, "costKind" | "lowUsd" | "highUsd">) {
  if (estimate.costKind === "free") return "The model is free."
  if (estimate.costKind === "plan") return "Your plan covers the model."
  if (estimate.lowUsd === undefined || estimate.highUsd === undefined)
    return "The model has no listed price, so Vector cannot estimate what it costs."
  return `About ${usd(estimate.lowUsd)} to ${usd(estimate.highUsd)} at catalog rates.`
}

/** What the page says once the model answered. */
export function distilledLabel(result: Pick<MemoryDistillResult, "records" | "model" | "dropped" | "error">) {
  const dropped = result.dropped.quote + result.dropped.scan + result.dropped.invalid
  const head =
    result.records.length === 0
      ? `No suggestions from ${result.model} held their quotes.`
      : `${suggestionsLabel(result.records.length, result.model)}, waiting below for you to keep or drop.`
  const away = dropped > 0 ? ` Dropped ${count(dropped, "suggestion")} that did not hold up against the document.` : ""
  return `${head}${away}${result.error ? ` ${result.error}` : ""}`
}

/** "12 suggestions from <model>". */
export function suggestionsLabel(n: number, model: string | undefined) {
  return `${count(n, "suggestion")}${model ? ` from ${model}` : ""}`
}

/** The model of the latest run over the document, from its History. */
export function suggestedBy(history: MemoryDocumentDetail["history"]) {
  const model = history.find((event) => event.action === "distilled")?.detail?.model
  return typeof model === "string" ? model : undefined
}

/** A record a model suggested that waits for the user. */
export function suggestion(record: Pick<MemoryRecord, "origin" | "status">) {
  return record.origin === "distilled" && record.status === "proposed"
}

function usd(value: number) {
  return `$${value < 0.01 ? value.toFixed(4) : value.toFixed(2)}`
}

// --- Code links and what needs a look ------------------------------------------------------------------------------

export type AnchorMethod = MemoryAnchor["method"]

/** How a record is linked to a file, as "the code … it". */
export function anchorMethodLabel(method: AnchorMethod) {
  if (method === "definition") return "defines it"
  if (method === "use") return "uses it"
  if (method === "route") return "serves the route"
  if (method === "env") return "reads the variable"
  if (method === "constant") return "sets the value"
  if (method === "path") return "is the file it names"
  if (method === "user") return "linked by you"
  return "changed in a run that used it"
}

export function anchorStatusLabel(status: MemoryAnchor["status"]) {
  if (status === "fresh") return "unchanged since Vector linked it"
  if (status === "drifted") return "changed since Vector linked it"
  return "gone from the code"
}

/** One link, in one line: where, what it names, how and whether the code still says it. */
export function anchorLine(anchor: MemoryAnchor) {
  const where = `${anchor.path}${anchor.line ? `:${anchor.line}` : ""}`
  const value = anchor.value ? ` (${anchor.value.raw})` : ""
  return [
    `${where}${anchor.symbol ? ` ${anchor.symbol}` : ""}`,
    `${anchorMethodLabel(anchor.method)}${value}`,
    anchorStatusLabel(anchor.status),
  ].join(" · ")
}

/** The words of a record that named the code, marked within its text. */
export function evidence(text: string, symbol: string | undefined) {
  const name = symbol?.replace(/^(?:GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS) /, "")
  const at = name ? text.indexOf(name) : -1
  if (!name || at < 0) return [{ text, mark: false }]
  return [
    ...(at > 0 ? [{ text: text.slice(0, at), mark: false }] : []),
    { text: name, mark: true },
    ...(at + name.length < text.length ? [{ text: text.slice(at + name.length), mark: false }] : []),
  ]
}

/** A document's links by record, in the order its records are listed; a link to a passage stands on its own. */
export function codeLinks(
  anchors: readonly MemoryAnchor[],
  records: readonly Pick<MemoryRecord, "id" | "kind" | "card">[],
) {
  const known = new Map(records.map((record) => [record.id, record]))
  const owners = [...new Set(anchors.map((anchor) => anchor.owner))]
  return owners
    .map((owner) => ({
      owner,
      record: known.get(owner),
      anchors: anchors
        .filter((anchor) => anchor.owner === owner)
        .toSorted((a, b) => b.weight - a.weight || a.path.localeCompare(b.path)),
    }))
    .toSorted((a, b) => Number(!a.record) - Number(!b.record))
}

export type ReviewAction = {
  readonly action: "dismiss" | "keep-document" | "keep-code" | "keep" | "approve" | "reject"
  readonly winner?: string
  readonly label: string
  /** What the page says once the engine took the decision. */
  readonly done: string
}

export type ReviewRow = {
  readonly id: string
  readonly kind: MemoryReviewItem["kind"]
  readonly title: string
  readonly text: string
  /** The document to open for it, when there is one. */
  readonly document?: string
  readonly actions: readonly ReviewAction[]
}

const CONFLICTS: Readonly<Record<string, string>> = {
  value: "They give different values",
  modality: "One requires what the other forbids",
  polarity: "One says the opposite of the other",
  endpoint: "They give the same endpoint another method or status",
}

const DISMISS: ReviewAction = {
  action: "dismiss",
  label: "Dismiss",
  done: "Dismissed. It stays dismissed while both sides say the same.",
}

/** Each item that needs a look, worded for the page, with the decisions it takes. Vector never settles one itself. */
export function reviewRows(items: readonly MemoryReviewItem[]): ReviewRow[] {
  return items.map((item) => {
    const detail = item.detail
    const word = (value: unknown) =>
      typeof value === "string" ? value : typeof value === "number" ? String(value) : ""
    if (item.kind === "drift") {
      const where = `${word(detail.path)}${detail.line ? `:${word(detail.line)}` : ""}`
      const text =
        detail.type === "value"
          ? `The document says ${word(detail.document)}; the code says ${word(detail.code)} (${where}).`
          : detail.type === "missing"
            ? `The code it is linked to is gone: ${where}${detail.symbol ? ` (${word(detail.symbol)})` : ""}.`
            : `The code it is linked to changed: ${where}${detail.symbol ? ` (${word(detail.symbol)})` : ""}.`
      return {
        id: item.id,
        kind: item.kind,
        title: `Linked code drifted from [${item.a}]`,
        text,
        actions: [
          { action: "keep-document", label: "The document is right", done: "Noted. The code is yours to change." },
          {
            action: "keep-code",
            label: "The code is right",
            done: "Saved as a decision of yours, and the link now takes the code as it is.",
          },
          DISMISS,
        ],
      }
    }
    if (item.kind === "conflict") {
      const side = (value: unknown) => {
        const record = value && typeof value === "object" ? (value as Record<string, unknown>) : {}
        return { id: word(record.id), title: word(record.title) || "Memory", text: word(record.text) }
      }
      const a = side(detail.a)
      const b = side(detail.b)
      const said = detail.said && typeof detail.said === "object" ? (detail.said as Record<string, unknown>) : {}
      const prefer = word(detail.prefer)
      return {
        id: item.id,
        kind: item.kind,
        title: `${a.title} and ${b.title} disagree`,
        text: `${CONFLICTS[word(detail.type)] ?? "They disagree"}: “${word(said.a) || a.text}” against “${word(said.b) || b.text}”.${prefer ? ` Vector would go by ${prefer === a.id ? a.title : b.title}, but it is your call.` : ""}`,
        actions: [
          {
            action: "keep",
            winner: a.id,
            label: `Keep ${a.title}`,
            done: `Kept ${a.title}. The other side is put away; you can restore it.`,
          },
          {
            action: "keep",
            winner: b.id,
            label: `Keep ${b.title}`,
            done: `Kept ${b.title}. The other side is put away; you can restore it.`,
          },
          DISMISS,
        ],
      }
    }
    const title = word(detail.title) || "A document"
    if (detail.suggested === true)
      return {
        id: item.id,
        kind: item.kind,
        title,
        text: `A model suggested a record from it. Keep it if the document says so.${detail.text ? ` “${word(detail.text).slice(0, 200)}”` : ""}`,
        ...(typeof detail.document === "string" ? { document: detail.document } : {}),
        actions: [
          { action: "approve", label: "Keep", done: "Kept. Vector uses it now." },
          { action: "reject", label: "Drop", done: "Dropped. A model's suggestion of it is not proposed again." },
        ],
      }
    const hold = typeof detail.hold === "string" ? (detail.hold as DocumentHold) : undefined
    const whole = detail.type === "document"
    return {
      id: item.id,
      kind: item.kind,
      title,
      text: whole
        ? `The whole document is held for your review: ${documentHoldLabel(hold)}.`
        : `${detail.type === "record" ? "A record" : "A passage"} is held for your review: ${documentHoldLabel(hold)}.${detail.text ? ` “${word(detail.text).slice(0, 200)}”` : ""}`,
      ...(typeof detail.document === "string" ? { document: detail.document } : {}),
      actions: [
        { action: "approve", label: "Approve", done: "Approved. Vector uses it now." },
        whole
          ? { action: "reject", label: "Reject", done: forgottenLabel(title) }
          : { action: "reject", label: "Reject", done: "Rejected. It stays out, also after a reindex." },
      ],
    }
  })
}

// --- Search model -------------------------------------------------------------------------------------------------

/** "24 MB", as the download is described before it starts. */
export function megabytes(bytes: number) {
  return `${Math.max(1, Math.round(bytes / 1_000_000))} MB`
}

/** The default model, the one the card offers first. */
export function defaultModel(status: Pick<MemoryModelStatus, "options"> | undefined) {
  return status?.options?.find((option) => !option.preview) ?? status?.options?.[0]
}

/** The model in use, or the one a download would fetch. */
export function shownModel(status: Pick<MemoryModelStatus, "options" | "model"> | undefined) {
  return status?.options?.find((option) => option.id === status.model) ?? defaultModel(status)
}

/** What the Search model card says first, in each state. */
export function modelHeadline(status: MemoryModelStatus | undefined) {
  if (!status) return "The search model is not available from this engine."
  const option = shownModel(status)
  if (status.state === "downloading")
    return `Downloading ${Math.round((status.progress ?? 0) * 100)}% of ${megabytes(status.total ?? option?.bytes ?? 0)}…`
  if (status.state === "verifying") return "Checking the model's files and its vectors on this computer…"
  if (status.state === "failed")
    return `The model cannot be used on this computer: ${status.error ?? "it failed its check"}. Until then Vector searches by keywords and code links.`
  if (status.state === "ready") return "Searching documents by meaning, keywords and code links, all on this computer."
  return `Searching by keywords and code links. Download the ${megabytes(option?.bytes ?? 0)} model to search by meaning.`
}

/** What a download is, said before it starts. */
export function modelOffer(option: Pick<MemoryModelOption, "label" | "bytes">) {
  return `${option.label}: a one-time ${megabytes(option.bytes)} download, then it runs on this computer with no network.`
}

/** Who made a model and under what license. */
export function modelLicense(option: Pick<MemoryModelOption, "owner" | "license">) {
  return `${option.owner} · ${option.license}`
}

/** A sha256 short enough for a row; the full one is the row's title. */
export function shortSha(sha256: string) {
  return sha256.length > 16 ? `${sha256.slice(0, 16)}…` : sha256
}

/** How much of the repository's documents is searchable by meaning. */
export function embeddedLabel(status: Pick<MemoryModelStatus, "state" | "embedded" | "paused"> | undefined) {
  const embedded = status?.embedded
  if (status?.state !== "ready" || !embedded || embedded.total === 0) return undefined
  const share = Math.min(100, Math.floor((embedded.done / embedded.total) * 100))
  const counted = `${embedded.done.toLocaleString("en-US")} of ${embedded.total.toLocaleString("en-US")} passages and records in this repository searchable by meaning (${share}%)`
  if (embedded.done >= embedded.total) return counted
  return status.paused
    ? `${counted}. Paused: the rest waits until you resume.`
    : `${counted}. The rest is embedded in the background.`
}

/** How the model's last load was checked on this computer. */
export function checkLabel(status: Pick<MemoryModelStatus, "check"> | undefined) {
  const check = status?.check
  if (!check) return undefined
  if (check.by === "ranking") return "Checked on this computer by how it ranks its test sentences."
  return `Checked on this computer against its pinned vectors: lowest match ${check.lowest.toFixed(3)}, needs ${check.needed}.`
}

/** Where the model runs, when it cannot run here. */
export function runsLabel(status: Pick<MemoryModelStatus, "worker"> | undefined) {
  if (status?.worker?.mode !== "in-process") return undefined
  return `It does not run here: Vector's background reader is not running${status.worker.reason ? ` (${status.worker.reason})` : ""}.`
}

/** Where the files came from. */
export function sourceLabel(status: Pick<MemoryModelStatus, "source"> | undefined) {
  if (status?.source === "mirror") return "Downloaded from Vector's copy of the pinned files."
  if (status?.source === "huggingface") return "Downloaded from Hugging Face at the pinned revision."
  if (status?.source === "folder") return "Installed from a folder."
  return undefined
}

/** Said where downloads are turned off, as in tests and CI. */
export const MODEL_DOWNLOADS_OFF =
  "Downloads are turned off here. In a terminal, install the model from a folder of its files with vector memory model install --from <folder>."

/**
 * Said wherever the full-precision fallback is offered or in use: its 90 MB graph has not been run in this build, and
 * it is checked against the int8 model's test vectors at a threshold nobody has measured on it.
 */
export const MODEL_FALLBACK_UNVERIFIED =
  "Not yet verified: the full-precision model has not been run in this release, so it may not pass its check on this computer either."

/** What each model action says once the engine answered. */
export const MODEL_DONE = {
  download: "Downloading the search model. You can keep working; documents are searched by meaning once it is ready.",
  fallback: "Downloading the full-precision model, which is not yet verified.",
  remove: "Removed. Vector searches documents by keywords and code links until you download the model again.",
  pause: "Paused. What is embedded is still searched by meaning; the rest waits until you resume.",
  resume: "Resumed.",
} as const

/** Whether the model itself is still downloading or being checked, before document embedding can start. */
export function modelBusy(status: Pick<MemoryModelStatus, "state"> | undefined) {
  return status?.state === "downloading" || status?.state === "verifying"
}

/** Whether the page keeps asking about the model: while it downloads or checks, or embeds what is left. */
export function modelPolling(status: Pick<MemoryModelStatus, "state" | "embedded" | "paused"> | undefined) {
  if (!status) return false
  if (modelBusy(status)) return true
  return status.state === "ready" && !status.paused && !!status.embedded && status.embedded.done < status.embedded.total
}

/** The one-time offer on the Documents tab: shown once there are documents and no model, until the user answers. */
export function offerModel(list: Pick<MemoryDocumentList, "documents" | "model"> | undefined, dismissed: boolean) {
  if (!list || dismissed || list.documents.length === 0) return undefined
  if (list.model?.state !== "absent" || list.model.downloads === false) return undefined
  const option = defaultModel(list.model)
  return option
    ? `Search these documents by meaning too: a one-time ${megabytes(option.bytes)} download, then it runs on this computer.`
    : undefined
}
