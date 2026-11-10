export * as ConfigV1 from "./config"

import { Schema } from "effect"
import { NonNegativeInt, PositiveInt, type DeepMutable } from "../../schema"
import { RunBudget } from "@vectordevai/schema/run-budget"
import { TaskSize } from "@vectordevai/schema/task-size"
import { ConfigExperimental } from "../../config/experimental"
import { ConfigReference } from "../../config/reference"
import { ConfigAgentV1 } from "./agent"
import { ConfigAttachmentV1 } from "./attachment"
import { ConfigCommandV1 } from "./command"
import { ConfigFormatterV1 } from "./formatter"
import { ConfigLayoutV1 } from "./layout"
import { ConfigLocalV1 } from "./local"
import { ConfigLSPV1 } from "./lsp"
import { ConfigMCPV1 } from "./mcp"
import { ConfigPermissionV1 } from "./permission"
import { ConfigPluginV1 } from "./plugin"
import { ConfigProviderV1 } from "./provider"
import { ConfigResearchV1 } from "./research"
import { ConfigServerV1 } from "./server"
import { ConfigSkillsV1 } from "./skills"

export type Layout = ConfigLayoutV1.Layout

export const WellKnown = Schema.Struct({
  config: Schema.optional(Schema.Json),
  remote_config: Schema.optional(Schema.Json),
})

const LogLevelRef = Schema.Literals(["DEBUG", "INFO", "WARN", "ERROR"]).annotate({
  identifier: "LogLevel",
  description: "Log level",
})

// Defaults of the subagent and workflow limits, by config key. A repository's value only narrows them (the engine's
// projectExecutableConfig), and the runtime limits start from them.
export const SubagentDefaults = { running: 8, per_request: 32, usd: 25 } as const
export const WorkflowDefaults = {
  max_agents: 100,
  concurrency: 16,
  // steps defaults to max_agents times this.
  steps_per_agent: 40,
  per_agent_steps: 60,
  minutes: 120,
  runs: 1,
} as const

const between = (minimum: number, maximum: number) => Schema.Int.check(Schema.isBetween({ minimum, maximum }))

const BudgetSubagents = Schema.Struct({
  ...RunBudget.Info.fields,
  running: Schema.optional(between(1, 16)).annotate({
    description: "Subagents that run at once in one conversation; the rest wait for a free slot (default: 8)",
  }),
  per_request: Schema.optional(between(1, 1000)).annotate({
    description: "New subagents one request may start, at any depth (default: 32)",
  }),
})

const BudgetWorkflow = Schema.Struct({
  max_agents: Schema.optional(between(1, 1000)).annotate({ description: "Agents one run may start (default: 100)" }),
  concurrency: Schema.optional(between(1, 16)).annotate({
    description: "Agents of one run working at once, also bounded by this computer's processors (default: 16)",
  }),
  usd: Schema.optional(Schema.Finite.check(Schema.isGreaterThan(0))).annotate({
    description: "Spend ceiling of one run at catalog prices (default: none; the subagent ceiling still applies)",
  }),
  tokens: Schema.optional(PositiveInt).annotate({ description: "Tokens one run may use (default: none)" }),
  steps: Schema.optional(PositiveInt).annotate({ description: "Model steps of one run (default: 40 per agent)" }),
  per_agent_steps: Schema.optional(PositiveInt).annotate({ description: "Model steps of one agent (default: 60)" }),
  minutes: Schema.optional(between(1, 1440)).annotate({ description: "Minutes one run may take (default: 120)" }),
  runs: Schema.optional(between(1, 4)).annotate({
    description: "Workflow runs at once in one conversation (default: 1)",
  }),
})

const SizingSubagents = Schema.Struct({
  fork: Schema.optional(Schema.Boolean).annotate({
    description: "Let the agent start subagents from its whole conversation, sharing its prompt cache (default: true)",
  }),
  models: Schema.optional(Schema.mutable(Schema.Array(Schema.String)).check(Schema.isMaxLength(32))).annotate({
    description:
      'Models a subagent may be given that cost more than the agent\'s own or run on another provider: "provider/model" entries. "provider/*" and "*" only widen which providers count; the cost rule still applies.',
  }),
  ask_timeout: Schema.optional(between(1, 1440)).annotate({
    description:
      "Minutes a subagent's permission request or question waits for you before it is declined, never approved (default: it waits)",
  }),
  isolation: Schema.optional(
    Schema.Struct({
      lsp: Schema.optional(Schema.Boolean).annotate({
        description: "Start language servers in a subagent's own worktree (default: false)",
      }),
      mcp: Schema.optional(Schema.Boolean).annotate({
        description: "Start local MCP servers in a subagent's own worktree (default: false)",
      }),
      link: Schema.optional(Schema.mutable(Schema.Array(Schema.String)).check(Schema.isMaxLength(16))).annotate({
        description: "Git-ignored directories, such as node_modules, linked into a subagent's own worktree",
      }),
      max_kept: Schema.optional(between(1, 200)).annotate({
        description: "Changed worktrees kept waiting for your review (default: 20)",
      }),
    }),
  ).annotate({ description: "Worktrees of subagents launched with isolation" }),
})

export const Info = Schema.Struct({
  $schema: Schema.optional(Schema.String).annotate({
    description: "JSON schema reference for configuration validation",
  }),
  shell: Schema.optional(Schema.String).annotate({ description: "Default shell to use for terminal and bash tool" }),
  logLevel: Schema.optional(LogLevelRef).annotate({ description: "Log level" }),
  server: Schema.optional(ConfigServerV1.Server).annotate({
    description: "Server configuration for vector serve and web commands",
  }),
  command: Schema.optional(Schema.Record(Schema.String, ConfigCommandV1.Info)).annotate({
    description: "Command configuration, see https://vectordev.ai/docs/commands",
  }),
  skills: Schema.optional(ConfigSkillsV1.Info).annotate({ description: "Additional skill folder paths" }),
  references: Schema.optional(ConfigReference.Info).annotate({
    description: "Named git or local directory references",
  }),
  reference: Schema.optional(ConfigReference.Info).annotate({
    description: "@deprecated Use 'references' field instead. Named git or local directory references",
  }),
  watcher: Schema.optional(Schema.Struct({ ignore: Schema.optional(Schema.mutable(Schema.Array(Schema.String))) })),
  snapshot: Schema.optional(Schema.Boolean).annotate({
    description:
      "Enable or disable snapshot tracking. When false, filesystem snapshots are not recorded and undoing or reverting will not undo/redo file changes. Defaults to true.",
  }),
  plugin: Schema.optional(Schema.mutable(Schema.Array(ConfigPluginV1.Spec))),
  share: Schema.optional(Schema.Literals(["manual", "auto", "disabled"])).annotate({
    description: "Public session sharing is unavailable in Vector; this setting is ignored.",
  }),
  autoshare: Schema.optional(Schema.Boolean).annotate({
    description: "@deprecated Public session sharing is unavailable in Vector; this setting is ignored.",
  }),
  autoupdate: Schema.optional(Schema.Union([Schema.Boolean, Schema.Literal("notify")])).annotate({
    description:
      "Automatically update to the latest version. Set to true to auto-update, false to disable, or 'notify' to show update notifications",
  }),
  disabled_providers: Schema.optional(Schema.mutable(Schema.Array(Schema.String))).annotate({
    description: "Disable providers that are loaded automatically",
  }),
  enabled_providers: Schema.optional(Schema.mutable(Schema.Array(Schema.String))).annotate({
    description: "When set, ONLY these providers will be enabled. All other providers will be ignored",
  }),
  model: Schema.optional(Schema.String).annotate({
    description: "Model to use in the format of provider/model, eg anthropic/claude-2",
  }),
  small_model: Schema.optional(Schema.String).annotate({
    description: "Small model to use for tasks like title generation in the format of provider/model",
  }),
  default_agent: Schema.optional(Schema.String).annotate({
    description:
      "Default agent to use when none is specified. Must be a primary agent. Falls back to 'build' if not set or if the specified agent is invalid.",
  }),
  username: Schema.optional(Schema.String).annotate({
    description: "Custom username to display in conversations instead of system username",
  }),
  mode: Schema.optional(
    Schema.StructWithRest(
      Schema.Struct({ build: Schema.optional(ConfigAgentV1.Info), plan: Schema.optional(ConfigAgentV1.Info) }),
      [Schema.Record(Schema.String, ConfigAgentV1.Info)],
    ),
  ).annotate({ description: "@deprecated Use `agent` field instead." }),
  agent: Schema.optional(
    Schema.StructWithRest(
      Schema.Struct({
        plan: Schema.optional(ConfigAgentV1.Info),
        build: Schema.optional(ConfigAgentV1.Info),
        general: Schema.optional(ConfigAgentV1.Info),
        explore: Schema.optional(ConfigAgentV1.Info),
        title: Schema.optional(ConfigAgentV1.Info),
        summary: Schema.optional(ConfigAgentV1.Info),
        compaction: Schema.optional(ConfigAgentV1.Info),
      }),
      [Schema.Record(Schema.String, ConfigAgentV1.Info)],
    ),
  ).annotate({ description: "Agent configuration, see https://vectordev.ai/docs/custom-agents" }),
  provider: Schema.optional(Schema.Record(Schema.String, ConfigProviderV1.Info)).annotate({
    description: "Custom provider configurations and model overrides",
  }),
  mcp: Schema.optional(
    Schema.Record(Schema.String, Schema.Union([ConfigMCPV1.Info, Schema.Struct({ enabled: Schema.Boolean })])),
  ).annotate({ description: "MCP (Model Context Protocol) server configurations" }),
  formatter: Schema.optional(ConfigFormatterV1.Info).annotate({
    description:
      "Enable or configure formatters. Omit or set to false to disable, true to enable built-ins, or an object to enable built-ins with overrides.",
  }),
  lsp: Schema.optional(ConfigLSPV1.Info).annotate({
    description:
      "Enable or configure LSP servers. Omit or set to false to disable, true to enable built-ins, or an object to enable built-ins with overrides.",
  }),
  instructions: Schema.optional(Schema.mutable(Schema.Array(Schema.String))).annotate({
    description: "Additional instruction files or patterns to include",
  }),
  layout: Schema.optional(ConfigLayoutV1.Layout).annotate({ description: "@deprecated Always uses stretch layout." }),
  permission: Schema.optional(ConfigPermissionV1.Info),
  tools: Schema.optional(Schema.Record(Schema.String, Schema.Boolean)),
  attachment: Schema.optional(ConfigAttachmentV1.Info).annotate({
    description: "Attachment processing configuration, including image size limits and resizing behavior",
  }),
  enterprise: Schema.optional(
    Schema.Struct({ url: Schema.optional(Schema.String).annotate({ description: "Enterprise URL" }) }),
  ),
  tool_output: Schema.optional(
    Schema.Struct({
      max_lines: Schema.optional(PositiveInt).annotate({
        description: "Maximum lines of tool output before it is truncated and saved to disk (default: 2000)",
      }),
      max_bytes: Schema.optional(PositiveInt).annotate({
        description: "Maximum bytes of tool output before it is truncated and saved to disk (default: 51200)",
      }),
    }),
  ).annotate({
    description:
      "Thresholds for truncating tool output. When output exceeds either limit, the full text is written to the truncation directory and a preview is returned.",
  }),
  compaction: Schema.optional(
    Schema.Struct({
      auto: Schema.optional(Schema.Boolean).annotate({
        description: "Enable automatic compaction when context is full (default: true)",
      }),
      prune: Schema.optional(Schema.Boolean).annotate({
        description:
          "Clear old tool outputs when a prompt arrives after the provider's prompt cache has expired, when the history is re-sent at full price anyway (default: true)",
      }),
      tail_turns: Schema.optional(NonNegativeInt).annotate({
        description:
          "Number of recent user turns, including their following assistant/tool responses, to keep verbatim during compaction (default: 2)",
      }),
      preserve_recent_tokens: Schema.optional(NonNegativeInt).annotate({
        description: "Maximum number of tokens from recent turns to preserve verbatim after compaction",
      }),
      reserved: Schema.optional(NonNegativeInt).annotate({
        description: "Token buffer for compaction. Leaves enough window to avoid overflow during compaction.",
      }),
      max_context: Schema.optional(NonNegativeInt).annotate({
        description:
          "Compact once the conversation reaches this many tokens, even when the model's window is larger. Every request re-sends the whole conversation, so a smaller context costs less per step. Defaults to just below a model's long-context price tier, and to 200000 for models with a window of 500000 or more and no tier; 0 uses the model's whole window.",
      }),
      clear: Schema.optional(Schema.Boolean).annotate({
        description:
          "During a long run, clear old tool outputs once the context passes 60000 tokens and at least 40000 tokens of older output can go (default: false)",
      }),
    }),
  ),
  budget: Schema.optional(
    Schema.Struct({
      run: Schema.optional(RunBudget.Info),
      loop: Schema.optional(
        Schema.Struct({
          enabled: Schema.optional(Schema.Boolean).annotate({
            description: "Stop runs that repeat the same tool call or error (default: true)",
          }),
        }),
      ),
      subagents: Schema.optional(BudgetSubagents).annotate({
        description:
          "Limits for the subagents one request starts: how many run at once in a conversation (running), how many one request may start (per_request), and the spend ceiling they share (usd, default 25 at catalog prices; only priced and unknown steps count toward it). A repository may only lower running and per_request, and its usd is ignored.",
      }),
      workflow: Schema.optional(BudgetWorkflow).annotate({
        description: "Ceilings of a workflow run. A repository may only lower them.",
      }),
    }),
  ).annotate({
    description:
      "Spend and runaway limits. run applies to every run in every repository: set it in your user config, because a repository's own budget.run is ignored. A prompt's own budget overrides run.",
  }),
  sizing: Schema.optional(
    Schema.Struct({
      auto: Schema.optional(Schema.Boolean).annotate({
        description:
          "Size each request, so a greeting gets a direct reply and a small action is done directly: Work and Thorough requests may hand work to subagents; Light and Chat do not (default: true). false gives every request the full harness.",
      }),
      judge: Schema.optional(TaskSize.JudgeMode).annotate({
        description:
          "When Vector runs LLM-as-a-judge after a run that changed files: off, thorough (large tasks only) or changes (every task that changed files). Default: off for those runs. A prompt's own judge setting overrides it. Deep research's citation judge reads it too, and runs when it is unset: unset or thorough checks Deep reports and Focused ones that cite 8 or more notes, changes checks every report, and off turns it off.",
      }),
      learn: Schema.optional(Schema.Boolean).annotate({
        description:
          "Use learned workflow defaults when you leave effort on Default: drop Thorough's extra effort, skip subagents or give them a cheaper model, only where this repository's checked runs passed as often for less (default: true). false keeps the size's defaults. Your own picks always win, and spend caps are unchanged.",
      }),
      subagents: Schema.optional(SizingSubagents).annotate({
        description:
          "How subagents run: forks, per-call models, how long a helper's unanswered request waits, and worktree isolation. Read from your user config; a repository may only turn forks off, narrow models and shorten your ask_timeout.",
      }),
    }),
  ).annotate({ description: "Task sizing: how much harness, reasoning and verification each request gets." }),
  local: Schema.optional(ConfigLocalV1.Info).annotate({
    description:
      "Vector Local: run Vector's AI features only on model servers you or your company host. Read from your user config and your company's managed config, never a repository's.",
  }),
  research: Schema.optional(ConfigResearchV1.Info).annotate({
    description:
      "Deep research (preview): when the build agent may research as a tool, what one run may spend and read, the sites it prefers or avoids, and robots.txt. Research searches the web in each research agent's own browser in the desktop app; there is no search service to set up. depth and retain_days do not apply yet. Read from your user config; a repository's config may only add sites to avoid and turn the research tool down.",
  }),
  experimental: Schema.optional(
    Schema.Struct({
      disable_paste_summary: Schema.optional(Schema.Boolean),
      batch_tool: Schema.optional(Schema.Boolean).annotate({ description: "Enable the batch tool" }),
      openTelemetry: Schema.optional(Schema.Boolean).annotate({
        description: "Enable OpenTelemetry spans for AI SDK calls (using the 'experimental_telemetry' flag)",
      }),
      primary_tools: Schema.optional(Schema.mutable(Schema.Array(Schema.String))).annotate({
        description: "Tools that should only be available to primary agents.",
      }),
      continue_loop_on_deny: Schema.optional(Schema.Boolean).annotate({
        description: "Continue the agent loop when a tool call is denied",
      }),
      mcp_timeout: Schema.optional(PositiveInt).annotate({
        description: "Timeout in milliseconds for model context protocol (MCP) requests",
      }),
      policies: Schema.optional(Schema.mutable(Schema.Array(ConfigExperimental.Policy))).annotate({
        description: "Policy statements applied to supported resources, such as provider access",
      }),
    }),
  ),
}).annotate({ identifier: "Config" })

export type Info = DeepMutable<Schema.Schema.Type<typeof Info>>
