import { Database } from "bun:sqlite"
import { createHash, randomBytes, timingSafeEqual } from "node:crypto"
import { chmodSync } from "node:fs"
import type { createDockerRuntime } from "./docker.js"
import { publishWorkspaceChanges, WorkspacePublishError } from "./github.js"
import { MessageIdentities } from "./message-identities.js"
import { parseCommand, record, workspaceId, WorkspaceError, type EngineCommand } from "./protocol.js"
import { verifyWorkspaceRequest } from "./signing.js"
import { publicWorkspace, StoreError, WorkspaceStore, type WorkspaceRecord } from "./store.js"

export type WorkspaceRuntime = ReturnType<typeof createDockerRuntime>
export type WorkspaceServiceOptions = {
  store: WorkspaceStore
  runtime: WorkspaceRuntime
  secret: string
  nonceDatabase: string
  relayOrigin: string
  model: { id: string; name: string; origin: string; key: string; maxOutputTokens?: number }
  maxModelCalls?: number
  maxRunMs?: number
  now?: () => number
  fetch?: typeof fetch
  allowHttp?: boolean
  publish?: typeof publishWorkspaceChanges
}

export function createWorkspaceService(options: WorkspaceServiceOptions) {
  const now = options.now ?? Date.now
  const fetcher = options.fetch ?? fetch
  const maxRunMs = options.maxRunMs ?? 2 * 60 * 60 * 1000
  const maxCalls = options.maxModelCalls ?? 50
  const maximum = options.model.maxOutputTokens ?? 4096
  const upstream = new URL(options.model.origin)
  const relay = new URL(options.relayOrigin)
  if (
    options.secret.length < 32 ||
    !options.model.key ||
    !/^[A-Za-z0-9][A-Za-z0-9_./:-]{0,150}$/.test(options.model.id) ||
    !Number.isSafeInteger(maximum) ||
    maximum < 1 ||
    maximum > 16_384 ||
    !Number.isSafeInteger(maxCalls) ||
    maxCalls < 1 ||
    maxCalls > 1000 ||
    !Number.isSafeInteger(maxRunMs) ||
    maxRunMs < 60_000 ||
    maxRunMs > 24 * 60 * 60 * 1000 ||
    upstream.username ||
    upstream.password ||
    upstream.search ||
    upstream.hash ||
    (upstream.protocol !== "https:" && !options.allowHttp) ||
    relay.username ||
    relay.password ||
    relay.pathname !== "/" ||
    relay.search ||
    relay.hash ||
    !["http:", "https:"].includes(relay.protocol)
  )
    throw new Error("Cloud workspace service is not configured.")
  const nonceDB = new Database(options.nonceDatabase, { create: true, strict: true })
  const identities = new MessageIdentities({
    path: options.nonceDatabase === ":memory:" ? ":memory:" : options.nonceDatabase + ".messages",
  })
  if (options.nonceDatabase !== ":memory:") chmodSync(options.nonceDatabase, 0o600)
  nonceDB.exec(
    "PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS request_nonce (nonce TEXT PRIMARY KEY, expires INTEGER NOT NULL)",
  )
  nonceDB.exec(
    "CREATE TABLE IF NOT EXISTS model_guard (workspace TEXT PRIMARY KEY, prompt TEXT NOT NULL, blocked INTEGER NOT NULL DEFAULT 0)",
  )
  nonceDB.exec("CREATE TABLE IF NOT EXISTS closed_account (account TEXT PRIMARY KEY, closed_at INTEGER NOT NULL)")
  // Account ids are compared lower-case (signing.ts); a fence an earlier version stored as signed moves to that form.
  nonceDB.exec(
    "INSERT OR IGNORE INTO closed_account(account,closed_at) SELECT lower(account),closed_at FROM closed_account WHERE account<>lower(account); DELETE FROM closed_account WHERE account<>lower(account)",
  )
  nonceDB.exec(
    "CREATE TABLE IF NOT EXISTS publication (workspace TEXT PRIMARY KEY, digest TEXT NOT NULL, receipt TEXT NOT NULL)",
  )
  nonceDB.exec("CREATE TABLE IF NOT EXISTS retirement_pending (workspace TEXT PRIMARY KEY, owner TEXT NOT NULL)")
  nonceDB.exec(
    "CREATE TABLE IF NOT EXISTS prompt_delivery (workspace TEXT NOT NULL, message TEXT NOT NULL, hash TEXT NOT NULL, accepted INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(workspace,message))",
  )
  const retiring = nonceDB.query<{ owner: string }, [string]>("SELECT owner FROM retirement_pending WHERE workspace=?")
  const publication = nonceDB.query<{ digest: string; receipt: string }, [string]>(
    "SELECT digest,receipt FROM publication WHERE workspace=?",
  )
  const nonceInsert = nonceDB.query("INSERT OR IGNORE INTO request_nonce(nonce,expires) VALUES (?,?)")
  const nonceClean = nonceDB.query("DELETE FROM request_nonce WHERE expires < ?")
  const modelGuard = nonceDB.query<{ blocked: number; prompt: string }, [string]>(
    "SELECT blocked,prompt FROM model_guard WHERE workspace=?",
  )
  const newPrompt = nonceDB.query(
    "INSERT INTO model_guard(workspace,prompt,blocked) VALUES (?,?,0) ON CONFLICT(workspace) DO UPDATE SET blocked=CASE WHEN prompt<>excluded.prompt THEN 0 ELSE blocked END,prompt=excluded.prompt",
  )
  const blockModel = nonceDB.query(
    "INSERT INTO model_guard(workspace,prompt,blocked) VALUES (?,'',1) ON CONFLICT(workspace) DO UPDATE SET blocked=1",
  )
  const isClosed = nonceDB.query<{ account: string }, [string]>("SELECT account FROM closed_account WHERE account=?")
  const closedAccounts = nonceDB.query<{ account: string }, []>("SELECT account FROM closed_account")
  const jobs = new Map<string, Promise<void>>()
  const leases = new Set<string>()
  const modelRunning = new Set<string>()
  const publishers = new Map<string, AbortController>()
  let closed = false

  function queueRetirement(workspace: WorkspaceRecord) {
    nonceDB
      .query("INSERT OR IGNORE INTO retirement_pending(workspace,owner) VALUES (?,?)")
      .run(workspace.id, workspace.ownerId)
    blockModel.run(workspace.id)
  }

  function owned(owner: string, id: string) {
    const workspace = options.store.get(owner, id)
    if (!workspace) throw new WorkspaceError("WORKSPACE_NOT_FOUND", "This workspace is not available.", 404)
    return workspace
  }

  function transition(
    workspace: WorkspaceRecord,
    state: WorkspaceRecord["state"],
    runtimeId?: string,
    baseCommit?: string | null,
  ) {
    const changed = options.store.transition(workspace.ownerId, workspace.id, {
      expectedState: workspace.state,
      expectedRevision: workspace.revision,
      state,
      ...(runtimeId !== undefined ? { runtimeId } : {}),
      ...(baseCommit !== undefined ? { baseCommit } : {}),
    })
    if (!changed)
      throw new WorkspaceError("WORKSPACE_CHANGED", "The workspace changed. Refresh before trying again.", 409)
    return changed
  }

  async function exclusive<T>(id: string, task: () => Promise<T>) {
    if (leases.has(id) || jobs.has(id))
      throw new WorkspaceError("WORKSPACE_BUSY", "The workspace is changing. Try again shortly.", 409)
    leases.add(id)
    try {
      return await task()
    } finally {
      leases.delete(id)
    }
  }

  function provision(
    workspace: WorkspaceRecord,
    create?: Extract<ReturnType<typeof parseCommand>, { action: "create" }>,
  ) {
    const promise = (async () => {
      try {
        let baseCommit = workspace.baseCommit
        if (isClosed.get(workspace.ownerId)) throw new Error("Account is closing.")
        if (create) {
          const [owner, repository] = workspace.repository.split("/")
          const created = await options.runtime.create({
            id: workspace.id,
            password: workspace.enginePassword,
            repository: { owner: owner!, repository: repository!, ref: workspace.branch },
            credential: create.githubToken,
            model: {
              id: options.model.id,
              name: options.model.name,
              baseURL: `${relay.origin}/model/${workspace.id}/v1`,
              token: workspace.enginePassword,
              maxOutputTokens: maximum,
            },
          })
          baseCommit = created.baseCommit
        } else await options.runtime.start(workspace.id)
        const deadline = Date.now() + 60_000
        while (!(await options.runtime.health(workspace.id, workspace.enginePassword))) {
          if (Date.now() >= deadline) throw new Error("Engine did not become ready.")
          await new Promise((resolve) => setTimeout(resolve, 250))
        }
        const current = owned(workspace.ownerId, workspace.id)
        if (current.state !== "creating" || isClosed.get(workspace.ownerId))
          throw new Error("Workspace creation was retired.")
        transition(current, "running", workspace.id, baseCommit)
      } catch {
        queueRetirement(workspace)
        const retired = await options.runtime.stop(workspace.id).then(
          () => true,
          () => false,
        )
        if (!retired) return // Keep the active slot until cleanup is independently known to have succeeded.
        const current = options.store.get(workspace.ownerId, workspace.id)
        if (current?.state === "creating") transition(current, "error")
        nonceDB.query("DELETE FROM retirement_pending WHERE workspace=?").run(workspace.id)
      }
    })().finally(() => jobs.delete(workspace.id))
    jobs.set(workspace.id, promise)
  }

  async function engine(workspace: WorkspaceRecord, command: EngineCommand) {
    if (workspace.state !== "running")
      throw new WorkspaceError("WORKSPACE_STOPPED", "Start this workspace to continue its chats.", 409)
    if (command.method === "POST" && retiring.get(workspace.id))
      throw new WorkspaceError(
        "WORKSPACE_RETIRING",
        "The old engine has not finished stopping. Wait for cleanup before starting more work.",
        409,
      )
    if (command.path === "/provider")
      return response({
        all: [
          {
            id: "vector-cloud",
            name: "Vector Cloud",
            models: { [options.model.id]: { id: options.model.id, name: options.model.name } },
          },
        ],
        default: { "vector-cloud": options.model.id },
        connected: ["vector-cloud"],
      })
    const body = record(command.body) ? command.body : undefined
    const session = /^\/session\/(ses_[A-Za-z0-9]+)\//.exec(command.path)?.[1]
    if (
      command.method === "POST" &&
      command.path.endsWith("/message_id") &&
      session &&
      typeof body?.requestID === "string"
    )
      return response({ messageID: identities.allocate(workspace.id, session, body.requestID) })
    if (body?.model !== undefined && (!record(body.model) || body.model.modelID !== options.model.id))
      throw new WorkspaceError("MODEL_UNAVAILABLE", "Choose the available cloud model.")
    if (command.method === "POST" && command.path.endsWith("/prompt_async") && typeof body?.messageID === "string") {
      if (!session || !identities.lookup(workspace.id, session, body.messageID))
        throw new WorkspaceError("MESSAGE_ID_REQUIRED", "Allocate a cloud message identity before submitting a turn.")
      const hash = createHash("sha256")
        .update(JSON.stringify({ model: body.model ?? null, parts: body.parts }))
        .digest("hex")
      const delivered = nonceDB
        .query<
          { hash: string; accepted: number },
          [string, string]
        >("SELECT hash,accepted FROM prompt_delivery WHERE workspace=? AND message=?")
        .get(workspace.id, body.messageID)
      if (delivered) {
        if (delivered.hash !== hash)
          throw new WorkspaceError(
            "MESSAGE_CONFLICT",
            "This turn identity was already used for different content.",
            409,
          )
        if (delivered.accepted || (await confirmMessage(workspace, session, body.messageID))) return response(null)
        throw new WorkspaceError(
          "MESSAGE_OUTCOME_UNKNOWN",
          "This turn's delivery is not confirmed. Refresh the saved chat before starting a new turn.",
          409,
        )
      }
      const guard = modelGuard.get(workspace.id)
      if (guard?.blocked && guard.prompt === body.messageID)
        throw new WorkspaceError(
          "MODEL_OUTCOME_UNKNOWN",
          "Refresh this saved chat and send a new turn to continue after the interrupted model request.",
          409,
        )
      newPrompt.run(workspace.id, body.messageID)
      nonceDB
        .query("INSERT INTO prompt_delivery(workspace,message,hash) VALUES (?,?,?)")
        .run(workspace.id, body.messageID, hash)
    }
    // Both routing inputs are fixed; every workspace owns a separate engine and data volume.
    const url = new URL(command.path, "http://engine.invalid")
    url.searchParams.set("directory", "/data/repository")
    if (url.pathname === "/session") url.searchParams.set("roots", "true")
    const result = await options.runtime.request(
      workspace.id,
      workspace.enginePassword,
      `${url.pathname}${url.search}`,
      {
        method: command.method,
        headers: { "content-type": "application/json", "x-vector-directory": "/data/repository" },
        ...(command.body !== undefined ? { body: JSON.stringify(command.body) } : {}),
        signal: AbortSignal.timeout(20_000),
      },
    )
    if (!result.ok) {
      await result.body?.cancel()
      throw new WorkspaceError(
        "ENGINE_REQUEST_FAILED",
        "The workspace could not complete this request. Refresh its saved chat before retrying.",
        result.status < 500 ? 409 : 502,
      )
    }
    if (result.status === 204) {
      if (session && typeof body?.messageID === "string" && command.path.endsWith("/prompt_async")) {
        const deadline = Date.now() + 5000
        do {
          if (await confirmMessage(workspace, session, body.messageID)) return response(null)
          await new Promise((resolve) => setTimeout(resolve, 100))
        } while (Date.now() < deadline)
        throw new WorkspaceError(
          "MESSAGE_OUTCOME_UNKNOWN",
          "This turn's delivery is not confirmed. Refresh the saved chat before starting a new turn.",
          409,
        )
      }
      return response(null)
    }
    const raw = await boundedBody(result, 2_000_000)
    try {
      return response(JSON.parse(raw))
    } catch {
      throw new WorkspaceError("ENGINE_RESPONSE_INVALID", "The workspace response could not be read.", 502)
    }
  }

  async function confirmMessage(workspace: WorkspaceRecord, session: string, message: string) {
    const result = await options.runtime.request(
      workspace.id,
      workspace.enginePassword,
      `/session/${session}/message/${message}?directory=%2Fdata%2Frepository`,
      { signal: AbortSignal.timeout(3000) },
    )
    if (!result.ok) {
      await result.body?.cancel()
      return false
    }
    const raw = await boundedBody(result, 128 * 1024)
    const saved: unknown = JSON.parse(raw)
    if (!record(saved) || !record(saved.info) || saved.info.id !== message || saved.info.role !== "user") return false
    nonceDB.query("UPDATE prompt_delivery SET accepted=1 WHERE workspace=? AND message=?").run(workspace.id, message)
    return true
  }

  function eraseReceipts(id: string) {
    identities.removeWorkspace(id)
    for (const table of ["model_guard", "publication", "prompt_delivery", "retirement_pending"])
      nonceDB.query(`DELETE FROM ${table} WHERE workspace=?`).run(id)
  }

  async function stop(workspace: WorkspaceRecord) {
    if (workspace.state === "stopped" && !retiring.get(workspace.id)) return workspace
    queueRetirement(workspace)
    await options.runtime.stop(workspace.id)
    const current = owned(workspace.ownerId, workspace.id)
    const paused =
      current.state === "stopped" ? current : transition(current, current.state === "creating" ? "error" : "stopped")
    nonceDB.query("DELETE FROM retirement_pending WHERE workspace=?").run(workspace.id)
    return paused
  }

  /** Erases every workspace of a closed account; the promise settles when this pass is over, whatever it left behind. */
  function cleanupAccount(owner: string) {
    const key = `account:${owner}`
    const running = jobs.get(key)
    if (running) return running
    const cleanup = (async () => {
      for (const workspace of options.store.list(owner)) {
        await jobs.get(workspace.id)
        await exclusive(workspace.id, async () => {
          const current = options.store.get(owner, workspace.id)
          if (!current) return
          const paused = await stop(current)
          await options.runtime.remove(workspace.id, { deleteData: true })
          if (!options.store.delete(owner, workspace.id, paused.revision))
            throw new WorkspaceError("WORKSPACE_CHANGED", "Workspace cleanup will be retried.", 409)
          eraseReceipts(workspace.id)
        }).catch(() => undefined) // One unavailable container must not prevent another workspace's erasure.
      }
    })()
      .catch(() => {
        /* The durable account fence remains; the reaper retries cleanup. */
      })
      .finally(() => jobs.delete(key))
    jobs.set(key, cleanup)
    return cleanup
  }

  async function command(owner: string, path: string, request: Request, raw: string) {
    if (path === "/accounts/close" && request.method === "POST") {
      if (raw !== "{}")
        throw new WorkspaceError("INVALID_WORKSPACE_REQUEST", "Send a supported account cleanup request.")
      nonceDB.query("INSERT OR IGNORE INTO closed_account(account,closed_at) VALUES (?,?)").run(owner, now())
      for (const workspace of options.store.list(owner)) publishers.get(workspace.id)?.abort()
      void cleanupAccount(owner)
      // `remaining` counts the account's workspaces not yet erased. Account deletion's follow-up pass waits for zero, so
      // a deletion is not finished while a container or volume the runtime keeps refusing still holds the account's data.
      return response({ closed: true, remaining: options.store.list(owner).length }, 202)
    }
    if (isClosed.get(owner))
      throw new WorkspaceError("ACCOUNT_CLOSED", "This account's cloud workspaces are closed.", 403)
    if (request.method === "GET" && path === "/workspaces")
      return response({ enabled: true, workspaces: options.store.list(owner).map(publicWorkspace) })
    if (request.method !== "POST")
      throw new WorkspaceError("METHOD_NOT_ALLOWED", "Use a supported workspace operation.", 405)
    let body: unknown
    try {
      body = JSON.parse(raw)
    } catch {
      throw new WorkspaceError("INVALID_JSON", "Send a valid workspace request.")
    }
    if (path === "/workspaces") {
      const input = parseCommand({ ...(record(body) ? body : {}), action: "create" })
      if (input.action !== "create") throw new Error("Invalid creation.")
      const created = options.store.create(owner, { ...input, enginePassword: randomBytes(32).toString("hex") })
      if (created.created) provision(created.workspace, input)
      return response({ workspace: publicWorkspace(created.workspace) }, created.created ? 202 : 200)
    }
    const match = /^\/workspaces\/([^/]+)\/(start|stop|delete|engine|changes|publish)$/.exec(path)
    if (!match || !workspaceId(match[1]))
      throw new WorkspaceError("WORKSPACE_NOT_FOUND", "This workspace is not available.", 404)
    const input = parseCommand({ ...(record(body) ? body : {}), action: match[2], workspaceId: match[1] })
    const workspace = owned(owner, input.action === "create" ? "" : input.workspaceId)
    if (input.action === "engine") return engine(workspace, input)
    return exclusive(workspace.id, async () => {
      if (input.action === "changes" || input.action === "publish") {
        if (!workspace.baseCommit)
          throw new WorkspaceError(
            "WORKSPACE_BASE_UNKNOWN",
            "Create a new workspace before publishing its changes.",
            409,
          )
        if (input.action === "publish" && workspace.state !== "stopped")
          throw new WorkspaceError("REVIEW_REQUIRED", "Pause and review the changes before publishing.", 409)
        const paused = await stop(workspace)
        const snapshot = await options.runtime.snapshot(workspace.id, { baseCommit: workspace.baseCommit })
        if (isClosed.get(owner))
          throw new WorkspaceError("ACCOUNT_CLOSED", "This account's cloud workspaces are closed.", 403)
        const previous = publication.get(workspace.id)
        if (input.action === "changes")
          return response({
            workspace: publicWorkspace(paused),
            changes: { digest: snapshot.digest, diff: snapshot.diff, files: snapshot.changes.map((file) => file.path) },
            ...(previous ? { pullRequest: JSON.parse(previous.receipt) as unknown } : {}),
          })
        if (input.digest !== snapshot.digest)
          throw new WorkspaceError(
            "CHANGES_CHANGED",
            "The files changed after review. Review them again before publishing.",
            409,
          )
        if (previous) {
          if (previous.digest !== snapshot.digest)
            throw new WorkspaceError(
              "PUBLICATION_CONFLICT",
              "This workspace already published a different change. Open its existing pull request to continue.",
              409,
            )
          return response({ workspace: publicWorkspace(paused), pullRequest: JSON.parse(previous.receipt) as unknown })
        }
        const controller = new AbortController()
        publishers.set(workspace.id, controller)
        const receipt = await (options.publish ?? publishWorkspaceChanges)(
          {
            repository: workspace.repository,
            baseBranch: workspace.branch,
            baseCommit: workspace.baseCommit,
            snapshot,
            token: input.githubToken,
            workspaceId: workspace.id,
            title: input.title,
            signal: controller.signal,
          },
          fetcher,
        ).finally(() => publishers.delete(workspace.id))
        nonceDB
          .query("INSERT INTO publication(workspace,digest,receipt) VALUES (?,?,?)")
          .run(workspace.id, snapshot.digest, JSON.stringify(receipt))
        return response({ workspace: publicWorkspace(paused), pullRequest: receipt })
      }
      if (input.action === "stop") return response({ workspace: publicWorkspace(await stop(workspace)) })
      if (input.action === "delete") {
        if (workspace.state === "running" || workspace.state === "creating")
          throw new WorkspaceError("WORKSPACE_RUNNING", "Stop this workspace before deleting its files and chats.", 409)
        await options.runtime.remove(workspace.id, { deleteData: true })
        if (!options.store.delete(owner, workspace.id, workspace.revision))
          throw new WorkspaceError("WORKSPACE_CHANGED", "Refresh before deleting this workspace.", 409)
        eraseReceipts(workspace.id)
        return response({ deleted: true })
      }
      if (workspace.state === "running") return response({ workspace: publicWorkspace(workspace) })
      if (workspace.state !== "stopped" || !workspace.runtimeId)
        throw new WorkspaceError(
          "WORKSPACE_NOT_READY",
          "This workspace did not finish setup. Delete it and create a new workspace.",
          409,
        )
      const starting = transition(workspace, "creating")
      provision(starting)
      return response({ workspace: publicWorkspace(starting) }, 202)
    })
  }

  async function model(request: Request, path: string) {
    const match = /^\/model\/([^/]+)\/v1\/chat\/completions$/.exec(path)
    if (request.method !== "POST" || !match || !workspaceId(match[1]))
      throw new WorkspaceError("MODEL_UNAVAILABLE", "The cloud model is not available.", 404)
    const workspace = options.store.active().find((item) => item.id === match[1])
    const credential = request.headers.get("authorization")?.replace(/^Bearer /, "") ?? ""
    if (
      !workspace ||
      workspace.state !== "running" ||
      isClosed.get(workspace.ownerId) ||
      !equalSecret(credential, workspace.enginePassword)
    )
      throw new WorkspaceError("MODEL_UNAVAILABLE", "The cloud model is not available.", 401)
    if (retiring.get(workspace.id))
      throw new WorkspaceError("WORKSPACE_RETIRING", "The old engine is still being retired.", 422)
    if (workspace.runningSince === null || now() - workspace.runningSince >= maxRunMs)
      throw new WorkspaceError("WORKSPACE_EXPIRED", "Pause and restart this workspace before continuing.", 422)
    if (modelGuard.get(workspace.id)?.blocked)
      throw new WorkspaceError(
        "MODEL_OUTCOME_UNKNOWN",
        "Send a new turn after reviewing the saved chat to continue.",
        422,
      )
    if (modelRunning.has(workspace.id))
      throw new WorkspaceError("MODEL_BUSY", "A model request is already in progress.", 429)
    const raw = await boundedBody(request, 1_000_000)
    let body: unknown
    try {
      body = JSON.parse(raw)
    } catch {
      throw new WorkspaceError("MODEL_REQUEST_INVALID", "The cloud model request is invalid.")
    }
    if (
      !record(body) ||
      body.model !== options.model.id ||
      !Array.isArray(body.messages) ||
      body.messages.length < 1 ||
      body.messages.length > 1000
    )
      throw new WorkspaceError("MODEL_REQUEST_INVALID", "The cloud model request is invalid.")
    const output = body.max_tokens ?? body.max_completion_tokens ?? maximum
    if (typeof output !== "number" || !Number.isSafeInteger(output) || output < 1 || output > maximum)
      throw new WorkspaceError("MODEL_REQUEST_INVALID", "The cloud model response limit is invalid.")
    if (modelRunning.has(workspace.id))
      throw new WorkspaceError("MODEL_BUSY", "A model request is already in progress.", 429)
    const current = owned(workspace.ownerId, workspace.id)
    if (
      current.state !== "running" ||
      retiring.get(current.id) ||
      isClosed.get(current.ownerId) ||
      current.runningSince === null ||
      now() - current.runningSince >= maxRunMs
    )
      throw new WorkspaceError("WORKSPACE_EXPIRED", "Pause and restart this workspace before continuing.", 409)
    if (!options.store.reserveModel(workspace.ownerId, workspace.id, maxCalls))
      throw new WorkspaceError("MODEL_LIMIT_REACHED", "This workspace reached its cloud preview model limit.", 422)
    modelRunning.add(workspace.id)
    try {
      const allowed = [
        "messages",
        "tools",
        "tool_choice",
        "temperature",
        "top_p",
        "stop",
        "seed",
        "stream",
        "stream_options",
        "parallel_tool_calls",
        "response_format",
        "reasoning_effort",
      ]
      const result = await fetcher(`${upstream.href.replace(/\/$/, "")}/chat/completions`, {
        method: "POST",
        headers: { authorization: `Bearer ${options.model.key}`, "content-type": "application/json" },
        body: JSON.stringify({
          ...Object.fromEntries(Object.entries(body).filter(([key]) => allowed.includes(key))),
          model: options.model.id,
          max_tokens: output,
        }),
        redirect: "error",
        signal: AbortSignal.any([request.signal, AbortSignal.timeout(120_000)]),
      })
      if (!result.ok || !result.body) {
        await result.body?.cancel()
        throw new WorkspaceError(
          "MODEL_REQUEST_FAILED",
          "The cloud model request failed. Its outcome may be unknown; it was not retried.",
          422,
        )
      }
      const reader = result.body.getReader()
      let bytes = 0
      const done = () => modelRunning.delete(workspace.id)
      return new Response(
        new ReadableStream<Uint8Array>({
          async pull(controller) {
            try {
              const item = await reader.read()
              if (item.done) {
                done()
                controller.close()
                return
              }
              bytes += item.value.byteLength
              if (bytes > 8_000_000) {
                blockModel.run(workspace.id)
                await reader.cancel()
                done()
                controller.error(new Error("Model response limit exceeded."))
                return
              }
              controller.enqueue(item.value)
            } catch {
              blockModel.run(workspace.id)
              done()
              controller.error(new Error("Cloud model stream was interrupted."))
            }
          },
          async cancel() {
            blockModel.run(workspace.id)
            done()
            await reader.cancel()
          },
        }),
        {
          headers: {
            "content-type": result.headers.get("content-type")?.includes("event-stream")
              ? "text/event-stream"
              : "application/json",
            "cache-control": "no-store",
          },
        },
      )
    } catch (error) {
      blockModel.run(workspace.id)
      modelRunning.delete(workspace.id)
      if (error instanceof WorkspaceError) throw error
      throw new WorkspaceError(
        "MODEL_REQUEST_FAILED",
        "The cloud model request was interrupted. Review the saved chat before sending a new turn.",
        422,
      )
    }
  }

  return {
    async fetch(request: Request) {
      try {
        if (closed) throw new WorkspaceError("WORKSPACES_UNAVAILABLE", "Cloud workspaces are shutting down.", 503)
        const url = new URL(request.url)
        if (url.search || /[%\\]/.test(url.pathname))
          throw new WorkspaceError("INVALID_WORKSPACE_REQUEST", "Use a supported workspace operation.")
        if (url.pathname.startsWith("/model/")) return await model(request, url.pathname)
        const raw = await boundedBody(request, 128 * 1024)
        const identity = verifyWorkspaceRequest({
          secret: options.secret,
          headers: request.headers,
          method: request.method,
          path: url.pathname,
          body: raw,
          now: now(),
        })
        nonceClean.run(now())
        if (nonceInsert.run(identity.nonce, identity.expiresAt).changes !== 1)
          throw new WorkspaceError("WORKSPACE_REQUEST_REPLAYED", "This workspace request has already been used.", 409)
        return await command(identity.accountId, url.pathname, request, raw)
      } catch (error) {
        if (error instanceof WorkspaceError)
          return response({ error: { code: error.code, message: error.message } }, error.status)
        if (error instanceof StoreError)
          return response(
            {
              error: {
                code: error.code === "quota_exceeded" ? "WORKSPACE_LIMIT_REACHED" : "WORKSPACE_CHANGED",
                message:
                  error.code === "quota_exceeded"
                    ? "Your cloud workspace preview limit has been reached."
                    : "The workspace changed. Refresh before trying again.",
              },
            },
            409,
          )
        if (error instanceof WorkspacePublishError)
          return response(
            {
              error: {
                code: "GITHUB_PUBLICATION_FAILED",
                message:
                  "GitHub publication could not be confirmed. Review the changes again before retrying; Vector will not force-push or merge them.",
              },
            },
            409,
          )
        return response(
          {
            error: {
              code: "WORKSPACES_UNAVAILABLE",
              message: "The cloud workspace service is temporarily unavailable.",
            },
          },
          503,
        )
      }
    },
    async recover() {
      for (const workspace of options.store.active()) {
        // A control-service crash can leave a paid request's outcome unknown. Persist its
        // block before listening, retire the old engine and require explicit Start/new turn.
        // Merely reconnecting its socket would let the engine retry the previous request.
        await stop(workspace).catch(() => undefined)
      }
    },
    async reap() {
      let failed = false
      for (const pending of nonceDB
        .query<{ workspace: string; owner: string }, []>("SELECT workspace,owner FROM retirement_pending")
        .all()) {
        if (leases.has(pending.workspace) || jobs.has(pending.workspace)) continue
        const workspace = options.store.get(pending.owner, pending.workspace)
        if (!workspace) continue
        await exclusive(workspace.id, () => stop(workspace)).catch(() => {
          failed = true
        })
      }
      for (const workspace of options.store.active()) {
        if (workspace.state !== "running" || leases.has(workspace.id) || jobs.has(workspace.id)) continue
        const began =
          "runningSince" in workspace && typeof workspace.runningSince === "number"
            ? workspace.runningSince
            : workspace.updatedAt
        if (now() - began < maxRunMs) continue
        await exclusive(workspace.id, () => stop(workspace)).catch(() => {
          failed = true
        })
      }
      for (const owner of closedAccounts.all()) {
        await cleanupAccount(owner.account)
        // A closed account's workspace that this pass could not erase is reported like an engine that would not stop.
        if (options.store.list(owner.account).length) failed = true
      }
      if (failed) throw new Error("One or more cloud engines or closed accounts' workspaces still need cleanup.")
    },
    async settle() {
      await Promise.all(jobs.values())
    },
    async close() {
      closed = true
      await Promise.all(jobs.values())
      identities.close()
      nonceDB.close()
    },
  }
}

async function boundedBody(input: Request | Response, limit: number) {
  if (!input.body) return ""
  const reader = input.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    while (true) {
      const item = await reader.read()
      if (item.done) break
      size += item.value.byteLength
      if (size > limit) {
        await reader.cancel()
        throw new WorkspaceError("BODY_TOO_LARGE", "The workspace request or response is too large.", 413)
      }
      chunks.push(item.value)
    }
  } finally {
    reader.releaseLock()
  }
  return Buffer.concat(chunks).toString("utf8")
}

function equalSecret(value: string, expected: string) {
  return (
    /^[A-Za-z0-9_-]{32,256}$/.test(value) &&
    value.length === expected.length &&
    timingSafeEqual(Buffer.from(value), Buffer.from(expected))
  )
}

function response(value: unknown, status = 200) {
  return Response.json(value, { status, headers: { "cache-control": "no-store", "x-content-type-options": "nosniff" } })
}
