import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { Effect, ManagedRuntime } from "effect"
import type { Brain } from "@vectordevai/core/brain/brain"
import { BrainSkill } from "@vectordevai/core/brain/skill"
import { LayerNode } from "@vectordevai/core/effect/layer-node"
import { Flag } from "@vectordevai/core/flag/flag"
import { AppNodeBuilderV1 } from "../../src/effect/app-node-builder-v1"
import { ServerAuth } from "../../src/server/auth"
import { Server } from "../../src/server/server"
import { disposeAllInstances, tmpdir } from "../fixture/fixture"

// The learned-skill routes under /memory/skills, over a real listener with an owner and an invited guest, as Settings >
// Memory > Skills reads them: the list, one skill with its versions, the owner's review, edits, versions and undo,
// forget, and Share to the repository. No route drafts a skill, so drafts are written through BrainSkill as the engine's
// learner writes them. The listener builds its own services, so both open the brain as a file in the test's data folder.

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
const previousDatabase = Flag.VECTOR_AGENT_DB
const basic = (username: string, password: string) => ServerAuth.header({ username, password }) ?? ""
const owner = { authorization: basic("vector", "owner-secret") }
const guest = { authorization: basic("guest", "guest-secret") }

// The skills over the brain file the listener uses.
const runtime = ManagedRuntime.make(AppNodeBuilderV1.build(LayerNode.group([BrainSkill.node])))
const skills = <A>(body: (service: BrainSkill.Interface) => Effect.Effect<A>) =>
  runtime.runPromise(
    Effect.gen(function* () {
      const service = yield* BrainSkill.Service
      return yield* body(service)
    }),
  )

let listener: Awaited<ReturnType<typeof Server.listen>>
let shared: Awaited<ReturnType<typeof tmpdir>>

const config = { formatter: false, lsp: false } as const

beforeAll(async () => {
  shared = await tmpdir({ git: true, trusted: true, config })
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
  // A file name, under the test's own data folder: brain.db goes beside it.
  Flag.VECTOR_AGENT_DB = "memory-skills.db"
  listener = await Server.listen({ hostname: "127.0.0.1", port: 0 })
})

afterAll(async () => {
  await listener.stop(true)
  await runtime.dispose()
  Flag.VECTOR_WORKSPACE_ID = previousWorkspaceID
  Flag.VECTOR_AGENT_DB = previousDatabase
  for (const key of keys) {
    const value = previous[key]
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  await shared[Symbol.asyncDispose]()
})

afterEach(async () => {
  await disposeAllInstances()
})

// A listener reused across tests: a pooled keep-alive socket could carry one test's request into another's.
const call = (directory: string, method: string, route: string, body?: unknown, headers = owner) => {
  const url = new URL(route, listener.url)
  url.searchParams.set("directory", directory)
  return fetch(url, {
    method,
    keepalive: false,
    headers: { ...headers, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
}

const json = async (response: Response, status = 200) => {
  const body = (await response.json()) as any
  expect([response.status, body]).toEqual([status, expect.anything()])
  return body
}

// The brain place the routes use for a repository: its key is the repository's id.
const place = async (directory: string): Promise<Brain.Place> => {
  const project = (await json(await call(directory, "GET", "/project/current"))) as { id: string }
  return { repository: project.id, root: directory, sources: [], held: false }
}

// A run that turned `bun typecheck` green, as the engine's learner traces it.
const trace = (sessionID: string, area = "src"): BrainSkill.Trace => ({
  sessionID,
  requestID: `msg_${sessionID}`,
  signal: "recovered",
  check: {
    command: "bun typecheck",
    target: "bun typecheck",
    failure: "src/a.ts(3,1): error TS2322: Type 'string' is not assignable to type 'number'.",
  },
  commands: [`git diff ${area}`, `cat ${area}/a.ts`],
  edited: [`${area}/a.ts`],
  read: [`${area}/b.ts`],
  closing: "Fixed the type error.",
  at: Date.now(),
})

// A draft waiting for review, as a run in `sessionID` wrote it.
const draft = async (where: Brain.Place, sessionID = "ses_a", area = "src") => {
  const run = trace(sessionID, area)
  const result = await skills((service) =>
    service.propose(where, BrainSkill.draft(run)!, {
      origin: "agent",
      sessionID,
      requestID: run.requestID,
      evidence: { type: "run", command: "bun typecheck", requestID: run.requestID, verified: true },
      trace: run,
    }),
  )
  if (result.type === "refused") throw new Error(`refused: ${result.reason}`)
  return result.entry
}

describe("memory skill routes", () => {
  test("every skill and workflow route is the owner's own: an invited guest gets 403 on each", async () => {
    for (const [method, route, body] of [
      ["GET", "/memory/skills"],
      ["GET", "/memory/skills/s0000000"],
      ["PATCH", "/memory/skills/s0000000", { action: "approve" }],
      ["DELETE", "/memory/skills/s0000000"],
      ["GET", "/memory/skills/s0000000/share"],
      ["POST", "/memory/skills/s0000000/share", {}],
      ["GET", "/memory/workflow"],
      ["DELETE", "/memory/workflow"],
    ] as const)
      expect([method, route, (await call(shared.path, method, route, body, guest)).status]).toEqual([
        method,
        route,
        403,
      ])
  })

  test("lists drafts with the skill settings, and gives one with its evidence, versions and uses", async () => {
    await using tmp = await tmpdir({ git: true, trusted: true, config })
    const entry = await draft(await place(tmp.path))
    const list = await json(await call(tmp.path, "GET", "/memory/skills?filter=review"))
    expect(list.settings).toEqual({ skills: "review", skillDrafter: "local-only" })
    expect(list.skills.map((item: { id: string }) => item.id)).toEqual([entry.id])
    expect(list.skills[0]).toMatchObject({ kind: "skill", status: "proposed", skill: { checks: ["bun typecheck"] } })
    expect((await json(await call(tmp.path, "GET", "/memory/skills"))).skills).toEqual([])
    const detail = await json(await call(tmp.path, "GET", `/memory/skills/${entry.id}`))
    expect(detail.versions.map((item: { version: number }) => item.version)).toEqual([1])
    expect(detail.evidence).toMatchObject([{ type: "run", command: "bun typecheck", sessionID: "ses_a" }])
    expect(detail.uses).toEqual({ loads: 0, passes: 0, fails: 0, ignored: 0, reverts: 0 })
    const gone = await call(tmp.path, "GET", "/memory/skills/s0000000")
    expect(gone.status).toBe(400)
    expect(await gone.json()).toMatchObject({ data: { code: "not-found" } })
  }, 60_000)

  test("the owner edits, approves, rolls back, archives, restores, undoes and forgets a skill", async () => {
    await using tmp = await tmpdir({ git: true, trusted: true, config })
    const entry = await draft(await place(tmp.path))
    const patch = (body: unknown) => call(tmp.path, "PATCH", `/memory/skills/${entry.id}`, body)

    const edited = await json(
      await patch({ description: "When bun typecheck fails in src: run it, then read the error." }),
    )
    expect(edited.entry.skill).toMatchObject({ version: 2, drafter: "user" })
    expect(edited.versions.map((item: { reason: string }) => item.reason)).toEqual(["edited", "learned"])

    const approved = await json(await patch({ action: "approve" }))
    expect(approved.entry).toMatchObject({ status: "active", skill: { approvedBy: "user" } })

    const rolled = await json(await patch({ action: "rollback", version: 1 }))
    expect(rolled.entry.skill.version).toBe(3)
    expect(rolled.entry.skill.description).toBe(entry.skill!.description)
    expect(rolled.versions[0]).toMatchObject({ version: 3, reason: "rollback" })

    expect((await json(await patch({ action: "archive" }))).entry.status).toBe("archived")
    // With no other skill of the key in use, restoring brings the entry itself back.
    expect((await json(await patch({ action: "restore" }))).entry.status).toBe("active")
    expect((await json(await patch({ action: "undo" }))).entry.status).toBe("archived")

    // An edit is checked as a draft is: a command off the allow lists is refused.
    const unsafe = await patch({ commands: ["rm -fr src"] })
    expect(unsafe.status).toBe(400)
    expect(await unsafe.json()).toMatchObject({ data: { code: "refused", reason: "unsafe-command" } })

    expect(await json(await call(tmp.path, "DELETE", `/memory/skills/${entry.id}`))).toEqual({ forgotten: true })
    expect((await call(tmp.path, "GET", `/memory/skills/${entry.id}`)).status).toBe(400)
    expect((await call(tmp.path, "DELETE", `/memory/skills/${entry.id}`)).status).toBe(400)
  }, 60_000)

  test("a rejected draft is gone, and memory's own routes refuse a skill and say where it is changed", async () => {
    await using tmp = await tmpdir({ git: true, trusted: true, config })
    const entry = await draft(await place(tmp.path))
    for (const [method, body] of [
      ["PATCH", { text: "Something else" }],
      ["PATCH", { action: "approve" }],
      ["DELETE", undefined],
    ] as const) {
      const response = await call(tmp.path, method, `/memory/${entry.id}`, body)
      expect(response.status).toBe(400)
      expect(await response.json()).toMatchObject({ data: { code: "refused", reason: "skill-entry" } })
    }
    expect((await json(await call(tmp.path, "GET", `/memory/skills/${entry.id}`))).entry.status).toBe("proposed")
    const rejected = await json(await call(tmp.path, "PATCH", `/memory/skills/${entry.id}`, { action: "reject" }))
    expect(rejected.entry.id).toBe(entry.id)
    expect((await call(tmp.path, "GET", `/memory/skills/${entry.id}`)).status).toBe(400)
  }, 60_000)

  test("Share refuses what repeats the owner's memory, writes inside the repository only, and reloads when idle", async () => {
    await using tmp = await tmpdir({ git: true, trusted: true, config })
    const where = await place(tmp.path)
    const share = (id: string, body: unknown = {}) => call(tmp.path, "POST", `/memory/skills/${id}/share`, body)

    // A draft is shared only once the owner approves it.
    const waiting = await draft(where, "ses_wait", "lib")
    expect(await (await share(waiting.id)).json()).toMatchObject({ data: { reason: "not-approved" } })

    // Steps that repeat a fact the owner told Vector are refused, with the sentences listed.
    const fact = "Initech pays its invoices through pay.initech-billing.com from account 99812345"
    expect((await call(tmp.path, "POST", "/memory", { kind: "fact", text: fact, scope: "personal" })).status).toBe(200)
    const personal = await draft(where, "ses_personal", "billing")
    await json(
      await call(tmp.path, "PATCH", `/memory/skills/${personal.id}`, {
        procedure: `## Steps\n1. Run \`bun typecheck\`.\n2. ${fact}.`,
      }),
    )
    await json(await call(tmp.path, "PATCH", `/memory/skills/${personal.id}`, { action: "approve" }))
    const refused = await share(personal.id)
    expect(refused.status).toBe(400)
    const body = await refused.json()
    expect(body).toMatchObject({ data: { code: "refused", reason: "personal" } })
    expect(body.data.message).toContain("99812345")

    // A link where the file would go could land it anywhere, so nothing is written through it.
    const entry = await draft(where, "ses_share", "src")
    await json(await call(tmp.path, "PATCH", `/memory/skills/${entry.id}`, { action: "approve" }))
    const folder = path.join(tmp.path, ".vector", "skills", entry.skill!.name)
    await using outside = await tmpdir()
    await fs.mkdir(path.dirname(folder), { recursive: true })
    // A junction on Windows, as elsewhere in these tests. Only the link is removed: unlink drops a junction without
    // following it, where Bun's rm on Windows fails on a link to a folder.
    await fs.symlink(outside.path, folder, process.platform === "win32" ? "junction" : "dir")
    expect(await (await share(entry.id)).json()).toMatchObject({ data: { reason: "outside" } })
    expect(await fs.readdir(outside.path)).toEqual([])
    await fs.unlink(folder)

    // A file already there is replaced only with force.
    const file = path.join(folder, "SKILL.md")
    await fs.mkdir(folder, { recursive: true })
    await fs.writeFile(file, "mine")
    expect(await (await share(entry.id)).json()).toMatchObject({ data: { reason: "exists" } })
    expect(await fs.readFile(file, "utf8")).toBe("mine")
    expect(await json(await share(entry.id, { force: true }))).toEqual({
      path: `.vector/skills/${entry.skill!.name}/SKILL.md`,
      trust: "changed",
      reload: "when-idle",
    })
    const written = await fs.readFile(file, "utf8")
    expect(written).toContain(`name: ${entry.skill!.name}`)
    expect(written).toContain('  version: "1"')
    expect(written).not.toContain("TS2322")
    expect(written).not.toContain("ses_share")
    // The learned copy is put away once the team's file exists.
    expect((await json(await call(tmp.path, "GET", `/memory/skills/${entry.id}`))).entry).toMatchObject({
      status: "archived",
      skill: { sharedPath: `.vector/skills/${entry.skill!.name}/SKILL.md` },
    })
  }, 60_000)

  test("the Share preview is the file sharing writes, byte for byte, from a session in a subfolder too", async () => {
    await using tmp = await tmpdir({ git: true, trusted: true, config })
    const where = await place(tmp.path)
    const entry = await draft(where, "ses_preview", "src")
    const name = entry.skill!.name
    // A draft would be refused, and the preview says so before anything is written.
    const waiting = await call(tmp.path, "GET", `/memory/skills/${entry.id}/share`)
    expect(waiting.status).toBe(400)
    expect(await waiting.json()).toMatchObject({ data: { reason: "not-approved" } })
    await json(await call(tmp.path, "PATCH", `/memory/skills/${entry.id}`, { action: "approve" }))

    // The session works in a subfolder; the file still goes under the repository's root, as the server words it.
    const sub = path.join(tmp.path, "packages", "app")
    await fs.mkdir(sub, { recursive: true })
    const preview = await json(await call(sub, "GET", `/memory/skills/${entry.id}/share`))
    expect(preview).toMatchObject({ path: `.vector/skills/${name}/SKILL.md`, exists: false })
    expect(await Bun.file(path.join(tmp.path, preview.path)).exists()).toBe(false)
    expect(await json(await call(sub, "POST", `/memory/skills/${entry.id}/share`, {}))).toMatchObject({
      path: preview.path,
    })
    expect(await fs.readFile(path.join(tmp.path, preview.path), "utf8")).toBe(preview.text)
  }, 60_000)

  test("the skill and workflow settings round-trip through the memory settings", async () => {
    const before = await json(await call(shared.path, "GET", "/memory/settings"))
    expect(before).toMatchObject({
      skills: "review",
      skillDrafter: "local-only",
      workflow: "apply",
      workflowExplore: false,
    })
    const changed = await json(
      await call(shared.path, "PATCH", "/memory/settings", {
        skills: "auto",
        skillDrafter: "off",
        workflow: "observe",
        workflowExplore: true,
      }),
    )
    expect(changed).toMatchObject({ skills: "auto", skillDrafter: "off", workflow: "observe", workflowExplore: true })
    expect(await json(await call(shared.path, "GET", "/memory/settings"))).toMatchObject(changed)
    expect((await json(await call(shared.path, "GET", "/memory/skills"))).settings).toEqual({
      skills: "auto",
      skillDrafter: "off",
    })
    // The other settings stay as they were.
    expect(changed.learning).toBe(before.learning)
    expect(changed.facets).toEqual(before.facets)
    await call(shared.path, "PATCH", "/memory/settings", {
      skills: "review",
      skillDrafter: "local-only",
      workflow: "apply",
      workflowExplore: false,
    })
  }, 60_000)

  test("memory counts skills apart from the entries it lists", async () => {
    await using tmp = await tmpdir({ git: true, trusted: true, config })
    await draft(await place(tmp.path))
    const list = await json(await call(tmp.path, "GET", "/memory?filter=all"))
    expect(list.stats.skills).toEqual({ active: 0, review: 1 })
    expect(list.entries.some((entry: { kind: string }) => entry.kind === "skill")).toBe(false)
  }, 60_000)
})
