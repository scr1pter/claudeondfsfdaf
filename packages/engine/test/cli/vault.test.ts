import { describe, expect } from "bun:test"
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
import { Git } from "../../src/git"
import { gitRunner, send } from "../../src/cli/cmd/vault"
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
})
