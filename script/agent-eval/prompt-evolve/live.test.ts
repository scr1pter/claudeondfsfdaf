import { afterAll, describe, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { capture } from "../run"
import { MIN_REPEAT, check, environment, local, rates, type LiveOptions } from "./live"

const root = await mkdtemp(join(tmpdir(), "prompt-evolve-live-"))
afterAll(() => rm(root, { recursive: true, force: true }))

// The owner's environment, as the harness would find it.
const OWNER = {
  PATH: "/Users/owner/bin:/usr/bin",
  HOME: "/Users/owner",
  XDG_CONFIG_HOME: "/Users/owner/.config",
  ANTHROPIC_API_KEY: "sk-ant-owner-key",
  OPENAI_API_KEY: "sk-openai-owner-key",
  AWS_SECRET_ACCESS_KEY: "aws-owner-secret",
  VECTOR_SERVER_PASSWORD: "owner-password",
  VECTOR_AGENT_SESSION: "ses_owner",
}
const ENOUGH = {
  yes: true,
  "max-spend": "2",
  prices: "prices.json",
  model: "anthropic/claude-sonnet-4-5",
  "allow-remote": true,
}

describe("the live arm", () => {
  test("builds vector run's environment from scratch: only the named credentials, an isolated home, the brain off", () => {
    const home = join(root, "home")
    const env = environment({
      home,
      auth: ["ANTHROPIC_API_KEY"],
      config: { agent: { build: { prompt: "P" } }, permission: { memory: "allow" } },
      source: OWNER,
    })
    const inherited = Object.entries(env).filter(
      ([key, value]) => key in OWNER && OWNER[key as keyof typeof OWNER] === value,
    )
    expect(inherited).toEqual([["ANTHROPIC_API_KEY", "sk-ant-owner-key"]])
    for (const value of Object.values(OWNER).filter((value) => value !== "sk-ant-owner-key"))
      expect(Object.values(env).some((item) => item.includes(value))).toBe(false)
    expect(env.HOME).toBe(home)
    for (const key of ["XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME"])
      expect(env[key]).toStartWith(`${home}/`)
    expect(env.VECTOR_AGENT_DB).toBe(":memory:")
    expect(env.VECTOR_PURE).toBe("1")
    expect(env.VECTOR_DISABLE_USAGE).toBe("1")
    expect(env.VECTOR_DISABLE_PROJECT_CONFIG).toBe("1")
    const config = JSON.parse(env.VECTOR_CONFIG_CONTENT!)
    expect(config.agent.build.prompt).toBe("P")
    expect(config.permission.memory).toBe("deny")
  })

  test("agent-eval's capture runs a child with exactly the environment it is given", async () => {
    const result = await capture({
      command: process.execPath,
      args: ["-e", "console.log(JSON.stringify(Object.keys(process.env).toSorted()))"],
      cwd: root,
      timeoutMs: 20_000,
      env: { PATH: OWNER.PATH, ONLY: "1" },
    })
    expect(JSON.parse(result.output.trim().split("\n").at(-1)!)).toEqual([
      "CI",
      "FORCE_COLOR",
      "NO_COLOR",
      "ONLY",
      "PATH",
    ])
  })

  test("refuses CI, a run without --yes, --max-spend, --prices or a pinned model, and a remote model without --allow-remote", () => {
    const refused = (flags: Record<string, string | boolean>, env: Record<string, string | undefined> = OWNER) => {
      const result = check(flags, env)
      return "refused" in result ? result.refused : "ran"
    }
    expect(refused(ENOUGH, { ...OWNER, CI: "true" })).toContain("never runs in CI")
    expect(refused({ ...ENOUGH, yes: false })).toContain("--yes")
    expect(refused({ ...ENOUGH, "max-spend": "0" })).toContain("--max-spend")
    expect(refused({ ...ENOUGH, prices: false })).toContain("--prices")
    expect(refused({ ...ENOUGH, model: "claude-sonnet-4-5" })).toContain("--model provider/model")
    expect(refused({ ...ENOUGH, "allow-remote": false })).toContain("--allow-remote")
    expect(refused({ ...ENOUGH, "allow-remote": false, "base-url": "https://models.example.com/v1" })).toContain(
      "--allow-remote",
    )
    expect(refused({ ...ENOUGH, repeat: String(MIN_REPEAT - 1) })).toContain("--repeat")
    expect(refused({ ...ENOUGH, "auth-env": "NOT_SET_ANYWHERE" })).toContain("NOT_SET_ANYWHERE")
    expect(refused({ ...ENOUGH, "live-tasks": "no-such-task" })).toContain("Unknown live task")
  })

  test("only a model on this computer runs at $0 prices; a remote one, by --base-url or its own service, needs prices", async () => {
    const zero = join(root, "zero.json")
    await writeFile(zero, JSON.stringify({ input: 0, output: 0 }))
    const live = (baseURL?: string): LiveOptions => ({
      model: "anthropic/claude-sonnet-4-5",
      ...(baseURL ? { baseURL } : {}),
      auth: [],
      maxSpend: 5,
      prices: zero,
      repeat: MIN_REPEAT,
      tasks: [],
    })
    expect(local("https://models.example.com/v1")).toBe(false)
    expect(local("http://[::1]:8000/v1")).toBe(true)
    await expect(rates(live("https://models.example.com/v1"))).rejects.toThrow("prices above $0")
    await expect(rates(live())).rejects.toThrow("prices above $0")
    expect(await rates(live("http://127.0.0.1:8000/v1"))).toMatchObject({ input: 0, output: 0 })
  })

  test("accepts a model on this computer without --allow-remote, and named credentials that are set", () => {
    const local = check(
      { ...ENOUGH, "allow-remote": false, "base-url": "http://127.0.0.1:8000/v1", model: "local/claude-local" },
      OWNER,
    )
    expect(local).toMatchObject({
      model: "local/claude-local",
      baseURL: "http://127.0.0.1:8000/v1",
      repeat: MIN_REPEAT,
      maxSpend: 2,
    })
    expect(check({ ...ENOUGH, "auth-env": "ANTHROPIC_API_KEY", repeat: "6" }, OWNER)).toMatchObject({
      auth: ["ANTHROPIC_API_KEY"],
      repeat: 6,
    })
  })
})
