import { describe, expect, test } from "bun:test"
import { createHash, randomBytes } from "node:crypto"
import type { BrainExport } from "@vectordevai/core/brain/export"
import { BrainRunBundle } from "@vectordevai/core/brain/run-bundle"
import { BrainUpload } from "@vectordevai/core/brain/upload"
import { GithubBrain } from "../../src/cli/cmd/github.brain"
import { allowConversationRestore, decryptConversation, encryptConversation } from "../../src/cli/cmd/github.session"
import { BRAIN_ACCOUNT, BRAIN_KEY, brainAad, brainSealed, brainUploaded } from "./github.agent-fixture"

const UPLOAD_ID = `vbu_${"u".repeat(32)}`
const expected = { repositoryId: "42", uploadId: UPLOAD_ID, publicRepository: false }
const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex")
const aad = (repositoryId = "42", generation = "3", uploadId = UPLOAD_ID) =>
  brainAad({ repositoryId, generation, uploadId })

// The same item shapes core's run-bundle test packs.
const entry: BrainExport.Item = {
  id: "e1",
  kind: "lesson",
  scope: "repository",
  status: "active",
  text: "Use the repository test script.",
  paths: [],
  pinned: true,
  evidence: [],
  createdAt: 1,
}
const skill: BrainExport.Item = {
  ...entry,
  id: "s1",
  kind: "skill",
  skill: {
    name: "learned-check",
    description: "Check changes",
    procedure: "Run bun test",
    checks: ["bun test"],
    commands: [],
    version: 1,
  },
}
const pack = (publicRepository: boolean, text = entry.text) =>
  BrainRunBundle.pack({
    ownerStartedDesktop: true,
    includeBrain: true,
    publicRepository,
    memory: {
      format: "vector-memory",
      version: 1,
      scope: "all",
      exportedAt: 1,
      entries: [{ ...entry, text }],
      documents: [],
    },
    shareableSkills: [skill],
    insights: { format: "vector-workflow-insights", version: 1, rows: [] },
    screen: async (parts) => parts.map(() => true),
  })

/** What brain-download answers after the desktop's own encryption for repository 42 (the fixture's brainUploaded). */
const uploaded = (bytes: Uint8Array) => brainUploaded(bytes, { repositoryId: "42", uploadId: UPLOAD_ID })

/** An envelope sealed directly under any authenticated data, so only the framing checks can refuse it. */
const sealed = (bytes: Uint8Array, associated: string, uploadId = UPLOAD_ID) => brainSealed(bytes, associated, uploadId)

// Each character of a base64url string carries six bits; changing only the last one's spare low bit keeps the decoded
// bytes and makes the text noncanonical.
const spare = (value: string) => {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"
  return value.slice(0, -1) + alphabet[alphabet.indexOf(value.at(-1)!) ^ 1]
}

describe("opening an approved Brain upload", () => {
  test("an upload the desktop encrypted opens to exactly its approved bytes, approval and Brain key", async () => {
    const packed = await pack(false)
    const download = await uploaded(packed.bytes)
    const opened = GithubBrain.openUpload(download, expected)
    expect(opened).toBeDefined()
    expect(Buffer.from(opened!.bytes).equals(packed.bytes)).toBe(true)
    expect(opened!.bundle.memory.entries.map((item) => item.id)).toEqual(["e1"])
    expect(opened!.bundle.memory.skills?.map((item) => item.id)).toEqual(["s1"])
    expect(opened!.approval).toEqual({
      source: "desktop",
      repositoryId: "42",
      sha256: packed.sha256,
      approvedAt: download.approvedAt,
      audience: "owner-desktop",
      publicRepository: false,
    })
    expect(opened!.brainKey).toEqual(BRAIN_KEY)
    expect(GithubBrain.openUpload({ ...download, artifactKey: undefined }, expected)?.brainKey).toBeUndefined()
    // The approval and Brain key fit the session codec: the next run restores this exact approval and no other.
    const conversation = await decryptConversation({
      bytes: await encryptConversation({
        identity: { repositoryId: "42", thread: "dispatch-9", rid: "gh-42-9-1-5" },
        key: opened!.brainKey!,
        session: {},
        brain: { path: BrainRunBundle.PATH, bytes: opened!.bytes, approval: opened!.approval },
      }),
      key: BRAIN_KEY,
      expected: { repositoryId: "42", thread: "dispatch-9" },
    })
    expect(conversation).toBeDefined()
    expect(Buffer.from(conversation!.brain!).equals(packed.bytes)).toBe(true)
    expect(allowConversationRestore(conversation!, opened!.approval)).toBe(true)
    expect(allowConversationRestore(conversation!, { ...opened!.approval, sha256: "0".repeat(64) })).toBe(false)
  })

  test("a tampered ciphertext, nonce, key or authenticated data refuses", async () => {
    const download = await uploaded((await pack(false)).bytes)
    const flipped = Buffer.from(download.ciphertext, "base64url")
    flipped[0] ^= 1
    for (const changed of [
      { ...download, ciphertext: flipped.toString("base64url") },
      { ...download, nonce: Buffer.alloc(12, 5).toString("base64url") },
      { ...download, key: randomBytes(32).toString("base64url") },
      // Passes every framing check, so only GCM refuses it.
      { ...download, aad: aad("42", "4") },
    ])
      expect(GithubBrain.openUpload(changed, expected)).toBeUndefined()
    expect(GithubBrain.openUpload(download, expected)).toBeDefined()
  })

  test("an envelope sealed for another repository, upload or framing refuses even though it authenticates", async () => {
    const bytes = (await pack(false)).bytes
    const other = `vbu_${"v".repeat(32)}`
    // One character past the desktop's 256, with every part still in place.
    const long = `vector-brain-upload-v1|${"a".repeat(257 - aad().length + BRAIN_ACCOUNT.length)}|42|3|${UPLOAD_ID}`
    expect(long).toHaveLength(257)
    expect(GithubBrain.openUpload(sealed(bytes, aad()), expected)).toBeDefined()
    const download = await uploaded(bytes)
    for (const repositoryId of ["43", "0x1", "042", "12345678901234567", "42\n"])
      expect(GithubBrain.openUpload(download, { ...expected, repositoryId })).toBeUndefined()
    // An id the desktop would never encrypt for (core brain/upload.ts), even sealed and expected alike.
    for (const repositoryId of ["042", "12345678901234567"])
      expect(GithubBrain.openUpload(sealed(bytes, aad(repositoryId)), { ...expected, repositoryId })).toBeUndefined()
    expect(GithubBrain.openUpload(download, { ...expected, uploadId: other })).toBeUndefined()
    expect(GithubBrain.openUpload({ ...download, uploadId: other }, expected)).toBeUndefined()
    for (const associated of [
      // Sealed for another upload, answered under this one's id.
      aad("42", "3", other),
      aad("43"),
      aad("42", "0"),
      aad("42", "x"),
      `vector-brain-upload-v2|${BRAIN_ACCOUNT}|42|3|${UPLOAD_ID}`,
      `${aad()}|extra`,
      long,
    ])
      expect(GithubBrain.openUpload(sealed(bytes, associated), expected)).toBeUndefined()
    expect(GithubBrain.openUpload(sealed(bytes, aad(), other), { ...expected, uploadId: other })).toBeUndefined()
  })

  test("a digest or size that differs from the decrypted bytes refuses", async () => {
    const download = await uploaded((await pack(false)).bytes)
    for (const changed of [
      { ...download, sha256: digest(Buffer.from("other approved bytes")) },
      { ...download, bytes: download.bytes + 1 },
      { ...download, bytes: download.bytes - 1 },
      { ...download, bytes: 0 },
      { ...download, bytes: BrainRunBundle.MAX_BYTES + 1 },
      { ...download, approvedAt: 0 },
    ])
      expect(GithubBrain.openUpload(changed, expected)).toBeUndefined()
  })

  test("a repository that became public refuses an approved bundle with skills", async () => {
    const withSkill = await uploaded((await pack(false)).bytes)
    const withoutSkill = await uploaded((await pack(true)).bytes)
    expect(GithubBrain.openUpload({ ...withSkill, publicRepository: true }, expected)).toBeUndefined()
    // The run's own event can say public while the server still says private.
    expect(GithubBrain.openUpload(withSkill, { ...expected, publicRepository: true })).toBeUndefined()
    expect(GithubBrain.openUpload(withSkill, expected)?.bundle.memory.skills).toHaveLength(1)
    expect(
      GithubBrain.openUpload({ ...withoutSkill, publicRepository: true }, expected)?.approval.publicRepository,
    ).toBe(true)
    // Without skills the event's view refuses nothing, and the approval keeps the server's visibility.
    expect(
      GithubBrain.openUpload(withoutSkill, { ...expected, publicRepository: true })?.approval.publicRepository,
    ).toBe(false)
  })

  test("an approved upload whose bytes are not a valid run bundle, or whose encoding is not canonical, refuses", async () => {
    // Core's upload test shape: the desktop's validate accepts it, the run bundle schema does not.
    const loose = new TextEncoder().encode(
      JSON.stringify({
        format: "vector-brain-run",
        version: 1,
        memory: {
          format: "vector-memory",
          version: 1,
          scope: "repository",
          documents: [],
          entries: [
            { scope: "repository", kind: "lesson", status: "active", private: false, text: "approved context" },
          ],
          skills: [],
        },
        insights: { format: "vector-workflow-insights", version: 1, rows: [] },
      }),
    )
    expect(() => BrainUpload.validate(loose, false)).not.toThrow()
    expect(GithubBrain.openUpload(await uploaded(loose), expected)).toBeUndefined()
    // A size whose ciphertext has spare bits in its last character, so a noncanonical spelling of the same bytes exists.
    const packs = await Promise.all(["", " ", "  "].map((extra) => pack(false, entry.text + extra)))
    const bytes = packs.find((value) => (value.bytes.length + 16) % 3 !== 0)!.bytes
    const download = await uploaded(bytes)
    expect(GithubBrain.openUpload(download, expected)).toBeDefined()
    expect(Buffer.from(spare(download.key), "base64url").equals(Buffer.from(download.key, "base64url"))).toBe(true)
    expect(GithubBrain.openUpload({ ...download, key: spare(download.key) }, expected)).toBeUndefined()
    expect(GithubBrain.openUpload({ ...download, ciphertext: spare(download.ciphertext) }, expected)).toBeUndefined()
    // Sixteen characters carry exactly twelve bytes with no spare bits, so a wrong nonce can only be the wrong size.
    expect(
      GithubBrain.openUpload({ ...download, nonce: Buffer.alloc(11).toString("base64url") }, expected),
    ).toBeUndefined()
    expect(
      GithubBrain.openUpload({ ...download, key: Buffer.alloc(31).toString("base64url") }, expected),
    ).toBeUndefined()
  })
})
