export * as BrainDatabase from "./database"

import { chmodSync, mkdirSync } from "node:fs"
import path from "node:path"
import { EffectDrizzleSqlite } from "@vectordevai/effect-drizzle-sqlite"
import { layer } from "#sqlite"
import { Context, Effect, Layer } from "effect"
import { DatabaseMigration } from "../database/migration"
import { makeGlobalNode } from "../effect/app-node"
import { Flag } from "../flag/flag"
import { Global } from "../global"
import { InstallationChannel } from "../installation/version"
import { BrainPaths } from "./paths"
import first from "./migration/20261018000000_brain"
import knowledge from "./migration/20261101000000_knowledge"
import privateMemory from "./migration/20261102000000_private_memory"
import tombstoneTerms from "./migration/20261103000000_tombstone_terms"
import credit from "./migration/20261104000000_credit"
import code from "./migration/20261120000000_code"
import creditedOnce from "./migration/20261121000000_credited_once"
import research from "./migration/20261201000000_research"
import facets from "./migration/20261202000000_facets"
import revocation from "./migration/20261203000000_revocation"
import learnedSkills from "./migration/20261210000000_learned_skills"
import workflow from "./migration/20261211000000_workflow"
import researchClaims from "./migration/20261212000000_research_claims"
import reviewMemory from "./migration/20261216000000_review_memory"
import reviewMemoryScope from "./migration/20261217000000_review_memory_scope"
import reviewMemorySource from "./migration/20261218000000_review_memory_source"

// brain.db, opened once per process and shared by everything that reads or writes the brain: memory entries, and the
// documents and records Vector reads into it. One connection means one writer per process, which SQLite wants, and
// another process (the desktop engine beside a CLI run) waits on busy_timeout rather than failing.

/**
 * Every Brain migration, run in this order. Ids sort the same way: each has its own 14-digit prefix, and a new one takes
 * a prefix after the last, so branches that each add migrations cannot leave two sharing one or running out of order.
 */
export const migrations: readonly DatabaseMigration.Migration[] = [
  first,
  knowledge,
  privateMemory,
  tombstoneTerms,
  credit,
  code,
  creditedOnce,
  research,
  facets,
  revocation,
  learnedSkills,
  workflow,
  researchClaims,
  reviewMemory,
  reviewMemoryScope,
  reviewMemorySource,
]

const makeDatabase = EffectDrizzleSqlite.makeWithDefaults()
export type Database = Effect.Success<typeof makeDatabase>

export interface Interface {
  readonly db: Database
  /** The database file, or ":memory:". */
  readonly file: string
}

export class Service extends Context.Service<Service, Interface>()("@vector/BrainDatabase") {}

export const layerFor = (file: string) =>
  Layer.effect(
    Service,
    Effect.gen(function* () {
      const db = yield* makeDatabase
      yield* db.run("PRAGMA journal_mode = WAL")
      yield* db.run("PRAGMA synchronous = NORMAL")
      yield* db.run("PRAGMA busy_timeout = 5000")
      yield* db.run("PRAGMA foreign_keys = ON")
      // Forgotten memory is overwritten on disk, not just unlinked from the b-tree.
      yield* db.run("PRAGMA secure_delete = ON")
      yield* DatabaseMigration.applyOnly(db, migrations)
      // SQLite gives the -wal and -shm files the database's own mode, but on the first open they exist before this.
      if (file !== ":memory:" && process.platform !== "win32")
        yield* Effect.forEach(
          ["", "-wal", "-shm"],
          (suffix) =>
            Effect.try({ try: () => chmodSync(file + suffix, 0o600), catch: () => undefined }).pipe(Effect.ignore),
          { discard: true },
        )
      return { db, file }
    }).pipe(Effect.orDie),
  ).pipe(
    Layer.provide(
      Layer.suspend(() => {
        if (file !== ":memory:") mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
        return layer({ filename: file })
      }),
    ),
  )

/**
 * brain.db beside vector.db: latest, beta and prod share one; a development channel gets its own, so a dev build never
 * touches real memory. A session database in memory (tests, the onboarding check) means a brain in memory too.
 */
export function databasePath() {
  if (Flag.VECTOR_AGENT_DB === ":memory:") return ":memory:"
  const channel =
    ["latest", "beta", "prod"].includes(InstallationChannel) ||
    process.env.VECTOR_DISABLE_CHANNEL_DB === "1" ||
    process.env.VECTOR_DISABLE_CHANNEL_DB === "true"
  return path.join(
    BrainPaths.directory(Global.Path.data),
    channel ? "brain.db" : `brain-${InstallationChannel.replace(/[^a-zA-Z0-9._-]/g, "-")}.db`,
  )
}

// The path is resolved when the layer is built, not at import, so a host that sets the database flag first is honoured.
export const node = makeGlobalNode({
  service: Service,
  layer: Layer.suspend(() => layerFor(databasePath())),
  deps: [],
})
