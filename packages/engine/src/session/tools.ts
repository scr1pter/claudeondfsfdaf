import { TaskClaims } from "@/task/claims"
import { WorkflowMarkers } from "@/orchestration/constants"
import { assertWritable } from "@/tool/owned-path"
import { SubagentLifecycle } from "@/tool/subagent-lifecycle"
import { Agent } from "@/agent/agent"
import { SessionV1 } from "@vectordevai/core/v1/session"
import { Provider } from "@/provider/provider"
import { ProviderTransform } from "@/provider/transform"
import { MCP } from "@/mcp"
import { Permission } from "@/permission"
import type { PermissionV1 } from "@vectordevai/core/v1/permission"
import { Tool } from "@/tool/tool"
import { ToolJsonSchema } from "@/tool/json-schema"
import { ToolRegistry } from "@/tool/registry"
import { Truncate } from "@/tool/truncate"

import { Plugin } from "@/plugin"
import type { TaskPromptOps } from "@/tool/task"
import type { TaskSizeContext } from "@/tool/escalate"
import type { TaskLimits } from "@/task/limits"
import type { TaskSize } from "@vectordevai/core/task-size"
import { type Tool as AITool, tool, jsonSchema, type ToolExecutionOptions, asSchema } from "ai"
import { Cause, Effect, Option, Result, Schema } from "effect"
import { MessageV2 } from "./message-v2"
import { Session } from "./session"
import { SessionProcessor } from "./processor"
import { PartID } from "./schema"
import { EffectBridge } from "@/effect/bridge"
import { ProviderV2 } from "@vectordevai/core/provider"
import { ModelV2 } from "@vectordevai/core/model"
import { freeModelMayTrain } from "@vectordevai/core/free-model-choice"
import { isRecord } from "@/util/record"
import { NativePatch } from "./llm/native-patch"
import { SessionMemory } from "./memory"
import { Brain } from "@vectordevai/core/brain/brain"
import { PermissionPolicy } from "@vectordevai/schema/permission-policy"
import { InstanceState } from "@/effect/instance-state"
import { Config } from "@/config/config"
import { Git } from "@/git"
import { SessionAudience } from "@vectordevai/core/session/audience"
import { PrivateAccess } from "@/tool/private-access"
import { PromptTrust } from "@/config/prompt-trust"
import { Global } from "@vectordevai/core/global"
import { PromptSource } from "./prompt-source"
import path from "path"

const MCP_RESOURCE_TOOLS = {
  list: "list_mcp_resources",
  listTemplates: "list_mcp_resource_templates",
  read: "read_mcp_resource",
} as const
const MAX_MCP_RESOURCE_BLOB_BYTES = 10 * 1024 * 1024
const SUPPORTED_MCP_RESOURCE_ATTACHMENT_MIMES = new Set([
  "application/pdf",
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/webp",
])

/**
 * Whether this step offers the task tool: it is in the step's tools and the agent's and session's rules do not disable
 * it. A per-message `tools: {task: false}` becomes session permission, and the request drops disabled tools only after
 * this record is built, so membership alone would still offer a workflow that cannot launch (G.3).
 */
export function taskOffered(
  tools: Readonly<Record<string, unknown>>,
  agent: PermissionV1.Ruleset,
  session: PermissionV1.Ruleset | undefined,
) {
  return (
    Object.hasOwn(tools, "task") && !Permission.disabled(["task"], Permission.merge(agent, session ?? [])).has("task")
  )
}

export const resolve = Effect.fn("SessionTools.resolve")(function* (input: {
  agent: Agent.Info
  model: Provider.Model
  session: Session.Info
  processor: Pick<SessionProcessor.Handle, "message" | "updateToolCall" | "completeToolCall">
  // Agents the user invoked by name this turn; launching one of them skips the task permission prompt.
  invokedAgents: readonly string[]
  messages: SessionV1.WithParts[]
  promptOps: TaskPromptOps
  // The request's size this step, for the escalate tool; absent where sizing does not apply.
  taskSize?: TaskSizeContext
  // Whether the owner's personal memory and private documents may go to this step's model: no guest is in the
  // session and the model does not train on prompts. Absent, they stay out.
  personal?: boolean
  // A role whose output leaves the machine or reaches the web (section 6.4a): its tools find nothing personal.
  outward?: boolean
  // The request a root session's subagent launches count against (multi-agent contract 5.B.2).
  delegation?: TaskLimits.Context
  // This step's sized effort: a fork's effort and a brief's ceiling (5.E.1).
  effort?: TaskSize.Effort
  // The effort this request's own size gives, which the task tool passes down under Thorough (5.E.1).
  passdown?: TaskSize.Effort
}) {
  const tools: Record<string, AITool> = {}
  const run = yield* EffectBridge.make()
  const plugin = yield* Plugin.Service
  const permission = yield* Permission.Service
  const sessions = yield* Session.Service
  const registry = yield* ToolRegistry.Service
  const mcp = yield* MCP.Service
  const truncate = yield* Truncate.Service
  const brain = yield* Brain.Service
  // The prompt guard reads what this directory's prompts come from, so every caller must hand it the config.
  const config = yield* Config.Service
  const audience = yield* SessionAudience.Service
  const git = yield* Git.Service
  const instance = yield* InstanceState.context
  const access = PrivateAccess.make({ sessionID: input.session.id, audience, git, instance })
  const readTargets = new Map<string, Map<string, boolean>>()
  const rememberRead = (callID: string, files: readonly string[], recursive = false) => {
    const targets = readTargets.get(callID) ?? new Map<string, boolean>()
    for (const file of files) targets.set(file, recursive || targets.get(file) === true)
    readTargets.set(callID, targets)
    return access.read(files, { ancestors: recursive }).pipe(Effect.orDie)
  }
  // A guest family's finished output is checked again against durable fences, including files the call read, before
  // plugins, history or the model see it. A fence that landed while the call ran still applies.
  const checked = Effect.fn("SessionTools.privateOutput")(function* <A>(callID: string, value: A) {
    const targets = readTargets.get(callID) ?? new Map<string, boolean>()
    readTargets.delete(callID)
    for (const [file, recursive] of targets) yield* access.read([file], { ancestors: recursive }).pipe(Effect.orDie)
    return yield* access.output(value).pipe(Effect.orDie)
  })
  // Errors reach history and the model the same way output does, so a guest family's error text is checked too.
  // The refusal that replaces it carries no path.
  const guarded = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.catchCause((cause) =>
        access.output(Cause.pretty(cause)).pipe(Effect.orDie, Effect.andThen(Effect.failCause(cause))),
      ),
    )
  // What a compaction folded away still counts for the rules that ask about outside content, so they read the session's
  // stored messages as well as the window the model sees.
  const history = () =>
    sessions.messages({ sessionID: input.session.id }).pipe(
      Effect.catch(() => Effect.succeed([] as SessionV1.WithParts[])),
      Effect.map((stored) => [...stored, ...input.messages]),
    )
  // The prompt files each tool call's approved prompt_source ask let it change, by call, taken into the hold's baseline
  // once the call completes.
  const prompted = new Map<string, string[]>()
  // What this directory's prompts are read from (section 8.2), worked out for each edit a tool call asks for.
  const prompts = Effect.fnUntraced(function* () {
    const instance = yield* InstanceState.context
    return yield* PromptSource.sources({
      config,
      global: Option.getOrElse(yield* Effect.serviceOption(Global.Service), () => Global.make()),
      directory: instance.directory,
      worktree: instance.worktree,
    })
  })

  // Refusals name another conversation's subagent only to its own family. A family that cannot be read names none.
  const inFamily = TaskClaims.familyOf(audience, input.session.id)

  const subagentTitle = SubagentLifecycle.read(input.session)?.title
  const context = (args: Record<string, unknown>, options: ToolExecutionOptions): Tool.Context => ({
    sessionID: input.session.id,
    parentID: input.session.parentID,
    abort: options.abortSignal!,
    messageID: input.processor.message.id,
    callID: options.toolCallId,
    extra: {
      model: input.model,
      // Whether the model may train on prompts, for tools that keep the owner's personal memory away from such a model.
      mayTrain: freeModelMayTrain(input.model),
      personal: input.personal === true,
      outward: input.outward === true,
      invokedAgents: input.invokedAgents,
      promptOps: input.promptOps,
      [WorkflowMarkers.TASK_OFFERED]: taskOffered(tools, input.agent.permission, input.session.permission),
      ...(input.taskSize ? { taskSize: input.taskSize } : {}),
      ...(input.delegation ? { delegation: input.delegation } : {}),
      ...(input.effort ? { effort: input.effort } : {}),
      ...(input.passdown ? { passdown: input.passdown } : {}),
      // Names this subagent to a session whose edit its write makes stale (FileState.verify).
      ...(subagentTitle ? { subagentTitle } : {}),
    },
    ownedPaths: TaskClaims.pathsFor(input.session.id),
    getOwnedPaths: () =>
      Effect.sync(() => TaskClaims.trustedPaths(input.session.id, input.session.parentID !== undefined)),
    inFamily,
    assertReadable: (request) => rememberRead(options.toolCallId, request.files, request.recursive),
    assertGitReadable: (request) => access.git(request.cwd, request).pipe(Effect.orDie),
    assertOutput: (value) => access.output(value).pipe(Effect.asVoid, Effect.orDie),
    assertWritable: (request) =>
      rememberRead(options.toolCallId, request.files ?? []).pipe(
        Effect.andThen(
          assertWritable(
            {
              sessionID: input.session.id,
              parentID: input.session.parentID,
              getOwnedPaths: () =>
                Effect.sync(() => TaskClaims.trustedPaths(input.session.id, input.session.parentID !== undefined)),
              inFamily,
            },
            request,
          ),
        ),
      ),
    agent: input.agent.name,
    messages: input.messages,
    history,
    metadata: (val) =>
      access.output(val).pipe(
        Effect.orDie,
        Effect.andThen(
          input.processor.updateToolCall(options.toolCallId, (match) => {
            if (!["running", "pending"].includes(match.state.status)) return match
            return {
              ...match,
              state: {
                title: val.title,
                metadata: val.metadata,
                status: "running",
                input: args,
                time: { start: Date.now() },
              },
            }
          }),
        ),
      ),
    deniedResources: (req) =>
      Effect.succeed(
        req.patterns.filter(
          (pattern) =>
            Permission.evaluate(
              req.permission,
              pattern,
              Permission.merge(input.agent.permission, input.session.permission ?? []),
            ).action === "deny",
        ),
      ),
    ask: (req) =>
      Effect.gen(function* () {
        const request = {
          sessionID: input.session.id,
          tool: { messageID: input.processor.message.id, callID: options.toolCallId },
          ruleset: Permission.merge(input.agent.permission, input.session.permission ?? []),
        }
        if (req.permission === "edit" && !req.metadata?.command) {
          const instance = yield* InstanceState.context
          yield* rememberRead(
            options.toolCallId,
            req.patterns.map((pattern) => path.resolve(instance.worktree, pattern)),
          )
          yield* assertWritable(
            {
              sessionID: input.session.id,
              parentID: input.session.parentID,
              getOwnedPaths: () =>
                Effect.sync(() => TaskClaims.trustedPaths(input.session.id, input.session.parentID !== undefined)),
              inFamily,
            },
            { files: req.patterns.map((pattern) => path.resolve(instance.worktree, pattern)) },
          )
        }
        yield* permission.ask({ ...req, ...request })
        if (req.permission !== "edit") return
        const instance = yield* InstanceState.context
        // A file Vector reads into an agent's prompt or permissions asks again, every time and in every session, after
        // the edit rules allowed the change: whichever tool writes it, and whatever configuration or a client allows.
        const sources = yield* prompts()
        const sourced = req.patterns.filter((pattern) =>
          PromptSource.is(path.resolve(instance.worktree, pattern), sources),
        )
        if (sourced.length > 0) {
          yield* permission.ask({
            permission: PermissionPolicy.PROMPT_SOURCE,
            patterns: sourced,
            always: [],
            metadata: req.metadata,
            ...request,
          })
          prompted.set(options.toolCallId, [
            ...(prompted.get(options.toolCallId) ?? []),
            ...sourced.map((pattern) => path.resolve(instance.worktree, pattern)),
          ])
        }
        // A line in a file memory is read from binds every later request, so planted text must not land in one unseen:
        // a session that took in outside content asks every time before it changes one, whichever tool writes it (an
        // edit, a patch or a shell redirect) and whatever the edit rules allow. A subagent always asks: it works from a
        // brief another agent wrote, which carries whatever that agent took in.
        const files = req.patterns.filter((pattern) =>
          SessionMemory.source(path.resolve(instance.worktree, pattern), brain.files()),
        )
        if (files.length === 0) return
        const hold = input.session.parentID ? "subagent" : SessionMemory.taint(yield* history())
        if (!hold) return
        yield* permission.ask({
          permission: PermissionPolicy.MEMORY_SOURCE,
          patterns: files,
          always: [],
          metadata: { ...req.metadata, hold },
          ...request,
        })
      }).pipe(Effect.orDie),
  })

  const builtinTask = (yield* registry.named()).task
  const decodeTask = Schema.decodeUnknownResult(builtinTask.parameters)
  for (const item of yield* registry.tools({
    modelID: ModelV2.ID.make(input.model.api.id),
    providerID: input.model.providerID,
    agent: input.agent,
  })) {
    const schema = ProviderTransform.schema(input.model, ToolJsonSchema.fromTool(item))
    tools[item.id] = tool({
      description: item.description,
      // The built-in Task advertises the concise batch form, while old model
      // calls and clients may still send a singular brief. Validate against its
      // real runtime decoder before tool hooks; changed plugin schemas keep the
      // existing validation path.
      inputSchema: jsonSchema(
        schema,
        ToolRegistry.isBuiltinTask(item)
          ? {
              validate(value) {
                const decoded = decodeTask(value)
                return Result.isSuccess(decoded)
                  ? { success: true, value: value as Record<string, unknown> }
                  : {
                      success: false,
                      error: new Error(builtinTask.formatValidationError?.(decoded.failure) ?? String(decoded.failure)),
                    }
              },
            }
          : undefined,
      ),
      execute(args, options) {
        return run.promise(
          Effect.gen(function* () {
            const ctx = context(args, options)
            yield* access.output(args).pipe(Effect.orDie)
            yield* plugin.trigger(
              "tool.execute.before",
              { tool: item.id, sessionID: ctx.sessionID, callID: ctx.callID },
              { args },
            )
            yield* access.output(args).pipe(Effect.orDie)
            const result = yield* item.execute(args, ctx).pipe(
              // The owner approved these changes, so they are not held at the next start.
              Effect.tap(() => PromptTrust.accept(prompted.get(options.toolCallId) ?? [])),
              Effect.ensuring(Effect.sync(() => prompted.delete(options.toolCallId))),
            )
            const output = {
              ...result,
              attachments: result.attachments?.map((attachment) => ({
                ...attachment,
                id: PartID.ascending(),
                sessionID: ctx.sessionID,
                messageID: input.processor.message.id,
              })),
            }
            // Before plugins: an after-hook must not receive a guest family's private raw output.
            yield* checked(options.toolCallId, output)
            yield* plugin.trigger(
              "tool.execute.after",
              { tool: item.id, sessionID: ctx.sessionID, callID: ctx.callID, args },
              output,
            )
            if (options.abortSignal?.aborted) {
              yield* input.processor.completeToolCall(options.toolCallId, output)
            }
            return output
          }).pipe(guarded),
        )
      },
    })
    if (ToolRegistry.isBuiltinPatch(item)) NativePatch.mark(tools[item.id])
  }

  // A research agent is offered its own tools alone, whatever a session's rules allow (RC1): no MCP tool or resource
  // reaches Deep research. What they return would be private text the outbound check does not see, and a resource's
  // address is the model's to write, so a hostile page could choose what is sent to an MCP server.
  if (Agent.researchTools(input.agent.name)) return tools

  const hasMcpResourceServer = Object.values(yield* mcp.clients()).some(
    (client) => !!client.getServerCapabilities()?.resources,
  )
  if (hasMcpResourceServer) {
    tools[MCP_RESOURCE_TOOLS.list] = tool({
      description:
        "Lists resources provided by connected MCP servers. Resources provide context such as files, database schemas, or application-specific information.",
      inputSchema: jsonSchema(
        ProviderTransform.schema(input.model, {
          type: "object",
          properties: {
            server: {
              type: "string",
              description: "Optional MCP server name. When omitted, lists resources from every connected server.",
            },
          },
          additionalProperties: false,
        }),
      ),
      execute(args, opts) {
        return run.promise(
          Effect.gen(function* () {
            const parsed = parseListMcpResourcesArgs(args)
            const ctx = context(toRecord(args), opts)
            const clients = yield* mcp.clients()
            const resourceServers = Object.entries(clients)
              .filter((entry) => !!entry[1].getServerCapabilities()?.resources)
              .map((entry) => entry[0])
              .sort((a, b) => a.localeCompare(b))
            if (parsed.server && !resourceServers.includes(parsed.server)) {
              throw new Error(
                resourceServers.length === 0
                  ? `MCP server "${parsed.server}" does not support resources`
                  : `MCP server "${parsed.server}" does not support resources. Available resource servers: ${resourceServers.join(", ")}`,
              )
            }
            const permissionPatterns = parsed.server
              ? [`mcp:${parsed.server}:*`]
              : resourceServers.map((server) => `mcp:${server}:*`)
            yield* plugin.trigger(
              "tool.execute.before",
              { tool: MCP_RESOURCE_TOOLS.list, sessionID: ctx.sessionID, callID: opts.toolCallId },
              { args },
            )
            yield* ctx.ask({
              permission: "read",
              metadata: parsed.server ? { server: parsed.server } : {},
              patterns: permissionPatterns,
              always: permissionPatterns,
            })

            const resources = Object.values(yield* mcp.resources(parsed.server))
            const filtered = resources
              .filter((resource) => !parsed.server || resource.client === parsed.server)
              .toSorted((a, b) =>
                (a.client + "\u0000" + a.name + "\u0000" + a.uri).localeCompare(
                  b.client + "\u0000" + b.name + "\u0000" + b.uri,
                ),
              )
            const content = JSON.stringify({ resources: filtered.map(formatMcpResource) }, null, 2)
            // A guest family's private raw text is refused before truncation saves it to a file.
            yield* access.output(content).pipe(Effect.orDie)
            const truncated = yield* truncate.output(content, {}, input.agent)
            const output = {
              title: parsed.server ? `MCP resources: ${parsed.server}` : "MCP resources",
              metadata: {
                count: filtered.length,
                servers: resourceServers,
                ...(parsed.server ? { server: parsed.server } : {}),
                truncated: truncated.truncated,
                ...(truncated.truncated && { outputPath: truncated.outputPath }),
              },
              output: truncated.content,
            }
            yield* plugin.trigger(
              "tool.execute.after",
              { tool: MCP_RESOURCE_TOOLS.list, sessionID: ctx.sessionID, callID: opts.toolCallId, args },
              output,
            )
            if (opts.abortSignal?.aborted) {
              yield* input.processor.completeToolCall(opts.toolCallId, output)
            }
            return output
          }).pipe(guarded),
        )
      },
    })

    tools[MCP_RESOURCE_TOOLS.listTemplates] = tool({
      description:
        "Lists resource templates provided by connected MCP servers. Resource templates are parameterized resources that can be read after filling in their URI template.",
      inputSchema: jsonSchema(
        ProviderTransform.schema(input.model, {
          type: "object",
          properties: {
            server: {
              type: "string",
              description:
                "Optional MCP server name. When omitted, lists resource templates from every connected server.",
            },
          },
          additionalProperties: false,
        }),
      ),
      execute(args, opts) {
        return run.promise(
          Effect.gen(function* () {
            const parsed = parseListMcpResourcesArgs(args)
            const ctx = context(toRecord(args), opts)
            const clients = yield* mcp.clients()
            const resourceServers = Object.entries(clients)
              .filter((entry) => !!entry[1].getServerCapabilities()?.resources)
              .map((entry) => entry[0])
              .sort((a, b) => a.localeCompare(b))
            if (parsed.server && !resourceServers.includes(parsed.server)) {
              throw new Error(
                resourceServers.length === 0
                  ? `MCP server "${parsed.server}" does not support resources`
                  : `MCP server "${parsed.server}" does not support resources. Available resource servers: ${resourceServers.join(", ")}`,
              )
            }
            const permissionPatterns = parsed.server
              ? [`mcp:${parsed.server}:*`]
              : resourceServers.map((server) => `mcp:${server}:*`)
            yield* plugin.trigger(
              "tool.execute.before",
              { tool: MCP_RESOURCE_TOOLS.listTemplates, sessionID: ctx.sessionID, callID: opts.toolCallId },
              { args },
            )
            yield* ctx.ask({
              permission: "read",
              metadata: parsed.server ? { server: parsed.server } : {},
              patterns: permissionPatterns,
              always: permissionPatterns,
            })

            const templates = Object.values(yield* mcp.resourceTemplates(parsed.server))
            const filtered = templates
              .filter((template) => !parsed.server || template.client === parsed.server)
              .toSorted((a, b) =>
                (a.client + "\u0000" + a.name + "\u0000" + a.uriTemplate).localeCompare(
                  b.client + "\u0000" + b.name + "\u0000" + b.uriTemplate,
                ),
              )
            const content = JSON.stringify({ resourceTemplates: filtered.map(formatMcpResourceTemplate) }, null, 2)
            // A guest family's private raw text is refused before truncation saves it to a file.
            yield* access.output(content).pipe(Effect.orDie)
            const truncated = yield* truncate.output(content, {}, input.agent)
            const output = {
              title: parsed.server ? `MCP resource templates: ${parsed.server}` : "MCP resource templates",
              metadata: {
                count: filtered.length,
                servers: resourceServers,
                ...(parsed.server ? { server: parsed.server } : {}),
                truncated: truncated.truncated,
                ...(truncated.truncated && { outputPath: truncated.outputPath }),
              },
              output: truncated.content,
            }
            yield* plugin.trigger(
              "tool.execute.after",
              { tool: MCP_RESOURCE_TOOLS.listTemplates, sessionID: ctx.sessionID, callID: opts.toolCallId, args },
              output,
            )
            if (opts.abortSignal?.aborted) {
              yield* input.processor.completeToolCall(opts.toolCallId, output)
            }
            return output
          }).pipe(guarded),
        )
      },
    })

    tools[MCP_RESOURCE_TOOLS.read] = tool({
      description:
        "Read a specific resource from an MCP server using the server name and resource URI. The URI is an MCP identifier and does not need to be a file URL.",
      inputSchema: jsonSchema(
        ProviderTransform.schema(input.model, {
          type: "object",
          properties: {
            server: {
              type: "string",
              description: "MCP server name exactly as returned by list_mcp_resources.",
            },
            uri: {
              type: "string",
              description: "Resource URI to read. Use the exact URI string returned by list_mcp_resources.",
            },
          },
          required: ["server", "uri"],
          additionalProperties: false,
        }),
      ),
      execute(args, opts) {
        return run.promise(
          Effect.gen(function* () {
            const parsed = parseReadMcpResourceArgs(args)
            const ctx = context(toRecord(args), opts)
            const clients = yield* mcp.clients()
            const client = clients[parsed.server]
            if (!client) {
              throw new Error(`MCP server "${parsed.server}" is not connected`)
            }
            if (!client.getServerCapabilities()?.resources) {
              throw new Error(`MCP server "${parsed.server}" does not support resources`)
            }
            yield* plugin.trigger(
              "tool.execute.before",
              { tool: MCP_RESOURCE_TOOLS.read, sessionID: ctx.sessionID, callID: opts.toolCallId },
              { args },
            )
            yield* ctx.ask({
              permission: "read",
              metadata: { server: parsed.server, uri: parsed.uri },
              patterns: [`mcp:${parsed.server}:${parsed.uri}`],
              always: [`mcp:${parsed.server}:*`],
            })

            const content = yield* mcp.readResource(parsed.server, parsed.uri)
            if (!content) throw new Error(`Failed to read MCP resource: ${parsed.server}/${parsed.uri}`)

            const formatted = formatMcpResourceContent(parsed.server, parsed.uri, content)
            // A guest family's private raw text is refused before truncation saves it to a file.
            yield* access.output(formatted.text).pipe(Effect.orDie)
            const truncated = yield* truncate.output(formatted.text, {}, input.agent)
            const output = {
              title: `MCP resource: ${parsed.uri}`,
              metadata: {
                server: parsed.server,
                uri: parsed.uri,
                contents: formatted.contents,
                attachments: formatted.attachments.length,
                truncated: truncated.truncated,
                ...(truncated.truncated && { outputPath: truncated.outputPath }),
              },
              output: truncated.content,
              attachments: formatted.attachments.map((attachment) => ({
                ...attachment,
                id: PartID.ascending(),
                sessionID: ctx.sessionID,
                messageID: input.processor.message.id,
              })),
            }
            yield* plugin.trigger(
              "tool.execute.after",
              { tool: MCP_RESOURCE_TOOLS.read, sessionID: ctx.sessionID, callID: opts.toolCallId, args },
              output,
            )
            if (opts.abortSignal?.aborted) {
              yield* input.processor.completeToolCall(opts.toolCallId, output)
            }
            return output
          }).pipe(guarded),
        )
      },
    })
  }

  const cloud = yield* mcp.cloudTools()
  for (const [key, item] of Object.entries(yield* mcp.tools())) {
    const execute = item.execute
    if (!execute) continue

    const schema = yield* Effect.promise(() => Promise.resolve(asSchema(item.inputSchema).jsonSchema))
    const transformed = ProviderTransform.schema(input.model, { ...schema, properties: schema.properties ?? {} })
    item.inputSchema = jsonSchema(transformed)
    item.execute = (args, opts) =>
      run.promise(
        Effect.gen(function* () {
          const ctx = context(args, opts)
          yield* access.output(args).pipe(Effect.orDie)
          yield* plugin.trigger(
            "tool.execute.before",
            { tool: key, sessionID: ctx.sessionID, callID: opts.toolCallId },
            { args },
          )
          const result: Awaited<ReturnType<NonNullable<typeof execute>>> = yield* Effect.gen(function* () {
            yield* ctx.ask({ permission: key, metadata: {}, patterns: ["*"], always: ["*"] })
            // A Vercel or Supabase server's tool that changes the account or
            // reads its data or keys asks again under vector_cloud, every time
            // (McpCloud), after its own permission so a denied tool is refused first.
            const account = cloud[key]
            if (account) {
              const input = JSON.stringify(args, null, 2)
              yield* ctx.ask({
                permission: account.permission,
                patterns: [[account.provider.toLowerCase(), "mcp", account.server, account.tool].join("/")],
                always: [],
                metadata: {
                  provider: account.provider,
                  environment: "account",
                  action: account.tool,
                  summary: `Call ${account.tool} on the "${account.server}" MCP server. It acts on the ${account.provider} account that server is signed in to, outside Vector Cloud.`,
                  statements: [{ label: "Input", sql: input.slice(0, 4000), length: input.length }],
                },
              })
            }
            return yield* Effect.promise(() => execute(args, opts))
          }).pipe(
            Effect.withSpan("Tool.execute", {
              attributes: {
                "tool.name": key,
                "tool.call_id": opts.toolCallId,
                "session.id": ctx.sessionID,
                "message.id": input.processor.message.id,
              },
            }),
          )
          // Before plugins and before truncation saves it: a guest family's private raw output is refused.
          yield* access.output(result).pipe(Effect.orDie)
          yield* plugin.trigger(
            "tool.execute.after",
            { tool: key, sessionID: ctx.sessionID, callID: opts.toolCallId, args },
            result,
          )

          const textParts: string[] = []
          const attachments: Omit<SessionV1.FilePart, "id" | "sessionID" | "messageID">[] = []
          for (const contentItem of result.content) {
            if (contentItem.type === "text") textParts.push(contentItem.text)
            else if (contentItem.type === "image") {
              attachments.push({
                type: "file",
                mime: contentItem.mimeType,
                url: `data:${contentItem.mimeType};base64,${contentItem.data}`,
              })
            } else if (contentItem.type === "resource") {
              const { resource } = contentItem
              if (resource.text) textParts.push(resource.text)
              if (resource.blob) {
                const mime = resource.mimeType ?? "application/octet-stream"
                const size = base64Size(resource.blob)
                if (!SUPPORTED_MCP_RESOURCE_ATTACHMENT_MIMES.has(mime)) {
                  textParts.push(
                    `[Binary MCP resource omitted: ${resource.uri} (${mime}, ${formatBytes(size)}) is not a supported attachment type]`,
                  )
                  continue
                }
                if (size > MAX_MCP_RESOURCE_BLOB_BYTES) {
                  textParts.push(
                    `[Binary MCP resource omitted: ${resource.uri} (${mime}, ${formatBytes(size)}) exceeds ${formatBytes(MAX_MCP_RESOURCE_BLOB_BYTES)}]`,
                  )
                  continue
                }
                attachments.push({
                  type: "file",
                  mime,
                  url: `data:${mime};base64,${resource.blob}`,
                  filename: resource.uri,
                })
              }
            }
          }

          const truncated = yield* truncate.output(textParts.join("\n\n"), {}, input.agent)
          const metadata = {
            ...result.metadata,
            truncated: truncated.truncated,
            ...(truncated.truncated && { outputPath: truncated.outputPath }),
          }

          const output = {
            title: "",
            metadata,
            output: truncated.content,
            attachments: attachments.map((attachment) => ({
              ...attachment,
              id: PartID.ascending(),
              sessionID: ctx.sessionID,
              messageID: input.processor.message.id,
            })),
            content: result.content,
          }
          if (opts.abortSignal?.aborted) {
            yield* input.processor.completeToolCall(opts.toolCallId, output)
          }
          return output
        }).pipe(guarded),
      )
    tools[key] = item
  }

  return tools
})

function toRecord(value: unknown) {
  if (isRecord(value)) return value
  return {}
}

function parseListMcpResourcesArgs(value: unknown) {
  const args = toRecord(value)
  return { server: optionalString(args, "server") }
}

function parseReadMcpResourceArgs(value: unknown) {
  const args = toRecord(value)
  return { server: requiredString(args, "server"), uri: requiredString(args, "uri") }
}

function optionalString(args: Record<string, unknown>, key: string) {
  const value = args[key]
  if (value === undefined || value === null || value === "") return undefined
  if (typeof value !== "string") throw new Error(`${key} must be a string`)
  return value
}

function requiredString(args: Record<string, unknown>, key: string) {
  const value = optionalString(args, key)
  if (value) return value
  throw new Error(`${key} is required`)
}

function formatMcpResource(resource: MCP.Resource) {
  const result = Object.fromEntries(Object.entries(resource).filter((entry) => entry[0] !== "client"))
  return { ...result, server: resource.client }
}

function formatMcpResourceTemplate(template: Record<string, unknown> & { client: string }) {
  const result = Object.fromEntries(Object.entries(template).filter((entry) => entry[0] !== "client"))
  return { ...result, server: template.client }
}

function formatMcpResourceContent(server: string, uri: string, content: { contents: unknown }) {
  const items = (Array.isArray(content.contents) ? content.contents : [content.contents]).filter(isRecord)
  const text: string[] = []
  const attachments: Omit<SessionV1.FilePart, "id" | "sessionID" | "messageID">[] = []

  for (const item of items) {
    const itemUri = typeof item.uri === "string" ? item.uri : uri
    const mime = typeof item.mimeType === "string" ? item.mimeType : "application/octet-stream"
    if (typeof item.text === "string") {
      text.push(`Resource: ${itemUri}\nMIME: ${mime}\n${item.text}`)
      continue
    }
    if (typeof item.blob === "string") {
      const size = base64Size(item.blob)
      if (!SUPPORTED_MCP_RESOURCE_ATTACHMENT_MIMES.has(mime)) {
        text.push(
          `[Binary MCP resource omitted: ${itemUri} (${mime}, ${formatBytes(size)}) is not a supported attachment type]`,
        )
        continue
      }
      if (size > MAX_MCP_RESOURCE_BLOB_BYTES) {
        text.push(
          `[Binary MCP resource omitted: ${itemUri} (${mime}, ${formatBytes(size)}) exceeds ${formatBytes(MAX_MCP_RESOURCE_BLOB_BYTES)}]`,
        )
        continue
      }
      text.push(`[Binary MCP resource attached: ${itemUri} (${mime})]`)
      attachments.push({
        type: "file",
        mime,
        url: `data:${mime};base64,${item.blob}`,
        filename: itemUri,
      })
      continue
    }
    text.push(`[MCP resource content without text or blob: ${itemUri}]`)
  }

  return {
    contents: items.length,
    attachments,
    text: text.join("\n\n") || `MCP resource ${uri} from ${server} returned no contents.`,
  }
}

function base64Size(value: string) {
  const trimmed = value.replace(/\s/g, "")
  const padding = trimmed.endsWith("==") ? 2 : trimmed.endsWith("=") ? 1 : 0
  return Math.max(0, Math.floor((trimmed.length * 3) / 4) - padding)
}

function formatBytes(value: number) {
  if (value < 1024) return `${value} B`
  if (value < 1024 * 1024) return `${Math.ceil(value / 1024)} KB`
  return `${Math.ceil(value / (1024 * 1024))} MB`
}

export * as SessionTools from "./tools"
