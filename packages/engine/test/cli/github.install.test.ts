import { expect, test } from "bun:test"
import { readWorkflowOptions } from "@vectordevai/core/review/workflow"
import { GithubAgents } from "@vectordevai/core/github-agents"
import { CODIUM_NEXT, installWorkflow, UPGRADE, type InstallPort } from "../../src/cli/cmd/github.install"
import { githubListedPerks } from "../../src/cli/cmd/github.app"

function fixture(
  options: {
    listed?: string[]
    codium?: boolean
    installation?: boolean
    app?: boolean
    existing?: string
    upgrade?: boolean
  } = {},
) {
  const seen = {
    choices: [] as { message: string; labels: string[] }[],
    confirms: [] as string[],
    content: "",
    output: [] as string[],
    providers: 0,
  }
  const port: InstallPort = {
    choose: async (message, choices) => {
      seen.choices.push({ message, labels: choices.map((choice) => choice.label) })
      if (message.includes("publishes")) return options.app ? "app" : "github"
      if (message.includes("how Vector")) return options.codium ? "codium" : "own-key"
      return choices[0]!.value
    },
    confirm: async (message) => {
      seen.confirms.push(message)
      return message === UPGRADE ? options.upgrade === true : message.includes("automatically")
    },
    text: async () => "50",
    info: (text) => seen.output.push(text),
    done: (text) => seen.output.push(text),
    read: async () => options.existing,
    write: async (content) => {
      seen.content = content
    },
    listed: async () => options.listed ?? [],
    installation: async () =>
      options.installation
        ? { available: true, installUrl: "https://github.com/apps/vector-fixture/installations/new" }
        : { available: false },
    providers: async () => {
      seen.providers++
      return [{ id: "openai", name: "OpenAI", env: ["OPENAI_API_KEY"], models: [{ id: "gpt-4.1", name: "GPT-4.1" }] }]
    },
  }
  return {
    seen,
    port,
    run: (flags = {}) =>
      installWorkflow({ flags, version: GithubAgents.MIN_AGENTS_CLI, repository: "owner/project" }, port),
  }
}

test("unlisted setup defaults to own key and writes both secret steps without a Codium choice", async () => {
  const f = fixture()
  await f.run()
  expect(readWorkflowOptions(f.seen.content)).toMatchObject({
    mode: "own-key",
    provider: "openai",
    model: "gpt-4.1",
    autoReview: true,
    share: false,
  })
  expect(f.seen.choices.some((choice) => choice.message.includes("how Vector"))).toBe(false)
  expect(f.seen.output.join("\n")).toContain("VECTOR_CLI_TOKEN")
  expect(f.seen.output.join("\n")).toContain("OPENAI_API_KEY")
})

test("listed Codium setup uses only its public gates, skips provider/sharing prompts and takes the handle from the install URL", async () => {
  const f = fixture({ listed: ["github-agents", "github-no-secret"], codium: true, installation: true })
  await f.run()
  expect(readWorkflowOptions(f.seen.content)).toMatchObject({
    mode: "codium",
    keys: [],
    autoReview: false,
    handle: "vector-fixture",
  })
  expect(f.seen.choices[0]?.labels).toContain("Codium (your plan, no API key)")
  expect(f.seen.providers).toBe(0)
  expect(f.seen.confirms.some((message) => message.includes("Publish task"))).toBe(false)
  expect(f.seen.content).not.toContain("VECTOR_CLI_TOKEN")
  expect(f.seen.content).not.toContain("VECTOR_SHARE_CONSENT")
  expect(f.seen.content).toContain("@vector-fixture")
  expect(f.seen.output).toContain(CODIUM_NEXT)
  expect(CODIUM_NEXT).not.toMatch(/\b(?:payment|dispute|fraud|closing|credits|dollars)\b|\$\d/i)
})

test("no-key wording needs its own listed perk, and owner --codium bypasses listing without advertising the flag", async () => {
  const listed = fixture({ listed: ["github-agents"], codium: true })
  await listed.run()
  expect(listed.seen.choices[0]?.labels).toContain("Codium (your plan)")
  expect(listed.seen.choices[0]?.labels.join(" ")).not.toContain("no API key")
  const owner = fixture()
  await owner.run({ codium: true })
  expect(readWorkflowOptions(owner.seen.content)?.mode).toBe("codium")
  expect(owner.seen.choices).toEqual([])
  expect(readWorkflowOptions(owner.seen.content)?.handle).toBeUndefined()
})

test("Codium schedules need the schedule gate unless owner acceptance explicitly bypasses it", async () => {
  const schedule = [JSON.stringify({ id: "daily", cron: "17 9 * * *", prompt: "Maintain the repository" })]
  const gated = fixture({ listed: ["github-agents"], codium: true })
  await expect(gated.run({ schedule })).rejects.toThrow("not available")
  expect(gated.seen.content).toBe("")
  const owner = fixture()
  await owner.run({ codium: true, schedule })
  expect(readWorkflowOptions(owner.seen.content)?.schedules).toEqual([JSON.parse(schedule[0]!)])
  const listed = fixture({ listed: ["github-agents", "scheduled"], codium: true })
  await listed.run({ schedule })
  expect(readWorkflowOptions(listed.seen.content)?.schedules).toHaveLength(1)
})

test("legacy or unknown existing workflows require an upgrade choice before overwrite", async () => {
  const refused = fixture({ existing: "name: My workflow\n" })
  expect(await refused.run()).toEqual({ written: false })
  expect(refused.seen.content).toBe("")
  expect(refused.seen.confirms).toEqual([UPGRADE])
  const upgraded = fixture({ existing: "# Vector workflow version 2\n", upgrade: true })
  await upgraded.run({ ownKey: true })
  expect(readWorkflowOptions(upgraded.seen.content)?.mode).toBe("own-key")
})

test("contradictory modes, malformed schedules and impossible calendars cannot write a workflow", async () => {
  for (const flags of [
    { codium: true, ownKey: true },
    { schedule: ["not JSON"] },
    { schedule: [JSON.stringify({ id: "bad", cron: "60 9 * * *", prompt: "Maintain" })] },
  ]) {
    const f = fixture()
    await expect(f.run(flags)).rejects.toThrow()
    expect(f.seen.content).toBe("")
  }
})

test("App publication remains a separate explicit choice and defaults to the repository credential", async () => {
  const defaulted = fixture({ installation: true })
  await defaulted.run({ ownKey: true })
  expect(readWorkflowOptions(defaulted.seen.content)?.publishAuth).toBe("github")
  const selected = fixture({ installation: true, app: true })
  await selected.run({ ownKey: true })
  expect(readWorkflowOptions(selected.seen.content)?.publishAuth).toBe("app")
  expect(selected.seen.output.join("\n")).toContain("https://github.com/apps/vector-fixture/installations/new")
})

test("the installer reads public enabled listing with no credentials and fails closed on malformed, disabled or oversized answers", async () => {
  const seen: RequestInit[] = []
  for (const body of [
    { enabled: false, listed: ["github-agents"] },
    { enabled: true },
    { enabled: true, listed: [9] },
    { enabled: true, listed: ["github-agents"], extra: "x".repeat(256_000) },
  ])
    expect(
      await githubListedPerks(async (_url, init) => {
        seen.push(init)
        return Response.json(body)
      }),
    ).toEqual([])
  expect(
    await githubListedPerks(async (_url, init) => {
      seen.push(init)
      return Response.json({ enabled: true, listed: ["github-agents", "scheduled"] })
    }),
  ).toEqual(["github-agents", "scheduled"])
  expect(
    seen.every(
      (init) =>
        !new Headers(init.headers).has("authorization") && init.credentials === "omit" && init.redirect === "error",
    ),
  ).toBe(true)
  expect(
    await githubListedPerks(async () => {
      throw new Error("fixture offline")
    }),
  ).toEqual([])
})
