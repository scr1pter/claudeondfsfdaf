import { describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import fs from "node:fs/promises"
import path from "node:path"
import { Effect } from "effect"
import { LayerNode } from "@vectordevai/core/effect/layer-node"
import { Global } from "@vectordevai/core/global"
import { Egress } from "@vectordevai/core/local-mode/egress"
import { LocalPolicy } from "@vectordevai/core/local-mode/policy"
import { VaultError } from "@vectordevai/core/vault/error"
import { VaultGitHub } from "@vectordevai/core/vault/github"
import { VaultBackup } from "@vectordevai/core/vault/vault"
import { Vault } from "@vectordevai/schema/vault"
import { Git } from "../../src/git"
import { gitRunner, restoredLine, restoreTotals, send } from "../../src/cli/cmd/vault"
import { tmpdir } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

// `vector vault --github` as the CLI wires it: git through the engine's Git.run (stdin and environment included), and
// the privacy check through the brain-vault source, which Vector Local blocks. The remote is a bare repository on this
// computer; nothing reaches GitHub.

const it = testEffect(LayerNode.compile(LayerNode.group([Git.node])))
const encoder = new TextEncoder()
const ISOLATED = { GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" }

const bare = (dir: string) => {
  const result = spawnSync("git", ["init", "--bare", "-q", "-b", "main", dir], { env: { ...process.env, ...ISOLATED } })
  if (result.status !== 0) throw new Error(result.stderr.toString())
}

describe("vector vault --github", () => {
  it.live("backs up and restores through Git.run, checking the repository is private before the push", () =>
    Effect.gen(function* () {
      const tmp = yield* Effect.acquireRelease(
        Effect.promise(() => tmpdir()),
        (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()),
      )
      yield* Effect.promise(() => fs.mkdir(Global.Path.cache, { recursive: true }))
      const remote = path.join(tmp.path, "remote.git")
      bare(remote)
      const checks: string[] = []
      const git = yield* Git.Service
      const store = (name: string) =>
        VaultGitHub.store({
          repo: "octo/brain-vault",
          remote,
          api: "https://api.github.test",
          dir: path.join(tmp.path, name),
          git: gitRunner(git),
          send: async (url) => {
            checks.push(url)
            return new Response(null, { status: 404 })
          },
        })
      const first = store("cache-a")
      const created = yield* Effect.promise(() => VaultBackup.create(first, { cost: 2 ** 14 }))
      const files = [{ path: "memory/personal.json", section: "memory" as const, bytes: encoder.encode("I prefer tables"), repository: "" }]
      yield* Effect.promise(() => VaultBackup.backup({ store: first, opened: created, files }))
      expect(checks).toEqual(["https://api.github.test/repos/octo/brain-vault"])
      const other = store("cache-b")
      const opened = yield* Effect.promise(() => VaultBackup.unlock(other, created.code))
      const read = yield* Effect.promise(() => VaultBackup.read({ store: other, opened }))
      expect(read.files[0]!.bytes.toString("utf8")).toBe("I prefer tables")
    }).pipe(Effect.scoped),
  )

  it.live("with Vector Local on, the privacy check is blocked and nothing is pushed", () =>
    Effect.gen(function* () {
      const tmp = yield* Effect.acquireRelease(
        Effect.promise(() => tmpdir()),
        (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()),
      )
      yield* Effect.promise(() => fs.mkdir(Global.Path.cache, { recursive: true }))
      const remote = path.join(tmp.path, "remote.git")
      bare(remote)
      const git = yield* Git.Service
      const store = VaultGitHub.store({
        repo: "octo/brain-vault",
        remote,
        api: "https://api.github.com",
        dir: path.join(tmp.path, "cache"),
        git: gitRunner(git),
        send,
      })
      Egress.configure(LocalPolicy.resolve({ global: { enabled: true } }))
      const refused = yield* Effect.promise(async () => {
        const created = await VaultBackup.create(store, { cost: 2 ** 14 })
        return VaultBackup.backup({
          store,
          opened: created,
          files: [{ path: "memory/personal.json", section: "memory", bytes: encoder.encode("x"), repository: "" }],
        }).catch((error: unknown) => error)
      }).pipe(Effect.ensuring(Effect.sync(() => Egress.configure(LocalPolicy.OFF))))
      expect(refused).toBeInstanceOf(VaultError)
      expect((refused as VaultError).code).toBe("public-repo")
      expect((refused as Error).message).toStartWith("Vector Local blocked a connection to api.github.com.")
      const heads = spawnSync("git", ["--git-dir", remote, "for-each-ref"], { env: { ...process.env, ...ISOLATED } })
      expect(heads.stdout.toString()).toBe("")
    }).pipe(Effect.scoped),
  )

  it.live(
    "learned sections keep their section, repository and worktree through git and ask for reader two; memory alone asks for reader one (B10)",
    () =>
      Effect.gen(function* () {
        const tmp = yield* Effect.acquireRelease(
          Effect.promise(() => tmpdir()),
          (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()),
        )
        yield* Effect.promise(() => fs.mkdir(Global.Path.cache, { recursive: true }))
        const remote = path.join(tmp.path, "remote.git")
        bare(remote)
        const git = yield* Git.Service
        const store = (name: string) =>
          VaultGitHub.store({
            repo: "octo/brain-vault",
            remote,
            api: "https://api.github.test",
            dir: path.join(tmp.path, name),
            git: gitRunner(git),
            send: async () => new Response(null, { status: 404 }),
          })
        const first = store("cache-a")
        const created = yield* Effect.promise(() => VaultBackup.create(first, { cost: 2 ** 14 }))
        // The paths and sections VaultMemory.files gives a repository's files.
        const learned = [
          {
            path: "memory/personal.json",
            section: "memory" as const,
            bytes: encoder.encode("I prefer tables"),
            repository: "",
          },
          {
            path: "skills/repository-0123456789abcdef01234567.json",
            section: "skills" as const,
            bytes: encoder.encode('{"skills":[]}'),
            repository: "prj_a",
            worktree: "/repo",
          },
          {
            path: "insights/repository-0123456789abcdef01234567.json",
            section: "insights" as const,
            bytes: encoder.encode('{"rows":[]}'),
            repository: "prj_a",
            worktree: "/repo",
          },
        ]
        yield* Effect.promise(() =>
          VaultBackup.backup({ store: first, opened: created, files: learned, now: 1_763_000_000_000 }),
        )
        const other = store("cache-b")
        const opened = yield* Effect.promise(() => VaultBackup.unlock(other, created.code))
        const read = yield* Effect.promise(() => VaultBackup.read({ store: other, opened }))
        expect(read.manifest.minReader).toBe(Vault.LEARNED_READER)
        expect(
          read.files.map(({ file, bytes }) => ({
            path: file.path,
            section: file.section,
            repository: file.repository,
            worktree: file.worktree,
            text: bytes.toString("utf8"),
          })),
        ).toEqual(
          learned.map((file) => ({
            path: file.path,
            section: file.section,
            repository: file.repository,
            worktree: file.worktree,
            text: new TextDecoder().decode(file.bytes),
          })),
        )
        const memoryOnly = yield* Effect.promise(() =>
          VaultBackup.backup({ store: first, opened: created, files: learned.slice(0, 1), now: 1_763_000_060_000 }),
        )
        // A store reads the remote once (core vault/github.ts sync), so the newer version is read through a fresh one.
        const newest = yield* Effect.promise(() =>
          VaultBackup.read({ store: store("cache-c"), opened, version: memoryOnly.snapshot.id }),
        )
        expect(newest.manifest.minReader).toBe(Vault.MIN_READER)
        expect(newest.files.map(({ file }) => file.section)).toEqual(["memory"])
        // Either learned section alone asks for reader two (core vault/vault.ts: skills or insights).
        for (const [index, files] of [
          [learned[0]!, learned[1]!],
          [learned[0]!, learned[2]!],
        ].entries()) {
          const saved = yield* Effect.promise(() =>
            VaultBackup.backup({ store: first, opened: created, files, now: 1_763_000_120_000 + index * 60_000 }),
          )
          const back = yield* Effect.promise(() =>
            VaultBackup.read({ store: store(`cache-learned-${index}`), opened, version: saved.snapshot.id }),
          )
          expect([back.manifest.minReader, back.files.map(({ file }) => file.section)]).toEqual([
            Vault.LEARNED_READER,
            files.map((file) => file.section),
          ])
        }
      }).pipe(Effect.scoped),
  )
})

describe("vector vault restore's lines (B10)", () => {
  const counts = { restored: 0, active: 0, pinned: 0, waiting: 0, known: 0, refused: 0, batches: 1, documents: 0 }

  test("the tally counts learned skills and workflow insights apart, to review, never as waiting as before", () => {
    // VaultMemory.restore answers a learned file as waiting: every skill and insight comes back a proposal.
    const total = restoreTotals([
      {
        section: "memory",
        done: { ...counts, unreadable: false, restored: 3, active: 1, pinned: 1, waiting: 2, known: 1 },
      },
      { section: "skills", done: { ...counts, unreadable: false, restored: 2, waiting: 2, refused: 1 } },
      { section: "insights", done: { ...counts, unreadable: false, restored: 1, waiting: 1 } },
      { section: "journal", done: { unreadable: true } },
    ])
    expect(total).toEqual({
      restored: 6,
      active: 1,
      pinned: 1,
      waiting: 2,
      skills: 2,
      insights: 1,
      known: 1,
      refused: 1,
      unreadable: 1,
      documents: 0,
    })
    const learned = restoreTotals([
      { section: "skills", done: { ...counts, unreadable: false, restored: 2, waiting: 2 } },
      { section: "insights", done: { ...counts, unreadable: false, restored: 1, waiting: 1 } },
    ])
    expect(learned.waiting).toBe(0)
    expect(restoredLine(learned)).toBe("2 learned skills to review, 1 workflow insight to review.")
  })

  test("the line says 'as before' for memory only, and names no memory for a learned-only restore", () => {
    const none = { active: 0, pinned: 0, waiting: 0, skills: 0, insights: 0 }
    expect(restoredLine({ ...none, skills: 2, insights: 1 })).toBe(
      "2 learned skills to review, 1 workflow insight to review.",
    )
    expect(restoredLine({ active: 1, pinned: 1, waiting: 2, skills: 1, insights: 0 })).toBe(
      "1 in use (1 pinned), 2 waiting for your review as before, 1 learned skill to review.",
    )
    expect(restoredLine(none)).toBe("0 in use, 0 waiting for your review as before.")
  })
})
