export * as BrainSchema from "./schema"

import { Schema } from "effect"

// One entry model for everything durable that steers the agent. A repository rule and a learned lesson are the same
// kind of record; they differ in who wrote them (origin) and how much they bind (kind: only `rule` is binding).

/** Where an entry applies: one repository on this computer, or every repository (the user's own). */
export const Scope = Schema.Literals(["repository", "personal"])
export type Scope = typeof Scope.Type

/**
 * - rule: binding. Only ever read from a rules file a person wrote; Vector never creates one.
 * - preference: how this user likes things done.
 * - decision: a choice and its reason.
 * - lesson: what worked or failed here, "when X, do Y because Z".
 * - fact: something checkable in the code.
 * - failure: a check that failed this way before and the repair that worked (failure memory).
 * - review: what Vectorscope was told not to flag; read by reviews, never sent with coding requests.
 * - term: what the user means by a word or phrase ("when I say ship it I mean open a PR, wait for CI, then merge"),
 *   delivered only to a request whose words name it.
 */
export const Kind = Schema.Literals(["rule", "preference", "decision", "lesson", "fact", "failure", "review", "term"])
export type Kind = typeof Kind.Type

/**
 * What a preference or a term is about (section 6.3), so Settings can group what Vector learned about the user, each
 * kind can be turned off, and a role hears only the kinds its work needs: format (tables, bullets, charts, units,
 * citation style, length), workflow (pull requests, CI, merging, tests, commits, deploys), vocabulary (what the user
 * means by their words), tooling (package manager, editor, language), sources (papers, primary sources, named sites),
 * and style (everything else).
 */
export const Facet = Schema.Literals(["format", "workflow", "vocabulary", "tooling", "sources", "style"])
export type Facet = typeof Facet.Type

/**
 * Metadata key of a message part whose text came from outside this conversation: a transcript imported as passive
 * history, the issue and pull request text the GitHub agent is given, a resource an editor embedded over ACP, or what
 * was piped into `vector run`. A role "user" message carrying it was not typed by the user, so its words vouch for no
 * memory, and memory written in a session that has one waits for review, as it does after reading the web. The value
 * says where the text came from; "file", a local file an editor embedded, is this computer's and holds nothing.
 */
export const OUTSIDE = "vector.outside"

/**
 * The OUTSIDE value of a text part the user pasted into the composer rather than typed: an email, a log, someone
 * else's message. Like a local file an editor embedded, it holds nothing, since the user chose to send it; but it
 * vouches for nothing either, so Vector never learns what the user likes from it.
 */
export const PASTE = "paste"

/**
 * Metadata key of the spans of a text part the user pasted into what they typed, as `[start, end]` offsets into the
 * part's text: what a composer that expands pastes inline sends (the terminal UI does). Like a part marked PASTE, those
 * spans hold nothing and vouch for nothing, so Vector never learns what the user likes from them.
 */
export const PASTED = "vector.pasted"

/** What the agent and the user may write themselves. A term's text reads "when I say X, I mean Y". */
export const LearnedKind = Schema.Literals(["preference", "decision", "lesson", "fact", "term"])
export type LearnedKind = typeof LearnedKind.Type

/**
 * - active: used by the agent. What the agent learns is active at once, unless it is held.
 * - proposed: waits for a second sighting or one click: what Vector learned from a long message, what a model suggested
 *   it learn, what was imported, and what an earlier version held without evidence it could check. Active once the
 *   user approves it, or once a session with nothing from outside in it writes the same words.
 * - quarantined: held for the user's review (untrusted source, guest, web or MCP content, instruction-like text).
 *   Neither proposed nor quarantined entries are ever shown to the agent, so a session cannot launder its own writes.
 * - archived: decayed or put away; restorable.
 * - superseded: replaced by a newer entry, kept and linked.
 */
export const Status = Schema.Literals(["active", "proposed", "quarantined", "archived", "superseded"])
export type Status = typeof Status.Type

/** import: read from a file the user imported, which waits for their approval however it reads. */
export const Origin = Schema.Literals(["file", "user", "agent", "failure-memory", "import"])
export type Origin = typeof Origin.Type

/**
 * Why an entry, a document or one of its passages waits for the user. Two only ever hold document content:
 * - hidden-text: text a reader of the document would not see (tiny or off-page PDF text, hidden Word or HTML text).
 * - suggested: a document the agent offered to keep without the user's own words asking for it.
 */
export const Hold = Schema.Literals([
  "web",
  "mcp",
  "subagent",
  "untrusted-repository",
  "guest",
  "instruction-like",
  "hidden-unicode",
  "hidden-text",
  "suggested",
])
export type Hold = typeof Hold.Type

export const Source = Schema.Struct({
  /** The file the entry is read from, for entries that mirror a file. */
  file: Schema.String,
  line: Schema.optional(Schema.Finite),
})

export const Entry = Schema.Struct({
  id: Schema.String,
  scope: Scope,
  kind: Kind,
  origin: Origin,
  status: Status,
  pinned: Schema.Boolean,
  text: Schema.String,
  paths: Schema.Array(Schema.String),
  confidence: Schema.Finite,
  uses: Schema.Finite,
  stale: Schema.Boolean,
  hold: Schema.optional(Hold),
  source: Schema.optional(Source),
  supersededBy: Schema.optional(Schema.String),
  related: Schema.Array(Schema.String),
  lastUsedAt: Schema.optional(Schema.Finite),
  createdAt: Schema.Finite,
  updatedAt: Schema.Finite,
  /**
   * Kept from the same places personal memory is (sessions an invited guest is in and models that may train on
   * prompts): learned in a session that read a private document, or by Vector's learner from the owner's own words
   * when they name someone or something in particular ("always cc jane@acme.com on release PRs").
   */
  private: Schema.optional(Schema.Boolean),
  /** What a preference or a term is about. */
  facet: Schema.optional(Facet),
  /** A term's word or phrase, as recall matches it, and what the user means by it. */
  term: Schema.optional(Schema.Struct({ key: Schema.String, meaning: Schema.String })),
}).annotate({ identifier: "MemoryEntry" })
export type Entry = typeof Entry.Type

export const Evidence = Schema.Struct({
  /** "document": a quote from a document's record or passage, whose id is the path. */
  type: Schema.Literals(["message", "file", "check", "user", "file-item", "document"]),
  path: Schema.optional(Schema.String),
  quote: Schema.optional(Schema.String),
  command: Schema.optional(Schema.String),
  sessionID: Schema.optional(Schema.String),
  createdAt: Schema.Finite,
}).annotate({ identifier: "MemoryEvidence" })
export type Evidence = typeof Evidence.Type

// Documents. A document the user gives Vector (or a doc the repository tracks) is read on this computer into sections,
// passages and typed records. They live in tables of their own, never as entries, so recall over memory stays a scan of
// a few hundred rows however many documents there are.

/** The reader a document went through. DOCM reads as docx, MDX as markdown, TSV as csv, and .rst and .adoc as text. */
export const Format = Schema.Literals([
  "pdf",
  "docx",
  "pptx",
  "xlsx",
  "csv",
  "markdown",
  "html",
  "json",
  "yaml",
  "openapi",
  "text",
])
export type Format = typeof Format.Type

/**
 * - private: uploads and chat attachments, withheld where personal memory is (guests, models that may train).
 * - repository: the repository's own tracked docs, which the agent could read anyway.
 */
export const Visibility = Schema.Literals(["private", "repository"])
export type Visibility = typeof Visibility.Type

/**
 * How a document arrived. web: a page Deep research read, kept held under its run. research: a research run's report,
 * held until the user keeps it.
 */
export const DocumentOrigin = Schema.Literals(["upload", "chat", "agent", "repository", "cli", "web", "research"])
export type DocumentOrigin = typeof DocumentOrigin.Type

/**
 * Where a document is in its reading, in order: queued, reading, linking (to code), searchable (by keywords and code
 * links), embedding, ready (searchable by meaning too). partial: read, with pages or parts it could not read. held: the
 * whole document waits for the user. superseded: a newer version replaced it.
 */
export const DocumentStatus = Schema.Literals([
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
])
export type DocumentStatus = typeof DocumentStatus.Type

/** What the user should know about how a document was read. */
export const DocumentWarning = Schema.Literals([
  "truncated",
  "scanned",
  "ocr",
  "ocr-incomplete",
  "encrypted",
  "macros-ignored",
  "external-links",
  "secrets-removed",
  "tables-approximate",
])
export type DocumentWarning = typeof DocumentWarning.Type

/**
 * - requirement: what must, should or may be so ("Clients MUST retry at most 3 times").
 * - constraint: a limit with a number and unit ("at most 50 MB per file").
 * - decision: a choice and its reason, from an ADR or prose.
 * - contract: an endpoint, environment variable, CLI line, config key, function, event or error code.
 * - procedure: ordered steps and their commands.
 * - term: a glossary term or acronym and its definition.
 * - entity: a service, table, queue, environment or component the document keeps naming.
 * - fact: a parameter's default or a stated value ("p95 latency is 200 ms").
 * - question: something the document leaves open (TBD, TODO, open questions).
 */
export const RecordKind = Schema.Literals([
  "requirement",
  "constraint",
  "decision",
  "contract",
  "procedure",
  "term",
  "entity",
  "fact",
  "question",
])
export type RecordKind = typeof RecordKind.Type

/** A passage's or record's state, as an entry's: only active ones reach the agent. */
export const ItemStatus = Schema.Literals(["active", "proposed", "quarantined", "archived"])
export type ItemStatus = typeof ItemStatus.Type

/** Who wrote a record: Vector's rules, a model asked to distill (quote-locked), or the user. */
export const RecordOrigin = Schema.Literals(["extracted", "distilled", "user"])
export type RecordOrigin = typeof RecordOrigin.Type

/** What reading a document produced, for its progress and its page. */
export const DocumentStats = Schema.Struct({
  /** Estimated tokens of the extracted text: what sending the document whole would cost. */
  tokens: Schema.Finite,
  /** Pages (or parts, for formats without pages) read so far. */
  read: Schema.Finite,
  sections: Schema.Finite,
  passages: Schema.Finite,
  records: Schema.Finite,
  kinds: Schema.Record(RecordKind, Schema.Finite),
  /** Passages held for the user's review. */
  held: Schema.Finite,
  /** Files of the repository its records and passages are linked to. */
  linked: Schema.Finite,
  /** Passages and records searchable by meaning. */
  embedded: Schema.Finite,
}).annotate({ identifier: "MemoryDocumentStats" })
export type DocumentStats = typeof DocumentStats.Type

export const Document = Schema.Struct({
  id: Schema.String,
  /** The number the user refers to it by ("document 3"), unique within the repository. */
  ordinal: Schema.Finite,
  version: Schema.Finite,
  /** The version this one replaced. */
  previous: Schema.optional(Schema.String),
  /** The file name it arrived with. */
  name: Schema.String,
  title: Schema.String,
  format: Format,
  origin: DocumentOrigin,
  visibility: Visibility,
  status: DocumentStatus,
  hold: Schema.optional(Hold),
  bytes: Schema.Finite,
  pages: Schema.optional(Schema.Finite),
  /** Pages with no text layer (scanned images), which Vector does not read. */
  unread: Schema.Array(Schema.Finite),
  /** The repository file it mirrors, for repository docs and documents added by path. */
  sourcePath: Schema.optional(Schema.String),
  /** Whether a copy of the original file is kept (off unless the user turns it on). */
  stored: Schema.Boolean,
  stats: DocumentStats,
  warnings: Schema.Array(DocumentWarning),
  error: Schema.optional(Schema.String),
  /** The local model its passages and records were embedded with. */
  embedModel: Schema.optional(Schema.String),
  createdAt: Schema.Finite,
  updatedAt: Schema.Finite,
  indexedAt: Schema.optional(Schema.Finite),
  /** The user paused its reading; it goes on when they resume it. */
  paused: Schema.optional(Schema.Boolean),
}).annotate({ identifier: "MemoryDocument" })
export type Document = typeof Document.Type

/** A passage's text as `get` returns it: verbatim and redacted. The header is the document's title and section path. */
export const Passage = Schema.Struct({
  id: Schema.String,
  document: Schema.String,
  section: Schema.String,
  page: Schema.optional(Schema.Finite),
  header: Schema.String,
  text: Schema.String,
  tokens: Schema.Finite,
}).annotate({ identifier: "MemoryPassage" })
export type Passage = typeof Passage.Type

/** A typed record. Its id is stable across versions of its document, so pins, edits and citations survive them. */
export const Record = Schema.Struct({
  id: Schema.String,
  document: Schema.String,
  passage: Schema.String,
  /** The section's path, such as "3 Limits > 3.2 Retries". */
  section: Schema.String,
  kind: RecordKind,
  subject: Schema.String,
  /** The line the agent sees, built from the source sentence with no paraphrase. */
  card: Schema.String,
  /** The exact source span. */
  quote: Schema.String,
  fields: Schema.Record(Schema.String, Schema.Unknown),
  status: ItemStatus,
  hold: Schema.optional(Hold),
  confidence: Schema.Finite,
  origin: RecordOrigin,
  userEdited: Schema.Boolean,
  pinned: Schema.Boolean,
  page: Schema.optional(Schema.Finite),
  /** The document version that last changed this record's text. */
  changedVersion: Schema.optional(Schema.Finite),
  uses: Schema.Finite,
  /** Runs in the last 30 days whose answer cited it or that opened it, and how many of them passed their checks. */
  runs: Schema.optional(Schema.Finite),
  passed: Schema.optional(Schema.Finite),
  createdAt: Schema.Finite,
  updatedAt: Schema.Finite,
}).annotate({ identifier: "MemoryRecord" })
export type Record = typeof Record.Type

/** One line of document knowledge as search and citations show it: a record's card, or a passage's opening. */
export const Card = Schema.Struct({
  id: Schema.String,
  /** document: a whole document, cited by its id. */
  kind: Schema.Literals([...RecordKind.literals, "passage", "document"]),
  document: Schema.String,
  /** The document's title. */
  title: Schema.String,
  page: Schema.optional(Schema.Finite),
  section: Schema.optional(Schema.String),
  text: Schema.String,
}).annotate({ identifier: "MemoryCard" })
export type Card = typeof Card.Type

/** A change to a record: Vector reading a new version of it, or the user's edit or decision. */
export const RecordEvent = Schema.Struct({
  at: Schema.Finite,
  action: Schema.String,
  actor: Schema.Literals(["user", "agent", "vector"]),
  detail: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
}).annotate({ identifier: "MemoryRecordEvent" })
export type RecordEvent = typeof RecordEvent.Type

/** What a version of a document changed from the one before, counted by record kind. */
export const VersionDiff = Schema.Struct({
  version: Schema.Finite,
  /** The version it replaced. */
  previous: Schema.String,
  added: Schema.Record(Schema.String, Schema.Finite),
  changed: Schema.Record(Schema.String, Schema.Finite),
  removed: Schema.Record(Schema.String, Schema.Finite),
  unchanged: Schema.Record(Schema.String, Schema.Finite),
  /** The user's edits and pins the new version kept. */
  edits: Schema.Finite,
  pins: Schema.Finite,
}).annotate({ identifier: "MemoryVersionDiff" })
export type VersionDiff = typeof VersionDiff.Type

/** A step in a document's life, newest first on its History: a record id when the step is about one. */
export const DocumentEvent = Schema.Struct({
  at: Schema.Finite,
  action: Schema.String,
  actor: Schema.Literals(["user", "agent", "vector"]),
  record: Schema.optional(Schema.String),
  detail: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
}).annotate({ identifier: "MemoryDocumentEvent" })
export type DocumentEvent = typeof DocumentEvent.Type

/** How runs used a document in the last 30 days: runs that cited or opened one of its cards, passed, or reverted. */
export const DocumentUsage = Schema.Struct({
  runs: Schema.Finite,
  passed: Schema.Finite,
  reverted: Schema.Finite,
}).annotate({ identifier: "MemoryDocumentUsage" })
export type DocumentUsage = typeof DocumentUsage.Type

/** A link from a record, passage or entry to the code it names. */
export const Anchor = Schema.Struct({
  /** The link's number, which unlinking names. */
  id: Schema.Finite,
  owner: Schema.String,
  path: Schema.String,
  symbol: Schema.optional(Schema.String),
  line: Schema.optional(Schema.Finite),
  /**
   * - definition, use: the code defines or uses a name the document gives; route, env: registers its endpoint or reads
   *   its environment variable; constant: defines a value the document states; path: is a file it names.
   * - user: the user linked it; outcome: a run that cited the record changed this file and passed.
   */
  method: Schema.Literals(["path", "definition", "use", "route", "env", "constant", "user", "outcome"]),
  weight: Schema.Finite,
  /** A constant's value as the code gives it, in the unit its name or comment gives. */
  value: Schema.optional(
    Schema.Struct({ raw: Schema.String, value: Schema.Finite, unit: Schema.optional(Schema.String) }),
  ),
  /** fresh: the linked line is unchanged (or only moved); drifted: it reads differently now; missing: it is gone. */
  status: Schema.Literals(["fresh", "drifted", "missing"]),
  origin: Schema.Literals(["extracted", "user", "outcome"]),
  checkedAt: Schema.Finite,
}).annotate({ identifier: "MemoryAnchor" })
export type Anchor = typeof Anchor.Type

/** Something Vector holds that a file is linked to: a document's record or passage, or a memory entry. */
export const Link = Schema.Struct({
  owner: Schema.String,
  type: Schema.Literals(["record", "passage", "entry"]),
  /** A record's kind, "passage", or an entry's kind. */
  kind: Schema.String,
  /** The document's title, or "Memory" for an entry. */
  title: Schema.String,
  document: Schema.optional(Schema.String),
  text: Schema.String,
  /** The link itself; an entry covering the file by its paths has none. */
  anchor: Schema.optional(Anchor),
}).annotate({ identifier: "MemoryLink" })
export type Link = typeof Link.Type

/**
 * - conflict: two records, or a record and an entry or rule, disagree. Never resolved automatically.
 * - drift: linked code changed, or gives a different value than the document.
 * - held: content that waits for the user.
 */
export const ReviewKind = Schema.Literals(["conflict", "drift", "held"])
export type ReviewKind = typeof ReviewKind.Type

export const ReviewStatus = Schema.Literals(["open", "dismissed", "resolved"])
export type ReviewStatus = typeof ReviewStatus.Type

/** Something in the brain that needs the user's look ("Needs a look" in Settings). */
export const ReviewItem = Schema.Struct({
  id: Schema.String,
  kind: ReviewKind,
  /** The record, passage, entry or document the item is about, and the other side of a conflict. */
  a: Schema.String,
  b: Schema.optional(Schema.String),
  subject: Schema.String,
  detail: Schema.Record(Schema.String, Schema.Unknown),
  status: ReviewStatus,
  /** Which side the user kept, for a resolved conflict. */
  winner: Schema.optional(Schema.String),
  createdAt: Schema.Finite,
  updatedAt: Schema.Finite,
}).annotate({ identifier: "MemoryReviewItem" })
export type ReviewItem = typeof ReviewItem.Type

/** The local search model is downloaded only when the user asks; until it is ready, search uses keywords and code links. */
export const ModelState = Schema.Literals(["absent", "downloading", "verifying", "ready", "failed"])
export type ModelState = typeof ModelState.Type

/** Which graph of a model: int8, or the full-precision one offered when int8 fails its check on this computer. */
export const ModelVariant = Schema.Literals(["int8", "fp32"])
export type ModelVariant = typeof ModelVariant.Type

/** A model Vector can download, as Settings and the CLI describe it before asking. */
export const ModelOption = Schema.Struct({
  id: Schema.String,
  label: Schema.String,
  description: Schema.String,
  license: Schema.String,
  /** Who made it. */
  owner: Schema.String,
  /** The model's page at the revision its files are pinned to. */
  source: Schema.String,
  revision: Schema.String,
  /** Bytes the int8 download takes. */
  bytes: Schema.Finite,
  /** Bytes the full-precision graph takes, for a model that has one. */
  fallback: Schema.optional(Schema.Finite),
  /** sha256 of its int8 graph. */
  sha256: Schema.String,
  /** Set for a model offered only on request, saying what is not yet checked. */
  preview: Schema.optional(Schema.String),
  installed: Schema.Boolean,
}).annotate({ identifier: "MemoryModelOption" })
export type ModelOption = typeof ModelOption.Type

export const ModelStatus = Schema.Struct({
  state: ModelState,
  /** The model's id in Vector's manifest. */
  model: Schema.optional(Schema.String),
  variant: Schema.optional(ModelVariant),
  /** From 0 to 1 while downloading or verifying. */
  progress: Schema.optional(Schema.Finite),
  /** Bytes received, or on disk once ready. */
  bytes: Schema.optional(Schema.Finite),
  /** Bytes the manifest expects. */
  total: Schema.optional(Schema.Finite),
  error: Schema.optional(Schema.String),
  /** Embedding in the background is held until the user resumes it. */
  paused: Schema.optional(Schema.Boolean),
  /** The int8 graph failed its check here, so the full-precision one is offered. */
  fallback: Schema.optional(Schema.Boolean),
  /** False where downloads are turned off (VECTOR_BRAIN_EMBED=off); installing from a folder still works. */
  downloads: Schema.optional(Schema.Boolean),
  /** Where its files came from. */
  source: Schema.optional(Schema.Literals(["mirror", "huggingface", "folder"])),
  /** The last load's check: its lowest canary cosine against the least it needed, or a check by ranking. */
  check: Schema.optional(
    Schema.Struct({ lowest: Schema.Finite, needed: Schema.Finite, by: Schema.Literals(["vectors", "ranking"]) }),
  ),
  /** Every model Vector can download. */
  options: Schema.optional(Schema.Array(ModelOption)),
  /** Passages and records of this repository's documents embedded with the model in use, of all it could embed. */
  embedded: Schema.optional(Schema.Struct({ done: Schema.Finite, total: Schema.Finite })),
  /** Where the model runs: the background reader, or nowhere when documents are read on the main thread. */
  worker: Schema.optional(
    Schema.Struct({ mode: Schema.Literals(["worker", "in-process"]), reason: Schema.optional(Schema.String) }),
  ),
}).annotate({ identifier: "MemoryModelStatus" })
export type ModelStatus = typeof ModelStatus.Type
