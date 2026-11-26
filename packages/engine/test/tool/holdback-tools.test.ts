import { afterEach, describe, expect } from "bun:test"
import path from "path"
import { Cause, Effect, Exit, Layer } from "effect"
import { LayerNode } from "@vectordevai/core/effect/layer-node"
import { CrossSpawnSpawner } from "@vectordevai/core/cross-spawn-spawner"
import { FSUtil } from "@vectordevai/core/fs-util"
import { Ripgrep } from "@vectordevai/core/ripgrep"
import { reviewPermissionRules } from "@vectordevai/core/review/permission"
import { PermissionV1 } from "@vectordevai/core/v1/permission"
import { Agent } from "../../src/agent/agent"
import { Git } from "@/git"
import { LSP } from "@/lsp/lsp"
import { Permission } from "../../src/permission"
import { Instruction } from "../../src/session/instruction"
import { MessageID, SessionID } from "../../src/session/schema"
import { GlobTool } from "../../src/tool/glob"
import { GrepTool } from "../../src/tool/grep"
import { ReadTool } from "../../src/tool/read"
import { Truncate } from "@/tool/truncate"
import type { Tool } from "@/tool/tool"
import { disposeAllInstances, provideInstance, testInstanceStoreLayer, tmpdirScoped } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

// VS-34's tool half (SF-14) at the read, grep and glob tools, given the context the session runtime builds for a review
// session under holdback "secrets": `extra.holdback` and the session's rules, which deny the credential files and the
// held paths. The runtime's own wiring of that context is test/session/holdback-tools.test.ts's. Token-like literals
// and private key headers are assembled at run time, so none sits in the source.

afterEach(async () => {
  await disposeAllInstances()
})

const it = testEffect(
  Layer.mergeAll(
    LayerNode.compile(
      LayerNode.group([
        Agent.node,
        FSUtil.node,
        CrossSpawnSpawner.node,
        Instruction.node,
        LSP.node,
        Ripgrep.node,
        Truncate.node,
        Git.node,
      ]),
    ),
    testInstanceStoreLayer,
  ),
)

const T = {
  ghp: "ghp_" + "h1T2".repeat(9),
  akia: "AKIA" + "H7Q2W4E6R8T0Y1U3",
  npm: "npm_" + "k7E8".repeat(9),
  glpat: "glpat-" + "t1O2o3L4s5X6y7Z8w9V0",
}
const [pkBegin, pkEnd] = ["BEGIN", "END"].map((word) => `-----${word} RSA ${"PRIVATE"} KEY-----`)
const keyBody = Array.from(
  { length: 30 },
  (_, index) => `${"M".repeat(8)}${String(index).padStart(2, "0")}${"q4W5".repeat(13)}x`,
)

const base = {
  sessionID: SessionID.make("ses_holdback_tools"),
  messageID: MessageID.make("msg_holdback_tools"),
  callID: "",
  agent: "review",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => Effect.void,
}

// The context of a review session whose rules are `rules`: asks and listing checks answer from them, as the session
// runtime's do, and `holdback` is what the runtime sets for rules that hold back.
function context(
  rules: PermissionV1.Rule[],
  options: { holdback?: boolean; ask?: "rules" | "allow" } = {},
): Tool.Context {
  const denied = (request: { permission: string; patterns: readonly string[] }) =>
    request.patterns.filter((pattern) => Permission.evaluate(request.permission, pattern, rules).action === "deny")
  return {
    ...base,
    extra: options.holdback === false ? {} : { holdback: "secrets" },
    deniedResources: (request) => Effect.succeed(denied(request)),
    ask: (request) => {
      const refused = options.ask === "allow" ? undefined : denied(request)[0]
      if (!refused) return Effect.void
      return Effect.die(
        new PermissionV1.DeniedError({ ruleset: rules, permission: request.permission, pattern: refused }),
      )
    },
  }
}

const HELD = reviewPermissionRules({ holdback: "secrets", held: ["notes.txt", ".envrc"] })
const held = context(HELD)
// The same review without the key: the rules and context of today's review sessions.
const unset = context(reviewPermissionRules({}), { holdback: false })

const write = Effect.fn("HoldbackToolsTest.write")(function* (dir: string, files: Record<string, string | Uint8Array>) {
  const fs = yield* FSUtil.Service
  for (const [file, content] of Object.entries(files)) yield* fs.writeWithDirs(path.join(dir, file), content)
})

const read = (dir: string, args: { filePath: string; offset?: number; limit?: number }, next: Tool.Context) =>
  provideInstance(dir)(
    Effect.gen(function* () {
      const tool = yield* (yield* ReadTool).init()
      return yield* tool.execute({ ...args, filePath: path.join(dir, args.filePath) }, next)
    }),
  )

const grep = (dir: string, args: { pattern: string; path?: string; include?: string }, next: Tool.Context) =>
  provideInstance(dir)(
    Effect.gen(function* () {
      const tool = yield* (yield* GrepTool).init()
      return yield* tool.execute(args, next)
    }),
  )

const glob = (dir: string, args: { pattern: string; path?: string }, next: Tool.Context) =>
  provideInstance(dir)(
    Effect.gen(function* () {
      const tool = yield* (yield* GlobTool).init()
      return yield* tool.execute(args, next)
    }),
  )

const failure = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.exit,
    Effect.map((exit) => {
      if (Exit.isSuccess(exit)) throw new Error("expected the tool to fail")
      const error = Cause.squash(exit.cause)
      return error instanceof Error ? error.message : String(error)
    }),
  )

const REFUSED = 'may hold credentials, so this review does not read it (holdback "secrets"); nothing was read.'

describe("the read tool under holdback (VS-34, SF-14)", () => {
  it.live("redacts a token in a file it may read, in the output, the preview and the display; unset returns it", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped({ git: true })
      yield* write(dir, {
        "src/config.ts": `export const token = "${T.ghp}"\nexport const url = process.env.API_URL\n`,
      })
      const result = yield* read(dir, { filePath: "src/config.ts" }, held)
      expect(JSON.stringify(result)).not.toContain(T.ghp)
      expect(result.output).toContain('1: export const token = "[redacted]"')
      expect(result.output).toContain("2: export const url = process.env.API_URL")
      expect(result.metadata.preview).toContain("[redacted]")
      expect(result.metadata.display).toMatchObject({ type: "file", lineStart: 1 })
      const plain = yield* read(dir, { filePath: "src/config.ts" }, unset)
      expect(plain.output).toContain(T.ghp)
      // Without the key the output is what it was: every line as read.
      expect(plain.output.replace(T.ghp, "[redacted]")).toBe(result.output)
    }),
  )

  it.live("redacts a line whole before the 2,000-character cut, so no part of a token or one-line key is left", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped({ git: true })
      const escaped = `${pkBegin}\\n${keyBody.slice(0, 4).join("\\n")}\\n${pkEnd}\\n`
      yield* write(dir, {
        "dist/app.min.js": `${"x".repeat(1989)}"${T.ghp}"${"y".repeat(100)}\n`,
        "deploy/service-account.json": `{"pad": "${"p".repeat(1900)}", "private_key": "${escaped}"}\n`,
      })
      const cut = yield* read(dir, { filePath: "dist/app.min.js" }, held)
      expect(cut.output).toContain("(line truncated to 2000 chars)")
      expect(cut.output).not.toContain("ghp_")
      // Unset, the cut keeps the token's first ten characters, which no shape reads any more.
      expect((yield* read(dir, { filePath: "dist/app.min.js" }, unset)).output).toContain(T.ghp.slice(0, 10))
      const json = yield* read(dir, { filePath: "deploy/service-account.json" }, held)
      for (const line of keyBody.slice(0, 4)) expect(json.output).not.toContain(line.slice(0, 16))
      const raw = yield* read(dir, { filePath: "deploy/service-account.json" }, unset)
      expect(raw.output).toContain(keyBody[0].slice(0, 16))
    }),
  )

  it.live("redacts a private key's body in a read that starts inside it, from the lines before the offset", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped({ git: true })
      yield* write(dir, { "fixtures/key.txt": ["# test fixture", pkBegin, ...keyBody, pkEnd, "done"].join("\n") })
      const inside = yield* read(dir, { filePath: "fixtures/key.txt", offset: 12, limit: 5 }, held)
      expect(inside.output).toContain("12: [redacted]")
      for (const line of keyBody) expect(inside.output).not.toContain(line)
      const whole = yield* read(dir, { filePath: "fixtures/key.txt" }, held)
      for (const line of keyBody) expect(whole.output).not.toContain(line)
      expect(whole.output).toContain(`2: ${pkBegin}`)
      expect((yield* read(dir, { filePath: "fixtures/key.txt", offset: 12, limit: 5 }, unset)).output).toContain(
        keyBody[9],
      )
    }),
  )

  it.live(
    "refuses a credential file nested or in another case, and a held path, even when the ask lets it through",
    () =>
      Effect.gen(function* () {
        const dir = yield* tmpdirScoped({ git: true })
        yield* write(dir, {
          "config/prod/.envrc": `export TOKEN=${T.npm}\n`,
          "config/.ENVRC": `export TOKEN=${T.npm}\n`,
          "deploy/.netrc": "machine registry.example.test login ci password plain-words\n",
          "notes.txt": "export DB_PASS=plain-words-only\n",
        })
        // The rules refuse the listed and the held paths as written.
        for (const file of ["config/prod/.envrc", "deploy/.netrc", "notes.txt"]) {
          const message = yield* failure(read(dir, { filePath: file }, held))
          expect([file, message]).toEqual([file, expect.not.stringContaining("plain-words")])
          expect([file, message.includes("permission") || message.includes(REFUSED)]).toEqual([file, true])
        }
        // An ask that would let every read through still meets the case-folded rules: nothing is read.
        const lenient = context(HELD, { ask: "allow" })
        for (const file of ["config/prod/.envrc", "config/.ENVRC", "deploy/.netrc", "notes.txt"])
          expect([file, yield* failure(read(dir, { filePath: file }, lenient))]).toEqual([
            file,
            `${path.normalize(file)} ${REFUSED}`,
          ])
        // Give the case variant its own checkout so its stored name survives on case-insensitive volumes.
        const other = yield* tmpdirScoped({ git: true })
        yield* write(other, { "Notes.TXT": "export DB_PASS=plain-words-only\n" })
        expect(yield* failure(read(other, { filePath: "Notes.TXT" }, lenient))).toBe(`Notes.TXT ${REFUSED}`)
        expect((yield* read(other, { filePath: "Notes.TXT" }, unset)).output).toContain("plain-words-only")
        // With no way to read the rules, nothing is read either.
        const blind = { ...lenient, deniedResources: undefined }
        expect(yield* failure(read(dir, { filePath: "src.txt" }, blind))).toBe(`src.txt ${REFUSED}`)
        // Unset, the same files are read as they are today.
        expect((yield* read(dir, { filePath: "config/prod/.envrc" }, unset)).output).toContain(T.npm)
        expect((yield* read(dir, { filePath: "notes.txt" }, unset)).output).toContain("plain-words-only")
      }),
  )

  // A held path in NFC whose file the platform names in NFD (macOS HFS+), or the other way round: the rules match
  // neither spelling of the other form, and the second check, which folds both to NFC, refuses it.
  it.live("refuses a held non-ASCII path in the other Unicode normal form, and grep does not search it", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped({ git: true })
      const nfc = "docs/\u00e9-notes.txt"
      const nfd = "docs/e\u0301-notes.txt"
      yield* write(dir, { [nfd]: "export DB_PASS=plain-words-only # needle\n" })
      for (const held of [nfc, nfd]) {
        // An ask that lets every read through: the second check folds both spellings to the held path's NFC form.
        const lenient = context(reviewPermissionRules({ holdback: "secrets", held: [held] }), { ask: "allow" })
        for (const file of [nfc, nfd])
          expect([held, file, yield* failure(read(dir, { filePath: file }, lenient))]).toEqual([
            held,
            file,
            `${path.normalize(file)} ${REFUSED}`,
          ])
        expect([held, (yield* grep(dir, { pattern: "needle", path: "docs" }, lenient)).output]).toEqual([
          held,
          "No files found",
        ])
      }
      expect((yield* read(dir, { filePath: nfd }, unset)).output).toContain("plain-words-only")
      expect((yield* grep(dir, { pattern: "needle", path: "docs" }, unset)).output).toContain("plain-words-only")
    }),
  )

  it.live("refuses an image or a PDF, which cannot be redacted, and reads it unset", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped({ git: true })
      const png = Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==",
        "base64",
      )
      yield* write(dir, { "docs/screen.png": png, "docs/spec.pdf": "%PDF-1.4\n%fake\n" })
      for (const file of ["docs/screen.png", "docs/spec.pdf"])
        expect(yield* failure(read(dir, { filePath: file }, held))).toBe(
          `${path.normalize(file)} is an image or a PDF, which cannot be redacted, so this review does not read it (holdback "secrets"); nothing was read.`,
        )
      expect((yield* read(dir, { filePath: "docs/screen.png" }, unset)).attachments).toHaveLength(1)
    }),
  )

  it.live("redacts the instructions it loads beside a file, and the entries of a directory it lists", () =>
    Effect.gen(function* () {
      const files = {
        "pkg/AGENTS.md": `# Notes\nDeploy with ${T.glpat}.\n`,
        "pkg/src/index.ts": "export const one = 1\n",
        [`pkg/${T.akia}.txt`]: "named after a key\n",
      }
      const dir = yield* tmpdirScoped({ git: true })
      yield* write(dir, files)
      const result = yield* read(dir, { filePath: "pkg/src/index.ts" }, held)
      expect(result.output).toContain("system-reminder")
      expect(result.output).toContain("Deploy with [redacted].")
      expect(result.output).not.toContain(T.glpat)
      // An instruction file loads once per conversation, so the unset read is of another checkout.
      const other = yield* tmpdirScoped({ git: true })
      yield* write(other, files)
      expect((yield* read(other, { filePath: "pkg/src/index.ts" }, unset)).output).toContain(T.glpat)
      const listed = yield* read(dir, { filePath: "pkg" }, held)
      expect(JSON.stringify(listed)).not.toContain(T.akia)
      expect(listed.output).toContain("[redacted].txt")
    }),
  )
})

describe("the grep tool under holdback (VS-34, SF-14)", () => {
  const tree = {
    "config/.envrc": `export TOKEN=${T.npm} # needle\n`,
    "config/prod/.envrc": `export TOKEN=${T.npm} # needle\n`,
    "deploy/.netrc": "machine registry.example.test login ci # needle\n",
    "notes.txt": "export DB_PASS=plain-words-only # needle\n",
    "src/config.ts": [
      `export const token = "${T.ghp}" // needle`,
      "export const url = process.env.API_URL // needle",
      "export const mode = process.env.MODE",
    ].join("\n"),
    "fixtures/key.txt": ["# needle fixture", pkBegin, ...keyBody, pkEnd].join("\n"),
  }

  it.live(
    "a directory grep returns no line from a credential or held file, and withholds lines that hold a value",
    () =>
      Effect.gen(function* () {
        const dir = yield* tmpdirScoped({ git: true })
        yield* write(dir, tree)
        const result = yield* grep(dir, { pattern: "needle|M{8}" }, held)
        for (const file of ["config/.envrc", "config/prod/.envrc", "deploy/.netrc", "notes.txt"])
          expect([file, result.output.replaceAll("\\", "/").includes(file)]).toEqual([file, false])
        for (const value of [T.npm, T.ghp, "plain-words-only", "login ci", ...keyBody.map((line) => line.slice(0, 16))])
          expect([value, result.output.includes(value)]).toEqual([value, false])
        // The lines without a value are shown, the key's header and comment among them.
        expect(result.output).toContain("Line 2: export const url = process.env.API_URL // needle")
        expect(result.output).toContain("Line 1: # needle fixture")
        expect(result.output).toStartWith("Found 2 matches")
        // Unset, the same search shows them all but the files today's rules deny.
        const plain = yield* grep(dir, { pattern: "needle|M{8}" }, unset)
        expect(plain.output).toContain(T.ghp)
        expect(plain.output).toContain(keyBody[0])
        expect(plain.output).toContain("notes.txt")
      }),
  )

  it.live("a search for process.env is allowed, and a search for a token's first characters finds nothing", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped({ git: true })
      yield* write(dir, tree)
      const env = yield* grep(dir, { pattern: "process.env" }, held)
      expect(env.output).toContain(`${path.join("src", "config.ts")}:`)
      expect(env.output).toContain("Line 3: export const mode = process.env.MODE")
      // Whether a probe matched inside the value is never told: the line is withheld, not shown redacted.
      for (const pattern of [T.ghp.slice(0, 8), `${T.ghp.slice(0, 8)}|process.env.MODE`, "h1T2h1T2"]) {
        const probe = yield* grep(dir, { pattern, path: "src" }, held)
        expect([pattern, probe.output.includes("Line 1")]).toEqual([pattern, false])
        expect([pattern, probe.output.includes("[redacted]")]).toEqual([pattern, false])
      }
      expect((yield* grep(dir, { pattern: T.ghp.slice(0, 8) }, held)).output).toBe("No files found")
      expect((yield* grep(dir, { pattern: T.ghp.slice(0, 8) }, unset)).output).toContain(T.ghp)
    }),
  )

  it.live("refuses a credential file named directly, in another case too, and shows a long line's match whole", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped({ git: true })
      yield* write(dir, {
        ...tree,
        "config/staging/.ENVRC": `export TOKEN=${T.npm} # needle\n`,
        "dist/app.min.js": `${"a".repeat(2600)}needle${"b".repeat(50)}\n${"c".repeat(1989)} ${T.akia} needle\n`,
      })
      for (const file of ["config/.envrc", "config/prod/.envrc", "notes.txt"])
        expect(Exit.isFailure(yield* grep(dir, { pattern: "needle", path: file }, held).pipe(Effect.exit))).toBe(true)
      const lenient = context(HELD, { ask: "allow" })
      expect(yield* failure(grep(dir, { pattern: "needle", path: "config/staging/.ENVRC" }, lenient))).toBe(
        'config/staging/.ENVRC may hold credentials, so this review does not search it (holdback "secrets"); nothing was read.',
      )
      expect((yield* grep(dir, { pattern: "needle", path: "config/staging/.ENVRC" }, unset)).output).toContain(T.npm)
      expect((yield* grep(dir, { pattern: "needle", path: "config" }, lenient)).output).toBe("No files found")
      // A match past ripgrep's 2,000-character cut is shown from the whole line; a line with a value is withheld, so
      // no part of the key ID is left by any cut.
      const long = yield* grep(dir, { pattern: "needle", path: "dist" }, held)
      expect(long.output).toContain(`Line 1: …${"a".repeat(444)}needle${"b".repeat(50)}`)
      expect(long.output).not.toContain("AKIA")
      expect(long.output).toStartWith("Found 1 matches")
    }),
  )

  it.live("redacts a file over the size cap a line at a time, and gives no line ripgrep cut", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped({ git: true })
      yield* write(dir, {
        "data/big.log": [
          "first needle line",
          `token ${T.ghp} needle`,
          `${"z".repeat(2500)} needle`,
          ...Array.from({ length: 12_000 }, (_, index) => `filler line ${index} ${"f".repeat(80)}`),
        ].join("\n"),
      })
      const result = yield* grep(dir, { pattern: "needle", path: "data" }, held)
      expect(result.output).toContain("Line 1: first needle line")
      expect(result.output).not.toContain(T.ghp)
      expect(result.output).not.toContain("Line 3:")
      expect((yield* grep(dir, { pattern: "needle", path: "data" }, unset)).output).toContain("Line 3:")
    }),
  )

  // Design item 2's backstop stands apart from the session's rules: a path holdback itself holds back gives no line,
  // even where the rules (here a review's without the key's denies) let grep search it. A template is not one.
  it.live("withholds every line of a listed path even when the session's rules let grep search it", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped({ git: true })
      yield* write(dir, {
        "config/.envrc": "export MODE=dev # needle\n",
        "deploy/.netrc": "machine registry.example.test login ci # needle\n",
        "keys/id_ed25519": "comment needle\n",
        ".env.example": "MODE= # needle\n",
        "src/a.ts": "export const a = 1 // needle\n",
      })
      const result = yield* grep(dir, { pattern: "needle" }, context(reviewPermissionRules({})))
      for (const file of ["config/.envrc", "deploy/.netrc", "keys/id_ed25519"])
        expect([file, result.output.replaceAll("\\", "/").includes(file)]).toEqual([file, false])
      expect(result.output).toContain(`${path.join("src", "a.ts")}:`)
      expect(result.output).toContain(".env.example:")
      expect(result.output).toStartWith("Found 2 matches")
      expect((yield* grep(dir, { pattern: "needle" }, unset)).output).toContain(path.join("deploy", ".netrc"))
    }),
  )

  // A change can commit many files whose matching lines are all withheld. One search reads at most 16 MiB of them
  // again: 16 files of about 1 MB are all read and give nothing; a 17th stops the search, which then reads as
  // truncated rather than as finding nothing.
  it.live("stops reading files again at its byte budget, and reads as truncated", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped({ git: true })
      const file = [`token ${T.ghp} needle`, ...Array.from({ length: 9_999 }, () => "f".repeat(99))].join("\n")
      expect(file.length).toBeLessThan(1024 * 1024)
      yield* write(dir, Object.fromEntries(Array.from({ length: 16 }, (_, index) => [`logs/${index}.log`, file])))
      const within = yield* grep(dir, { pattern: "needle", path: "logs" }, held)
      expect(within.output).toBe("No files found")
      expect(within.metadata.truncated).toBe(false)
      yield* write(dir, { "logs/16.log": file })
      const over = yield* grep(dir, { pattern: "needle", path: "logs" }, held)
      expect(over.output).toStartWith("Found 0 matches (more matches available)")
      expect(over.output).toContain("(Results truncated.")
      expect(over.metadata.truncated).toBe(true)
      expect(over.output).not.toContain(T.ghp)
      expect((yield* grep(dir, { pattern: "needle", path: "logs" }, unset)).output).toStartWith("Found 17 matches")
    }),
  )
})

describe("the glob tool under holdback (VS-34, SF-14)", () => {
  it.live("redacts a file name that spells a token, as read redacts a directory's entries, and lists it unset", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped({ git: true })
      yield* write(dir, { [`pkg/${T.akia}.txt`]: "named after a key\n", "pkg/notes.txt": "plain\n" })
      const result = yield* glob(dir, { pattern: "*.txt", path: "pkg" }, held)
      expect(JSON.stringify(result)).not.toContain(T.akia)
      expect(result.output.split("\n").toSorted()).toEqual([
        path.join("pkg", "[redacted].txt"),
        path.join("pkg", "notes.txt"),
      ])
      expect(result.metadata.count).toBe(2)
      expect((yield* glob(dir, { pattern: "*.txt", path: "pkg" }, unset)).output).toContain(
        path.join("pkg", `${T.akia}.txt`),
      )
    }),
  )
})
