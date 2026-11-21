import fs from "node:fs/promises"
import path from "node:path"
import { getIDToken, setSecret } from "@actions/core"
import { z } from "zod"
import { GithubAgents } from "@vectordevai/core/github-agents"
import { decodeActionsJobBody, isJobId, type ActionsJobBody } from "@vectordevai/schema/everywhere"
import { githubFetch } from "./github.shared"
import { GithubSecrets } from "./github.secrets"

const SITE = "https://vectordev.ai"
/** A one-time run ticket as `startCloudRun` writes it into a dispatch's `inputs.ticket` (2.5). */
export const TICKET = /^vtk_[A-Za-z0-9_-]{43}$(?![\s\S])/
/** A run id as mint writes it to VECTOR_RUN_ID: `gh-<repositoryId>-<runId>-<runAttempt>-<checkRunId>` (GithubAgents.runId). */
export const MINTED_RUN_ID = /^gh-[1-9]\d{0,19}-[1-9]\d{0,19}-[1-9]\d{0,19}-[1-9]\d{0,19}$(?![\s\S])/
const Run = z
  .object({
    token: z.string().refine(GithubSecrets.validRunToken),
    runId: z.string().regex(MINTED_RUN_ID),
    deadline: z.number().int().positive().safe(),
    heartbeatSeconds: z.literal(GithubAgents.HEARTBEAT_SECONDS),
    idleSeconds: z.literal(GithubAgents.IDLE_SECONDS),
  })
  .strict()
const ErrorBody = z
  .object({
    error: z
      .object({
        code: z.string().max(100),
        message: z.string().max(1000).optional(),
        limit: z.enum(["hours", "at-once", "scheduled"]).optional(),
        perk: z.literal("scheduled").optional(),
      })
      .strict(),
  })
  .strict()
const Heartbeat = z.object({ ok: z.literal(true), stop: z.boolean() }).strict()
const Settled = z.object({ ok: z.literal(true) }).strict()
const Binding = z
  .object({
    bound: z.literal(true),
    repository: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9_.-]{1,100}$(?![\s\S])/),
    repositoryId: z.string().regex(/^[1-9]\d{0,19}$(?![\s\S])/),
    generation: z.number().int().positive().safe(),
    workflowUpdate: z.boolean(),
  })
  .strict()
/** A Brain upload id as brain-download reads it from VECTOR_BRAIN_UPLOAD: `vbu_` and 32 base64url characters. */
export const UPLOAD = /^vbu_[A-Za-z0-9_-]{32}$(?![\s\S])/
/**
 * The job's GITHUB_REPOSITORY_ID as the run's Brain context, restore and save use it: a positive safe integer without a
 * leading zero, the bound the server's mint, binding and Brain routes and the desktop also apply. One rule, so a run
 * never gets its conversation without its Brain context, or the other way round.
 */
export const isRepositoryId = (value: string | undefined) =>
  /^[1-9]\d{0,15}$(?![\s\S])/.test(value ?? "") && Number.isSafeInteger(Number(value))
const canonical = (value: string) => Buffer.from(value, "base64url").toString("base64url") === value
// The same 32-byte key shape github.session.ts's keyBytes accepts, for the ordinary and the Brain conversation key.
const Key = z
  .object({
    key: z
      .string()
      .regex(/^[A-Za-z0-9_-]{43}$(?![\s\S])/)
      .refine(canonical),
    keyId: z.string().regex(/^[0-9a-f]{16}$(?![\s\S])/),
  })
  .strict()
// The largest approved upload (BrainRunBundle.MAX_BYTES, the server's BRAIN_UPLOAD_MAX) plus its 16-byte GCM tag, as
// unpadded base64url. A literal, so the mint path never loads the Brain modules.
const BRAIN_CIPHERTEXT = Math.ceil(((512 * 1024 + 16) * 4) / 3)
// The answer's other fields take well under 1 KiB, so a 4 KiB margin holds them without admitting a larger envelope.
const BRAIN_RESPONSE = BRAIN_CIPHERTEXT + 4096
const BrainAnswer = z
  .object({
    uploadId: z.string().regex(UPLOAD),
    key: Key.shape.key,
    aad: z.string().min(1).max(256),
    nonce: z.string().regex(/^[A-Za-z0-9_-]{16}$(?![\s\S])/),
    // At least one approved byte and the tag.
    ciphertext: z
      .string()
      .min(23)
      .max(BRAIN_CIPHERTEXT)
      .regex(/^[A-Za-z0-9_-]+$(?![\s\S])/),
    sha256: z.string().regex(/^[0-9a-f]{64}$(?![\s\S])/),
    bytes: z
      .number()
      .int()
      .min(1)
      .max(512 * 1024),
    approvedAt: z.number().int().positive().safe(),
    publicRepository: z.boolean(),
    artifactKey: Key.optional(),
  })
  .strict()

/** A live desktop Brain run's download answer, as `/api/cloud-agents/brain-download` builds it (spec 2.8). */
export type BrainDownload = z.infer<typeof BrainAnswer>
/** Every answer of the key and Brain clients other than "ok". None of them carries server text (P6, spec 2.13). */
export type KeyStatus = "absent" | "brain-run" | "refused" | "expired" | "not-allowed" | "unavailable"

export type Services = {
  oidc: (audience: string) => Promise<string>
  mask: (value: string) => void
  request: (url: string, init: RequestInit) => Promise<Response>
  now: () => number
  monotonic: () => number
  wait: (ms: number) => Promise<void>
  notice: (message: string) => void
}
const services: Services = {
  oidc: getIDToken,
  mask: setSecret,
  request: githubFetch,
  now: Date.now,
  monotonic: () => performance.now(),
  wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  notice: console.log,
}

async function body(response: Response, maximum = 16_384) {
  const reader = response.body?.getReader()
  if (!reader) return
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    while (true) {
      const part = await reader.read()
      if (part.done) break
      size += part.value.byteLength
      if (size > maximum) {
        await reader.cancel()
        return
      }
      chunks.push(part.value)
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown
  } catch {
    return
  }
}

function bounded<T>(run: () => Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new Error("GitHub authorization timed out or was cancelled."))
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(new Error("GitHub authorization timed out or was cancelled."))
    signal.addEventListener("abort", abort, { once: true })
    Promise.resolve()
      .then(() => {
        signal.throwIfAborted()
        return run()
      })
      .then(
        (value) => {
          signal.removeEventListener("abort", abort)
          resolve(value)
        },
        () => {
          signal.removeEventListener("abort", abort)
          reject(new Error("GitHub authorization is unavailable."))
        },
      )
  })
}

async function post(
  endpoint: string,
  credential: string,
  data: unknown,
  client: Services,
  options: { signal?: AbortSignal; timeout?: number; maximum?: number } = {},
) {
  return send(endpoint, credential, client, { ...options, body: JSON.stringify(data) })
}

/**
 * One request to vectordev.ai with `credential` as its bearer: a POST of the JSON text `options.body`, or a GET when
 * there is none. It follows no redirect, sends no cookie, skips every cache and gives up after `options.timeout`
 * (20 s by default) or on the signal. It answers the response and its JSON body, read up to `options.maximum` bytes,
 * or undefined when the request failed.
 */
async function send(
  endpoint: string,
  credential: string,
  client: Services,
  options: { body?: string; signal?: AbortSignal; timeout?: number; maximum?: number } = {},
) {
  const timeout = AbortSignal.timeout(options.timeout ?? 20_000)
  const until = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout
  return bounded(async () => {
    const response = await client.request(SITE + endpoint, {
      method: options.body === undefined ? "GET" : "POST",
      redirect: "error",
      credentials: "omit",
      cache: "no-store",
      headers: {
        Authorization: `Bearer ${credential}`,
        ...(options.body === undefined ? {} : { "Content-Type": "application/json" }),
        Accept: "application/json",
      },
      ...(options.body === undefined ? {} : { body: options.body }),
      signal: until,
    })
    if (until.aborted) {
      await response.body?.cancel().catch(() => undefined)
      return
    }
    return { response, body: await body(response, options.maximum) }
  }, until).catch(() => undefined)
}

const REFUSALS: Record<string, readonly [number, GithubAgents.MintStatus]> = {
  INVALID_REQUEST: [400, "denied"],
  INVALID_JSON: [400, "denied"],
  OIDC_INVALID: [401, "denied"],
  WORKFLOW_NOT_TRUSTED: [403, "denied"],
  EVENT_NOT_ALLOWED: [403, "denied"],
  ACTOR_NOT_ALLOWED: [403, "denied"],
  COMMENT_CHANGED: [403, "denied"],
  EVENT_NEEDS_APP: [403, "needs-app"],
  RUNNER_NOT_SUPPORTED: [403, "runner"],
  REPO_NOT_BOUND: [404, "not-bound"],
  BINDING_SUSPENDED: [409, "suspended"],
  WORKFLOW_UPDATE_REQUIRED: [426, "update-required"],
  BINDING_UNAVAILABLE: [403, "binding-unavailable"],
  CLOUD_AGENTS_SOURCE_UNAVAILABLE: [403, "source-unavailable"],
  MODEL_PLANS_DISABLED: [503, "service-off"],
  PERSISTENT_STORE_UNAVAILABLE: [503, "unavailable"],
  GITHUB_UNAVAILABLE: [503, "unavailable"],
  RUN_TOKENS_UNAVAILABLE: [503, "unavailable"],
  CLOUD_AGENTS_UNAVAILABLE: [503, "unavailable"],
}

/** Error bodies are decoded for a finite decision only. Their messages never reach a log or an exception. */
export function mintStatus(status: number, value: unknown): GithubAgents.MintStatus {
  const error = ErrorBody.safeParse(value)
  if (!error.success) return "unavailable"
  if (error.data.error.code === "MODEL_PLAN_RUN_LIMIT")
    return status === 429 && error.data.error.limit && !error.data.error.perk ? error.data.error.limit : "unavailable"
  if (error.data.error.code === "CODIUM_PERK_REQUIRED")
    return status === 403 && error.data.error.perk === "scheduled" && !error.data.error.limit
      ? "not-in-plan"
      : "unavailable"
  if (error.data.error.limit || error.data.error.perk) return "unavailable"
  const refusal = REFUSALS[error.data.error.code]
  return refusal?.[0] === status ? refusal[1] : "unavailable"
}

function workflowVersion(env: Readonly<Record<string, string | undefined>>) {
  if (!/^[1-9]\d{0,3}$(?![\s\S])/.test(env.VECTOR_WORKFLOW_VERSION ?? ""))
    throw new Error("The GitHub workflow version is invalid. Update the workflow.")
  return env.VECTOR_WORKFLOW_VERSION!
}

async function identity(audience: string, client: Services, signal = AbortSignal.timeout(20_000)) {
  const value = await bounded(() => client.oidc(audience), signal).catch(() => undefined)
  if (!value || value.length > 20_000 || !/^[A-Za-z0-9_.-]+$(?![\s\S])/.test(value)) return
  client.mask(value)
  return value
}

export async function mintRunToken(input: {
  purpose: "task" | "review"
  env?: Record<string, string | undefined>
  services?: Services
  signal?: AbortSignal
}) {
  const env = input.env ?? process.env
  const client = input.services ?? services
  if (env.GITHUB_ACTIONS !== "true" || env.VECTOR_MODE !== "codium")
    throw new Error("Mint is available only in a Codium GitHub Actions job.")
  if (!env.GITHUB_OUTPUT || !path.isAbsolute(env.GITHUB_OUTPUT) || !env.GITHUB_ENV || !path.isAbsolute(env.GITHUB_ENV))
    throw new Error("GitHub Actions file commands are unavailable.")
  const output = env.GITHUB_OUTPUT
  const environment = env.GITHUB_ENV
  const finish = async (status: GithubAgents.MintStatus) => {
    await fs.appendFile(output, `status=${status}\n`).catch(() => {
      throw new Error("Could not write the GitHub run status.")
    })
    return status
  }
  const version = workflowVersion(env)
  if (!GithubAgents.THREAD_PATTERN.test(env.VECTOR_THREAD ?? "") || /[\r\n]/.test(env.VECTOR_THREAD ?? ""))
    return finish("denied")
  const optionalId = (value: string | undefined) =>
    !value
      ? undefined
      : /^[1-9]\d{0,15}$(?![\s\S])/.test(value) && Number.isSafeInteger(Number(value))
        ? Number(value)
        : null
  const comment = optionalId(env.VECTOR_COMMENT_ID)
  const pr = optionalId(env.VECTOR_PR)
  if (comment === null || pr === null || (env.VECTOR_TICKET && !TICKET.test(env.VECTOR_TICKET))) return finish("denied")
  let retries = 0
  let polls = 0
  let waitUntil: number | undefined
  const expired = () => waitUntil !== undefined && client.monotonic() >= waitUntil
  const remaining = () => (waitUntil === undefined ? Infinity : Math.max(0, waitUntil - client.monotonic()))
  const operation = (limit = 20_000) => {
    const timeout = AbortSignal.timeout(Math.max(1, Math.ceil(Math.min(limit, remaining()))))
    return input.signal ? AbortSignal.any([input.signal, timeout]) : timeout
  }
  const wait = async (ms: number) => {
    if (expired()) return
    const duration = Math.min(ms, remaining())
    await bounded(() => client.wait(duration), operation(duration + 1)).catch(() => undefined)
  }
  while (true) {
    input.signal?.throwIfAborted()
    if (expired()) return finish("at-once")
    const proof = await identity(GithubAgents.AUDIENCE.mint, client, operation())
    input.signal?.throwIfAborted()
    if (expired()) return finish("at-once")
    if (!proof) return finish("unavailable")
    const answer = await post(
      GithubAgents.ENDPOINT.mint,
      proof,
      {
        purpose: input.purpose,
        thread: env.VECTOR_THREAD,
        workflowVersion: version,
        ...(comment ? { commentId: comment } : {}),
        ...(pr ? { pullRequest: pr } : {}),
        ...(env.VECTOR_TICKET ? { ticket: env.VECTOR_TICKET } : {}),
      },
      client,
      { signal: operation() },
    )
    input.signal?.throwIfAborted()
    if (expired()) return finish("at-once")
    if (!answer) return finish("unavailable")
    if (answer.response.status === 200) {
      const result = Run.safeParse(answer.body)
      if (!result.success || result.data.deadline <= client.now()) return finish("unavailable")
      client.mask(result.data.token)
      try {
        if (expired()) return finish("at-once")
        input.signal?.throwIfAborted()
        await GithubSecrets.writeRunToken(result.data.token, env)
        if (expired() || input.signal?.aborted) {
          await fs.unlink(GithubSecrets.runTokenPath(env))
          input.signal?.throwIfAborted()
          return finish("at-once")
        }
        await fs.appendFile(
          environment,
          `VECTOR_RUN_DEADLINE=${result.data.deadline}\nVECTOR_RUN_ID=${result.data.runId}\n`,
        )
        await fs.appendFile(output, `rid=${result.data.runId}\n`)
      } catch {
        throw new Error("Could not store the private GitHub run credential.")
      }
      return finish("ok")
    }
    const parsed = ErrorBody.safeParse(answer.body)
    const code = parsed.success ? parsed.data.error.code : undefined
    if (
      (answer.response.status === 409 && code === "OIDC_REPLAYED") ||
      (answer.response.status === 429 && code === "RATE_LIMITED")
    ) {
      if (retries++ >= 3) return finish("unavailable")
      const retry = answer.response.headers.get("retry-after")
      await wait(
        code === "RATE_LIMITED" && retry && /^\d+$/.test(retry) ? Math.min(30_000, Number(retry) * 1000) : 1000,
      )
      continue
    }
    const status = mintStatus(answer.response.status, answer.body)
    if (status !== "at-once" || polls++ >= 20) return finish(status)
    waitUntil ??= client.monotonic() + GithubAgents.AT_ONCE_WAIT_MS
    await wait(GithubAgents.AT_ONCE_POLL_MS)
  }
}

export async function bindRepository(input: { env?: Record<string, string | undefined>; services?: Services } = {}) {
  const env = input.env ?? process.env
  const client = input.services ?? services
  if (env.GITHUB_ACTIONS !== "true") {
    client.notice("Bind must run in GitHub Actions.")
    return 2 as const
  }
  const event = await (async () => {
    if (!env.GITHUB_EVENT_PATH) return
    const info = await fs.stat(env.GITHUB_EVENT_PATH)
    if (info.size > 1_048_576) return
    return JSON.parse(await fs.readFile(env.GITHUB_EVENT_PATH, "utf8")) as unknown
  })().catch(() => undefined)
  const repo = z.object({ repository: z.object({ default_branch: z.string().min(1).max(240) }) }).safeParse(event)
  if (!repo.success || env.GITHUB_REF !== `refs/heads/${repo.data.repository.default_branch}`) {
    client.notice("Run the bind from the default branch.")
    return 2 as const
  }
  if (!/^vbc_[A-Za-z0-9_-]{43}$(?![\s\S])/.test(env.VECTOR_BIND_CODE ?? "")) {
    client.notice("The bind code is invalid or expired. Create a new code in Vector.")
    return 2 as const
  }
  const proof = await identity(GithubAgents.AUDIENCE.bind, client)
  if (!proof) {
    client.notice("GitHub could not authorize the bind. Retry the workflow.")
    return 1 as const
  }
  const version = workflowVersion(env)
  const answer = await post(
    GithubAgents.ENDPOINT.bind,
    proof,
    { code: env.VECTOR_BIND_CODE, workflowVersion: version },
    client,
  )
  const parsed = answer?.response.status === 200 ? Binding.safeParse(answer.body) : undefined
  if (
    parsed?.success &&
    parsed.data.repository === env.GITHUB_REPOSITORY &&
    parsed.data.repositoryId === env.GITHUB_REPOSITORY_ID
  ) {
    client.notice(`Bound ${parsed.data.repository} to a Vector account.`)
    if (parsed.data.workflowUpdate) client.notice("Update the workflow from Vector before starting a Codium run.")
    return 0 as const
  }
  if (answer && [400, 401, 403, 404, 409, 426].includes(answer.response.status)) {
    client.notice("The repository could not be bound. Check the code, default branch and permissions.")
    return 2 as const
  }
  client.notice("The repository binding service is unavailable. Retry the workflow.")
  return 1 as const
}

export async function heartbeat(input: {
  token?: string
  state: "starting" | "running"
  services?: Services
  signal?: AbortSignal
}) {
  if (!input.token || !GithubSecrets.validRunToken(input.token)) return { ok: false, stop: true } as const
  const answer = await post(
    GithubAgents.ENDPOINT.heartbeat,
    input.token,
    { state: input.state },
    input.services ?? services,
    { signal: input.signal, timeout: 5000 },
  )
  const parsed = answer?.response.status === 200 ? Heartbeat.safeParse(answer.body) : undefined
  return parsed?.success ? parsed.data : ({ ok: false, stop: true } as const)
}

export async function settle(input: {
  token?: string
  outcome: GithubAgents.Outcome
  /**
   * The pull request this run opened, as https://github.com/<owner>/<repo>/pull/<n>. Optional: vectordev.ai passes it to
   * its settle listener only for this run's own repository and ignores anything else (R-A3). No phase sets it yet: the
   * agent phase settles before the publish job opens the pull request.
   */
  prUrl?: string
  services?: Services
  signal?: AbortSignal
}) {
  if (!input.token || !GithubSecrets.validRunToken(input.token)) return false
  const answer = await post(
    GithubAgents.ENDPOINT.settle,
    input.token,
    { outcome: input.outcome, ...(input.prUrl === undefined ? {} : { prUrl: input.prUrl }) },
    input.services ?? services,
    { signal: input.signal, timeout: 5000 },
  )
  return answer?.response.status === 200 && Settled.safeParse(answer.body).success
}

const KEY_REFUSALS: Record<string, readonly [number, "refused" | "expired" | "not-allowed"]> = {
  INVALID_REQUEST: [400, "refused"],
  RUN_TOKEN_INVALID: [401, "refused"],
  MODEL_PLAN_RUN_EXPIRED: [401, "expired"],
  ARTIFACT_KEY_NOT_ALLOWED: [403, "not-allowed"],
}
const BRAIN_REFUSALS: Record<string, readonly [number, "refused" | "expired"]> = {
  BRAIN_UPLOAD_INVALID: [400, "refused"],
  RUN_TOKEN_INVALID: [401, "refused"],
  MODEL_PLAN_RUN_EXPIRED: [401, "expired"],
}

/**
 * The ordinary conversation key for this run's own thread (V27, spec 2.13). Only an authorized Codium run token asks,
 * and only once: own key holds no run token, so it never reaches this route (INV-K1). A desktop Brain run, whose
 * workflow sets VECTOR_BRAIN_UPLOAD, never asks: its conversation key comes only from brainDownload (deviations,
 * "2026-11-15 BT03" item 4). It never throws, retries or prints, so a failure only costs the saved session (V27).
 */
export async function artifactKey(
  input: {
    env?: Readonly<Record<string, string | undefined>>
    holder?: Pick<typeof GithubSecrets.credentials, "runToken">
    services?: Services
    signal?: AbortSignal
  } = {},
) {
  const env = input.env ?? process.env
  const token = (input.holder ?? GithubSecrets.credentials).runToken()
  const thread = env.VECTOR_THREAD ?? ""
  if (!token || !GithubSecrets.validRunToken(token) || !GithubAgents.THREAD_PATTERN.test(thread))
    return { status: "absent" } as const
  if (env.VECTOR_BRAIN_UPLOAD) return { status: "brain-run" } as const
  const client = input.services ?? services
  const answer = await post(GithubAgents.ENDPOINT.artifactKey, token, { thread }, client, { signal: input.signal })
  if (!answer) return { status: "unavailable" } as const
  if (answer.response.status !== 200)
    return { status: refusal(KEY_REFUSALS, answer.response.status, answer.body) } as const
  const key = Key.safeParse(answer.body)
  if (!key.success) return { status: "unavailable" } as const
  client.mask(key.data.key)
  return { status: "ok", key: key.data } as const
}

/**
 * The owner-approved Brain upload for this live desktop run (B08, spec 2.8): the opaque envelope, its content key, and
 * the separately labelled Brain conversation key. Only an authorized Codium run token asks, once. The id comes only
 * from VECTOR_BRAIN_UPLOAD, the variable that makes artifactKey answer brain-run, so a step that can download Brain
 * context can never also ask for the ordinary key; an empty or malformed id is no request. GithubBrain.openUpload
 * checks the envelope locally.
 */
export async function brainDownload(
  input: {
    env?: Readonly<Record<string, string | undefined>>
    holder?: Pick<typeof GithubSecrets.credentials, "runToken">
    services?: Services
    signal?: AbortSignal
  } = {},
) {
  const uploadId = (input.env ?? process.env).VECTOR_BRAIN_UPLOAD ?? ""
  const token = (input.holder ?? GithubSecrets.credentials).runToken()
  if (!token || !GithubSecrets.validRunToken(token) || !UPLOAD.test(uploadId)) return { status: "absent" } as const
  const client = input.services ?? services
  const answer = await post(GithubAgents.ENDPOINT.brainDownload, token, { uploadId }, client, {
    signal: input.signal,
    maximum: BRAIN_RESPONSE,
  })
  if (!answer) return { status: "unavailable" } as const
  if (answer.response.status !== 200)
    return { status: refusal(BRAIN_REFUSALS, answer.response.status, answer.body) } as const
  const download = BrainAnswer.safeParse(answer.body)
  if (!download.success || download.data.uploadId !== uploadId) return { status: "unavailable" } as const
  client.mask(download.data.key)
  if (download.data.artifactKey) client.mask(download.data.artifactKey.key)
  return { status: "ok", download: download.data } as const
}

/** How many times in all, and how far apart, an Actions run reads its Vector everywhere job's body (R-A4). */
export const EVERYWHERE_BODY_ATTEMPTS = 7
export const EVERYWHERE_BODY_RETRY_MS = 1000
// The largest answer the body route can give is about 193 KB: 32,000 characters of task and context, each at most six
// bytes once JSON escapes it, and the field names. 256 KiB holds it, and nothing larger is read.
const EVERYWHERE_BODY_RESPONSE = 256 * 1024

type EverywhereBody =
  | { readonly status: "absent" | "unavailable" }
  | { readonly status: "ok"; readonly body: ActionsJobBody }

/**
 * The request of the Vector everywhere job this Actions run serves, read by reference (R-A4, spec 3.6): GET
 * /api/everywhere/jobs/<jid>/body with the run token. Only an authorized Codium run token asks, and only for a
 * well-formed job id; own key holds no run token (INV-K1). Only a 200 that is exactly the body is "ok"
 * (decodeActionsJobBody). The route's own 404 NOT_FOUND, its answer to a run it has not linked, is read again
 * EVERYWHERE_BODY_RETRY_MS later, up to EVERYWHERE_BODY_ATTEMPTS reads in all: that read is unspent, and the start
 * listener that links the run runs after the mint's answer. Any other answer, an outage, a redirect, an answer over
 * the cap or the signal is "unavailable" at once, with no second read of a body that may already be spent. It never
 * throws, prints, masks or logs the answer.
 */
export async function everywhereJobBody(input: {
  jid: string
  holder?: Pick<typeof GithubSecrets.credentials, "runToken">
  services?: Services
  signal?: AbortSignal
}) {
  const token = (input.holder ?? GithubSecrets.credentials).runToken()
  if (!token || !GithubSecrets.validRunToken(token) || !isJobId(input.jid)) return { status: "absent" } as const
  const client = input.services ?? services
  const read = async (attempt: number): Promise<EverywhereBody> => {
    const answer = await send(`/api/everywhere/jobs/${input.jid}/body`, token, client, {
      signal: input.signal,
      maximum: EVERYWHERE_BODY_RESPONSE,
    })
    if (!answer) return { status: "unavailable" }
    if (answer.response.status === 200) {
      const body = decodeActionsJobBody(answer.body)
      return body.ok ? { status: "ok", body: body.value } : { status: "unavailable" }
    }
    const error = ErrorBody.safeParse(answer.body)
    if (
      attempt >= EVERYWHERE_BODY_ATTEMPTS ||
      answer.response.status !== 404 ||
      !error.success ||
      error.data.error.code !== "NOT_FOUND"
    )
      return { status: "unavailable" }
    const pause = AbortSignal.timeout(EVERYWHERE_BODY_RETRY_MS + 1000)
    const waited = await bounded(
      () => client.wait(EVERYWHERE_BODY_RETRY_MS),
      input.signal ? AbortSignal.any([input.signal, pause]) : pause,
    ).then(
      () => true,
      () => false,
    )
    return waited ? read(attempt + 1) : { status: "unavailable" }
  }
  return read(1)
}

/** A refusal is one of the route's own codes at its own status; anything else, and every message, stays unread. */
function refusal<T extends KeyStatus>(
  table: Readonly<Record<string, readonly [number, T]>>,
  status: number,
  value: unknown,
): T | "unavailable" {
  const error = ErrorBody.safeParse(value)
  if (!error.success || error.data.error.limit || error.data.error.perk) return "unavailable"
  const known = table[error.data.error.code]
  return known?.[0] === status ? known[1] : "unavailable"
}

/** The account gate's run-domain decision; it never consults saved/CLI credentials or grants offline grace. */
export async function verifyGithubRun(holder = GithubSecrets.credentials, client: Services = services) {
  return holder.authorize(async (token) => {
    const answer = await heartbeat({ token, state: "starting", services: client })
    return answer.ok && !answer.stop
  })
}
