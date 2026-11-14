import { inArray, sql } from "drizzle-orm"
import { Effect } from "effect"
import type { BrainDatabase } from "./database"
import { BrainStateTable } from "./sql"

// Unlike the general brain revision, these counters change only when the user withdraws or corrects memory. They
// survive event pruning and scope erasure, so a warm snapshot cannot regain an old key after a later withdrawal.
// Personal rules and outward habits reach every audience, so every repository observes the personal counter too.
export const revision = (db: BrainDatabase.Database, repository: string) =>
  db
    .select({ revision: sql<number>`coalesce(sum(${BrainStateTable.revocation_revision}), 0)` })
    .from(BrainStateTable)
    .where(inArray(BrainStateTable.repository_id, [repository, ""]))
    .get()
    .pipe(
      Effect.orDie,
      Effect.map((row) => row?.revision ?? 0),
    )

export * as BrainRevocation from "./revocation"
