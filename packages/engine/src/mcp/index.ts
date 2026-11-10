import { mkdir } from "node:fs/promises"
import path from "node:path"
import type { Stream as NodeStream } from "node:stream"
import { LayerNode } from "@vectordevai/core/effect/layer-node"
import { untrustedChildEnvironment } from "@vectordevai/core/child-environment"
import { type Tool } from "ai"
import { ConfigV1 } from "@vectordevai/core/v1/config/config"
import { serviceUse } from "@vectordevai/core/effect/service-use"
import type { Client } from "@modelcontextprotocol/sdk/client/index.js"
import type { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { Egress } from "@vectordevai/core/local-mode/egress"
import type { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js"
import type { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"
import type { LoggingMessageNotification, Tool as MCPToolDef } from "@modelcontextprotocol/sdk/types.js"
import { Config } from "@/config/config"
import { Global } from "@vectordevai/core/global"
import { ConfigMCPV1 } from "@vectordevai/core/v1/config/mcp"
import { McpCloud } from "./cloud"
import { NamedError } from "@vectordevai/core/util/error"
import { withTimeout } from "@/util/timeout"
import { FSUtil } from "@vectordevai/core/fs-util"
import { Redaction } from "@vectordevai/core/redaction"
import { isRecord } from "@/util/record"
import { isDeepEqual, mergeDeep } from "remeda"
import { McpOAuthPendingProvider, McpOAuthProvider, OAUTH_CALLBACK_PATH } from "./oauth-provider"
import { McpOAuthCallback } from "./oauth-callback"
import { McpAuth } from "./auth"
import { EventV2Bridge } from "@/event-v2-bridge"
import { TuiEvent } from "@/server/tui-event"
import open from "open"
import { Cause, Effect, Exit, Layer, Context, Schema, Stream } from "effect"
import { EffectBridge } from "@/effect/bridge"
import { InstanceState } from "@/effect/instance-state"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import { CrossSpawnSpawner } from "@vectordevai/core/cross-spawn-spawner"
import { McpCatalog } from "./catalog"
import { McpEvent } from "@vectordevai/schema/mcp-event"
import { WorkspaceTrust } from "@vectordevai/core/workspace-trust/workspace-trust"
import { TaskPlace } from "@/task/place"

const DEFAULT_TIMEOUT = 30_000
// Longest single stderr chunk that is written to the log.
const STDERR_CHUNK_LIMIT = 2_048
// Total stderr logged per server process; anything beyond is drained silently.
const STDERR_TOTAL_LIMIT = 64 * 1024
// Consecutive request timeouts before a live-but-unresponsive server is dropped.
const TIMEOUT_STRIKES = 2

/**
 * Keep a local server's stderr flowing. The SDK pipes the child's stderr into a
 * PassThrough that nobody reads; once it fills the OS pipe backs up and the
 * server blocks on write(2). It then never answers another request, every call
 * times out, and because the process is still alive onclose never fires. The
 * drain is what matters; logging is bounded so a chatty server cannot flood
 * the log.
 */
export function drainStderr(stream: NodeStream | null | undefined, log: (text: string) => void) {
  if (!stream) return
  let logged = 0
  stream.on("error", () => {})
  stream.on("data", (chunk: Buffer | string) => {
    if (logged > STDERR_TOTAL_LIMIT) return
    const text = (typeof chunk === "string" ? chunk : chunk.toString("utf8")).trim()
    if (!text) return
    logged += text.length
    if (logged > STDERR_TOTAL_LIMIT) {
      log(`stderr output exceeded ${STDERR_TOTAL_LIMIT} bytes; further output is discarded`)
      return
    }
    log(
      text.length > STDERR_CHUNK_LIMIT
        ? `${text.slice(0, STDERR_CHUNK_LIMIT)}… (${text.length - STDERR_CHUNK_LIMIT} more bytes)`
        : text,
    )
  })
}

// The SDK loads with the first connection rather than with the engine; see ./sdk.
const loadSdk = Effect.promise(() => import("./sdk"))

export const Resource = Schema.Struct({
  name: Schema.String,
  uri: Schema.String,
  description: Schema.optional(Schema.String),
  mimeType: Schema.optional(Schema.String),
  client: Schema.String,
}).annotate({ identifier: "McpResource" })
export type Resource = Schema.Schema.Type<typeof Resource>

export const ToolsChanged = McpEvent.ToolsChanged

export const BrowserOpenFailed = McpEvent.BrowserOpenFailed

export const Failed = NamedError.create("MCPFailed", {
  name: Schema.String,
})

export class NotFoundError extends Schema.TaggedErrorClass<NotFoundError>()("MCP.NotFoundError", {
  name: Schema.String,
}) {}

type MCPClient = Client

const StatusConnected = Schema.Struct({ status: Schema.Literal("connected") }).annotate({
  identifier: "MCPStatusConnected",
})
const StatusDisabled = Schema.Struct({ status: Schema.Literal("disabled") }).annotate({
  identifier: "MCPStatusDisabled",
})
const StatusFailed = Schema.Struct({ status: Schema.Literal("failed"), error: Schema.String }).annotate({
  identifier: "MCPStatusFailed",
})
const StatusNeedsAuth = Schema.Struct({ status: Schema.Literal("needs_auth") }).annotate({
  identifier: "MCPStatusNeedsAuth",
})
const StatusNeedsClientRegistration = Schema.Struct({
  status: Schema.Literal("needs_client_registration"),
  error: Schema.String,
}).annotate({ identifier: "MCPStatusNeedsClientRegistration" })

export const Status = Schema.Union([
  StatusConnected,
  StatusDisabled,
  StatusFailed,
  StatusNeedsAuth,
  StatusNeedsClientRegistration,
]).annotate({ identifier: "MCPStatus", discriminator: "status" })
export type Status = Schema.Schema.Type<typeof Status>

// Store transports for OAuth servers to allow finishing auth
type TransportWithAuth = StreamableHTTPClientTransport | SSEClientTransport
const pendingOAuthTransports = new Map<string, { transport: TransportWithAuth; provider?: McpOAuthPendingProvider }>()

// Prompt cache types
type PromptInfo = Awaited<ReturnType<MCPClient["listPrompts"]>>["prompts"][number]
type ResourceInfo = Awaited<ReturnType<MCPClient["listResources"]>>["resources"][number]
type ResourceTemplateInfo = Awaited<ReturnType<MCPClient["listResourceTemplates"]>>["resourceTemplates"][number]
type McpEntry = NonNullable<ConfigV1.Info["mcp"]>[string]

function isMcpConfigured(entry: McpEntry): entry is ConfigMCPV1.Info {
  return typeof entry === "object" && entry !== null && "type" in entry
}

function validMcpName(name: string) {
  return name.trim() === name && name.length > 0 && name.length <= 256 && !Object.hasOwn(Object.prototype, name)
}

const credentialReference = String.raw`\{(?:env|vault):[A-Za-z_][A-Za-z0-9_]*\}`

function unsafeCredentialHeader(headers?: Record<string, string>) {
  if (!headers) return
  return Object.entries(headers).find(
    ([name, value]) =>
      (/^(authorization|cookie|proxy-authorization)$/i.test(name) ||
        /(?:^|[-_])(?:api[-_]?key|token|secret|password)(?:$|[-_])/i.test(name)) &&
      !new RegExp(`^\\s*(?:(?:Bearer|Basic|Token)\\s+)?${credentialReference}\\s*$`, "i").test(value),
  )?.[0]
}

export function resolveMcpValue(
  value: string,
  label: string,
  environment: Record<string, string | undefined> = process.env,
  secrets: Record<string, string> = {},
) {
  return value
    .replace(/\{env:([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, variable: string) => {
      const resolved = environment[variable]
      if (resolved === undefined) throw new Error(`${label} requires environment variable ${variable}.`)
      return resolved
    })
    .replace(/\{vault:([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, key: string) => {
      const resolved = secrets[key]
      if (resolved === undefined) throw new Error(`${label} requires a credential named ${key}.`)
      return resolved
    })
}

export function resolveMcpHeaders(
  headers: Record<string, string> | undefined,
  environment: Record<string, string | undefined> = process.env,
  secrets: Record<string, string> = {},
) {
  if (!headers) return
  return Object.fromEntries(
    Object.entries(headers).map(([name, value]) => [
      name,
      resolveMcpValue(value, `MCP header "${name}"`, environment, secrets),
    ]),
  )
}

// A trusted project's local server runs the command its trust approval bound: an absolute
// executable or a copy in the approved snapshot. A client that sends that command back
// unchanged keeps the command and cwd its config file declares, instead of writing the
// bound paths into the file.
function declaredMcp(mcp: ConfigMCPV1.Info, configured: unknown, onDisk: Record<string, unknown>): ConfigMCPV1.Info {
  if (mcp.type !== "local" || !isRecord(configured) || !Array.isArray(onDisk.command)) return mcp
  if (!isDeepEqual(mcp.command, configured.command) || mcp.cwd !== configured.cwd) return mcp
  if (!onDisk.command.every((item): item is string => typeof item === "string")) return mcp
  return { ...mcp, command: onDisk.command, cwd: typeof onDisk.cwd === "string" ? onDisk.cwd : undefined }
}

// A remote MCP server's requests, labelled so Vector Local decides and logs each one (mcp-remote). With Vector Local
// off they go out as they are.
function remoteFetch(input: string | URL, init?: RequestInit) {
  return Egress.fetch("mcp-remote", input, init)
}

function remoteURL(value: string) {
  if (!WorkspaceTrust.userRemoteUrlAllowed(value)) return
  const url = new URL(value)
  return url
}

interface CreateResult {
  mcpClient?: MCPClient
  status: Status
  defs?: MCPToolDef[]
  instructions?: string
}

interface AuthResult {
  authorizationUrl: string
  oauthState: string
  client?: MCPClient
}

// --- Effect Service ---

interface State {
  config: Record<string, ConfigMCPV1.Info>
  status: Record<string, Status>
  clients: Record<string, MCPClient>
  defs: Record<string, MCPToolDef[]>
  instructions: Record<string, string>
  removed: Set<string>
  // Consecutive request timeouts per server; reset by any answered request.
  timeouts: Record<string, number>
}

export interface ServerInstructions {
  name: string
  instructions: string
  tools: string[]
}

export interface Interface {
  readonly status: () => Effect.Effect<Record<string, Status>>
  readonly clients: () => Effect.Effect<Record<string, MCPClient>>
  readonly instructions: () => Effect.Effect<ServerInstructions[]>
  readonly tools: () => Effect.Effect<Record<string, Tool>>
  /** Tools of Vercel's and Supabase's own MCP servers that ask under a vector_cloud permission, by tool key. */
  readonly cloudTools: () => Effect.Effect<Record<string, McpCloud.Request>>
  readonly prompts: () => Effect.Effect<Record<string, PromptInfo & { client: string }>>
  readonly resources: (clientName?: string) => Effect.Effect<Record<string, ResourceInfo & { client: string }>>
  readonly resourceTemplates: (
    clientName?: string,
  ) => Effect.Effect<Record<string, ResourceTemplateInfo & { client: string }>>
  readonly add: (
    name: string,
    mcp: ConfigMCPV1.Info,
    secrets?: Record<string, string>,
  ) => Effect.Effect<{ status: Record<string, Status> | Status }>
  readonly remove: (name: string) => Effect.Effect<void, NotFoundError>
  readonly connect: (name: string) => Effect.Effect<void, NotFoundError>
  readonly disconnect: (name: string) => Effect.Effect<void, NotFoundError>
  readonly getPrompt: (
    clientName: string,
    name: string,
    args?: Record<string, string>,
  ) => Effect.Effect<Awaited<ReturnType<MCPClient["getPrompt"]>> | undefined>
  readonly readResource: (
    clientName: string,
    resourceUri: string,
  ) => Effect.Effect<Awaited<ReturnType<MCPClient["readResource"]>> | undefined>
  readonly startAuth: (
    mcpName: string,
  ) => Effect.Effect<{ authorizationUrl: string; oauthState: string }, NotFoundError>
  readonly authenticate: (
    mcpName: string,
    onAuthorization?: (authorizationUrl: string) => void,
  ) => Effect.Effect<Status, NotFoundError>
  readonly finishAuth: (mcpName: string, authorizationCode: string) => Effect.Effect<Status, NotFoundError>
  readonly removeAuth: (mcpName: string) => Effect.Effect<void>
  readonly supportsOAuth: (mcpName: string) => Effect.Effect<boolean, NotFoundError>
  readonly hasStoredTokens: (mcpName: string) => Effect.Effect<boolean>
  readonly getAuthStatus: (mcpName: string) => Effect.Effect<AuthStatus>
}

export class Service extends Context.Service<Service, Interface>()("@vector/MCP") {}

export const use = serviceUse(Service)

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    const auth = yield* McpAuth.Service
    const events = yield* EventV2Bridge.Service
    const cfgSvc = yield* Config.Service

    type Transport = StdioClientTransport | StreamableHTTPClientTransport | SSEClientTransport

    /**
     * Connect a client via the given transport with resource safety:
     * on failure the transport is closed; on success the caller owns it.
     */
    const connectTransport = Effect.fn("MCP.connectTransport")(function* (transport: Transport, timeout: number) {
      const directory = yield* InstanceState.directory
      const sdk = yield* loadSdk
      return yield* Effect.acquireUseRelease(
        Effect.succeed(transport),
        (t) =>
          Effect.tryPromise({
            try: () => {
              const client = sdk.createClient(directory)
              return withTimeout(client.connect(t), timeout).then(() => client)
            },
            catch: (e) => (e instanceof Error ? e : new Error(String(e))),
          }),
        (t, exit) => (Exit.isFailure(exit) ? Effect.tryPromise(() => t.close()).pipe(Effect.ignore) : Effect.void),
      )
    })

    const DISABLED_RESULT: CreateResult = { status: { status: "disabled" } }

    const disabledByIsolation = Effect.fn("MCP.disabledByIsolation")(function* () {
      const ctx = yield* InstanceState.context
      if (!TaskPlace.isTaskDirectory(ctx.directory) && !TaskPlace.isTaskDirectory(ctx.worktree)) return false
      return (yield* cfgSvc.get()).sizing?.subagents?.isolation?.mcp !== true
    })

    const connectRemote = Effect.fn("MCP.connectRemote")(function* (
      key: string,
      mcp: ConfigMCPV1.Info & { type: "remote" },
    ) {
      const secrets = (yield* auth.get(key))?.secrets ?? {}
      const oauthDisabled = mcp.oauth === false
      const oauthConfig = typeof mcp.oauth === "object" ? mcp.oauth : undefined
      const url = remoteURL(mcp.url)
      if (!url) {
        return {
          client: undefined as MCPClient | undefined,
          status: { status: "failed" as const, error: `Invalid MCP URL for "${key}"` },
        }
      }
      // Vector Local decides a remote MCP server by its host before connecting: one on this computer or on the list,
      // or a source the user allowed. Its requests, sign-in included, then go through the labelled fetch below.
      const decided = Egress.decide({ source: "mcp-remote", url })
      if (decided.decision !== "allow")
        return {
          client: undefined as MCPClient | undefined,
          status: { status: "failed" as const, error: `Off in Vector Local: ${decided.reason}` },
        }
      let authProvider: McpOAuthProvider | undefined

      if (!oauthDisabled) {
        authProvider = new McpOAuthProvider(
          key,
          mcp.url,
          {
            clientId: oauthConfig?.clientId,
            clientSecret: oauthConfig?.clientSecret,
            scope: oauthConfig?.scope,
            callbackPort: oauthConfig?.callbackPort,
            redirectUri: oauthConfig?.redirectUri,
          },
          {
            onRedirect: async () => {},
          },
          auth,
        )
      }

      const headers = resolveMcpHeaders(mcp.headers, process.env, secrets)
      const sdk = yield* loadSdk
      const transports: Array<{ name: string; transport: TransportWithAuth }> = [
        {
          name: "StreamableHTTP",
          transport: new sdk.StreamableHTTPClientTransport(url, {
            authProvider,
            requestInit: headers ? { headers } : undefined,
            fetch: remoteFetch,
          }),
        },
        {
          name: "SSE",
          transport: new sdk.SSEClientTransport(url, {
            authProvider,
            requestInit: headers ? { headers } : undefined,
            fetch: remoteFetch,
          }),
        },
      ]

      const connectTimeout = mcp.timeout ?? DEFAULT_TIMEOUT
      let lastStatus: Status | undefined

      for (const { name, transport } of transports) {
        const result = yield* connectTransport(transport, connectTimeout).pipe(
          Effect.map((client) => ({ client, transportName: name })),
          Effect.catch((error) => {
            const lastError = error instanceof Error ? error : new Error(String(error))
            const isAuthError =
              error instanceof sdk.UnauthorizedError || (authProvider && lastError.message.includes("OAuth"))

            if (isAuthError) {
              if (lastError.message.includes("registration") || lastError.message.includes("client_id")) {
                lastStatus = {
                  status: "needs_client_registration" as const,
                  error: "Server does not support dynamic client registration. Please provide clientId in config.",
                }
                return events
                  .publish(TuiEvent.ToastShow, {
                    title: "MCP Authentication Required",
                    message: `Server "${key}" requires a pre-registered client ID. Add clientId to your config.`,
                    variant: "warning",
                    duration: 8000,
                  })
                  .pipe(Effect.ignore, Effect.as(undefined))
              } else {
                pendingOAuthTransports.set(key, { transport })
                lastStatus = { status: "needs_auth" as const }
                return events
                  .publish(TuiEvent.ToastShow, {
                    title: "MCP Authentication Required",
                    message: `Server "${key}" requires authentication. Open MCP in Vector and choose Connect.`,
                    variant: "warning",
                    duration: 8000,
                  })
                  .pipe(Effect.ignore, Effect.as(undefined))
              }
            }

            lastStatus = { status: "failed" as const, error: lastError.message }
            return Effect.void
          }),
        )
        if (result) return { client: result.client, status: { status: "connected" } as Status }
        // If this was an auth error, stop trying other transports
        if (lastStatus?.status === "needs_auth" || lastStatus?.status === "needs_client_registration") break
      }

      return {
        client: undefined as MCPClient | undefined,
        status: (lastStatus ?? { status: "failed", error: "Unknown error" }) as Status,
      }
    })

    const connectLocal = Effect.fn("MCP.connectLocal")(function* (
      key: string,
      mcp: ConfigMCPV1.Info & { type: "local" },
    ) {
      const secrets = (yield* auth.get(key))?.secrets ?? {}
      const [cmd, ...args] = mcp.command.map((value) =>
        resolveMcpValue(value, `MCP command for "${key}"`, process.env, secrets),
      )
      // Inside an untrusted project the project's own files would take a server from the user's config over: its
      // node_modules and .npmrc steer npx, and python -m imports from the working directory. So until the project is
      // trusted the server starts in an empty directory of Vector's instead.
      const baseDir = (yield* cfgSvc.trust()).trusted
        ? yield* InstanceState.directory
        : yield* Effect.promise(async () => {
            const directory = path.join(Global.Path.state, "mcp", "untrusted-workspace")
            await mkdir(directory, { recursive: true })
            return directory
          })
      const cwd = mcp.cwd ? path.resolve(baseDir, mcp.cwd) : baseDir
      const environment = mcp.environment
        ? Object.fromEntries(
            Object.entries(mcp.environment).map(([name, value]) => [
              name,
              resolveMcpValue(value, `MCP environment variable ${name}`, process.env, secrets),
            ]),
          )
        : undefined
      const bridge = yield* EffectBridge.make()
      const sdk = yield* loadSdk
      const transport = new sdk.StdioClientTransport({
        stderr: "pipe",
        command: cmd,
        args,
        cwd,
        env: untrustedChildEnvironment(process.env, cmd === "vector" ? { BUN_BE_BUN: "1" } : undefined, environment),
      })
      drainStderr(transport.stderr, (output) =>
        bridge.fork(Effect.logWarning("MCP server stderr", { server: key, output }).pipe(Effect.ignore)),
      )

      const connectTimeout = mcp.timeout ?? DEFAULT_TIMEOUT
      return yield* connectTransport(transport, connectTimeout).pipe(
        Effect.map((client): { client: MCPClient | undefined; status: Status } => ({
          client,
          status: { status: "connected" },
        })),
        Effect.catch((error): Effect.Effect<{ client: MCPClient | undefined; status: Status }> => {
          const msg = error instanceof Error ? error.message : String(error)
          return Effect.succeed({ client: undefined, status: { status: "failed", error: msg } })
        }),
      )
    })

    const create = Effect.fn("MCP.create")(
      function* (key: string, mcp: ConfigMCPV1.Info) {
        if (yield* disabledByIsolation()) return DISABLED_RESULT
        if (mcp.enabled === false) {
          return DISABLED_RESULT
        }
        const { client: mcpClient, status } =
          mcp.type === "remote"
            ? yield* connectRemote(key, mcp as ConfigMCPV1.Info & { type: "remote" })
            : yield* connectLocal(key, mcp as ConfigMCPV1.Info & { type: "local" })

        if (!mcpClient) {
          if (status.status !== "connected" && status.status !== "disabled") {
            yield* Effect.logWarning("server unavailable", { key, type: mcp.type, status: status.status })
          }
          return { status } satisfies CreateResult
        }

        return yield* Effect.gen(function* () {
          const listed = mcpClient.getServerCapabilities()?.tools ? yield* McpCatalog.defs(mcpClient, mcp.timeout) : []
          if (!listed) {
            return yield* Effect.fail(new Error("Failed to get tools"))
          }
          return {
            mcpClient,
            status,
            defs: listed,
            instructions: mcpClient.getInstructions()?.trim(),
          } satisfies CreateResult
        }).pipe(
          // onError also runs when the load is interrupted while listing tools, which catchCause would skip.
          Effect.onError(() => Effect.tryPromise(() => mcpClient.close()).pipe(Effect.ignore)),
        )
      },
      Effect.map((result): CreateResult => result),
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) return Effect.interrupt
        const error = Cause.squash(cause)
        return Effect.succeed<CreateResult>({
          status: { status: "failed", error: error instanceof Error ? error.message : String(error) },
        })
      }),
    )
    const descendants = Effect.fnUntraced(
      function* (pid: number) {
        if (process.platform === "win32") return [] as number[]
        const pids: number[] = []
        const queue = [pid]
        for (let index = 0; index < queue.length; index++) {
          const current = queue[index]
          const handle = yield* spawner.spawn(ChildProcess.make("pgrep", ["-P", String(current)], { stdin: "ignore" }))
          const text = yield* Stream.mkString(Stream.decodeText(handle.stdout))
          yield* handle.exitCode
          for (const tok of text.split("\n")) {
            const cpid = parseInt(tok, 10)
            if (!isNaN(cpid) && !pids.includes(cpid)) {
              pids.push(cpid)
              queue.push(cpid)
            }
          }
        }
        return pids
      },
      Effect.scoped,
      Effect.catch(() => Effect.succeed([] as number[])),
    )

    function watch(
      sdk: typeof import("./sdk"),
      s: State,
      name: string,
      client: MCPClient,
      bridge: EffectBridge.Shape,
      timeout?: number,
    ) {
      client.onclose = () => {
        if (s.clients[name] !== client) return
        delete s.clients[name]
        delete s.defs[name]
        delete s.instructions[name]
        s.status[name] = { status: "failed", error: "Connection closed" }
        bridge.fork(
          Effect.logWarning("MCP connection closed", { server: name }).pipe(
            Effect.andThen(events.publish(ToolsChanged, { server: name })),
            Effect.ignore,
          ),
        )
      }

      client.setNotificationHandler(sdk.LoggingMessageNotificationSchema, (notification) =>
        bridge.promise(serverLog(name, notification.params)),
      )

      if (!client.getServerCapabilities()?.tools) return
      client.setNotificationHandler(sdk.ToolListChangedNotificationSchema, async () => {
        if (s.clients[name] !== client || s.status[name]?.status !== "connected") return

        const listed = await bridge.promise(McpCatalog.defs(client, timeout))
        if (!listed) return
        if (s.clients[name] !== client || s.status[name]?.status !== "connected") return

        s.defs[name] = listed
        await bridge.promise(events.publish(ToolsChanged, { server: name }).pipe(Effect.ignore))
      })
    }

    function serverLog(name: string, params: LoggingMessageNotification["params"]) {
      const fields = { server: name, logger: params.logger, level: params.level, data: params.data }
      switch (params.level) {
        case "debug":
          return Effect.logDebug("MCP server log", fields)
        case "info":
        case "notice":
          return Effect.logInfo("MCP server log", fields)
        case "warning":
          return Effect.logWarning("MCP server log", fields)
        case "error":
        case "critical":
        case "alert":
        case "emergency":
          return Effect.logError("MCP server log", fields)
      }
    }

    const state = yield* InstanceState.make<State>(
      Effect.fn("MCP.state")(function* () {
        const cfg = yield* cfgSvc.get()
        const config = cfg.mcp ?? {}
        const s: State = {
          config: {},
          status: {},
          clients: {},
          defs: {},
          instructions: {},
          removed: new Set(),
          timeouts: {},
        }
        if (yield* disabledByIsolation()) {
          for (const [name, entry] of Object.entries(config)) {
            if (validMcpName(name) && isMcpConfigured(entry)) s.status[name] = { status: "disabled" }
          }
          return s
        }
        const bridge = yield* EffectBridge.make()

        // Register cleanup before connecting: an interrupted load (a stop during cold start) closes this scope
        // before the retry, and every client already stored in s.clients must be closed with it.
        yield* Effect.addFinalizer(() =>
          Effect.gen(function* () {
            const clients = Object.values(s.clients)
            s.clients = {}
            s.defs = {}
            s.instructions = {}
            yield* Effect.forEach(
              clients,
              (client) =>
                Effect.gen(function* () {
                  const sdk = yield* loadSdk
                  const pid = client.transport instanceof sdk.StdioClientTransport ? client.transport.pid : null
                  if (typeof pid === "number") {
                    const pids = yield* descendants(pid)
                    for (const dpid of pids) {
                      try {
                        process.kill(dpid, "SIGTERM")
                      } catch {}
                    }
                  }
                  yield* Effect.tryPromise(() => client.close()).pipe(Effect.ignore)
                }),
              { concurrency: "unbounded" },
            )
            pendingOAuthTransports.clear()
          }),
        )

        yield* Effect.forEach(
          Object.entries(config),
          ([key, mcp]) =>
            Effect.gen(function* () {
              if (!validMcpName(key)) {
                yield* Effect.logError("Ignoring MCP config entry with invalid name", { key })
                return
              }
              if (!isMcpConfigured(mcp)) {
                yield* Effect.logError("Ignoring MCP config entry without type", { key })
                return
              }

              if (mcp.enabled === false) {
                s.status[key] = { status: "disabled" }
                return
              }

              const result = yield* create(key, mcp)
              s.status[key] = result.status
              if (result.mcpClient) {
                const sdk = yield* loadSdk
                s.clients[key] = result.mcpClient
                s.defs[key] = result.defs!
                if (result.instructions) s.instructions[key] = result.instructions
                watch(sdk, s, key, result.mcpClient, bridge, mcp.timeout)
              }
            }),
          { concurrency: "unbounded" },
        )

        return s
      }),
    )

    function closeClient(s: State, name: string) {
      const client = s.clients[name]
      delete s.clients[name]
      delete s.defs[name]
      delete s.instructions[name]
      delete s.timeouts[name]
      if (!client) return Effect.void
      return Effect.tryPromise(() => client.close()).pipe(Effect.ignore)
    }

    /**
     * Record the outcome of a request to a server. Two consecutive timeouts mean
     * the server is wedged: alive, so onclose never fires, but not answering.
     * Drop the client and mark the server failed so the UI offers Connect again
     * instead of caching a dead client until restart.
     */
    const settle = Effect.fnUntraced(function* (
      s: State,
      name: string,
      client: MCPClient,
      error?: unknown,
      signal?: AbortSignal,
    ) {
      if (s.clients[name] !== client) return
      // A cancelled call is not evidence either way: the server never got the
      // chance to answer, so leave the strike count where it was rather than
      // letting a cancel between two timeouts hide a wedged server forever.
      if (signal?.aborted) return
      const sdk = yield* loadSdk
      if (!sdk.isRequestTimeout(error, signal)) {
        delete s.timeouts[name]
        return
      }
      const strikes = (s.timeouts[name] ?? 0) + 1
      s.timeouts[name] = strikes
      if (strikes < TIMEOUT_STRIKES) return
      yield* Effect.logWarning("MCP server stopped responding", { server: name, timeouts: strikes })
      yield* closeClient(s, name)
      // Closing waits on the child process, which can take seconds. If the user
      // reconnected in that window, the entry now holds a fresh, healthy client
      // and marking the server failed would wrongly disable it.
      if (s.clients[name]) return
      s.status[name] = { status: "failed", error: "Server stopped responding; reconnect it" }
      yield* events.publish(ToolsChanged, { server: name }).pipe(Effect.ignore)
    })

    const storeClient = Effect.fnUntraced(function* (
      s: State,
      name: string,
      client: MCPClient,
      listed: MCPToolDef[],
      instructions: string | undefined,
      timeout?: number,
    ) {
      const bridge = yield* EffectBridge.make()
      const sdk = yield* loadSdk
      const previous = s.clients[name]
      s.status[name] = { status: "connected" }
      s.clients[name] = client
      delete s.timeouts[name]
      s.defs[name] = listed
      if (instructions) s.instructions[name] = instructions
      else delete s.instructions[name]
      watch(sdk, s, name, client, bridge, timeout)
      if (previous) yield* Effect.tryPromise(() => previous.close()).pipe(Effect.ignore)
      return s.status[name]
    })

    const status = Effect.fn("MCP.status")(function* () {
      const s = yield* InstanceState.get(state)

      const cfg = yield* cfgSvc.get()
      const config = cfg.mcp ?? {}
      const result: Record<string, Status> = {}

      for (const [key, mcp] of Object.entries(config)) {
        if (!validMcpName(key)) continue
        if (!isMcpConfigured(mcp)) continue
        if (s.removed.has(key)) continue
        result[key] = s.status[key] ?? { status: "disabled" }
      }

      for (const key of Object.keys(s.config)) {
        result[key] = s.status[key] ?? { status: "disabled" }
      }

      return result
    })

    const clients = Effect.fn("MCP.clients")(function* () {
      const s = yield* InstanceState.get(state)
      return s.clients
    })

    const instructions = Effect.fn("MCP.instructions")(function* () {
      const s = yield* InstanceState.get(state)
      return Object.entries(s.instructions)
        .filter(([name]) => s.status[name]?.status === "connected")
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([name, item]) => ({
          name,
          instructions: item,
          tools: (s.defs[name] ?? []).map((tool) => McpCatalog.toolName(name, tool.name)),
        }))
    })

    const createAndStore = Effect.fn("MCP.createAndStore")(function* (name: string, mcp: ConfigMCPV1.Info) {
      const s = yield* InstanceState.get(state)
      const result = yield* create(name, mcp)

      s.status[name] = result.status
      if (!result.mcpClient) {
        yield* closeClient(s, name)
        delete s.clients[name]
        return result.status
      }

      return yield* storeClient(s, name, result.mcpClient, result.defs!, result.instructions, mcp.timeout)
    })

    // add/connect/disconnect mutate instance state only; mirror the intent into the
    // project's integration store so it survives a backend restart. Persistence failure
    // must not undo the runtime change, so surface it instead of failing the request.
    const persistConfig = Effect.fnUntraced(function* (name: string, entry: ConfigMCPV1.Info | { enabled: boolean }) {
      yield* cfgSvc.updateMcpLocal(name, entry).pipe(
        Effect.catchCause((cause) =>
          Effect.logError("failed to persist MCP server config", {
            name,
            error: String(Cause.squash(cause)),
          }).pipe(
            Effect.andThen(
              events
                .publish(TuiEvent.ToastShow, {
                  title: "MCP config not saved",
                  message: `Could not save "${name}"; the change may not survive a restart.`,
                  variant: "warning",
                  duration: 8000,
                })
                .pipe(Effect.ignore),
            ),
          ),
        ),
      )
    })

    const add = Effect.fn("MCP.add")(function* (
      name: string,
      input: ConfigMCPV1.Info,
      secrets?: Record<string, string>,
    ) {
      if (!validMcpName(name)) {
        return {
          status: {
            status: "failed",
            error: "MCP server names must be between 1 and 256 characters and cannot use reserved object keys.",
          } satisfies Status,
        }
      }
      // Clients read config with secrets replaced by Redaction.MARKER. One that
      // sends an entry back unchanged keeps the stored values, not the marker.
      // Loaded config and runtime state hold {env:...} references already resolved,
      // so the config files win wherever they hold a value; the others only fill
      // what no file holds, such as a remote config or a save that failed.
      const configured = (yield* cfgSvc.get()).mcp?.[name]
      const running = (yield* InstanceState.get(state)).config[name]
      const onDisk = yield* cfgSvc.storedMcp(name)
      const stored = [configured, running, onDisk]
        .filter(isRecord)
        .reduce<Record<string, unknown>>((merged, entry) => mergeDeep(merged, entry), {})
      const mcp = Redaction.restore(input, stored)
      const unsafeHeader = mcp.type === "remote" ? unsafeCredentialHeader(mcp.headers) : undefined
      if (mcp.type === "remote" && !remoteURL(mcp.url)) {
        return {
          status: {
            status: "failed",
            error:
              "MCP remote URLs must use HTTPS (HTTP only on your own machine or network) and cannot contain embedded credentials.",
          } satisfies Status,
        }
      }
      // Restoring drops a command whose masked secret nothing stored can fill.
      if (mcp.type === "local" && (!mcp.command?.length || !mcp.command[0]?.trim())) {
        return {
          status: {
            status: "failed",
            error: "Local MCP servers require a command to run.",
          } satisfies Status,
        }
      }
      if (unsafeHeader) {
        return {
          status: {
            status: "failed",
            error: `MCP header "${unsafeHeader}" must reference an environment variable or encrypted vault credential, such as "Bearer {env:MCP_TOKEN}". Vector does not store raw MCP credentials in repository configuration.`,
          } satisfies Status,
        }
      }
      const invalidSecret = Object.entries(secrets ?? {}).find(
        ([key, value]) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || !value || value.length > 64 * 1024,
      )
      if (invalidSecret || Object.keys(secrets ?? {}).length > 128) {
        return {
          status: {
            status: "failed",
            error: invalidSecret
              ? `MCP credential "${invalidSecret[0]}" is invalid.`
              : "MCP credentials may contain at most 128 entries.",
          } satisfies Status,
        }
      }
      // An add replaces the credential set as well as the server config. This
      // prevents a later config with a guessed vault key from inheriting a
      // secret left behind by a previous integration under the same name.
      yield* auth.updateSecrets(name, secrets ?? {})
      const s = yield* InstanceState.get(state)
      s.removed.delete(name)
      s.config[name] = mcp
      yield* persistConfig(name, declaredMcp(mcp, configured, onDisk))
      yield* createAndStore(name, mcp)
      yield* events.publish(ToolsChanged, { server: name }).pipe(Effect.ignore)
      return { status: s.status }
    })

    const remove = Effect.fn("MCP.remove")(function* (name: string) {
      yield* requireMcpConfig(name)
      // Delete the durable entry before clearing the in-memory client and
      // encrypted credentials. If the file cannot be written, the caller sees
      // a failure and the working integration remains intact and retryable.
      yield* cfgSvc.removeMcpLocal(name)
      const s = yield* InstanceState.get(state)
      yield* closeClient(s, name)
      delete s.config[name]
      delete s.status[name]
      s.removed.add(name)
      McpOAuthCallback.cancelPending(name)
      pendingOAuthTransports.delete(name)
      yield* auth.remove(name)
      yield* events.publish(ToolsChanged, { server: name }).pipe(Effect.ignore)
    })

    const connect = Effect.fn("MCP.connect")(function* (name: string) {
      const mcp = yield* requireMcpConfig(name)
      const enabled = { ...mcp, enabled: true }
      const s = yield* InstanceState.get(state)
      yield* persistConfig(name, { enabled: true })
      s.config[name] = enabled
      yield* createAndStore(name, enabled)
      yield* events.publish(ToolsChanged, { server: name }).pipe(Effect.ignore)
    })

    const disconnect = Effect.fn("MCP.disconnect")(function* (name: string) {
      const mcp = yield* requireMcpConfig(name)
      const s = yield* InstanceState.get(state)
      const disabled = { ...mcp, enabled: false }
      yield* persistConfig(name, { enabled: false })
      s.config[name] = disabled
      yield* closeClient(s, name)
      delete s.clients[name]
      s.status[name] = { status: "disabled" }
      yield* events.publish(ToolsChanged, { server: name }).pipe(Effect.ignore)
    })

    function requestTimeout(s: State, name: string, configured: McpEntry | undefined, fallback?: number) {
      const staticTimeout = configured && isMcpConfigured(configured) ? configured.timeout : undefined
      return s.config[name]?.timeout ?? staticTimeout ?? fallback
    }

    const tools = Effect.fn("MCP.tools")(function* () {
      const result: Record<string, Tool> = {}
      const s = yield* InstanceState.get(state)

      const cfg = yield* cfgSvc.get()
      const config = cfg.mcp ?? {}
      const defaultTimeout = cfg.experimental?.mcp_timeout
      const bridge = yield* EffectBridge.make()

      for (const [clientName, client] of Object.entries(s.clients)) {
        if (s.status[clientName]?.status !== "connected") continue
        const mcpConfig = config[clientName]
        const listed = s.defs[clientName]
        if (!listed) {
          yield* Effect.logWarning("missing cached tools for connected server", { clientName })
          continue
        }
        const timeout = requestTimeout(s, clientName, mcpConfig, defaultTimeout)
        for (const mcpTool of listed) {
          const key = McpCatalog.toolName(clientName, mcpTool.name)
          result[key] = McpCatalog.convertTool(mcpTool, client, timeout, {
            onSettled: (error, signal) => bridge.promise(settle(s, clientName, client, error, signal)),
          })
        }
      }
      return result
    })

    const cloudTools = Effect.fn("MCP.cloudTools")(function* () {
      const s = yield* InstanceState.get(state)
      const result: Record<string, McpCloud.Request> = {}
      for (const clientName of Object.keys(s.clients)) {
        if (s.status[clientName]?.status !== "connected") continue
        const entry = yield* getMcpConfig(clientName)
        const provider = entry ? McpCloud.provider(entry) : undefined
        if (!provider) continue
        for (const mcpTool of s.defs[clientName] ?? []) {
          const request = McpCloud.request(provider, clientName, mcpTool.name)
          if (request) result[McpCatalog.toolName(clientName, mcpTool.name)] = request
        }
      }
      return result
    })

    function collectFromConnected<T extends { name: string }>(
      s: State,
      listFn: (c: Client, timeout?: number) => Promise<T[]>,
      label: string,
      key?: (item: T) => string,
      targetClientName?: string,
    ) {
      return Effect.gen(function* () {
        const cfg = yield* cfgSvc.get()
        return yield* Effect.forEach(
          Object.entries(s.clients).filter(
            ([name]) => s.status[name]?.status === "connected" && (!targetClientName || name === targetClientName),
          ),
          ([clientName, client]) =>
            McpCatalog.fetch(
              clientName,
              client,
              (c) => listFn(c, requestTimeout(s, clientName, cfg.mcp?.[clientName], cfg.experimental?.mcp_timeout)),
              label,
              key,
            ).pipe(Effect.map((items) => Object.entries(items ?? {}))),
          { concurrency: "unbounded" },
        ).pipe(Effect.map((results) => Object.fromEntries<T & { client: string }>(results.flat())))
      })
    }

    const prompts = Effect.fn("MCP.prompts")(function* () {
      return yield* collectFromConnected(yield* InstanceState.get(state), McpCatalog.prompts, "prompts")
    })

    const resources = Effect.fn("MCP.resources")(function* (clientName?: string) {
      return yield* collectFromConnected(
        yield* InstanceState.get(state),
        McpCatalog.resources,
        "resources",
        (resource) => resource.uri,
        clientName,
      )
    })

    const resourceTemplates = Effect.fn("MCP.resourceTemplates")(function* (clientName?: string) {
      return yield* collectFromConnected(
        yield* InstanceState.get(state),
        McpCatalog.resourceTemplates,
        "resource templates",
        (template) => template.uriTemplate,
        clientName,
      )
    })

    const withClient = Effect.fnUntraced(function* <A>(
      clientName: string,
      fn: (client: MCPClient, timeout?: number) => Promise<A>,
      label: string,
      meta?: Record<string, unknown>,
    ) {
      const s = yield* InstanceState.get(state)
      const client = s.clients[clientName]
      if (!client) {
        yield* Effect.logWarning(`client not found for ${label}`, { clientName })
        return undefined
      }
      const cfg = yield* cfgSvc.get()
      return yield* Effect.tryPromise({
        try: () => fn(client, requestTimeout(s, clientName, cfg.mcp?.[clientName], cfg.experimental?.mcp_timeout)),
        catch: (error) => error,
      }).pipe(
        Effect.tap(() => settle(s, clientName, client)),
        Effect.tapError((error) =>
          Effect.logError(`failed to ${label}`, {
            clientName,
            ...meta,
            error: error instanceof Error ? error.message : String(error),
          }).pipe(Effect.andThen(settle(s, clientName, client, error))),
        ),
        Effect.orElseSucceed(() => undefined),
      )
    })

    const getPrompt = Effect.fn("MCP.getPrompt")(function* (
      clientName: string,
      name: string,
      args?: Record<string, string>,
    ) {
      return yield* withClient(
        clientName,
        (client, timeout) => client.getPrompt({ name, arguments: args }, { timeout }),
        "getPrompt",
        { promptName: name },
      )
    })

    const readResource = Effect.fn("MCP.readResource")(function* (clientName: string, resourceUri: string) {
      return yield* withClient(
        clientName,
        (client, timeout) => client.readResource({ uri: resourceUri }, { timeout }),
        "readResource",
        { resourceUri },
      )
    })

    const getMcpConfig = Effect.fnUntraced(function* (mcpName: string) {
      if (!validMcpName(mcpName)) return undefined
      const s = yield* InstanceState.get(state)
      if (Object.hasOwn(s.config, mcpName)) return s.config[mcpName]

      const cfg = yield* cfgSvc.get()
      const mcpConfig = cfg.mcp && Object.hasOwn(cfg.mcp, mcpName) ? cfg.mcp[mcpName] : undefined
      if (!mcpConfig || !isMcpConfigured(mcpConfig)) return undefined
      return mcpConfig
    })

    const requireMcpConfig = Effect.fnUntraced(function* (mcpName: string) {
      if (yield* disabledByIsolation()) return yield* new NotFoundError({ name: mcpName })
      const mcpConfig = yield* getMcpConfig(mcpName)
      if (!mcpConfig) return yield* new NotFoundError({ name: mcpName })
      return mcpConfig
    })

    const startAuth = Effect.fn("MCP.startAuth")(function* (mcpName: string) {
      const mcpConfig = yield* requireMcpConfig(mcpName)
      if (mcpConfig.type !== "remote") throw new Error(`MCP server ${mcpName} is not a remote server`)
      if (mcpConfig.oauth === false) throw new Error(`MCP server ${mcpName} has OAuth explicitly disabled`)
      const url = remoteURL(mcpConfig.url)
      if (!url) throw new Error(`Invalid MCP URL for "${mcpName}"`)
      const decided = Egress.decide({ source: "mcp-remote", url })
      if (decided.decision !== "allow") throw new Error(`MCP server ${mcpName}: off in Vector Local. ${decided.reason}`)

      // OAuth config is optional - if not provided, we'll use auto-discovery
      const oauthConfig = typeof mcpConfig.oauth === "object" ? mcpConfig.oauth : undefined

      // Resolve effective redirect URI: explicit redirectUri > callbackPort shorthand > default
      const effectiveRedirectUri =
        oauthConfig?.redirectUri ??
        (oauthConfig?.callbackPort ? `http://127.0.0.1:${oauthConfig.callbackPort}${OAUTH_CALLBACK_PATH}` : undefined)

      // Start the callback server with custom redirectUri if configured
      yield* Effect.promise(() => McpOAuthCallback.ensureRunning(effectiveRedirectUri))

      const oauthState = Array.from(crypto.getRandomValues(new Uint8Array(32)))
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("")
      yield* auth.updateOAuthState(mcpName, oauthState)
      let capturedUrl: URL | undefined
      const authProvider = new McpOAuthPendingProvider(
        mcpName,
        mcpConfig.url,
        {
          clientId: oauthConfig?.clientId,
          clientSecret: oauthConfig?.clientSecret,
          scope: oauthConfig?.scope,
          redirectUri: effectiveRedirectUri,
        },
        {
          onRedirect: async (url) => {
            // The server's own OAuth metadata names this URL, and it goes to the system opener, which also launches
            // file:, smb: and application links: only a web page may be opened.
            if (url.protocol !== "https:" && url.protocol !== "http:")
              throw new Error(
                `MCP server ${mcpName} asked Vector to open a ${url.protocol} authorization link; only http and https links are opened`,
              )
            capturedUrl = url
          },
        },
        auth,
      )

      const secrets = (yield* auth.get(mcpName))?.secrets ?? {}
      const sdk = yield* loadSdk
      const transport = new sdk.StreamableHTTPClientTransport(url, {
        authProvider,
        requestInit: mcpConfig.headers
          ? { headers: resolveMcpHeaders(mcpConfig.headers, process.env, secrets) }
          : undefined,
        fetch: remoteFetch,
      })
      const directory = yield* InstanceState.directory

      return yield* Effect.tryPromise({
        try: () => {
          const client = sdk.createClient(directory)
          return client.connect(transport).then(async () => {
            await authProvider.commit()
            return { authorizationUrl: "", oauthState, client } satisfies AuthResult
          })
        },
        catch: (error) => error,
      }).pipe(
        Effect.catch((error) => {
          if (error instanceof sdk.UnauthorizedError && capturedUrl) {
            pendingOAuthTransports.set(mcpName, { transport, provider: authProvider })
            return Effect.succeed({ authorizationUrl: capturedUrl.toString(), oauthState } satisfies AuthResult)
          }
          return Effect.die(error)
        }),
      )
    })

    const authenticate = Effect.fn("MCP.authenticate")(function* (
      mcpName: string,
      onAuthorization?: (authorizationUrl: string) => void,
    ) {
      const result = yield* startAuth(mcpName)
      if (!result.authorizationUrl) {
        const client = "client" in result ? result.client : undefined
        const mcpConfig = yield* requireMcpConfig(mcpName).pipe(
          Effect.tapError(() => Effect.tryPromise(() => client?.close() ?? Promise.resolve()).pipe(Effect.ignore)),
        )

        const listed = client
          ? client.getServerCapabilities()?.tools
            ? yield* McpCatalog.defs(client, mcpConfig.timeout)
            : []
          : undefined
        if (!client || !listed) {
          yield* Effect.tryPromise(() => client?.close() ?? Promise.resolve()).pipe(Effect.ignore)
          return { status: "failed", error: "Failed to get tools" } satisfies Status
        }

        const s = yield* InstanceState.get(state)
        yield* auth.clearOAuthState(mcpName)
        return yield* storeClient(s, mcpName, client, listed, client.getInstructions()?.trim(), mcpConfig.timeout)
      }

      const callbackPromise = McpOAuthCallback.waitForCallback(result.oauthState, mcpName)
      onAuthorization?.(result.authorizationUrl)

      yield* Effect.tryPromise(() => open(result.authorizationUrl)).pipe(
        Effect.flatMap((subprocess) =>
          Effect.callback<void, Error>((resume) => {
            const timer = setTimeout(() => resume(Effect.void), 500)
            subprocess.on("error", (err) => {
              clearTimeout(timer)
              resume(Effect.fail(err))
            })
            subprocess.on("exit", (code) => {
              if (code !== null && code !== 0) {
                clearTimeout(timer)
                resume(Effect.fail(new Error(`Browser open failed with exit code ${code}`)))
              }
            })
          }),
        ),
        Effect.catch(() => {
          return events.publish(BrowserOpenFailed, { mcpName, url: result.authorizationUrl }).pipe(Effect.ignore)
        }),
      )

      const code = yield* Effect.promise(() => callbackPromise)

      const storedState = yield* auth.getOAuthState(mcpName)
      if (storedState !== result.oauthState) {
        yield* auth.clearOAuthState(mcpName)
        throw new Error("OAuth state mismatch - potential CSRF attack")
      }
      yield* auth.clearOAuthState(mcpName)
      return yield* finishAuth(mcpName, code)
    })

    const finishAuth = Effect.fn("MCP.finishAuth")(function* (mcpName: string, authorizationCode: string) {
      yield* requireMcpConfig(mcpName)
      const pending = pendingOAuthTransports.get(mcpName)
      if (!pending) throw new Error(`No pending OAuth flow for MCP server: ${mcpName}`)

      const error = yield* Effect.tryPromise({
        try: () => pending.transport.finishAuth(authorizationCode),
        catch: (error) => error,
      }).pipe(
        Effect.match({
          onFailure: (error) => (error instanceof Error ? error.message : String(error)),
          onSuccess: () => undefined,
        }),
      )

      if (error) return { status: "failed", error: `OAuth completion failed: ${error}` } satisfies Status

      yield* Effect.promise(() => pending.provider?.commit() ?? Promise.resolve())
      yield* auth.clearCodeVerifier(mcpName)
      pendingOAuthTransports.delete(mcpName)

      const mcpConfig = yield* requireMcpConfig(mcpName)

      return yield* createAndStore(mcpName, { ...mcpConfig, enabled: true })
    })

    const removeAuth = Effect.fn("MCP.removeAuth")(function* (mcpName: string) {
      yield* auth.remove(mcpName)
      McpOAuthCallback.cancelPending(mcpName)
      pendingOAuthTransports.delete(mcpName)
    })

    const supportsOAuth = Effect.fn("MCP.supportsOAuth")(function* (mcpName: string) {
      const mcpConfig = yield* requireMcpConfig(mcpName)
      return mcpConfig.type === "remote" && mcpConfig.oauth !== false
    })

    const hasStoredTokens = Effect.fn("MCP.hasStoredTokens")(function* (mcpName: string) {
      const entry = yield* auth.get(mcpName)
      return !!entry?.tokens
    })

    const getAuthStatus = Effect.fn("MCP.getAuthStatus")(function* (mcpName: string) {
      const runtimeConfig = (yield* InstanceState.has(state))
        ? (yield* InstanceState.get(state)).config[mcpName]
        : undefined
      const mcpConfig = runtimeConfig ?? (yield* cfgSvc.get()).mcp?.[mcpName]
      if (!mcpConfig || !isMcpConfigured(mcpConfig) || mcpConfig.type !== "remote") return "not_authenticated"
      const entry = yield* auth.getForUrl(mcpName, mcpConfig.url)
      if (!entry?.tokens) return "not_authenticated"
      if (entry.tokens.expiresAt && entry.tokens.expiresAt < Date.now() / 1000) return "expired"
      return "authenticated"
    })

    return Service.of({
      status,
      clients,
      instructions,
      tools,
      cloudTools,
      prompts,
      resources,
      resourceTemplates,
      add,
      remove,
      connect,
      disconnect,
      getPrompt,
      readResource,
      startAuth,
      authenticate,
      finishAuth,
      removeAuth,
      supportsOAuth,
      hasStoredTokens,
      getAuthStatus,
    })
  }),
)

export type AuthStatus = "authenticated" | "expired" | "not_authenticated"

export const node = LayerNode.make({
  service: Service,
  layer: layer,
  deps: [CrossSpawnSpawner.node, McpAuth.node, EventV2Bridge.node, Config.node],
})

export * as MCP from "."
