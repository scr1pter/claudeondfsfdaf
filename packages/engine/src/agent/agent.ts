import { LayerNode } from "@vectordevai/core/effect/layer-node"
import { PermissionV1 } from "@vectordevai/core/v1/permission"
import { Config } from "@/config/config"
import { serviceUse } from "@vectordevai/core/effect/service-use"
import { Provider } from "@/provider/provider"

import { generateObject, streamObject, type ModelMessage } from "ai"
import { Truncate } from "@/tool/truncate"
import { Auth } from "../auth"
import { ProviderTransform } from "@/provider/transform"

import PROMPT_GENERATE from "./generate.txt"
import PROMPT_COMPACTION from "./prompt/compaction.txt"
import PROMPT_DEBUG from "./prompt/debug.txt"
import PROMPT_DISTILL from "./prompt/distill.txt"
import PROMPT_EXPLORE from "./prompt/explore.txt"
import PROMPT_GENERAL from "./prompt/general.txt"
import PROMPT_JUDGE from "./prompt/judge.txt"
import PROMPT_MIGRATION from "./prompt/migration.txt"
import PROMPT_PERFORMANCE from "./prompt/performance.txt"
import PROMPT_RESEARCH from "./prompt/research.txt"
import PROMPT_RESEARCH_JUDGE from "./prompt/research-judge.txt"
import PROMPT_RESEARCHER from "./prompt/researcher.txt"
import PROMPT_REVIEW from "./prompt/review.txt"
import PROMPT_SECURITY from "./prompt/security.txt"
import PROMPT_SUMMARY from "./prompt/summary.txt"
import PROMPT_TEST from "./prompt/test.txt"
import PROMPT_TITLE from "./prompt/title.txt"
import { Permission } from "@/permission"
import { Wildcard } from "@vectordevai/core/util/wildcard"
import { mergeDeep, pipe, sortBy, values } from "remeda"
import { Global } from "@vectordevai/core/global"
import path from "path"
import { Plugin } from "@/plugin"
import { Skill } from "../skill"
import { Effect, Context, Layer, Schema } from "effect"
import { InstanceState } from "@/effect/instance-state"
import * as Option from "effect/Option"
import { AbsolutePath, type DeepMutable } from "@vectordevai/core/schema"
import { ProviderV2 } from "@vectordevai/core/provider"
import { ModelV2 } from "@vectordevai/core/model"
import { LocationServiceMap, locationServiceMapLayer } from "@vectordevai/core/location-services"
import { Reference } from "@vectordevai/core/reference"
import { Location } from "@vectordevai/core/location"
import { PluginV2 } from "@vectordevai/core/plugin"
import { FSUtil } from "@vectordevai/core/fs-util"
import { isNativeSpecialist } from "@vectordevai/core/agent/specialists"

export const Info = Schema.Struct({
  name: Schema.String,
  description: Schema.optional(Schema.String),
  mode: Schema.Literals(["subagent", "primary", "all"]),
  native: Schema.optional(Schema.Boolean),
  hidden: Schema.optional(Schema.Boolean),
  topP: Schema.optional(Schema.Finite),
  temperature: Schema.optional(Schema.Finite),
  color: Schema.optional(Schema.String),
  permission: PermissionV1.Ruleset,
  model: Schema.optional(
    Schema.Struct({
      modelID: ModelV2.ID,
      providerID: ProviderV2.ID,
    }),
  ),
  variant: Schema.optional(Schema.String),
  prompt: Schema.optional(Schema.String),
  options: Schema.Record(Schema.String, Schema.Unknown),
  steps: Schema.optional(Schema.Finite),
}).annotate({ identifier: "Agent" })
export type Info = DeepMutable<Schema.Schema.Type<typeof Info>>

// Permissions whose Vector Cloud actions publish, change a database, write a
// host's environment or change hosting settings (projects, protection and
// domains). Keep agent defaults explicit; the runtime permission boundary also
// requires a fresh decision when a configured rule allows one of these actions.
const CLOUD_MUTATIONS = [
  "vector_cloud_publish",
  "vector_cloud_database",
  "vector_cloud_environment",
  "vector_cloud_hosting",
]

// Deep research's agents (section 5.3): the lead, its web workers and the judge that checks the lead's citations.
export const RESEARCH = "research"
export const RESEARCHER = "researcher"
export const RESEARCH_JUDGE = "research-judge"
const RESEARCH_AGENTS: Record<string, { readonly tools: readonly string[]; readonly subagents: readonly string[] }> = {
  // The lead plans, searches, reads, notes and writes the report. It reads the repository and the brain, and the
  // user's visible browser only to hand a sign-in or a paywall to the user. It delegates to its researchers alone; the
  // judge is launched by Vector when a report is checked.
  [RESEARCH]: {
    tools: [
      "research_plan",
      "research_search",
      "research_read",
      "research_browser",
      "research_note",
      "research_report",
      "memory",
      "question",
      "read",
      "grep",
      "glob",
      "list",
      "browser",
      "task",
    ],
    subagents: [RESEARCHER, RESEARCH_JUDGE],
  },
  // A web worker answers one sub-question from the web. It sees no repository file, no memory tool and not the user's
  // own browser, since what it sends (queries and addresses) leaves the machine.
  [RESEARCHER]: { tools: ["research_search", "research_read", "research_browser", "research_note"], subagents: [] },
  // The judge gets the cited passages in its brief and answers in plain lines.
  [RESEARCH_JUDGE]: { tools: [], subagents: [] },
}
/** The tools a research agent may be offered at all, whatever any rule allows; nothing for any other agent. */
export function researchTools(agent: string): readonly string[] | undefined {
  return RESEARCH_AGENTS[agent]?.tools
}
// Coding and outside tools no user or repository rule may hand a research agent. They are denied last.
const RESEARCH_DENIED = [
  "edit",
  "write",
  "apply_patch",
  "bash",
  "todowrite",
  "plan_enter",
  "plan_exit",
  "vector_cloud*",
  "webfetch",
  "websearch",
  "skill",
  "escalate",
  "terminal",
  "terminal_input",
]

const GeneratedAgent = Schema.Struct({
  identifier: Schema.String,
  whenToUse: Schema.String,
  systemPrompt: Schema.String,
})

export interface Interface {
  readonly get: (agent: string) => Effect.Effect<Info>
  /**
   * The agent one of Vector's helper sessions (`internal` set, such as a Vectorscope reviewer) runs as. A Subagent
   * specialist turned off in Settings leaves `get` and `list`, so the user, the task tool and the @ list no longer
   * reach it, but the helpers that run as one keep it: only this finds it, so every lookup of a helper session's agent
   * goes through here.
   */
  readonly helper: (agent: string) => Effect.Effect<Info>
  readonly list: () => Effect.Effect<Info[]>
  readonly defaultInfo: () => Effect.Effect<Info>
  readonly defaultAgent: () => Effect.Effect<string>
  readonly generate: (input: {
    description: string
    model?: { providerID: ProviderV2.ID; modelID: ModelV2.ID }
  }) => Effect.Effect<
    {
      identifier: string
      whenToUse: string
      systemPrompt: string
    },
    Provider.DefaultModelError
  >
}

type State = Omit<Interface, "generate">

export class Service extends Context.Service<Service, Interface>()("@vector/Agent") {}

export const use = serviceUse(Service)

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const config = yield* Config.Service
    const auth = yield* Auth.Service
    const plugin = yield* Plugin.Service
    const skill = yield* Skill.Service
    const provider = yield* Provider.Service
    const locations = yield* LocationServiceMap.Service

    const state = yield* InstanceState.make<State>(
      Effect.fn("Agent.state")(function* (ctx) {
        const cfg = yield* config.get()
        const skillDirs = yield* skill.dirs()
        const referenceDirs = yield* Effect.gen(function* () {
          yield* (yield* PluginV2.Service).wait(PluginV2.ID.make("core/config-reference"))
          return (yield* (yield* Reference.Service).list()).map((reference) => reference.path)
        }).pipe(Effect.provide(locations.get(Location.Ref.make({ directory: AbsolutePath.make(ctx.directory) }))))
        const directoryKey = (pattern: string) =>
          process.platform === "win32" ? pattern.replaceAll("\\", "/").toLowerCase() : pattern
        const directoryAliases = new Map(
          [
            [path.join(Global.Path.data, "tool-output", "*"), Truncate.GLOB],
            ...[
              path.join(Global.Path.tmp, "*"),
              ...skillDirs.map((dir) => path.join(dir, "*")),
              ...referenceDirs.map((dir) => path.join(dir, "*")),
            ].map((pattern) => [pattern, FSUtil.normalizePathPattern(pattern)] as const),
          ].map(([source, target]) => [directoryKey(source), target]),
        )
        const whitelistedDirs = Array.from(directoryAliases.values())
        const builtInDeny = (pattern: string) => {
          const known = directoryAliases.get(directoryKey(pattern))
          if (known || process.platform !== "win32") return known
          const match = pattern.match(/^(.*)[\\/]\*$/)
          if (!match || /[*?\[]/.test(match[1])) return
          // The final output directory may not exist yet; resolve only its already-created private parent.
          const directory =
            path.basename(match[1]).toLowerCase() === "tool-output"
              ? path.join(FSUtil.normalizePath(path.dirname(match[1])), "tool-output")
              : FSUtil.normalizePath(match[1])
          return whitelistedDirs.find((root) => directoryKey(root) === directoryKey(path.join(directory, "*")))
        }
        const readonlyExternalDirectory = {
          "*": "ask",
          ...Object.fromEntries(whitelistedDirs.map((dir) => [dir, "allow"])),
        } satisfies Record<string, "allow" | "ask" | "deny">

        // mirrors github.com/github/gitignore Node.gitignore pattern for .env files
        const readDefaults = {
          "*": "allow",
          "*.env": "ask",
          "*.env.*": "ask",
          "*.env.example": "allow",
          "*.key": "ask",
          "*.pem": "ask",
          ".aws/*": "ask",
          "**/.aws/*": "ask",
          ".docker/config.json": "ask",
          "**/.docker/config.json": "ask",
          ".kube/*": "ask",
          "**/.kube/*": "ask",
          ".ssh/*": "ask",
          "**/.ssh/*": "ask",
        } satisfies Record<string, "allow" | "ask" | "deny">

        const defaults = Permission.fromConfig({
          "*": "allow",
          doom_loop: "ask",
          unsandboxed_shell: "ask",
          // Terminals the agent did not open (the user's, or another session's) ask before the agent types into,
          // resizes or closes them. Reading any terminal asks nothing, and a submitted line also goes through the
          // shell's own rules.
          terminal: { "*": "allow", "other:*": "ask" },
          terminal_input: { "*": "allow", "other:*": "ask" },
          browser_external: "ask",
          browser_interact: "ask",
          browser_sensitive: "ask",
          webfetch: "ask",
          private_network: "ask",
          websearch: "ask",
          // With Vector Local on, a shell command that may reach the network asks first (tool/shell.ts).
          network_command: "ask",
          // Vector Cloud actions that publish, change a database or write a
          // host's environment act on the user's own accounts and may bill them.
          vector_cloud_publish: "ask",
          vector_cloud_database: "ask",
          vector_cloud_environment: "ask",
          vector_cloud_hosting: "ask",
          external_directory: {
            "*": "ask",
            ...Object.fromEntries(whitelistedDirs.map((dir) => [dir, "allow"])),
          },
          question: "deny",
          plan_enter: "deny",
          plan_exit: "deny",
          read: readDefaults,
        })

        const user = Permission.fromConfig(cfg.permission ?? {})
        const readonlyVerificationBash = {
          "*": "deny",
          "git diff*": "allow",
          "git status*": "allow",
          "git show*": "allow",
          "git log*": "allow",
          "gh pr view*": "allow",
          "gh pr diff*": "allow",
          "gh pr review*": "ask",
          // Test and build entrypoints execute repository-controlled code. A read-only specialist may run them only
          // after an explicit approval; the shell sandbox remains a second boundary after approval.
          "bun test*": "ask",
          "bun typecheck*": "ask",
          "bun run test*": "ask",
          "bun run build*": "ask",
          "npm test*": "ask",
          "npm run test*": "ask",
          "npm run build*": "ask",
          "pnpm test*": "ask",
          "pnpm run test*": "ask",
          "pnpm run build*": "ask",
          "pytest*": "ask",
          "cargo test*": "ask",
          "go test*": "ask",
        } as const
        // Flags that make an allowed command write a chosen file, run another program, or read any file without the
        // read tool's asks (`git diff --no-index .env README.md`). They come after every other rule, so no ask or
        // allow can reopen them.
        const readonlyBashDenies = {
          "git difftool*": "deny",
          "*--output*": "deny",
          "*--no-index*": "deny",
          "*--ext-diff*": "deny",
          "*--extcmd*": "deny",
          "*--basetemp*": "deny",
          "*--junit*": "deny",
          "*outfile*": "deny",
          "* -o*": "deny",
          "go test*profile*": "deny",
        } as const
        // explore, review, judge and security may search, read, use their web tool, run the verification commands and
        // be asked about external reads. User and repository rules can only narrow that: a deny applies anywhere, an
        // ask or allow only within what the specialist already has. Otherwise a blanket allow after the user's rules
        // would skip their denies and the default asks for secret files, and a checked-in config could hand a
        // read-only child MCP tools or edits behind the parent's back.
        const readonlySpecialists: Record<string, string[]> = {
          explore: ["webfetch", "websearch"],
          review: ["webfetch", "websearch"],
          judge: ["browser"],
          security: ["webfetch", "websearch"],
        }
        const verificationCommands = Object.entries(readonlyVerificationBash)
          .filter((entry) => entry[1] !== "deny")
          .map((entry) => entry[0])
        const readonlySpecialist = (name: string, rules: PermissionV1.Rule[]) => {
          const tools = ["grep", "glob", "list", "read", ...readonlySpecialists[name]]
          return Permission.merge(
            defaults,
            Permission.fromConfig({
              "*": "deny",
              ...Object.fromEntries(tools.map((tool) => [tool, "allow" as const])),
              read: readDefaults,
              bash: readonlyVerificationBash,
              external_directory: readonlyExternalDirectory,
            }),
            rules.flatMap((rule) => narrow(rule, tools, verificationCommands)),
            Permission.fromConfig({ bash: readonlyBashDenies }),
          )
        }
        // The research agents follow the same pattern (RC1): user and repository rules only narrow within the agent's
        // own tools and subagents, and the coding tools are denied last, so a global `bash: allow`, `edit: allow` or
        // `"*": "allow"` reopens nothing. Plan mode's merge order would let them. research_read asks once per run (the
        // tool scopes it to the run and never saves it), and an address on the user's own network asks per origin.
        const researchAgent = (name: string, rules: PermissionV1.Rule[]) => {
          const tools = [...RESEARCH_AGENTS[name].tools]
          const subagents = [...RESEARCH_AGENTS[name].subagents]
          const reads = tools.includes("read")
          const browses = tools.includes("browser")
          // A blanket read allow ("*": "allow", `read: allow`) lands after the read defaults, so secret files would
          // stop asking. Their asks follow each such allow again, except for a path one of the rules names itself.
          const blanket = (pattern: string) => /^[*/]*$/.test(pattern)
          const secrets = Permission.fromConfig({
            read: Object.fromEntries(
              Object.entries(readDefaults).filter(
                ([pattern]) =>
                  pattern !== "*" &&
                  !rules.some(
                    (rule) =>
                      rule.permission === "read" &&
                      !blanket(rule.pattern) &&
                      (Wildcard.match(rule.pattern, pattern) || Wildcard.match(pattern, rule.pattern)),
                  ),
              ),
            ),
          })
          return Permission.merge(
            defaults,
            Permission.fromConfig({
              "*": "deny",
              ...Object.fromEntries(tools.map((tool) => [tool, "allow" as const])),
              ...(tools.includes("research_read")
                ? { research_read: "ask" as const, private_network: "ask" as const }
                : {}),
              ...(reads ? { read: readDefaults, external_directory: readonlyExternalDirectory } : {}),
              ...(browses
                ? {
                    browser_external: "ask" as const,
                    browser_interact: "ask" as const,
                    browser_sensitive: "ask" as const,
                  }
                : {}),
              ...(subagents.length
                ? {
                    task: {
                      "*": "deny" as const,
                      ...Object.fromEntries(subagents.map((item) => [item, "allow" as const])),
                    },
                  }
                : {}),
            }),
            // The run's first read asks however broad an allow is ("*", "research_*"): only a rule for research_read
            // itself answers it.
            rules.flatMap((rule) =>
              narrow(rule, tools, [], { subagents, external: reads })
                .filter(
                  (item) =>
                    item.permission !== "research_read" ||
                    item.action !== "allow" ||
                    rule.permission === "research_read",
                )
                .flatMap((item) =>
                  reads && item.permission === "read" && item.action === "allow" && blanket(item.pattern)
                    ? [item, ...secrets]
                    : [item],
                ),
            ),
            Permission.fromConfig({
              ...Object.fromEntries(RESEARCH_DENIED.map((tool) => [tool, "deny" as const])),
              // MCP resources are read under `read` with an `mcp:` pattern; the lead, which reads files, reads none.
              ...(reads ? { read: { "mcp:*": "deny" as const } } : {}),
            }),
          )
        }

        const agents: Record<string, Info> = {
          build: {
            name: "build",
            description: "The default agent. Executes tools based on configured permissions.",
            options: {},
            permission: Permission.merge(
              defaults,
              Permission.fromConfig({
                question: "allow",
                plan_enter: "allow",
              }),
              user,
            ),
            mode: "primary",
            native: true,
          },
          plan: {
            name: "plan",
            description: "Plan mode. Disallows all edit tools.",
            options: {},
            permission: Permission.merge(
              defaults,
              Permission.fromConfig({
                question: "allow",
                plan_exit: "allow",
                task: {
                  general: "deny",
                  debug: "deny",
                  judge: "deny",
                  migration: "deny",
                  performance: "deny",
                  test: "deny",
                },
                external_directory: {
                  [path.join(Global.Path.data, "plans", "*")]: "allow",
                },
                edit: {
                  "*": "deny",
                  [path.join(".vector", "plans", "*.md")]: "allow",
                  [path.relative(ctx.worktree, path.join(Global.Path.data, path.join("plans", "*.md")))]: "allow",
                },
              }),
              user,
              // After the user's rules: plan mode never types into a terminal, whatever they allow.
              Permission.fromConfig({ terminal_input: "deny" }),
            ),
            mode: "primary",
            native: true,
          },
          quick: {
            name: "quick",
            description:
              "A lightweight conversational lane for greetings and acknowledgements that does not load engineering tools.",
            prompt:
              "Respond briefly and naturally. This lane is only for conversation, greetings, acknowledgements, and other requests that require no project inspection or tool use. Identify yourself as Vector when relevant.",
            options: {},
            permission: Permission.merge(defaults, user, Permission.fromConfig({ "*": "deny" })),
            mode: "primary",
            native: true,
            hidden: true,
          },
          // Editor ghost text. It runs on the quick lane: the last request only, no tools, no project context.
          autocomplete: {
            name: "autocomplete",
            description: "Inline code completion for the editor.",
            prompt:
              "You are Vector Tab, an inline code completion engine. Continue the code exactly at the cursor. Return only the code to insert: no explanation, no markdown, and no repeated surrounding code. Prefer the smallest useful completion, from the rest of the current line up to one short coherent block.",
            options: {},
            permission: Permission.merge(defaults, user, Permission.fromConfig({ "*": "deny" })),
            mode: "primary",
            native: true,
            hidden: true,
          },
          general: {
            name: "general",
            description: `General-purpose agent for researching complex questions and executing multi-step tasks.`,
            permission: Permission.merge(
              defaults,
              Permission.fromConfig({
                todowrite: "deny",
              }),
              user,
            ),
            // Its own prompt replaces the main agent's provider prompt, as for every specialist: that prompt's
            // TodoWrite, task-tool and user-facing guidance is for tools and a user this agent does not have.
            prompt: PROMPT_GENERAL,
            options: {},
            mode: "subagent",
            native: true,
          },
          explore: {
            name: "explore",
            permission: readonlySpecialist("explore", user),
            description: `Fast read-only agent for broad codebase searches across several areas or naming conventions, whose raw output would flood your context (eg. "how do API endpoints work?"). For one pattern, symbol or known file, use Glob, Grep or Read yourself. Say how thorough to be: "quick", "medium" or "very thorough".`,
            prompt: PROMPT_EXPLORE,
            options: {},
            mode: "subagent",
            native: true,
          },
          review: {
            name: "review",
            permission: readonlySpecialist("review", user),
            description:
              "Read-only senior code reviewer. Use this to inspect a diff or implementation for correctness, regressions, missing tests, maintainability, and security issues without changing files.",
            prompt: PROMPT_REVIEW,
            options: {},
            mode: "subagent",
            native: true,
          },
          judge: {
            name: "judge",
            permission: readonlySpecialist("judge", user),
            description:
              "Independent completion judge. Scores requirement coverage, correctness, regression safety, evidence, and security, then returns PASS, FAIL, or INCONCLUSIVE without editing files.",
            prompt: PROMPT_JUDGE,
            options: {},
            mode: "subagent",
            native: true,
          },
          debug: {
            name: "debug",
            permission: Permission.merge(
              defaults,
              Permission.fromConfig({
                todowrite: "deny",
              }),
              user,
            ),
            description:
              "Debugging specialist that reproduces failures, isolates root causes, applies focused repairs, and verifies the fix with targeted checks.",
            prompt: PROMPT_DEBUG,
            options: {},
            mode: "subagent",
            native: true,
          },
          test: {
            name: "test",
            permission: Permission.merge(
              defaults,
              Permission.fromConfig({
                todowrite: "deny",
              }),
              user,
            ),
            description:
              "Testing specialist that designs focused coverage, writes or repairs tests, runs the relevant suite, and reports failures with actionable evidence.",
            prompt: PROMPT_TEST,
            options: {},
            mode: "subagent",
            native: true,
          },
          security: {
            name: "security",
            permission: readonlySpecialist("security", user),
            description:
              "Read-only application security reviewer for trust boundaries, authentication, authorization, secrets, injection risks, unsafe data flow, and dependency exposure.",
            prompt: PROMPT_SECURITY,
            options: {},
            mode: "subagent",
            native: true,
          },
          // Deep research (section 5.3). The lead is a primary agent and a subagent build may hand a research question
          // to; it makes no code changes. The app's agent picker leaves it out by name (context/local.tsx): the Mode
          // menu picks it.
          [RESEARCH]: {
            name: RESEARCH,
            description:
              "Deep research (preview). Researches a question across the web and this repository's brain, then writes a report where each claim cites a quote found in its source. Makes no code changes.",
            permission: researchAgent(RESEARCH, user),
            prompt: PROMPT_RESEARCH,
            options: {},
            mode: "all",
            native: true,
          },
          [RESEARCHER]: {
            name: RESEARCHER,
            description:
              "Research worker for one sub-question of a Deep research plan. Searches and reads the web and saves notes with quotes; it has no files, no memory tool and no shell.",
            permission: researchAgent(RESEARCHER, user),
            prompt: PROMPT_RESEARCHER,
            options: {},
            mode: "subagent",
            native: true,
          },
          // Launched by Vector when a research report is checked, never by a model: hidden from the task list.
          [RESEARCH_JUDGE]: {
            name: RESEARCH_JUDGE,
            description: "Checks that each cited note's quote supports its claim.",
            permission: researchAgent(RESEARCH_JUDGE, user),
            prompt: PROMPT_RESEARCH_JUDGE,
            options: {},
            mode: "subagent",
            native: true,
            hidden: true,
          },
          performance: {
            name: "performance",
            permission: Permission.merge(
              defaults,
              Permission.fromConfig({
                todowrite: "deny",
              }),
              user,
            ),
            description:
              "Performance specialist for profiling slow runtime paths, builds, bundles, queries, and rendering. Measures a baseline, applies focused optimizations, and verifies the improvement.",
            prompt: PROMPT_PERFORMANCE,
            options: {},
            mode: "subagent",
            native: true,
          },
          migration: {
            name: "migration",
            permission: Permission.merge(
              defaults,
              Permission.fromConfig({
                todowrite: "deny",
              }),
              user,
            ),
            description:
              "Migration specialist for framework, dependency, API, database schema, and configuration upgrades. Plans compatibility boundaries, makes staged changes, and validates rollback safety.",
            prompt: PROMPT_MIGRATION,
            options: {},
            mode: "subagent",
            native: true,
          },
          compaction: {
            name: "compaction",
            mode: "primary",
            native: true,
            hidden: true,
            prompt: PROMPT_COMPACTION,
            permission: Permission.merge(
              defaults,
              Permission.fromConfig({
                "*": "deny",
              }),
              user,
            ),
            options: {},
          },
          title: {
            name: "title",
            mode: "primary",
            options: {},
            native: true,
            hidden: true,
            temperature: 0.5,
            permission: Permission.merge(
              defaults,
              Permission.fromConfig({
                "*": "deny",
              }),
              user,
            ),
            prompt: PROMPT_TITLE,
          },
          summary: {
            name: "summary",
            mode: "primary",
            options: {},
            native: true,
            hidden: true,
            permission: Permission.merge(
              defaults,
              Permission.fromConfig({
                "*": "deny",
              }),
              user,
            ),
            prompt: PROMPT_SUMMARY,
          },
          // Reads a document's sections for suggestions in a hidden helper session. It runs on the quick lane (no tools,
          // no repository context) and answers only through StructuredOutput, which its session's rules allow back.
          distill: {
            name: "distill",
            mode: "primary",
            options: {},
            native: true,
            hidden: true,
            temperature: 0,
            permission: Permission.merge(defaults, user, Permission.fromConfig({ "*": "deny" })),
            prompt: PROMPT_DISTILL,
          },
        }

        // A Subagent specialist turned off still takes its config, for the copy its helpers keep (below).
        const off = new Set<string>()
        for (const [key, value] of Object.entries(cfg.agent ?? {})) {
          if (value.disable && !isNativeSpecialist(key)) {
            delete agents[key]
            continue
          }
          if (value.disable) off.add(key)
          let item = agents[key]
          if (!item)
            item = agents[key] = {
              name: key,
              mode: "all",
              permission: Permission.merge(defaults, user),
              options: {},
              native: false,
            }
          if (value.model) item.model = Provider.parseModel(value.model)
          item.variant = value.variant ?? item.variant
          item.prompt = value.prompt ?? item.prompt
          item.description = value.description ?? item.description
          item.temperature = value.temperature ?? item.temperature
          item.topP = value.top_p ?? item.topP
          item.mode = value.mode ?? item.mode
          item.color = value.color ?? item.color
          item.hidden = value.hidden ?? item.hidden
          item.name = value.name ?? item.name
          item.steps = value.steps ?? item.steps
          item.options = mergeDeep(item.options, value.options ?? {})
          item.permission = Permission.merge(item.permission, Permission.fromConfig(value.permission ?? {}))
        }

        // A trusted project's config merges over the user's, so a project allow can replace a user-global deny.
        // Replay the user's own rules from their first deny on, after everything else, so each such deny holds again
        // and the user's later exceptions to it keep working.
        const ceiling = yield* config.permissionCeiling()
        const userCeiling = (name: string) => {
          if (!ceiling) return []
          const rules = [
            ...Permission.fromConfig(ceiling.permission),
            ...Permission.fromConfig(ceiling.agent[name] ?? {}),
          ]
          const first = rules.findIndex((rule) => rule.action === "deny")
          return first === -1 ? [] : rules.slice(first)
        }
        for (const [name, item] of Object.entries(agents)) {
          if (!(name in readonlySpecialists) && !(name in RESEARCH_AGENTS))
            item.permission = Permission.merge(item.permission, userCeiling(name))
        }

        // Rebuilt after the config loop above, so a read-only specialist's own config rules, and the user ceiling, are
        // narrowed like the user's. The research agents likewise.
        for (const name of Object.keys(readonlySpecialists)) {
          const item = agents[name]
          if (!item) continue
          item.permission = readonlySpecialist(name, [
            ...user,
            ...Permission.fromConfig(cfg.agent?.[name]?.permission ?? {}),
            ...userCeiling(name),
          ])
        }
        for (const name of Object.keys(RESEARCH_AGENTS)) {
          const item = agents[name]
          if (!item) continue
          item.permission = researchAgent(name, [
            ...user,
            ...Permission.fromConfig(cfg.agent?.[name]?.permission ?? {}),
            ...userCeiling(name),
          ])
        }

        // The research tools are the research agents' alone, and so are the researcher and the judge: no other agent,
        // whatever its rules, may call one or launch one outside a research run. The build agent alone may hand a
        // question to the research lead with its research tool (on Work and Thorough requests).
        for (const [name, item] of Object.entries(agents)) {
          if (name in RESEARCH_AGENTS) continue
          // Only where task may launch them: a rule for one subagent would otherwise be the last word on task for an
          // agent that may launch none, and offer it the tool.
          const launches = [RESEARCHER, RESEARCH_JUDGE].filter(
            (agent) => Permission.evaluate("task", agent, item.permission).action !== "deny",
          )
          item.permission = Permission.merge(
            item.permission,
            Permission.fromConfig({
              "research_*": "deny",
              ...(name === "build" ? {} : { research: "deny" as const }),
              ...(launches.length
                ? { task: Object.fromEntries(launches.map((agent) => [agent, "deny" as const])) }
                : {}),
            }),
          )
        }

        // A wildcard allow (an agent's or the user's "*": "allow") must not silently
        // approve cloud actions in the agent defaults. The runtime also requires
        // confirmation when a rule names a Cloud mutation explicitly.
        for (const name in agents) {
          const permission = agents[name].permission
          const unnamed = CLOUD_MUTATIONS.filter((key) => {
            const rule = Permission.evaluate(key, "*", permission)
            return rule.action === "allow" && !rule.permission.startsWith("vector_cloud")
          })
          if (!unnamed.length) continue
          agents[name].permission = Permission.merge(
            permission,
            Permission.fromConfig(Object.fromEntries(unnamed.map((key) => [key, "ask" as const]))),
          )
        }

        // Ensure Truncate.GLOB is allowed unless explicitly configured
        for (const name in agents) {
          const agent = agents[name]
          // Capture aliases once with the ruleset. Re-resolving allowed roots while evaluating a request could grant
          // access to a different directory if a Windows junction is later retargeted. Preserve lexical deny rules
          // and add their canonical spelling at the same precedence so a built-in allowance cannot bypass a deny.
          agent.permission = agent.permission.flatMap((rule) => {
            if (rule.permission !== "external_directory" || rule.action !== "deny") return [rule]
            const pattern = builtInDeny(rule.pattern)
            return !pattern || pattern === rule.pattern ? [rule] : [rule, { ...rule, pattern }]
          })
          const explicit = agent.permission.some((r) => {
            if (r.permission !== "external_directory") return false
            if (r.action !== "deny") return false
            return directoryKey(r.pattern) === directoryKey(Truncate.GLOB)
          })
          if (explicit) continue

          agents[name].permission = Permission.merge(
            agents[name].permission,
            Permission.fromConfig({ external_directory: { [Truncate.GLOB]: "allow" } }),
          )
        }

        // Vector's own helpers run as Subagent specialists: a Vectorscope review prompts review and security. One
        // turned off leaves the agent list and `get`, but a helper session still gets it, hidden, from `helper`.
        const helpers: Record<string, Info> = Object.fromEntries(
          [...off].map((name) => [name, { ...agents[name], hidden: true }]),
        )
        for (const name of off) delete agents[name]

        const get = Effect.fnUntraced(function* (agent: string) {
          return agents[agent]
        })

        const helper = Effect.fnUntraced(function* (agent: string) {
          return agents[agent] ?? helpers[agent]
        })

        const list = Effect.fnUntraced(function* () {
          const cfg = yield* config.get()
          return pipe(
            agents,
            values(),
            sortBy(
              [(x) => (cfg.default_agent ? x.name === cfg.default_agent : x.name === "build"), "desc"],
              [(x) => x.name, "asc"],
            ),
          )
        })

        const defaultInfo = Effect.fnUntraced(function* () {
          const c = yield* config.get()
          if (c.default_agent) {
            const agent = agents[c.default_agent]
            if (!agent) throw new Error(`default agent "${c.default_agent}" not found`)
            if (agent.mode === "subagent") throw new Error(`default agent "${c.default_agent}" is a subagent`)
            if (agent.hidden === true) throw new Error(`default agent "${c.default_agent}" is hidden`)
            return agent
          }
          const visible = Object.values(agents).find((a) => a.mode !== "subagent" && a.hidden !== true)
          if (!visible) throw new Error("no primary visible agent found")
          return visible
        })

        const defaultAgent = Effect.fnUntraced(function* () {
          return (yield* defaultInfo()).name
        })

        return {
          get,
          helper,
          list,
          defaultInfo,
          defaultAgent,
        } satisfies State
      }),
    )

    return Service.of({
      get: Effect.fn("Agent.get")(function* (agent: string) {
        return yield* InstanceState.useEffect(state, (s) => s.get(agent))
      }),
      helper: Effect.fn("Agent.helper")(function* (agent: string) {
        return yield* InstanceState.useEffect(state, (s) => s.helper(agent))
      }),
      list: Effect.fn("Agent.list")(function* () {
        return yield* InstanceState.useEffect(state, (s) => s.list())
      }),
      defaultInfo: Effect.fn("Agent.defaultInfo")(function* () {
        return yield* InstanceState.useEffect(state, (s) => s.defaultInfo())
      }),
      defaultAgent: Effect.fn("Agent.defaultAgent")(function* () {
        return yield* InstanceState.useEffect(state, (s) => s.defaultAgent())
      }),
      generate: Effect.fn("Agent.generate")(function* (input: {
        description: string
        model?: { providerID: ProviderV2.ID; modelID: ModelV2.ID }
      }) {
        const cfg = yield* config.get()
        const model = input.model ?? (yield* provider.defaultModel())
        const resolved = yield* provider.getModel(model.providerID, model.modelID)
        const language = yield* provider.getLanguage(resolved)
        // The OpenTelemetry tracer package loads only when the experimental exporter is configured.
        const tracer = yield* Effect.gen(function* () {
          if (!cfg.experimental?.openTelemetry) return undefined
          const { OtelTracer } = yield* Effect.promise(() => import("@effect/opentelemetry/Tracer"))
          return Option.getOrUndefined(yield* Effect.serviceOption(OtelTracer))
        })

        const system = [PROMPT_GENERATE]
        yield* plugin.trigger("experimental.chat.system.transform", { model: resolved }, { system })
        const existing = yield* InstanceState.useEffect(state, (s) => s.list())

        // TODO: clean this up so provider specific logic doesnt bleed over
        const authInfo = yield* auth.get(model.providerID).pipe(Effect.orDie)
        const isOpenaiOauth = model.providerID === "openai" && authInfo?.type === "oauth"

        const params = {
          experimental_telemetry: {
            isEnabled: cfg.experimental?.openTelemetry,
            tracer,
            metadata: {
              userId: cfg.username ?? "unknown",
            },
          },
          temperature: 0.3,
          messages: [
            ...(isOpenaiOauth
              ? []
              : system.map(
                  (item): ModelMessage => ({
                    role: "system",
                    content: item,
                  }),
                )),
            {
              role: "user",
              content: `Create an agent configuration based on this request: "${input.description}".\n\nIMPORTANT: The following identifiers already exist and must NOT be used: ${existing.map((i) => i.name).join(", ")}\n  Return ONLY the JSON object, no other text, do not wrap in backticks`,
            },
          ],
          model: language,
          schema: Object.assign(
            Schema.toStandardSchemaV1(GeneratedAgent),
            Schema.toStandardJSONSchemaV1(GeneratedAgent),
          ),
        } satisfies Parameters<typeof generateObject>[0]

        if (isOpenaiOauth) {
          return yield* Effect.promise(async () => {
            const result = streamObject({
              ...params,
              providerOptions: ProviderTransform.providerOptions(resolved, {
                instructions: system.join("\n"),
                store: false,
              }),
              onError: () => {},
            })
            for await (const part of result.fullStream) {
              if (part.type === "error") throw part.error
            }
            return result.object
          })
        }

        return yield* Effect.promise(() => generateObject(params).then((r) => r.object))
      }),
    })
  }),
)

// One user or config rule as it may apply to a read-only specialist that has `tools` and may run the `verification`
// commands (each a literal prefix ending in `*`). A deny always applies. An allow or ask applies to the tools it
// names, and an ask also narrows external reads and the verification commands it covers: `bash: ask` asks before
// each of them, `git *: ask` before the git ones, `git diff --stat*: ask` before that one alone. For an agent that
// delegates to `subagents` alone (the research lead), a rule for `task` applies to those of them its pattern names,
// never to any other subagent, and an agent that reads no file (`external: false`) gets no external-read rule.
function narrow(
  rule: PermissionV1.Rule,
  tools: string[],
  verification: string[],
  options: { readonly subagents?: readonly string[]; readonly external?: boolean } = {},
): PermissionV1.Rule[] {
  if (rule.action === "deny") return [rule]
  const named = tools
    .filter((tool) => Wildcard.match(tool, rule.permission))
    .flatMap((tool) =>
      tool === "task" && options.subagents
        ? options.subagents
            .filter((agent) => Wildcard.match(agent, rule.pattern))
            .map((agent) => ({ ...rule, permission: tool, pattern: agent }))
        : [{ ...rule, permission: tool }],
    )
  if (rule.action !== "ask") return named
  const external =
    options.external !== false && Wildcard.match("external_directory", rule.permission)
      ? [{ ...rule, permission: "external_directory" }]
      : []
  const bash = Wildcard.match("bash", rule.permission)
    ? verification.flatMap((pattern) => {
        const prefix = pattern.slice(0, -1)
        if (Wildcard.match(prefix, rule.pattern)) return [{ ...rule, permission: "bash", pattern }]
        if (rule.pattern.split(/[*?]/)[0].startsWith(prefix)) return [{ ...rule, permission: "bash" }]
        return []
      })
    : []
  return [...named, ...external, ...bash]
}

const locationServiceMapNode = LayerNode.make({
  service: LocationServiceMap.Service,
  layer: locationServiceMapLayer,
  deps: [],
})

export const node = LayerNode.make({
  service: Service,
  layer: layer,
  deps: [Config.node, Auth.node, Plugin.node, Skill.node, Provider.node, locationServiceMapNode],
})

export * as Agent from "./agent"
