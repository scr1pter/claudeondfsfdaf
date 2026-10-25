import { LayerNode } from "@vectordevai/core/effect/layer-node"
import { LocationServiceMap, locationServiceMapLayer } from "@vectordevai/core/location-services"
import { httpClient } from "@vectordevai/core/effect/app-node-platform"
import { Ripgrep } from "@vectordevai/core/ripgrep"
import { PlanExitTool } from "./plan"
import { Session } from "@/session/session"
import { SessionStatus } from "@/session/status"
import { QuestionTool } from "./question"
import { ShellTool } from "./shell"
import { TerminalTool } from "./terminal"
import { EditTool } from "./edit"
import { GlobTool } from "./glob"
import { GrepTool } from "./grep"
import { ReadTool } from "./read"
import { TaskTool } from "./task"
import { TaskManageTool } from "./task-manage"
import { TaskManager } from "@/task/manager"
import { SpendGuard } from "@vectordevai/core/spend-guard"
import { Database } from "@vectordevai/core/database/database"
import { TodoWriteTool } from "./todo"
import { TEAM_MARKER_RELATIVE_PATH, TeammateMessageTool } from "./teammate"
import { WebFetchTool } from "./webfetch"
import { WriteTool } from "./write"
import { InvalidTool } from "./invalid"
import { EscalateTool } from "./escalate"
import { SkillTool } from "./skill"
import { MemoryTool } from "./memory"
import { Brain } from "@vectordevai/core/brain/brain"
import { BrainKnowledge } from "@vectordevai/core/brain/knowledge"
import { Global } from "@vectordevai/core/global"
import { FreeModelGuests } from "@vectordevai/core/free-model-guests"
import { Git } from "@/git"
import * as Tool from "./tool"
import { Config } from "@/config/config"
import { ConfigDependencies } from "@/config/dependencies"
import { InstallationLocal } from "@vectordevai/core/installation/version"
import { PluginLoader } from "@/plugin/loader"
import { type ToolContext as PluginToolContext, type ToolDefinition } from "@vectordevai/plugin"
import type { JSONSchema7, JSONSchema7Definition } from "@ai-sdk/provider"
import { Schema } from "effect"
import z from "zod"
import { Plugin } from "../plugin"
import { Provider } from "@/provider/provider"

import { LspTool } from "./lsp"
import * as Truncate from "./truncate"
import { ApplyPatchTool } from "./apply_patch"
import { Glob } from "@vectordevai/core/util/glob"
import path from "path"
import { pathToFileURL } from "url"
import { Effect, Layer, Context } from "effect"
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"
import { CrossSpawnSpawner } from "@vectordevai/core/cross-spawn-spawner"
import { Format } from "../format"
import { InstanceState } from "@/effect/instance-state"
import { EffectBridge } from "@/effect/bridge"
import { Question } from "../question"
import { Todo } from "../session/todo"
import { LSP } from "@/lsp/lsp"
import { Instruction } from "../session/instruction"
import { FSUtil } from "@vectordevai/core/fs-util"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Agent } from "../agent/agent"
import { Skill } from "../skill"
import { Permission } from "@/permission"
import { BackgroundJob } from "@/background/job"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { ProviderV2 } from "@vectordevai/core/provider"
import { ModelV2 } from "@vectordevai/core/model"
import { BrowserTool } from "./browser"
import { VectorCloudTool } from "./vector-cloud"
import { ResearchStore } from "@vectordevai/core/research/store"
import { ResearchRun } from "./research-run"
import { ResearchPlanTool } from "./research-plan"
import { ResearchSearchTool } from "./research-search"
import { ResearchReadTool } from "./research-read"
import { ResearchNoteTool } from "./research-note"
import { ResearchReportTool } from "./research-report"
import { ResearchBrowserTool } from "./research-browser"
import { ResearchTool } from "./research"

// Which research tool each research agent is offered (section 5.3). The agents' permissions say the same; offering
// them only here keeps every other agent's tool list, and its provider cache, as it was.
const RESEARCH_TOOLS: Record<string, readonly string[]> = {
  [ResearchRun.LEAD]: [
    "research_plan",
    "research_search",
    "research_read",
    "research_browser",
    "research_note",
    "research_report",
  ],
  [ResearchRun.RESEARCHER]: ["research_search", "research_read", "research_browser", "research_note"],
}
const RESEARCH_TOOL_IDS = new Set(Object.values(RESEARCH_TOOLS).flat())

type TaskDef = Tool.InferDef<typeof TaskTool>
type ReadDef = Tool.InferDef<typeof ReadTool>
const builtinPatches = new WeakSet<Tool.Def>()
const builtinTasks = new WeakSet<Tool.Def>()

export function isBuiltinTask(tool: Tool.Def) {
  return builtinTasks.has(tool)
}

export function isBuiltinPatch(tool: Tool.Def) {
  return builtinPatches.has(tool)
}

type State = {
  custom: Tool.Def[]
  builtin: Tool.Def[]
  task: TaskDef
  taskSchema: string
  read: ReadDef
  patch: Tool.Def
}

export interface Interface {
  readonly ids: () => Effect.Effect<string[]>
  readonly all: () => Effect.Effect<Tool.Def[]>
  readonly named: () => Effect.Effect<{ task: TaskDef; read: ReadDef }>
  readonly tools: (model: {
    providerID: ProviderV2.ID
    modelID: ModelV2.ID
    agent: Agent.Info
  }) => Effect.Effect<Tool.Def[]>
}

export class Service extends Context.Service<Service, Interface>()("@vector/ToolRegistry") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const config = yield* Config.Service
    const dependencies = yield* ConfigDependencies.Service
    const plugin = yield* Plugin.Service
    const agents = yield* Agent.Service
    const truncate = yield* Truncate.Service
    const flags = yield* RuntimeFlags.Service
    const fsutil = yield* FSUtil.Service

    const invalid = yield* InvalidTool
    const escalate = yield* EscalateTool
    const task = yield* TaskTool
    const taskManage = yield* TaskManageTool
    const read = yield* ReadTool
    const question = yield* QuestionTool
    const todo = yield* TodoWriteTool
    const teammate = yield* TeammateMessageTool
    const lsptool = yield* LspTool
    const plan = yield* PlanExitTool
    const webfetch = yield* WebFetchTool
    const shell = yield* ShellTool
    const terminaltool = yield* TerminalTool
    const globtool = yield* GlobTool
    const writetool = yield* WriteTool
    const edit = yield* EditTool
    const greptool = yield* GrepTool
    const patchtool = yield* ApplyPatchTool
    const skilltool = yield* SkillTool
    const memorytool = yield* MemoryTool
    const browsertool = yield* BrowserTool
    const vectorcloudtool = yield* VectorCloudTool
    const researchplan = yield* ResearchPlanTool
    const researchsearch = yield* ResearchSearchTool
    const researchread = yield* ResearchReadTool
    const researchnote = yield* ResearchNoteTool
    const researchreport = yield* ResearchReportTool
    const researchbrowser = yield* ResearchBrowserTool
    const researchtool = yield* ResearchTool
    const agent = yield* Agent.Service

    const state = yield* InstanceState.make<State>(
      Effect.fn("ToolRegistry.state")(function* (ctx) {
        const custom: Tool.Def[] = []

        function fromPlugin(id: string, def: ToolDefinition): Tool.Def {
          // Plugin tools still expose Zod args publicly; keep that compatibility
          // boxed at the registry boundary and give the LLM the original JSON Schema.
          // Normalize missing args to `{}` once — pre-1.14.49 the code was
          // `z.object(def.args)` and Zod silently tolerated undefined (#27451, #27630).
          const args = def.args ?? {}
          const entries = Object.entries(args)
          const allZod = entries.every((entry) => isZodType(entry[1]))
          const zodParams = allZod ? z.object(args) : undefined
          const jsonSchema = zodParams ? zodJsonSchema(zodParams) : legacyJsonSchema(entries)
          const parameters = zodParams
            ? Schema.declare<unknown>((u): u is unknown => zodParams.safeParse(u).success)
            : Schema.Unknown
          return {
            id,
            parameters,
            jsonSchema,
            description: def.description,
            execute: (args, toolCtx) =>
              Effect.gen(function* () {
                // Bridge the host's Effect-based `ask` into a Promise-returning
                // function for the plugin to make sure context persists
                const bridge = yield* EffectBridge.make()
                const pluginCtx: PluginToolContext = {
                  ...toolCtx,
                  ask: (req) => bridge.promise(toolCtx.ask(req)),
                  directory: ctx.directory,
                  worktree: ctx.worktree,
                }
                const result = yield* Effect.promise(() => def.execute(args as any, pluginCtx))
                const output = typeof result === "string" ? result : result.output
                const metadata = typeof result === "string" ? {} : (result.metadata ?? {})
                const attachments = typeof result === "string" ? undefined : result.attachments
                const info = yield* agent.get(toolCtx.agent)
                const out = yield* truncate.output(output, {}, info)
                return {
                  title: typeof result === "string" ? "" : (result.title ?? ""),
                  output: out.truncated ? out.content : output,
                  attachments,
                  metadata: {
                    ...metadata,
                    truncated: out.truncated,
                    ...(out.truncated && { outputPath: out.outputPath }),
                  },
                }
              }).pipe(
                Effect.withSpan("Tool.execute", {
                  attributes: {
                    "tool.name": id,
                    "session.id": toolCtx.sessionID,
                    "message.id": toolCtx.messageID,
                    ...(toolCtx.callID ? { "tool.call_id": toolCtx.callID } : {}),
                  },
                }),
              ),
          }
        }

        const dirs = yield* config.directories()
        const matches = dirs.flatMap((dir) =>
          Glob.scanSync("{tool,tools}/*.{js,ts}", { cwd: dir, absolute: true, dot: true, symlink: true }),
        )
        if (matches.length && !InstallationLocal) yield* dependencies.prepare().pipe(Effect.forkDetach)
        for (const match of matches) {
          const namespace = path.basename(match, path.extname(match))
          // `match` is an absolute filesystem path from `Glob.scanSync(..., { absolute: true })`.
          // Import it as `file://` so Node on Windows accepts the dynamic import.
          const loaded = yield* Effect.promise(() =>
            PluginLoader.load({
              spec: match,
              target: match,
              entry: pathToFileURL(match).href,
              source: "file",
              options: undefined,
              deprecated: false,
            }),
          )
          if (!loaded.ok) {
            yield* Effect.logWarning("Custom tool could not load", { path: match, error: String(loaded.error) })
            continue
          }
          for (const [id, def] of Object.entries(loaded.value.mod)) {
            if (!isPluginTool(def)) continue
            custom.push(fromPlugin(id === "default" ? namespace : `${namespace}_${id}`, def))
          }
        }

        const plugins = yield* plugin.list()
        for (const p of plugins) {
          for (const [id, def] of Object.entries(p.tool ?? {})) {
            custom.push(fromPlugin(id, def))
          }
        }

        yield* config.get()
        const questionEnabled = ["app", "cli", "desktop"].includes(flags.client) || flags.enableQuestionTool
        // A Parallel Workspace writes its team marker while it is provisioned, before any session runs there, so
        // a directory without one never has teammates and the tool would only cost tokens on every request.
        const team = yield* fsutil.isFile(path.join(ctx.directory, TEAM_MARKER_RELATIVE_PATH))

        const tool = yield* Effect.all({
          invalid: Tool.init(invalid),
          escalate: Tool.init(escalate),
          shell: Tool.init(shell),
          terminal: Tool.init(terminaltool),
          read: Tool.init(read),
          glob: Tool.init(globtool),
          grep: Tool.init(greptool),
          edit: Tool.init(edit),
          write: Tool.init(writetool),
          task: Tool.init(task),
          taskManage: Tool.init(taskManage),
          fetch: Tool.init(webfetch),
          todo: Tool.init(todo),
          teammate: Tool.init(teammate),
          skill: Tool.init(skilltool),
          memory: Tool.init(memorytool),
          patch: Tool.init(patchtool),
          question: Tool.init(question),
          lsp: Tool.init(lsptool),
          plan: Tool.init(plan),
          browser: Tool.init(browsertool),
          vectorcloud: Tool.init(vectorcloudtool),
          researchplan: Tool.init(researchplan),
          researchsearch: Tool.init(researchsearch),
          researchread: Tool.init(researchread),
          researchnote: Tool.init(researchnote),
          researchreport: Tool.init(researchreport),
          researchbrowser: Tool.init(researchbrowser),
          research: Tool.init(researchtool),
        })

        return {
          custom,
          builtin: [
            tool.invalid,
            ...(questionEnabled ? [tool.question] : []),
            tool.shell,
            tool.terminal,
            tool.read,
            tool.glob,
            tool.grep,
            tool.edit,
            tool.write,
            tool.task,
            tool.taskManage,
            tool.fetch,
            tool.todo,
            ...(team ? [tool.teammate] : []),
            tool.skill,
            // The session runtime removes it from subagents and the quick lane, which leave memory to the main agent.
            tool.memory,
            tool.patch,
            // Offered only to a sized request below Thorough; the session runtime removes it everywhere else.
            tool.escalate,
            ...(process.env.VECTOR_BROWSER_BRIDGE_URL && process.env.VECTOR_BROWSER_BRIDGE_TOKEN ? [tool.browser] : []),
            ...(process.env.VECTOR_CLOUD_BRIDGE_URL && process.env.VECTOR_CLOUD_BRIDGE_TOKEN ? [tool.vectorcloud] : []),
            ...(flags.experimentalLspTool ? [tool.lsp] : []),
            ...(flags.experimentalPlanMode && flags.client === "cli" ? [tool.plan] : []),
            // Deep research's tools, offered to the research agents alone (below), and the build agent's research tool.
            tool.researchplan,
            tool.researchsearch,
            tool.researchread,
            tool.researchnote,
            tool.researchreport,
            // Each research agent's own browser. It is offered outside the desktop app too, and says there that it
            // needs the desktop browser.
            tool.researchbrowser,
            tool.research,
          ],
          task: tool.task,
          taskSchema: JSON.stringify(tool.task.jsonSchema),
          read: tool.read,
          patch: tool.patch,
        }
      }),
    )

    const all: Interface["all"] = Effect.fn("ToolRegistry.all")(function* () {
      const s = yield* InstanceState.get(state)
      return [...s.builtin, ...s.custom] as Tool.Def[]
    })

    const ids: Interface["ids"] = Effect.fn("ToolRegistry.ids")(function* () {
      return (yield* all()).map((tool) => tool.id)
    })

    const describeTask = Effect.fn("ToolRegistry.describeTask")(function* (agent: Agent.Info) {
      // A hidden built-in subagent (the research judge) is Vector's to launch, so no model is told about it.
      const items = (yield* agents.list()).filter(
        (item) => item.mode !== "primary" && !(item.native && item.hidden && item.mode === "subagent"),
      )
      const filtered = items.filter(
        (item) => Permission.evaluate("task", item.name, agent.permission).action !== "deny",
      )
      const list = filtered.toSorted((a, b) => a.name.localeCompare(b.name))
      const description = list
        .map(
          (item) =>
            `- ${item.name}: ${item.description ?? "This subagent should only be called manually by the user."}`,
        )
        .join("\n")
      return ["Available agent types:", description].join("\n")
    })

    const tools: Interface["tools"] = Effect.fn("ToolRegistry.tools")(function* (input) {
      const builtin = yield* InstanceState.get(state)
      const researchSetting = (yield* config.get()).research?.tool
      // A research agent is offered its own tools and nothing else, whatever a session's or the user's rules allow:
      // no edit, shell, plugin or custom tool reaches Deep research (RC1).
      const own = Agent.researchTools(input.agent.name)
      const filtered = (yield* all()).filter((tool) => {
        if (own && tool.id !== InvalidTool.id && !own.includes(tool.id)) return false
        // With Vector Local's Web access None, research is offered no tool that reaches the web (section 5.9).
        if (ResearchRun.withheld(tool.id)) return false
        if (RESEARCH_TOOL_IDS.has(tool.id)) return RESEARCH_TOOLS[input.agent.name]?.includes(tool.id) ?? false
        // The build agent researches as a tool on its own requests unless the user turned that off; the session
        // runtime's size decides the rest when the tool runs.
        if (tool.id === ResearchTool.id) return input.agent.name === "build" && researchSetting !== "off"

        const usePatch =
          input.modelID.includes("gpt-") && !input.modelID.includes("oss") && !input.modelID.includes("gpt-4")
        if (tool.id === ApplyPatchTool.id) return usePatch
        if (tool.id === EditTool.id || tool.id === WriteTool.id) return !usePatch

        return true
      })

      return yield* Effect.forEach(
        filtered,
        Effect.fnUntraced(function* (tool: Tool.Def) {
          // Task's compatibility validator must distinguish untouched definitions
          // from in-place plugin edits without mutating the cached builtin schema.
          const initialSchema = tool === builtin.task ? structuredClone(tool.jsonSchema) : tool.jsonSchema
          const output = {
            description: tool.description,
            parameters: tool.parameters,
            jsonSchema: initialSchema,
          }
          yield* plugin.trigger("tool.definition", { toolID: tool.id }, output)
          const jsonSchema =
            output.parameters === tool.parameters || output.jsonSchema !== initialSchema ? output.jsonSchema : undefined
          const result = {
            id: tool.id,
            description: [output.description, tool.id === TaskTool.id ? yield* describeTask(input.agent) : undefined]
              .filter(Boolean)
              .join("\n"),
            parameters: output.parameters,
            jsonSchema,
            execute: tool.execute,
            formatValidationError: tool.formatValidationError,
          }
          if (tool === builtin.patch && output.parameters === tool.parameters && output.jsonSchema === tool.jsonSchema)
            builtinPatches.add(result)
          if (
            tool === builtin.task &&
            output.parameters === tool.parameters &&
            output.jsonSchema === initialSchema &&
            JSON.stringify(jsonSchema) === builtin.taskSchema
          )
            builtinTasks.add(result)
          return result
        }),
        { concurrency: "unbounded" },
      )
    })

    const named: Interface["named"] = Effect.fn("ToolRegistry.named")(function* () {
      const s = yield* InstanceState.get(state)
      return { task: s.task, read: s.read }
    })

    return Service.of({ ids, all, named, tools })
  }),
)

function isZodType(value: unknown): value is z.ZodType {
  return typeof value === "object" && value !== null && "_zod" in value
}

function isPluginTool(value: unknown): value is ToolDefinition {
  return typeof value === "object" && value !== null && "args" in value && "description" in value && "execute" in value
}

function isJsonSchemaDefinition(value: unknown): value is JSONSchema7Definition {
  return typeof value === "boolean" || (typeof value === "object" && value !== null && !Array.isArray(value))
}

function legacyJsonSchema(entries: [string, unknown][]): JSONSchema7 {
  const properties = Object.fromEntries(
    entries.filter((entry): entry is [string, JSONSchema7Definition] => isJsonSchemaDefinition(entry[1])),
  )
  return {
    type: "object",
    properties,
    required: Object.keys(properties),
  }
}

function zodJsonSchema(schema: z.ZodType): JSONSchema7 {
  const result = normalizeZodJsonSchema(z.toJSONSchema(schema, { io: "input", metadata: zodMetadataRegistry(schema) }))
  if (!isJsonSchemaObject(result)) throw new Error("plugin tool Zod schema produced a non-object JSON Schema")
  const { $defs, ...rest } = result
  return (
    $defs && isJsonSchemaObject($defs) ? { ...rest, definitions: $defs as JSONSchema7["definitions"] } : rest
  ) as JSONSchema7
}

function zodMetadataRegistry(schema: z.ZodType) {
  const registry = z.registry<Record<string, unknown>>()
  const seen = new WeakSet<object>()
  const collect = (value: unknown) => {
    if (typeof value !== "object" || value === null) return
    if (seen.has(value)) return
    seen.add(value)

    if (isZodType(value)) {
      const metadata = typeof value.meta === "function" ? value.meta() : undefined
      const description = typeof value.description === "string" ? value.description : undefined
      const merged = {
        ...(metadata && typeof metadata === "object" ? metadata : {}),
        ...(description ? { description } : {}),
      }
      if (Object.keys(merged).length) registry.add(value, merged)
      collect(value._zod.def)
      return
    }

    for (const item of Object.values(value)) collect(item)
  }
  collect(schema)
  return registry
}

function normalizeZodJsonSchema(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => normalizeZodJsonSchema(item))
  if (typeof value !== "object" || value === null) return value
  return Object.fromEntries(
    Object.entries(value)
      .filter((entry) =>
        (entry[0] === "exclusiveMaximum" || entry[0] === "exclusiveMinimum") && typeof entry[1] === "boolean"
          ? false
          : true,
      )
      .map(([key, item]) => [key, normalizeZodJsonSchema(item)]),
  )
}

function isJsonSchemaObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

// The same location services the app's terminal routes reach, so the terminal tool sees the terminals the panel shows.
const locationServiceMapNode = LayerNode.make({
  service: LocationServiceMap.Service,
  layer: locationServiceMapLayer,
  deps: [],
})

export const node = LayerNode.make({
  service: Service,
  layer,
  deps: [
    Config.node,
    ConfigDependencies.node,
    Plugin.node,
    Question.node,
    Todo.node,
    Agent.node,
    Skill.node,
    Session.node,
    SessionStatus.node,
    BackgroundJob.node,
    Provider.node,
    LSP.node,
    Instruction.node,
    Brain.node,
    BrainKnowledge.node,
    FreeModelGuests.node,
    Git.node,
    FSUtil.node,
    EventV2Bridge.node,
    httpClient,
    CrossSpawnSpawner.node,
    Format.node,
    Truncate.node,
    RuntimeFlags.node,
    Database.node,
    Ripgrep.node,
    SpendGuard.node,
    TaskManager.node,
    Global.node,
    ResearchStore.node,
    ResearchRun.node,
    locationServiceMapNode,
  ],
})

export * as ToolRegistry from "./registry"
