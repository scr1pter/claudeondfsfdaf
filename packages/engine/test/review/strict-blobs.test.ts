import { $ } from "bun"
import { describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { Effect } from "effect"
import { ReviewGit } from "../../src/review/git"
import { ReviewStrictBlobs } from "../../src/review/strict-blobs"
import { tmpdir } from "../fixture/fixture"

const native = process.platform === "linux" ? test : test.skip

describe("SF-19 private strict blobs", () => {
  native(
    "reads both immutable sides of a fork and distinguishes missing entries from withheld or unreadable evidence",
    async () => {
      await using tmp = await tmpdir({ git: true })
      const directory = tmp.path
      const git = (...args: string[]) => $`git ${args}`.cwd(directory).quiet().text()
      const write = (file: string, value: string | Uint8Array) => Bun.write(path.join(directory, file), value)
      await fs.mkdir(path.join(directory, "src"), { recursive: true })
      await write("src/old.ts", "before\r\n")
      await write("empty.ts", "")
      await write("oversize.ts", "x".repeat(1024 * 1024 + 1))
      await write("binary.dat", new Uint8Array([65, 0, 66]))
      await write("invalid.dat", new Uint8Array([0xe2, 0x28, 0xa1]))
      await write("private.ts", "const token = 'ghp_" + "a1B2".repeat(9) + "'\n")
      await write("skip.ts", "synthetic denied row\n")
      await write(".env", "SYNTHETIC=fixture-only\n")
      await fs.symlink("src", path.join(directory, "alias"))
      await git("add", "-A")
      await git("commit", "-qm", "base")
      const base = (await git("rev-parse", "HEAD")).trim()
      await git("mv", "src/old.ts", "src/new.ts")
      await write("src/new.ts", "after\r\n")
      await git("commit", "-qam", "head")
      const head = (await git("rev-parse", "HEAD")).trim()
      await git("checkout", "-q", base)
      await write("src/new.ts", "WORKTREE DECOY\n")
      const queries: string[] = []
      const input = {
        directory,
        base,
        head,
        holdback: "secrets" as const,
        denied: (name: string) => name === "skip.ts",
        requests: {
          head: [
            "src/new.ts",
            "src/old.ts",
            "src/missing.ts",
            "empty.ts",
            "oversize.ts",
            "binary.dat",
            "invalid.dat",
            "private.ts",
            "alias",
            "alias/file.ts",
            "skip.ts",
            ".env",
            "../outside.ts",
          ],
          base: ["src/old.ts", "src/new.ts"],
        },
      }
      const blobs = await Effect.runPromise(
        Effect.gen(function* () {
          const placement = yield* ReviewGit.metadata(directory)
          return yield* ReviewGit.within(
            placement,
            base,
            Effect.gen(function* () {
              const view = (yield* ReviewGit.Current)!
              return yield* ReviewStrictBlobs.read(input).pipe(
                Effect.provideService(ReviewGit.Current, {
                  ...view,
                  repository: {
                    ...view.repository,
                    read: (op, signal) => {
                      if (op.kind === "show" || op.kind === "tree") queries.push(op.file)
                      return view.repository.read(op, signal)
                    },
                  },
                }),
              )
            }),
          )
        }),
      )
      expect(blobs.head.get("src/new.ts")).toBe("after\r\n")
      expect(blobs.base.get("src/old.ts")).toBe("before\r\n")
      expect(blobs.head.get("empty.ts")).toBe("")
      for (const name of ["src/old.ts", "src/missing.ts"]) expect(blobs.head.get(name)).toEqual({ absent: true })
      expect(blobs.base.get("src/new.ts")).toEqual({ absent: true })
      for (const name of [
        "oversize.ts",
        "binary.dat",
        "invalid.dat",
        "private.ts",
        "alias",
        "alias/file.ts",
        "skip.ts",
        ".env",
        "../outside.ts",
      ])
        expect(blobs.head.get(name)).toBeNull()
      for (const name of ["skip.ts", ".env", "../outside.ts"]) expect(queries).not.toContain(name)
    },
    30_000,
  )

  test("a failed final preflight discards text already read from the private view", async () => {
    const base = "1".repeat(40)
    const head = "2".repeat(40)
    const directory = "/strict-evidence-fixture"
    const metadata = {
      directory,
      gitDirectory: directory + "/.git",
      commonDirectory: directory + "/.git",
      head,
      objectValidated: false as const,
    }
    let checks = 0
    let showed = false
    const view: ReviewGit.View = {
      metadata,
      preflight: () =>
        ++checks === 1 ? Effect.void : Effect.fail(new ReviewGit.Refused({ message: "fixture binding changed" })),
      client: {
        run: () => Effect.die("strict evidence reached the Git command client"),
        branch: () => Effect.die("strict evidence requested a branch"),
        defaultBranch: () => Effect.die("strict evidence requested a default branch"),
      },
      repository: {
        ...metadata,
        shallow: false,
        hasInfoRules: false,
        isOpen: () => true,
        status: async () => ({ head, dirty: false }),
        close: async () => {},
        read: async (operation) => {
          if (operation.kind === "resolve") return { code: 0, bytes: Buffer.from(operation.revision + "\n") }
          if (operation.kind === "show") {
            showed = true
            return { code: 0, bytes: Buffer.from("discarded contents") }
          }
          throw new Error("unexpected strict evidence read")
        },
      },
    }
    const result = await Effect.runPromise(
      ReviewStrictBlobs.read({ directory, base, head, requests: { base: [], head: ["safe.ts"] } }).pipe(
        Effect.provideService(ReviewGit.Current, view),
      ),
    )
    expect(showed).toBe(true)
    expect(checks).toBe(2)
    expect(result.head.size).toBe(0)
    expect(result.base.size).toBe(0)
  })

  test("a rejected commit or prior cancellation cannot establish absence", async () => {
    await using tmp = await tmpdir()
    const input = {
      directory: tmp.path,
      base: "1".repeat(40),
      head: "2".repeat(40),
      requests: { base: [], head: ["missing.ts"] },
    }
    const stop = new AbortController()
    stop.abort()
    for (const override of [{ head: "HEAD" }, { signal: stop.signal }]) {
      const blobs = await Effect.runPromise(ReviewStrictBlobs.read({ ...input, ...override }))
      expect(blobs.head.get("missing.ts") ?? null).toBeNull()
    }
  })
})
