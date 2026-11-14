import { describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import {
  createFixConsentPolicy,
  FIX_LIMITS,
  prepareFixProposal,
  type FixConsent,
  type FixOperation,
  type FixProposal,
} from "../../src/review/fix-proposal"

const sha = (value: string) => `sha256:${createHash("sha256").update(value).digest("hex")}`
const proposal = (): FixProposal => ({
  version: 1,
  scope: {
    kind: "local",
    repository: "/repo",
    worktree: "/isolated/fix-42",
    sourceBranch: "feature",
    baseBranch: "main",
    destinationBranch: "vector/fix-42",
  },
  base: "a".repeat(40),
  head: "b".repeat(40),
  findings: ["verified-finding-42"],
  files: [{ path: "src/a.ts", preimage: sha("old\n"), postimage: sha("new\n") }],
  patch: "diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-old\n+new\n",
})
const apply: FixOperation = { kind: "apply" }
const checks: FixOperation = {
  kind: "checks",
  commands: [{ argv: ["bun", "test", "test/a.test.ts"], cwd: "." }],
  network: "off",
  timeoutMs: 120_000,
  outputBytes: 80 * 1024,
}
const commit: FixOperation = { kind: "commit", message: "fix: correct the verified defect\n" }
const push: FixOperation = {
  kind: "push",
  remote: "https://github.com/vector/example.git",
  commit: "c".repeat(40),
  mode: "branch",
}

function fixture() {
  const time = { now: 1_000 }
  return { time, policy: createFixConsentPolicy(() => time.now) }
}

async function approved(policy: ReturnType<typeof createFixConsentPolicy>, input = proposal(), operation = apply) {
  const result = await policy.approve(input, operation, "local:alice", 1_000)
  if (!result.ok) throw new Error(result.reason)
  return result.consent
}

describe("fix proposal digest", () => {
  test("hashes actual UTF-8 patch bytes and a fixed complete proposal envelope", async () => {
    const input = proposal()
    const result = await prepareFixProposal(input)
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error(result.reason)
    expect(result.patchDigest).toBe(sha(input.patch))
    expect(result.digest).toBe(
      sha(
        JSON.stringify([
          "vector.fix-proposal.v1",
          ["local", "/repo", "/isolated/fix-42", "feature", "main", "vector/fix-42"],
          input.base,
          input.head,
          ["verified-finding-42"],
          [["src/a.ts", sha("old\n"), sha("new\n")]],
          sha(input.patch),
        ]),
      ),
    )
    expect(Object.isFrozen(result.proposal)).toBe(true)
    expect(Object.isFrozen(result.proposal.scope)).toBe(true)
    expect(Object.isFrozen(result.proposal.files[0])).toBe(true)
  })

  test("canonicalizes object key and set order, while preserving patch order and every byte", async () => {
    const input = { ...proposal(), findings: ["z", "a"] }
    const first = await prepareFixProposal(input)
    const second = await prepareFixProposal({
      patch: input.patch,
      files: input.files.map((file) => ({ postimage: file.postimage, preimage: file.preimage, path: file.path })),
      findings: ["a", "z"],
      head: input.head,
      base: input.base,
      scope: { ...input.scope },
      version: 1,
    })
    expect(first.ok && second.ok && first.digest === second.digest).toBe(true)
    for (const change of ["+new ", "+new\r", "+néw", "+n\tew", "++secret"]) {
      const changed = await prepareFixProposal({ ...input, patch: input.patch.replace("+new", change) })
      expect(changed.ok).toBe(true)
      expect(first.ok && changed.ok && first.digest !== changed.digest).toBe(true)
    }
  })

  test("supports bounded additions, deletions, context and no-newline markers", async () => {
    for (const input of [
      {
        ...proposal(),
        files: [{ path: "src/a.ts", preimage: null, postimage: sha("new\n") }],
        patch:
          "diff --git a/src/a.ts b/src/a.ts\nnew file mode 100644\nindex 0000000..1234567\n--- /dev/null\n+++ b/src/a.ts\n@@ -0,0 +1 @@\n+new\n",
      },
      {
        ...proposal(),
        files: [{ path: "src/a.ts", preimage: sha("old\n"), postimage: null }],
        patch:
          "diff --git a/src/a.ts b/src/a.ts\ndeleted file mode 100644\nindex abcdef0..0000000\n--- a/src/a.ts\n+++ /dev/null\n@@ -1 +0,0 @@\n-old\n",
      },
      {
        ...proposal(),
        patch:
          "diff --git a/src/a.ts b/src/a.ts\nindex abcdef0..1234567 100644\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,2 +1,2 @@\n context\n-old\n\\ No newline at end of file\n+new\n\\ No newline at end of file\n",
      },
    ])
      expect((await prepareFixProposal(input)).ok).toBe(true)
  })

  test("refuses undeclared paths, traversal, hidden metadata, malformed hunks and executable metadata", async () => {
    const input = proposal()
    for (const patch of [
      input.patch.replaceAll("src/a.ts", "../outside"),
      input.patch.replaceAll("src/a.ts", ".GiT/config"),
      input.patch.replace("+++ b/src/a.ts", "+++ b/other.ts"),
      input.patch.replace("@@ -1 +1 @@", "@@ -1,2 +1 @@"),
      input.patch.replace("@@ -1 +1 @@", "@@ -9007199254740991,2 +1 @@"),
      input.patch + "ignored trailer\n",
      input.patch + input.patch,
      input.patch.replace("--- a/src/a.ts", "old mode 100644\nnew mode 100755\n--- a/src/a.ts"),
      input.patch.replace("--- a/src/a.ts", "index abcdef0..1234567 120000\n--- a/src/a.ts"),
      input.patch.replace("--- a/src/a.ts", "GIT binary patch\n--- a/src/a.ts"),
      input.patch.replace("--- a/src/a.ts", "new file mode 100644\n--- a/src/a.ts"),
      input.patch.replace("--- a/src/a.ts", "rename from src/a.ts\n--- a/src/a.ts"),
      input.patch.replace("+new", "+new\0"),
      input.patch.slice(0, -1),
    ])
      expect(await prepareFixProposal({ ...input, patch })).toEqual({ ok: false, reason: "proposal" })
    for (const path of ["/absolute", "a//b", "a/./b", "a/../b", "a\\b", ".git/config", "a/.GIT/config"])
      expect((await prepareFixProposal({ ...input, files: [{ ...input.files[0], path }] })).ok).toBe(false)
  })

  test("canonicalizes the file manifest without silently dropping a real patch or path", async () => {
    const input = proposal()
    const files = [input.files[0], { ...input.files[0], path: "src/b.ts" }]
    const patch = input.patch + input.patch.replaceAll("src/a.ts", "src/b.ts")
    const first = await prepareFixProposal({ ...input, files, patch })
    const reordered = await prepareFixProposal({ ...input, files: [...files].reverse(), patch })
    expect(first.ok && reordered.ok && first.digest === reordered.digest).toBe(true)
    expect((await prepareFixProposal({ ...input, files, patch: input.patch })).ok).toBe(false)
    expect((await prepareFixProposal({ ...input, patch })).ok).toBe(false)
    const reorderedPatch = await prepareFixProposal({
      ...input,
      files,
      patch: input.patch.replaceAll("src/a.ts", "src/b.ts") + input.patch,
    })
    expect(first.ok && reorderedPatch.ok && first.digest !== reorderedPatch.digest).toBe(true)
  })

  test("rejects unbounded, malformed or caller-added authority data rather than truncating", async () => {
    const input = proposal()
    const getter = { ...input }
    Object.defineProperty(getter, "patch", { enumerable: true, get: () => input.patch })
    for (const invalid of [
      null,
      { ...input, approved: true },
      { ...input, actor: "owner" },
      { ...input, digest: sha(input.patch) },
      { ...input, head: "HEAD" },
      { ...input, files: [...input.files, ...input.files] },
      { ...input, findings: ["same", "same"] },
      { ...input, findings: [] },
      { ...input, findings: Array.from({ length: FIX_LIMITS.findings + 1 }, (_, i) => `f${i}`) },
      { ...input, patch: "+".repeat(FIX_LIMITS.patchBytes + 1) },
      { ...input, patch: input.patch.replace("new", "\ud800") },
      { ...input, scope: { ...input.scope, destinationBranch: "main" } },
      { ...input, scope: { ...input.scope, worktree: "/repo" } },
      { ...input, scope: { ...input.scope, repository: "/repo/../other" } },
      getter,
    ])
      expect((await prepareFixProposal(invalid)).ok).toBe(false)
    const oversized = {
      ...input,
      patch: `diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1,${FIX_LIMITS.lines} @@\n-old\n${"+x\n".repeat(FIX_LIMITS.lines)}`,
    }
    expect(await prepareFixProposal(oversized)).toEqual({ ok: false, reason: "proposal" })
  })

  test("binds immutable GitHub repository identity and refuses source/base publication", async () => {
    const input = {
      ...proposal(),
      scope: {
        kind: "github" as const,
        repositoryID: 42,
        owner: "vector",
        repository: "example",
        pullRequest: 7,
        sourceBranch: "feature",
        baseBranch: "main",
        destinationBranch: "vector/fix-42",
      },
    }
    expect((await prepareFixProposal(input)).ok).toBe(true)
    for (const scope of [
      { ...input.scope, repositoryID: 0 },
      { ...input.scope, repositoryID: "42" },
      { ...input.scope, destinationBranch: "main" },
      { ...input.scope, destinationBranch: "feature" },
      { ...input.scope, destinationBranch: "other/fix" },
      { ...input.scope, approved: true },
    ])
      expect((await prepareFixProposal({ ...input, scope })).ok).toBe(false)
    const { policy } = fixture()
    expect((await policy.approve(input, push, "github:1", 500)).ok).toBe(true)
    expect(
      await policy.approve(input, { ...push, remote: "https://github.com/other/example.git" }, "github:1", 500),
    ).toEqual({ ok: false, reason: "operation" })
  })
})

describe("per-operation fix consent policy (in-process only)", () => {
  test("apply, checks, commit and push each need a distinct concrete approval", async () => {
    const { policy } = fixture()
    const input = proposal()
    for (const operation of [apply, checks, commit, push]) {
      const handle = await approved(policy, input, operation)
      for (const other of [apply, checks, commit, push].filter((other) => other !== operation))
        expect(await policy.consume(handle, input, other, "local:alice")).toEqual({ ok: false, reason: "mismatch" })
      expect(await policy.consume(handle, input, operation, "local:alice")).toMatchObject({
        ok: true,
        actor: "local:alice",
      })
      expect(await policy.consume(handle, input, operation, "local:alice")).toEqual({ ok: false, reason: "used" })
    }
  })

  test("changed bytes, preimage, base/head, finding, worktree, branch or actor invalidate the old approval", async () => {
    const { policy } = fixture()
    const input = proposal()
    const handle = await approved(policy, input)
    for (const changed of [
      { ...input, patch: input.patch.replace("+new", "+nëw") },
      { ...input, files: [{ ...input.files[0], preimage: sha("different") }] },
      { ...input, files: [{ ...input.files[0], postimage: sha("different") }] },
      { ...input, base: "c".repeat(40) },
      { ...input, head: "d".repeat(40) },
      { ...input, findings: ["different-finding"] },
      { ...input, scope: { ...input.scope, worktree: "/isolated/different" } },
      { ...input, scope: { ...input.scope, destinationBranch: "vector/different" } },
    ])
      expect(await policy.consume(handle, changed, apply, "local:alice")).toEqual({ ok: false, reason: "mismatch" })
    expect(await policy.consume(handle, input, apply, "local:bob")).toEqual({ ok: false, reason: "mismatch" })
    expect((await policy.consume(handle, input, apply, "local:alice")).ok).toBe(true)
  })

  test("binds exact commands, cwd, order, limits, commit text, remote, publish SHA and publish mode", async () => {
    const { policy } = fixture()
    const input = proposal()
    const commands = {
      ...checks,
      commands: [
        { argv: ["bun", "test"], cwd: "." },
        { argv: ["bun", "typecheck"], cwd: "packages/core" },
      ],
    }
    const cases: [FixOperation, FixOperation][] = [
      [checks, { ...checks, commands: [{ argv: ["bun", "typecheck"], cwd: "." }] }],
      [checks, { ...checks, commands: [{ argv: ["bun", "test", "test/other.ts"], cwd: "." }] }],
      [checks, { ...checks, commands: [{ argv: ["bun", "test", "test/a.test.ts"], cwd: "packages/core" }] }],
      [checks, { ...checks, timeoutMs: 119_999 }],
      [checks, { ...checks, outputBytes: 1_024 }],
      [commands, { ...commands, commands: [...commands.commands].reverse() }],
      [commit, { ...commit, message: "fix: different\n" }],
      [push, { ...push, commit: "d".repeat(40) }],
      [push, { ...push, remote: "https://github.com/vector/other.git" }],
      [push, { ...push, mode: "draft-pr" }],
    ]
    for (const [original, changed] of cases) {
      const handle = await approved(policy, input, original)
      expect(await policy.consume(handle, input, changed, "local:alice")).toEqual({ ok: false, reason: "mismatch" })
      expect((await policy.consume(handle, input, original, "local:alice")).ok).toBe(true)
    }
  })

  test("revocation and expiry refuse actual state transitions, including while a hash is pending", async () => {
    const { policy, time } = fixture()
    const input = proposal()
    const revoked = await approved(policy)
    const consume = policy.consume(revoked, input, apply, "local:alice")
    expect(policy.revoke(revoked)).toEqual({ ok: true })
    expect(await consume).toEqual({ ok: false, reason: "revoked" })
    const expired = await approved(policy)
    time.now = 2_000
    expect(await policy.consume(expired, input, apply, "local:alice")).toEqual({ ok: false, reason: "expiry" })
    expect(await policy.approve(input, apply, "local:alice", FIX_LIMITS.consentMs + 1)).toEqual({
      ok: false,
      reason: "expiry",
    })
  })

  test("twelve concurrent consumes yield exactly one winner; serialized handles and another policy never match", async () => {
    const { policy } = fixture()
    const input = proposal()
    const handle = await approved(policy)
    const results = await Promise.all(
      Array.from({ length: 12 }, () => policy.consume(handle, input, apply, "local:alice")),
    )
    expect(results.filter((result) => result.ok)).toHaveLength(1)
    expect(results.filter((result) => !result.ok && result.reason === "used")).toHaveLength(11)
    expect(await policy.consume(JSON.parse(JSON.stringify(handle)), input, apply, "local:alice")).toEqual({
      ok: false,
      reason: "unknown",
    })
    expect(await fixture().policy.consume(handle, input, apply, "local:alice")).toEqual({
      ok: false,
      reason: "unknown",
    })
    expect(
      await policy.consume(
        { approved: true, actor: "local:alice" } as unknown as FixConsent,
        input,
        apply,
        "local:alice",
      ),
    ).toEqual({ ok: false, reason: "unknown" })
  })

  test("snapshots proposal and operation before asynchronous hashing without freezing caller-owned data", async () => {
    const { policy } = fixture()
    const input = proposal()
    const command = { ...checks, commands: [{ argv: ["bun", "test"], cwd: "." }] }
    const grant = policy.approve(input, command, "local:alice", 1_000)
    input.head = "d".repeat(40)
    command.commands[0].argv.push("test/different.ts")
    const result = await grant
    if (!result.ok) throw new Error(result.reason)
    expect(await policy.consume(result.consent, input, command, "local:alice")).toEqual({
      ok: false,
      reason: "mismatch",
    })
    const consuming = policy.consume(
      result.consent,
      proposal(),
      { ...checks, commands: [{ argv: ["bun", "test"], cwd: "." }] },
      "local:alice",
    )
    expect((await consuming).ok).toBe(true)
    expect(Object.isFrozen(input)).toBe(false)
  })

  test("refuses unsafe/unknown operations and caller approval fields rather than treating them as consent", async () => {
    const { policy } = fixture()
    for (const operation of [
      { kind: "apply", approved: true },
      { kind: "merge" },
      { ...checks, network: "on" },
      { ...checks, commands: [{ argv: ["sh", "-c", "bun test"], cwd: "." }] },
      { ...checks, commands: [{ argv: ["bun", "test", "--preload", "evil.ts"], cwd: "." }] },
      { ...checks, commands: [{ argv: ["bun", "test", "../other"], cwd: "." }] },
      { ...checks, commands: [{ argv: ["bun", "test"], cwd: "../other" }] },
      { ...checks, commands: [{ argv: ["bun", "test", "; curl"], cwd: "." }] },
      { ...checks, commands: [] },
      { ...checks, timeoutMs: FIX_LIMITS.commandMs + 1 },
      { ...push, remote: "https://token@github.com/vector/example.git" },
      { ...push, commit: "HEAD" },
    ])
      expect(await policy.approve(proposal(), operation, "local:alice", 1_000)).toEqual({
        ok: false,
        reason: "operation",
      })
    expect(
      (
        await policy.approve(
          proposal(),
          { ...checks, commands: [{ argv: ["bun", "test", "--coverage", "--coverage-reporter=lcov"], cwd: "." }] },
          "local:alice",
          1_000,
        )
      ).ok,
    ).toBe(true)
  })

  test("bounds pending grants, frees retired slots and rejects invalid/backwards clocks", async () => {
    const { policy, time } = fixture()
    const handles = await Promise.all(Array.from({ length: FIX_LIMITS.pending }, () => approved(policy)))
    expect(await policy.approve(proposal(), apply, "local:alice", 1_000)).toEqual({ ok: false, reason: "capacity" })
    expect(policy.revoke(handles[0])).toEqual({ ok: true })
    expect((await policy.approve(proposal(), apply, "local:alice", 1_000)).ok).toBe(true)
    time.now = 2_000
    expect((await policy.approve(proposal(), apply, "local:alice", 1_000)).ok).toBe(true)
    time.now = 1_999
    expect(await policy.approve(proposal(), apply, "local:alice", 1_000)).toEqual({ ok: false, reason: "clock" })
    time.now = Number.NaN
    expect(await policy.approve(proposal(), apply, "local:alice", 1_000)).toEqual({ ok: false, reason: "clock" })
    expect(await policy.approve(proposal(), apply, "", 1_000)).toEqual({ ok: false, reason: "actor" })
  })
})
