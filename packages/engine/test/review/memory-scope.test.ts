import { $ } from "bun"
import { describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { Effect, Result } from "effect"
import { ReadOnlyGit } from "@vectordevai/core/read-only-git"
import { ReviewMemoryScope } from "@/review/memory-scope"
import { tmpdir } from "../fixture/fixture"

const local = process.platform === "linux" ? test : test.skip
const git = (cwd: string, ...args: string[]) => $`git ${args}`.cwd(cwd).quiet().text()

describe("verified physical review-memory scope", () => {
  local("real linked worktrees and subdirectories share only the validated common-store scope", async () => {
    await using tmp = await tmpdir({ git: true })
    const nested = path.join(tmp.path, "nested")
    await fs.mkdir(nested)
    const primary = await Effect.runPromise(ReviewMemoryScope.git(tmp.path))
    const child = await Effect.runPromise(ReviewMemoryScope.git(tmp.path, nested))
    expect(child.binding.scope).toBe(primary.binding.scope)
    expect(child.binding.directory).toBe(nested)
    const linked = path.join(tmp.path, "linked")
    await git(tmp.path, "worktree", "add", "--quiet", "-b", "memory-linked", linked)
    const worktree = await Effect.runPromise(ReviewMemoryScope.git(linked))
    expect(worktree.binding.scope).toBe(primary.binding.scope)
    expect(worktree.binding.worktree).toBe(linked)
    expect(worktree.binding.gitDirectory).not.toBe(primary.binding.gitDirectory)
    expect(worktree.binding.commonIdentity).toEqual(primary.binding.commonIdentity)
    await fs.writeFile(path.join(tmp.path, "next.txt"), "next\n")
    await git(tmp.path, "add", "next.txt")
    await git(tmp.path, "commit", "--quiet", "-m", "next")
    expect((await Effect.runPromise(ReviewMemoryScope.git(tmp.path))).binding.scope).toBe(primary.binding.scope)
  })

  local("distinct physical clones with identical HEAD and remote never share scope", async () => {
    await using tmp = await tmpdir({ git: true })
    await git(tmp.path, "remote", "add", "origin", "https://example.invalid/vector/same.git")
    await using clone = await tmpdir()
    await git(tmp.path, "clone", "--quiet", "--no-hardlinks", tmp.path, clone.path)
    await git(clone.path, "remote", "set-url", "origin", "https://example.invalid/vector/same.git")
    const first = await Effect.runPromise(ReviewMemoryScope.git(tmp.path))
    const second = await Effect.runPromise(ReviewMemoryScope.git(clone.path))
    expect(first.metadata.head).toBe(second.metadata.head)
    expect(await git(tmp.path, "remote", "get-url", "origin")).toBe(
      await git(clone.path, "remote", "get-url", "origin"),
    )
    expect(first.binding.scope).not.toBe(second.binding.scope)
  })

  local("replacement and legacy source bindings refuse instead of being adopted by today's store", async () => {
    await using tmp = await tmpdir({ git: true })
    const admitted = await Effect.runPromise(ReviewMemoryScope.git(tmp.path))
    await using saved = await tmpdir()
    const original = path.join(saved.path, "old-store")
    await fs.rename(path.join(tmp.path, ".git"), original)
    await fs.cp(original, path.join(tmp.path, ".git"), { recursive: true })
    await git(tmp.path, "config", "--local", "fixture.scopeIdentity", "replacement")
    const replacement = await Effect.runPromise(ReviewMemoryScope.git(tmp.path))
    expect(replacement.metadata.head).toBe(admitted.metadata.head)
    expect(replacement.binding.scope).not.toBe(admitted.binding.scope)
    const stale = await Effect.runPromise(ReviewMemoryScope.verify(admitted.binding).pipe(Effect.result))
    expect(Result.isFailure(stale)).toBe(true)
    for (const legacy of [undefined, null, {}, { ...admitted.binding, scope: "caller-chosen" }])
      expect(Result.isFailure(await Effect.runPromise(ReviewMemoryScope.verify(legacy).pipe(Effect.result)))).toBe(true)
    await expect(ReadOnlyGit.open(admitted.metadata)).rejects.toBeInstanceOf(ReadOnlyGit.Unavailable)
    const current = await ReadOnlyGit.open(replacement.metadata)
    try {
      expect(ReviewMemoryScope.repositoryScope(current)).toBe(replacement.binding.scope)
    } finally {
      await current.close()
    }
  })

  local("unregistered Git pointers and malformed markers cannot turn into folder authority", async () => {
    await using tmp = await tmpdir({ git: true })
    await using unregistered = await tmpdir()
    await fs.writeFile(path.join(unregistered.path, ".git"), `gitdir: ${path.join(tmp.path, ".git")}\n`)
    expect(
      Result.isFailure(await Effect.runPromise(ReviewMemoryScope.git(unregistered.path).pipe(Effect.result))),
    ).toBe(true)
    expect(
      Result.isFailure(await Effect.runPromise(ReviewMemoryScope.folder(unregistered.path).pipe(Effect.result))),
    ).toBe(true)
    const nested = path.join(tmp.path, "nested")
    await fs.mkdir(nested)
    expect(Result.isFailure(await Effect.runPromise(ReviewMemoryScope.folder(nested).pipe(Effect.result)))).toBe(true)
  })

  local("folders bind their exact physical directory or refuse a real Git ancestor", async () => {
    await using tmp = await tmpdir()
    const first = path.join(tmp.path, "first")
    const second = path.join(tmp.path, "second")
    const alias = path.join(tmp.path, "alias")
    await fs.mkdir(first)
    await fs.mkdir(second)
    // File-only mode writes ordinary fixture data, without creating a Git
    // repository. Positive folder assertions require real evolved metadata.
    await git(tmp.path, "config", "--file", path.join(first, "fixture.config"), "fixture.value", "first")
    await git(tmp.path, "config", "--file", path.join(second, "fixture.config"), "fixture.value", "second")
    await fs.symlink(first, alias, "dir")
    let ancestor = await fs.realpath(tmp.path)
    for (;;) {
      const marker = await fs.lstat(path.join(ancestor, ".git")).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error
        return undefined
      })
      if (marker) {
        // Managed test hosts can place a synthetic .git above temporary
        // folders. That is real Git ancestry, not a qualified non-Git fixture.
        for (const selected of [first, alias, second, tmp.path]) {
          const refused = await Effect.runPromise(ReviewMemoryScope.folder(selected).pipe(Effect.result))
          expect(Result.isFailure(refused) && refused.failure._tag).toBe("ReviewMemoryScope.Refused")
        }
        return
      }
      const parent = path.dirname(ancestor)
      if (parent === ancestor) break
      ancestor = parent
    }
    const captured = await Effect.runPromise(ReviewMemoryScope.folder(first))
    expect((await Effect.runPromise(ReviewMemoryScope.folder(alias))).scope).toBe(captured.scope)
    await fs.unlink(alias)
    await fs.symlink(second, alias, "dir")
    expect((await Effect.runPromise(ReviewMemoryScope.folder(alias))).scope).not.toBe(captured.scope)
    expect((await Effect.runPromise(ReviewMemoryScope.folder(tmp.path))).scope).not.toBe(captured.scope)
  })
})
