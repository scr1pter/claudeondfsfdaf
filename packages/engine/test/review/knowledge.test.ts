import { CrossSpawnSpawner } from "@vectordevai/core/cross-spawn-spawner"
import { LayerNode } from "@vectordevai/core/effect/layer-node"
import { Ripgrep } from "@vectordevai/core/ripgrep"
import { $ } from "bun"
import { rename } from "node:fs/promises"
import { BrainDatabase } from "@vectordevai/core/brain/database"
import { BrainItemTable } from "@vectordevai/core/brain/sql"
import { BrainPosting } from "@vectordevai/core/brain/posting"
import { parseUnifiedDiff } from "@vectordevai/core/review/diff"
import { scopedSources } from "../../src/review/card-sources"
import { Effect } from "effect"
import { afterEach, describe, expect } from "bun:test"
import path from "path"
import { Brain } from "@vectordevai/core/brain/brain"
import { BrainKnowledge } from "@vectordevai/core/brain/knowledge"
import { FSUtil } from "@vectordevai/core/fs-util"
import { buildReviewPrompt } from "@vectordevai/core/review/prompt"
import { Token } from "@vectordevai/core/util/token"
import { Instruction } from "../../src/session/instruction"
import { ReviewContext } from "../../src/review/context"
import { disposeAllInstances, TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

// Vectorscope knows the specs: a review of a change gets the requirements and contracts the user's documents link to
// the changed files, with whether each link still holds, in at most 300 tokens, and nothing it may not see.

afterEach(async () => {
  await disposeAllInstances()
})

const it = testEffect(
  LayerNode.compile(
    LayerNode.group([
      CrossSpawnSpawner.node, Ripgrep.node, Brain.node, BrainKnowledge.node, Instruction.node, FSUtil.node, BrainDatabase.node,
    ]),
  ),
)

const SPEC = `# Limits

## 1 Uploads

Uploads are limited to at most 50 MB per file by \`MAX_UPLOAD_BYTES\`.

## 2 Sessions

The \`refreshTokenTtl\` MUST be 14 days.
`

const setup = Effect.fn("test.setup")(function* (origin: BrainKnowledge.Origin, hold?: "web") {
  const dir = (yield* TestInstance).directory
  const fs = yield* FSUtil.Service
  yield* fs.writeWithDirs(path.join(dir, "src", "upload.ts"), "// Upload limits.\nexport const MAX_UPLOAD_BYTES = 64 * 1024 * 1024\n")
  yield* fs.writeWithDirs(
    path.join(dir, "src", "auth", "session.ts"),
    "export const refreshTokenTtl = (days: number) => days * 86_400\n",
  )
  const knowledge = yield* BrainKnowledge.Service
  const place = yield* (yield* Instruction.Service).place()
  const added = yield* knowledge.add(place, { type: "text", name: "Limits.md", text: SPEC, origin, ...(hold ? { hold } : {}) })
  if (added.type === "refused") throw new Error(added.message)
  yield* knowledge.wait(place, added.document.id, "searchable", 20_000)
  // The session code changes after it was linked.
  yield* Effect.promise(() => Bun.sleep(5))
  yield* fs.writeWithDirs(
    path.join(dir, "src", "auth", "session.ts"),
    "export const refreshTokenTtl = (hours: number) => hours * 3_600\n",
  )
  yield* knowledge.drift(place, { force: true })
  return { knowledge, place }
})

describe("ReviewContext.requirements", () => {
  it.instance(
    "the changed files' requirements come with their drift flags, within 300 tokens, and the prompt carries them as data",
    () =>
      Effect.gen(function* () {
        yield* setup("upload")
        const place = yield* (yield* Instruction.Service).place()
        const text = yield* ReviewContext.requirements({
          place,
          files: ["src/upload.ts", "src/auth/session.ts", "README.md"],
          personal: true,
        })
        expect(text).toBeDefined()
        expect(Token.estimate(text!)).toBeLessThanOrEqual(300)
        expect(text).toMatch(/\[r[0-9a-z]{12}\] constraint · Limits: Uploads are limited to at most 50 MB/)
        expect(text).toContain("→ src/upload.ts:2 (code says 64 MB)")
        expect(text).toMatch(/\[r[0-9a-z]{12}\] requirement · Limits: The refreshTokenTtl MUST be 14 days\./)
        expect(text).toContain("(drifted: the linked code changed since it was linked)")
        const prompt = buildReviewPrompt({
          mode: "full",
          trust: "trusted",
          base: "a".repeat(40),
          head: "b".repeat(40),
          diff: "diff --git a/src/upload.ts b/src/upload.ts",
          maxComments: 10,
          requirements: text!,
        })
        expect(prompt).toContain("<untrusted_linked_requirements>")
        expect(prompt).toContain("(code says 64 MB)")
        expect(prompt).toContain("cite its [id]")
      }),
    { git: true },
    60_000,
  )

  it.instance(
    "a model that may train gets none of a private document, and a change to unlinked files gets nothing",
    () =>
      Effect.gen(function* () {
        yield* setup("upload")
        const place = yield* (yield* Instruction.Service).place()
        expect(
          yield* ReviewContext.requirements({ place, files: ["src/upload.ts"], personal: false }),
        ).toBeUndefined()
        expect(yield* ReviewContext.requirements({ place, files: ["README.md"], personal: true })).toBeUndefined()
        // Nothing to say, nothing in the prompt.
        const prompt = buildReviewPrompt({
          mode: "full",
          trust: "trusted",
          base: "a".repeat(40),
          head: "b".repeat(40),
          diff: "diff --git a/README.md b/README.md",
          maxComments: 10,
        })
        expect(prompt).not.toContain("linked_requirements")
      }),
    { git: true },
    60_000,
  )

  it.instance(
    "held content never reaches a review, and a forgotten document takes its links with it",
    () =>
      Effect.gen(function* () {
        const { knowledge } = yield* setup("agent", "web")
        const place = yield* (yield* Instruction.Service).place()
        const [document] = yield* knowledge.documents(place, { personal: true })
        expect(document!.status).toBe("held")
        const files = ["src/upload.ts", "src/auth/session.ts"]
        expect(yield* knowledge.links(place, "src/upload.ts", { personal: true })).not.toEqual([])
        expect(yield* ReviewContext.requirements({ place, files, personal: true })).toBeUndefined()
        yield* knowledge.update(place, document!.id, { action: "approve" })
        expect(yield* ReviewContext.requirements({ place, files, personal: true })).toBeDefined()
        yield* knowledge.remove(place, document!.id)
        expect(yield* ReviewContext.requirements({ place, files, personal: true })).toBeUndefined()
      }),
    { git: true },
    60_000,
  )
})

describe("SF-26 Brain cards", () => {
  it.instance(
    "SF-26 read-only search leaves usage and last_used_at intact",
    () =>
      Effect.gen(function* () {
        const { knowledge, place } = yield* setup("upload")
        const db = (yield* BrainDatabase.Service).db
        const usage = () =>
          db
            .select({ id: BrainItemTable.id, uses: BrainItemTable.uses, last: BrainItemTable.last_used_at })
            .from(BrainItemTable)
            .orderBy(BrainItemTable.id)
            .all()
            .pipe(Effect.orDie)
        const before = yield* usage()
        const matches = yield* knowledge.search(place, {
          query: "refreshTokenTtl",
          limit: 3,
          personal: true,
          readOnly: true,
        })
        expect(matches.length).toBeGreaterThan(0)
        expect(yield* usage()).toEqual(before)
        yield* knowledge.search(place, { query: "refreshTokenTtl", limit: 3, personal: true })
        expect(yield* usage()).not.toEqual(before)
      }),
    { git: true },
    30_000,
  )

  const native = process.platform === "linux" ? it.instance : it.instance.skip
  native(
    "SF-26 local card evaluation uses synthetic base-commit documents and isolates personal cards",
    () =>
      Effect.gen(function* () {
        const directory = (yield* TestInstance).directory
        const fs = yield* FSUtil.Service
        const { knowledge, place } = yield* setup("upload")
        const file = "src/upload.ts"
        const git = (...args: string[]) =>
          Effect.promise(() => $`git ${args}`.cwd(directory).quiet().text()).pipe(Effect.map((text) => text.trimEnd()))
        yield* fs.writeWithDirs(path.join(directory, "docs/review.md"), "The checked-in upload limit is 20 bytes.")
        yield* fs.writeWithDirs(path.join(directory, "docs/other.md"), "UNRELATED_DOC_TEXT")
        const manifest = {
          files: [
            { path: "docs/review.md", description: "Upload policy", scope: "src/**" },
            { path: "docs/other.md", description: "Other", scope: "other/**" },
          ],
        }
        yield* fs.writeWithDirs(path.join(directory, ".vector/files.json"), JSON.stringify(manifest))
        yield* git("add", ".")
        yield* git("commit", "-qm", "base documents")
        const base = yield* git("rev-parse", "HEAD")
        yield* fs.writeWithDirs(path.join(directory, file), "export const MAX_UPLOAD_BYTES = 1000\n")
        yield* fs.writeWithDirs(path.join(directory, "docs/review.md"), "FORGED_HEAD_CARD")
        yield* git("add", ".")
        yield* git("commit", "-qm", "change uploaded bytes and forge documentation")
        const head = yield* git("rev-parse", "HEAD")
        const files = parseUnifiedDiff(yield* git("diff", base, head, "--", file))
        const common = {
          directory,
          place,
          head,
          base,
          files,
          denied: () => false,
          personal: true,
          trust: "trusted" as const,
          shared: false,
        }
        const gather = (changes: Partial<ReviewContext.CardsInput> = {}) =>
          ReviewContext.cards({ ...common, ...changes, deadline: performance.now() + 15_000 })
        // A private upload may move onto a matching document's working-tree path. Its visibility and
        // provenance come from the store; repository excerpts still have to exist in the exact base.
        const localSource = path.join(directory, "private-note.md")
        const localText = "MAX_UPLOAD_BYTES MUST include the private second dispatch envelope."
        yield* fs.writeWithDirs(localSource, localText)
        const moved = yield* knowledge.add(place, { type: "path", path: localSource, origin: "upload" })
        if (moved.type === "refused") throw new Error(moved.message)
        yield* knowledge.wait(place, moved.document.id, "searchable", 20_000)
        yield* Effect.promise(() => rename(localSource, path.join(directory, "docs/review.md")))
        const privateRows = yield* gather()
        expect(privateRows.some((row) => row.personal)).toBe(true)
        expect(privateRows.length).toBeLessThanOrEqual(3)
        expect(privateRows.every((row) => Array.from(row.text).length <= 160)).toBe(true)
        const shared = yield* gather({ shared: true })
        expect(shared.length).toBeGreaterThan(0)
        expect(shared.every((row) => !row.personal)).toBe(true)
        expect(JSON.stringify(shared)).toContain("20 bytes")
        expect(JSON.stringify(shared)).not.toMatch(
          /FORGED_HEAD_CARD|UNRELATED_DOC_TEXT|50 MB|private second dispatch envelope/,
        )
        const fork = yield* gather({ trust: "untrusted" })
        expect(fork).toEqual(shared)
        const denied = yield* gather({ shared: true, denied: (path) => path === "docs/review.md" })
        expect(denied).toEqual([])
        const personal = privateRows.find((row) => row.personal)!
        const sessionID = "ses_sf26_posting_fixture"
        yield* (yield* Brain.Service).used([personal.id], { sessionID, tier: "review", tokens: 30 })
        const checked = yield* BrainPosting.run(place, {
          sessionIDs: [sessionID],
          parts: [personal.text],
          typed: false,
          known: () => Effect.succeed(new Set<string>()),
        })
        expect(checked.status).toBe("changed")
        expect(checked.parts.join("\n")).not.toContain(personal.text)
        yield* knowledge.remove(place, moved.document.id)
        expect(yield* gather({ shared: true })).toEqual(shared)
        // A later comparison uses the now-committed document at its own base, even in this same process.
        yield* fs.writeWithDirs(path.join(directory, file), "export const MAX_UPLOAD_BYTES = 2000\n")
        yield* git("add", file)
        yield* git("commit", "-qm", "next card review base")
        const nextHead = yield* git("rev-parse", "HEAD")
        const newer = yield* gather({
          base: head,
          head: nextHead,
          files: parseUnifiedDiff(yield* git("diff", head, nextHead, "--", file)),
          shared: true,
        })
        expect(JSON.stringify(newer)).toContain("FORGED_HEAD_CARD")
        expect(JSON.stringify(newer)).not.toContain("20 bytes")
        expect(
          scopedSources(
            { files: [{ path: "../secret", description: "outside", scope: "src/**" }, {path:"docs/unscoped.md",description:"missing scope"}, ...manifest.files] },
            [file],
            () => false,
          ).map((row) => row.path),
        ).toEqual(["docs/review.md"])
      }),
    { git: true },
    90_000,
  )
})
