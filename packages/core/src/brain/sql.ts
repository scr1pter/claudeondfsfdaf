import { sql } from "drizzle-orm"
import { blob, index, integer, primaryKey, real, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core"
import type { Research } from "@vectordevai/schema/research"
import type { RunBudget } from "@vectordevai/schema/run-budget"
import type { CostKind } from "../review/types"
import type { TaskSize } from "../task-size"
import type { BrainCode } from "./code"
import type { BrainSchema } from "./schema"
import type { BrainWorkflow } from "./workflow"
import type { ReviewMemory } from "./review-memory"

// brain.db, a SQLite file of its own beside vector.db: erasing all memory deletes one folder, session repair, export
// and sharing never touch it, and secure_delete costs the session database nothing. `repository_id` is "" for the
// personal scope, so every lookup is a plain equality.

export const BrainEntryTable = sqliteTable(
  "brain_entry",
  {
    id: text().primaryKey(),
    scope: text().$type<BrainSchema.Scope>().notNull(),
    repository_id: text().notNull(),
    kind: text().$type<BrainSchema.Kind>().notNull(),
    origin: text().$type<BrainSchema.Origin>().notNull(),
    status: text().$type<BrainSchema.Status>().notNull(),
    pinned: integer({ mode: "boolean" }).notNull().default(false),
    body: text().notNull(),
    paths: text({ mode: "json" }).$type<string[]>().notNull(),
    terms: text().notNull(),
    norm_hash: text().notNull(),
    confidence: real().notNull(),
    uses: integer().notNull().default(0),
    // Proven knowledge: runs that cited the entry and passed. The counts decay, so SQLite keeps fractions of them as
    // REAL values in these integer columns. An entry gets `harmful` only from the user.
    helpful: integer().notNull().default(0),
    harmful: integer().notNull().default(0),
    last_used_at: integer(),
    created_at: integer().notNull(),
    updated_at: integer().notNull(),
    superseded_by: text(),
    stale: integer({ mode: "boolean" }).notNull().default(false),
    hold_reason: text().$type<BrainSchema.Hold>(),
    related: text({ mode: "json" }).$type<string[]>().notNull(),
    // Already in the cached prefix (an unscoped rule, MEMORY.md within its budget), so never recalled again.
    tier0: integer({ mode: "boolean" }).notNull().default(false),
    // Mirrors of a file: the file, the item's line, and its position so the digest keeps the file's order.
    source_file: text(),
    source_line: integer(),
    origin_session_id: text(),
    signature: text(),
    // Learned after reading a private document, so withheld where that document is: from guests and models that may
    // train on prompts.
    private: integer({ mode: "boolean" }).notNull().default(false),
    // What a preference or a term is about (migration 20261202000000_facets).
    facet: text().$type<BrainSchema.Facet>(),
    // A term's word or phrase, lowercased with its punctuation as spaces, which recall looks for in a request's words.
    term_key: text(),
  },
  (table) => [
    index("brain_entry_repository_status_idx").on(table.repository_id, table.status),
    index("brain_entry_source_idx").on(table.source_file),
    index("brain_entry_hash_idx").on(table.repository_id, table.norm_hash),
  ],
)

export const BrainEvidenceTable = sqliteTable(
  "brain_evidence",
  {
    id: integer().primaryKey({ autoIncrement: true }),
    entry_id: text()
      .notNull()
      .references(() => BrainEntryTable.id, { onDelete: "cascade" }),
    type: text().$type<BrainSchema.Evidence["type"]>().notNull(),
    path: text(),
    quote: text(),
    // The cited file's content hash when the evidence was checked; a different hash later makes the entry stale.
    file_hash: text(),
    command: text(),
    session_id: text(),
    created_at: integer().notNull(),
  },
  (table) => [index("brain_evidence_entry_idx").on(table.entry_id)],
)

// What happened to an entry, newest last: the "recently learned" list, and the prior text an undo restores.
export const BrainEventTable = sqliteTable(
  "brain_event",
  {
    id: integer().primaryKey({ autoIncrement: true }),
    entry_id: text().notNull(),
    repository_id: text().notNull(),
    at: integer().notNull(),
    action: text().notNull(),
    actor: text().$type<"user" | "agent" | "vector">().notNull(),
    detail: text({ mode: "json" }).$type<Record<string, unknown>>(),
  },
  (table) => [
    index("brain_event_repository_idx").on(table.repository_id, table.at),
    // A request's credit marker, once per repository (migration 20261121000000_credited_once).
    uniqueIndex("brain_event_credited_idx")
      .on(table.repository_id, table.entry_id)
      .where(sql`${table.action} = 'credited'`),
  ],
)

// A forgotten entry leaves only the hash of its normalised text, so Vector does not learn it again. No text is kept.
export const BrainTombstoneTable = sqliteTable(
  "brain_tombstone",
  {
    repository_id: text().notNull(),
    norm_hash: text().notNull(),
    until: integer().notNull(),
    // An entry's terms and their way round (BrainLexical.polarity), so a close rewording is refused too.
    terms: text(),
    polarity: text(),
  },
  (table) => [primaryKey({ columns: [table.repository_id, table.norm_hash] })],
)

// The files the brain mirrors and the content it last read from each, so an unchanged file is never parsed again.
export const BrainSourceTable = sqliteTable("brain_source", {
  path: text().primaryKey(),
  repository_id: text().notNull(),
  content_hash: text().notNull(),
  size: integer().notNull(),
  mtime: integer().notNull(),
  held: integer({ mode: "boolean" }).notNull().default(false),
  // Rules and MEMORY.md as the agent reads them in the cached prefix, rendered once when the file changes.
  digest: text(),
  synced_at: integer().notNull(),
})

// One row per repository and one for the personal scope (""). `revision` changes on every write, so an engine process
// can tell from one row whether what it cached is still current.
// Review memory has its own tables: no current or older generic memory query can recall these as personal habits.
export const BrainReviewMemoryTable = sqliteTable(
  "brain_review_memory",
  {
    id: text().primaryKey(),
    repository_id: text().notNull(),
    // NULL is legacy, physically unbound data. It is never adopted by a newly opened clone.
    scope_id: text(),
    kind: text().$type<ReviewMemory.Kind>().notNull(),
    status: text().$type<"proposed" | "active">().notNull(),
    visibility: text().$type<"private" | "repository">().notNull(),
    body: text().notNull(),
    paths: text({ mode: "json" }).$type<string[]>().notNull(),
    citations: text({ mode: "json" }).$type<ReviewMemory.Citation[]>().notNull(),
    reason: text().notNull(),
    parent_session_id: text(),
    review_session_id: text(),
    source_head: text(),
    origin: text().$type<"owner" | "review">().notNull(),
    approved_by: text(),
    approved_at: integer(),
    created_at: integer().notNull(),
    updated_at: integer().notNull(),
  },
  (table) => [
    index("brain_review_memory_repository_idx").on(table.repository_id, table.status),
    index("brain_review_memory_parent_idx").on(table.repository_id, table.parent_session_id),
    index("brain_review_memory_session_idx").on(table.repository_id, table.review_session_id),
    index("brain_review_memory_scope_idx").on(table.repository_id, table.scope_id, table.status),
  ],
)

// Immutable source identities only. Text remains in brain_review_memory, and
// old session-memory erasers invalidate these sources by removing their two
// reserved generic metadata witnesses.
export const BrainReviewMemorySourceTable = sqliteTable(
  "brain_review_memory_source",
  {
    repository_id: text().notNull(),
    scope_id: text().notNull(),
    review_session_id: text().notNull(),
    parent_session_id: text().notNull(),
    source_head: text().notNull(),
    parent_marker_id: text().notNull(),
    review_marker_id: text().notNull(),
    state: text().$type<"active" | "retired">().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.repository_id, table.scope_id, table.review_session_id] }),
    uniqueIndex("brain_review_memory_source_parent_marker_idx").on(table.parent_marker_id),
    uniqueIndex("brain_review_memory_source_review_marker_idx").on(table.review_marker_id),
    index("brain_review_memory_source_parent_idx").on(table.repository_id, table.parent_session_id),
    index("brain_review_memory_source_review_idx").on(table.repository_id, table.review_session_id),
  ],
)

// Content-free generations survive erasure and are never reset; absence means disabled, never implicit consent.
export const BrainReviewMemoryStateTable = sqliteTable("brain_review_memory_state", {
  repository_id: text().primaryKey(),
  enabled: integer({ mode: "boolean" }).notNull().default(false),
  generation: integer().notNull().default(0),
})

// Physical namespaces share a real ProjectID's erase epoch, but never its consent or enabled state.
export const BrainReviewMemoryScopeStateTable = sqliteTable(
  "brain_review_memory_scope_state",
  {
    repository_id: text().notNull(),
    scope_id: text().notNull(),
    enabled: integer({ mode: "boolean" }).notNull().default(false),
    generation: integer().notNull().default(0),
  },
  (table) => [primaryKey({ columns: [table.repository_id, table.scope_id] })],
)

export const BrainStateTable = sqliteTable("brain_state", {
  repository_id: text().primaryKey(),
  revision: integer().notNull().default(0),
  // Explicit withdrawals and corrections only. Never reset by event retention or erasing a scope's content.
  revocation_revision: integer().notNull().default(0),
  learning: integer({ mode: "boolean" }).notNull().default(true),
  consolidated_at: integer(),
  // Documents keep a revision of their own, so a memory write never invalidates what is cached about documents.
  knowledge_revision: integer().notNull().default(0),
  // BM25's N and total length over the repository's passages and records, kept here so a search reads no other row.
  items: integer().notNull().default(0),
  item_length_sum: integer().notNull().default(0),
  // Whether the repository's tracked docs are read, and whether originals of added documents are kept.
  repository_docs: integer({ mode: "boolean" }).notNull().default(true),
  keep_originals: integer({ mode: "boolean" }).notNull().default(false),
  scanned_at: integer(),
  // When document credit last decayed, so the next pass decays it by the time since.
  credited_at: integer(),
  // The code index keeps a revision of its own, so a change of code rebuilds the code graph and nothing else, and the
  // commit history was last read at, so co-change is read again only after a commit.
  code_revision: integer().notNull().default(0),
  code_head: text(),
  // The personal row only: the facets Vector may learn (all of them when unset), and when the model learner runs.
  learn_facets: text({ mode: "json" }).$type<Partial<Record<BrainSchema.Facet, boolean>>>(),
  model_learner: text().$type<"local-only" | "always" | "off">(),
  // The personal row only, all unset until the owner chooses (migrations 20261210000000_learned_skills and
  // 20261211000000_workflow): skills wait for review, the skill drafter runs only with Vector Local on, learned workflow
  // defaults apply, and exploration is off.
  skill_learning: text().$type<BrainSchema.SkillLearning>(),
  skill_drafter: text().$type<BrainSchema.SkillDrafter>(),
  codium_helpers: text().$type<BrainSchema.CodiumHelpers>(),
  knowledge_distill: integer({ mode: "boolean" }),
  workflow_learning: text().$type<BrainSchema.WorkflowLearning>(),
  workflow_explore: integer({ mode: "boolean" }),
})

// Which entries reached which session, and through which tier. Pruned after 30 days.
export const BrainUseTable = sqliteTable(
  "brain_use",
  {
    id: integer().primaryKey({ autoIncrement: true }),
    session_id: text().notNull(),
    entry_id: text().notNull(),
    tier: text()
      .$type<"digest" | "recall" | "attach" | "search" | "pointer" | "guard" | "get" | "brief" | "review">()
      .notNull(),
    tokens: integer().notNull(),
    at: integer().notNull(),
    // The request message it reached, whether the answer cited it, and how that run ended, for outcome credit.
    request_id: text(),
    cited: integer({ mode: "boolean" }).notNull().default(false),
    outcome: text().$type<"pass" | "revert">(),
  },
  (table) => [index("brain_use_session_idx").on(table.session_id)],
)

// Learned skills (migration 20261210000000_learned_skills). A skill is a brain_entry of kind "skill" under the repository
// id "skill:<repository>", which no memory query of this or an older build reads; these tables hold what the entry does
// not: its procedure, the commands it names, its versions, its loads and the listing each session chose. `repository_id`
// here is the real repository's.

export const BrainSkillTable = sqliteTable(
  "brain_skill",
  {
    entry_id: text()
      .primaryKey()
      .references(() => BrainEntryTable.id, { onDelete: "cascade" }),
    repository_id: text().notNull(),
    skill_key: text().notNull(),
    name: text().notNull(),
    description: text().notNull(),
    procedure: text().notNull(),
    checks: text({ mode: "json" }).$type<string[]>().notNull(),
    commands: text({ mode: "json" }).$type<string[]>().notNull(),
    // The failing output's redacted tail. Never shared, and never part of the procedure.
    failure: text(),
    version: integer().notNull(),
    drafter: text().$type<"rules" | "model" | "user" | "import">().notNull(),
    session_id: text(),
    request_id: text(),
    approved_by: text().$type<"user" | "vector">(),
    approved_at: integer(),
    shared_path: text(),
    shared_at: integer(),
    // 1 exactly when the entry is active, written in the same transaction as its status, so a unique index keeps one
    // live entry per key.
    live: integer({ mode: "boolean" }).notNull().default(false),
    // Lifetime counters: brain_use keeps 30 days.
    loads: integer().notNull().default(0),
    passes: integer().notNull().default(0),
    fails: integer().notNull().default(0),
    reverts: integer().notNull().default(0),
    ignored: integer().notNull().default(0),
  },
  (table) => [
    index("brain_skill_key_idx").on(table.repository_id, table.skill_key),
    uniqueIndex("brain_skill_live_idx")
      .on(table.repository_id, table.skill_key)
      .where(sql`${table.live} = 1`),
  ],
)

// Every text a skill had. No foreign key: each path that deletes an entry deletes its versions too.
export const BrainSkillVersionTable = sqliteTable(
  "brain_skill_version",
  {
    id: integer().primaryKey({ autoIncrement: true }),
    repository_id: text().notNull(),
    skill_key: text().notNull(),
    version: integer().notNull(),
    entry_id: text().notNull(),
    // The session whose run produced this text; none for the owner's edits, imports and rollbacks.
    session_id: text(),
    name: text().notNull(),
    description: text().notNull(),
    procedure: text().notNull(),
    checks: text({ mode: "json" }).$type<string[]>().notNull(),
    commands: text({ mode: "json" }).$type<string[]>().notNull(),
    failure: text(),
    actor: text().$type<"agent" | "user" | "vector" | "import">().notNull(),
    reason: text().$type<"learned" | "edited" | "imported" | "rollback">().notNull(),
    created_at: integer().notNull(),
  },
  (table) => [
    uniqueIndex("brain_skill_version_key_idx").on(table.repository_id, table.skill_key, table.version),
    index("brain_skill_version_session_idx").on(table.session_id),
  ],
)

// A load of a skill, credited once per request when the run ends.
export const BrainSkillUseTable = sqliteTable(
  "brain_skill_use",
  {
    id: integer().primaryKey({ autoIncrement: true }),
    repository_id: text().notNull(),
    entry_id: text().notNull(),
    version: integer().notNull(),
    session_id: text().notNull(),
    request_id: text().notNull(),
    at: integer().notNull(),
    outcome: text().$type<"pass" | "fail" | "ignored" | "revert">(),
  },
  (table) => [
    uniqueIndex("brain_skill_use_request_idx").on(table.request_id, table.entry_id),
    index("brain_skill_use_session_idx").on(table.session_id),
  ],
)

// The skills a session was offered, chosen once so the system prompt stays the same for the provider's cache, across
// restarts too.
export const BrainSkillListingTable = sqliteTable(
  "brain_skill_listing",
  {
    session_id: text().notNull(),
    position: integer().notNull(),
    repository_id: text().notNull(),
    entry_id: text().notNull(),
    version: integer().notNull(),
    name: text().notNull(),
    description: text().notNull(),
    private: integer({ mode: "boolean" }).notNull(),
    created_at: integer().notNull(),
  },
  (table) => [primaryKey({ columns: [table.session_id, table.position] })],
)

// Workflow insights (migration 20261211000000_workflow): one row per request of the build agent, numbers only, which
// BrainWorkflow turns into cheaper defaults.
export const BrainWorkflowRunTable = sqliteTable(
  "brain_workflow_run",
  {
    id: integer().primaryKey({ autoIncrement: true }),
    repository_id: text().notNull(),
    session_id: text().notNull(),
    request_id: text().notNull(),
    at: integer().notNull(),
    tier: text().$type<TaskSize.Tier>().notNull(),
    // The tier that set effort: the offered tier on a provider that caches, else the request's.
    effort_tier: text().$type<TaskSize.Tier>().notNull(),
    agent: text().$type<"build">().notNull(),
    provider_id: text().notNull(),
    model_id: text().notNull(),
    effort: text().notNull(),
    effort_source: text().$type<BrainWorkflow.EffortSource>().notNull(),
    subagents: integer().notNull(),
    subagent_model: text().$type<"parent" | "small" | "mixed">(),
    subagent_models: text({ mode: "json" }).$type<Record<string, number>>().notNull(),
    judge_rounds: integer().notNull(),
    outcome: text().$type<BrainWorkflow.Outcome>().notNull(),
    signal: text().$type<"recovered" | "judged" | "judge-fail" | "check-fail">(),
    // Unknown unless every step of the run was priced; unknown is never zero.
    cost_usd: real(),
    // Relative catalog-weighted usage, only when every recorded step ran on Codium with a known weight.
    codium_units: real(),
    cost_kinds: text({ mode: "json" }).$type<Partial<Record<CostKind, number>>>().notNull(),
    steps: integer().notNull(),
    unpriced_steps: integer().notNull(),
    // The root session's and every child session's of the run.
    tokens_input: integer().notNull(),
    tokens_output: integer().notNull(),
    tokens_reasoning: integer().notNull(),
    tokens_cache_read: integer().notNull(),
    // Background subagents were still running when it was recorded, so its cost is never used.
    partial: integer({ mode: "boolean" }).notNull().default(false),
    runs: integer().notNull().default(1),
    stop: text().$type<RunBudget.StopReason>(),
    taint: text().$type<BrainSchema.Hold>(),
    advice: text({ mode: "json" }).$type<BrainWorkflow.Advice>(),
  },
  (table) => [
    uniqueIndex("brain_workflow_run_request_idx").on(table.repository_id, table.request_id),
    index("brain_workflow_run_tier_idx").on(table.repository_id, table.effort_tier, table.at),
    index("brain_workflow_run_session_idx").on(table.session_id),
  ],
)

// Documents, and everything Vector reads from them. Created empty by the knowledge migration. A passage or a record is
// one `brain_item`, which carries what a search filters on (visibility, status, BM25 length, outcome counters), so the
// postings query never touches a content table. Sections, passages, records, postings and vectors go with their document
// through foreign keys; the rest is keyed by repository, as entries are.

export const BrainDocumentTable = sqliteTable(
  "brain_document",
  {
    id: text().primaryKey(),
    repository_id: text().notNull(),
    // Stable across versions of the same document: its source path, or its normalised name.
    lineage: text().notNull(),
    version: integer().notNull().default(1),
    previous_id: text(),
    ordinal: integer().notNull(),
    name: text().notNull(),
    title: text().notNull(),
    format: text().$type<BrainSchema.Format>().notNull(),
    origin: text().$type<BrainSchema.DocumentOrigin>().notNull(),
    visibility: text().$type<BrainSchema.Visibility>().notNull(),
    content_hash: text().notNull(),
    bytes: integer().notNull(),
    pages: integer(),
    unread: text({ mode: "json" }).$type<number[]>().notNull(),
    source_path: text(),
    stored: integer({ mode: "boolean" }).notNull().default(false),
    status: text().$type<BrainSchema.DocumentStatus>().notNull(),
    hold_reason: text().$type<BrainSchema.Hold>(),
    stats: text({ mode: "json" }).$type<BrainSchema.DocumentStats>().notNull(),
    warnings: text({ mode: "json" }).$type<BrainSchema.DocumentWarning[]>().notNull(),
    error: text(),
    // The reader's version, so a better reader can re-read what an older one read.
    extractor: integer().notNull(),
    embed_model: text(),
    origin_session_id: text(),
    created_at: integer().notNull(),
    updated_at: integer().notNull(),
    indexed_at: integer(),
    // A page Deep research read (origin web) or a run's report (origin research): the address it was read from, when,
    // and the run it belongs to (migration 20261201000000_research).
    source_url: text(),
    fetched_at: integer(),
    run_id: text(),
  },
  (table) => [
    index("brain_document_repository_idx").on(table.repository_id, table.status),
    index("brain_document_hash_idx").on(table.repository_id, table.content_hash),
    index("brain_document_lineage_idx").on(table.repository_id, table.lineage),
    uniqueIndex("brain_document_ordinal_idx").on(table.repository_id, table.ordinal),
    index("brain_document_run_idx").on(table.run_id),
  ],
)

export const BrainSectionTable = sqliteTable(
  "brain_section",
  {
    id: text().primaryKey(),
    document_id: text()
      .notNull()
      .references(() => BrainDocumentTable.id, { onDelete: "cascade" }),
    parent_id: text(),
    ordinal: integer().notNull(),
    level: integer().notNull(),
    heading: text().notNull(),
    path: text().notNull(),
    kind: text().$type<"section" | "slide" | "sheet">().notNull(),
    page_start: integer(),
    page_end: integer(),
    tokens: integer().notNull(),
  },
  (table) => [index("brain_section_document_idx").on(table.document_id, table.ordinal)],
)

export const BrainItemTable = sqliteTable(
  "brain_item",
  {
    id: integer().primaryKey({ autoIncrement: true }),
    repository_id: text().notNull(),
    type: text().$type<"passage" | "record">().notNull(),
    // The passage's or record's id.
    ref: text().notNull().unique(),
    document_id: text()
      .notNull()
      .references(() => BrainDocumentTable.id, { onDelete: "cascade" }),
    visibility: text().$type<BrainSchema.Visibility>().notNull(),
    status: text().$type<BrainSchema.ItemStatus>().notNull(),
    hold_reason: text().$type<BrainSchema.Hold>(),
    // Terms indexed for it, BM25's document length.
    length: integer().notNull(),
    confidence: real().notNull(),
    uses: integer().notNull().default(0),
    // Outcome counts, which decay, so they are not whole numbers.
    helpful: real().notNull().default(0),
    harmful: real().notNull().default(0),
    ignored: integer().notNull().default(0),
    last_used_at: integer(),
    last_helpful_at: integer(),
  },
  (table) => [index("brain_item_repository_idx").on(table.repository_id, table.status, table.visibility)],
)

export const BrainPassageTable = sqliteTable(
  "brain_passage",
  {
    // Content-addressed within the document's lineage, so unchanged text keeps its id across versions.
    id: text().primaryKey(),
    item: integer()
      .notNull()
      .unique()
      .references(() => BrainItemTable.id, { onDelete: "cascade" }),
    document_id: text()
      .notNull()
      .references(() => BrainDocumentTable.id, { onDelete: "cascade" }),
    section_id: text().notNull(),
    ordinal: integer().notNull(),
    page: integer(),
    header: text().notNull(),
    body: text().notNull(),
    tokens: integer().notNull(),
    // Offsets into the document's extracted text.
    span_start: integer().notNull(),
    span_end: integer().notNull(),
    norm_hash: text().notNull(),
  },
  (table) => [index("brain_passage_document_idx").on(table.document_id, table.ordinal)],
)

export const BrainRecordTable = sqliteTable(
  "brain_record",
  {
    // From the repository, lineage, kind and subject, so it is stable across versions and reordering.
    id: text().primaryKey(),
    item: integer()
      .notNull()
      .unique()
      .references(() => BrainItemTable.id, { onDelete: "cascade" }),
    document_id: text()
      .notNull()
      .references(() => BrainDocumentTable.id, { onDelete: "cascade" }),
    passage_id: text().notNull(),
    section_id: text().notNull(),
    kind: text().$type<BrainSchema.RecordKind>().notNull(),
    key: text().notNull(),
    subject: text().notNull(),
    card: text().notNull(),
    quote: text().notNull(),
    quote_hash: text().notNull(),
    fields: text({ mode: "json" }).$type<Record<string, unknown>>().notNull(),
    polarity: text().notNull(),
    // The extraction rule that found it.
    rule: text().notNull(),
    origin: text().$type<BrainSchema.RecordOrigin>().notNull(),
    user_edited: integer({ mode: "boolean" }).notNull().default(false),
    pinned: integer({ mode: "boolean" }).notNull().default(false),
    changed_version: integer(),
    page: integer(),
    span_start: integer().notNull(),
    span_end: integer().notNull(),
    norm_hash: text().notNull(),
    created_at: integer().notNull(),
    updated_at: integer().notNull(),
  },
  (table) => [
    index("brain_record_document_idx").on(table.document_id),
    index("brain_record_subject_idx").on(table.subject),
    index("brain_record_hash_idx").on(table.norm_hash),
  ],
)

// The keyword index: one integer id per term and repository, with its document frequency.
export const BrainTermTable = sqliteTable(
  "brain_term",
  {
    id: integer().primaryKey({ autoIncrement: true }),
    repository_id: text().notNull(),
    term: text().notNull(),
    df: integer().notNull().default(0),
  },
  (table) => [uniqueIndex("brain_term_repository_idx").on(table.repository_id, table.term)],
)

// Created WITHOUT ROWID by the migration (drizzle has no option for it), so a posting is its key and count, about 18
// bytes, and a query reads only the rows of its own terms.
export const BrainPostingTable = sqliteTable(
  "brain_posting",
  {
    term: integer().notNull(),
    item: integer()
      .notNull()
      .references(() => BrainItemTable.id, { onDelete: "cascade" }),
    count: integer().notNull(),
  },
  (table) => [primaryKey({ columns: [table.term, table.item] }), index("brain_posting_item_idx").on(table.item)],
)

// A link from a record, passage or entry (`owner`) to the code it names.
export const BrainAnchorTable = sqliteTable(
  "brain_anchor",
  {
    id: integer().primaryKey({ autoIncrement: true }),
    repository_id: text().notNull(),
    owner: text().notNull(),
    path: text().notNull(),
    symbol: text(),
    line: integer(),
    method: text().$type<"path" | "definition" | "use" | "route" | "env" | "constant" | "user" | "outcome">().notNull(),
    weight: real().notNull(),
    // A constant's value as the code gives it, for drift checks with values.
    value: text({ mode: "json" }).$type<{ raw: string; value: number; unit?: string }>(),
    file_hash: text().notNull(),
    line_hash: text(),
    status: text().$type<"fresh" | "drifted" | "missing">().notNull(),
    origin: text().$type<"extracted" | "user" | "outcome">().notNull(),
    checked_at: integer().notNull(),
    created_at: integer().notNull(),
  },
  (table) => [
    index("brain_anchor_path_idx").on(table.repository_id, table.path),
    index("brain_anchor_owner_idx").on(table.owner),
  ],
)

// Identifiers a document names that the code does not have yet; they link themselves when the code lands.
export const BrainPendingTable = sqliteTable(
  "brain_pending",
  {
    repository_id: text().notNull(),
    owner: text().notNull(),
    identifier: text().notNull(),
    kind: text().$type<"symbol" | "path" | "route" | "env">().notNull(),
    created_at: integer().notNull(),
  },
  (table) => [primaryKey({ columns: [table.repository_id, table.owner, table.identifier] })],
)

export const BrainEdgeTable = sqliteTable(
  "brain_edge",
  {
    repository_id: text().notNull(),
    source: text().notNull(),
    target: text().notNull(),
    type: text()
      .$type<"derived_from" | "related" | "same_as" | "conflicts" | "defines" | "imports" | "co_changes">()
      .notNull(),
    weight: real().notNull(),
    created_at: integer().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.source, table.type, table.target] }),
    index("brain_edge_target_idx").on(table.repository_id, table.target),
  ],
)

// A passage's or record's embedding from the local model: int8 values with their scale, and sign bits for a prefilter.
export const BrainVectorTable = sqliteTable(
  "brain_vector",
  {
    item: integer()
      .primaryKey()
      .references(() => BrainItemTable.id, { onDelete: "cascade" }),
    repository_id: text().notNull(),
    model: text().notNull(),
    q8: blob({ mode: "buffer" }).notNull(),
    bits: blob({ mode: "buffer" }).notNull(),
    scale: real().notNull(),
    norm_hash: text().notNull(),
    embedded_at: integer().notNull(),
  },
  (table) => [index("brain_vector_repository_idx").on(table.repository_id, table.model)],
)

// Work on documents, claimed with a lease so an engine and a CLI process sharing brain.db never do the same work twice.
export const BrainJobTable = sqliteTable(
  "brain_job",
  {
    id: text().primaryKey(),
    repository_id: text().notNull(),
    document_id: text().references(() => BrainDocumentTable.id, { onDelete: "cascade" }),
    kind: text().$type<"extract" | "link" | "embed" | "scan" | "drift" | "distill">().notNull(),
    state: text().$type<"queued" | "running" | "paused" | "done" | "failed">().notNull(),
    lease_owner: text(),
    lease_until: integer(),
    attempts: integer().notNull().default(0),
    next_at: integer().notNull(),
    done: integer().notNull().default(0),
    total: integer().notNull().default(0),
    error: text(),
    created_at: integer().notNull(),
    updated_at: integer().notNull(),
  },
  (table) => [index("brain_job_state_idx").on(table.state, table.next_at)],
)

export const BrainReviewTable = sqliteTable(
  "brain_review",
  {
    id: text().primaryKey(),
    repository_id: text().notNull(),
    kind: text().$type<BrainSchema.ReviewKind>().notNull(),
    a: text().notNull(),
    b: text(),
    subject: text().notNull(),
    detail: text({ mode: "json" }).$type<Record<string, unknown>>().notNull(),
    status: text().$type<BrainSchema.ReviewStatus>().notNull(),
    winner: text(),
    created_at: integer().notNull(),
    updated_at: integer().notNull(),
  },
  (table) => [index("brain_review_repository_idx").on(table.repository_id, table.status)],
)

// The repository's code as Vector last read it, for the code graph and for finding what a document names. Each file
// keeps its size, time and hash, so an unchanged file is never read again; what it imports as written, which files
// those are (resolved again when files come and go), and the files history changed with it.
export const BrainCodeFileTable = sqliteTable(
  "brain_code_file",
  {
    repository_id: text().notNull(),
    path: text().notNull(),
    content_hash: text().notNull(),
    bytes: integer().notNull(),
    mtime: integer().notNull(),
    language: text().$type<BrainCode.Language>().notNull(),
    imports: text({ mode: "json" }).$type<string[]>().notNull(),
    dependencies: text({ mode: "json" }).$type<string[]>().notNull(),
    co_change: text({ mode: "json" }).$type<Record<string, number>>().notNull(),
    synced_at: integer().notNull(),
  },
  (table) => [primaryKey({ columns: [table.repository_id, table.path] })],
)

// What each file declares. `signature_hash` is the hash of the declaring line, so a changed signature is a different
// row without the file being read again.
export const BrainCodeSymbolTable = sqliteTable(
  "brain_code_symbol",
  {
    id: integer().primaryKey({ autoIncrement: true }),
    repository_id: text().notNull(),
    path: text().notNull(),
    name: text().notNull(),
    kind: text().$type<BrainCode.SymbolKind>().notNull(),
    line: integer().notNull(),
    exported: integer({ mode: "boolean" }).notNull(),
    signature_hash: text().notNull(),
  },
  (table) => [
    index("brain_code_symbol_name_idx").on(table.repository_id, table.name),
    index("brain_code_symbol_path_idx").on(table.repository_id, table.path),
  ],
)

// Routes each file registers, environment variables it reads and constants it gives a value: looked up by value, so
// a document naming POST /v1/invoices or SMTP_HOST is linked without searching the working tree.
export const BrainCodeLiteralTable = sqliteTable(
  "brain_code_literal",
  {
    id: integer().primaryKey({ autoIncrement: true }),
    repository_id: text().notNull(),
    path: text().notNull(),
    kind: text().$type<BrainCode.Literal["kind"]>().notNull(),
    value: text().notNull(),
    method: text(),
    line: integer().notNull(),
  },
  (table) => [
    index("brain_code_literal_value_idx").on(table.repository_id, table.value),
    index("brain_code_literal_path_idx").on(table.repository_id, table.path),
  ],
)

// Deep research, one brain per repository (migration 20261201000000_research). A run holds what it planned, the pages
// it read (each one a held, private brain document of origin web, so nothing recalls it), the notes whose quotes were
// found in those pages, and its report (a held document of origin research until the user keeps it). A run nobody
// keeps is deleted after 30 days. Sources and notes go with their run; a source whose page was forgotten keeps its
// row without a document, so its notes can say their quote is no longer in it.

export const ResearchRunTable = sqliteTable(
  "research_run",
  {
    id: text().primaryKey(),
    repository_id: text().notNull(),
    // The root session: researchers write into their parent's run.
    session_id: text().notNull(),
    question: text().notNull(),
    plan: text({ mode: "json" }).$type<Research.Plan>(),
    depth: text().$type<Research.Depth>().notNull(),
    scope: text().$type<Research.Scope>().notNull(),
    status: text().$type<Research.RunStatus>().notNull(),
    // The report's latest version, and its Markdown as research_report rendered it. A trigger clears both when the
    // document is forgotten, however that happens.
    report_document_id: text().references(() => BrainDocumentTable.id, { onDelete: "set null" }),
    report: text(),
    // Every query the run sent, as the Sources tab and the report's Method show them.
    queries: text({ mode: "json" }).$type<string[]>().notNull(),
    // The page and search budget the run was started with, which the store enforces.
    limits: text({ mode: "json" }).$type<{ pages?: number; searches?: number }>(),
    pages: integer().notNull().default(0),
    searches: integer().notNull().default(0),
    cost_usd: real().notNull().default(0),
    steps: integer().notNull().default(0),
    kept: integer({ mode: "boolean" }).notNull().default(false),
    created_at: integer().notNull(),
    updated_at: integer().notNull(),
  },
  (table) => [
    index("research_run_repository_idx").on(table.repository_id, table.created_at),
    index("research_run_session_idx").on(table.session_id),
  ],
)

export const ResearchSourceTable = sqliteTable(
  "research_source",
  {
    id: text().primaryKey(),
    run_id: text()
      .notNull()
      .references(() => ResearchRunTable.id, { onDelete: "cascade" }),
    // S1, S2, ... within the run.
    ordinal: integer().notNull(),
    url: text().notNull(),
    canonical_url: text().notNull(),
    title: text().notNull(),
    site: text().notNull(),
    author: text(),
    published_at: text(),
    kind: text().$type<Research.SiteKind>().notNull(),
    status: text().$type<Research.SourceStatus>().notNull(),
    reason: text(),
    duplicate_of: text(),
    signals: text({ mode: "json" }).$type<Research.Signal>(),
    // Read from the user's own computer or network, so its text is private context for the outbound check.
    private: integer({ mode: "boolean" }).notNull().default(false),
    pages: integer(),
    // The held page; none for a page that was skipped, copied or forgotten since.
    document_id: text().references(() => BrainDocumentTable.id, { onDelete: "set null" }),
    fetched_at: integer(),
    created_at: integer().notNull(),
  },
  (table) => [uniqueIndex("research_source_ordinal_idx").on(table.run_id, table.ordinal)],
)

export const ResearchNoteTable = sqliteTable(
  "research_note",
  {
    id: text().primaryKey(),
    run_id: text()
      .notNull()
      .references(() => ResearchRunTable.id, { onDelete: "cascade" }),
    // N1, N2, ... within the run.
    ordinal: integer().notNull(),
    subquestion: text().notNull(),
    claim: text().notNull(),
    source_id: text()
      .notNull()
      .references(() => ResearchSourceTable.id, { onDelete: "cascade" }),
    // The passage of the source its quote was found in: the one embedded when the machine is idle.
    passage_id: text(),
    quote: text().notNull(),
    page: integer(),
    stance: text().$type<Research.Stance>().notNull(),
    // Whether the quote states the claim (BrainLexical.states); false is a paraphrase.
    support: integer({ mode: "boolean" }).notNull(),
    verdict: text().$type<Research.Verdict>(),
    measurement: text({ mode: "json" }).$type<Research.Measurement>(),
    created_at: integer().notNull(),
  },
  (table) => [
    uniqueIndex("research_note_ordinal_idx").on(table.run_id, table.ordinal),
    index("research_note_source_idx").on(table.source_id),
  ],
)
