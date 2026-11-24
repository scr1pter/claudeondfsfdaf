import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import type { ReadOnlyGit } from "@vectordevai/core/read-only-git"
import { parseUnifiedDiff } from "@vectordevai/core/review/diff"
import { DEFAULT_REVIEW_CONFIG } from "@vectordevai/core/review/types"
import { ReviewGit } from "../../src/review/git"
import { ReviewTrivial } from "../../src/review/trivial"

const base = "a".repeat(40)
const head = "b".repeat(40)
const directory = "/vector-proof-fixture"
const config = { ...DEFAULT_REVIEW_CONFIG, trivial: "skip" as const }
const file = "docs/guide.md"
const patch = [
  "diff --git a/docs/guide.md b/docs/guide.md",
  "--- a/docs/guide.md",
  "+++ b/docs/guide.md",
  "@@ -1 +1 @@",
  "-Before.",
  "+After.",
  "",
].join("\n")
const input = { directory, base, head, files: parseUnifiedDiff(patch), config, instructions: [] }
const output = (code: number, text = "") => ({ code, bytes: Buffer.from(text) })

// This is the typed private port, not a fake Git subprocess. Its ordinary client is a tripwire. Core's verifier
// integration tests exercise the port's implementation against real file repositories.
function fixture(
  options: {
    names?: string
    patch?: string
    mode?: string
    show?: string
    ignored?: string
    attributes?: string
    reference?: number
    hasInfoRules?: boolean
    aliases?: { code: number; text?: string }
  } = {},
) {
  const reads: ReadOnlyGit.Read[] = []
  let open = true
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
      run: () => Effect.die("unexpected live Git command"),
      branch: () => Effect.die("unexpected branch read"),
      defaultBranch: () => Effect.die("unexpected default-branch read"),
    },
    preflight: () => (open ? Effect.void : Effect.fail(new ReviewGit.Refused({ message: "view closed" }))),
    repository: {
      ...metadata,
      hasInfoRules: options.hasInfoRules ?? false,
      isOpen: () => open,
      status: async () => ({ dirty: false, head }),
      close: async () => {
        open = false
      },
      shallow: false,
      read: async (operation) => {
        reads.push(operation)
        if (operation.kind === "unaliased-changes") return output(options.aliases?.code ?? 0, options.aliases?.text)
        if (operation.kind === "diff")
          return output(0, operation.names ? (options.names ?? file + "\0") : (options.patch ?? patch))
        if (operation.kind === "path-references") {
          if (operation.revision !== head || operation.file !== file) throw new Error("wrong search")
          return output(options.reference ?? 1)
        }
        if (operation.kind !== "tree" && operation.kind !== "show") throw new Error("unexpected private read")
        const actual =
          operation.file === file
            ? operation.revision === head
              ? (options.show ?? "After.\n")
              : "Before.\n"
            : operation.file === "docs/.gitignore"
              ? options.ignored
              : operation.file === ".gitattributes"
                ? options.attributes
                : undefined
        if (operation.kind === "tree")
          return output(
            0,
            actual === undefined
              ? ""
              : (operation.file === file && operation.revision === base ? (options.mode ?? "100644") : "100644") +
                  " blob " +
                  "c".repeat(40) +
                  "\t" +
                  operation.file +
                  "\0",
          )
        return actual === undefined || Buffer.byteLength(actual) > operation.maxBytes ? output(1) : output(0, actual)
      },
    },
  }
  return {
    reads,
    view,
    run: <A, E>(effect: Effect.Effect<A, E>) =>
      Effect.runPromise(effect.pipe(Effect.provideService(ReviewGit.Current, view))),
  }
}

describe("private trivial proof", () => {
  test("a complete two-sided doc change requires exact mode, blob bytes and a negative head reference search", async () => {
    const f = fixture()
    const proof = await f.run(ReviewTrivial.prove(input))
    expect(proof).toBeDefined()
    expect(await f.run(ReviewTrivial.kinds(proof!, input))).toEqual(["docs"])
    expect(f.reads).toContainEqual({ kind: "unaliased-changes", from: base, to: head, files: [file] })
    expect(f.reads.flatMap((read) => (read.kind === "show" && read.file === file ? [read.revision] : []))).toEqual([
      base,
      head,
    ])
    expect(f.reads).toContainEqual({ kind: "path-references", revision: head, file })
    expect(await f.run(ReviewTrivial.kinds({ ...proof! }, input))).toBeUndefined()
    expect(await f.run(ReviewTrivial.kinds(proof!, { ...input, base: head }))).toBeUndefined()
    expect(await f.run(ReviewTrivial.kinds(proof!, { ...input, files: [] }))).toBeUndefined()
    expect(
      await f.run(ReviewTrivial.kinds(proof!, { ...input, config: { ...config, ignore: [file] } })),
    ).toBeUndefined()
    expect(await fixture().run(ReviewTrivial.kinds(proof!, input))).toBeUndefined()
    await f.view.repository.close()
    expect(await f.run(ReviewTrivial.kinds(proof!, input))).toBeUndefined()
  })

  test("a hidden name, incomplete patch, unsupported mode, mismatched blob or uncertain reference cannot issue a proof", async () => {
    for (const options of [
      { names: file + "\0.env\0" },
      { names: file },
      { patch: patch.replace("+After.", "+Different.") },
      { mode: "100755" },
      { mode: "120000" },
      { mode: "160000" },
      { show: "does not match the patch\n" },
      { show: "After.\n" + "x".repeat(256 * 1024) },
      { reference: 0 },
      { reference: 2 },
      { hasInfoRules: true },
      { aliases: { code: 2 } },
      { aliases: { code: 0, text: "ambiguous" } },
      { ignored: "guide.md\n" },
      { attributes: "docs/*.md linguist-generated" },
      { attributes: "[attr]hidden linguist-vendored\ndocs/*.md hidden" },
    ]) {
      const f = fixture(options)
      expect(await f.run(ReviewTrivial.prove(input))).toBeUndefined()
      if ("names" in options) expect(f.reads.map((read) => read.kind)).toEqual(["diff"])
    }
  })

  test("instruction and restricted paths never request file contents", async () => {
    for (const restrictions of [
      { instructions: ["**/guide.md"] },
      { instructions: ["~/instructions/*.md"] },
      { instructions: ["../shared/guide.md"] },
      { instructions: ["https://instructions.invalid/guide.md"] },
      { denied: (path: string) => path === file },
    ]) {
      const f = fixture()
      expect(await f.run(ReviewTrivial.prove({ ...input, ...restrictions }))).toBeUndefined()
      expect(f.reads).toEqual([])
    }
  })

  test("a rename checks the old and new names in both trees before requesting content", async () => {
    const oldPath = "docs/old-guide.md"
    const rename = parseUnifiedDiff(
      [
        `diff --git a/${oldPath} b/${file}`,
        "similarity index 100%",
        `rename from ${oldPath}`,
        `rename to ${file}`,
        "",
      ].join("\n"),
    )
    const f = fixture({ names: [oldPath, file, ""].join("\0"), aliases: { code: 2 } })
    expect(await f.run(ReviewTrivial.prove({ ...input, files: rename }))).toBeUndefined()
    expect(f.reads).toEqual([
      { kind: "diff", names: true, from: base, to: head },
      { kind: "unaliased-changes", from: base, to: head, files: [oldPath, file] },
    ])
  })
})
