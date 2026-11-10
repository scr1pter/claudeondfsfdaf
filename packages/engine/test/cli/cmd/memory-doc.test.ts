import { beforeEach, expect } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { Effect } from "effect"
import { ChildEnvironment } from "@vectordevai/core/child-environment"
import { cliIt, type RunResult, type SpawnOpts } from "../../lib/cli-process"

// `vector memory doc` as a user runs it: the real CLI in a process of its own, with its own home and data folder,
// in a repository of its own. Documents are read on this computer; no model is asked anything.

const SPEC = `# Auth spec

## 1 Sessions

The client MUST refresh the session before it expires.
Refresh tokens expire after 14 days.

## 2 Limits

Clients MUST retry at most 3 times after a 429 response.
Uploads are limited to 50 MB per file.
`

// The CLI runs as the owner runs it in their own terminal: without the agent marker, which every child of a process
// that resolved Vector Local otherwise inherits. Its owner-only commands refuse under the marker.
beforeEach(() => {
  ChildEnvironment.inherit({ agent: false })
})

// A repository in the fixture's home, and `vector memory doc …` run in it. The test process keeps its databases in
// memory, which a child would inherit; each CLI run here is a process of its own, so they share files in the home.
const repository = (
  fixture: {
    readonly home: string
    readonly vector: { readonly spawn: (args: string[], opts?: SpawnOpts) => Effect.Effect<RunResult> }
  },
  files: Record<string, string>,
) =>
  Effect.promise(async () => {
    const root = path.join(fixture.home, "repo")
    await fs.mkdir(root, { recursive: true })
    for (const [name, content] of Object.entries(files)) await fs.writeFile(path.join(root, name), content)
    return {
      root,
      doc: (args: string[], opts: { readonly stdin?: string } = {}) =>
        fixture.vector.spawn(["memory", "doc", ...args], {
          cwd: root,
          env: { VECTOR_AGENT_DB: path.join(fixture.home, "vector.db") },
          timeoutMs: 60_000,
          ...opts,
        }),
    }
  })

cliIt.concurrent(
  "doc add - keeps what a converter pipes in as Markdown, under the name given, and search finds it",
  (fixture) =>
    Effect.gen(function* () {
      const repo = yield* repository(fixture, {})
      const added = yield* repo.doc(["add", "-", "--name", "scan.pdf", "--json"], { stdin: SPEC })
      fixture.vector.expectExit(added, 0, "vector memory doc add -")
      const [result] = JSON.parse(added.stdout) as { file: string; type: string; document: Record<string, unknown> }[]
      expect(result).toMatchObject({
        file: "-",
        type: "queued",
        document: { title: "scan.pdf", format: "markdown", origin: "cli", status: "searchable" },
      })
      const search = yield* repo.doc(["search", "retry", "429", "--why", "--json"])
      fixture.vector.expectExit(search, 0, "vector memory doc search")
      const [card] = JSON.parse(search.stdout) as { text: string; title: string; why: string[] }[]
      expect(card).toMatchObject({ title: "scan.pdf", why: ["retry", "429"] })
      expect(card!.text).toContain("retry at most 3 times")
      const empty = yield* repo.doc(["add"])
      fixture.vector.expectExit(empty, 1, "vector memory doc add with no file")
    }),
  120_000,
)

cliIt.concurrent(
  "doc extract --json shows what Vector would learn and stores nothing",
  (fixture) =>
    Effect.gen(function* () {
      const repo = yield* repository(fixture, { "spec.md": SPEC })
      const extracted = yield* repo.doc(["extract", "spec.md", "--json"])
      fixture.vector.expectExit(extracted, 0, "vector memory doc extract")
      const structured = JSON.parse(extracted.stdout) as { title: string; records: { kind: string; card: string }[] }
      expect(structured.title).toBe("Auth spec")
      expect(structured.records.some((record) => record.kind === "requirement" && record.card.includes("retry"))).toBe(
        true,
      )
      const listed = yield* repo.doc(["list", "--json"])
      fixture.vector.expectExit(listed, 0, "vector memory doc list")
      expect(JSON.parse(listed.stdout)).toEqual([])
      // The same file added is kept, so the empty list above is the dry run's doing.
      fixture.vector.expectExit(yield* repo.doc(["add", "spec.md"]), 0, "vector memory doc add")
      expect(JSON.parse((yield* repo.doc(["list", "--json"])).stdout)).toHaveLength(1)
    }),
  120_000,
)

cliIt.concurrent(
  "doc add asks for --replace before a new version replaces a document, and show and forget find it by number",
  (fixture) =>
    Effect.gen(function* () {
      const repo = yield* repository(fixture, { "spec.md": SPEC })
      fixture.vector.expectExit(yield* repo.doc(["add", "spec.md"]), 0, "vector memory doc add")
      yield* Effect.promise(() => fs.appendFile(path.join(repo.root, "spec.md"), "\nUploads MUST be scanned.\n"))
      const asked = yield* repo.doc(["add", "spec.md"])
      fixture.vector.expectExit(asked, 1, "vector memory doc add, a new version")
      expect(asked.stdout + asked.stderr).toContain("Run again with --replace")
      const replaced = yield* repo.doc(["add", "spec.md", "--replace", "--json"])
      fixture.vector.expectExit(replaced, 0, "vector memory doc add --replace")
      expect(JSON.parse(replaced.stdout)[0]).toMatchObject({ type: "version", document: { version: 2, ordinal: 2 } })
      const shown = yield* repo.doc(["show", "2", "--records", "--kind", "requirement", "--json"])
      fixture.vector.expectExit(shown, 0, "vector memory doc show --records")
      const records = JSON.parse(shown.stdout) as { kind: string }[]
      expect(records.length).toBeGreaterThan(0)
      expect(records.every((record) => record.kind === "requirement")).toBe(true)
      const read = yield* repo.doc(["read", "2", "2 Limits"])
      fixture.vector.expectExit(read, 0, "vector memory doc read")
      expect(read.stdout).toContain("retry at most 3 times")
      const exported = yield* fixture.vector.spawn(["memory", "export"], {
        cwd: repo.root,
        env: { VECTOR_AGENT_DB: path.join(fixture.home, "vector.db") },
        timeoutMs: 60_000,
      })
      fixture.vector.expectExit(exported, 0, "vector memory export")
      expect(exported.stdout).toContain("## Documents")
      expect(exported.stdout).toContain("retry at most 3 times")
      fixture.vector.expectExit(yield* repo.doc(["forget", "2"]), 0, "vector memory doc forget")
      expect(JSON.parse((yield* repo.doc(["list", "--json"])).stdout)).toEqual([])
    }),
  180_000,
)

cliIt.concurrent(
  "repo-docs on says the repository's docs are shared like its memory, not private",
  (fixture) =>
    Effect.gen(function* () {
      const repo = yield* repository(fixture, {})
      const shown = yield* fixture.vector.spawn(["memory", "repo-docs", "on"], {
        cwd: repo.root,
        env: { VECTOR_AGENT_DB: path.join(fixture.home, "vector.db") },
        timeoutMs: 60_000,
      })
      fixture.vector.expectExit(shown, 0, "vector memory repo-docs on")
      expect(shown.stderr).toContain("not private")
      expect(shown.stderr).toContain("shared like the repository's memory")
      const help = yield* fixture.vector.spawn(["memory", "repo-docs", "--help"], { cwd: repo.root, timeoutMs: 60_000 })
      fixture.vector.expectExit(help, 0, "vector memory repo-docs --help")
      expect(`${help.stdout}${help.stderr}`.replace(/\s+/g, " ")).toContain("shared like its memory, not private")
    }),
  120_000,
)

cliIt.concurrent(
  "links shows what a file is linked to, review lists the drift, and review resolve keeps the code",
  (fixture) =>
    Effect.gen(function* () {
      const repo = yield* repository(fixture, {
        "limits.md":
          "# Limits\n\n## 1 Uploads\n\nUploads are limited to at most 50 MB per file by `MAX_UPLOAD_BYTES`.\n",
        "upload.ts": "// Upload limits.\nexport const MAX_UPLOAD_BYTES = 64 * 1024 * 1024\n",
      })
      yield* Effect.promise(() => Bun.$`git init -q`.cwd(repo.root).quiet())
      const run = (args: string[]) =>
        fixture.vector.spawn(["memory", ...args], {
          cwd: repo.root,
          env: { VECTOR_AGENT_DB: path.join(fixture.home, "vector.db") },
          timeoutMs: 60_000,
        })
      fixture.vector.expectExit(yield* repo.doc(["add", "limits.md"]), 0, "vector memory doc add")
      const links = yield* run(["links", "upload.ts", "--json"])
      fixture.vector.expectExit(links, 0, "vector memory links")
      const linked = JSON.parse(links.stdout) as { kind: string; anchor?: { method: string; symbol?: string } }[]
      expect(linked).toContainEqual(
        expect.objectContaining({
          kind: "constraint",
          anchor: expect.objectContaining({ method: "constant", symbol: "MAX_UPLOAD_BYTES" }),
        }),
      )
      // A file named through a link to the repository spells the root another way than git does, as Windows' short
      // temporary folder name (RUNNER~1) did on CI, and it is still found by its name in the repository.
      const alias = path.join(fixture.home, "linked-repository")
      yield* Effect.promise(() => fs.symlink(repo.root, alias, "junction"))
      const viaAlias = yield* run(["links", path.join(alias, "upload.ts"), "--json"])
      fixture.vector.expectExit(viaAlias, 0, "vector memory links through a linked folder")
      expect(JSON.parse(viaAlias.stdout)).toContainEqual(
        expect.objectContaining({
          kind: "constraint",
          anchor: expect.objectContaining({ symbol: "MAX_UPLOAD_BYTES" }),
        }),
      )
      const listed = yield* run(["review"])
      fixture.vector.expectExit(listed, 0, "vector memory review")
      expect(`${listed.stdout}${listed.stderr}`).toContain("says 50 MB; the code says 64 MB (upload.ts:2)")
      const items = JSON.parse((yield* run(["review", "--json"])).stdout) as { id: string; kind: string }[]
      const drift = items.find((item) => item.kind === "drift")!
      const kept = yield* run(["review", "resolve", drift.id, "keep-code", "--json"])
      fixture.vector.expectExit(kept, 0, "vector memory review resolve")
      expect(JSON.parse(kept.stdout)).toMatchObject({
        type: "item",
        item: { status: "resolved" },
        entry: { kind: "decision" },
      })
      const after = yield* run(["review"])
      expect(`${after.stdout}${after.stderr}`).toContain("Nothing needs a look.")
      const unknown = yield* run(["review", "resolve", "vnothing", "dismiss"])
      fixture.vector.expectExit(unknown, 1, "vector memory review resolve of nothing")
    }),
  180_000,
)

cliIt.concurrent(
  "doc distill shows the estimate first, sends only with --yes and the flag, and keeps the verbatim suggestion only",
  (fixture) =>
    Effect.gen(function* () {
      const billing =
        "# Billing notes\n\n## Refunds policy\n\nRefunds are approved by a support lead and paid back to the original card within ten business days.\n"
      const repo = yield* repository(fixture, { "billing.md": billing })
      const run = (args: string[], flag: boolean) =>
        fixture.vector.spawn(["memory", "doc", ...args], {
          cwd: repo.root,
          env: {
            VECTOR_AGENT_DB: path.join(fixture.home, "vector.db"),
            ...(flag ? { VECTOR_KNOWLEDGE_DISTILL: "1" } : {}),
          },
          timeoutMs: 60_000,
        })
      const added = yield* repo.doc(["add", "billing.md", "--json"])
      fixture.vector.expectExit(added, 0, "vector memory doc add")
      const id = (JSON.parse(added.stdout) as { document: { id: string } }[])[0]!.document.id
      const model = ["--model", "lmstudio/test-model"]

      // Off by default.
      const off = yield* run(["distill", id, ...model, "--yes"], false)
      fixture.vector.expectExit(off, 1, "vector memory doc distill with the flag off")
      expect(`${off.stdout}${off.stderr}`).toContain("VECTOR_KNOWLEDGE_DISTILL")
      // The estimate sends nothing.
      const estimate = yield* run(["distill", id, ...model, "--json"], true)
      fixture.vector.expectExit(estimate, 0, "vector memory doc distill estimate")
      expect(JSON.parse(estimate.stdout)).toMatchObject({
        enabled: true,
        model: "lmstudio/test-model",
        sections: 1,
        output: 4000,
      })
      expect(yield* fixture.llm.calls).toBe(0)

      yield* fixture.llm.tool("StructuredOutput", {
        records: [
          {
            kind: "requirement",
            text: "Refunds are approved by a support lead",
            quote:
              "Refunds are approved by a support lead and paid back to the original card within ten business days.",
          },
          { kind: "constraint", text: "Refunds are paid within 5 days", quote: "Refunds are paid within 5 days." },
        ],
      })
      const sent = yield* run(["distill", id, ...model, "--yes", "--json"], true)
      fixture.vector.expectExit(sent, 0, "vector memory doc distill --yes")
      const result = JSON.parse(sent.stdout) as {
        records: { id: string; status: string }[]
        dropped: { quote: number }
      }
      expect(result.records.map((record) => record.status)).toEqual(["proposed"])
      expect(result.dropped.quote).toBe(1)
      expect(yield* fixture.llm.calls).toBe(1)

      fixture.vector.expectExit(
        yield* run(["approve", id, "--suggestions"], true),
        0,
        "vector memory doc approve --suggestions",
      )
      const shown = yield* run(["show", id, "--records", "--json"], true)
      const records = JSON.parse(shown.stdout) as { id: string; status: string; origin: string }[]
      expect(records.find((record) => record.id === result.records[0]!.id)).toMatchObject({
        status: "active",
        origin: "distilled",
      })
    }),
  120_000,
)
