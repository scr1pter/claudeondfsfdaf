import { beforeEach, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import path from "node:path"
import { Effect } from "effect"
import { parse } from "jsonc-parser"
import { ChildEnvironment } from "@vectordevai/core/child-environment"
import { EgressGuard } from "@vectordevai/core/local-mode/guard"
import { LocalProbe } from "@vectordevai/core/local-mode/probe"
import { SURFACE, sinceOf, surface } from "../../src/cli/cmd/local"
import { cliIt } from "../lib/cli-process"
import { LocalServers } from "../../../core/test/fixture/local-servers/serve"

// `vector local` and `vector run --local` as a person runs them: the real CLI in a home folder of its own, against
// fake model servers on 127.0.0.1. What would loosen Vector Local is refused under the agent marker and without a
// terminal; the check's exit status says whether every layer passed; the network log prints as JSON; and --local turns
// Vector Local on for one run without changing a setting.

const AGENT = { VECTOR_AGENT_SESSION: "ses_agent", VECTOR_LOCAL: "1" }
const SERVER = "http://127.0.0.1:11434"

// The CLI runs as the owner runs it in their own terminal: without the agent marker, which every child of a process
// that resolved Vector Local otherwise inherits. The agent's own runs pass it themselves.
beforeEach(() => {
  ChildEnvironment.inherit({ agent: false })
})

const configFile = (home: string) => path.join(home, ".config", "vector", "vector.json")
const writeConfig = (home: string, value: Record<string, unknown>) => {
  mkdirSync(path.dirname(configFile(home)), { recursive: true })
  writeFileSync(configFile(home), JSON.stringify(value, null, 2))
}
// The user's config as Vector writes it: into the first of these that exists, or a new vector.jsonc.
const readConfig = (home: string) => {
  const file = ["vector.jsonc", "vector.json", "config.json"]
    .map((name) => path.join(home, ".config", "vector", name))
    .find((item) => existsSync(item))
  return file ? (parse(readFileSync(file, "utf8")) as Record<string, any>) : {}
}

// The CLI's way out to the internet for the test's scope: an HTTP proxy on 127.0.0.1 that answers every request as a
// vectordev.ai that turns the token down, and lists each request that reached it. A request Vector Local blocked never
// gets here, and one it let leave always does, since the CLI is pointed at it through HTTP_PROXY.
const proxy = () =>
  Effect.acquireRelease(
    Effect.sync(() => {
      const hits: string[] = []
      const server = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch(request) {
          hits.push(`${request.method} ${request.url}`)
          return Response.json(
            { ok: false, error: { code: "CLI_TOKEN_INVALID", message: "Not a token" } },
            { status: 401 },
          )
        },
      })
      return { origin: server.url.origin, hits: () => [...hits], stop: () => server.stop(true) }
    }),
    (item) => Effect.promise(() => item.stop()),
  )

// A fake Ollama on 127.0.0.1 for the test's scope, with its identity pin as Add server records it.
const ollama = (routes?: Record<string, LocalServers.Route>) =>
  Effect.acquireRelease(
    Effect.promise(async () => {
      const fake = await LocalServers.serve("ollama", { routes })
      const server = await LocalProbe.probe(fake.origin)
      return { fake, pin: server!.pin }
    }),
    (item) => Effect.promise(() => item.fake.close()),
  )

// The user's own config with Vector Local on, the fake server on the list and pinned, and a provider for its models.
const listed = (home: string, origin: string, pin: LocalProbe.Pin) =>
  writeConfig(home, {
    local: { enabled: true, endpoints: [origin], pins: { [origin]: pin } },
    provider: {
      ollama: {
        npm: "@ai-sdk/openai-compatible",
        name: "Ollama (test)",
        options: { baseURL: `${origin}/v1` },
        models: { "qwen3-coder:30b": { name: "qwen3-coder:30b", tool_call: true } },
      },
    },
  })

describe("vector local", () => {
  cliIt.live(
    "refuses to loosen Vector Local under the agent marker, but still tightens it",
    ({ vector, home }) =>
      Effect.gen(function* () {
        // The user's model server is one this Vector does not count: under the marker, the user's config only tightens.
        writeConfig(home, { local: { enabled: true, endpoints: [SERVER] } })
        const off = yield* vector.spawn(["local", "off"], { env: AGENT })
        vector.expectExit(off, 1)
        expect(off.stderr).toContain(
          "An agent or Vector's own terminal started this Vector, so it cannot loosen Vector Local.",
        )
        const allow = yield* vector.spawn(["local", "allow", "github", "--reason", "Pull requests"], { env: AGENT })
        vector.expectExit(allow, 1)
        expect(allow.stderr).toContain("cannot loosen Vector Local")
        expect(readConfig(home).local).toEqual({ enabled: true, endpoints: [SERVER] })
        // A stricter Web access is a tightening, which the marker does not stop, and the server stays on the list.
        const web = yield* vector.spawn(["local", "web", "none"], { env: AGENT })
        vector.expectExit(web, 0)
        expect(readConfig(home).local).toEqual({ enabled: true, endpoints: [SERVER], web: "none" })
      }),
    60_000,
  )

  cliIt.live(
    "asks at a terminal before loosening, so without one nothing changes",
    ({ vector, home }) =>
      Effect.gen(function* () {
        writeConfig(home, { local: { enabled: true, web: "none" } })
        const ask = yield* vector.spawn(["local", "web", "ask"])
        vector.expectExit(ask, 1)
        expect(ask.stderr).toContain("This change would loosen Vector Local, so it needs your answer at a terminal.")
        expect(ask.stderr).toContain("It sets Web access to Ask.")
        const off = yield* vector.spawn(["local", "off"])
        vector.expectExit(off, 1)
        expect(readConfig(home).local).toEqual({ enabled: true, web: "none" })
        const status = yield* vector.spawn(["local", "status", "--json"])
        vector.expectExit(status, 0)
        expect(JSON.parse(status.stdout).policy).toMatchObject({ enabled: true, web: "none" })
        // An edit by hand is held, and the status says where confirming it applies.
        writeConfig(home, {
          local: {
            enabled: true,
            web: "none",
            allow: [{ source: "github", reason: "Pull requests", added_at: 1, added_by: "cli" }],
          },
        })
        const held = yield* vector.spawn(["local", "status"])
        vector.expectExit(held, 0)
        expect(held.stderr).toContain(
          "A change to your config would loosen Vector Local: it allows github for any host. It waits for you: run vector local confirm. A Vector that is already running applies that when it next starts, except the desktop app, which keeps a record of its own.",
        )
        // The status says these are the terminal's settings, not the desktop app's.
        expect(held.stderr).toContain(SURFACE)
        const confirm = yield* vector.spawn(["local", "confirm"])
        vector.expectExit(confirm, 1)
        expect(confirm.stderr).toContain("It allows github for any host.")
      }),
    60_000,
  )

  // A Vector the desktop app starts (its built-in terminal, its agents' commands) inherits VECTOR_CLIENT=desktop and
  // the app's config folders, so its status is the app's own: the terminal note would be wrong there.
  test("says the settings are the terminal's own only outside the desktop app", () => {
    expect(surface("cli")).toBe(SURFACE)
    expect(surface("desktop")).toBeUndefined()
  })

  cliIt.live(
    "vector local check exits 2 when off, 0 when every layer passes, and 1 once a listed server stops answering",
    ({ vector, home }) =>
      Effect.gen(function* () {
        const off = yield* vector.spawn(["local", "check"])
        vector.expectExit(off, 2)
        expect(off.stderr).toContain("Vector Local is off")

        const server = yield* ollama()
        listed(home, server.fake.origin, server.pin)
        const pass = yield* vector.spawn(["local", "check", "--json"])
        vector.expectExit(pass, 0)
        const report = JSON.parse(pass.stdout)
        expect(report.result).toBe("pass")
        expect(report.rows.find((row: { layer: string }) => row.layer === "models")).toMatchObject({
          status: "pass",
          title: "Models Vector may call: ollama (1)",
          // The test harness's own provider points at a server that is not on the list.
          detail: "Off in Vector Local: lmstudio.",
        })

        yield* Effect.promise(() => server.fake.close())
        const fail = yield* vector.spawn(["local", "check"])
        vector.expectExit(fail, 1)
        expect(fail.stderr).toContain(`Nothing answered at ${server.fake.origin}`)
      }),
    60_000,
  )

  cliIt.live(
    "vector local log --json prints what Vector sent, origins only, and filters it",
    ({ vector, home }) =>
      Effect.gen(function* () {
        const server = yield* ollama()
        listed(home, server.fake.origin, server.pin)
        // Check reads the listed server, which the network log records.
        vector.expectExit(yield* vector.spawn(["local", "check"]), 0)
        const log = yield* vector.spawn(["local", "log", "--json"])
        vector.expectExit(log, 0)
        const events = JSON.parse(log.stdout) as { source: string; origin: string; decision: string }[]
        expect(events.length).toBeGreaterThan(0)
        expect(
          events.filter((event) => event.source === LocalProbe.SERVER_CHECK).map((event) => event.origin),
        ).toContain(server.fake.origin)
        expect(events.every((event) => !event.origin.includes("/api/"))).toBe(true)
        const blocked = yield* vector.spawn(["local", "log", "--json", "--blocked"])
        vector.expectExit(blocked, 0)
        expect(
          (JSON.parse(blocked.stdout) as { decision: string }[]).every((event) => event.decision !== "allow"),
        ).toBe(true)
        const future = yield* vector.spawn(["local", "log", "--json", "--since", "2999-01-01"])
        expect(JSON.parse(future.stdout)).toEqual([])
        const wrong = yield* vector.spawn(["local", "log", "--since", "soon"])
        vector.expectExit(wrong, 1)
        expect(wrong.stderr).toContain("--since takes a span such as 30m, 2h or 7d, or a date")
      }),
    60_000,
  )
})

describe("the account gate", () => {
  cliIt.live(
    "leaves every vector local command open, and keeps vector run --local behind it, on Vector Local from the start",
    ({ vector, home }) =>
      Effect.gen(function* () {
        const account = yield* proxy()
        const env = {
          VECTOR_CLI: "1",
          VECTOR_SITE_URL: "http://vectordev.example",
          HTTP_PROXY: account.origin,
          NO_PROXY: "127.0.0.1,localhost,[::1]",
          // The CLI inherits the test run's strict network guard, which would refuse the account check before it got
          // here, and a sign-in from an earlier day then passes on its offline grace. The CLI keeps that guard, with
          // this proxy as the guard's own and vectordev.example as a name it may reach through it.
          [EgressGuard.ENVIRONMENT.proxy]: account.origin,
          [EgressGuard.ENVIRONMENT.names]: [process.env[EgressGuard.ENVIRONMENT.names], "vectordev.example"]
            .filter(Boolean)
            .join(","),
        }
        const status = yield* vector.spawn(["local", "status"], { env })
        vector.expectExit(status, 0)
        expect(status.stderr).toContain("Vector Local is off")
        // With no sign-in, --local applies before the account check, which knows vectordev.ai is blocked.
        const unsigned = yield* vector.spawn(["run", "--local", "say hi"], { env })
        vector.expectExit(unsigned, 1)
        expect(unsigned.stderr).toContain(
          "A free Vector account is required. Vector Local blocks requests to vectordev.ai",
        )
        expect(account.hits()).toEqual([])
        // Signed in on an earlier day, the check would ask vectordev.ai again; under --local it sends nothing, and the
        // run stops at the model, which is not on a model server list.
        const auth = path.join(home, ".local", "share", "vector", "cli-auth.json")
        mkdirSync(path.dirname(auth), { recursive: true })
        writeFileSync(
          auth,
          JSON.stringify({
            token: "vct_test_not_a_token",
            user: { id: "usr_test", email: "owner@example.com" },
            verifiedAt: Date.now() - 2 * 24 * 60 * 60 * 1000,
          }),
        )
        const signed = yield* vector.spawn(["run", "--local", "say hi"], { env })
        expect(signed.exitCode).not.toBe(0)
        expect(`${signed.stdout}${signed.stderr}`).toContain("off in Vector Local")
        expect(account.hits()).toEqual([])
        // Without --local the same check goes out through the proxy, so a request that left would have shown above.
        const plain = yield* vector.spawn(["run", "say hi"], { env })
        vector.expectExit(plain, 1)
        expect(account.hits()).toContain("POST http://vectordev.example/api/account/cli-verify")
      }),
    60_000,
  )
})

describe("vector local setup", () => {
  cliIt.live(
    "adds a typed server as a provider and lists it; with Vector Local on it asks at a terminal first",
    ({ vector, home }) =>
      Effect.gen(function* () {
        const server = yield* ollama()
        const added = yield* vector.spawn(["local", "setup", `${server.fake.origin}/v1`])
        vector.expectExit(added, 0)
        expect(added.stderr).toContain(`Added Ollama 0.12.6 at ${server.fake.origin}`)
        expect(added.stderr).toContain("as ollama, with 3 models.")
        const config = readConfig(home)
        expect(config.local).toEqual({ endpoints: [server.fake.origin], pins: { [server.fake.origin]: server.pin } })
        expect(config.provider.ollama.options.baseURL).toBe(`${server.fake.origin}/v1`)

        const other = yield* ollama()
        vector.expectExit(yield* vector.spawn(["local", "on"]), 0)
        const asked = yield* vector.spawn(["local", "setup", other.fake.origin])
        vector.expectExit(asked, 1)
        expect(asked.stderr).toContain(`It adds the model server ${other.fake.origin}.`)
        // Nothing was written: neither the list nor a second provider.
        expect(readConfig(home).local.endpoints).toEqual([server.fake.origin])
        expect(Object.keys(readConfig(home).provider)).toEqual(["ollama"])
      }),
    60_000,
  )

  cliIt.live(
    "under the agent marker, adds no server even with Vector Local off, since turning it on would let the server in",
    ({ vector, home }) =>
      Effect.gen(function* () {
        const server = yield* ollama()
        const added = yield* vector.spawn(["local", "setup", server.fake.origin], {
          env: { VECTOR_AGENT_SESSION: "ses_agent" },
        })
        vector.expectExit(added, 1)
        expect(added.stderr).toContain("cannot loosen Vector Local")
        expect(added.stderr).toContain(`adds the model server ${server.fake.origin}`)
        // Neither the list nor a provider.
        expect(readConfig(home).local).toBeUndefined()
        expect(readConfig(home).provider?.ollama).toBeUndefined()
        // A typed server elsewhere is not even read, so nothing is sent to it.
        const typed = yield* vector.spawn(["local", "setup", "http://10.9.9.9:8000"], {
          env: { VECTOR_AGENT_SESSION: "ses_agent" },
        })
        vector.expectExit(typed, 1)
        expect(typed.stderr).toContain("cannot loosen Vector Local")
        expect(typed.stderr).not.toContain("No model server Vector knows answered")
      }),
    60_000,
  )
})

describe("vector run --local", () => {
  cliIt.live(
    "turns Vector Local on for this run only, so an unlisted model server gets no prompt",
    ({ vector, home, llm }) =>
      Effect.gen(function* () {
        yield* llm.text("hello from the test llm")
        const result = yield* vector.run("say hi", { extraArgs: ["--local"] })
        expect(result.exitCode).not.toBe(0)
        expect(`${result.stdout}${result.stderr}`).toContain("off in Vector Local")
        expect(yield* llm.calls).toBe(0)
        // Nothing was written: the user's config has no local block.
        expect(readConfig(home).local).toBeUndefined()
      }),
    60_000,
  )

  cliIt.live(
    "never loosens what the user set: a listed server still answers, with Web access as it was",
    ({ vector, home, llm }) =>
      Effect.gen(function* () {
        yield* llm.text("hello from the test llm")
        const origin = new URL(llm.url).origin
        writeConfig(home, { local: { enabled: false, web: "none", endpoints: [origin] } })
        const result = yield* vector.run("say hi", { extraArgs: ["--local"] })
        vector.expectExit(result, 0)
        expect(result.stdout).toContain("hello from the test llm")
        expect(readConfig(home).local).toEqual({ enabled: false, web: "none", endpoints: [origin] })
        // The next run without --local is as the user's config says: Vector Local off.
        const status = yield* vector.spawn(["local", "status", "--json"])
        expect(JSON.parse(status.stdout).policy).toMatchObject({ enabled: false, web: "none" })
      }),
    60_000,
  )

  cliIt.live(
    "with --attach, runs only on a server that has Vector Local on already",
    ({ vector, llm }) =>
      Effect.gen(function* () {
        const server = yield* vector.serve()
        const result = yield* vector.run("say hi", { extraArgs: ["--local", "--attach", server.url] })
        vector.expectExit(result, 1)
        expect(result.stderr).toContain(`the server at ${server.url} has it off`)
        expect(yield* llm.calls).toBe(0)
      }),
    60_000,
  )

  cliIt.live(
    "with --attach, runs on a server that has Vector Local on, which sends the prompt to the model server on its list",
    ({ vector, home, llm }) =>
      Effect.gen(function* () {
        yield* llm.text("hello from the attached server")
        writeConfig(home, { local: { enabled: true, endpoints: [new URL(llm.url).origin] } })
        const server = yield* vector.serve()
        const result = yield* vector.run("say hi", { extraArgs: ["--local", "--attach", server.url] })
        vector.expectExit(result, 0)
        expect(result.stdout).toContain("hello from the attached server")
        expect(yield* llm.calls).toBe(1)
      }),
    60_000,
  )

  cliIt.live(
    "with --attach, says so before connecting when Vector Local here does not list the server, as under the agent marker",
    ({ vector, llm }) =>
      Effect.gen(function* () {
        // A server on the user's network, which a Vector the agent started may not add to the list.
        const result = yield* vector.run("say hi", {
          extraArgs: ["--local", "--attach", "http://10.255.255.1:4096"],
          env: { VECTOR_AGENT_SESSION: "ses_agent" },
        })
        vector.expectExit(result, 1)
        expect(result.stderr).toContain("which kept this run from reaching http://10.255.255.1:4096")
        expect(result.stderr).toContain("Ignored the model servers in VECTOR_LOCAL_POLICY")
        expect(yield* llm.calls).toBe(0)
      }),
    60_000,
  )
})

describe("vector local helpers", () => {
  test("--since takes a span back from now, or a date", () => {
    const now = Date.parse("2026-10-22T12:00:00Z")
    expect(sinceOf("30m", now)).toBe(now - 30 * 60_000)
    expect(sinceOf("2h", now)).toBe(now - 2 * 3_600_000)
    expect(sinceOf("7d", now)).toBe(now - 7 * 86_400_000)
    expect(sinceOf("2026-10-01", now)).toBe(Date.parse("2026-10-01"))
    expect(sinceOf("soon", now)).toBeNull()
  })
})
