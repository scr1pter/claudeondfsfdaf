import { sql } from "drizzle-orm"
import { Effect } from "effect"
import { Database } from "@vectordevai/core/database/database"
import { ReviewAuthor } from "@/review/author"
import { ReviewGit } from "@/review/git"
import type { ReadOnlyGit } from "@vectordevai/core/read-only-git"

export const directory = "/tmp/vector-authorship-fixture"
export const base = "a".repeat(40)
export const head = "b".repeat(40)
export const first = "1".repeat(40)
export const middle = "2".repeat(40)
export const last = "3".repeat(40)
export const session = "ses_localAuthorshipFixture"
export const file = "src/feature.ts"

export const seedAuthorship = Effect.fn("test.seedAuthorship")(function* (dir: string, project = base) {
  const { db } = yield* Database.Service
  yield* db.run(sql`INSERT INTO project(id,worktree,time_created,time_updated,sandboxes)
    VALUES (${project},${dir},1,1,'[]')`)
  yield* db.run(sql`INSERT INTO session(id,project_id,slug,directory,title,version,time_created,time_updated)
    VALUES (${session},${project},'fixture',${dir},'fixture','1',1,1)`)
  yield* db.run(sql`INSERT INTO session_audience(session_id) VALUES (${session})`)
  return (seq: number, start: string, end: string, model = "claude-sonnet", files = [file]) =>
    db.run(sql`INSERT INTO session_message(id,session_id,seq,type,data,time_created,time_updated)
      VALUES (${"msg_fixture" + seq},${session},${seq},'assistant',${JSON.stringify({
        model: { providerID: "test", id: model },
        finish: "stop",
        time: { created: seq, completed: seq },
        snapshot: { start, end, files },
        content: [],
      })},1,1)`)
})

export const lookupFixture = (paths = [file]) => {
  const metadata: ReadOnlyGit.Metadata = {
    directory,
    head,
    gitDirectory: directory + "/.git",
    commonDirectory: directory + "/.git",
    commonIdentity: { dev: "1", ino: "2", birth: "3" },
    objectValidated: false,
  }
  const view: ReviewGit.View = {
    metadata,
    client: {
      run: () => Effect.die("unexpected Git command"),
      branch: () => Effect.die("unexpected branch read"),
      defaultBranch: () => Effect.die("unexpected default branch read"),
    },
    preflight: () => Effect.void,
    repository: {
      ...metadata,
      shallow: false,
      hasInfoRules: false,
      isOpen: () => true,
      status: async () => ({ head, dirty: false }),
      close: async () => {},
      read: async (op) => {
        if (op.kind === "roots" && op.revision === head) return { code: 0, bytes: Buffer.from(base + "\n") }
        if (op.kind !== "author-commit" || ![base, head].includes(op.revision)) throw Error("unexpected Git operation")
        return { code: 0, bytes: Buffer.from(op.revision === base ? first + "\n" : last + "\nGitHub Copilot\n") }
      },
    },
  }
  return ReviewAuthor.lookup({ directory, head, base, paths }).pipe(Effect.provideService(ReviewGit.Current, view))
}

export const outsideCI = Effect.acquireRelease(
  Effect.sync(() => {
    const saved = { CI: process.env.CI, GITHUB_ACTIONS: process.env.GITHUB_ACTIONS }
    delete process.env.CI
    delete process.env.GITHUB_ACTIONS
    return saved
  }),
  (saved) =>
    Effect.sync(() => {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
    }),
)
