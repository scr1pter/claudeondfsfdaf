import { afterAll, beforeAll, expect } from "bun:test"
import { Effect, Exit, Scope } from "effect"
import { cliIt, withCliFixture } from "../lib/cli-process"
import path from "node:path"

// The round trip and the public history test start several CLI processes. Each takes 2 to 3.5 s on a Windows runner,
// and more than twice that when the runner slows (test.yml run 42443552558: past 30 s for both), so those two get a
// limit of their own. Each process keeps its own 30 s limit, so a hang still fails.
const PROCESSES = 120_000

// A real local export of a session a real `vector serve` created, made once for the round trip and the owner-only
// test: both used to start the server and export it themselves, two of the six cold CLI processes each ran on a 30 s
// budget (test.yml job 136531095350: 30 s on a normal Windows runner). The hook's 30 s is the owner-only test's former
// budget, which covered these same two processes and four more. The server stops before any test runs, but the source
// home and its database stay open until afterAll: the owner-only test imports into that database, so its import still
// forks a source the database knows, as it did when it served, exported and imported in one home. The round trip
// imports into a fresh home of its own.
const sourceScope = Effect.runSync(Scope.make())
let source: { id: string; archive: string; db: string }

beforeAll(async () => {
  source = await Effect.runPromise(
    withCliFixture(({ vector, home }) =>
      Effect.gen(function* () {
        const db = path.join(home, "source.db")
        const env = { VECTOR_AGENT_DB: db }
        const exported = yield* Effect.scoped(
          Effect.gen(function* () {
            const server = yield* vector.serve({ env })
            const session = yield* Effect.promise(() =>
              fetch(`${server.url}/session`, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ title: "Round trip fixture" }),
              }).then((response) => response.json()),
            )
            const result = yield* vector.spawn(["export", session.id], { env })
            expect(result.exitCode, JSON.stringify(session) + result.stderr).toBe(0)
            return { id: session.id, archive: result.stdout }
          }),
        )
        return { ...exported, db }
      }),
    ).pipe(Scope.provide(sourceScope)),
  )
}, 30_000)

afterAll(() => Effect.runPromise(Scope.close(sourceScope, Exit.void)))

cliIt.live(
  "import rejects remote URLs without contacting them",
  ({ vector }) =>
    Effect.gen(function* () {
      const result = yield* vector.spawn(["import", "https://example.invalid/share/session"])
      expect(result.exitCode).not.toBe(0)
      expect(result.stdout + result.stderr).toContain("Use a Vector share URL")
    }),
  30_000,
)

cliIt.live(
  "local session export imports into a fresh isolated home",
  ({ home }) =>
    Effect.gen(function* () {
      const file = path.join(home, "export.json")
      yield* Effect.promise(() => Bun.write(file, source.archive))
      yield* withCliFixture((fixture) =>
        Effect.gen(function* () {
          const env = { VECTOR_AGENT_DB: path.join(fixture.home, "roundtrip.db") }
          const before = yield* fixture.vector.spawn(["session", "list", "--format", "json"], { env })
          expect(before.exitCode, before.stderr).toBe(0)
          expect(before.stdout.trim()).toBe("")
          const imported = yield* fixture.vector.spawn(["import", file], { env })
          expect(imported.exitCode).toBe(0)
          const importedID = imported.stdout.match(/Imported session: (ses_\S+)/)?.[1]
          expect(importedID).toBeDefined()
          expect(importedID).not.toBe(source.id)
          const restored = yield* fixture.vector.spawn(["export", importedID!], { env })
          expect(restored.exitCode, restored.stderr).toBe(0)
          expect(JSON.parse(restored.stdout).info).toMatchObject({ id: importedID, title: "Round trip fixture" })
        }),
      )
    }),
  PROCESSES,
)

cliIt.live(
  "portable public history imports passively with fresh local identities",
  ({ vector, home }) =>
    Effect.gen(function* () {
      const env = { VECTOR_AGENT_DB: path.join(home, "import.db") }
      const marker = path.join(home, "must-not-execute")
      const file = path.join(home, "public.json")
      yield* Effect.promise(() =>
        Bun.write(
          file,
          JSON.stringify({
            version: 1,
            engine: "v1",
            title: "Passive public fixture",
            messages: [
              {
                id: "foreign-user",
                role: "user",
                createdAt: 1,
                parts: [{ type: "text", text: "Imported user message" }],
              },
              {
                id: "foreign-assistant",
                role: "assistant",
                createdAt: 2,
                parts: [
                  {
                    type: "tool",
                    name: "bash",
                    callID: "foreign-call",
                    status: "interrupted",
                    input: JSON.stringify({ command: `touch ${marker}` }),
                    output: "",
                  },
                ],
              },
            ],
          }),
        ),
      )
      const imported = yield* vector.spawn(["import", file], { env })
      expect(imported.exitCode, imported.stderr).toBe(0)
      const id = imported.stdout.match(/Imported session: (ses_\S+)/)?.[1]
      expect(id).toBeDefined()
      const exported = yield* vector.spawn(["export", id!], { env })
      expect(exported.exitCode, exported.stderr).toBe(0)
      const archive = JSON.parse(exported.stdout)
      expect(archive.info.directory).not.toBe("/untrusted-placement")
      expect(archive.info.permission).toBeUndefined()
      expect(archive.messages).toHaveLength(2)
      expect(archive.messages.map((message: { info: { id: string } }) => message.info.id)).not.toContain("foreign-user")
      expect(
        archive.messages
          .flatMap((message: { parts: { type: string }[] }) => message.parts)
          .every((part: { type: string }) => part.type === "text"),
      ).toBe(true)
      expect(yield* Effect.promise(() => Bun.file(marker).exists())).toBe(false)
      const portable = yield* vector.spawn(["export", id!, "--public"], { env })
      expect(portable.exitCode, portable.stderr).toBe(0)
      expect(JSON.parse(portable.stdout)).toMatchObject({ version: 1, engine: "v1", title: "Passive public fixture" })
      const sanitized = yield* vector.spawn(["export", id!, "--public", "--sanitize"], { env })
      expect(sanitized.exitCode, sanitized.stderr).toBe(0)
      expect(sanitized.stdout).not.toContain(marker)
      expect(sanitized.stdout).not.toContain("Imported user message")
    }),
  PROCESSES,
)

cliIt.live(
  "an invalid archive creates no partial session",
  ({ vector, home }) =>
    Effect.gen(function* () {
      const env = { VECTOR_AGENT_DB: path.join(home, "import.db") }
      const file = path.join(home, "invalid-public.json")
      yield* Effect.promise(() =>
        Bun.write(
          file,
          JSON.stringify({
            version: 1,
            engine: "v1",
            title: "Invalid",
            messages: [
              { id: "foreign", role: "user", createdAt: 1, parts: [{ type: "command", command: "execute me" }] },
            ],
          }),
        ),
      )
      const imported = yield* vector.spawn(["import", file], { env })
      expect(imported.exitCode).not.toBe(0)
      const sessions = yield* vector.spawn(["session", "list", "--format", "json"], { env })
      expect(sessions.exitCode, sessions.stderr).toBe(0)
      expect(sessions.stdout.trim()).toBe("")
    }),
  30_000,
)

cliIt.live(
  "native public history is imported into the current CLI's passive display format",
  ({ vector, home }) =>
    Effect.gen(function* () {
      const env = { VECTOR_AGENT_DB: path.join(home, "import.db") }
      const file = path.join(home, "native-public.json")
      yield* Effect.promise(() =>
        Bun.write(
          file,
          JSON.stringify({
            version: 1,
            engine: "v2",
            title: "Native public fixture",
            messages: [
              {
                id: "native-foreign-user",
                role: "user",
                createdAt: 1,
                parts: [{ type: "text", text: "Visible native history" }],
              },
            ],
          }),
        ),
      )
      const imported = yield* vector.spawn(["import", file], { env })
      expect(imported.exitCode, imported.stderr).toBe(0)
      expect(imported.stdout).toContain("portable v2 transcript into v1")
      const id = imported.stdout.match(/Imported session: (ses_\S+)/)?.[1]
      expect(id).toBeDefined()
      const exported = yield* vector.spawn(["export", id!], { env })
      expect(exported.exitCode, exported.stderr).toBe(0)
      const archive = JSON.parse(exported.stdout)
      expect(archive.messages[0].parts[0]).toMatchObject({ type: "text", text: "Visible native history" })
      expect(archive.messages[0].info.id).not.toBe("native-foreign-user")
    }),
  30_000,
)

cliIt.live(
  "an owner-only conversation keeps its marker on local export and refuses the portable format",
  ({ vector, home }) =>
    Effect.gen(function* () {
      // The source session's own database, so the import forks a known source that is not private.
      const env = { VECTOR_AGENT_DB: source.db }
      // A local archive's owner-only marker can only tighten what an import may disclose.
      const file = path.join(home, "private.json")
      yield* Effect.promise(() =>
        Bun.write(file, JSON.stringify({ ...JSON.parse(source.archive), privacy: "owner-only" })),
      )
      const imported = yield* vector.spawn(["import", file], { env })
      expect(imported.exitCode, imported.stderr).toBe(0)
      const importedID = imported.stdout.match(/Imported session: (ses_\S+)/)?.[1]
      expect(importedID).toBeDefined()
      const local = yield* vector.spawn(["export", importedID!], { env })
      expect(local.exitCode, local.stderr).toBe(0)
      expect(JSON.parse(local.stdout).privacy).toBe("owner-only")
      const portable = yield* vector.spawn(["export", "--public", importedID!], { env })
      expect(portable.exitCode).not.toBe(0)
      expect(portable.stdout + portable.stderr).toContain("cannot be exported in the portable format")
      const sanitized = yield* vector.spawn(["export", "--sanitize", importedID!], { env })
      const native = "engine" in JSON.parse(local.stdout)
      if (native) expect(sanitized.exitCode).not.toBe(0)
      else {
        expect(sanitized.exitCode, sanitized.stderr).toBe(0)
        expect(JSON.parse(sanitized.stdout).privacy).toBe("owner-only")
      }
    }),
  30_000,
)

// F44b: the CLI's own `export --sanitize`, not only localArchive, keeps a child's lifecycle text out. A real `vector
// serve` makes the parent and a child whose record holds a title and a mailbox entry; a plain export shows both and the
// sanitized export holds neither, with the record's markers in their place.
cliIt.live(
  "a sanitized CLI export of a child session redacts its lifecycle title and mailbox text",
  ({ vector, home }) =>
    Effect.gen(function* () {
      const env = { VECTOR_AGENT_DB: path.join(home, "child.db") }
      const title = "Child title naming /home/person/private-repo"
      const mailbox = "Mailbox note quoting the private plan"
      const child = yield* Effect.scoped(
        Effect.gen(function* () {
          const server = yield* vector.serve({ env })
          const create = (body: object) =>
            Effect.promise(() =>
              fetch(`${server.url}/session`, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify(body),
              }).then((response) => response.json()),
            )
          const parent = yield* create({ title: "Lifecycle parent" })
          return yield* create({
            parentID: parent.id,
            title,
            metadata: {
              subagent: {
                kind: "subagent",
                agent: "general",
                title,
                parentSessionID: parent.id,
                status: "completed",
                startedAt: 1,
                mailbox: [{ id: "mail_1", sender: "Lead", text: mailbox, delivery: "steer", createdAt: 1 }],
              },
            },
          })
        }),
      )
      expect(child.id, JSON.stringify(child)).toStartWith("ses_")
      const plain = yield* vector.spawn(["export", child.id], { env })
      expect(plain.exitCode, plain.stderr).toBe(0)
      expect(plain.stdout).toContain(title)
      expect(plain.stdout).toContain(mailbox)
      const sanitized = yield* vector.spawn(["export", "--sanitize", child.id], { env })
      expect(sanitized.exitCode, sanitized.stderr).toBe(0)
      expect(sanitized.stdout).not.toContain(title)
      expect(sanitized.stdout).not.toContain(mailbox)
      const record = JSON.parse(sanitized.stdout).info.metadata.subagent
      expect(record.title).toBe(`[redacted:subagent-title:${child.id}]`)
      expect(record.mailbox[0]).toMatchObject({ id: "mail_1", text: `[redacted:subagent-mailbox-text:${child.id}-0]` })
    }),
  PROCESSES,
)
