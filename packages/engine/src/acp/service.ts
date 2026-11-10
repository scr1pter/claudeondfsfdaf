import { Billing } from "@vectordevai/schema/billing"
import {
  type AgentSideConnection,
  type AuthenticateRequest,
  type AuthenticateResponse,
  type AuthMethod,
  type CancelNotification,
  type CloseSessionRequest,
  type CloseSessionResponse,
  type ForkSessionRequest,
  type ForkSessionResponse,
  type InitializeRequest,
  type InitializeResponse,
  type ListSessionsRequest,
  type ListSessionsResponse,
  type LoadSessionRequest,
  type LoadSessionResponse,
  type McpServer,
  type NewSessionRequest,
  type NewSessionResponse,
  type PromptRequest,
  type PromptResponse,
  type ResumeSessionRequest,
  type ResumeSessionResponse,
  type SessionInfo,
  type SetSessionConfigOptionRequest,
  type SetSessionConfigOptionResponse,
  type SetSessionModelRequest,
  type SetSessionModelResponse,
  type SetSessionModeRequest,
  type SetSessionModeResponse,
} from "@agentclientprotocol/sdk"
import { InstallationVersion } from "@vectordevai/core/installation/version"
import { ModelPlanStatus } from "@vectordevai/core/model-plan-status"
import { BrainSchema } from "@vectordevai/core/brain/schema"
import { AppNodeBuilder } from "@vectordevai/core/effect/app-node-builder"
import type { AssistantMessage, Message, VectorClient, SessionMessageResponse } from "@vectordevai/sdk/v2"
import { Context, Effect, Layer, ManagedRuntime } from "effect"
import * as ACPError from "./error"
import { buildConfigOptions, parseModelSelection } from "./config-option"
import { promptContentToParts } from "./content"
import { Directory } from "./directory"
import { ACPEvent } from "./event"
import { ACPSession } from "./session"
import { UsageService } from "./usage"
import { ACPProfile } from "./profile"
import { ProviderV2 } from "@vectordevai/core/provider"
import { ModelV2 } from "@vectordevai/core/model"
import { Provider } from "@/provider/provider"
import type { Command } from "@/command"
import { FREE_ROUTER_ID, isFreeModelRef } from "@vectordevai/schema/free-model"

export const AuthMethodID = "vector-login"

export type Error = ACPError.Error
type ServiceConnection = Pick<AgentSideConnection, "sessionUpdate"> &
  Partial<Pick<AgentSideConnection, "requestPermission" | "writeTextFile">>

export type Interface = {
  readonly initialize: (input: InitializeRequest) => Effect.Effect<InitializeResponse, Error>
  readonly authenticate: (input: AuthenticateRequest) => Effect.Effect<AuthenticateResponse, Error>
  readonly newSession: (input: NewSessionRequest) => Effect.Effect<NewSessionResponse, Error>
  readonly loadSession: (input: LoadSessionRequest) => Effect.Effect<LoadSessionResponse, Error>
  readonly listSessions: (input: ListSessionsRequest) => Effect.Effect<ListSessionsResponse, Error>
  readonly resumeSession: (input: ResumeSessionRequest) => Effect.Effect<ResumeSessionResponse, Error>
  readonly closeSession: (input: CloseSessionRequest) => Effect.Effect<CloseSessionResponse, Error>
  readonly forkSession: (input: ForkSessionRequest) => Effect.Effect<ForkSessionResponse, Error>
  readonly setSessionConfigOption: (
    input: SetSessionConfigOptionRequest,
  ) => Effect.Effect<SetSessionConfigOptionResponse, Error>
  readonly setSessionMode: (input: SetSessionModeRequest) => Effect.Effect<SetSessionModeResponse, Error>
  readonly setSessionModel: (input: SetSessionModelRequest) => Effect.Effect<SetSessionModelResponse, Error>
  readonly prompt: (input: PromptRequest) => Effect.Effect<PromptResponse, Error>
  readonly cancel: (input: CancelNotification) => Effect.Effect<void, Error>
}

export class Service extends Context.Service<Service, Interface>()("@vector/ACP/Service") {}

export function make(input: {
  sdk: VectorClient
  connection?: ServiceConnection
  directory?: Directory.Interface
  session?: ACPSession.Interface
  usage?: UsageService.Interface
  eventSubscription?: (subscription: ACPEvent.Subscription) => void
}): Interface {
  const session = input.session ?? makeSessionService()
  const directoryService = input.directory ?? makeDirectoryService(input.sdk)
  const registeredMcp = new Map<string, Set<string>>()
  const sessionSnapshots = new Map<string, Directory.Snapshot>()
  const events = input.connection
    ? ACPEvent.start({ sdk: input.sdk, connection: input.connection, session })
    : undefined
  if (events) input.eventSubscription?.(events)

  const initialize = Effect.fn("ACP.initialize")(function* (params: InitializeRequest) {
    const started = performance.now()
    const authMethod: AuthMethod = {
      description: "Run `vector auth login` in the terminal",
      name: "Connect a provider with Vector",
      id: AuthMethodID,
    }

    if (params.clientCapabilities?._meta?.["terminal-auth"] === true) {
      authMethod._meta = {
        "terminal-auth": {
          command: "vector",
          args: ["auth", "login"],
          label: "Vector provider login",
        },
      }
    }

    const response = {
      protocolVersion: 1,
      agentCapabilities: {
        loadSession: true,
        mcpCapabilities: {
          http: true,
          sse: true,
        },
        promptCapabilities: {
          embeddedContext: true,
          image: true,
        },
        sessionCapabilities: {
          close: {},
          fork: {},
          list: {},
          resume: {},
        },
      },
      authMethods: [authMethod],
      agentInfo: {
        name: "Vector",
        version: InstallationVersion,
      },
    }
    ACPProfile.duration("acp.initialize", started)
    return response
  })

  const authenticate = Effect.fn("ACP.authenticate")(function* (params: AuthenticateRequest) {
    if (params.methodId !== AuthMethodID) {
      return yield* new ACPError.UnknownAuthMethodError({ methodId: params.methodId })
    }
    return {}
  })

  const directorySnapshot = Effect.fn("ACP.directorySnapshot")(function* (cwd: string) {
    const started = performance.now()
    const snapshot = yield* directoryService.get(cwd)
    ACPProfile.duration("acp.directory.snapshot", started)
    return snapshot
  })

  const configSnapshot = Effect.fn("ACP.configSnapshot")(function* (state: ACPSession.Info) {
    const snapshot = sessionSnapshots.get(state.id)
    if (snapshot) return snapshot
    const loaded = yield* directorySnapshot(state.cwd)
    sessionSnapshots.set(state.id, loaded)
    return loaded
  })

  const newSession = Effect.fn("ACP.newSession")(function* (params: NewSessionRequest) {
    const started = performance.now()
    const snapshot = yield* directorySnapshot(params.cwd)
    const selected = yield* selectDefaultModel(snapshot)
    const variant = selectVariant(snapshot, selected)
    const modeId = snapshot.availableModes.length > 0 ? snapshot.defaultModeID : undefined
    const created = yield* profiledRequest(
      "acp.newSession.session.create",
      () =>
        input.sdk.session.create(
          {
            directory: params.cwd,
            ...(modeId ? { agent: modeId } : {}),
            model: {
              providerID: selected.providerID,
              id: selected.modelID,
              ...(variant ? { variant } : {}),
            },
          },
          { throwOnError: true },
        ),
      "session",
    )
    const state = yield* session.create({
      id: created.id,
      cwd: params.cwd,
      mcpServers: params.mcpServers,
      model: selected,
      variant,
      modeId,
    })
    sessionSnapshots.set(state.id, snapshot)

    yield* registerMcpServers(input.sdk, registeredMcp, params.cwd, state.id, params.mcpServers)
    yield* sendAvailableCommands(input.connection, state.id, snapshot)

    const response = {
      sessionId: state.id,
      configOptions: configOptions(snapshot, {
        model: state.model ?? selected,
        variant: state.variant,
        modeId: state.modeId,
      }),
    }
    ACPProfile.duration("acp.newSession", started)
    return response
  })

  const loadSession = Effect.fn("ACP.loadSession")(function* (params: LoadSessionRequest) {
    const snapshot = yield* directorySnapshot(params.cwd)
    yield* request(
      () => input.sdk.session.get({ directory: params.cwd, sessionID: params.sessionId }, { throwOnError: true }),
      "session",
    )
    const messages = yield* request(
      () => input.sdk.session.messages({ directory: params.cwd, sessionID: params.sessionId }, { throwOnError: true }),
      "session",
    )
    const restored = restoreFromMessages(messages.map((item) => item.info))
    const model = restored.model ?? (yield* selectDefaultModel(snapshot))
    const state = yield* session.load({
      id: params.sessionId,
      cwd: params.cwd,
      mcpServers: params.mcpServers,
      model,
      variant: restored.variant ?? selectVariant(snapshot, model),
      modeId: restored.modeId ?? (snapshot.availableModes.length > 0 ? snapshot.defaultModeID : undefined),
    })
    sessionSnapshots.set(state.id, snapshot)

    yield* registerMcpServers(input.sdk, registeredMcp, params.cwd, state.id, params.mcpServers)
    yield* sendAvailableCommands(input.connection, state.id, snapshot)
    yield* replayMessages(events, messages)

    return {
      configOptions: configOptions(snapshot, {
        model: state.model ?? model,
        variant: state.variant,
        modeId: state.modeId,
      }),
    }
  })

  const listSessions = Effect.fn("ACP.listSessions")(function* (params: ListSessionsRequest) {
    const cursor = params.cursor ? Number(params.cursor) : undefined
    const limit = 100
    const sessions = yield* request(
      () =>
        input.sdk.session.list(
          {
            ...(params.cwd ? { directory: params.cwd } : {}),
            roots: true,
          },
          { throwOnError: true },
        ),
      "session",
    )
    const serverEntries = sessions.map(
      (item): SessionInfo => ({
        sessionId: item.id,
        cwd: item.directory,
        title: item.title,
        updatedAt: new Date(item.time.updated).toISOString(),
      }),
    )
    const liveEntries = (yield* session.list(params.cwd ?? undefined))
      .filter((item) => !serverEntries.some((entry) => entry.sessionId === item.id))
      .map(
        (item): SessionInfo => ({
          sessionId: item.id,
          cwd: item.cwd,
          updatedAt: item.createdAt.toISOString(),
        }),
      )
    const sorted = [...liveEntries, ...serverEntries].toSorted(
      (a, b) => new Date(b.updatedAt ?? 0).getTime() - new Date(a.updatedAt ?? 0).getTime(),
    )
    const filtered =
      cursor === undefined || !Number.isFinite(cursor)
        ? sorted
        : sorted.filter((item) => new Date(item.updatedAt ?? 0).getTime() < cursor)
    const page = filtered.slice(0, limit)
    const last = page.at(-1)
    return {
      sessions: page,
      ...(filtered.length > limit && last ? { nextCursor: String(new Date(last.updatedAt ?? 0).getTime()) } : {}),
    }
  })

  const resumeSession = Effect.fn("ACP.resumeSession")(function* (params: ResumeSessionRequest) {
    const snapshot = yield* directorySnapshot(params.cwd)
    yield* request(
      () => input.sdk.session.get({ directory: params.cwd, sessionID: params.sessionId }, { throwOnError: true }),
      "session",
    )
    const messages = yield* request(
      () =>
        input.sdk.session.messages(
          { directory: params.cwd, sessionID: params.sessionId, limit: 20 },
          { throwOnError: true },
        ),
      "session",
    )
    const restored = restoreFromMessages(messages.map((item) => item.info))
    const model = restored.model ?? (yield* selectDefaultModel(snapshot))
    const state = yield* session.load({
      id: params.sessionId,
      cwd: params.cwd,
      mcpServers: params.mcpServers ?? [],
      model,
      variant: restored.variant ?? selectVariant(snapshot, model),
      modeId: restored.modeId ?? (snapshot.availableModes.length > 0 ? snapshot.defaultModeID : undefined),
    })
    sessionSnapshots.set(state.id, snapshot)

    yield* registerMcpServers(input.sdk, registeredMcp, params.cwd, state.id, params.mcpServers ?? [])
    yield* sendAvailableCommands(input.connection, state.id, snapshot)

    return {
      configOptions: configOptions(snapshot, {
        model: state.model ?? model,
        variant: state.variant,
        modeId: state.modeId,
      }),
    }
  })

  const abortBackingSession = Effect.fn("ACP.abortBackingSession")(function* (current: ACPSession.Info) {
    yield* request(
      () => input.sdk.session.abort({ directory: current.cwd, sessionID: current.id }, { throwOnError: true }),
      "session",
    ).pipe(
      Effect.catch((error) =>
        Effect.logError("failed to abort ACP backing session", { error: error, sessionID: current.id }),
      ),
    )
  })

  const closeSession = Effect.fn("ACP.closeSession")(function* (params: CloseSessionRequest) {
    const removed = yield* session.remove(params.sessionId)
    registeredMcp.delete(params.sessionId)
    sessionSnapshots.delete(params.sessionId)
    if (!removed) return {}

    yield* abortBackingSession(removed)
    return {}
  })

  const cancel = Effect.fn("ACP.cancel")(function* (params: CancelNotification) {
    const current = yield* session.get(params.sessionId)
    yield* abortBackingSession(current)
  })

  const forkSession = Effect.fn("ACP.forkSession")(function* (params: ForkSessionRequest) {
    const snapshot = yield* directorySnapshot(params.cwd)
    const forked = yield* request(
      () =>
        input.sdk.session.fork(
          {
            directory: params.cwd,
            sessionID: params.sessionId,
          },
          { throwOnError: true },
        ),
      "session",
    )
    const messages = yield* request(
      () =>
        input.sdk.session.messages({ directory: params.cwd, sessionID: forked.id, limit: 20 }, { throwOnError: true }),
      "session",
    )
    const restored = restoreFromMessages(messages.map((item) => item.info))
    const model = restored.model ?? (yield* selectDefaultModel(snapshot))
    const state = yield* session.load({
      id: forked.id,
      cwd: params.cwd,
      mcpServers: params.mcpServers ?? [],
      model,
      variant: restored.variant ?? selectVariant(snapshot, model),
      modeId: restored.modeId ?? (snapshot.availableModes.length > 0 ? snapshot.defaultModeID : undefined),
    })
    sessionSnapshots.set(state.id, snapshot)

    yield* registerMcpServers(input.sdk, registeredMcp, params.cwd, state.id, params.mcpServers ?? [])
    yield* sendAvailableCommands(input.connection, state.id, snapshot)
    yield* replayMessages(events, messages)

    return {
      sessionId: state.id,
      configOptions: configOptions(snapshot, {
        model: state.model ?? model,
        variant: state.variant,
        modeId: state.modeId,
      }),
    }
  })

  const setSessionConfigOption = Effect.fn("ACP.setSessionConfigOption")(function* (
    params: SetSessionConfigOptionRequest,
  ) {
    const current = yield* session.get(params.sessionId)
    const snapshot = yield* configSnapshot(current)
    if (typeof params.value !== "string") {
      return yield* new ACPError.InvalidConfigOptionError({ configId: params.configId })
    }

    if (params.configId === "model") {
      const selected = yield* parseSelectedModel(snapshot, params.value)
      const variant = selected.variant ?? selectVariant(snapshot, selected.model)
      const state = yield* session
        .setVariant(params.sessionId, Directory.variants(snapshot, selected.model) ? variant : undefined)
        .pipe(Effect.andThen(session.setModel(params.sessionId, selected.model)))
      return {
        configOptions: configOptions(snapshot, {
          model: state.model ?? selected.model,
          variant: state.variant,
          modeId: state.modeId,
        }),
      }
    }

    if (params.configId === "effort") {
      const model = current.model ?? (yield* selectDefaultModel(snapshot))
      const variants = Directory.variants(snapshot, model)
      if (!variants || !Object.keys(variants).includes(params.value)) {
        return yield* new ACPError.InvalidEffortError({ effort: params.value })
      }
      const state = yield* session.setVariant(params.sessionId, params.value)
      return {
        configOptions: configOptions(snapshot, {
          model: state.model ?? model,
          variant: state.variant,
          modeId: state.modeId,
        }),
      }
    }

    if (params.configId === "mode") {
      if (!snapshot.availableModes.some((mode) => mode.id === params.value)) {
        return yield* new ACPError.InvalidModeError({ mode: params.value })
      }
      const state = yield* session.setMode(params.sessionId, params.value)
      return {
        configOptions: configOptions(snapshot, {
          model: state.model ?? (yield* selectDefaultModel(snapshot)),
          variant: state.variant,
          modeId: state.modeId,
        }),
      }
    }

    return yield* new ACPError.InvalidConfigOptionError({ configId: params.configId })
  })

  const setSessionMode = Effect.fn("ACP.setSessionMode")(function* (params: SetSessionModeRequest) {
    const current = yield* session.get(params.sessionId)
    const snapshot = yield* configSnapshot(current)
    if (!snapshot.availableModes.some((mode) => mode.id === params.modeId)) {
      return yield* new ACPError.InvalidModeError({ mode: params.modeId })
    }
    yield* session.setMode(params.sessionId, params.modeId)
    return {}
  })

  const setSessionModel = Effect.fn("ACP.setSessionModel")(function* (params: SetSessionModelRequest) {
    const current = yield* session.get(params.sessionId)
    const snapshot = yield* configSnapshot(current)
    const selected = yield* parseSelectedModel(snapshot, params.modelId)
    yield* session
      .setVariant(
        params.sessionId,
        Directory.variants(snapshot, selected.model)
          ? (selected.variant ?? selectVariant(snapshot, selected.model))
          : undefined,
      )
      .pipe(Effect.andThen(session.setModel(params.sessionId, selected.model)))
    return {}
  })

  return {
    initialize,
    authenticate,
    newSession,
    loadSession,
    listSessions,
    resumeSession,
    closeSession,
    forkSession,
    setSessionConfigOption,
    setSessionMode,
    setSessionModel,
    prompt: Effect.fn("ACP.prompt")(function* (params: PromptRequest) {
      const current = yield* session.get(params.sessionId)
      const snapshot = yield* directorySnapshot(current.cwd)
      const selected = current.model ?? (yield* selectDefaultModel(snapshot))
      if (!current.model) {
        yield* session.setModel(params.sessionId, selected)
      }
      const variant = current.variant ?? selectVariant(snapshot, selected)
      const modeId = current.modeId ?? (snapshot.availableModes.length > 0 ? snapshot.defaultModeID : undefined)
      const parts = promptContentToParts(params.prompt)
      const command = detectSlashCommand(parts)

      if (!command) {
        const response = yield* request(
          () =>
            input.sdk.session.prompt(
              {
                sessionID: current.id,
                model: {
                  providerID: selected.providerID,
                  modelID: selected.modelID,
                },
                ...(variant ? { variant } : {}),
                parts,
                ...(modeId ? { agent: modeId } : {}),
                directory: current.cwd,
              },
              { throwOnError: true },
            ),
          "session",
        )
        const messages = yield* sendUsageUpdate(input.usage, input.sdk, input.connection, current.id, current.cwd)
        return yield* promptResponse(response.info, params.messageId, messages)
      }

      const known = snapshot.availableCommands.find((item) => item.name === command.name)
      if (known) {
        const response = yield* request(
          () =>
            input.sdk.session.command(
              {
                sessionID: current.id,
                command: known.name,
                arguments: command.args,
                model: `${selected.providerID}/${selected.modelID}`,
                ...(variant ? { variant } : {}),
                ...(modeId ? { agent: modeId } : {}),
                directory: current.cwd,
              },
              { throwOnError: true },
            ),
          "session",
        )
        const messages = yield* sendUsageUpdate(input.usage, input.sdk, input.connection, current.id, current.cwd)
        return yield* promptResponse(response.info, params.messageId, messages)
      }

      if (command.name === "compact") {
        yield* request(
          () =>
            input.sdk.session.summarize(
              {
                sessionID: current.id,
                directory: current.cwd,
                providerID: selected.providerID,
                modelID: selected.modelID,
              },
              { throwOnError: true },
            ),
          "session",
        )
      }

      yield* sendUsageUpdate(input.usage, input.sdk, input.connection, current.id, current.cwd)
      return yield* promptResponse(undefined, params.messageId, undefined)
    }),
    cancel,
  }
}

function makeSessionService() {
  return ManagedRuntime.make(AppNodeBuilder.build(ACPSession.node)).runSync(
    ACPSession.Service.use((service) => Effect.succeed(service)),
  )
}

function makeDirectoryService(sdk: VectorClient) {
  return ManagedRuntime.make(
    AppNodeBuilder.build(Directory.node, [
      [
        Directory.loaderNode,
        Layer.succeed(
          Directory.Loader,
          Directory.Loader.of({
            load: (directory) => request(() => loadDirectorySnapshot(sdk, directory), "directory"),
          }),
        ),
      ],
    ]),
  ).runSync(Directory.Service.use((service) => Effect.succeed(service)))
}

function makeUsageService(sdk: VectorClient) {
  const limits = new Map<string, Promise<number | undefined>>()
  const contextLimit: UsageService.Interface["contextLimit"] = Effect.fn("ACP.promptUsage.contextLimit")(
    function* (params) {
      const key = `${params.directory}\u0000${params.providerID}\u0000${params.modelID}`
      const current = limits.get(key)
      if (current) return yield* Effect.promise(() => current)

      const next = sdk.config
        .providers({ directory: params.directory }, { throwOnError: true })
        .then((response) => {
          const providers = Object.fromEntries(
            (response.data?.providers ?? []).map((provider) => [provider.id, provider]),
          ) as Record<ProviderV2.ID, Provider.Info>
          return UsageService.findContextLimit(providers, params.providerID, params.modelID)
        })
        .catch(() => undefined)
      limits.set(key, next)
      return yield* Effect.promise(() => next)
    },
  )

  const sendUpdate: UsageService.Interface["sendUpdate"] = Effect.fn("ACP.promptUsage.sendUpdate")(function* (params) {
    const messages = yield* request(
      () =>
        sdk.session.messages(
          {
            sessionID: params.sessionID,
            directory: params.directory,
          },
          { throwOnError: true },
        ),
      "session",
    ).pipe(
      Effect.map((messages) => messages as readonly UsageService.SessionMessage[]),
      Effect.catch((error) =>
        Effect.logError("failed to fetch messages for usage update", { error: error }).pipe(Effect.as(undefined)),
      ),
    )
    if (!messages) return

    const latest = messages.findLast(
      (message): message is { readonly info: UsageService.AssistantMessage } => message.info.role === "assistant",
    )
    if (latest && !Billing.hasOwnIdentity(latest.info)) return messages
    const message = UsageService.latestAssistantMessage(messages)
    if (!message?.providerID || !Billing.hasOwnIdentity(message) || !message.modelID) return messages

    const size = yield* contextLimit({
      directory: params.directory,
      providerID: ProviderV2.ID.make(message.providerID),
      modelID: ModelV2.ID.make(message.modelID),
    })
    if (!size) return messages
    const session = yield* request(
      () => sdk.session.get({ sessionID: params.sessionID, directory: params.directory }, { throwOnError: true }),
      "session",
    ).pipe(Effect.catch(() => Effect.succeed(undefined)))
    const cost = UsageService.totalSessionCost(messages, session)

    yield* Effect.promise(() =>
      params.connection
        .sessionUpdate({
          sessionId: params.sessionID,
          update: {
            sessionUpdate: "usage_update",
            used: UsageService.contextTokens(message),
            size,
            cost: cost === undefined ? undefined : { amount: cost, currency: "USD" },
          },
        })
        .catch(() => {}),
    )
    return messages
  })

  return UsageService.Service.of({
    buildUsage: UsageService.buildUsage,
    latestAssistantMessage: UsageService.latestAssistantMessage,
    totalSessionCost: UsageService.totalSessionCost,
    contextLimit,
    sendUpdate,
  })
}

function replayMessages(subscription: ACPEvent.Subscription | undefined, messages: SessionMessageResponse[]) {
  if (!subscription) return Effect.void
  return Effect.promise(async () => {
    for (const message of messages) {
      await subscription.replayMessage(message).catch(() => {})
    }
  })
}

type ConfigState = {
  readonly model: Directory.DefaultModel
  readonly variant?: string
  readonly modeId?: string
}

type SdkResponse<T> = {
  readonly data?: T
  readonly error?: unknown
}

type MessageInfo = {
  readonly role?: Message["role"]
  readonly model?: Extract<Message, { role: "user" }>["model"]
  readonly providerID?: Extract<Message, { role: "assistant" }>["providerID"]
  readonly modelID?: Extract<Message, { role: "assistant" }>["modelID"]
  readonly variant?: Extract<Message, { role: "assistant" }>["variant"]
  readonly mode?: Extract<Message, { role: "assistant" }>["mode"]
  readonly agent?: Message["agent"]
}

type AssistantError = NonNullable<AssistantMessage["error"]>
type AssistantInfo = (UsageService.AssistantTokenCost & Pick<AssistantMessage, "error" | "id">) | undefined

function request<T>(fn: () => Promise<T | SdkResponse<T>>, service?: string) {
  return Effect.tryPromise({
    try: async () => {
      const result = await fn()
      if (isSdkResponse<T>(result)) {
        if (result.error) throw result.error
        if (result.data !== undefined) return result.data
      }
      return result as T
    },
    catch: (error) => fromUnknownError(error, service),
  })
}

function profiledRequest<T>(name: string, fn: () => Promise<T | SdkResponse<T>>, service?: string) {
  return request(() => ACPProfile.measure(name, fn), service)
}

async function loadDirectorySnapshot(sdk: VectorClient, directory: string) {
  return ACPProfile.measure("acp.directory.load", async () => {
    const [providersResponse, agentsResponse, commandsResponse, skillsResponse, configResponse] = await Promise.all([
      ACPProfile.measure("acp.directory.provider.list", () =>
        sdk.config.providers({ directory }, { throwOnError: true }),
      ),
      ACPProfile.measure("acp.directory.mode.defaultAgent.load", () =>
        sdk.app.agents({ directory }, { throwOnError: true }),
      ),
      ACPProfile.measure("acp.directory.command.list", () => sdk.command.list({ directory }, { throwOnError: true })),
      ACPProfile.measure("acp.directory.skill.list", () => sdk.app.skills({ directory }, { throwOnError: true })),
      ACPProfile.measure("acp.directory.defaultModel.config", () =>
        sdk.config.get({ directory }, { throwOnError: true }).catch(() => undefined),
      ),
    ])
    const providersData = providersResponse.data!
    const agents = agentsResponse.data!
    const commandsData = commandsResponse.data!
    const skills = skillsResponse.data!
    const providers = Object.fromEntries(providersData.providers.map((provider) => [provider.id, provider])) as Record<
      ProviderV2.ID,
      Provider.Info
    >
    const defaultModelStarted = performance.now()
    const defaultModel = defaultModelFromConfig(configResponse?.data?.model, providers)
    ACPProfile.duration("acp.directory.defaultModel.resolve", defaultModelStarted, { configured: !!defaultModel })
    const modes = agents
      .filter((agent) => agent.mode !== "subagent" && agent.hidden !== true)
      .map((agent) => ({
        id: agent.name,
        name: agent.name,
        ...(agent.description ? { description: agent.description } : {}),
      }))
    const commands = [
      ...commandsData,
      ...skills
        .filter((skill) => !commandsData.some((command) => command.name === skill.name))
        .map((skill) => ({
          name: skill.name,
          description: skill.description,
          source: "skill" as const,
          template: skill.content,
          hints: [],
        })),
    ] as Command.Info[]

    return Directory.build({
      directory,
      providers,
      modes,
      defaultModeID: agents.find((agent) => agent.mode === "primary" && agent.hidden !== true)?.name ?? "build",
      commands: commands.toSorted((a, b) => a.name.localeCompare(b.name)),
      ...(defaultModel ? { defaultModel } : {}),
    })
  })
}

function defaultModelFromConfig(
  configuredModel: string | undefined,
  providers: Record<ProviderV2.ID, Provider.Info>,
): Directory.DefaultModel | undefined {
  // A configured Vector model stays on the shared allowance, even when the user's own OpenRouter account lists it.
  const configured = configuredModel ? Provider.parseModel(configuredModel) : undefined
  if (configured && providers[configured.providerID]?.models[configured.modelID]) return configured
  if (configured && isFreeModelRef(configured)) return configured

  // First-session startup resolves configured or sorted available models without reading historical sessions.
  // Vector Codium spends the account's credits, so it is never chosen automatically.
  const connected = Object.values(providers).filter((provider) => provider.id !== ModelPlanStatus.PROVIDER_ID)
  const preferred = connected.some((provider) => provider.id !== "vector")
    ? connected.filter((provider) => provider.id !== "vector")
    : connected
  const best = Provider.automaticModels(preferred.flatMap((provider) => Object.values(provider.models)))[0]
  if (providers[ProviderV2.ID.openrouter] && best?.freeModel?.source !== "openrouter") return
  if (best) return { providerID: best.providerID, modelID: best.id }
}

const selectDefaultModel = Effect.fn("ACP.selectDefaultModel")(function* (snapshot: Directory.Snapshot) {
  if (snapshot.defaultModel) return snapshot.defaultModel
  const free = Provider.automaticModels(
    Object.values(snapshot.providers).flatMap((provider) => Object.values(provider.models)),
  ).find((model) => model.freeModel?.source === "openrouter")
  if (free) return { providerID: free.providerID, modelID: free.id }
  if (snapshot.providers[ProviderV2.ID.openrouter]) return yield* new ACPError.AuthRequiredError({})
  // Nor is OpenRouter's free router, which picks a model at random, chosen for anyone.
  const model = snapshot.modelOptions.find(
    (option) => option.providerID !== ModelPlanStatus.PROVIDER_ID && option.modelID !== FREE_ROUTER_ID,
  )
  if (model) return { providerID: model.providerID, modelID: model.modelID }
  // Codium alone is listed: it runs only on a model the person names, never as the automatic choice.
  if (snapshot.providers[ProviderV2.ID.make(ModelPlanStatus.PROVIDER_ID)])
    return yield* new ACPError.AuthRequiredError({ providerId: ModelPlanStatus.PROVIDER_ID })
  return yield* new ACPError.AuthRequiredError({})
})

// Only what the user typed names a command and its arguments: a command's arguments count as their words, and an
// embedded resource's text is not.
function detectSlashCommand(parts: ReturnType<typeof promptContentToParts>) {
  const text = parts
    .filter((part): part is Extract<(typeof parts)[number], { type: "text" }> => part.type === "text")
    .filter((part) => part.metadata?.[BrainSchema.OUTSIDE] === undefined)
    .map((part) => part.text)
    .join("")
    .trim()
  if (!text.startsWith("/")) return

  const [name, ...rest] = text.slice(1).split(/\s+/)
  if (!name) return
  return { name, args: rest.join(" ").trim() }
}

const promptResponse = Effect.fn("ACP.promptResponse")(function* (
  info: AssistantInfo,
  messageId: string | null | undefined,
  messages: readonly UsageService.SessionMessage[] | undefined,
) {
  // The turn's usage covers every provider step it ran, not just the last one.
  const usage = info
    ? ((messages ? UsageService.turnUsage(messages, info.id) : undefined) ??
      (Billing.hasOwnIdentity(info) ? UsageService.buildUsage(info) : undefined))
    : undefined
  if (!info?.error) {
    return {
      stopReason: "end_turn" as const,
      ...(usage ? { usage } : {}),
      ...(messageId ? { userMessageId: messageId } : {}),
      _meta: {},
    }
  }

  const base = {
    ...(usage ? { usage } : {}),
    ...(messageId ? { userMessageId: messageId } : {}),
    _meta: {},
  }

  if (info.error.name === "MessageAbortedError") {
    return {
      stopReason: "cancelled" as const,
      ...base,
    }
  }

  if (info.error.name === "MessageOutputLengthError") {
    return {
      stopReason: "max_tokens" as const,
      ...base,
    }
  }

  if (info.error.name === "ContentFilterError") {
    return {
      stopReason: "refusal" as const,
      ...base,
    }
  }

  if (info.error.name === "ProviderAuthError") {
    return yield* new ACPError.AuthRequiredError({ providerId: info.error.data.providerID })
  }

  return yield* new ACPError.ServiceFailureError({
    service: "session",
    safeMessage: promptErrorMessage(info.error),
    errorName: info.error.name,
  })
})

function promptErrorMessage(error: AssistantError) {
  if ("message" in error.data && typeof error.data.message === "string") return error.data.message
  return "Vector prompt failed"
}

function sendUsageUpdate(
  usage: UsageService.Interface | undefined,
  sdk: VectorClient,
  connection: ServiceConnection | undefined,
  sessionID: string,
  directory: string,
) {
  if (!connection) return Effect.succeed(undefined)
  return (usage ?? makeUsageService(sdk)).sendUpdate({
    connection,
    sessionID,
    directory,
  })
}

function selectVariant(snapshot: Directory.Snapshot, model: Directory.DefaultModel) {
  const variants = Directory.variants(snapshot, model)
  if (!variants) return
  if (variants.default) return "default"
  return Object.keys(variants)[0]
}

function configOptions(snapshot: Directory.Snapshot, session: ConfigState) {
  return buildConfigOptions({
    providers: Object.values(snapshot.providers),
    currentModel: session.model,
    currentVariant: session.variant,
    modes: snapshot.availableModes,
    currentModeId: session.modeId,
  })
}

function parseSelectedModel(snapshot: Directory.Snapshot, modelId: string) {
  const selected = parseModelSelection(modelId, Object.values(snapshot.providers))
  const provider = snapshot.providers[ProviderV2.ID.make(selected.model.providerID)]
  const model = provider?.models[ModelV2.ID.make(selected.model.modelID)]
  if (!model) {
    return Effect.fail(
      new ACPError.InvalidModelError({
        providerId: selected.model.providerID,
        modelId,
      }),
    )
  }
  if (selected.variant && !model.variants?.[selected.variant]) {
    return Effect.fail(new ACPError.InvalidEffortError({ effort: selected.variant }))
  }
  return Effect.succeed({
    model: {
      providerID: provider.id,
      modelID: model.id,
    },
    variant: selected.variant,
  })
}

function sendAvailableCommands(
  connection: Pick<AgentSideConnection, "sessionUpdate"> | undefined,
  sessionId: string,
  snapshot: Directory.Snapshot,
) {
  if (!connection) return Effect.void
  return Effect.sync(() => {
    setTimeout(() => {
      void connection.sessionUpdate({
        sessionId,
        update: {
          sessionUpdate: "available_commands_update",
          availableCommands: snapshot.availableCommands.map((command) => ({
            name: command.name,
            description: command.description ?? "",
          })),
        },
      })
    }, 0)
  })
}

function registerMcpServers(
  sdk: VectorClient,
  registered: Map<string, Set<string>>,
  directory: string,
  sessionId: string,
  servers: readonly McpServer[],
) {
  const started = performance.now()
  const current = registered.get(sessionId) ?? new Set<string>()
  registered.set(sessionId, current)
  const pending = new Set<string>()

  return Effect.all(
    servers
      .map((server) => ({ server, config: mcpConfig(server) }))
      .filter((entry) => {
        const key = mcpRegistrationKey(entry.server.name, entry.config)
        if (current.has(key) || pending.has(key)) return false
        pending.add(key)
        return true
      })
      .map((entry) =>
        request(
          () =>
            sdk.mcp.add(
              {
                directory,
                name: entry.server.name,
                config: entry.config,
              },
              { throwOnError: true },
            ),
          "mcp",
        ).pipe(
          Effect.tap(() => Effect.sync(() => current.add(mcpRegistrationKey(entry.server.name, entry.config)))),
          Effect.ignore,
        ),
      ),
    { concurrency: "unbounded" },
  ).pipe(
    Effect.tap(() =>
      Effect.sync(() =>
        ACPProfile.duration("acp.mcp.register", started, {
          count: pending.size,
        }),
      ),
    ),
    Effect.asVoid,
  )
}

function mcpRegistrationKey(name: string, config: ReturnType<typeof mcpConfig>) {
  return `${name}:${stableStringify(config)}`
}

function mcpConfig(server: McpServer) {
  if ("type" in server) {
    return {
      type: "remote" as const,
      url: server.url,
      headers: Object.fromEntries(server.headers.map((header) => [header.name, header.value])),
    }
  }
  return {
    type: "local" as const,
    command: [server.command, ...server.args],
    environment: Object.fromEntries(server.env.map((entry) => [entry.name, entry.value])),
  }
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`
  if (!value || typeof value !== "object") return JSON.stringify(value)
  return `{${Object.entries(value)
    .toSorted(([a], [b]) => a.localeCompare(b))
    .map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`)
    .join(",")}}`
}

function restoreFromMessages(messages: readonly MessageInfo[]) {
  const user = messages.findLast(
    (message) => message.role === "user" && message.model?.providerID && message.model.modelID,
  )
  if (user?.model?.providerID && user.model.modelID) {
    return {
      model: { providerID: user.model.providerID as ProviderV2.ID, modelID: user.model.modelID as ModelV2.ID },
      variant: user.model.variant,
      modeId: user.agent,
    }
  }

  const assistant = messages.findLast((message) => message.providerID && message.modelID)
  if (assistant?.providerID && assistant.modelID) {
    return {
      model: { providerID: assistant.providerID as ProviderV2.ID, modelID: assistant.modelID as ModelV2.ID },
      variant: assistant.variant,
      modeId: assistant.mode ?? assistant.agent,
    }
  }

  return {}
}

function isSdkResponse<T>(value: T | SdkResponse<T>): value is SdkResponse<T> {
  return typeof value === "object" && value !== null && ("data" in value || "error" in value)
}

function fromUnknownError(error: unknown, service?: string): Error {
  if (isACPError(error)) return error
  if (isAuthRequired(error)) {
    return new ACPError.AuthRequiredError({ providerId: findProviderID(error) })
  }
  return new ACPError.ServiceFailureError({ safeMessage: "Vector service failure", service })
}

function isACPError(error: unknown): error is Error {
  return (
    typeof error === "object" &&
    error !== null &&
    "_tag" in error &&
    typeof error._tag === "string" &&
    error._tag.startsWith("ACP")
  )
}

function isAuthRequired(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false
  if (value instanceof Error && (value.name === "ProviderAuthError" || value.name === "LoadAPIKeyError")) return true
  if (
    value instanceof Error &&
    (value.message.includes("ProviderAuthError") || value.message.includes("LoadAPIKeyError"))
  ) {
    return true
  }
  if ("name" in value && (value.name === "ProviderAuthError" || value.name === "LoadAPIKeyError")) return true
  if ("_tag" in value && (value._tag === "ProviderAuthError" || value._tag === "LoadAPIKeyError")) return true
  if ("error" in value && isAuthRequired(value.error)) return true
  if ("data" in value && isAuthRequired(value.data)) return true
  return false
}

function findProviderID(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null) return
  if ("providerID" in value && typeof value.providerID === "string") return value.providerID
  if ("providerId" in value && typeof value.providerId === "string") return value.providerId
  if ("data" in value) return findProviderID(value.data)
  if ("error" in value) return findProviderID(value.error)
}
