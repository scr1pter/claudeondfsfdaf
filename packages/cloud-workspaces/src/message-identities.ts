import { Database } from "bun:sqlite"
import { chmodSync, mkdirSync } from "node:fs"
import { dirname } from "node:path"
import { ascending } from "@vectordevai/schema/identifier"
import { WorkspaceError, workspaceId } from "./protocol.js"

const SESSION = /^ses_[A-Za-z0-9]{1,80}$/
const MESSAGE = /^msg_[0-9a-f]{12}[0-9A-Za-z]{14}$/
const MAX_MESSAGES = 500

/** Private host allocations keep the engine's chronological IDs separate from client retry identifiers. */
export class MessageIdentities {
  private readonly database: Database
  private readonly statements: ReturnType<typeof prepare>

  constructor(options: { path: string }) {
    // The service selects this persistent path. A request never supplies a filesystem path or message timestamp.
    if (!options.path || options.path.includes("\0")) throw invalid()
    if (options.path !== ":memory:") mkdirSync(dirname(options.path), { recursive: true, mode: 0o700 })
    this.database = new Database(options.path, { create: true, strict: true })
    try {
      if (options.path !== ":memory:") chmodSync(options.path, 0o600)
      this.database.exec("PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;")
      const version = this.database.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version
      if (version !== 0 && version !== 1)
        throw new WorkspaceError(
          "WORKSPACE_MESSAGE_STORAGE_UNSUPPORTED",
          "The workspace message store needs a compatible service version.",
          503,
        )
      this.database
        .transaction(() => {
          this.database.exec(`
          CREATE TABLE IF NOT EXISTS workspace_message_identity (
            workspace_id TEXT NOT NULL,
            session_id TEXT NOT NULL,
            request_id TEXT NOT NULL,
            message_id TEXT NOT NULL UNIQUE,
            PRIMARY KEY (workspace_id, session_id, request_id)
          );
          PRAGMA user_version = 1;
        `)
        })
        .immediate()
      this.statements = prepare(this.database)
    } catch (error) {
      this.database.close()
      throw error
    }
  }

  allocate(workspaceID: string, sessionID: string, requestID: string) {
    if (
      !workspaceId(workspaceID) ||
      typeof sessionID !== "string" ||
      !SESSION.test(sessionID) ||
      !workspaceId(requestID)
    )
      throw invalid()
    return this.database
      .transaction(() => {
        const previous = this.statements.existing.get(workspaceID, sessionID, requestID)
        if (previous) return previous.messageID
        if (this.statements.count.get(workspaceID)!.count >= MAX_MESSAGES)
          throw new WorkspaceError(
            "WORKSPACE_MESSAGE_LIMIT",
            "This workspace has reached its saved message limit.",
            429,
          )
        // The engine generates assistant IDs with this same constructor. Random client IDs break its ordering.
        const messageID = `msg_${ascending()}`
        this.statements.insert.run(workspaceID, sessionID, requestID, messageID)
        return messageID
      })
      .immediate()
  }

  lookup(workspaceID: string, sessionID: string, messageID: string) {
    if (
      !workspaceId(workspaceID) ||
      typeof sessionID !== "string" ||
      !SESSION.test(sessionID) ||
      typeof messageID !== "string" ||
      !MESSAGE.test(messageID)
    )
      return false
    return this.statements.matches.get(workspaceID, sessionID, messageID) !== null
  }

  removeWorkspace(workspaceID: string) {
    if (!workspaceId(workspaceID)) throw invalid()
    this.statements.remove.run(workspaceID)
  }

  close() {
    this.database.close()
  }
}

function prepare(database: Database) {
  return {
    existing: database.query<{ messageID: string }, [string, string, string]>(
      "SELECT message_id AS messageID FROM workspace_message_identity WHERE workspace_id = ? AND session_id = ? AND request_id = ?",
    ),
    matches: database.query<{ found: number }, [string, string, string]>(
      "SELECT 1 AS found FROM workspace_message_identity WHERE workspace_id = ? AND session_id = ? AND message_id = ?",
    ),
    count: database.query<{ count: number }, [string]>(
      "SELECT count(*) AS count FROM workspace_message_identity WHERE workspace_id = ?",
    ),
    insert: database.query<never, [string, string, string, string]>(
      "INSERT INTO workspace_message_identity (workspace_id, session_id, request_id, message_id) VALUES (?, ?, ?, ?)",
    ),
    remove: database.query<never, [string]>("DELETE FROM workspace_message_identity WHERE workspace_id = ?"),
  }
}

function invalid() {
  return new WorkspaceError("INVALID_MESSAGE_REQUEST", "The workspace message identity request is invalid.")
}
