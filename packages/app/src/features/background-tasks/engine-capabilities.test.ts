import { describe, expect, test } from "bun:test"
import { QueryClient } from "@tanstack/solid-query"
import {
  FLAGS,
  NO_CAPABILITIES,
  capabilitiesChanged,
  engineCapabilitiesQuery,
  firstSteerNotice,
  parseCapabilities,
  readEngineCapabilities,
  steerSupported,
} from "./engine-capabilities"

type Answer = { data?: unknown; error?: unknown; response?: { ok: boolean; status: number } }

function client(answer: Answer | (() => Promise<Answer>)) {
  const calls: unknown[] = []
  return {
    calls,
    client: {
      experimental: {
        capabilities: {
          get: (async (...args: unknown[]) => {
            calls.push(args)
            return typeof answer === "function" ? answer() : answer
          }) as never,
        },
      },
    },
  }
}

const ok = { ok: true, status: 200 }

describe("engine capabilities", () => {
  test("reads each flag as on only when the engine sent true", () => {
    const parsed = parseCapabilities({
      backgroundSubagents: true,
      sessionStop: true,
      vectorscopeSettings: true,
      vectorscopeRuns: true,
      vectorscopeReviewMemoryControls: true,
      taskPromote: "true",
      taskResume: 1,
      workflows: false,
      somethingNewer: true,
    })
    expect(parsed.backgroundSubagents).toBe(true)
    expect(parsed.sessionStop).toBe(true)
    expect(parsed.vectorscopeSettings).toBe(true)
    expect(parsed.vectorscopeRuns).toBe(true)
    expect(parsed.vectorscopeReviewMemoryControls).toBe(true)
    for (const value of [undefined, null, false, 1, "true", {}, []])
      expect(parseCapabilities({ vectorscopeReviewMemoryControls: value }).vectorscopeReviewMemoryControls).toBe(false)
    expect(
      parseCapabilities({ vectorscopeRuns: true, vectorscopeSettings: true }).vectorscopeReviewMemoryControls,
    ).toBe(false)
    expect(parseCapabilities({ vectorscopeRuns: "true" }).vectorscopeRuns).toBe(false)
    expect(parseCapabilities({ vectorscopeSettings: true }).vectorscopeRuns).toBe(false)
    expect(parsed.taskPromote).toBe(false)
    expect(parsed.taskResume).toBe(false)
    expect(parsed.workflows).toBe(false)
    expect(parsed.backgroundShells).toBe(false)
    expect(Object.keys(parsed).sort()).toEqual([...FLAGS].sort())
  })

  test("HTML, text, arrays and garbage read as every flag off", () => {
    for (const data of ["<!doctype html><html></html>", "ok", 42, null, undefined, [true], true])
      expect(parseCapabilities(data)).toEqual(NO_CAPABILITIES)
    expect(Object.values(NO_CAPABILITIES).every((value) => value === false)).toBe(true)
  })

  test("an engine without the route, an error status or an HTML page reads as unsupported", async () => {
    expect(
      await readEngineCapabilities(client({ error: "Not Found", response: { ok: false, status: 404 } }).client),
    ).toEqual(NO_CAPABILITIES)
    expect(await readEngineCapabilities(client({ error: {}, response: { ok: false, status: 500 } }).client)).toEqual(
      NO_CAPABILITIES,
    )
    expect(await readEngineCapabilities(client({ data: "<html>Vector</html>", response: ok }).client)).toEqual(
      NO_CAPABILITIES,
    )
    // The SDK throws this for a text/html answer before any body is read.
    const html = client(() =>
      Promise.reject(
        new Error("Request is not supported by this version of Vector Server (Server responded with text/html)"),
      ),
    )
    expect(await readEngineCapabilities(html.client)).toEqual(NO_CAPABILITIES)
  })

  test("reads a current engine's flags without throwing on errors", async () => {
    const reader = client({ data: { backgroundSubagents: true, sessionStop: true, taskResume: true }, response: ok })
    const flags = await readEngineCapabilities(reader.client)
    expect(flags.sessionStop).toBe(true)
    expect(flags.taskResume).toBe(true)
    expect(flags.taskPromote).toBe(false)
    // One request, which never throws on an error status.
    expect(reader.calls).toHaveLength(1)
    expect((reader.calls[0] as [unknown, { throwOnError: boolean }])[1].throwOnError).toBe(false)
  })

  test("a failure with no answer throws, so the query retries instead of hiding features", async () => {
    const offline = client({ error: new TypeError("Failed to fetch"), response: undefined })
    await expect(readEngineCapabilities(offline.client)).rejects.toThrow("Failed to fetch")
    const refused = client(() => Promise.reject(new TypeError("NetworkError")))
    await expect(readEngineCapabilities(refused.client)).rejects.toThrow("NetworkError")
  })

  test("the query is cached per server and never goes stale on its own", () => {
    const query = engineCapabilitiesQuery("server-a" as never, client({ data: {}, response: ok }).client)
    expect([...query.queryKey]).toEqual(["server-a", "capabilities"])
    expect(query.staleTime).toBe(Infinity)
  })

  // Settings → Agents → Workflows writes permission.workflow, and the save reloads the engine: the flag follows it.
  test("a settings reload or a reconnect reads the flags again; the first connection and other events do not", () => {
    expect(capabilitiesChanged("global.disposed", false)).toBe(true)
    expect(capabilitiesChanged("server.instance.disposed", false)).toBe(true)
    expect(capabilitiesChanged("server.connected", true)).toBe(true)
    expect(capabilitiesChanged("server.connected", false)).toBe(false)
    for (const type of ["session.updated", "message.part.updated", "session.status"])
      expect(capabilitiesChanged(type, true)).toBe(false)
  })

  test("the workflows flag follows a config save that turned workflows off", async () => {
    let workflows = true
    const engine = client(async () => ({ data: { workflows, backgroundSubagents: true }, response: ok }))
    const queries = new QueryClient()
    const query = engineCapabilitiesQuery("server-a" as never, engine.client)
    expect((await queries.fetchQuery(query)).workflows).toBe(true)
    // The save wrote permission.workflow: deny; the engine reloads and says so on its next answer.
    workflows = false
    expect((await queries.fetchQuery(query)).workflows).toBe(true)
    if (capabilitiesChanged("global.disposed", true)) await queries.refetchQueries({ queryKey: query.queryKey })
    expect(queries.getQueryData<{ workflows: boolean }>(query.queryKey)?.workflows).toBe(false)
  })
})

describe("steerSupported", () => {
  test("engines from 1.99.100 steer", () => {
    for (const version of ["1.99.100", "1.99.113", "1.100.0", "2.0.0", "v1.99.101", "1.99.100-beta.1"])
      expect(steerSupported(version)).toBe(true)
  })

  test("engines before 1.99.100 queue", () => {
    for (const version of ["1.99.99", "1.99.0", "1.98.200", "0.9.0", "v1.99.12"])
      expect(steerSupported(version)).toBe(false)
  })

  test("an unknown or unreadable version steers", () => {
    for (const version of [undefined, "", "dev", "local", "unknown"]) expect(steerSupported(version)).toBe(true)
  })

  test("the older-engine notice shows once per server", () => {
    expect(firstSteerNotice("server-notice")).toBe(true)
    expect(firstSteerNotice("server-notice")).toBe(false)
    expect(firstSteerNotice("server-other")).toBe(true)
  })
})
