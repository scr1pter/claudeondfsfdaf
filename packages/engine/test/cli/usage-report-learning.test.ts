import { afterEach, beforeEach, expect, test } from "bun:test"
import path from "path"
import { rm } from "fs/promises"
import { Global } from "@vectordevai/core/global"
import type { SessionV1 } from "@vectordevai/core/v1/session"
import { UsageReport } from "@vectordevai/schema/usage-report"
import { sendUsageReport } from "../../src/cli/usage-report"
import { summarizeUsage } from "../../src/session/session"

// Statement 8: usage check-ins are unchanged and never include skills or workflow data. The CLI's report is built from
// the session history's summary; a request a learned workflow default shaped keeps the user's own variant, so the
// report's values, effort levels included, are the ones the same history gives without learning.

const FILE = path.join(Global.Path.data, "cli-usage.json")
const DESKTOP_MARKER = path.join(Global.Path.data, UsageReport.DESKTOP_MARKER)
const NOW = Date.UTC(2026, 9, 10, 9, 30)
const ci = process.env.CI
const servers: ReturnType<typeof Bun.serve>[] = []

beforeEach(async () => {
  await rm(FILE, { force: true })
  await rm(DESKTOP_MARKER, { force: true })
  delete process.env.CI
})

afterEach(() => {
  servers.splice(0).forEach((server) => server.stop(true))
  if (ci !== undefined) process.env.CI = ci
})

// The check-in endpoint, keeping what each report sent.
function site() {
  const bodies: Record<string, unknown>[] = []
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      bodies.push(await request.json())
      return new Response(null, { status: 204 })
    },
  })
  servers.push(server)
  return { bodies, origin: server.url.origin }
}

function assistant(created: number, tokens: number, variant?: string) {
  return {
    id: `message-${created}`,
    sessionID: "session-learning",
    role: "assistant",
    time: { created, completed: created + 2_000 },
    parentID: `parent-${created}`,
    modelID: "claude-x",
    providerID: "anthropic",
    variant,
    size: "thorough",
    mode: "build",
    agent: "build",
    path: { cwd: "/tmp/vector", root: "/tmp/vector" },
    cost: 0.01,
    tokens: { total: tokens, input: tokens, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  } as unknown as typeof SessionV1.Assistant.Type
}

const history = [assistant(NOW - 3_000, 400), assistant(NOW - 2_000, 300, "high"), assistant(NOW - 1_000, 200)]

// The same requests, with what learning leaves on them: a learned default and an explored one, beside the variant.
const learned = history.map((message, index) =>
  index === 1
    ? message
    : {
        ...message,
        workflow: {
          effort: "default" as const,
          ...(index === 2 ? { subagentModel: "small" as const } : {}),
          source: index === 0 ? ("learned" as const) : ("explore" as const),
          reason: "Thorough work here passed 9 of 10 checked runs at default effort against 8 of 9 at high.",
        },
      },
)

test("a history shaped by learned defaults reports the same values as the same history without them", async () => {
  // One report a day: each history reports as a fresh install, one after the other.
  const report = async (messages: readonly (typeof SessionV1.Info.Type)[]): Promise<Record<string, unknown>> => {
    await rm(FILE, { force: true })
    const fixture = site()
    expect(
      await sendUsageReport({
        token: "vct_synthetic-usage-fixture",
        site: fixture.origin,
        now: NOW,
        summary: async () => summarizeUsage(messages),
      }),
    ).toBe(true)
    return { ...fixture.bodies[0], installId: undefined }
  }
  const plain = await report(history)
  const shaped = await report(learned)
  expect(shaped).toEqual(plain)
  // A learned default never stands in for the user's variant: the two requests they left on Default count there.
  const levels = (shaped.usage as { effortLevels: { id: string; responses: number }[] }).effortLevels
  expect(levels.find((level) => level.id === "default")?.responses).toBe(2)
  for (const word of ["workflow", "skill", "learned", "explore", "checked runs"])
    expect(JSON.stringify(shaped).toLowerCase()).not.toContain(word)
})
