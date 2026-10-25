import { afterEach, expect } from "bun:test"
import { LayerNode } from "@vectordevai/core/effect/layer-node"
import { Cause, Effect, Exit, Layer } from "effect"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { disposeAllInstances, TestInstance, trustWorkspace } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { Agent, RESEARCHER, RESEARCH_JUDGE } from "../../src/agent/agent"
import PROMPT_REVIEW from "../../src/agent/prompt/review.txt"
import { GENERAL_SUBAGENT } from "../../src/agent/subagent-kind"
import { NATIVE_SPECIALISTS } from "@vectordevai/core/agent/specialists"
import { Auth } from "../../src/auth"
import { Config } from "../../src/config/config"
import { RuntimeFlags } from "../../src/effect/runtime-flags"
import { Global } from "@vectordevai/core/global"
import { Permission } from "../../src/permission"
import { PermissionV1 } from "@vectordevai/core/v1/permission"
import { Plugin } from "../../src/plugin"
import { Provider } from "../../src/provider/provider"
import { Skill } from "../../src/skill"
import { Truncate } from "../../src/tool/truncate"
import { FSUtil } from "@vectordevai/core/fs-util"
import { assertExternalDirectoryEffect } from "../../src/tool/external-directory"
import { SessionID, MessageID } from "../../src/session/schema"
import type { Tool } from "../../src/tool/tool"

const agentLayer = (flags: Partial<RuntimeFlags.Info> = {}) =>
  LayerNode.compile(
    LayerNode.group([Agent.node, Plugin.node, Provider.node, Auth.node, Config.node, Skill.node, RuntimeFlags.node]),
    [[RuntimeFlags.node, RuntimeFlags.layer(flags)]],
  )

const it = testEffect(agentLayer())

// Helper to evaluate permission for a tool with wildcard pattern
function evalPerm(agent: Agent.Info | undefined, permission: string): PermissionV1.Action | undefined {
  if (!agent) return undefined
  return Permission.evaluate(permission, "*", agent.permission).action
}

function load<A>(fn: (svc: Agent.Interface) => Effect.Effect<A>) {
  return Agent.Service.use(fn)
}

function externalActions(agent: Agent.Info, target: string) {
  return Effect.gen(function* () {
    const actions: PermissionV1.Action[] = []
    const ctx: Tool.Context = {
      sessionID: SessionID.make("ses_agent_permissions"),
      messageID: MessageID.make("msg_agent_permissions"),
      callID: "agent_permissions",
      agent: agent.name,
      abort: AbortSignal.any([]),
      messages: [],
      metadata: () => Effect.void,
      ask: (request) =>
        Effect.sync(() => {
          actions.push(
            ...request.patterns.map(
              (pattern) => Permission.evaluate(request.permission, pattern, agent.permission).action,
            ),
          )
        }),
    }
    yield* assertExternalDirectoryEffect(ctx, target)
    return actions
  })
}

const expectDefaultAgentError = Effect.fn("AgentTest.expectDefaultAgentError")(function* (message: string) {
  const exit = yield* load((svc) => svc.defaultAgent()).pipe(Effect.exit)
  expect(Exit.isFailure(exit)).toBe(true)
  if (Exit.isFailure(exit)) expect(Cause.pretty(exit.cause)).toContain(message)
})

afterEach(async () => {
  await disposeAllInstances()
})

it.instance("returns default native agents when no config", () =>
  Effect.gen(function* () {
    const agents = yield* load((svc) => svc.list())
    const names = agents.map((a) => a.name)
    expect(names).toContain("build")
    expect(names).toContain("plan")
    expect(names).toContain("general")
    expect(names).toContain("explore")
    expect(names).toContain("review")
    expect(names).toContain("judge")
    expect(names).toContain("debug")
    expect(names).toContain("test")
    expect(names).toContain("security")
    expect(names).toContain("performance")
    expect(names).toContain("migration")
    expect(names).toContain("compaction")
    expect(names).toContain("title")
    expect(names).toContain("summary")
  }),
)

it.instance("build agent has correct default properties", () =>
  Effect.gen(function* () {
    const build = yield* load((svc) => svc.get("build"))
    expect(build).toBeDefined()
    expect(build?.mode).toBe("primary")
    expect(build?.native).toBe(true)
    expect(evalPerm(build, "edit")).toBe("allow")
    expect(evalPerm(build, "bash")).toBe("allow")
  }),
)

it.instance("plan agent denies edits except .vector/plans/*", () =>
  Effect.gen(function* () {
    const plan = yield* load((svc) => svc.get("plan"))
    expect(plan).toBeDefined()
    // Wildcard is denied
    expect(evalPerm(plan, "edit")).toBe("deny")
    // But specific path is allowed
    expect(Permission.evaluate("edit", ".vector/plans/foo.md", plan!.permission).action).toBe("allow")
  }),
)

it.instance("plan agent denies mutation-capable subagents by default", () =>
  Effect.gen(function* () {
    const plan = yield* load((svc) => svc.get("plan"))
    expect(plan).toBeDefined()
    expect(Permission.evaluate("task", "general", plan!.permission).action).toBe("deny")
    expect(Permission.evaluate("task", "debug", plan!.permission).action).toBe("deny")
    expect(Permission.evaluate("task", "test", plan!.permission).action).toBe("deny")
    expect(Permission.evaluate("task", "performance", plan!.permission).action).toBe("deny")
    expect(Permission.evaluate("task", "migration", plan!.permission).action).toBe("deny")
    expect(Permission.evaluate("task", "explore", plan!.permission).action).toBe("allow")
    expect(Permission.evaluate("task", "review", plan!.permission).action).toBe("allow")
    expect(Permission.evaluate("task", "security", plan!.permission).action).toBe("allow")
    expect(Permission.evaluate("task", "custom", plan!.permission).action).toBe("allow")
  }),
)

it.instance(
  "user permission can allow the general subagent from plan mode",
  () =>
    Effect.gen(function* () {
      const plan = yield* load((svc) => svc.get("plan"))
      expect(plan).toBeDefined()
      expect(Permission.evaluate("task", "general", plan!.permission).action).toBe("allow")
    }),
  {
    trusted: true,
    config: {
      permission: {
        task: {
          general: "allow",
        },
      },
    },
  },
)

it.instance("explore agent denies edit and write", () =>
  Effect.gen(function* () {
    const explore = yield* load((svc) => svc.get("explore"))
    expect(explore).toBeDefined()
    expect(explore?.mode).toBe("subagent")
    expect(evalPerm(explore, "edit")).toBe("deny")
    expect(evalPerm(explore, "write")).toBe("deny")
    expect(evalPerm(explore, "todowrite")).toBe("deny")
    expect(Permission.evaluate("bash", "rm -rf src", explore!.permission).action).toBe("deny")
    expect(Permission.evaluate("bash", "git status --short", explore!.permission).action).toBe("allow")
  }),
)

it.instance("explore agent asks for external directories and allows whitelisted external paths", () =>
  Effect.gen(function* () {
    const explore = yield* load((svc) => svc.get("explore"))
    expect(explore).toBeDefined()
    expect(Permission.evaluate("external_directory", "/some/other/path", explore!.permission).action).toBe("ask")
    expect(Permission.evaluate("external_directory", Truncate.GLOB, explore!.permission).action).toBe("allow")
    expect(yield* externalActions(explore!, path.join(Global.Path.tmp, "agent-work"))).toEqual(["allow"])
  }),
)

it.instance(
  "reference config does not create subagents",
  () =>
    Effect.gen(function* () {
      const agents = yield* load((svc) => svc.list())
      const names = agents.map((agent) => agent.name)
      expect(names).not.toContain("effect")
      expect(names).not.toContain("effectFull")
      expect(names).not.toContain("localdocs")
      expect(names).not.toContain("localdocsFull")
    }),
  {
    trusted: true,
    config: {
      references: {
        effect: "github.com/effect/effect-smol",
        effectFull: {
          repository: "Effect-TS/effect",
          branch: "main",
        },
        localdocs: "../docs",
        localdocsFull: {
          path: "../local-docs",
        },
      },
    },
  },
)

it.instance("general agent denies todo tools", () =>
  Effect.gen(function* () {
    const general = yield* load((svc) => svc.get("general"))
    expect(general).toBeDefined()
    expect(general?.mode).toBe("subagent")
    expect(general?.hidden).toBeUndefined()
    expect(evalPerm(general, "todowrite")).toBe("deny")
  }),
)

it.instance("native specialist agents have the intended permission boundaries", () =>
  Effect.gen(function* () {
    const review = yield* load((svc) => svc.get("review"))
    const judge = yield* load((svc) => svc.get("judge"))
    const security = yield* load((svc) => svc.get("security"))
    const debug = yield* load((svc) => svc.get("debug"))
    const test = yield* load((svc) => svc.get("test"))

    for (const agent of [review, judge, security]) {
      expect(agent?.mode).toBe("subagent")
      expect(agent?.native).toBe(true)
      expect(evalPerm(agent, "read")).toBe("allow")
      expect(evalPerm(agent, "edit")).toBe("deny")
      expect(evalPerm(agent, "write")).toBe("deny")
      expect(Permission.evaluate("bash", "rm -rf dist", agent!.permission).action).toBe("deny")
    }

    expect(Permission.evaluate("bash", "gh pr view 42", review!.permission).action).toBe("allow")
    expect(Permission.evaluate("bash", "gh pr diff 42", review!.permission).action).toBe("allow")
    expect(Permission.evaluate("bash", "gh pr review 42 --comment", review!.permission).action).toBe("ask")

    for (const agent of [debug, test]) {
      expect(agent?.mode).toBe("subagent")
      expect(agent?.native).toBe(true)
      expect(evalPerm(agent, "read")).toBe("allow")
      expect(evalPerm(agent, "edit")).toBe("allow")
      expect(evalPerm(agent, "bash")).toBe("allow")
      expect(evalPerm(agent, "todowrite")).toBe("deny")
    }
  }),
)

it.instance(
  "user permissions cannot make read-only specialists mutate files",
  () =>
    Effect.gen(function* () {
      for (const name of ["explore", "review", "judge", "security"] as const) {
        const agent = yield* load((svc) => svc.get(name))
        expect(Permission.evaluate("edit", "src/app.ts", agent!.permission).action).toBe("deny")
        expect(Permission.evaluate("bash", "rm -rf src", agent!.permission).action).toBe("deny")
      }
    }),
  {
    trusted: true,
    config: {
      permission: {
        edit: "allow",
        bash: "allow",
      },
    },
  },
)

it.instance(
  "agent-specific config cannot make native read-only specialists mutate files or delegate mutations",
  () =>
    Effect.gen(function* () {
      for (const name of ["explore", "review", "judge", "security"] as const) {
        const agent = yield* load((svc) => svc.get(name))
        expect(Permission.evaluate("edit", "src/app.ts", agent!.permission).action).toBe("deny")
        expect(Permission.evaluate("bash", "rm -rf src", agent!.permission).action).toBe("deny")
        expect(Permission.evaluate("task", "general", agent!.permission).action).toBe("deny")
      }
    }),
  {
    trusted: true,
    config: {
      agent: {
        explore: { permission: { edit: "allow", bash: "allow", task: "allow" } },
        review: { permission: { edit: "allow", bash: "allow", task: "allow" } },
        judge: { permission: { edit: "allow", bash: "allow", task: "allow" } },
        security: { permission: { edit: "allow", bash: "allow", task: "allow" } },
      },
    },
  },
)

it.instance(
  "read-only specialists keep the user's denies and asks, and the default asks for secret files",
  () =>
    Effect.gen(function* () {
      for (const name of ["explore", "review", "judge", "security"] as const) {
        const agent = yield* load((svc) => svc.get(name))
        const action = (permission: string, pattern: string) =>
          Permission.evaluate(permission, pattern, agent!.permission).action
        expect(action("webfetch", "https://example.com")).toBe("deny")
        expect(action("read", "secrets/token.txt")).toBe("deny")
        expect(action("read", "src/app.ts")).toBe("allow")
        expect(action("read", ".env")).toBe("ask")
        expect(action("read", "keys/server.pem")).toBe("ask")
        expect(action("bash", "git status --short")).toBe("ask")
        expect(action("bash", "bun test")).toBe("ask")
        // An ask narrows a command the specialist may run; it never reopens one it may not.
        expect(action("bash", "git push origin main")).toBe("deny")
        expect(action("bash", "git difftool -y --extcmd=sh")).toBe("deny")
        expect(action("bash", "git diff --output=src/app.ts")).toBe("deny")
        expect(action("bash", "git diff --no-index .env README.md")).toBe("deny")
        expect(action("mcp_github_create_or_update_file", "*")).toBe("deny")
      }
    }),
  {
    trusted: true,
    config: {
      permission: {
        webfetch: "deny",
        read: { "secrets/*": "deny" },
        bash: { "git *": "ask", "rm *": "ask" },
      },
    },
  },
)

it.instance("read-only specialists require approval before repository-controlled test and build scripts", () =>
  Effect.gen(function* () {
    for (const name of ["explore", "review", "judge", "security"] as const) {
      const agent = yield* load((svc) => svc.get(name))
      const action = (command: string) => Permission.evaluate("bash", command, agent!.permission).action
      expect(action("bun test --preload ./malicious.ts")).toBe("ask")
      expect(action("bun run build -- --config ./malicious.ts")).toBe("ask")
      expect(action("npm test -- --require ./malicious.cjs")).toBe("ask")
      expect(action("pnpm run build --config ./malicious.js")).toBe("ask")
      expect(action("pytest -p malicious_plugin")).toBe("ask")
    }
  }),
)

it.instance(
  "a repository config cannot hand a read-only specialist tools it does not have",
  () =>
    Effect.gen(function* () {
      const review = yield* load((svc) => svc.get("review"))
      const action = (permission: string, pattern = "*") =>
        Permission.evaluate(permission, pattern, review!.permission).action
      expect(action("vector_cloud_publish")).toBe("deny")
      expect(action("mcp_github_create_or_update_file")).toBe("deny")
      expect(action("external_directory", "/etc/*")).toBe("ask")
      expect(action("websearch")).toBe("deny")
      expect(action("grep")).toBe("allow")
    }),
  {
    trusted: true,
    config: {
      agent: {
        review: { permission: { "*": "allow", websearch: "deny" } },
      },
    },
  },
)

it.instance("compaction agent denies all permissions", () =>
  Effect.gen(function* () {
    const compaction = yield* load((svc) => svc.get("compaction"))
    expect(compaction).toBeDefined()
    expect(compaction?.hidden).toBe(true)
    expect(evalPerm(compaction, "bash")).toBe("deny")
    expect(evalPerm(compaction, "edit")).toBe("deny")
    expect(evalPerm(compaction, "read")).toBe("deny")
  }),
)

it.instance(
  "custom agent from config creates new agent",
  () =>
    Effect.gen(function* () {
      const custom = yield* load((svc) => svc.get("my_custom_agent"))
      expect(custom).toBeDefined()
      expect(String(custom?.model?.providerID)).toBe("openai")
      expect(String(custom?.model?.modelID)).toBe("gpt-4")
      expect(custom?.description).toBe("My custom agent")
      expect(custom?.temperature).toBe(0.5)
      expect(custom?.topP).toBe(0.9)
      expect(custom?.native).toBe(false)
      expect(custom?.mode).toBe("all")
    }),
  {
    trusted: true,
    config: {
      agent: {
        my_custom_agent: {
          model: "openai/gpt-4",
          description: "My custom agent",
          temperature: 0.5,
          top_p: 0.9,
        },
      },
    },
  },
)

it.instance(
  "custom agent config overrides native agent properties",
  () =>
    Effect.gen(function* () {
      const build = yield* load((svc) => svc.get("build"))
      expect(build).toBeDefined()
      expect(String(build?.model?.providerID)).toBe("anthropic")
      expect(String(build?.model?.modelID)).toBe("claude-3")
      expect(build?.description).toBe("Custom build agent")
      expect(build?.temperature).toBe(0.7)
      expect(build?.color).toBe("#FF0000")
      expect(build?.native).toBe(true)
    }),
  {
    trusted: true,
    config: {
      agent: {
        build: {
          model: "anthropic/claude-3",
          description: "Custom build agent",
          temperature: 0.7,
          color: "#FF0000",
        },
      },
    },
  },
)

it.instance(
  "agent disable removes agent from list",
  () =>
    Effect.gen(function* () {
      const explore = yield* load((svc) => svc.get("explore"))
      expect(explore).toBeUndefined()
      const agents = yield* load((svc) => svc.list())
      const names = agents.map((a) => a.name)
      expect(names).not.toContain("explore")
    }),
  {
    trusted: true,
    config: {
      agent: {
        explore: { disable: true },
      },
    },
  },
)

it.instance(
  "general disable removes the general Subagent and keeps the specialists",
  () =>
    Effect.gen(function* () {
      expect(yield* load((svc) => svc.get("general"))).toBeUndefined()
      const names = (yield* load((svc) => svc.list())).map((a) => a.name)
      expect(names).not.toContain("general")
      expect(names).toContain("explore")
      expect(names).toContain("review")
      expect(names).toContain("build")
    }),
  { trusted: true, config: { agent: { general: { disable: true } } } },
)

it.instance("native Subagents include the configurable coding specialists and dedicated research helpers", () =>
  Effect.gen(function* () {
    const specialists = (yield* load((svc) => svc.list()))
      .filter((agent) => agent.native === true && agent.mode === "subagent" && agent.name !== GENERAL_SUBAGENT)
      .map((agent) => agent.name)
      .toSorted()
    expect(specialists).toEqual([...NATIVE_SPECIALISTS, RESEARCHER, RESEARCH_JUDGE].toSorted())
    expect(NATIVE_SPECIALISTS).not.toContain(RESEARCHER)
    expect(NATIVE_SPECIALISTS).not.toContain(RESEARCH_JUDGE)
  }),
)

it.instance(
  "turning every specialist off keeps the main agents, general and Vector's helpers",
  () =>
    Effect.gen(function* () {
      const names = (yield* load((svc) => svc.list())).map((agent) => agent.name)
      for (const name of NATIVE_SPECIALISTS) {
        expect(names).not.toContain(name)
        expect(yield* load((svc) => svc.get(name))).toBeUndefined()
      }
      for (const name of [
        "build",
        "plan",
        "general",
        "quick",
        "autocomplete",
        "compaction",
        "title",
        "summary",
        "distill",
      ]) {
        expect(names).toContain(name)
      }
    }),
  {
    trusted: true,
    config: { agent: Object.fromEntries(NATIVE_SPECIALISTS.map((name) => [name, { disable: true }])) },
  },
)

// Vectorscope runs its reviewers as the review and security specialists, so turning one off in Settings must leave a
// copy that only a helper session reaches, with the specialist's own prompt and read-only permissions.
it.instance(
  "a helper still runs as a specialist that is turned off",
  () =>
    Effect.gen(function* () {
      const review = yield* load((svc) => svc.helper("review"))
      expect(review?.name).toBe("review")
      expect(review?.hidden).toBe(true)
      expect(review?.prompt).toBe(PROMPT_REVIEW)
      expect(evalPerm(review, "edit")).toBe("deny")
      expect(evalPerm(review, "grep")).toBe("allow")
      // Only helper finds the copy: get, which every other session uses, finds it under no name.
      expect(yield* load((svc) => svc.get("review"))).toBeUndefined()
      expect(yield* load((svc) => svc.get("helper:review"))).toBeUndefined()
      expect(yield* load((svc) => svc.helper("helper:review"))).toBeUndefined()
      // A specialist that is on is itself, for a helper too.
      expect((yield* load((svc) => svc.helper("explore")))?.name).toBe("explore")
      // A user-defined agent turned off is gone for helpers as well.
      expect(yield* load((svc) => svc.helper("mine"))).toBeUndefined()
    }),
  {
    trusted: true,
    config: { agent: { review: { disable: true }, mine: { description: "Mine", mode: "subagent", disable: true } } },
  },
)

it.instance(
  "agent permission config merges with defaults",
  () =>
    Effect.gen(function* () {
      const build = yield* load((svc) => svc.get("build"))
      expect(build).toBeDefined()
      // Specific pattern is denied
      expect(Permission.evaluate("bash", "rm -rf *", build!.permission).action).toBe("deny")
      // Edit still allowed
      expect(evalPerm(build, "edit")).toBe("allow")
    }),
  {
    trusted: true,
    config: {
      agent: {
        build: {
          permission: {
            bash: {
              "rm -rf *": "deny",
            },
          },
        },
      },
    },
  },
)

it.instance(
  "global permission config applies to all agents",
  () =>
    Effect.gen(function* () {
      const build = yield* load((svc) => svc.get("build"))
      expect(build).toBeDefined()
      expect(evalPerm(build, "bash")).toBe("deny")
    }),
  {
    trusted: true,
    config: {
      permission: {
        bash: "deny",
      },
    },
  },
)

it.instance(
  "agent steps/maxSteps config sets steps property",
  () =>
    Effect.gen(function* () {
      const build = yield* load((svc) => svc.get("build"))
      const plan = yield* load((svc) => svc.get("plan"))
      expect(build?.steps).toBe(50)
      expect(plan?.steps).toBe(100)
    }),
  {
    trusted: true,
    config: {
      agent: {
        build: { steps: 50 },
        plan: { maxSteps: 100 },
      },
    },
  },
)

it.instance(
  "agent mode can be overridden",
  () =>
    Effect.gen(function* () {
      const explore = yield* load((svc) => svc.get("explore"))
      expect(explore?.mode).toBe("primary")
    }),
  {
    trusted: true,
    config: {
      agent: {
        explore: { mode: "primary" },
      },
    },
  },
)

it.instance(
  "agent name can be overridden",
  () =>
    Effect.gen(function* () {
      const build = yield* load((svc) => svc.get("build"))
      expect(build?.name).toBe("Builder")
    }),
  {
    trusted: true,
    config: {
      agent: {
        build: { name: "Builder" },
      },
    },
  },
)

it.instance(
  "agent prompt can be set from config",
  () =>
    Effect.gen(function* () {
      const build = yield* load((svc) => svc.get("build"))
      expect(build?.prompt).toBe("Custom system prompt")
    }),
  {
    trusted: true,
    config: {
      agent: {
        build: { prompt: "Custom system prompt" },
      },
    },
  },
)

it.instance(
  "unknown agent properties are placed into options",
  () =>
    Effect.gen(function* () {
      const build = yield* load((svc) => svc.get("build"))
      expect(build?.options.random_property).toBe("hello")
      expect(build?.options.another_random).toBe(123)
    }),
  {
    trusted: true,
    config: {
      agent: {
        build: {
          random_property: "hello",
          another_random: 123,
        },
      },
    },
  },
)

it.instance(
  "agent options merge correctly",
  () =>
    Effect.gen(function* () {
      const build = yield* load((svc) => svc.get("build"))
      expect(build?.options.custom_option).toBe(true)
      expect(build?.options.another_option).toBe("value")
    }),
  {
    trusted: true,
    config: {
      agent: {
        build: {
          options: {
            custom_option: true,
            another_option: "value",
          },
        },
      },
    },
  },
)

it.instance(
  "multiple custom agents can be defined",
  () =>
    Effect.gen(function* () {
      const agentA = yield* load((svc) => svc.get("agent_a"))
      const agentB = yield* load((svc) => svc.get("agent_b"))
      expect(agentA?.description).toBe("Agent A")
      expect(agentA?.mode).toBe("subagent")
      expect(agentB?.description).toBe("Agent B")
      expect(agentB?.mode).toBe("primary")
    }),
  {
    trusted: true,
    config: {
      agent: {
        agent_a: {
          description: "Agent A",
          mode: "subagent",
        },
        agent_b: {
          description: "Agent B",
          mode: "primary",
        },
      },
    },
  },
)

it.instance(
  "Agent.list keeps the default agent first and sorts the rest by name",
  () =>
    Effect.gen(function* () {
      const names = (yield* load((svc) => svc.list())).map((a) => a.name)
      expect(names[0]).toBe("plan")
      expect(names.slice(1)).toEqual(names.slice(1).toSorted((a, b) => a.localeCompare(b)))
    }),
  {
    trusted: true,
    config: {
      default_agent: "plan",
      agent: {
        zebra: {
          description: "Zebra",
          mode: "subagent",
        },
        alpha: {
          description: "Alpha",
          mode: "subagent",
        },
      },
    },
  },
)

it.instance("Agent.get returns undefined for non-existent agent", () =>
  Effect.gen(function* () {
    const nonExistent = yield* load((svc) => svc.get("does_not_exist"))
    expect(nonExistent).toBeUndefined()
  }),
)

it.instance("default permission asks for risky and unsandboxed operations", () =>
  Effect.gen(function* () {
    const build = yield* load((svc) => svc.get("build"))
    expect(evalPerm(build, "doom_loop")).toBe("ask")
    expect(evalPerm(build, "external_directory")).toBe("ask")
    expect(evalPerm(build, "unsandboxed_shell")).toBe("ask")
    expect(evalPerm(build, "webfetch")).toBe("ask")
    expect(evalPerm(build, "websearch")).toBe("ask")
  }),
)

it.instance("terminals the agent did not open ask before input, resizing or closing; its own do not", () =>
  Effect.gen(function* () {
    for (const name of ["build", "general", "debug", "test"]) {
      const agent = (yield* load((svc) => svc.get(name)))!
      for (const permission of ["terminal", "terminal_input"]) {
        expect(Permission.evaluate(permission, "own:pty_1", agent.permission).action).toBe("allow")
        expect(Permission.evaluate(permission, "other:pty_1", agent.permission).action).toBe("ask")
      }
      expect(Permission.disabled(["terminal"], agent.permission).size).toBe(0)
    }
    // The read-only specialists and the quick lane deny everything else, which hides the tool.
    for (const name of ["explore", "review", "judge", "security", "quick"]) {
      const agent = (yield* load((svc) => svc.get(name)))!
      expect(Permission.disabled(["terminal"], agent.permission).has("terminal")).toBe(true)
      expect(Permission.evaluate("terminal_input", "own:pty_1", agent.permission).action).toBe("deny")
    }
  }),
)

it.instance(
  "plan mode never types into a terminal, whatever the user's rules allow",
  () =>
    Effect.gen(function* () {
      const plan = (yield* load((svc) => svc.get("plan")))!
      const build = (yield* load((svc) => svc.get("build")))!
      expect(Permission.evaluate("terminal_input", "own:pty_1", plan.permission).action).toBe("deny")
      expect(Permission.evaluate("terminal_input", "other:pty_1", plan.permission).action).toBe("deny")
      // Reading, waiting and its own terminals' lifecycle stay as the defaults have them.
      expect(Permission.evaluate("terminal", "own:pty_1", plan.permission).action).toBe("allow")
      expect(Permission.disabled(["terminal"], plan.permission).size).toBe(0)
      expect(Permission.evaluate("terminal_input", "other:pty_1", build.permission).action).toBe("allow")
    }),
  { trusted: true, config: { permission: { terminal_input: "allow" } } },
)

it.instance("research agents are never handed a terminal", () =>
  Effect.gen(function* () {
    for (const name of ["research", RESEARCHER]) {
      const agent = (yield* load((svc) => svc.get(name)))!
      expect(Permission.evaluate("terminal", "own:pty_1", agent.permission).action).toBe("deny")
      expect(Permission.evaluate("terminal_input", "own:pty_1", agent.permission).action).toBe("deny")
    }
  }),
)

it.instance("Vector Cloud publishing, database and host environment changes ask by default", () =>
  Effect.gen(function* () {
    for (const name of ["build", "plan", "general", "debug", "test", "performance", "migration"]) {
      const agent = yield* load((svc) => svc.get(name))
      expect(evalPerm(agent, "vector_cloud_publish")).toBe("ask")
      expect(evalPerm(agent, "vector_cloud_database")).toBe("ask")
      expect(evalPerm(agent, "vector_cloud_environment")).toBe("ask")
      expect(evalPerm(agent, "vector_cloud_hosting")).toBe("ask")
    }
    // A dry run only reads which migrations a database has applied.
    const build = yield* load((svc) => svc.get("build"))
    expect(evalPerm(build, "vector_cloud_inspect")).toBe("allow")
  }),
)

it.instance(
  "a wildcard allow does not approve Vector Cloud changes",
  () =>
    Effect.gen(function* () {
      for (const name of ["build", "deployer"]) {
        const agent = yield* load((svc) => svc.get(name))
        expect(evalPerm(agent, "vector_cloud_publish")).toBe("ask")
        expect(evalPerm(agent, "vector_cloud_database")).toBe("ask")
        expect(evalPerm(agent, "vector_cloud_environment")).toBe("ask")
        expect(evalPerm(agent, "vector_cloud_hosting")).toBe("ask")
        expect(evalPerm(agent, "edit")).toBe("allow")
      }
    }),
  {
    trusted: true,
    config: {
      permission: { "*": "allow" },
      agent: { deployer: { description: "Ships releases", mode: "subagent", permission: { "*": "allow" } } },
    },
  },
)

it.instance(
  "explicit Cloud rules remain in agent metadata before runtime approval",
  () =>
    Effect.gen(function* () {
      const build = yield* load((svc) => svc.get("build"))
      expect(evalPerm(build, "vector_cloud_publish")).toBe("allow")
      expect(evalPerm(build, "vector_cloud_database")).toBe("ask")
      expect(evalPerm(build, "vector_cloud_environment")).toBe("deny")
      const deployer = yield* load((svc) => svc.get("deployer"))
      expect(evalPerm(deployer, "vector_cloud_publish")).toBe("allow")
      expect(evalPerm(deployer, "vector_cloud_database")).toBe("allow")
      expect(evalPerm(deployer, "vector_cloud_environment")).toBe("allow")
      expect(evalPerm(deployer, "vector_cloud_hosting")).toBe("allow")
      expect(evalPerm(build, "vector_cloud_hosting")).toBe("ask")
    }),
  {
    trusted: true,
    config: {
      permission: { vector_cloud_publish: "allow", vector_cloud_environment: "deny" },
      agent: {
        deployer: { description: "Ships releases", mode: "subagent", permission: { "vector_cloud_*": "allow" } },
      },
    },
  },
)

it.instance("sensitive credential files require approval by default", () =>
  Effect.gen(function* () {
    const build = yield* load((svc) => svc.get("build"))
    expect(Permission.evaluate("read", "private.pem", build.permission).action).toBe("ask")
    expect(Permission.evaluate("read", ".ssh/id_ed25519", build.permission).action).toBe("ask")
    expect(Permission.evaluate("read", "src/index.ts", build.permission).action).toBe("allow")
  }),
)

it.instance(
  "legacy tools config converts to permissions",
  () =>
    Effect.gen(function* () {
      const build = yield* load((svc) => svc.get("build"))
      expect(evalPerm(build, "bash")).toBe("deny")
      expect(evalPerm(build, "read")).toBe("deny")
    }),
  {
    trusted: true,
    config: {
      agent: {
        build: {
          tools: {
            bash: false,
            read: false,
          },
        },
      },
    },
  },
)

it.instance(
  "legacy tools config maps write/edit/patch to edit permission",
  () =>
    Effect.gen(function* () {
      const build = yield* load((svc) => svc.get("build"))
      expect(evalPerm(build, "edit")).toBe("deny")
    }),
  {
    trusted: true,
    config: {
      agent: {
        build: {
          tools: {
            write: false,
          },
        },
      },
    },
  },
)

it.instance(
  "Truncate.GLOB is allowed even when user denies external_directory globally",
  () =>
    Effect.gen(function* () {
      const build = yield* load((svc) => svc.get("build"))
      expect(Permission.evaluate("external_directory", Truncate.GLOB, build!.permission).action).toBe("allow")
      expect(Permission.evaluate("external_directory", Truncate.DIR, build!.permission).action).toBe("deny")
      expect(Permission.evaluate("external_directory", "/some/other/path", build!.permission).action).toBe("deny")
    }),
  {
    trusted: true,
    config: {
      permission: {
        external_directory: "deny",
      },
    },
  },
)

it.instance(
  "a trusted project's allow cannot lift a user-global deny",
  () =>
    Effect.gen(function* () {
      const config = yield* Config.Service
      const dir = yield* Effect.acquireRelease(
        Effect.promise(() => fs.mkdtemp(path.join(os.tmpdir(), "vector-global-"))),
        (dir) => Effect.promise(() => fs.rm(dir, { recursive: true, force: true })),
      )
      yield* Effect.promise(() =>
        Bun.write(
          path.join(dir, "vector.json"),
          JSON.stringify({
            permission: { bash: { "*": "deny", "git status*": "allow" }, edit: { "*.lock": "deny" } },
            tools: { webfetch: false },
            agent: { build: { permission: { websearch: "deny" } } },
          }),
        ),
      )
      const previous = Global.Path.config
      yield* Effect.acquireRelease(
        Effect.sync(() => {
          ;(Global.Path as { config: string }).config = dir
        }).pipe(Effect.andThen(config.invalidate())),
        () =>
          Effect.sync(() => {
            ;(Global.Path as { config: string }).config = previous
          }).pipe(Effect.andThen(config.invalidate())),
      )

      const build = yield* load((svc) => svc.get("build"))
      const plan = yield* load((svc) => svc.get("plan"))
      const action = (agent: Agent.Info | undefined, permission: string, pattern: string) =>
        Permission.evaluate(permission, pattern, agent!.permission).action
      const explore = yield* load((svc) => svc.get("explore"))
      expect(action(build, "bash", "curl https://example.com")).toBe("deny")
      expect(action(plan, "bash", "curl https://example.com")).toBe("deny")
      expect(action(explore, "bash", "git diff")).toBe("deny")
      expect(action(explore, "edit", "src/index.ts")).toBe("deny")
      // The user's own exception to the deny still holds.
      expect(action(build, "bash", "git status")).toBe("allow")
      expect(action(build, "edit", "bun.lock")).toBe("deny")
      expect(action(build, "webfetch", "https://example.com")).toBe("deny")
      expect(action(build, "websearch", "query")).toBe("deny")
      // The project still decides wherever the user's global config denies nothing.
      expect(action(build, "edit", "src/index.ts")).toBe("allow")
      expect(action(build, "read", "src/index.ts")).toBe("allow")
    }),
  {
    trusted: true,
    config: {
      permission: { bash: "allow", edit: "allow", webfetch: "allow", websearch: "allow" },
      agent: { build: { permission: { bash: { "curl *": "allow" }, websearch: "allow" } } },
    },
  },
)

it.instance(
  "a user-global deny keeps its own exceptions when the project adds no permissions",
  () =>
    Effect.gen(function* () {
      const config = yield* Config.Service
      const dir = yield* Effect.acquireRelease(
        Effect.promise(() => fs.mkdtemp(path.join(os.tmpdir(), "vector-global-"))),
        (dir) => Effect.promise(() => fs.rm(dir, { recursive: true, force: true })),
      )
      yield* Effect.promise(() =>
        Bun.write(
          path.join(dir, "vector.json"),
          JSON.stringify({ permission: { bash: { "*": "deny", "git status*": "allow" } } }),
        ),
      )
      const previous = Global.Path.config
      yield* Effect.acquireRelease(
        Effect.sync(() => {
          ;(Global.Path as { config: string }).config = dir
        }).pipe(Effect.andThen(config.invalidate())),
        () =>
          Effect.sync(() => {
            ;(Global.Path as { config: string }).config = previous
          }).pipe(Effect.andThen(config.invalidate())),
      )

      const build = yield* load((svc) => svc.get("build"))
      expect(Permission.evaluate("bash", "git status", build!.permission).action).toBe("allow")
      expect(Permission.evaluate("bash", "rm -rf /", build!.permission).action).toBe("deny")
    }),
  { trusted: true, config: { model: "test/model" } },
)

it.instance("global tmp directory children are allowed for external_directory", () =>
  Effect.gen(function* () {
    const build = yield* load((svc) => svc.get("build"))
    expect(
      Permission.evaluate(
        "external_directory",
        path.join(FSUtil.normalizePath(Global.Path.tmp), "scratch"),
        build!.permission,
      ).action,
    ).toBe("allow")
    expect(
      Permission.evaluate(
        "external_directory",
        `${FSUtil.normalizePath(Global.Path.tmp)}-other/scratch`,
        build!.permission,
      ).action,
    ).toBe("ask")
    expect(Permission.evaluate("external_directory", "/some/other/path", build!.permission).action).toBe("ask")
  }),
)

it.instance(
  "an explicit tmp directory deny applies to the captured canonical root",
  () =>
    Effect.gen(function* () {
      const build = yield* load((svc) => svc.get("build"))
      expect(
        Permission.evaluate(
          "external_directory",
          path.join(FSUtil.normalizePath(Global.Path.tmp), "scratch"),
          build!.permission,
        ).action,
      ).toBe("deny")
      expect(yield* externalActions(build!, path.join(Global.Path.tmp, "scratch"))).toEqual(["deny"])
    }),
  {
    trusted: true,
    config: {
      permission: {
        external_directory: {
          [process.platform === "win32"
            ? path.join(Global.Path.tmp, "*").toUpperCase().replaceAll("\\", "/")
            : path.join(Global.Path.tmp, "*")]: "deny",
        },
      },
    },
  },
)

it.instance(
  "Truncate.GLOB is allowed even when user denies external_directory per-agent",
  () =>
    Effect.gen(function* () {
      const build = yield* load((svc) => svc.get("build"))
      expect(Permission.evaluate("external_directory", Truncate.GLOB, build!.permission).action).toBe("allow")
      expect(Permission.evaluate("external_directory", Truncate.DIR, build!.permission).action).toBe("deny")
      expect(Permission.evaluate("external_directory", "/some/other/path", build!.permission).action).toBe("deny")
    }),
  {
    trusted: true,
    config: {
      agent: {
        build: {
          permission: {
            external_directory: "deny",
          },
        },
      },
    },
  },
)

it.instance(
  "explicit Truncate.GLOB deny is respected",
  () =>
    Effect.gen(function* () {
      const build = yield* load((svc) => svc.get("build"))
      expect(Permission.evaluate("external_directory", Truncate.GLOB, build!.permission).action).toBe("deny")
      expect(Permission.evaluate("external_directory", Truncate.DIR, build!.permission).action).toBe("deny")
    }),
  {
    trusted: true,
    config: {
      permission: {
        external_directory: {
          "*": "deny",
          [process.platform === "win32"
            ? path.join(Global.Path.data, "tool-output", "*").toUpperCase()
            : path.join(Global.Path.data, "tool-output", "*")]: "deny",
        },
      },
    },
  },
)

it.instance(
  "skill directories are allowed for external_directory",
  () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const skillDir = path.join(test.directory, ".vector", "skill", "perm-skill")
      yield* Effect.promise(() =>
        Bun.write(
          path.join(skillDir, "SKILL.md"),
          `---
name: perm-skill
description: Permission skill.
---

# Permission Skill
`,
        ),
      )
      yield* Effect.promise(() => Bun.write(path.join(skillDir, "reference", "notes.md"), "Skill reference notes."))
      yield* Effect.promise(() => trustWorkspace(test.directory))

      yield* Effect.promise(() => fs.mkdir(path.join(test.directory, "empty-home"), { recursive: true }))
      const home = process.env.VECTOR_TEST_HOME
      process.env.VECTOR_TEST_HOME = path.join(test.directory, "empty-home")
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          process.env.VECTOR_TEST_HOME = home
        }),
      )

      const build = yield* load((svc) => svc.get("build"))
      // A trusted project's skills load from the approved snapshot, so that copy is the directory the agent reads.
      const skill = yield* Skill.Service.use((svc) => svc.get("perm-skill"))
      const target = path.join(path.dirname(skill!.location), "reference", "notes.md")
      expect(yield* Effect.promise(() => Bun.file(target).text())).toBe("Skill reference notes.")
      expect(yield* externalActions(build!, target)).toEqual(["allow"])
    }),
  { git: true },
)

it.instance(
  "project reference directories are allowed for external_directory",
  () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const build = yield* load((svc) => svc.get("build"))
      const target = path.resolve(test.directory, "../docs/reference/notes.md")
      expect(Permission.evaluate("external_directory", target, build!.permission).action).toBe("allow")
    }),
  {
    trusted: true,
    git: true,
    config: {
      references: {
        docs: "../docs",
      },
    },
  },
)

it.instance(
  "a captured reference allowance does not follow a retargeted directory link",
  () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const link = path.join(test.directory, "docs-link")
      const before = FSUtil.normalizePath(link)
      const build = yield* load((svc) => svc.get("build"))
      expect(Permission.evaluate("external_directory", path.join(before, "notes.md"), build!.permission).action).toBe(
        "allow",
      )
      yield* Effect.promise(async () => {
        await fs.unlink(link)
        await fs.symlink(path.join(test.directory, "second"), link, process.platform === "win32" ? "junction" : "dir")
      })
      const after = yield* Effect.promise(() => fs.realpath(link))
      expect(Permission.evaluate("external_directory", path.join(after, "notes.md"), build!.permission).action).toBe(
        "ask",
      )
      expect(Permission.evaluate("external_directory", path.join(before, "notes.md"), build!.permission).action).toBe(
        "allow",
      )
    }),
  {
    trusted: true,
    git: true,
    config: { references: { docs: "./docs-link" } },
    init: (directory) =>
      Effect.promise(async () => {
        await fs.mkdir(path.join(directory, "first"))
        await fs.mkdir(path.join(directory, "second"))
        await fs.symlink(
          path.join(directory, "first"),
          path.join(directory, "docs-link"),
          process.platform === "win32" ? "junction" : "dir",
        )
      }),
  },
)

it.instance("defaultAgent returns build when no default_agent config", () =>
  Effect.gen(function* () {
    const agent = yield* load((svc) => svc.defaultAgent())
    expect(agent).toBe("build")
  }),
)

it.instance("defaultInfo returns resolved build agent when no default_agent config", () =>
  Effect.gen(function* () {
    const agent = yield* load((svc) => svc.defaultInfo())
    expect(agent.name).toBe("build")
    expect(agent.mode).toBe("primary")
  }),
)

it.instance(
  "defaultAgent respects default_agent config set to plan",
  () =>
    Effect.gen(function* () {
      const agent = yield* load((svc) => svc.defaultAgent())
      expect(agent).toBe("plan")
    }),
  {
    trusted: true,
    config: {
      default_agent: "plan",
    },
  },
)

it.instance(
  "defaultAgent respects default_agent config set to custom agent with mode all",
  () =>
    Effect.gen(function* () {
      const agent = yield* load((svc) => svc.defaultAgent())
      expect(agent).toBe("my_custom")
    }),
  {
    trusted: true,
    config: {
      default_agent: "my_custom",
      agent: {
        my_custom: {
          description: "My custom agent",
        },
      },
    },
  },
)

it.instance(
  "defaultAgent throws when default_agent points to subagent",
  () => expectDefaultAgentError('default agent "explore" is a subagent'),
  {
    trusted: true,
    config: {
      default_agent: "explore",
    },
  },
)

it.instance(
  "defaultAgent throws when default_agent points to hidden agent",
  () => expectDefaultAgentError('default agent "compaction" is hidden'),
  {
    trusted: true,
    config: {
      default_agent: "compaction",
    },
  },
)

it.instance(
  "defaultAgent throws when default_agent points to non-existent agent",
  () => expectDefaultAgentError('default agent "does_not_exist" not found'),
  {
    trusted: true,
    config: {
      default_agent: "does_not_exist",
    },
  },
)

it.instance(
  "defaultAgent returns plan when build is disabled and default_agent not set",
  () =>
    Effect.gen(function* () {
      const agent = yield* load((svc) => svc.defaultAgent())
      // build is disabled, so it should return plan (next primary agent)
      expect(agent).toBe("plan")
    }),
  {
    trusted: true,
    config: {
      agent: {
        build: { disable: true },
      },
    },
  },
)

it.instance(
  "defaultAgent throws when all primary agents are disabled",
  () => expectDefaultAgentError("no primary visible agent found"),
  {
    trusted: true,
    config: {
      agent: {
        build: { disable: true },
        plan: { disable: true },
        // Deep research's lead is a primary agent too.
        research: { disable: true },
      },
    },
  },
)
