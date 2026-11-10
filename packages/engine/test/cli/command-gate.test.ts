import { afterEach, expect, test } from "bun:test"
import yargs from "yargs"
import { ChildEnvironment } from "@vectordevai/core/child-environment"
import { commandGate } from "@/cli/command-gate"
import { WorkflowCommand } from "@/cli/cmd/workflow"

const prior = process.env[ChildEnvironment.AGENT_MARKER]
afterEach(() => {
  if (prior === undefined) delete process.env[ChildEnvironment.AGENT_MARKER]
  else process.env[ChildEnvironment.AGENT_MARKER] = prior
})
async function invoke(argv: string[], vector = true, githubActions = false) {
  const calls: string[] = []
  let failure: unknown
  await yargs(argv)
    .exitProcess(false)
    .help(false)
    .version(false)
    .command({
      command: "codium",
      aliases: ["credits"],
      handler: () => {
        calls.push("handler")
      },
    })
    .command({
      ...WorkflowCommand,
      handler: () => {
        calls.push("handler")
      },
    })
    .command({
      command: "run",
      builder: (args) =>
        args
          .option("workflow", { type: "string" })
          .option("local", { type: "boolean" })
          .option("attach", { type: "string" }),
      handler: () => {
        calls.push("handler")
      },
    })
    .middleware((options) =>
      commandGate({
        options,
        vector,
        accountRequired: true,
        githubActions,
        local: async () => {
          calls.push("local")
        },
        account: async () => {
          calls.push("account")
        },
      }),
    )
    .parseAsync()
    .catch((error) => {
      failure = error
    })
  return { calls, failure }
}
test("both Actions status aliases bypass account transport while ordinary status keeps its gate", async () => {
  for (const command of ["codium", "credits"]) {
    expect(await invoke([command], true, true)).toEqual({ calls: ["handler"], failure: undefined })
    expect(await invoke([command], true, false)).toEqual({ calls: ["account", "handler"], failure: undefined })
  }
})
test("real workflow argv keeps offline validation ahead of all account transport", async () => {
  expect(await invoke(["workflow", "validate", "./fixture.json"])).toEqual({ calls: ["handler"], failure: undefined })
  expect(await invoke(["workflow", "validate", "saved-name", "--attach", "http://localhost:4096"])).toEqual({
    calls: ["account", "handler"],
    failure: undefined,
  })
})
test("agent-marked resume and run --workflow refuse before local setup, account, or command handler", async () => {
  process.env[ChildEnvironment.AGENT_MARKER] = "ses_outer"
  for (const argv of [
    ["workflow", "resume", "ses_run", "--session", "ses_parent", "--attach", "http://localhost:4096"],
    ["run", "--workflow", "review", "--local"],
  ]) {
    const result = await invoke(argv)
    expect(result.calls).toEqual([])
    expect(result.failure).toBeDefined()
    expect(String(result.failure)).toContain("agent")
  }
})
test("owner workflow runs establish local policy before account and keep stop available under the marker", async () => {
  delete process.env[ChildEnvironment.AGENT_MARKER]
  expect(await invoke(["run", "--workflow", "review", "--local"])).toEqual({
    calls: ["local", "account", "handler"],
    failure: undefined,
  })
  process.env[ChildEnvironment.AGENT_MARKER] = "ses_outer"
  expect(
    await invoke(["workflow", "stop", "ses_run", "--session", "ses_parent", "--attach", "http://localhost:4096"]),
  ).toEqual({ calls: ["account", "handler"], failure: undefined })
})

test("source entrypoints enforce workflow owner authority before --local without standalone account gating", async () => {
  process.env[ChildEnvironment.AGENT_MARKER] = "ses_outer"
  const refused = await invoke(["run", "--workflow", "review", "--local"], false)
  expect(refused.calls).toEqual([])
  expect(refused.failure).toBeDefined()
  delete process.env[ChildEnvironment.AGENT_MARKER]
  expect(await invoke(["run", "--workflow", "review", "--local"], false)).toEqual({
    calls: ["local", "handler"],
    failure: undefined,
  })
})

test("duplicate workflow options cannot bypass owner refusal or trigger setup", async () => {
  const argv = ["run", "--workflow", "review", "--workflow", "other", "--local"]
  process.env[ChildEnvironment.AGENT_MARKER] = "ses_outer"
  const agent = await invoke(argv)
  expect(agent.calls).toEqual([])
  expect(String(agent.failure)).toContain("agent")
  delete process.env[ChildEnvironment.AGENT_MARKER]
  const owner = await invoke(argv)
  expect(owner.calls).toEqual([])
  expect(String(owner.failure)).toContain("exactly one")
})
