import { sql } from "drizzle-orm"
import { Cause, Effect, Option } from "effect"
import { Database } from "@vectordevai/core/database/database"
import { LABS, labOf, type Lab } from "@vectordevai/core/model-lab"
import { ReviewMemoryFence } from "@vectordevai/core/review/memory-fence"
import type { ReviewOutcome, Trigger } from "@vectordevai/core/review/types"
import { SessionTable } from "@vectordevai/core/session/sql"
import { SessionSchema } from "@vectordevai/core/session/schema"
import { InstanceRef } from "@/effect/instance-ref"
import { ReviewGit } from "./git"

export * as ReviewAuthor from "./author"

const mark = Symbol("VectorScope local authorship")
export interface Proof {
  readonly [mark]: true
}
const issued = new WeakMap<Proof, Lab>()
export const trustedLab = (proof: Proof | undefined) => proof && issued.get(proof)
const oid = /^[0-9a-f]{40}$/
const MAX_PATHS = 256
const MAX_ROWS = 16
type Claim = NonNullable<ReviewOutcome["claimedAuthor"]>[number]
type Source = Claim["source"]

// Store a known lab and where it was claimed. Never retain the person's address, branch name or PR text.
export function claims(input: { branch?: string; body?: string; trailers?: string }): Claim[] {
  const values = new Map<string, Claim>()
  const record = (source: Source, text: string) => {
    for (const token of text.toLowerCase().match(/[a-z0-9][a-z0-9._/-]{0,63}/g) ?? []) {
      for (const part of token.split(/[/_.-]+/)) {
        const lab = LABS.find((name) => name === part) ?? labOf(part)
        if (lab) values.set(source + lab, { source, lab })
      }
    }
  }
  record("branch", input.branch?.slice(0, 256) ?? "")
  for (const line of input.body?.slice(0, 8192).split(/\r?\n/) ?? [])
    if (/^\s*(?:co-authored-by|authored[- ]by|generated[- ]by)\s*[: ]/i.test(line)) record("pr-body", line)
  record("trailer", input.trailers ?? "")
  return [...values.values()]
}

export function localEnvironment(trigger: Trigger, env = process.env) {
  const enabled = (value: string | undefined) => !!value?.trim() && !/^(?:0|false|no)$/i.test(value.trim())
  return trigger === "local" && ![process.env.CI, process.env.GITHUB_ACTIONS, env.CI, env.GITHUB_ACTIONS].some(enabled)
}

interface Row {
  session: string
  start: string
  seq: number
  provider: unknown
  model: unknown
  files: unknown
}

// Query just the model and path metadata from the owner database; no assistant prose or tool output is selected.
// Portable imports clear snapshots. Exclude shared, forked, internal, memory-fenced or guest sessions separately.
const match = Effect.fn("ReviewAuthor.match")(function* (input: {
  directory: string
  parent?: string
  project: string
  start: string
  end: string
  paths: readonly string[]
}) {
  const database = yield* Effect.serviceOption(Database.Service)
  if (Option.isNone(database)) return
  const paths = new Set(input.paths)
  const directory = SessionTable.directory.mapToDriverValue(input.directory)
  return yield* database.value.db.transaction((tx) =>
    Effect.gen(function* () {
      let tree = input.end
      let session: string | undefined
      let beforeSeq = Number.MAX_SAFE_INTEGER
      let lab: Lab | undefined
      const changed = new Set<string>()
      const visited = new Set<string>()
      while (tree !== input.start) {
        if (visited.has(tree) || visited.size >= MAX_ROWS) return
        visited.add(tree)
        const rows = yield* tx.all<Row>(sql`
          SELECT s.id AS session, m.seq AS seq, json_extract(m.data, '$.snapshot.start') AS start,
                 json_extract(m.data, '$.model.providerID') AS provider,
                 json_extract(m.data, '$.model.id') AS model,
                 json_extract(m.data, '$.snapshot.files') AS files
            FROM session s JOIN session_message m ON m.session_id = s.id
            JOIN session_audience a ON a.session_id = s.id
           WHERE s.project_id = ${input.project} AND s.directory = ${directory}
             AND (${input.parent ?? null} IS NULL OR s.id = ${input.parent ?? null})
             AND s.internal IS NULL AND s.parent_id IS NULL AND s.revert IS NULL
             AND s.share_url IS NULL AND s.share_info IS NULL AND a.owner_only = 0 AND a.guest_input = 0
             AND NOT EXISTS (SELECT 1 FROM session_lineage l WHERE l.session_id = s.id)
             AND m.type = 'assistant'
             AND json_extract(m.data, '$.time.completed') IS NOT NULL
             AND json_extract(m.data, '$.finish') IS NOT NULL
             AND json_extract(m.data, '$.finish') != 'error' AND json_type(m.data, '$.error') IS NULL
             AND (${session ?? null} IS NULL OR s.id = ${session ?? null})
             AND m.seq < ${beforeSeq}
             AND json_extract(m.data, '$.snapshot.start') != ${tree}
             AND json_extract(m.data, '$.snapshot.end') = ${tree}
             AND json_type(m.data, '$.snapshot.files') = 'array'
             AND length(json_extract(m.data, '$.snapshot.files')) < 65536
           LIMIT 2`)
        // Multiple possible writers, even in the same lab, leave the lineage ambiguous.
        if (rows.length !== 1) return
        const row: Row = rows[0]!
        const files: unknown = JSON.parse(typeof row.files === "string" ? row.files : "null")
        if (
          !oid.test(row.start) ||
          !Number.isSafeInteger(row.seq) ||
          !Array.isArray(files) ||
          !files.length ||
          files.length > MAX_PATHS ||
          files.some((name) => typeof name !== "string" || !paths.has(name))
        )
          return
        for (const name of files) changed.add(name)
        if (!session && (yield* ReviewMemoryFence.read(tx, SessionSchema.ID.make(row.session)))) return
        if (typeof row.provider !== "string" || typeof row.model !== "string") return
        const stepLab = labOf(row.provider + "/" + row.model)
        if (!stepLab || (lab && lab !== stepLab)) return
        lab = stepLab
        session = row.session
        beforeSeq = row.seq
        tree = row.start
      }
      if (!lab || changed.size !== paths.size) return
      const proof: Proof = Object.freeze({ [mark]: true as const })
      issued.set(proof, lab)
      return proof
    }),
  )
})

export const lookup = Effect.fn("ReviewAuthor.lookup")(function* (input: {
  directory: string
  parent?: string
  base: string
  head: string
  paths: readonly string[]
  branch?: string
  body?: string
}) {
  const claimedAuthor = claims(input)
  if (
    !oid.test(input.base) ||
    !oid.test(input.head) ||
    input.base === input.head ||
    !input.paths.length ||
    input.paths.length > MAX_PATHS
  )
    return { claimedAuthor }
  const collect = Effect.gen(function* () {
    const view = yield* ReviewGit.Current
    if (!view || view.repository.head !== input.head || view.repository.directory !== input.directory)
      return { claimedAuthor }
    const read = (revision: string) =>
      Effect.tryPromise({
        try: (signal) => view.repository.read({ kind: "author-commit", revision }, signal),
        catch: () => new Error("Authorship metadata unavailable"),
      })
    const base = yield* read(input.base)
    const head = yield* read(input.head)
    if (base.code || head.code) return { claimedAuthor }
    const [start] = base.bytes.toString("utf8").split("\n")
    const [end, ...trailers] = head.bytes.toString("utf8").split("\n")
    if (!start || !end || !oid.test(start) || !oid.test(end) || start === end) return { claimedAuthor }
    const instance = yield* InstanceRef
    let project = instance?.worktree === input.directory ? String(instance.project.id) : undefined
    if (!project || project === "global") {
      // Standalone local repositories without a remote are identified by their root commit. A managed
      // instance supplies its already-resolved project ID (which can instead name the normalized remote).
      const roots = yield* Effect.tryPromise({
        try: (signal) => view.repository.read({ kind: "roots", revision: input.head }, signal),
        catch: () => new Error("Authorship repository identity unavailable"),
      })
      const value = roots.bytes.toString("utf8").trim()
      if (roots.code || !oid.test(value)) return { claimedAuthor: claims({ ...input, trailers: trailers.join("\n") }) }
      project = value
    }
    const proof = yield* match({ ...input, project, start, end })
    yield* view.preflight()
    return { proof, claimedAuthor: claims({ ...input, trailers: trailers.join("\n") }) }
  })
  const current = yield* ReviewGit.Current
  const lookup = current
    ? collect
    : ReviewGit.metadata(input.directory).pipe(
        Effect.flatMap((metadata) => ReviewGit.within(metadata, input.head, collect)),
      )
  return yield* lookup.pipe(
    Effect.catchCause((cause) => (Cause.hasInterrupts(cause) ? Effect.interrupt : Effect.succeed({ claimedAuthor }))),
  )
})
