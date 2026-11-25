import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { Effect, Fiber, Stream } from "effect"
import { ReadOnlyGit } from "@vectordevai/core/read-only-git"
import { ReviewGit } from "../../src/review/git"
import { tmpdir } from "../fixture/fixture"

test.skipIf(process.platform !== "linux")(
  "cancelled impact acquisition joins its private directory cleanup before returning",
  async () => {
    await using checkout = await tmpdir({ git: true })
    const metadata = await Effect.runPromise(ReviewGit.metadata(checkout.path))
    const controller = new AbortController()
    let entered!: (dir: string) => void
    const acquiring = new Promise<string>((resolve) => {
      entered = resolve
    })
    let release!: () => void
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    const chmod = fs.chmod
    let ran = false,
      settled = false
    fs.chmod = async (...args) => {
      await chmod(...args)
      const dir = args[0]
      if (typeof dir === "string" && path.basename(dir).startsWith("vector-readonly-git-")) {
        entered(dir)
        await held
      }
    }
    const result = Effect.runPromise(
      ReviewGit.within(
        metadata,
        metadata.head,
        Effect.sync(() => {
          ran = true
        }),
        controller.signal,
      ).pipe(Effect.flip),
    ).finally(() => {
      settled = true
    })
    try {
      const directory = await Promise.race([
        acquiring,
        result.then((error) => {
          throw error
        }),
      ])
      controller.abort()
      expect(settled).toBe(false)
      expect((await fs.stat(directory)).isDirectory()).toBe(true)
      release()
      const refused = await result
      expect(refused.message).toContain("cancelled")
      expect(ran).toBe(false)
      await expect(fs.stat(directory)).rejects.toMatchObject({ code: "ENOENT" })
    } finally {
      release()
      controller.abort()
      fs.chmod = chmod
      await result.catch(() => undefined)
    }
  },
)

test("impact authorizes only immutable reads for the admitted checkout and its exact pair", async () => {
  const directory = "/fixture"
  const base = "b".repeat(40)
  const head = "a".repeat(40)
  const operations: ReadOnlyGit.Read[] = []
  let open = true
  const metadata: ReadOnlyGit.Metadata = {
    directory,
    gitDirectory: directory + "/.git",
    commonDirectory: directory + "/.git",
    head: base,
    objectValidated: false,
  }
  const never = () => {
    throw new Error("private impact must never use a fallback git client")
  }
  const view: ReviewGit.View = {
    metadata,
    repository: {
      ...metadata,
      shallow: false,
      isOpen: () => open,
      status: never,
      close: never,
      read: async (operation, signal) => {
        expect(signal).toBeInstanceOf(AbortSignal)
        operations.push(operation)
        return { code: operation.kind === "show" ? 3 : 0, bytes: Buffer.alloc(0) }
      },
    },
    client: { run: never, branch: never, defaultBranch: never },
    preflight: never,
  }
  const git = ReviewGit.impactClient(view, directory, head, base)
  const opts = { cwd: directory, maxOutputBytes: 1024, env: { GIT_NO_LAZY_FETCH: "1" } }
  const show = ["show", "--no-textconv", head + ":src/used.ts"]
  expect((await Effect.runPromise(git.run(show, opts))).truncated).toBe(true)
  const grep = [
    "grep",
    "-l",
    "-z",
    "-w",
    "-F",
    "-I",
    "--no-color",
    "--no-column",
    "--full-name",
    "-f",
    "-",
    head,
    "--",
    ":/",
  ]
  await Effect.runPromise(git.run(grep, { ...opts, stdin: Stream.make(Buffer.from("Needle\nSecond")) }))
  for (const revision of [base, head])
    expect((await Effect.runPromise(git.run(["ls-tree", "-r", "-z", "--full-tree", revision], opts))).exitCode).toBe(0)
  expect((await Effect.runPromise(git.run(["ls-tree", "-r", "-z", "-l", "--full-tree", head], opts))).exitCode).toBe(0)
  expect(operations).toEqual([
    { kind: "show", revision: head, file: "src/used.ts", maxBytes: 1024, distinguishLarge: true },
    {
      kind: "impact-grep",
      revision: head,
      maxBytes: 1024,
      search: { kind: "symbols", names: ["Needle", "Second"], exclude: [] },
    },
    ...[base, head].map<ReadOnlyGit.Read>((revision) => ({
      kind: "impact-tree",
      revision,
      maxBytes: 1024,
      namesAndIdsOnly: true,
    })),
    { kind: "impact-tree", revision: head, maxBytes: 1024 },
  ])
  for (const args of [
    ["show", "--no-textconv", "c".repeat(40) + ":src/used.ts"],
    ["cat-file", "--batch"],
    ["grep", "Needle", "HEAD"],
  ])
    expect((await Effect.runPromise(git.run(args, opts))).exitCode).toBe(128)
  expect((await Effect.runPromise(git.run(show, { ...opts, cwd: "/other" }))).exitCode).toBe(128)
  expect((await Effect.runPromise(git.run(show, { ...opts, env: { GIT_DIR: "/other" } }))).exitCode).toBe(128)
  expect(
    (await Effect.runPromise(git.run(grep, { ...opts, stdin: Stream.make(Buffer.alloc(1024 * 1024 + 1)) }))).exitCode,
  ).toBe(128)
  open = false
  expect((await Effect.runPromise(git.run(show, opts))).exitCode).toBe(128)
  expect(operations).toHaveLength(5)

  // A caller may lend a view whose lifetime continues after the graph. The worker must still join its own read.
  open = true
  let entered!: (signal: AbortSignal) => void
  const reading = new Promise<AbortSignal>((resolve) => {
    entered = resolve
  })
  let finish!: () => void
  const reaped = new Promise<void>((resolve) => {
    finish = resolve
  })
  const borrowed = ReviewGit.impactClient(
    {
      ...view,
      repository: {
        ...view.repository,
        read: async (_op, signal) => {
          entered(signal!)
          await reaped
          return { code: 0, bytes: Buffer.alloc(0) }
        },
      },
    },
    directory,
    head,
    base,
  )
  const child = Effect.runFork(borrowed.run(show, opts))
  const signal = await reading
  const aborted = new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }))
  let stopped = false
  const interrupt = Effect.runPromise(Fiber.interrupt(child)).then(() => {
    stopped = true
  })
  try {
    await aborted
    expect(stopped).toBe(false)
  } finally {
    finish()
    await interrupt
  }
  expect(stopped).toBe(true)
  expect(view.repository.isOpen()).toBe(true)
})
