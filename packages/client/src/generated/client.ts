import type {
  HealthGetOutput,
  LocationGetInput,
  LocationGetOutput,
  AgentsListInput,
  AgentsListOutput,
  SessionsImportArchiveInput,
  SessionsImportArchiveOutput,
  SessionsShareInput,
  SessionsShareOutput,
  SessionsSharePreviewInput,
  SessionsSharePreviewOutput,
  SessionsShareFlushInput,
  SessionsShareFlushOutput,
  SessionsUnshareInput,
  SessionsUnshareOutput,
  SessionsListInput,
  SessionsListOutput,
  SessionsCreateInput,
  SessionsCreateOutput,
  SessionsActiveOutput,
  SessionsGetInput,
  SessionsGetOutput,
  SessionsSwitchAgentInput,
  SessionsSwitchAgentOutput,
  SessionsSwitchModelInput,
  SessionsSwitchModelOutput,
  SessionsResumeFreeModelsInput,
  SessionsResumeFreeModelsOutput,
  SessionsPromptInput,
  SessionsPromptOutput,
  SessionsSpendInput,
  SessionsSpendOutput,
  SessionsCompactInput,
  SessionsCompactOutput,
  SessionsWaitInput,
  SessionsWaitOutput,
  SessionsStageInput,
  SessionsStageOutput,
  SessionsClearInput,
  SessionsClearOutput,
  SessionsCommitInput,
  SessionsCommitOutput,
  SessionsContextInput,
  SessionsContextOutput,
  SessionsHistoryInput,
  SessionsHistoryOutput,
  SessionsEventsInput,
  SessionsEventsOutput,
  SessionsInterruptInput,
  SessionsInterruptOutput,
  SessionsMessageInput,
  SessionsMessageOutput,
  MessagesListInput,
  MessagesListOutput,
  ModelsListInput,
  ModelsListOutput,
  ProvidersListInput,
  ProvidersListOutput,
  ProvidersGetInput,
  ProvidersGetOutput,
  IntegrationsListInput,
  IntegrationsListOutput,
  IntegrationsGetInput,
  IntegrationsGetOutput,
  IntegrationsConnectKeyInput,
  IntegrationsConnectKeyOutput,
  IntegrationsConnectOauthInput,
  IntegrationsConnectOauthOutput,
  IntegrationsAttemptStatusInput,
  IntegrationsAttemptStatusOutput,
  IntegrationsAttemptCompleteInput,
  IntegrationsAttemptCompleteOutput,
  IntegrationsAttemptCancelInput,
  IntegrationsAttemptCancelOutput,
  CredentialsUpdateInput,
  CredentialsUpdateOutput,
  CredentialsRemoveInput,
  CredentialsRemoveOutput,
  PermissionsListRequestsInput,
  PermissionsListRequestsOutput,
  PermissionsListSavedInput,
  PermissionsListSavedOutput,
  PermissionsRemoveSavedInput,
  PermissionsRemoveSavedOutput,
  PermissionsCreateInput,
  PermissionsCreateOutput,
  PermissionsListInput,
  PermissionsListOutput,
  PermissionsGetInput,
  PermissionsGetOutput,
  PermissionsReplyInput,
  PermissionsReplyOutput,
  FilesListInput,
  FilesListOutput,
  FilesFindInput,
  FilesFindOutput,
  CommandsListInput,
  CommandsListOutput,
  SkillsListInput,
  SkillsListOutput,
  EventsSubscribeOutput,
  PtysListInput,
  PtysListOutput,
  PtysCreateInput,
  PtysCreateOutput,
  PtysGetInput,
  PtysGetOutput,
  PtysUpdateInput,
  PtysUpdateOutput,
  PtysRemoveInput,
  PtysRemoveOutput,
  QuestionsListRequestsInput,
  QuestionsListRequestsOutput,
  QuestionsListInput,
  QuestionsListOutput,
  QuestionsReplyInput,
  QuestionsReplyOutput,
  QuestionsRejectInput,
  QuestionsRejectOutput,
  ReferencesListInput,
  ReferencesListOutput,
  ProjectCopiesCreateInput,
  ProjectCopiesCreateOutput,
  ProjectCopiesRemoveInput,
  ProjectCopiesRemoveOutput,
  ProjectCopiesRefreshInput,
  ProjectCopiesRefreshOutput,
} from "./types"
import { ClientError } from "./client-error"

export interface ClientOptions {
  readonly baseUrl: string
  readonly fetch?: typeof globalThis.fetch
  readonly headers?: HeadersInit
}

export interface RequestOptions {
  readonly signal?: AbortSignal
  readonly headers?: HeadersInit
}

interface RequestDescriptor {
  readonly method: string
  readonly path: string
  readonly query?: Record<string, unknown>
  readonly headers?: Record<string, unknown>
  readonly body?: unknown
  readonly successStatus: number
  readonly declaredStatuses: ReadonlyArray<number>
  readonly empty: boolean
}

export function make(options: ClientOptions) {
  const fetch = options.fetch ?? globalThis.fetch

  const prepare = (descriptor: RequestDescriptor, requestOptions?: RequestOptions) => {
    const url = new URL(descriptor.path, options.baseUrl)
    for (const [key, value] of Object.entries(descriptor.query ?? {})) appendQuery(url.searchParams, key, value)
    const headers = new Headers(options.headers)
    for (const [key, value] of Object.entries(descriptor.headers ?? {})) {
      if (value !== undefined && value !== null) headers.set(key, String(value))
    }
    for (const [key, value] of new Headers(requestOptions?.headers)) headers.set(key, value)
    if (descriptor.body !== undefined && !headers.has("content-type")) headers.set("content-type", "application/json")
    return {
      url,
      init: {
        method: descriptor.method,
        signal: requestOptions?.signal,
        headers,
        body: descriptor.body === undefined ? undefined : JSON.stringify(descriptor.body),
      } satisfies RequestInit,
    }
  }

  const execute = async (descriptor: RequestDescriptor, requestOptions?: RequestOptions) => {
    try {
      const prepared = prepare(descriptor, requestOptions)
      return await fetch(prepared.url, prepared.init)
    } catch (cause) {
      throw new ClientError("Transport", { cause })
    }
  }

  const responseError = async (response: Response, descriptor: RequestDescriptor): Promise<never> => {
    if (descriptor.declaredStatuses.includes(response.status)) throw await json(response)
    try {
      await response.body?.cancel()
    } catch {}
    throw new ClientError("UnexpectedStatus", { cause: { status: response.status } })
  }

  const request = async <A>(descriptor: RequestDescriptor, requestOptions?: RequestOptions): Promise<A> => {
    const response = await execute(descriptor, requestOptions)
    if (response.status !== descriptor.successStatus) return responseError(response, descriptor)
    if (descriptor.empty) {
      try {
        await response.body?.cancel()
      } catch {}
      return undefined as A
    }
    return (await json(response)) as A
  }

  const sse = <A>(descriptor: RequestDescriptor, requestOptions?: RequestOptions): AsyncIterable<A> => ({
    async *[Symbol.asyncIterator]() {
      const response = await execute(descriptor, requestOptions)
      if (response.status !== descriptor.successStatus) await responseError(response, descriptor)
      if (!isContentType(response, "text/event-stream")) {
        try {
          await response.body?.cancel()
        } catch {}
        throw new ClientError("UnsupportedContentType")
      }
      if (response.body === null) throw new ClientError("MalformedResponse")
      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ""
      try {
        while (true) {
          let next
          try {
            next = await reader.read()
          } catch (cause) {
            throw new ClientError("Transport", { cause })
          }
          buffer += decoder.decode(next.value, { stream: !next.done })
          if (buffer.length > 1_048_576) throw new ClientError("MalformedResponse")
          const trailingCarriageReturn = !next.done && buffer.endsWith("\r")
          if (trailingCarriageReturn) buffer = buffer.slice(0, -1)
          buffer = buffer.replaceAll("\r\n", "\n").replaceAll("\r", "\n")
          if (trailingCarriageReturn) buffer += "\r"
          if (next.done && buffer !== "") buffer += "\n\n"
          let boundary = buffer.indexOf("\n\n")
          while (boundary >= 0) {
            const block = buffer.slice(0, boundary)
            buffer = buffer.slice(boundary + 2)
            const data = block
              .split("\n")
              .flatMap((line) => (line.startsWith("data:") ? [line.slice(5).trimStart()] : []))
              .join("\n")
            if (data !== "") {
              try {
                yield JSON.parse(data) as A
              } catch (cause) {
                throw new ClientError("MalformedResponse", { cause })
              }
            }
            boundary = buffer.indexOf("\n\n")
          }
          if (next.done) return
        }
      } finally {
        try {
          await reader.cancel()
        } catch {}
        reader.releaseLock()
      }
    },
  })

  return {
    health: {
      get: (requestOptions?: RequestOptions) =>
        request<HealthGetOutput>(
          {
            method: "GET",
            path: (() => {
              const path = `/api/health`
              if (!path.startsWith("/") || path.startsWith("//") || path.includes("\\"))
                throw new Error(`Refusing cross-origin endpoint path: ${path}`)
              return path
            })(),
            successStatus: 200,
            declaredStatuses: [400, 401, 403],
            empty: false,
          },
          requestOptions,
        ),
    },
    location: {
      get: (input?: LocationGetInput, requestOptions?: RequestOptions) =>
        request<LocationGetOutput>(
          {
            method: "GET",
            path: (() => {
              const path = `/api/location`
              if (!path.startsWith("/") || path.startsWith("//") || path.includes("\\"))
                throw new Error(`Refusing cross-origin endpoint path: ${path}`)
              return path
            })(),
            query: { location: input?.["location"] },
            successStatus: 200,
            declaredStatuses: [400, 401, 403],
            empty: false,
          },
          requestOptions,
        ),
    },
    agents: {
      list: (input?: AgentsListInput, requestOptions?: RequestOptions) =>
        request<AgentsListOutput>(
          {
            method: "GET",
            path: (() => {
              const path = `/api/agent`
              if (!path.startsWith("/") || path.startsWith("//") || path.includes("\\"))
                throw new Error(`Refusing cross-origin endpoint path: ${path}`)
              return path
            })(),
            query: { location: input?.["location"] },
            successStatus: 200,
            declaredStatuses: [400, 401, 403],
            empty: false,
          },
          requestOptions,
        ),
    },
    sessions: {
      importArchive: (input: SessionsImportArchiveInput, requestOptions?: RequestOptions) =>
        request<{ readonly data: SessionsImportArchiveOutput }>(
          {
            method: "POST",
            path: (() => {
              const path = `/api/session/import`
              if (!path.startsWith("/") || path.startsWith("//") || path.includes("\\"))
                throw new Error(`Refusing cross-origin endpoint path: ${path}`)
              return path
            })(),
            body: { archive: input["archive"], location: input["location"] },
            successStatus: 200,
            declaredStatuses: [400, 401, 403],
            empty: false,
          },
          requestOptions,
        ).then((value) => value.data),
      share: (input: SessionsShareInput, requestOptions?: RequestOptions) =>
        request<{ readonly data: SessionsShareOutput }>(
          {
            method: "POST",
            path: (() => {
              const path = `/api/session/${encodeURIComponent(input.sessionID)}/share`
              if (!path.startsWith("/") || path.startsWith("//") || path.includes("\\"))
                throw new Error(`Refusing cross-origin endpoint path: ${path}`)
              return path
            })(),
            body: {
              consent: input["consent"],
              expiresAt: input["expiresAt"],
              previewHash: input["previewHash"],
              remember: input["remember"],
              includeScreenshots: input["includeScreenshots"],
            },
            successStatus: 200,
            declaredStatuses: [400, 401, 403],
            empty: false,
          },
          requestOptions,
        ).then((value) => value.data),
      sharePreview: (input: SessionsSharePreviewInput, requestOptions?: RequestOptions) =>
        request<{ readonly data: SessionsSharePreviewOutput }>(
          {
            method: "GET",
            path: (() => {
              const path = `/api/session/${encodeURIComponent(input.sessionID)}/share/preview`
              if (!path.startsWith("/") || path.startsWith("//") || path.includes("\\"))
                throw new Error(`Refusing cross-origin endpoint path: ${path}`)
              return path
            })(),
            query: { includeScreenshots: input["includeScreenshots"] },
            successStatus: 200,
            declaredStatuses: [400, 401, 403],
            empty: false,
          },
          requestOptions,
        ).then((value) => value.data),
      shareFlush: (input: SessionsShareFlushInput, requestOptions?: RequestOptions) =>
        request<{ readonly data: SessionsShareFlushOutput }>(
          {
            method: "POST",
            path: (() => {
              const path = `/api/session/${encodeURIComponent(input.sessionID)}/share/flush`
              if (!path.startsWith("/") || path.startsWith("//") || path.includes("\\"))
                throw new Error(`Refusing cross-origin endpoint path: ${path}`)
              return path
            })(),
            successStatus: 200,
            declaredStatuses: [400, 401, 403],
            empty: false,
          },
          requestOptions,
        ).then((value) => value.data),
      unshare: (input: SessionsUnshareInput, requestOptions?: RequestOptions) =>
        request<SessionsUnshareOutput>(
          {
            method: "DELETE",
            path: (() => {
              const path = `/api/session/${encodeURIComponent(input.sessionID)}/share`
              if (!path.startsWith("/") || path.startsWith("//") || path.includes("\\"))
                throw new Error(`Refusing cross-origin endpoint path: ${path}`)
              return path
            })(),
            successStatus: 204,
            declaredStatuses: [400, 401, 403],
            empty: true,
          },
          requestOptions,
        ),
      list: (input?: SessionsListInput, requestOptions?: RequestOptions) =>
        request<SessionsListOutput>(
          {
            method: "GET",
            path: (() => {
              const path = `/api/session`
              if (!path.startsWith("/") || path.startsWith("//") || path.includes("\\"))
                throw new Error(`Refusing cross-origin endpoint path: ${path}`)
              return path
            })(),
            query: {
              workspace: input?.["workspace"],
              limit: input?.["limit"],
              order: input?.["order"],
              search: input?.["search"],
              directory: input?.["directory"],
              project: input?.["project"],
              subpath: input?.["subpath"],
              cursor: input?.["cursor"],
            },
            successStatus: 200,
            declaredStatuses: [400, 401, 403],
            empty: false,
          },
          requestOptions,
        ),
      create: (input?: SessionsCreateInput, requestOptions?: RequestOptions) =>
        request<{ readonly data: SessionsCreateOutput }>(
          {
            method: "POST",
            path: (() => {
              const path = `/api/session`
              if (!path.startsWith("/") || path.startsWith("//") || path.includes("\\"))
                throw new Error(`Refusing cross-origin endpoint path: ${path}`)
              return path
            })(),
            body: {
              id: input?.["id"],
              agent: input?.["agent"],
              model: input?.["model"],
              location: input?.["location"],
              title: input?.["title"],
              parentID: input?.["parentID"],
              internal: input?.["internal"],
            },
            successStatus: 200,
            declaredStatuses: [400, 401, 403],
            empty: false,
          },
          requestOptions,
        ).then((value) => value.data),
      active: (requestOptions?: RequestOptions) =>
        request<{ readonly data: SessionsActiveOutput }>(
          {
            method: "GET",
            path: (() => {
              const path = `/api/session/active`
              if (!path.startsWith("/") || path.startsWith("//") || path.includes("\\"))
                throw new Error(`Refusing cross-origin endpoint path: ${path}`)
              return path
            })(),
            successStatus: 200,
            declaredStatuses: [400, 401, 403],
            empty: false,
          },
          requestOptions,
        ).then((value) => value.data),
      get: (input: SessionsGetInput, requestOptions?: RequestOptions) =>
        request<{ readonly data: SessionsGetOutput }>(
          {
            method: "GET",
            path: (() => {
              const path = `/api/session/${encodeURIComponent(input.sessionID)}`
              if (!path.startsWith("/") || path.startsWith("//") || path.includes("\\"))
                throw new Error(`Refusing cross-origin endpoint path: ${path}`)
              return path
            })(),
            successStatus: 200,
            declaredStatuses: [400, 401, 403, 404],
            empty: false,
          },
          requestOptions,
        ).then((value) => value.data),
      switchAgent: (input: SessionsSwitchAgentInput, requestOptions?: RequestOptions) =>
        request<SessionsSwitchAgentOutput>(
          {
            method: "POST",
            path: (() => {
              const path = `/api/session/${encodeURIComponent(input.sessionID)}/agent`
              if (!path.startsWith("/") || path.startsWith("//") || path.includes("\\"))
                throw new Error(`Refusing cross-origin endpoint path: ${path}`)
              return path
            })(),
            body: { agent: input["agent"] },
            successStatus: 204,
            declaredStatuses: [400, 401, 403, 404],
            empty: true,
          },
          requestOptions,
        ),
      switchModel: (input: SessionsSwitchModelInput, requestOptions?: RequestOptions) =>
        request<SessionsSwitchModelOutput>(
          {
            method: "POST",
            path: (() => {
              const path = `/api/session/${encodeURIComponent(input.sessionID)}/model`
              if (!path.startsWith("/") || path.startsWith("//") || path.includes("\\"))
                throw new Error(`Refusing cross-origin endpoint path: ${path}`)
              return path
            })(),
            body: { model: input["model"] },
            successStatus: 204,
            declaredStatuses: [400, 401, 403, 404],
            empty: true,
          },
          requestOptions,
        ),
      resumeFreeModels: (input: SessionsResumeFreeModelsInput, requestOptions?: RequestOptions) =>
        request<SessionsResumeFreeModelsOutput>(
          {
            method: "POST",
            path: (() => {
              const path = `/api/session/${encodeURIComponent(input.sessionID)}/free-models/resume`
              if (!path.startsWith("/") || path.startsWith("//") || path.includes("\\"))
                throw new Error(`Refusing cross-origin endpoint path: ${path}`)
              return path
            })(),
            body: { messageID: input["messageID"], modelID: input["modelID"] },
            successStatus: 204,
            declaredStatuses: [400, 401, 403, 404, 409, 500],
            empty: true,
          },
          requestOptions,
        ),
      prompt: (input: SessionsPromptInput, requestOptions?: RequestOptions) =>
        request<{ readonly data: SessionsPromptOutput }>(
          {
            method: "POST",
            path: (() => {
              const path = `/api/session/${encodeURIComponent(input.sessionID)}/prompt`
              if (!path.startsWith("/") || path.startsWith("//") || path.includes("\\"))
                throw new Error(`Refusing cross-origin endpoint path: ${path}`)
              return path
            })(),
            body: {
              id: input["id"],
              prompt: input["prompt"],
              delivery: input["delivery"],
              resume: input["resume"],
              budget: input["budget"],
            },
            successStatus: 200,
            declaredStatuses: [400, 401, 403, 404, 409],
            empty: false,
          },
          requestOptions,
        ).then((value) => value.data),
      spend: (input: SessionsSpendInput, requestOptions?: RequestOptions) =>
        request<{ readonly data: SessionsSpendOutput }>(
          {
            method: "GET",
            path: (() => {
              const path = `/api/session/${encodeURIComponent(input.sessionID)}/spend`
              if (!path.startsWith("/") || path.startsWith("//") || path.includes("\\"))
                throw new Error(`Refusing cross-origin endpoint path: ${path}`)
              return path
            })(),
            successStatus: 200,
            declaredStatuses: [400, 401, 403, 404],
            empty: false,
          },
          requestOptions,
        ).then((value) => value.data),
      compact: (input: SessionsCompactInput, requestOptions?: RequestOptions) =>
        request<SessionsCompactOutput>(
          {
            method: "POST",
            path: (() => {
              const path = `/api/session/${encodeURIComponent(input.sessionID)}/compact`
              if (!path.startsWith("/") || path.startsWith("//") || path.includes("\\"))
                throw new Error(`Refusing cross-origin endpoint path: ${path}`)
              return path
            })(),
            successStatus: 204,
            declaredStatuses: [400, 401, 403, 404, 503],
            empty: true,
          },
          requestOptions,
        ),
      wait: (input: SessionsWaitInput, requestOptions?: RequestOptions) =>
        request<SessionsWaitOutput>(
          {
            method: "POST",
            path: (() => {
              const path = `/api/session/${encodeURIComponent(input.sessionID)}/wait`
              if (!path.startsWith("/") || path.startsWith("//") || path.includes("\\"))
                throw new Error(`Refusing cross-origin endpoint path: ${path}`)
              return path
            })(),
            successStatus: 204,
            declaredStatuses: [400, 401, 403, 404, 503],
            empty: true,
          },
          requestOptions,
        ),
      stage: (input: SessionsStageInput, requestOptions?: RequestOptions) =>
        request<{ readonly data: SessionsStageOutput }>(
          {
            method: "POST",
            path: (() => {
              const path = `/api/session/${encodeURIComponent(input.sessionID)}/revert/stage`
              if (!path.startsWith("/") || path.startsWith("//") || path.includes("\\"))
                throw new Error(`Refusing cross-origin endpoint path: ${path}`)
              return path
            })(),
            body: { messageID: input["messageID"], files: input["files"] },
            successStatus: 200,
            declaredStatuses: [400, 401, 403, 404, 500],
            empty: false,
          },
          requestOptions,
        ).then((value) => value.data),
      clear: (input: SessionsClearInput, requestOptions?: RequestOptions) =>
        request<SessionsClearOutput>(
          {
            method: "POST",
            path: (() => {
              const path = `/api/session/${encodeURIComponent(input.sessionID)}/revert/clear`
              if (!path.startsWith("/") || path.startsWith("//") || path.includes("\\"))
                throw new Error(`Refusing cross-origin endpoint path: ${path}`)
              return path
            })(),
            successStatus: 204,
            declaredStatuses: [400, 401, 403, 404, 500],
            empty: true,
          },
          requestOptions,
        ),
      commit: (input: SessionsCommitInput, requestOptions?: RequestOptions) =>
        request<SessionsCommitOutput>(
          {
            method: "POST",
            path: (() => {
              const path = `/api/session/${encodeURIComponent(input.sessionID)}/revert/commit`
              if (!path.startsWith("/") || path.startsWith("//") || path.includes("\\"))
                throw new Error(`Refusing cross-origin endpoint path: ${path}`)
              return path
            })(),
            successStatus: 204,
            declaredStatuses: [400, 401, 403, 404],
            empty: true,
          },
          requestOptions,
        ),
      context: (input: SessionsContextInput, requestOptions?: RequestOptions) =>
        request<{ readonly data: SessionsContextOutput }>(
          {
            method: "GET",
            path: (() => {
              const path = `/api/session/${encodeURIComponent(input.sessionID)}/context`
              if (!path.startsWith("/") || path.startsWith("//") || path.includes("\\"))
                throw new Error(`Refusing cross-origin endpoint path: ${path}`)
              return path
            })(),
            successStatus: 200,
            declaredStatuses: [400, 401, 403, 404, 500],
            empty: false,
          },
          requestOptions,
        ).then((value) => value.data),
      history: (input: SessionsHistoryInput, requestOptions?: RequestOptions) =>
        request<SessionsHistoryOutput>(
          {
            method: "GET",
            path: (() => {
              const path = `/api/session/${encodeURIComponent(input.sessionID)}/history`
              if (!path.startsWith("/") || path.startsWith("//") || path.includes("\\"))
                throw new Error(`Refusing cross-origin endpoint path: ${path}`)
              return path
            })(),
            query: { limit: input["limit"], after: input["after"] },
            successStatus: 200,
            declaredStatuses: [400, 401, 403, 404],
            empty: false,
          },
          requestOptions,
        ),
      events: (input: SessionsEventsInput, requestOptions?: RequestOptions): AsyncIterable<SessionsEventsOutput> =>
        sse<SessionsEventsOutput>(
          {
            method: "GET",
            path: (() => {
              const path = `/api/session/${encodeURIComponent(input.sessionID)}/event`
              if (!path.startsWith("/") || path.startsWith("//") || path.includes("\\"))
                throw new Error(`Refusing cross-origin endpoint path: ${path}`)
              return path
            })(),
            query: { after: input["after"] },
            successStatus: 200,
            declaredStatuses: [400, 401, 403, 404],
            empty: false,
          },
          requestOptions,
        ),
      interrupt: (input: SessionsInterruptInput, requestOptions?: RequestOptions) =>
        request<SessionsInterruptOutput>(
          {
            method: "POST",
            path: (() => {
              const path = `/api/session/${encodeURIComponent(input.sessionID)}/interrupt`
              if (!path.startsWith("/") || path.startsWith("//") || path.includes("\\"))
                throw new Error(`Refusing cross-origin endpoint path: ${path}`)
              return path
            })(),
            successStatus: 204,
            declaredStatuses: [400, 401, 403, 404],
            empty: true,
          },
          requestOptions,
        ),
      message: (input: SessionsMessageInput, requestOptions?: RequestOptions) =>
        request<{ readonly data: SessionsMessageOutput }>(
          {
            method: "GET",
            path: (() => {
              const path = `/api/session/${encodeURIComponent(input.sessionID)}/message/${encodeURIComponent(input.messageID)}`
              if (!path.startsWith("/") || path.startsWith("//") || path.includes("\\"))
                throw new Error(`Refusing cross-origin endpoint path: ${path}`)
              return path
            })(),
            successStatus: 200,
            declaredStatuses: [400, 401, 403, 404],
            empty: false,
          },
          requestOptions,
        ).then((value) => value.data),
    },
    messages: {
      list: (input: MessagesListInput, requestOptions?: RequestOptions) =>
        request<MessagesListOutput>(
          {
            method: "GET",
            path: (() => {
              const path = `/api/session/${encodeURIComponent(input.sessionID)}/message`
              if (!path.startsWith("/") || path.startsWith("//") || path.includes("\\"))
                throw new Error(`Refusing cross-origin endpoint path: ${path}`)
              return path
            })(),
            query: { limit: input["limit"], order: input["order"], cursor: input["cursor"] },
            successStatus: 200,
            declaredStatuses: [400, 401, 403, 404, 500],
            empty: false,
          },
          requestOptions,
        ),
    },
    models: {
      list: (input?: ModelsListInput, requestOptions?: RequestOptions) =>
        request<ModelsListOutput>(
          {
            method: "GET",
            path: (() => {
              const path = `/api/model`
              if (!path.startsWith("/") || path.startsWith("//") || path.includes("\\"))
                throw new Error(`Refusing cross-origin endpoint path: ${path}`)
              return path
            })(),
            query: { location: input?.["location"] },
            successStatus: 200,
            declaredStatuses: [400, 401, 403, 503],
            empty: false,
          },
          requestOptions,
        ),
    },
    providers: {
      list: (input?: ProvidersListInput, requestOptions?: RequestOptions) =>
        request<ProvidersListOutput>(
          {
            method: "GET",
            path: (() => {
              const path = `/api/provider`
              if (!path.startsWith("/") || path.startsWith("//") || path.includes("\\"))
                throw new Error(`Refusing cross-origin endpoint path: ${path}`)
              return path
            })(),
            query: { location: input?.["location"] },
            successStatus: 200,
            declaredStatuses: [400, 401, 403, 503],
            empty: false,
          },
          requestOptions,
        ),
      get: (input: ProvidersGetInput, requestOptions?: RequestOptions) =>
        request<ProvidersGetOutput>(
          {
            method: "GET",
            path: (() => {
              const path = `/api/provider/${encodeURIComponent(input.providerID)}`
              if (!path.startsWith("/") || path.startsWith("//") || path.includes("\\"))
                throw new Error(`Refusing cross-origin endpoint path: ${path}`)
              return path
            })(),
            query: { location: input["location"] },
            successStatus: 200,
            declaredStatuses: [400, 401, 403, 404, 503],
            empty: false,
          },
          requestOptions,
        ),
    },
    integrations: {
      list: (input?: IntegrationsListInput, requestOptions?: RequestOptions) =>
        request<IntegrationsListOutput>(
          {
            method: "GET",
            path: (() => {
              const path = `/api/integration`
              if (!path.startsWith("/") || path.startsWith("//") || path.includes("\\"))
                throw new Error(`Refusing cross-origin endpoint path: ${path}`)
              return path
            })(),
            query: { location: input?.["location"] },
            successStatus: 200,
            declaredStatuses: [400, 401, 403],
            empty: false,
          },
          requestOptions,
        ),
      get: (input: IntegrationsGetInput, requestOptions?: RequestOptions) =>
        request<IntegrationsGetOutput>(
          {
            method: "GET",
            path: (() => {
              const path = `/api/integration/${encodeURIComponent(input.integrationID)}`
              if (!path.startsWith("/") || path.startsWith("//") || path.includes("\\"))
                throw new Error(`Refusing cross-origin endpoint path: ${path}`)
              return path
            })(),
            query: { location: input["location"] },
            successStatus: 200,
            declaredStatuses: [400, 401, 403],
            empty: false,
          },
          requestOptions,
        ),
      connectKey: (input: IntegrationsConnectKeyInput, requestOptions?: RequestOptions) =>
        request<IntegrationsConnectKeyOutput>(
          {
            method: "POST",
            path: (() => {
              const path = `/api/integration/${encodeURIComponent(input.integrationID)}/connect/key`
              if (!path.startsWith("/") || path.startsWith("//") || path.includes("\\"))
                throw new Error(`Refusing cross-origin endpoint path: ${path}`)
              return path
            })(),
            query: { location: input["location"] },
            body: { key: input["key"], label: input["label"] },
            successStatus: 204,
            declaredStatuses: [400, 401, 403],
            empty: true,
          },
          requestOptions,
        ),
      connectOauth: (input: IntegrationsConnectOauthInput, requestOptions?: RequestOptions) =>
        request<IntegrationsConnectOauthOutput>(
          {
            method: "POST",
            path: (() => {
              const path = `/api/integration/${encodeURIComponent(input.integrationID)}/connect/oauth`
              if (!path.startsWith("/") || path.startsWith("//") || path.includes("\\"))
                throw new Error(`Refusing cross-origin endpoint path: ${path}`)
              return path
            })(),
            query: { location: input["location"] },
            body: { methodID: input["methodID"], inputs: input["inputs"], label: input["label"] },
            successStatus: 200,
            declaredStatuses: [400, 401, 403],
            empty: false,
          },
          requestOptions,
        ),
      attemptStatus: (input: IntegrationsAttemptStatusInput, requestOptions?: RequestOptions) =>
        request<IntegrationsAttemptStatusOutput>(
          {
            method: "GET",
            path: (() => {
              const path = `/api/integration/attempt/${encodeURIComponent(input.attemptID)}`
              if (!path.startsWith("/") || path.startsWith("//") || path.includes("\\"))
                throw new Error(`Refusing cross-origin endpoint path: ${path}`)
              return path
            })(),
            query: { location: input["location"] },
            successStatus: 200,
            declaredStatuses: [400, 401, 403],
            empty: false,
          },
          requestOptions,
        ),
      attemptComplete: (input: IntegrationsAttemptCompleteInput, requestOptions?: RequestOptions) =>
        request<IntegrationsAttemptCompleteOutput>(
          {
            method: "POST",
            path: (() => {
              const path = `/api/integration/attempt/${encodeURIComponent(input.attemptID)}/complete`
              if (!path.startsWith("/") || path.startsWith("//") || path.includes("\\"))
                throw new Error(`Refusing cross-origin endpoint path: ${path}`)
              return path
            })(),
            query: { location: input["location"] },
            body: { code: input["code"] },
            successStatus: 204,
            declaredStatuses: [400, 401, 403],
            empty: true,
          },
          requestOptions,
        ),
      attemptCancel: (input: IntegrationsAttemptCancelInput, requestOptions?: RequestOptions) =>
        request<IntegrationsAttemptCancelOutput>(
          {
            method: "DELETE",
            path: (() => {
              const path = `/api/integration/attempt/${encodeURIComponent(input.attemptID)}`
              if (!path.startsWith("/") || path.startsWith("//") || path.includes("\\"))
                throw new Error(`Refusing cross-origin endpoint path: ${path}`)
              return path
            })(),
            query: { location: input["location"] },
            successStatus: 204,
            declaredStatuses: [400, 401, 403],
            empty: true,
          },
          requestOptions,
        ),
    },
    credentials: {
      update: (input: CredentialsUpdateInput, requestOptions?: RequestOptions) =>
        request<CredentialsUpdateOutput>(
          {
            method: "PATCH",
            path: (() => {
              const path = `/api/credential/${encodeURIComponent(input.credentialID)}`
              if (!path.startsWith("/") || path.startsWith("//") || path.includes("\\"))
                throw new Error(`Refusing cross-origin endpoint path: ${path}`)
              return path
            })(),
            query: { location: input["location"] },
            body: { label: input["label"] },
            successStatus: 204,
            declaredStatuses: [400, 401, 403],
            empty: true,
          },
          requestOptions,
        ),
      remove: (input: CredentialsRemoveInput, requestOptions?: RequestOptions) =>
        request<CredentialsRemoveOutput>(
          {
            method: "DELETE",
            path: (() => {
              const path = `/api/credential/${encodeURIComponent(input.credentialID)}`
              if (!path.startsWith("/") || path.startsWith("//") || path.includes("\\"))
                throw new Error(`Refusing cross-origin endpoint path: ${path}`)
              return path
            })(),
            query: { location: input["location"] },
            successStatus: 204,
            declaredStatuses: [400, 401, 403],
            empty: true,
          },
          requestOptions,
        ),
    },
    permissions: {
      listRequests: (input?: PermissionsListRequestsInput, requestOptions?: RequestOptions) =>
        request<PermissionsListRequestsOutput>(
          {
            method: "GET",
            path: (() => {
              const path = `/api/permission/request`
              if (!path.startsWith("/") || path.startsWith("//") || path.includes("\\"))
                throw new Error(`Refusing cross-origin endpoint path: ${path}`)
              return path
            })(),
            query: { location: input?.["location"] },
            successStatus: 200,
            declaredStatuses: [400, 401, 403],
            empty: false,
          },
          requestOptions,
        ),
      listSaved: (input?: PermissionsListSavedInput, requestOptions?: RequestOptions) =>
        request<{ readonly data: PermissionsListSavedOutput }>(
          {
            method: "GET",
            path: (() => {
              const path = `/api/permission/saved`
              if (!path.startsWith("/") || path.startsWith("//") || path.includes("\\"))
                throw new Error(`Refusing cross-origin endpoint path: ${path}`)
              return path
            })(),
            query: { projectID: input?.["projectID"] },
            successStatus: 200,
            declaredStatuses: [400, 401, 403],
            empty: false,
          },
          requestOptions,
        ).then((value) => value.data),
      removeSaved: (input: PermissionsRemoveSavedInput, requestOptions?: RequestOptions) =>
        request<PermissionsRemoveSavedOutput>(
          {
            method: "DELETE",
            path: (() => {
              const path = `/api/permission/saved/${encodeURIComponent(input.id)}`
              if (!path.startsWith("/") || path.startsWith("//") || path.includes("\\"))
                throw new Error(`Refusing cross-origin endpoint path: ${path}`)
              return path
            })(),
            successStatus: 204,
            declaredStatuses: [400, 401, 403],
            empty: true,
          },
          requestOptions,
        ),
      create: (input: PermissionsCreateInput, requestOptions?: RequestOptions) =>
        request<{ readonly data: PermissionsCreateOutput }>(
          {
            method: "POST",
            path: (() => {
              const path = `/api/session/${encodeURIComponent(input.sessionID)}/permission`
              if (!path.startsWith("/") || path.startsWith("//") || path.includes("\\"))
                throw new Error(`Refusing cross-origin endpoint path: ${path}`)
              return path
            })(),
            body: {
              id: input["id"],
              action: input["action"],
              resources: input["resources"],
              save: input["save"],
              metadata: input["metadata"],
              source: input["source"],
              agent: input["agent"],
            },
            successStatus: 200,
            declaredStatuses: [400, 401, 403, 404],
            empty: false,
          },
          requestOptions,
        ).then((value) => value.data),
      list: (input: PermissionsListInput, requestOptions?: RequestOptions) =>
        request<{ readonly data: PermissionsListOutput }>(
          {
            method: "GET",
            path: (() => {
              const path = `/api/session/${encodeURIComponent(input.sessionID)}/permission`
              if (!path.startsWith("/") || path.startsWith("//") || path.includes("\\"))
                throw new Error(`Refusing cross-origin endpoint path: ${path}`)
              return path
            })(),
            successStatus: 200,
            declaredStatuses: [400, 401, 403, 404],
            empty: false,
          },
          requestOptions,
        ).then((value) => value.data),
      get: (input: PermissionsGetInput, requestOptions?: RequestOptions) =>
        request<{ readonly data: PermissionsGetOutput }>(
          {
            method: "GET",
            path: (() => {
              const path = `/api/session/${encodeURIComponent(input.sessionID)}/permission/${encodeURIComponent(input.requestID)}`
              if (!path.startsWith("/") || path.startsWith("//") || path.includes("\\"))
                throw new Error(`Refusing cross-origin endpoint path: ${path}`)
              return path
            })(),
            successStatus: 200,
            declaredStatuses: [400, 401, 403, 404],
            empty: false,
          },
          requestOptions,
        ).then((value) => value.data),
      reply: (input: PermissionsReplyInput, requestOptions?: RequestOptions) =>
        request<PermissionsReplyOutput>(
          {
            method: "POST",
            path: (() => {
              const path = `/api/session/${encodeURIComponent(input.sessionID)}/permission/${encodeURIComponent(input.requestID)}/reply`
              if (!path.startsWith("/") || path.startsWith("//") || path.includes("\\"))
                throw new Error(`Refusing cross-origin endpoint path: ${path}`)
              return path
            })(),
            body: { reply: input["reply"], message: input["message"] },
            successStatus: 204,
            declaredStatuses: [400, 401, 403, 404],
            empty: true,
          },
          requestOptions,
        ),
    },
    files: {
      list: (input?: FilesListInput, requestOptions?: RequestOptions) =>
        request<FilesListOutput>(
          {
            method: "GET",
            path: (() => {
              const path = `/api/fs/list`
              if (!path.startsWith("/") || path.startsWith("//") || path.includes("\\"))
                throw new Error(`Refusing cross-origin endpoint path: ${path}`)
              return path
            })(),
            query: { location: input?.["location"], path: input?.["path"] },
            successStatus: 200,
            declaredStatuses: [400, 401, 403],
            empty: false,
          },
          requestOptions,
        ),
      find: (input: FilesFindInput, requestOptions?: RequestOptions) =>
        request<FilesFindOutput>(
          {
            method: "GET",
            path: (() => {
              const path = `/api/fs/find`
              if (!path.startsWith("/") || path.startsWith("//") || path.includes("\\"))
                throw new Error(`Refusing cross-origin endpoint path: ${path}`)
              return path
            })(),
            query: { location: input["location"], query: input["query"], type: input["type"], limit: input["limit"] },
            successStatus: 200,
            declaredStatuses: [400, 401, 403],
            empty: false,
          },
          requestOptions,
        ),
    },
    commands: {
      list: (input?: CommandsListInput, requestOptions?: RequestOptions) =>
        request<CommandsListOutput>(
          {
            method: "GET",
            path: (() => {
              const path = `/api/command`
              if (!path.startsWith("/") || path.startsWith("//") || path.includes("\\"))
                throw new Error(`Refusing cross-origin endpoint path: ${path}`)
              return path
            })(),
            query: { location: input?.["location"] },
            successStatus: 200,
            declaredStatuses: [400, 401, 403],
            empty: false,
          },
          requestOptions,
        ),
    },
    skills: {
      list: (input?: SkillsListInput, requestOptions?: RequestOptions) =>
        request<SkillsListOutput>(
          {
            method: "GET",
            path: (() => {
              const path = `/api/skill`
              if (!path.startsWith("/") || path.startsWith("//") || path.includes("\\"))
                throw new Error(`Refusing cross-origin endpoint path: ${path}`)
              return path
            })(),
            query: { location: input?.["location"] },
            successStatus: 200,
            declaredStatuses: [400, 401, 403],
            empty: false,
          },
          requestOptions,
        ),
    },
    events: {
      subscribe: (requestOptions?: RequestOptions): AsyncIterable<EventsSubscribeOutput> =>
        sse<EventsSubscribeOutput>(
          {
            method: "GET",
            path: (() => {
              const path = `/api/event`
              if (!path.startsWith("/") || path.startsWith("//") || path.includes("\\"))
                throw new Error(`Refusing cross-origin endpoint path: ${path}`)
              return path
            })(),
            successStatus: 200,
            declaredStatuses: [400, 401, 403],
            empty: false,
          },
          requestOptions,
        ),
    },
    ptys: {
      list: (input?: PtysListInput, requestOptions?: RequestOptions) =>
        request<PtysListOutput>(
          {
            method: "GET",
            path: (() => {
              const path = `/api/pty`
              if (!path.startsWith("/") || path.startsWith("//") || path.includes("\\"))
                throw new Error(`Refusing cross-origin endpoint path: ${path}`)
              return path
            })(),
            query: { location: input?.["location"] },
            successStatus: 200,
            declaredStatuses: [400, 401, 403],
            empty: false,
          },
          requestOptions,
        ),
      create: (input?: PtysCreateInput, requestOptions?: RequestOptions) =>
        request<PtysCreateOutput>(
          {
            method: "POST",
            path: (() => {
              const path = `/api/pty`
              if (!path.startsWith("/") || path.startsWith("//") || path.includes("\\"))
                throw new Error(`Refusing cross-origin endpoint path: ${path}`)
              return path
            })(),
            query: { location: input?.["location"] },
            body: {
              command: input?.["command"],
              args: input?.["args"],
              cwd: input?.["cwd"],
              title: input?.["title"],
              env: input?.["env"],
            },
            successStatus: 200,
            declaredStatuses: [400, 401, 403],
            empty: false,
          },
          requestOptions,
        ),
      get: (input: PtysGetInput, requestOptions?: RequestOptions) =>
        request<PtysGetOutput>(
          {
            method: "GET",
            path: (() => {
              const path = `/api/pty/${encodeURIComponent(input.ptyID)}`
              if (!path.startsWith("/") || path.startsWith("//") || path.includes("\\"))
                throw new Error(`Refusing cross-origin endpoint path: ${path}`)
              return path
            })(),
            query: { location: input["location"] },
            successStatus: 200,
            declaredStatuses: [400, 401, 403, 404],
            empty: false,
          },
          requestOptions,
        ),
      update: (input: PtysUpdateInput, requestOptions?: RequestOptions) =>
        request<PtysUpdateOutput>(
          {
            method: "PUT",
            path: (() => {
              const path = `/api/pty/${encodeURIComponent(input.ptyID)}`
              if (!path.startsWith("/") || path.startsWith("//") || path.includes("\\"))
                throw new Error(`Refusing cross-origin endpoint path: ${path}`)
              return path
            })(),
            query: { location: input["location"] },
            body: { title: input["title"], size: input["size"] },
            successStatus: 200,
            declaredStatuses: [400, 401, 403, 404],
            empty: false,
          },
          requestOptions,
        ),
      remove: (input: PtysRemoveInput, requestOptions?: RequestOptions) =>
        request<PtysRemoveOutput>(
          {
            method: "DELETE",
            path: (() => {
              const path = `/api/pty/${encodeURIComponent(input.ptyID)}`
              if (!path.startsWith("/") || path.startsWith("//") || path.includes("\\"))
                throw new Error(`Refusing cross-origin endpoint path: ${path}`)
              return path
            })(),
            query: { location: input["location"] },
            successStatus: 204,
            declaredStatuses: [400, 401, 403, 404],
            empty: true,
          },
          requestOptions,
        ),
    },
    questions: {
      listRequests: (input?: QuestionsListRequestsInput, requestOptions?: RequestOptions) =>
        request<QuestionsListRequestsOutput>(
          {
            method: "GET",
            path: (() => {
              const path = `/api/question/request`
              if (!path.startsWith("/") || path.startsWith("//") || path.includes("\\"))
                throw new Error(`Refusing cross-origin endpoint path: ${path}`)
              return path
            })(),
            query: { location: input?.["location"] },
            successStatus: 200,
            declaredStatuses: [400, 401, 403],
            empty: false,
          },
          requestOptions,
        ),
      list: (input: QuestionsListInput, requestOptions?: RequestOptions) =>
        request<{ readonly data: QuestionsListOutput }>(
          {
            method: "GET",
            path: (() => {
              const path = `/api/session/${encodeURIComponent(input.sessionID)}/question`
              if (!path.startsWith("/") || path.startsWith("//") || path.includes("\\"))
                throw new Error(`Refusing cross-origin endpoint path: ${path}`)
              return path
            })(),
            successStatus: 200,
            declaredStatuses: [400, 401, 403, 404],
            empty: false,
          },
          requestOptions,
        ).then((value) => value.data),
      reply: (input: QuestionsReplyInput, requestOptions?: RequestOptions) =>
        request<QuestionsReplyOutput>(
          {
            method: "POST",
            path: (() => {
              const path = `/api/session/${encodeURIComponent(input.sessionID)}/question/${encodeURIComponent(input.requestID)}/reply`
              if (!path.startsWith("/") || path.startsWith("//") || path.includes("\\"))
                throw new Error(`Refusing cross-origin endpoint path: ${path}`)
              return path
            })(),
            body: { answers: input["answers"] },
            successStatus: 204,
            declaredStatuses: [400, 401, 403, 404],
            empty: true,
          },
          requestOptions,
        ),
      reject: (input: QuestionsRejectInput, requestOptions?: RequestOptions) =>
        request<QuestionsRejectOutput>(
          {
            method: "POST",
            path: (() => {
              const path = `/api/session/${encodeURIComponent(input.sessionID)}/question/${encodeURIComponent(input.requestID)}/reject`
              if (!path.startsWith("/") || path.startsWith("//") || path.includes("\\"))
                throw new Error(`Refusing cross-origin endpoint path: ${path}`)
              return path
            })(),
            successStatus: 204,
            declaredStatuses: [400, 401, 403, 404],
            empty: true,
          },
          requestOptions,
        ),
    },
    references: {
      list: (input?: ReferencesListInput, requestOptions?: RequestOptions) =>
        request<ReferencesListOutput>(
          {
            method: "GET",
            path: (() => {
              const path = `/api/reference`
              if (!path.startsWith("/") || path.startsWith("//") || path.includes("\\"))
                throw new Error(`Refusing cross-origin endpoint path: ${path}`)
              return path
            })(),
            query: { location: input?.["location"] },
            successStatus: 200,
            declaredStatuses: [400, 401, 403],
            empty: false,
          },
          requestOptions,
        ),
    },
    projectCopies: {
      create: (input: ProjectCopiesCreateInput, requestOptions?: RequestOptions) =>
        request<ProjectCopiesCreateOutput>(
          {
            method: "POST",
            path: (() => {
              const path = `/experimental/project/${encodeURIComponent(input.projectID)}/copy`
              if (!path.startsWith("/") || path.startsWith("//") || path.includes("\\"))
                throw new Error(`Refusing cross-origin endpoint path: ${path}`)
              return path
            })(),
            query: { location: input["location"] },
            body: { strategy: input["strategy"], directory: input["directory"], name: input["name"] },
            successStatus: 200,
            declaredStatuses: [400, 401, 403],
            empty: false,
          },
          requestOptions,
        ),
      remove: (input: ProjectCopiesRemoveInput, requestOptions?: RequestOptions) =>
        request<ProjectCopiesRemoveOutput>(
          {
            method: "DELETE",
            path: (() => {
              const path = `/experimental/project/${encodeURIComponent(input.projectID)}/copy`
              if (!path.startsWith("/") || path.startsWith("//") || path.includes("\\"))
                throw new Error(`Refusing cross-origin endpoint path: ${path}`)
              return path
            })(),
            query: { location: input["location"] },
            body: { directory: input["directory"], force: input["force"] },
            successStatus: 204,
            declaredStatuses: [400, 401, 403],
            empty: true,
          },
          requestOptions,
        ),
      refresh: (input: ProjectCopiesRefreshInput, requestOptions?: RequestOptions) =>
        request<ProjectCopiesRefreshOutput>(
          {
            method: "POST",
            path: (() => {
              const path = `/experimental/project/${encodeURIComponent(input.projectID)}/copy/refresh`
              if (!path.startsWith("/") || path.startsWith("//") || path.includes("\\"))
                throw new Error(`Refusing cross-origin endpoint path: ${path}`)
              return path
            })(),
            query: { location: input["location"] },
            successStatus: 204,
            declaredStatuses: [400, 401, 403],
            empty: true,
          },
          requestOptions,
        ),
    },
  }
}

function appendQuery(params: URLSearchParams, key: string, value: unknown): void {
  if (value === undefined || value === null) return
  if (Array.isArray(value)) {
    for (const item of value) appendQuery(params, key, item)
    return
  }
  if (typeof value === "object") {
    for (const [child, item] of Object.entries(value)) appendQuery(params, `${key}[${child}]`, item)
    return
  }
  params.append(key, String(value))
}

async function json(response: Response): Promise<unknown> {
  if (!isContentType(response, "application/json") && !response.headers.get("content-type")?.includes("+json")) {
    try {
      await response.body?.cancel()
    } catch {}
    throw new ClientError("UnsupportedContentType")
  }
  let text: string
  try {
    text = await response.text()
  } catch (cause) {
    throw new ClientError("Transport", { cause })
  }
  if (text === "") throw new ClientError("MalformedResponse")
  try {
    return JSON.parse(text)
  } catch (cause) {
    throw new ClientError("MalformedResponse", { cause })
  }
}

function isContentType(response: Response, expected: string) {
  return response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() === expected
}
