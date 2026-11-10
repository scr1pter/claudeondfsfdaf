import { expect } from "bun:test"
import { Effect } from "effect"
import { cliIt, withCliFixture } from "../lib/cli-process"
import path from "node:path"

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
  ({ vector, home }) =>
    Effect.gen(function* () {
      const env = { VECTOR_AGENT_DB: path.join(home, "roundtrip.db") }
      const server = yield* vector.serve({ env })
      const session = yield* Effect.promise(() =>
        fetch(`${server.url}/session`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ title: "Round trip fixture" }),
        }).then((response) => response.json()),
      )
      const exported = yield* vector.spawn(["export", session.id], { env })
      expect(exported.exitCode, JSON.stringify(session) + exported.stderr).toBe(0)
      const file = path.join(home, "export.json")
      yield* Effect.promise(() => Bun.write(file, exported.stdout))
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
          expect(importedID).not.toBe(session.id)
          const restored = yield* fixture.vector.spawn(["export", importedID!], { env })
          expect(restored.exitCode, restored.stderr).toBe(0)
          expect(JSON.parse(restored.stdout).info).toMatchObject({ id: importedID, title: "Round trip fixture" })
        }),
      )
    }),
  30_000,
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
  30_000,
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
      const env = { VECTOR_AGENT_DB: path.join(home, "private.db") }
      const server = yield* vector.serve({ env })
      const session = yield* Effect.promise(() =>
        fetch(`${server.url}/session`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ title: "Private fixture" }),
        }).then((response) => response.json()),
      )
      const exported = yield* vector.spawn(["export", session.id], { env })
      expect(exported.exitCode, exported.stderr).toBe(0)
      // A local archive's owner-only marker can only tighten what an import may disclose.
      const file = path.join(home, "private.json")
      yield* Effect.promise(() =>
        Bun.write(file, JSON.stringify({ ...JSON.parse(exported.stdout), privacy: "owner-only" })),
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
