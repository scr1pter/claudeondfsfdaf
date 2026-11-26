import { afterEach, expect, test } from "bun:test"
import { chmodSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { ConfigManaged } from "../../src/config/managed"

// The desktop's main process reads company policy every half minute, so the macOS access control list check, which
// runs ls, keeps its listing until a path it lists changes.

const temporary: string[] = []
afterEach(() => {
  ConfigManaged.useTestDirectory(undefined)
  temporary.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true }))
})

test.skipIf(process.platform !== "win32")("clears a fixture ACL reader when the test directory is restored", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "vector-managed-"))
  temporary.push(dir)
  const file = path.join(dir, "vector.json")
  writeFileSync(file, "{}")
  const reads: (readonly string[])[] = []
  ConfigManaged.useTestDirectory(dir, (paths) => {
    reads.push(paths)
    return { entries: {} }
  })
  expect(ConfigManaged.read()).toMatchObject({ files: [], ignored: [{ kind: "unreadable" }] })
  expect(reads).toEqual([[dir, file]])
  ConfigManaged.useTestDirectory(dir)
  // Reset must stop calling the fixture reader even if the real PowerShell read fails closed. OS allow/deny
  // behavior is covered by the engine's managed-trust integration tests.
  ConfigManaged.read()
  expect(reads).toHaveLength(1)
})

test("retries incomplete Windows ACL reads, stays fail-closed, and keeps complete reads separate by reader", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "vector-managed-"))
  temporary.push(dir)
  const file = path.join(dir, "vector.json")
  writeFileSync(file, "{}")
  const acl = { owner: "S-1-5-18", rules: [] }
  const reads: (readonly string[])[] = []
  const answers: ReturnType<ConfigManaged.AclReader>[] = [
    { entries: {} },
    { entries: { [dir]: acl } },
    { entries: { [dir]: acl, [file]: acl } },
  ]
  const reader: ConfigManaged.AclReader = (paths) => {
    reads.push(paths)
    return answers.shift()!
  }
  const options = { platform: "win32" as const, acl: reader }
  expect(ConfigManaged.check(file, options)).toEqual({
    kind: "unreadable",
    reason: `Vector could not read who may change ${dir}.`,
  })
  expect(reads).toHaveLength(1)
  expect(ConfigManaged.check(file, options)).toEqual({
    kind: "unreadable",
    reason: `Vector could not read who may change ${file}.`,
  })
  expect(reads).toHaveLength(2)
  expect(ConfigManaged.check(file, options)).toBeUndefined()
  expect(ConfigManaged.check(file, options)).toBeUndefined()
  expect(reads).toEqual(Array.from({ length: 3 }, () => [dir, file]))
  const separate: ConfigManaged.AclReader = () => ({ entries: {} })
  expect(ConfigManaged.check(file, { platform: "win32", acl: separate })?.kind).toBe("unreadable")
  // Changing either path invalidates the complete result instead of trusting an older ACL.
  writeFileSync(file, "{ }")
  answers.push({ entries: {} })
  expect(ConfigManaged.check(file, options)?.kind).toBe("unreadable")
  expect(reads).toHaveLength(4)
})

test("a Windows ACL owner printed before a failed rule read cannot make the path trusted or cached", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "vector-managed-"))
  temporary.push(dir)
  const file = path.join(dir, "vector.json")
  writeFileSync(file, "{}")
  const owner = "S-1-5-18"
  const partial = [`O 0 ${owner}`, "C 0", `O 1 ${owner}`, `R 1 ${owner} 2 1 0`]
  let reads = 0
  const acl: ConfigManaged.AclReader = (paths) => {
    reads += 1
    const output = reads === 1 ? partial : [...partial, "R 1 S-1-1-0 2 1 0", "C 1"]
    return ConfigManaged.parseAcl(output.join("\r\n"), paths)
  }
  const options = { platform: "win32" as const, acl }
  expect(ConfigManaged.check(file, options)).toEqual({
    kind: "unreadable",
    reason: `Vector could not read who may change ${file}.`,
  })
  expect(ConfigManaged.check(file, options)).toEqual({
    kind: "untrusted",
    reason: `${file} lets S-1-1-0 change it.`,
  })
  expect(reads).toBe(2)
})

test("a completed Windows ACL with a malformed access flag is unavailable and is retried", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "vector-managed-"))
  temporary.push(dir)
  const file = path.join(dir, "vector.json")
  writeFileSync(file, "{}")
  let reads = 0
  const acl: ConfigManaged.AclReader = (paths) => {
    const allow = ++reads === 1 ? "unknown" : "1"
    const output = [`O 0 S-1-5-18`, "C 0", `O 1 S-1-5-18`, `R 1 S-1-1-0 2 ${allow} 0`, "C 1"]
    return ConfigManaged.parseAcl(output.join("\r\n"), paths)
  }
  const options = { platform: "win32" as const, acl }
  expect(ConfigManaged.check(file, options)).toEqual({
    kind: "unreadable",
    reason: `Vector could not read who may change ${file}.`,
  })
  expect(ConfigManaged.check(file, options)).toEqual({ kind: "untrusted", reason: `${file} lets S-1-1-0 change it.` })
  expect(reads).toBe(2)
})

test("Windows ACL blocks need one owner at the start, complete rule rows, and one matching terminal", () => {
  const file = "vector.json"
  const owner = "O 0 S-1-5-18"
  const rule = "R 0 S-1-1-0 -1610612736 1 0"
  const end = "C 0"
  for (const rows of [
    [owner, "R", end],
    [owner, "R 1 S-1-1-0 2 1 0", end],
    [owner, "R 0 S-1-1-0 2 1", end],
    [owner, "R 0 S-1-1-0 2147483648 1 0", end],
    [owner, "R 0 S-1-1-0 2e0 1 0", end],
    [owner, "R 0 S-1-1-0 2 1 2", end],
    [owner, "R 0 S-1-1-4294967296 2 1 0", end],
    ["O 0 incomplete", end],
    [owner, owner, end],
    [rule, owner, end],
    [owner, end, rule, end],
    [owner, "C 1"],
  ]) {
    expect(ConfigManaged.parseAcl(rows.join("\n"), [file]).entries[file]).toBeUndefined()
  }
  expect(ConfigManaged.parseAcl([owner, end].join("\n"), [file]).entries[file]).toEqual({
    owner: "S-1-5-18",
    rules: [],
  })
  expect(ConfigManaged.parseAcl([owner, rule, end].join("\r\n"), [file]).entries[file]?.rules).toEqual([
    { sid: "S-1-1-0", rights: -1610612736, allow: true, inheritOnly: false },
  ])
  expect(
    ConfigManaged.parseAcl([owner, "O 1 S-1-5-18", rule, end, "C 1"].join("\n"), ["folder", file]).entries,
  ).toEqual({})
})

test.skipIf(process.platform === "win32")(
  "lists macOS access control lists once until a path in the chain changes, and sees a change then",
  () => {
    const dir = mkdtempSync(path.join(tmpdir(), "vector-managed-"))
    temporary.push(dir)
    const file = path.join(dir, "vector.json")
    writeFileSync(file, "{}")
    chmodSync(file, 0o644)
    const listing = { stdout: "" }
    const calls: string[][] = []
    const macAcl: ConfigManaged.MacAclReader = (paths) => {
      calls.push([...paths])
      return { status: 0, stdout: listing.stdout, stderr: "" }
    }
    // The user running the test may own the file, as in the test managed folder; no one else may change it.
    const options = { platform: "darwin" as const, user: true, macAcl }
    expect(ConfigManaged.check(file, options)).toBeUndefined()
    expect(ConfigManaged.check(file, options)).toBeUndefined()
    expect(calls).toHaveLength(1)
    expect(calls[0]![0]).toBe(realpathSync(file))
    // An access control list that lets another user write it changes the file's change time, and is read then.
    listing.stdout = `-rw-------+ 1 owner staff 2 Oct 23 12:00 ${realpathSync(file)}\n 0: user:intruder allow write\n`
    chmodSync(file, 0o600)
    expect(ConfigManaged.check(file, options)).toEqual({
      reason: `${realpathSync(file)} lets user:intruder change it.`,
      kind: "untrusted",
    })
    expect(calls).toHaveLength(2)
  },
)

test.skipIf(process.platform === "win32")("never keeps a listing that failed", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "vector-managed-"))
  temporary.push(dir)
  const file = path.join(dir, "vector.json")
  writeFileSync(file, "{}")
  chmodSync(file, 0o644)
  const answers = [1, 0]
  const macAcl: ConfigManaged.MacAclReader = () => ({ status: answers.shift() ?? 0, stdout: "", stderr: "busy" })
  const options = { platform: "darwin" as const, user: true, macAcl }
  expect(ConfigManaged.check(file, options)?.kind).toBe("unreadable")
  expect(ConfigManaged.check(file, options)).toBeUndefined()
  expect(answers).toEqual([])
})
