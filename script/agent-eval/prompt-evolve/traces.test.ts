import { afterAll, describe, expect, test } from "bun:test"
import { mkdtemp, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { directory, list, parse, read, save } from "./traces"
import { REPO_ROOT } from "./variants"

const root = await mkdtemp(join(tmpdir(), "prompt-evolve-traces-"))
afterAll(() => rm(root, { recursive: true, force: true }))

const SECRET = "ghp_Zq8xK2mW9vR4tY7uI1oP3aS5dF6gH0jL2kQw"
const tool = (name: string, input: Record<string, unknown>, output: string) => ({
  type: "tool",
  tool: name,
  state: { status: "completed", input, output, title: "", metadata: {} },
})
const exported = {
  info: { id: "ses_1", directory: "/work/app", title: "Fix it" },
  messages: [
    { info: { role: "user" }, parts: [{ type: "text", text: "Fix the failing test." }] },
    {
      info: { role: "assistant" },
      parts: [
        tool("bash", { command: "bun test", description: "Run the tests" }, `1 fail\nGITHUB_TOKEN=${SECRET}`),
        tool("read", { filePath: "/work/app/src/a.ts" }, "1: export const a = 1"),
        { type: "text", text: "Fixed." },
      ],
    },
    { info: { role: "user" }, parts: [{ type: "text", text: "Now commit with password = hunter2secret" }] },
    { info: { role: "assistant" }, parts: [tool("bash", { command: "git status" }, "clean")] },
  ],
}

describe("traces", () => {
  test("an export becomes prompts and calls, each call with its recorded output and prompt, redacted", () => {
    const trace = parse(exported, { commit: "abc123" })
    expect(trace.repo).toBe("/work/app")
    expect(trace.commit).toBe("abc123")
    expect(trace.prompts).toHaveLength(2)
    expect(trace.calls.map((call) => [call.tool, call.prompt])).toEqual([
      ["bash", 0],
      ["read", 0],
      ["bash", 1],
    ])
    expect(trace.calls[1]!.output).toBe("1: export const a = 1")
    expect(JSON.stringify(trace)).not.toContain(SECRET)
    expect(JSON.stringify(trace)).not.toContain("hunter2secret")
  })

  test("a harness dump becomes the same calls, from the longest conversation it sent", () => {
    const body = (messages: unknown[]) => ({ body: { tools: [{ name: "bash" }], messages } })
    const conversation = [
      { role: "user", content: [{ type: "text", text: "Fix the failing test." }] },
      { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "bash", input: { command: "bun test" } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "1 fail" }] },
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "t2", name: "read", input: { filePath: "/work/app/a.ts" } }],
      },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "t2", content: [{ type: "text", text: "1: a" }] }],
      },
    ]
    const dump = { requests: [body(conversation.slice(0, 1)), body(conversation), { body: { messages: [] } }] }
    const trace = parse(dump, { repo: "/work/app" })
    expect(trace).toEqual({
      repo: "/work/app",
      prompts: ["Fix the failing test."],
      calls: [
        { tool: "bash", input: { command: "bun test" }, output: "1 fail", prompt: 0 },
        { tool: "read", input: { filePath: "/work/app/a.ts" }, output: "1: a", prompt: 0 },
      ],
    })
    // Footprint's dump is the list of requests itself.
    expect(parse(dump.requests, { repo: "/work/app" })).toEqual(trace)
  })

  test("traces are written outside the repository, in a folder only the owner can open", async () => {
    const env = { XDG_STATE_HOME: join(root, "state"), HOME: join(root, "home") }
    const file = await save(parse(exported), "fix-test", env)
    expect(file).toBe(join(root, "state", "vector-prompt-evolve", "traces", "fix-test.json"))
    expect((await stat(directory(env))).mode & 0o777).toBe(0o700)
    expect((await stat(file)).mode & 0o777).toBe(0o600)
    expect(await list(env)).toEqual(["fix-test"])
    expect((await read("fix-test", env)).calls).toHaveLength(3)
    expect(directory({ HOME: "/home/owner" })).toBe("/home/owner/.local/state/vector-prompt-evolve/traces")
  })

  test("refuses a state folder inside the repository, and a name that is a path", async () => {
    const env = { XDG_STATE_HOME: join(REPO_ROOT, "script", "agent-eval", "prompt-evolve", ".no-such-state") }
    await expect(save(parse(exported), "fix-test", env)).rejects.toThrow("outside the repository")
    expect(await Bun.file(directory(env)).exists()).toBe(false)
    expect(await stat(env.XDG_STATE_HOME).catch(() => "missing")).toBe("missing")
    await expect(save(parse(exported), "../escape", { XDG_STATE_HOME: join(root, "state") })).rejects.toThrow(
      "trace name",
    )
  })
})
