import { Effect } from "effect"
import type { DatabaseMigration } from "../../database/migration"

// A content-free counter per scope, independent of the event log's retention. Triggers advance it transactionally
// with each supported write, visible to another engine process sharing brain.db.
export default {
  id: "20261203000000_revocation",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run("ALTER TABLE `brain_state` ADD `revocation_revision` integer DEFAULT 0 NOT NULL;")
      yield* tx.run(`
        INSERT INTO brain_state (repository_id, revocation_revision)
        SELECT repository_id, count(*) FROM brain_event
        WHERE actor = 'user' AND action IN ('forgotten', 'archived', 'unpinned', 'edited', 'filed')
        GROUP BY repository_id
        ON CONFLICT (repository_id) DO UPDATE SET revocation_revision = excluded.revocation_revision;
      `)
      yield* tx.run(`
        CREATE TRIGGER IF NOT EXISTS brain_event_revocation AFTER INSERT ON brain_event
        WHEN NEW.actor = 'user' AND NEW.action IN ('forgotten', 'archived', 'unpinned', 'edited', 'filed')
        BEGIN
          INSERT INTO brain_state (repository_id, revocation_revision) VALUES (NEW.repository_id, 1)
          ON CONFLICT (repository_id) DO UPDATE SET revocation_revision = brain_state.revocation_revision + 1;
        END;
      `)
      yield* tx.run(`
        CREATE TRIGGER IF NOT EXISTS brain_document_visibility_revocation AFTER UPDATE OF visibility ON brain_document
        WHEN OLD.visibility = 'repository' AND NEW.visibility = 'private'
        BEGIN
          INSERT INTO brain_state (repository_id, revocation_revision) VALUES (NEW.repository_id, 1)
          ON CONFLICT (repository_id) DO UPDATE SET revocation_revision = brain_state.revocation_revision + 1;
        END;
      `)
      yield* tx.run(`
        CREATE TRIGGER IF NOT EXISTS brain_repository_docs_revocation AFTER UPDATE OF repository_docs ON brain_state
        WHEN OLD.repository_docs = 1 AND NEW.repository_docs = 0
        BEGIN
          UPDATE brain_state SET revocation_revision = revocation_revision + 1 WHERE repository_id = NEW.repository_id;
        END;
      `)
      yield* tx.run(`
        CREATE TRIGGER IF NOT EXISTS brain_repository_docs_initial_revocation AFTER INSERT ON brain_state
        WHEN NEW.repository_docs = 0
        BEGIN
          UPDATE brain_state SET revocation_revision = revocation_revision + 1 WHERE repository_id = NEW.repository_id;
        END;
      `)
      // Configure first records the setting, then removes documents in their own transactions. Revoke at each delete
      // too, so a prompt prepared between those writes cannot keep the old title under the new generation.
      yield* tx.run(`
        CREATE TRIGGER IF NOT EXISTS brain_repository_document_revocation AFTER DELETE ON brain_document
        WHEN OLD.origin = 'repository' AND EXISTS (
          SELECT 1 FROM brain_state WHERE repository_id = OLD.repository_id AND repository_docs = 0
        )
        BEGIN
          UPDATE brain_state SET revocation_revision = revocation_revision + 1 WHERE repository_id = OLD.repository_id;
        END;
      `)
    })
  },
} satisfies DatabaseMigration.Migration
