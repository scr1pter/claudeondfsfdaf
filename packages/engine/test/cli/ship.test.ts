import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { LocalPolicy } from "@vectordevai/core/local-mode/policy"
import { LocalSources } from "@vectordevai/core/local-mode/sources"
import { ShipDesk } from "@vectordevai/schema/ship-desk"
import {
  captureApi,
  captureEnvironmentProblem,
  captureShots,
  childEnvironment,
  ShipError,
  siteOrigin,
  type CaptureApi,
  type Runner,
} from "../../src/cli/cmd/ship"

// `vector ship capture` (WP A49) with its outside world replaced: the capture API is an in-memory server that answers as
// api/ops/uploads.ts does, and the runner (git, the repository's commands, the browser) is a fake that records what it
// was asked. Nothing reaches a network, no app starts and no browser opens.

const HEAD = "a".repeat(40)
const BASE = "b".repeat(40)
const TICKET = `vcap_${"t".repeat(43)}`
const SHIP = { install: "npm ci", build: "npm run build", start: "npm start", port: 4100, routes: ["/", "/pricing"] }

function png(size = 400) {
  const bytes = new Uint8Array(size)
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52])
  new DataView(bytes.buffer).setUint32(16, 1280)
  new DataView(bytes.buffer).setUint32(20, 800)
  return bytes
}

let work = ""
beforeEach(async () => {
  work = await fs.mkdtemp(path.join(os.tmpdir(), "ship-test-"))
})
afterEach(async () => {
  await fs.rm(work, { recursive: true, force: true })
})

/** A server answering as `POST /api/ops/uploads` does, and the storage links it signs. */
function server(options: { card?: Partial<ShipDesk.CardAnswer>; pending?: number } = {}) {
  const calls: {
    action?: string
    body?: any
    authorization?: string
    url: string
    method: string
    bytes?: number
    headers?: Record<string, string>
  }[] = []
  let pending = options.pending ?? 0
  const send = async (url: string, init: RequestInit) => {
    const method = init.method ?? "GET"
    const headers = Object.fromEntries(new Headers(init.headers).entries())
    if (url.startsWith("https://storage.example/")) {
      const bytes = init.body instanceof Blob ? init.body.size : 0
      calls.push({ url, method, bytes, headers })
      return new Response(null, { status: 200 })
    }
    const body = JSON.parse(String(init.body))
    calls.push({ url, method, action: body.action, body, authorization: headers.authorization })
    if (body.action === "card") {
      if (pending-- > 0)
        return Response.json(
          { error: { code: "SHIP_DESK_CARD_PENDING", message: "not yet", retryAfterMs: 10 } },
          { status: 409 },
        )
      return Response.json({
        repository: "octo/app",
        number: 12,
        baseRef: "main",
        baseSha: BASE,
        headSha: HEAD,
        files: 8,
        ...options.card,
      })
    }
    if (body.action === "start")
      return Response.json({
        capture: "cap_" + "c".repeat(22),
        until: Date.now() + 900_000,
        uploads: body.files.map((file: ShipDesk.CaptureFile, index: number) => ({
          n: index + 1,
          url: `https://storage.example/${index + 1}`,
          method: "PUT",
          headers: { "content-length": String(file.bytes), "content-type": file.type },
          expiresAt: Date.now() + 900_000,
        })),
      })
    if (body.action === "finish")
      return Response.json({ images: calls.filter((c) => c.method === "PUT").length, refused: [] })
    return Response.json({ error: { code: "X", message: "no" } }, { status: 400 })
  }
  return { calls, send, api: captureApi({ site: "https://vectordev.ai", ticket: TICKET, send }) }
}

/** The runner: git answers from a table, commands succeed unless told otherwise, the browser writes a PNG. */
function runner(
  options: {
    head?: string
    baseMissing?: boolean
    ship?: string | null
    failing?: { slot: "before" | "after"; command: string }
    shootFails?: string[]
  } = {},
) {
  const log: string[] = []
  const envs: Record<string, string>[] = []
  const slotOf = (cwd: string) => (cwd.endsWith(`${path.sep}before`) ? "before" : "after")
  const fake: Runner = {
    async run(command, cwd, env) {
      log.push(`run ${slotOf(cwd)} ${command}`)
      envs.push(env)
      return options.failing && options.failing.slot === slotOf(cwd) && options.failing.command === command ? 2 : 0
    },
    start(command, cwd, env) {
      log.push(`start ${slotOf(cwd)} ${command} PORT=${env.PORT}`)
      envs.push(env)
      return { exited: new Promise<number>(() => {}), stop: async () => void log.push(`stop ${slotOf(cwd)}`) }
    },
    async git(args) {
      log.push(`git ${args.join(" ")}`)
      if (args[0] === "rev-parse") return { code: 0, stdout: `${options.head ?? HEAD}\n` }
      if (args[0] === "cat-file") return { code: options.baseMissing ? 1 : 0, stdout: "" }
      if (args[0] === "show") {
        if (options.ship === null) return { code: 128, stdout: "" }
        return { code: 0, stdout: options.ship ?? JSON.stringify(SHIP) }
      }
      return { code: 0, stdout: "" }
    },
    async answers() {
      return true
    },
    async shoot(url, file) {
      log.push(`shoot ${url}`)
      if (options.shootFails?.includes(url)) return false
      await fs.writeFile(file, png())
      return true
    },
    async sleep() {},
  }
  return { fake, log, envs }
}

describe("the capture job's environment", () => {
  test("refuses a job that can mint OIDC tokens or holds a run token or an account token", () => {
    const none = () => false
    expect(captureEnvironmentProblem({}, none)).toBeUndefined()
    expect(captureEnvironmentProblem({ ACTIONS_ID_TOKEN_REQUEST_URL: "https://x" }, none)).toContain("id-token")
    expect(captureEnvironmentProblem({ ACTIONS_ID_TOKEN_REQUEST_TOKEN: "t" }, none)).toContain("id-token")
    expect(
      captureEnvironmentProblem(
        { RUNNER_TEMP: "/tmp/r" },
        (file) => file === path.join("/tmp/r", "vector-secrets", "run-token"),
      ),
    ).toContain("run token")
    expect(captureEnvironmentProblem({ VECTOR_CLI_TOKEN: "vct_x" }, none)).toContain("VECTOR_CLI_TOKEN")
  })

  test("the repository's commands never see Vector's ticket, tokens or secrets", () => {
    const env = childEnvironment({
      PATH: "/usr/bin",
      CI: "true",
      VECTOR_CAPTURE_TICKET: TICKET,
      VECTOR_CLI_TOKEN: "vct_x",
      VECTOR_SOME_SECRET: "s",
      VECTOR_SITE_URL: "https://vectordev.ai",
      ACTIONS_ID_TOKEN_REQUEST_URL: "https://x",
      GITHUB_REPOSITORY: "octo/app",
    })
    expect(env).toEqual({
      PATH: "/usr/bin",
      CI: "true",
      VECTOR_SITE_URL: "https://vectordev.ai",
      GITHUB_REPOSITORY: "octo/app",
    })
  })

  test("the site is https, or plain http on this computer only", () => {
    expect(siteOrigin(undefined)).toBe("https://vectordev.ai")
    expect(siteOrigin("https://preview.vectordev.ai/x")).toBe("https://preview.vectordev.ai")
    expect(siteOrigin("http://localhost:3000")).toBe("http://localhost:3000")
    expect(() => siteOrigin("http://vectordev.ai")).toThrow(ShipError)
  })

  test("its connections are labelled ship-desk, which Vector Local blocks except for the app on this computer", () => {
    const source = LocalSources.get("ship-desk")!
    expect(source.callSites).toContain("packages/engine/src/cli/cmd/ship.ts")
    const on = LocalPolicy.resolve({ global: { enabled: true } })
    expect(
      LocalPolicy.decide(on, {
        purpose: source.purpose,
        url: "https://vectordev.ai/api/ops/uploads",
        source: "ship-desk",
      }).decision,
    ).not.toBe("allow")
    expect(
      LocalPolicy.decide(on, { purpose: source.purpose, url: "http://127.0.0.1:4100/", source: "ship-desk" }).decision,
    ).toBe("allow")
  })
})

describe("the capture", () => {
  test("shoots each route on the base commit and the head, then uploads inside one start and one finish", async () => {
    const api = server()
    const run = runner()
    const result = await captureShots({ pr: 12, dir: work, api: api.api, runner: run.fake, work })
    expect(result).toMatchObject({ kind: "uploaded", images: 4, refused: [] })
    // .vector/ship.json came from the base commit, never the pull request.
    expect(run.log).toContain(`git show ${BASE}:.vector/ship.json`)
    expect(run.log).toContain(`git worktree add --detach ${path.join(work, "before")} ${BASE}`)
    expect(run.log.filter((line) => line.startsWith("shoot"))).toEqual([
      "shoot http://127.0.0.1:4100/",
      "shoot http://127.0.0.1:4100/pricing",
      "shoot http://127.0.0.1:4100/",
      "shoot http://127.0.0.1:4100/pricing",
    ])
    expect(run.log).toContain("stop before")
    expect(run.log).toContain("stop after")
    expect(run.log).toContain(`git worktree remove --force ${path.join(work, "before")}`)
    const start = api.calls.find((call) => call.action === "start")!
    expect(start.body.files).toEqual([
      { slot: "before", route: "/", bytes: 400, type: "image/png" },
      { slot: "before", route: "/pricing", bytes: 400, type: "image/png" },
      { slot: "after", route: "/", bytes: 400, type: "image/png" },
      { slot: "after", route: "/pricing", bytes: 400, type: "image/png" },
    ])
    const puts = api.calls.filter((call) => call.method === "PUT")
    expect(puts.map((call) => [call.url, call.bytes, call.headers?.["content-type"]])).toEqual([
      ["https://storage.example/1", 400, "image/png"],
      ["https://storage.example/2", 400, "image/png"],
      ["https://storage.example/3", 400, "image/png"],
      ["https://storage.example/4", 400, "image/png"],
    ])
    // The ticket goes only to vectordev.ai; the storage links carry their own signature.
    expect(api.calls.filter((call) => call.action).every((call) => call.authorization === `Bearer ${TICKET}`)).toBe(
      true,
    )
    expect(puts.every((call) => call.headers?.authorization === undefined)).toBe(true)
    expect(run.envs.every((env) => env.VECTOR_CAPTURE_TICKET === undefined && env.PORT === "4100")).toBe(true)
  })

  test("waits for the card while the pull request's event reaches vectordev.ai", async () => {
    const api = server({ pending: 2 })
    const result = await captureShots({ pr: 12, dir: work, api: api.api, runner: runner().fake, work })
    expect(result.kind).toBe("uploaded")
    expect(api.calls.filter((call) => call.action === "card")).toHaveLength(3)
  })

  test("a checkout that is not the pull request's head is refused; nothing to capture is a skip", async () => {
    await expect(
      captureShots({ pr: 12, dir: work, api: server().api, runner: runner({ head: "c".repeat(40) }).fake, work }),
    ).rejects.toThrow("head commit")
    expect(
      await captureShots({ pr: 12, dir: work, api: server().api, runner: runner({ baseMissing: true }).fake, work }),
    ).toEqual({
      kind: "skipped",
      reason: "The base commit is not in this checkout. Check out with fetch-depth: 0.",
    })
    expect(
      await captureShots({ pr: 12, dir: work, api: server().api, runner: runner({ ship: null }).fake, work }),
    ).toEqual({
      kind: "skipped",
      reason: "The base branch has no .vector/ship.json.",
    })
    expect(
      await captureShots({
        pr: 12,
        dir: work,
        api: server().api,
        runner: runner({ ship: '{"start":"x","port":80}' }).fake,
        work,
      }),
    ).toEqual({ kind: "skipped", reason: "The base branch's .vector/ship.json is not valid." })
    const api = server({ card: { baseSha: undefined } })
    expect((await captureShots({ pr: 12, dir: work, api: api.api, runner: runner().fake, work })).kind).toBe("skipped")
    expect(api.calls.some((call) => call.action === "start")).toBe(false)
  })

  test("a base that does not build still lets the head be captured; failed shots are left out", async () => {
    const api = server()
    const run = runner({
      failing: { slot: "before", command: "npm run build" },
      shootFails: ["http://127.0.0.1:4100/pricing"],
    })
    const lines: string[] = []
    const result = await captureShots({
      pr: 12,
      dir: work,
      api: api.api,
      runner: run.fake,
      work,
      log: (line) => lines.push(line),
    })
    expect(result).toMatchObject({ kind: "uploaded" })
    expect(api.calls.find((call) => call.action === "start")!.body.files).toEqual([
      { slot: "after", route: "/", bytes: 400, type: "image/png" },
    ])
    expect(lines).toContain("before: build exited 2.")
    expect(run.log).not.toContain("start before npm start PORT=4100")
  })

  test("the card's image count limits the routes; a server refusal surfaces its code", async () => {
    const api = server({ card: { files: 2 } })
    await captureShots({ pr: 12, dir: work, api: api.api, runner: runner().fake, work })
    expect(api.calls.find((call) => call.action === "start")!.body.files.map((file: any) => file.route)).toEqual([
      "/",
      "/",
    ])
    const refusing: CaptureApi = {
      ...server().api,
      card: async () => {
        throw new ShipError("This capture ticket is for another pull request.", "SHIP_DESK_TICKET_MISMATCH", 403)
      },
    }
    await expect(captureShots({ pr: 12, dir: work, api: refusing, runner: runner().fake, work })).rejects.toMatchObject(
      {
        code: "SHIP_DESK_TICKET_MISMATCH",
      },
    )
  })

  test("an upload whose size differs from what the link signed is never sent", async () => {
    const api = server()
    await expect(
      api.api.put(
        { n: 1, url: "https://storage.example/1", method: "PUT", headers: { "content-length": "10" }, expiresAt: 0 },
        png(),
      ),
    ).rejects.toThrow("changed size")
    await expect(
      api.api.put({ n: 1, url: "http://storage.example/1", method: "PUT", headers: {}, expiresAt: 0 }, png()),
    ).rejects.toThrow("https")
    expect(api.calls).toEqual([])
  })
})

describe("the ticket", () => {
  test("asks with the run's own token; a refusal or no token is simply no ticket", async () => {
    const { requestTicket, runTokenFile } = await import("../../src/cli/cmd/ship")
    const seen: { url: string; authorization?: string; body?: string }[] = []
    const answer = (status: number, body: unknown) => async (url: string, init: RequestInit) => {
      seen.push({
        url,
        authorization: new Headers(init.headers).get("authorization") ?? undefined,
        body: String(init.body),
      })
      return Response.json(body, { status })
    }
    const token = "vrt_payload.signature"
    expect(
      await requestTicket({ site: "https://vectordev.ai", token, send: answer(200, { ticket: TICKET, expiresAt: 5 }) }),
    ).toEqual({ kind: "ticket", ticket: TICKET, expiresAt: 5 })
    expect(seen[0]).toEqual({
      url: "https://vectordev.ai/api/ops/uploads",
      authorization: `Bearer ${token}`,
      body: JSON.stringify({ action: "ticket" }),
    })
    expect(
      await requestTicket({
        site: "https://vectordev.ai",
        token,
        send: answer(403, { error: { code: "SHIP_DESK_OFF", message: "Ship Desk is not on for this repository." } }),
      }),
    ).toEqual({ kind: "none", reason: "Ship Desk is not on for this repository." })
    expect(
      await requestTicket({ site: "https://vectordev.ai", token, send: answer(200, { ticket: "nope" }) }),
    ).toMatchObject({
      kind: "none",
    })
    expect(await requestTicket({ site: "https://vectordev.ai", token: "", send: answer(200, {}) })).toEqual({
      kind: "none",
      reason: "No run token.",
    })
    expect(seen).toHaveLength(3)
    expect(runTokenFile({ RUNNER_TEMP: "/tmp/r" })).toBe(path.join("/tmp/r", "vector-secrets", "run-token"))
    expect(runTokenFile({})).toBeUndefined()
  })
})
