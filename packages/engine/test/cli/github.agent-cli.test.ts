// V18b, CI-only (it spawns the CLI): `vector github run --phase agent` as the agent step starts it, through the real
// entry point, so index.ts loads the secret channel from stdin before the account gate and the instance. The account
// check goes to a loopback fake vectordev.ai (VECTOR_SITE_URL), GitHub is a loopback fake, the model is the fake LLM
// server, and the CLI fixture turns catalog fetches off. The child inherits this file's strict network guard through
// its proxy settings, so an attempt to leave this computer would be refused and listed. Nothing prints the
// environment: the shell tool runs a fixed check that prints one count per fixture value.

import { afterAll, describe, expect } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { Effect } from "effect"
import { AGENT_NEEDS_CHANNEL } from "../../src/cli/cmd/github.agent"
import { GithubBundle } from "../../src/cli/cmd/github.bundle"
import { cliIt } from "../lib/cli-process"
import { NetworkGuard } from "../../../core/test/lib/network-guard"
import { CHANNEL, RUN_ID, VALUES, cleanup, eventFile, fakeGithub, folder, git, stepEnv } from "./github.agent-fixture"

const network = NetworkGuard.use()
afterAll(cleanup)

function fakeSite() {
  const seen: { route: string; token?: unknown }[] = []
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url)
      const body = request.method === "POST" ? await request.json().catch(() => undefined) : undefined
      seen.push({
        route: `${request.method} ${url.pathname}`,
        token: body && typeof body === "object" && "token" in body ? body.token : undefined,
      })
      if (url.pathname === "/api/account/cli-verify")
        return Response.json({ ok: true, user: { id: "fixture-user", email: "fixture@example.invalid" } })
      return Response.json({ error: { code: "NOT_FOUND" } }, { status: 404 })
    },
  })
  return { url: `http://127.0.0.1:${server.port}`, seen, stop: () => server.stop(true) }
}

async function checkout() {
  const dir = await folder("vector-agent-cli-")
  await git(dir, ["init", "-q", "-b", "main"])
  await fs.writeFile(path.join(dir, "README.md"), "# Widgets\n")
  await git(dir, ["add", "-A"])
  await git(dir, ["commit", "-q", "-m", "base"])
  return dir
}

// The step's env: lines, with no credential; the credentials travel on stdin only.
function step(event: string, github: string, site: string, channel: boolean) {
  return Object.fromEntries(
    Object.entries({
      ...stepEnv({
        event,
        eventName: "workflow_dispatch",
        thread: `dispatch-${RUN_ID}`,
        github,
        prompt: "Check the environment",
      }),
      VECTOR_SITE_URL: site,
      VECTOR_DISABLE_USAGE: "1",
      VECTOR_PURE: "1",
      ...(channel
        ? { VECTOR_SECRET_CHANNEL: "stdin", VECTOR_SECRET_ENV_NAMES: Object.keys(CHANNEL.keys).join(",") }
        : {}),
    }).filter((entry): entry is [string, string] => entry[1] !== undefined),
  )
}

describe("the agent phase from the command line", () => {
  cliIt.live(
    "the CLI agent phase loads its channel before the account gate and leaves no credential in children",
    ({ vector, llm }) =>
      Effect.gen(function* () {
        const site = fakeSite()
        const github = fakeGithub({ roles: { alice: "write" } })
        const dir = yield* Effect.promise(checkout)
        const event = yield* Effect.promise(() => eventFile({ inputs: {}, sender: { login: "alice", type: "User" } }))
        const command = VALUES.map(
          (value, index) => `printf 'value${index}=%s\\n' "$(env | grep -cF -e '${value}')"`,
        ).join("; ")
        yield* llm.tool("bash", { command, description: "Check the environment" })
        yield* llm.text("Checked.")
        yield* llm.text("Check the environment")
        const result = yield* vector.actionsStep(["github", "run", "--phase", "agent"], {
          cwd: dir,
          stdin:
            JSON.stringify({ v: 1, githubToken: CHANNEL.githubToken, cliToken: CHANNEL.cliToken, keys: CHANNEL.keys }) +
            "\n",
          env: step(event, github.url, site.url, true),
          timeoutMs: 50_000,
        })
        site.stop()
        github.stop()
        vector.expectExit(result, 0, "agent phase")
        const summary = GithubBundle.parseRunSummary(
          yield* Effect.promise(() => fs.readFile(path.join(dir, "vector-out", "summary.json"), "utf8")),
        )
        expect(summary).toMatchObject({ mode: "own-key", kind: "dispatch", thread: `dispatch-${RUN_ID}` })
        // The gate checked the channel's CLI token, the one request to vectordev.ai (INV-K1).
        expect(site.seen).toEqual([{ route: "POST /api/account/cli-verify", token: CHANNEL.cliToken }])
        const inputs = JSON.stringify(yield* llm.inputs)
        VALUES.forEach((_, index) => expect(inputs).toContain(`value${index}=0`))
        // Fixture values only, and a failure names which of them, never the output itself.
        expect(VALUES.filter((value) => (result.stdout + result.stderr).includes(value))).toEqual([])
        expect(network.outside()).toEqual([])
      }),
    60_000,
  )

  cliIt.live(
    "without the channel the agent phase exits 1 before any instance or model request",
    ({ vector, llm }) =>
      Effect.gen(function* () {
        const site = fakeSite()
        const github = fakeGithub({ roles: { alice: "write" } })
        const dir = yield* Effect.promise(checkout)
        const event = yield* Effect.promise(() => eventFile({ inputs: {}, sender: { login: "alice", type: "User" } }))
        const result = yield* vector.actionsStep(["github", "run", "--phase", "agent"], {
          cwd: dir,
          env: step(event, github.url, site.url, false),
          timeoutMs: 50_000,
        })
        site.stop()
        github.stop()
        vector.expectExit(result, 1, "agent phase without a channel")
        expect(result.stderr).toContain(AGENT_NEEDS_CHANNEL)
        expect(yield* llm.calls).toBe(0)
        expect(site.seen).toEqual([])
        expect(github.seen).toEqual([])
        expect(
          yield* Effect.promise(() =>
            fs.stat(path.join(dir, "vector-out")).then(
              () => true,
              () => false,
            ),
          ),
        ).toBe(false)
        expect(network.outside()).toEqual([])
      }),
    60_000,
  )
})
