import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test"
import { Flag } from "@vectordevai/core/flag/flag"
import { GUEST_REQUEST_HEADER } from "@vectordevai/core/free-model-guests"
import { ServerAuth } from "../../src/server/auth"
import { Server } from "../../src/server/server"
import { IMPORT_CHARS } from "../../src/server/routes/instance/httpapi/groups/memory"
import { SKILLS_CHARS } from "../../src/brain/vault-memory"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances, tmpdir } from "../fixture/fixture"

// Brain Vault's memory over HTTP (WP A45): what the desktop app encrypts for a backup (GET /memory/backup) and how
// it restores a file it opened with the vault's key (POST /memory/restore). Both are the owner's own: an invited
// guest gets 403. A restore brings back as in use and pinned what the backup had in use and pinned.

const keys = [
  "VECTOR_SERVER_USERNAME",
  "VECTOR_SERVER_PASSWORD",
  "VECTOR_SERVER_GUEST_USERNAME",
  "VECTOR_SERVER_GUEST_PASSWORD",
  "VECTOR_SERVER_GUEST_WORKSPACES",
  "VECTOR_SERVER_GUEST_WORKSPACE_DIRECTORIES",
  "VECTOR_DISABLE_DEFAULT_PLUGINS",
] as const
const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]))
const previousWorkspaceID = Flag.VECTOR_WORKSPACE_ID
const basic = (username: string, password: string) => ServerAuth.header({ username, password }) ?? ""
const owner = { authorization: basic("vector", "owner-secret") }
const guest = { authorization: basic("guest", "guest-secret") }

let listener: Awaited<ReturnType<typeof Server.listen>>
let shared: Awaited<ReturnType<typeof tmpdir>>

beforeAll(async () => {
  shared = await tmpdir({ git: true, trusted: true, config: { formatter: false, lsp: false } })
  Object.assign(process.env, {
    VECTOR_SERVER_USERNAME: "vector",
    VECTOR_SERVER_PASSWORD: "owner-secret",
    VECTOR_SERVER_GUEST_USERNAME: "guest",
    VECTOR_SERVER_GUEST_PASSWORD: "guest-secret",
    VECTOR_SERVER_GUEST_WORKSPACES: "wrk_allowed",
    VECTOR_SERVER_GUEST_WORKSPACE_DIRECTORIES: JSON.stringify({ wrk_allowed: shared.path }),
    VECTOR_DISABLE_DEFAULT_PLUGINS: "1",
  })
  Flag.VECTOR_WORKSPACE_ID = "wrk_allowed"
  listener = await Server.listen({ hostname: "127.0.0.1", port: 0 })
})

afterAll(async () => {
  await listener.stop(true)
  Flag.VECTOR_WORKSPACE_ID = previousWorkspaceID
  for (const key of keys) {
    const value = previous[key]
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  await shared[Symbol.asyncDispose]()
})

afterEach(async () => {
  await disposeAllInstances()
  await resetDatabase()
})

const call = (method: string, route: string, body?: unknown, headers: Record<string, string> = owner) => {
  const url = new URL(route, listener.url)
  url.searchParams.set("directory", shared.path)
  return fetch(url, {
    method,
    keepalive: false,
    headers: { ...headers, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
}

const entry = (input: { id: string; text: string; status: string; pinned: boolean; kind?: string }) => ({
  id: input.id,
  scope: "personal",
  kind: input.kind ?? "preference",
  status: input.status,
  text: input.text,
  paths: [],
  pinned: input.pinned,
  evidence: [],
  createdAt: 1_700_000_000_000,
})

describe("Brain Vault memory routes", () => {
  test("restored skills and insight history wait for review and never restore approval or pins", async () => {
    const skill = { ...entry({ id: "s_import", text: "Check changes", status: "active", pinned: true, kind: "skill" }),
      scope: "repository", private: true, skill: { name: "learned-check-changes", description: "Check changes",
        procedure: "Run the repository check.", checks: ["bun test"], commands: ["git diff"], version: 1 },
    }
    const file = { format: "vector-memory", version: 1, scope: "repository", exportedAt: Date.now(), entries: [], documents: [], skills: [skill] }
    const restored = await call("POST", "/memory/restore", { section: "skills", text: JSON.stringify(file), repository: "" })
    expect(restored.status).toBe(200)
    expect(await restored.json()).toMatchObject({ restored: 1, active: 0, pinned: 0, waiting: 1 })
    const skills = await call("GET", "/memory/skills?filter=review")
    const listing = await skills.json() as { entries?: Array<{ status: string; private?: boolean }> }
    expect(JSON.stringify(listing)).toContain('"private":true')
    const insights = { format: "vector-workflow-insights", version: 1, rows: [{ tier: "standard", model: "vector-plan/floor", effort: "default", split: "solo", runs: 10, passRate: 1, checkedShare: 1 }] }
    const history = await call("POST", "/memory/restore", { section: "insights", text: JSON.stringify(insights), repository: "" })
    expect(history.status).toBe(200)
    expect(await history.json()).toMatchObject({ active: 0, pinned: 0, waiting: 1 })
  }, 30_000)
  test("an invited guest gets 403 from the backup and the restore", async () => {
    expect((await call("GET", "/memory/backup", undefined, guest)).status).toBe(403)
    expect((await call("POST", "/memory/restore", { text: "{}", repository: "" }, guest)).status).toBe(403)
  }, 30_000)

  test("owner credentials carrying the forwarded-guest marker get 403 from the backup and the restore", async () => {
    const forwarded = { ...owner, [GUEST_REQUEST_HEADER]: "1" }
    expect((await call("GET", "/memory/backup", undefined, forwarded)).status).toBe(403)
    expect((await call("POST", "/memory/restore", { text: "{}", repository: "" }, forwarded)).status).toBe(403)
    expect((await call("GET", "/memory/backup")).status).toBe(200)
  }, 30_000)

  test("the backup carries the owner's memory as export JSON, one file per place", async () => {
    const created = await call("POST", "/memory", {
      kind: "preference",
      text: "I prefer tables for comparisons",
      scope: "personal",
    })
    expect(created.status).toBe(200)
    const answer = await call("GET", "/memory/backup")
    expect(answer.status).toBe(200)
    const body = (await answer.json()) as {
      files: { path: string; section: string; text: string; repository: string }[]
    }
    const personal = body.files.find((file) => file.path === "memory/personal.json")
    expect(personal?.section).toBe("memory")
    expect(personal?.repository).toBe("")
    const file = JSON.parse(personal!.text) as { format: string; version: number; entries: { text: string }[] }
    expect(file.format).toBe("vector-memory")
    expect(file.version).toBe(1)
    expect(file.entries.map((item) => item.text)).toContain("I prefer tables for comparisons")
  }, 30_000)

  test("a restore keeps what was in use and pinned, and what waited waits again", async () => {
    const text = JSON.stringify({
      format: "vector-memory",
      version: 1,
      scope: "personal",
      exportedAt: 1_700_000_000_000,
      entries: [
        entry({ id: "m1", text: "I prefer short commit messages", status: "active", pinned: true }),
        entry({
          id: "m2",
          text: "When I say ship it, I mean open a PR",
          status: "proposed",
          pinned: false,
          kind: "term",
        }),
      ],
      documents: [],
    })
    const restored = await call("POST", "/memory/restore", { text, repository: "" })
    expect(restored.status).toBe(200)
    expect(await restored.json()).toEqual({
      restored: 2,
      active: 1,
      pinned: 1,
      waiting: 1,
      known: 0,
      refused: 0,
      documents: 0,
    })
    const listed = (await (await call("GET", "/memory?scope=personal&filter=active")).json()) as {
      entries: { text: string; pinned: boolean }[]
    }
    expect(listed.entries.find((item) => item.text === "I prefer short commit messages")?.pinned).toBe(true)
    const again = await call("POST", "/memory/restore", { text, repository: "" })
    expect(((await again.json()) as { known: number }).known).toBe(2)
  }, 30_000)

  test("a file this version cannot read, and one past 2 MB, are refused", async () => {
    const unreadable = await call("POST", "/memory/restore", {
      text: JSON.stringify({ format: "vector-memory", version: 9 }),
      repository: "",
    })
    expect(unreadable.status).toBe(400)
    const big = await call("POST", "/memory/restore", { text: "x".repeat(2 * 1024 * 1024 + 1), repository: "" })
    expect(big.status).toBe(400)
  }, 30_000)

  // One repository's own calls, for the cases below that need repositories of their own.
  const at = (directory: string, method: string, route: string, body?: unknown) => {
    const url = new URL(route, listener.url)
    url.searchParams.set("directory", directory)
    return fetch(url, {
      method,
      keepalive: false,
      headers: { ...owner, ...(body === undefined ? {} : { "content-type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
  }
  const ok = async (response: Response) => {
    const body = (await response.json()) as Record<string, unknown>
    expect([response.status, body]).toEqual([200, expect.anything()])
    return body
  }
  const projectOf = async (directory: string) =>
    ((await ok(await at(directory, "GET", "/project/current"))) as { id: string }).id
  type Skill = { name: string; private?: boolean; description?: string; procedure?: string; paths?: string[] }
  // Learned skills as an export file carries them, imported through POST /memory/import, which waits each for review.
  const importSkills = async (directory: string, skills: readonly Skill[]) => {
    const items = skills.map((skill) => ({
      ...entry({ id: `s_${skill.name}`, text: skill.name, status: "active", pinned: false, kind: "skill" }),
      scope: "repository",
      paths: skill.paths ?? ["src/a.ts"],
      ...(skill.private ? { private: true } : {}),
      skill: {
        name: skill.name,
        description: skill.description ?? "When bun typecheck fails in src: run it, then read the first error.",
        procedure: skill.procedure ?? "## Steps\n1. Run bun typecheck.\n2. Read the first error and fix it.",
        checks: ["bun typecheck"],
        commands: ["git diff src"],
        version: 1,
      },
    }))
    const text = JSON.stringify({
      format: "vector-memory",
      version: 1,
      scope: "repository",
      exportedAt: Date.now(),
      entries: [],
      documents: [],
      skills: items,
    })
    const imported = (await ok(await at(directory, "POST", "/memory/import", { text }))) as {
      entries: unknown[]
      refused: number
    }
    expect([imported.entries.length, imported.refused]).toEqual([skills.length, 0])
  }
  const review = async (directory: string) =>
    (await ok(await at(directory, "GET", "/memory/skills?filter=review"))).skills as {
      id: string
      status: string
      private?: boolean
      skill: { name: string }
    }[]
  const approveAll = async (directory: string) => {
    for (const skill of await review(directory))
      await ok(await at(directory, "PATCH", `/memory/skills/${skill.id}`, { action: "approve" }))
  }
  type BackupFile = { path: string; section: string; text: string; repository: string; worktree?: string }
  const backupOf = async (directory: string, repository: string) =>
    ((await ok(await at(directory, "GET", "/memory/backup"))).files as BackupFile[]).filter(
      (file) => file.repository === repository,
    )
  const restoreInto = async (directory: string, repository: string, file: BackupFile) =>
    (await ok(
      await at(directory, "POST", "/memory/restore", {
        section: file.section,
        text: file.text,
        repository,
        worktree: directory,
      }),
    )) as {
      restored: number
      active: number
      pinned: number
      waiting: number
      known: number
      refused: number
      documents: number
    }

  test("a skills backup holds only what a restore brings back, without evidence, in files under the restore limit (R45-10)", async () => {
    await using a = await tmpdir({ git: true, trusted: true, config: { formatter: false, lsp: false } })
    await using b = await tmpdir({ git: true, trusted: true, config: { formatter: false, lsp: false } })
    // The most a repository keeps that a restore reads: 50 skills in use (SkillStore.KEEP.skills) and 20 waiting
    // (BrainSkill.LIMIT.pending), each at the longest description (200) and procedure (4,000, half of it characters
    // JSON escapes), with 20 paths (LIMIT.paths, whose length nothing limits) of 1,200 characters.
    const procedure = (() => {
      const steps = "\n## Steps\n1. Run bun typecheck.\n2. Read the first error and fix it."
      return `## Notes\n${'"\\'.repeat((4000 - 9 - steps.length) / 2)}${steps}`.slice(0, 4000)
    })()
    expect(procedure.length).toBeLessThanOrEqual(4000)
    const description =
      "When bun typecheck fails in src: run it, read the first error, fix the type at its line, then run it again. "
        .repeat(2)
        .slice(0, 200)
        .trim()
    const paths = Array.from({ length: 20 }, (_, index) => `src/${"deep-folder-name/".repeat(70)}file-${index}.ts`)
    const skill = (index: number): Skill => ({ name: `learned-worst-case-${index}`, description, procedure, paths })
    const names = (from: number, count: number) => Array.from({ length: count }, (_, index) => skill(from + index))
    for (const [from, count] of [
      [0, 20],
      [20, 20],
      [40, 10],
    ] as const) {
      await importSkills(a.path, names(from, count))
      await approveAll(a.path)
    }
    // One put away, and one more in use in its place: archived rows never restore, so they stay out.
    const listed = (await ok(await at(a.path, "GET", "/memory/skills"))).skills as {
      id: string
      skill: { name: string }
    }[]
    const archived = listed.find((item) => item.skill.name === "learned-worst-case-0")!
    await ok(await at(a.path, "PATCH", `/memory/skills/${archived.id}`, { action: "archive" }))
    await importSkills(a.path, names(50, 1))
    await approveAll(a.path)
    await importSkills(a.path, names(51, 20))
    expect((await ok(await at(a.path, "GET", "/memory/skills"))).skills).toHaveLength(50)
    expect(await review(a.path)).toHaveLength(20)

    const repository = await projectOf(a.path)
    const files = (await backupOf(a.path, repository)).filter((file) => file.section === "skills")
    const sizes = files.map((file) => file.text.length)
    // Together they are past what one restore request takes; each file is under it.
    expect(sizes.reduce((sum, size) => sum + size, 0)).toBeGreaterThan(IMPORT_CHARS)
    expect(files.length).toBeGreaterThan(1)
    for (const size of sizes) expect(size).toBeLessThanOrEqual(SKILLS_CHARS)
    expect(files.map((file) => file.path)).toEqual([
      expect.stringMatching(/^skills\/repository-[0-9a-f]{24}\.json$/),
      ...files
        .slice(1)
        .map((_, index) => expect.stringMatching(new RegExp(`^skills/repository-[0-9a-f]{24}-${index + 2}\\.json$`))),
    ])
    const backedUp = files.flatMap(
      (file) =>
        (JSON.parse(file.text) as { skills: { status: string; evidence: unknown[]; skill: { name: string } }[] })
          .skills,
    )
    expect(backedUp.map((item) => item.skill.name).toSorted()).toEqual(
      names(1, 70)
        .map((item) => item.name)
        .toSorted(),
    )
    expect(new Set(backedUp.map((item) => item.status))).toEqual(new Set(["active", "proposed"]))
    expect(backedUp.every((item) => item.evidence.length === 0)).toBe(true)

    // The skills in use come first in the backup, so a restore that stops at the pending limit keeps approved ones.
    expect(backedUp.map((item) => item.status)).toEqual([
      ...Array.from({ length: 50 }, () => "active"),
      ...Array.from({ length: 20 }, () => "proposed"),
    ])

    // Every file restores. A repository takes at most 20 skills waiting for review, so the rest are refused.
    const restored = []
    for (const file of files) restored.push(await restoreInto(b.path, await projectOf(b.path), file))
    expect(restored.reduce((sum, item) => sum + item.restored, 0)).toBe(20)
    expect(restored.reduce((sum, item) => sum + item.refused, 0)).toBe(50)
    const inUse = new Set(names(1, 50).map((item) => item.name))
    const back = await review(b.path)
    expect(back).toHaveLength(20)
    expect(back.filter((item) => !inUse.has(item.skill.name))).toEqual([])
    expect((await ok(await at(b.path, "GET", "/memory/skills"))).skills).toEqual([])
  }, 240_000)

  test("a skill longer than a part by itself gets a part of its own, and every part still restores", async () => {
    await using a = await tmpdir({ git: true, trusted: true, config: { formatter: false, lsp: false } })
    await using b = await tmpdir({ git: true, trusted: true, config: { formatter: false, lsp: false } })
    // 20 paths of about 80,000 characters: one skill of about 1.6 million, past SKILLS_CHARS and under IMPORT_CHARS.
    const paths = Array.from({ length: 20 }, (_, index) => `src/${"deep-folder-name/".repeat(4_700)}file-${index}.ts`)
    await importSkills(a.path, [
      { name: "learned-short-a" },
      { name: "learned-oversize", paths },
      { name: "learned-short-b" },
    ])
    const files = (await backupOf(a.path, await projectOf(a.path))).filter((file) => file.section === "skills")
    const parts = files.map((file) =>
      (JSON.parse(file.text) as { skills: { skill: { name: string } }[] }).skills.map((item) => item.skill.name),
    )
    expect(parts.flat().toSorted()).toEqual(["learned-oversize", "learned-short-a", "learned-short-b"])
    const oversize = parts.findIndex((names) => names.includes("learned-oversize"))
    expect(parts[oversize]).toEqual(["learned-oversize"])
    expect(files[oversize]!.text.length).toBeGreaterThan(SKILLS_CHARS)
    expect(files[oversize]!.text.length).toBeLessThanOrEqual(IMPORT_CHARS)
    for (const [index, file] of files.entries())
      if (index !== oversize) expect(file.text.length).toBeLessThanOrEqual(SKILLS_CHARS)

    const restored = []
    for (const file of files) restored.push(await restoreInto(b.path, await projectOf(b.path), file))
    expect(restored.reduce((sum, item) => sum + item.restored, 0)).toBe(3)
    expect(restored.reduce((sum, item) => sum + item.refused, 0)).toBe(0)
  }, 120_000)

  test("learned skills and workflow insights restore into another repository as proposals to review, keeping privacy and seeding no learner stats (B10)", async () => {
    await using a = await tmpdir({ git: true, trusted: true, config: { formatter: false, lsp: false } })
    await using b = await tmpdir({ git: true, trusted: true, config: { formatter: false, lsp: false } })
    await importSkills(a.path, [{ name: "learned-bun-typecheck-src", private: true }, { name: "learned-bun-test-src" }])
    await approveAll(a.path)
    const before = (await ok(await at(a.path, "GET", "/memory/skills"))).skills as { private?: boolean }[]
    expect(before.map((item) => item.private === true).toSorted()).toEqual([false, true])

    const [repository, other] = [await projectOf(a.path), await projectOf(b.path)]
    expect(other).not.toBe(repository)
    const files = await backupOf(a.path, repository)
    expect(files.map((file) => file.section)).toEqual(["skills"])
    expect(files[0]!.worktree).toBe(a.path)
    const skills = await restoreInto(b.path, other, files[0]!)
    expect(skills).toEqual({ restored: 2, active: 0, pinned: 0, waiting: 2, known: 0, refused: 0, documents: 0 })
    // The insights file a backup holds for a repository with recorded runs (BrainTransfer.insights).
    const insights = {
      path: "insights/repository-0123456789abcdef01234567.json",
      section: "insights",
      repository,
      text: JSON.stringify({
        format: "vector-workflow-insights",
        version: 1,
        rows: [
          {
            tier: "thorough",
            model: "anthropic/claude-x",
            effort: "default",
            split: "solo",
            runs: 8,
            passRate: 1,
            checkedShare: 1,
          },
        ],
      }),
    }
    expect(await restoreInto(b.path, other, insights)).toMatchObject({ restored: 1, active: 0, pinned: 0, waiting: 1 })

    expect((await ok(await at(b.path, "GET", "/memory/skills"))).skills).toEqual([])
    const waiting = await review(b.path)
    expect(waiting.map((item) => [item.skill.name, item.status, item.private === true]).toSorted()).toEqual([
      ["learned-bun-test-src", "proposed", false],
      ["learned-bun-typecheck-src", "proposed", true],
    ])
    for (const item of waiting) {
      const detail = (await ok(await at(b.path, "GET", `/memory/skills/${item.id}`))) as {
        uses: unknown
        entry: { skill: { approvedBy?: string } }
      }
      expect(detail.uses).toEqual({ loads: 0, passes: 0, fails: 0, ignored: 0, reverts: 0 })
      expect(detail.entry.skill).toMatchObject({ helpful: 0, harmful: 0 })
      expect(detail.entry.skill.approvedBy).toBeUndefined()
    }
    const workflow = (await ok(await at(b.path, "GET", "/memory/workflow"))) as { tiers: { arms: unknown[] }[] }
    expect(workflow.tiers.flatMap((tier) => tier.arms)).toEqual([])
    const lessons = (await ok(await at(b.path, "GET", "/memory?filter=review"))).entries as {
      text: string
      kind: string
    }[]
    expect(lessons.some((item) => item.text.startsWith("Imported workflow observation for thorough work"))).toBe(true)
  }, 120_000)
})
