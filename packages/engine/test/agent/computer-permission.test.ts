import { afterEach, expect } from "bun:test"
import { LayerNode } from "@vectordevai/core/effect/layer-node"
import { PermissionPolicy } from "@vectordevai/schema/permission-policy"
import { Effect } from "effect"
import { disposeAllInstances } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { Agent, computerAsks } from "../../src/agent/agent"
import { Auth } from "../../src/auth"
import { Config } from "../../src/config/config"
import { RuntimeFlags } from "../../src/effect/runtime-flags"
import { Permission } from "../../src/permission"
import { Plugin } from "../../src/plugin"
import { Provider } from "../../src/provider/provider"
import { Skill } from "../../src/skill"

// The computer tool's agent rulesets (E3): every computer permission asks by default, no allow turns one into an
// allow, plan mode only observes, and the quick lane denies them all. The engine's ask path (requiresApproval) makes a
// person answer each one whatever the ruleset says; these tests pin the rulesets themselves.

const it = testEffect(
  LayerNode.compile(
    LayerNode.group([Agent.node, Plugin.node, Provider.node, Auth.node, Config.node, Skill.node, RuntimeFlags.node]),
  ),
)

afterEach(async () => {
  await disposeAllInstances()
})

const COMPUTER = [
  PermissionPolicy.COMPUTER_APP,
  PermissionPolicy.COMPUTER_OBSERVE,
  PermissionPolicy.COMPUTER_INTERACT,
  PermissionPolicy.COMPUTER_SENSITIVE,
]
const APP = "app:macos:com.apple.calculator"
const PATTERNS = ["*", APP, `${APP}:send`]

const get = (name: string) => Agent.Service.use((agents) => agents.get(name))
const action = (agent: Agent.Info, permission: string, pattern = "*") =>
  Permission.evaluate(permission, pattern, agent.permission).action
const offered = (agent: Agent.Info, tool: string) => !Permission.disabled([tool], agent.permission).has(tool)

// Agents that act on the user's behalf with the default ruleset and the user's rules.
const ACTING = ["build", "general", "debug", "test", "performance", "migration"]

it.instance("the defaults ask for all four computer permissions (INV-C5)", () =>
  Effect.gen(function* () {
    for (const name of ACTING) {
      const agent = (yield* get(name))!
      for (const permission of COMPUTER)
        for (const pattern of PATTERNS)
          expect([name, permission, pattern, action(agent, permission, pattern)]).toEqual([
            name,
            permission,
            pattern,
            "ask",
          ])
      expect(offered(agent, "computer")).toBe(true)
    }
    // The defaults block itself, as every agent built from it starts.
    const build = (yield* get("build"))!
    expect(action(build, "browser_sensitive")).toBe("ask")
    expect(action(build, "edit")).toBe("allow")
  }),
)

it.instance(
  "an agent from config starts from the same computer asks",
  () =>
    Effect.gen(function* () {
      const custom = (yield* get("custom"))!
      expect(custom).toBeDefined()
      for (const permission of COMPUTER) expect(action(custom, permission)).toBe("ask")
    }),
  { trusted: true, config: { agent: { custom: { description: "A custom agent" } } } },
)

it.instance("plan mode denies interacting and sensitive computer steps; the app ask stays an ask", () =>
  Effect.gen(function* () {
    const plan = (yield* get("plan"))!
    for (const pattern of PATTERNS) {
      expect(action(plan, PermissionPolicy.COMPUTER_INTERACT, pattern)).toBe("deny")
      expect(action(plan, PermissionPolicy.COMPUTER_SENSITIVE, pattern)).toBe("deny")
      // Raised at observe level only (E6).
      expect(action(plan, PermissionPolicy.COMPUTER_APP, pattern)).toBe("ask")
      expect(action(plan, PermissionPolicy.COMPUTER_OBSERVE, pattern)).toBe("ask")
    }
    // The tool stays offered in plan mode, so the agent can still look.
    expect(offered(plan, "computer")).toBe(true)
  }),
)

it.instance("the quick lane denies every computer permission and the tool", () =>
  Effect.gen(function* () {
    for (const name of ["quick", "autocomplete", "distill"]) {
      const agent = (yield* get(name))!
      for (const permission of COMPUTER)
        expect([name, permission, action(agent, permission)]).toEqual([name, permission, "deny"])
      expect(offered(agent, "computer")).toBe(false)
    }
  }),
)

it.instance(
  "the quick lane denies computer permissions under a global allow",
  () =>
    Effect.gen(function* () {
      const quick = (yield* get("quick"))!
      for (const permission of COMPUTER) expect(action(quick, permission)).toBe("deny")
      expect(offered(quick, "computer")).toBe(false)
    }),
  { trusted: true, config: { permission: { "*": "allow", computer_app: "allow", computer: "allow" } } },
)

it.instance(
  "no allow turns a computer permission into an allow, wildcard or named",
  () =>
    Effect.gen(function* () {
      for (const name of [...ACTING, "custom"]) {
        const agent = (yield* get(name))!
        for (const permission of COMPUTER)
          for (const pattern of PATTERNS)
            expect([name, permission, pattern, action(agent, permission, pattern)]).toEqual([
              name,
              permission,
              pattern,
              "ask",
            ])
      }
      // The allows still apply to everything else.
      const build = (yield* get("build"))!
      expect(action(build, "edit")).toBe("allow")
      expect(action(build, "browser_sensitive")).toBe("allow")
    }),
  {
    trusted: true,
    config: {
      permission: {
        "*": "allow",
        "computer*": "allow",
        computer_app: "allow",
        computer_interact: { [APP]: "allow" },
        computer_sensitive: { [`${APP}:send`]: "allow" },
      },
      agent: {
        build: { permission: { computer_sensitive: "allow", computer_observe: "allow" } },
        custom: { description: "A custom agent", permission: { "*": "allow" } },
      },
    },
  },
)

it.instance(
  "a computer deny still wins, before or after an allow",
  () =>
    Effect.gen(function* () {
      const build = (yield* get("build"))!
      expect(action(build, PermissionPolicy.COMPUTER_SENSITIVE)).toBe("deny")
      expect(action(build, PermissionPolicy.COMPUTER_SENSITIVE, `${APP}:send`)).toBe("deny")
      expect(action(build, PermissionPolicy.COMPUTER_APP, APP)).toBe("deny")
      // Another app is still asked.
      expect(action(build, PermissionPolicy.COMPUTER_APP, "app:macos:com.apple.textedit")).toBe("ask")
      expect(action(build, PermissionPolicy.COMPUTER_INTERACT)).toBe("ask")
    }),
  {
    trusted: true,
    config: {
      permission: {
        "*": "allow",
        computer_sensitive: "deny",
        computer_app: { [APP]: "deny" },
      },
    },
  },
)

it.instance(
  "plan mode stays observe-only under a global allow and the plan agent's own allows",
  () =>
    Effect.gen(function* () {
      const plan = (yield* get("plan"))!
      for (const pattern of PATTERNS) {
        expect(action(plan, PermissionPolicy.COMPUTER_INTERACT, pattern)).toBe("deny")
        expect(action(plan, PermissionPolicy.COMPUTER_SENSITIVE, pattern)).toBe("deny")
        expect(action(plan, PermissionPolicy.COMPUTER_APP, pattern)).toBe("ask")
      }
      expect(offered(plan, "computer")).toBe(true)
      // The user's rules still decide plan mode's other tools.
      expect(action(plan, "edit")).toBe("allow")
    }),
  {
    trusted: true,
    config: {
      permission: { "*": "allow", computer_interact: "allow", computer_sensitive: "allow" },
      agent: {
        plan: {
          permission: { computer_interact: "allow", computer_sensitive: { [`${APP}:send`]: "allow" } },
        },
      },
    },
  },
)

it.instance("agents with their own tool lists get the computer asks only when the list includes computer", () =>
  Effect.gen(function* () {
    expect(computerAsks(["read", "computer"])).toEqual({
      computer_app: "ask",
      computer_observe: "ask",
      computer_interact: "ask",
      computer_sensitive: "ask",
    })
    expect(computerAsks(["read", "browser", "computer_app"])).toEqual({})
    expect(computerAsks([])).toEqual({})
    // No read-only specialist or research agent lists the tool today, so each denies the computer permissions with
    // the rest of what it was not given.
    for (const name of ["explore", "review", "judge", "security", "research", "researcher", "research-judge"]) {
      const agent = (yield* get(name))!
      for (const permission of COMPUTER)
        expect([name, permission, action(agent, permission)]).toEqual([name, permission, "deny"])
      expect(offered(agent, "computer")).toBe(false)
    }
  }),
)
