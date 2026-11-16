import { createHash, createHmac, randomUUID } from "node:crypto"
import { GithubAgents } from "@vectordevai/core/github-agents"
import {
  buildAgentsWorkflow,
  cliVersionSpec,
  readWorkflowOptions,
  type AgentsWorkflowOptions,
} from "@vectordevai/core/review/workflow"
import type {
  AgentBinding,
  AgentListing,
  AgentMutationScope,
  AgentRun,
  AgentSetupInput,
  AgentSetupPreview,
  AgentsStatus,
} from "../../../app/src/features/github-agents/agents-model"
import {
  githubFetch,
  githubJson,
  GithubRequestError,
  gitRemotes,
  pickBaseRemote,
  type GithubAccess,
  type GithubRepoRef,
} from "./github-api"
import { resolveGithubAccess } from "./github-access"
import { requirePullRequestDirectory, requireSecretNames, requireWorkflowModel } from "./github-pr-input"
import type { createGithubAgentsBrain } from "./github-agents-brain"
import type { ServerReadyData } from "../preload/types"

const SITE = "https://vectordev.ai"
const EMPTY_LISTING: AgentListing = { agents: false, scheduled: false, noSecret: false, brain: false }
const BODY_LIMIT = 512_000
type Dependencies = {
  version: string
  token(): Promise<string | undefined>
  fetch?: typeof fetch
  access?: () => Promise<GithubAccess | undefined>
  repository?: (cwd: string) => Promise<GithubRepoRef | undefined>
  now?: () => number
  sleep?: (milliseconds: number) => Promise<void>
  authorityRevision?: () => number
  engine?: () => Promise<ServerReadyData>
}
type Repository = {
  id: number
  full_name: string
  default_branch: string
  private: boolean
  permissions?: { push?: boolean }
}

/** Both desktop setup paths use the same v3 workflow builder; provider secrets are names only. */
export function agentsWorkflowPreview(
  input: { mode: "codium" | "own-key"; model?: unknown; keys?: unknown; autoReview: boolean; share?: boolean },
  version: string,
  handle?: string,
  monthlyUsd?: number,
): AgentSetupPreview & { model: string } {
  if (input.mode !== "codium" && input.mode !== "own-key") throw new Error("Choose Codium or your own provider key.")
  if (typeof input.autoReview !== "boolean" || (input.share !== undefined && typeof input.share !== "boolean"))
    throw new Error("Invalid GitHub setup options.")
  if (
    input.mode === "codium" &&
    (input.autoReview || input.share || (input.keys !== undefined && (!Array.isArray(input.keys) || input.keys.length)))
  )
    throw new Error("Codium workflows cannot share publicly, auto-review, or contain provider secrets.")
  const selected =
    input.mode === "codium" ? { provider: "vector", model: "vector-plan" } : requireWorkflowModel(input.model)
  const keys =
    selected.provider === "vector"
      ? []
      : requireSecretNames(input.keys ?? []).filter((name) => name !== "VECTOR_CLI_TOKEN")
  const options: AgentsWorkflowOptions = {
    ...selected,
    mode: input.mode,
    keys,
    autoReview: input.autoReview,
    share: input.share ?? false,
    version,
    ...(handle ? { handle } : {}),
    ...(monthlyUsd === undefined ? {} : { monthlyUsd }),
  }
  return {
    path: GithubAgents.WORKFLOW_FILE,
    content: buildAgentsWorkflow(options),
    model: `${selected.provider}/${selected.model}`,
    secrets:
      input.mode === "codium"
        ? []
        : [
            {
              name: "VECTOR_CLI_TOKEN",
              detail: "Signs the workflow in to your Vector account. Create one at vectordev.ai/auth/cli.",
              url: "https://vectordev.ai/auth/cli",
            },
            ...keys.map((name) => ({ name, detail: "Your model provider's API key." })),
          ],
  }
}

/** Desktop credentials stay inside main: account credentials go to Vector; GitHub credentials go through githubJson. */
export function createGithubAgents(deps: Dependencies) {
  const request = deps.fetch ?? fetch
  const now = deps.now ?? Date.now
  const sleep =
    deps.sleep ?? ((milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)))
  const access = deps.access ?? resolveGithubAccess
  const repository = deps.repository ?? (async (cwd: string) => pickBaseRemote(await gitRemotes(cwd))?.repo)
  const authoritySecret = randomUUID()
  let authorityEpoch = 0
  let observedActor: string | undefined
  type Actor = {
    key: string
    principal: string
    epoch: number
    revision: number
    token?: string
    access?: GithubAccess
  }
  function assertActor(owner: Actor) {
    if (owner.epoch !== authorityEpoch || owner.revision !== (deps.authorityRevision?.() ?? 0))
      throw new Error("Your sign-in changed. Review this repository again.")
  }
  async function clearBrain() {
    if (brainPromise)
      await brainPromise.then(
        (controller) => controller.clear(),
        () => undefined,
      )
  }
  function invalidateAuthority() {
    authorityEpoch++
    observedActor = undefined
    void clearBrain()
  }
  async function actors(): Promise<Actor> {
    const epoch = authorityEpoch
    const revision = deps.authorityRevision?.() ?? 0
    const [token, signed] = await Promise.all([deps.token(), access()])
    if (epoch !== authorityEpoch || revision !== (deps.authorityRevision?.() ?? 0))
      throw new Error("Your sign-in changed. Review this repository again.")
    const principal = hash(JSON.stringify([token, signed?.token, signed?.source, signed?.apiUrl]))
    // External GitHub credential changes have no IPC revision event. Retire every earlier observation even if the
    // credentials later return to the same value; an old approval must never become current again.
    const observation = hash(JSON.stringify([revision, principal]))
    if (observedActor !== undefined && observedActor !== observation) invalidateAuthority()
    observedActor = observation
    const key = hash(JSON.stringify([authorityEpoch, revision, principal]))
    return { key, principal, epoch: authorityEpoch, revision, token, access: signed }
  }
  async function fence(owner: Actor) {
    const current = await actors()
    assertActor(owner)
    if (current.key !== owner.key) throw new Error("Your sign-in changed. Review this repository again.")
  }
  async function vector(
    path: string,
    body?: unknown,
    authenticated = true,
    expectedAccount?: string,
    expectedActor?: string,
  ): Promise<unknown> {
    const owner = authenticated ? await actors() : undefined
    const token = owner?.token
    if (owner) assertActor(owner)
    if (expectedActor && owner?.key !== expectedActor)
      throw new Error("Your sign-in changed. Review this repository again.")
    if (authenticated && !token) throw new Error("Sign in to Vector to connect this repository.")
    if (expectedAccount && (!token || createHash("sha256").update(token).digest("hex") !== expectedAccount))
      throw new Error("Your Vector sign-in changed. Review the attachment again.")
    const response = await request(SITE + path, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        accept: "application/json",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
    })
    if (!response.ok) throw new Error("Vector could not complete this GitHub request. Try again.")
    const text = await response.text()
    if (Buffer.byteLength(text) > BODY_LIMIT) throw new Error("Vector returned an invalid GitHub response.")
    if (owner) await fence(owner)
    return JSON.parse(text)
  }
  async function listing() {
    const body = await vector("/api/model-plans/config", undefined, false).catch(() => undefined)
    if (!record(body) || body.enabled !== true || !Array.isArray(body.listed)) return { ...EMPTY_LISTING }
    const agents = body.listed.includes("github-agents")
    return {
      agents,
      scheduled: agents && body.listed.includes("scheduled"),
      noSecret: agents && body.listed.includes("github-no-secret"),
      brain: agents && body.listed.includes("brain-cloud"),
    }
  }
  async function context(cwd: string, owner?: Actor) {
    requirePullRequestDirectory(cwd)
    const actor = owner ?? (await actors())
    const signed = actor.access
    const repo = await repository(cwd)
    if (!signed) throw new Error("Sign in to GitHub to work in this repository.")
    if (!repo) throw new Error("Add a GitHub remote to this repository first.")
    const response = await githubFetch(signed, repoPath(repo))
    const info: unknown = await response.json()
    if (
      !record(info) ||
      !Number.isSafeInteger(info.id) ||
      Number(info.id) < 1 ||
      typeof info.full_name !== "string" ||
      typeof info.default_branch !== "string" ||
      typeof info.private !== "boolean"
    )
      throw new Error("GitHub returned invalid repository details.")
    const value = info as Repository
    if (
      value.full_name.toLowerCase() !== `${repo.owner}/${repo.name}`.toLowerCase() ||
      !value.default_branch ||
      value.default_branch.includes("\0")
    )
      throw new Error("GitHub returned a different repository.")
    await fence(actor)
    const remote = await repository(cwd)
    if (!remote || repoPath(remote).toLowerCase() !== repoPath(repo).toLowerCase())
      throw new Error("The repository remote changed. Review this repository again.")
    assertActor(actor)
    return {
      access: signed,
      repo,
      info: value,
      scopes: response.headers.get("x-oauth-scopes"),
      actor,
      authority: hash(
        JSON.stringify([
          actor.key,
          value.id,
          value.full_name,
          value.private,
          value.default_branch,
          value.permissions?.push === true,
        ]),
      ),
    }
  }
  async function workflow(ctx: Awaited<ReturnType<typeof context>>) {
    const value = await githubJson<{ encoding?: unknown; content?: unknown; sha?: unknown; html_url?: unknown }>(
      ctx.access,
      `${repoPath(ctx.repo)}/contents/${GithubAgents.WORKFLOW_FILE}?ref=${encodeURIComponent(ctx.info.default_branch)}`,
    ).catch((error: unknown) => {
      if (error instanceof GithubRequestError && error.status === 404) return undefined
      throw error
    })
    if (!value) return
    if (value.encoding !== "base64" || typeof value.content !== "string" || value.content.length > BODY_LIMIT * 2)
      throw new Error("The GitHub workflow could not be read safely.")
    const encoded = value.content.replaceAll(/\s/g, "")
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) throw new Error("The GitHub workflow has an invalid encoding.")
    const bytes = Buffer.from(encoded, "base64")
    if (bytes.byteLength > BODY_LIMIT) throw new Error("The GitHub workflow is too large.")
    const content = bytes.toString("utf8")
    return {
      content,
      options: readWorkflowOptions(content),
      sha: typeof value.sha === "string" ? value.sha : undefined,
      url: typeof value.html_url === "string" ? value.html_url : undefined,
    }
  }
  async function readBindings(owner?: Actor) {
    const actor = owner ?? (await actors())
    await fence(actor)
    const body = await vector(
      GithubAgents.ENDPOINT.bindings,
      undefined,
      true,
      actor.token ? hash(actor.token) : undefined,
      actor.key,
    )
    if (!record(body) || !Array.isArray(body.bindings) || body.bindings.length > 200)
      throw new Error("Vector returned invalid repository connections.")
    await fence(actor)
    assertActor(actor)
    return body.bindings.map((value: unknown) => {
      const row = binding(value)
      const generation =
        record(value) &&
        typeof value.generation === "number" &&
        Number.isSafeInteger(value.generation) &&
        value.generation > 0
          ? value.generation
          : undefined
      const authorityId =
        generation === undefined
          ? undefined
          : createHmac("sha256", authoritySecret)
              .update(
                JSON.stringify([
                  actor.key,
                  row.repositoryId,
                  generation,
                  row.boundAt,
                  row.workflowVersion,
                  row.repository,
                  row.binder,
                  row.suspended,
                ]),
              )
              .digest("hex")
      return { row: { ...row, ...(authorityId ? { authorityId } : {}) }, generation }
    })
  }
  async function bindings(): Promise<AgentBinding[]> {
    return (await readBindings()).map((value) => value.row)
  }
  async function inspect(cwd: string): Promise<{ current: AgentsStatus; ctx?: Awaited<ReturnType<typeof context>> }> {
    requirePullRequestDirectory(cwd)
    const actor = await actors()
    const exposed = await listing()
    const listed = { ...exposed, brain: exposed.brain && deps.engine !== undefined }
    if (!actor.access) {
      await fence(actor)
      return {
        current: {
          signedIn: false,
          canDispatch: false,
          workflow: "missing",
          listed,
          bound: "not-yours-or-unknown",
        } satisfies AgentsStatus,
      }
    }
    const ctx = await context(cwd, actor)
    const installed = await workflow(ctx)
    const options = installed?.options
    const state = !installed
      ? "missing"
      : installed.content
            .match(/^\s+run:\s+['"]?npm install -g @vectordevai\/cli@([^\s'"]+)/gm)
            ?.some((line) => !supportedCli(line.match(/@vectordevai\/cli@([^\s'"]+)/)![1]!)) ||
          (options && !supportedCli(cliVersionSpec(options.version).spec))
        ? "cli-too-old"
        : options && installed.content === buildAgentsWorkflow(options)
          ? "current"
          : "old"
    // Own-key workflows never call a cloud-agents account endpoint.
    const ownBinding =
      options?.mode === "codium" && listed.agents && actor.token
        ? await bindings().then(
            (items) => items.find((item) => item.repositoryId === String(ctx.info.id)),
            () => undefined,
          )
        : undefined
    const installation = await vector("/api/github/installation", undefined, false).catch(() => undefined)
    const handleAvailable =
      record(installation) && installation.available === true && typeof installation.installUrl === "string"
        ? GithubAgents.slugFromInstallUrl(installation.installUrl)
        : undefined
    const current: AgentsStatus = {
      repo: ctx.info.full_name,
      repositoryId: String(ctx.info.id),
      defaultBranch: ctx.info.default_branch,
      publicRepository: !ctx.info.private,
      signedIn: true,
      canDispatch: ctx.info.permissions?.push === true,
      workflow: state,
      options,
      listed,
      bound: ownBinding ? "yours" : "not-yours-or-unknown",
      ...(ownBinding ? { binding: ownBinding } : {}),
      ...(handleAvailable ? { handleAvailable } : {}),
      ...(installed?.url ? { url: installed.url } : {}),
      ...(state === "current" && options
        ? {
            timeoutMinutes:
              options.mode === "codium" ? GithubAgents.TIMEOUT_MIN.codiumAgent : GithubAgents.TIMEOUT_MIN.ownKeyAgent,
          }
        : {}),
    }
    const verified = await context(cwd, actor)
    assertActor(actor)
    if (verified.authority !== ctx.authority) throw new Error("The repository authority changed. Review it again.")
    current.authorityId = createHmac("sha256", authoritySecret)
      .update(
        JSON.stringify([
          ctx.authority,
          installed?.content,
          listed,
          handleAvailable,
          ownBinding && [
            ownBinding.boundAt,
            ownBinding.workflowVersion,
            ownBinding.codium,
            ownBinding.suspended,
            ownBinding.authorityId,
          ],
        ]),
      )
      .digest("hex")
    return { current, ctx }
  }
  async function status(cwd: string): Promise<AgentsStatus> {
    return (await inspect(cwd)).current
  }
  type Context = Awaited<ReturnType<typeof context>>
  type MutationResult =
    | { url: string }
    | { dispatchedAt: number }
    | { state: "failed" | "pending" | "bound"; workflowUpdate?: string; runUrl?: string }
  type Guard = () => Promise<{ current: AgentsStatus; ctx: Context }>
  type MutationEffect = <T>(task: (value: Awaited<ReturnType<Guard>>) => Promise<T>) => Promise<T>
  const receipts = new Map<string, { owner: string; digest: string; result: Promise<MutationResult> }>()
  const pending = new Set<string>()
  const uncertain = new Set<string>()
  async function mutate(
    kind: string,
    input: AgentMutationScope & { cwd: string },
    execute: (guard: Guard, effect: MutationEffect) => Promise<MutationResult>,
  ): Promise<MutationResult> {
    if (
      !input ||
      !/^[1-9]\d{0,19}$/.test(input.expectedRepositoryId) ||
      !/^[0-9a-f]{64}$/.test(input.authorityId) ||
      !/^[0-9a-f-]{36}$/i.test(input.operationId)
    )
      throw new Error("Review this repository again before continuing.")
    const actor = await actors()
    const identity = hash(JSON.stringify([kind, input]))
    const previous = receipts.get(input.operationId)
    if (previous) {
      if (previous.owner !== actor.key || previous.digest !== identity)
        throw new Error("This operation belongs to a different approval. Review it again.")
      const ctx = await context(input.cwd, actor)
      if (String(ctx.info.id) !== input.expectedRepositoryId)
        throw new Error("The repository changed. Review it again.")
      const result = await previous.result
      await fence(actor)
      return result
    }
    const key = input.expectedRepositoryId
    if (pending.has(key) || uncertain.has(key))
      throw new Error(
        "A GitHub operation is pending or uncertain. Check Actions and pull requests; Vector will not resend it. Restart Vector only after confirming whether it ran.",
      )
    if (receipts.size >= 256)
      throw new Error("Restart Vector after checking pending GitHub operations before continuing.")
    const guard: Guard = async () => {
      await fence(actor)
      const value = await inspect(input.cwd)
      if (
        !value.ctx ||
        value.current.repositoryId !== input.expectedRepositoryId ||
        value.current.authorityId !== input.authorityId
      )
        throw new Error("The repository, sign-in, workflow or connection changed. Review this repository again.")
      return { current: value.current, ctx: value.ctx }
    }
    pending.add(key)
    let touched = false
    const result = (async () => {
      try {
        await guard()
        const effect: MutationEffect = async (task) => {
          const value = await guard()
          assertActor(actor)
          touched = true
          const answer = await task(value)
          await fence(actor)
          const after = await context(input.cwd, actor)
          if (after.authority !== value.ctx.authority)
            throw new Error("The repository authority changed during this operation.")
          return answer
        }
        const outcome = await execute(guard, effect)
        await fence(actor)
        return outcome
      } catch (error) {
        if (touched && !(error instanceof GithubRequestError && error.status >= 400 && error.status < 500)) {
          uncertain.add(key)
          throw new Error(
            "The GitHub result is uncertain. Vector will not resend it. Check Actions and pull requests; restart Vector only after confirming whether it ran.",
          )
        }
        throw error
      } finally {
        pending.delete(key)
      }
    })()
    receipts.set(input.operationId, { owner: actor.key, digest: identity, result })
    return result
  }
  const unbindReceipts = new Map<string, { owner: string; digest: string; result: Promise<void> }>()
  async function unbind(rawInput: { repositoryId: string; authorityId: string; operationId: string }) {
    const input = structuredClone(rawInput)
    if (
      !input ||
      !/^[1-9]\d{0,19}$/.test(input.repositoryId) ||
      !/^[0-9a-f]{64}$/.test(input.authorityId) ||
      !/^[0-9a-f-]{36}$/i.test(input.operationId)
    )
      throw new Error("Review this exact repository binding before disconnecting it.")
    const actor = await actors()
    const identity = hash(JSON.stringify(input))
    const old = unbindReceipts.get(input.operationId)
    if (old) {
      if (old.owner !== actor.key || old.digest !== identity)
        throw new Error("This disconnect approval belongs to another account or binding.")
      await old.result
      await fence(actor)
      return
    }
    const key = input.repositoryId
    if (pending.has(key) || uncertain.has(key))
      throw new Error("A GitHub operation is pending or uncertain. Check its result before disconnecting this binding.")
    if (unbindReceipts.size >= 256)
      throw new Error("Restart Vector after checking pending GitHub operations before continuing.")
    pending.add(key)
    let touched = false
    const result = (async () => {
      try {
        const current = (await readBindings(actor)).find((item) => item.row.repositoryId === input.repositoryId)
        if (!current?.generation || current.row.authorityId !== input.authorityId)
          throw new Error("The account or repository binding changed. Review this binding again.")
        await fence(actor)
        touched = true
        const response = await vector(
          GithubAgents.ENDPOINT.unbind,
          { repositoryId: input.repositoryId, expectedGeneration: current.generation },
          true,
          actor.token ? hash(actor.token) : undefined,
          actor.key,
        )
        if (!record(response) || response.ok !== true) throw new Error("Vector did not confirm this disconnect.")
        await fence(actor)
      } catch (error) {
        if (touched) {
          uncertain.add(key)
          throw new Error(
            "The disconnect result is uncertain. Vector will not resend it. Check your bindings before trying again.",
          )
        }
        throw error
      } finally {
        pending.delete(key)
      }
    })()
    unbindReceipts.set(input.operationId, { owner: actor.key, digest: identity, result })
    return result
  }
  async function preview(input: AgentSetupInput): Promise<AgentSetupPreview> {
    requirePullRequestDirectory(input.cwd)
    const owner = await actors()
    if (input.mode !== "codium" && input.mode !== "own-key") throw new Error("Choose Codium or your own provider key.")
    if (typeof input.autoReview !== "boolean" || (input.share !== undefined && typeof input.share !== "boolean"))
      throw new Error("Invalid GitHub setup options.")
    if (input.mode === "codium" && !(await listing()).agents)
      throw new Error("GitHub agents with Codium are not available right now.")
    if (input.mode === "codium" && (input.autoReview || input.share || input.keys?.length))
      throw new Error("Codium workflows cannot share publicly, auto-review, or contain provider secrets.")
    const installed = await vector("/api/github/installation", undefined, false).catch(() => undefined)
    const handle =
      record(installed) && installed.available === true && typeof installed.installUrl === "string"
        ? GithubAgents.slugFromInstallUrl(installed.installUrl)
        : undefined
    await fence(owner)
    return agentsWorkflowPreview(input, deps.version, handle)
  }
  async function update(content: string, guard: Guard, effect: MutationEffect) {
    const { ctx } = await guard()
    if (!ctx.info.permissions?.push) throw new Error("GitHub write access is required to update this workflow.")
    if (ctx.scopes !== null && !ctx.scopes.split(",").some((scope) => scope.trim() === "workflow"))
      throw new Error("Allow workflow access in your GitHub sign-in, then try again.")
    const old = await workflow(ctx)
    const base = await githubJson<{ object: { sha: string } }>(
      ctx.access,
      `${repoPath(ctx.repo)}/git/ref/heads/${refPath(ctx.info.default_branch)}`,
    )
    const branch = `vector-agents-${randomUUID()}`
    await effect(async ({ ctx }) => {
      await githubJson(ctx.access, `${repoPath(ctx.repo)}/git/refs`, {
        method: "POST",
        body: { ref: `refs/heads/${branch}`, sha: base.object.sha },
      })
    })
    const remove = async () => {
      const value = await guard().catch(() => undefined)
      if (value) {
        assertActor(value.ctx.actor)
        await githubFetch(value.ctx.access, `${repoPath(value.ctx.repo)}/git/refs/heads/${branch}`, {
          method: "DELETE",
        }).catch(() => undefined)
      }
    }
    await effect(async ({ ctx }) => {
      await githubJson(ctx.access, `${repoPath(ctx.repo)}/contents/${GithubAgents.WORKFLOW_FILE}`, {
        method: "PUT",
        body: {
          message: "Set up Vector in GitHub Actions",
          content: Buffer.from(content).toString("base64"),
          branch,
          ...(old?.sha ? { sha: old.sha } : {}),
        },
      }).catch(async (error: unknown) => {
        await remove()
        throw error
      })
    })
    const pull = await effect(async ({ ctx }) =>
      githubJson<{ html_url: string }>(ctx.access, `${repoPath(ctx.repo)}/pulls`, {
        method: "POST",
        body: {
          title: "Set up Vector in GitHub Actions",
          head: branch,
          base: ctx.info.default_branch,
          body: `Run Vector in your own repo, on your own Actions minutes.\n\nThis workflow takes effect after it is merged. Review the workflow and add any provider secrets listed in Vector's setup preview.`,
        },
      })
        .catch(async (error: unknown) => {
          if (error instanceof GithubRequestError && error.status >= 400 && error.status < 500) await remove()
          throw error
        })
        .then((pull) => ({ url: pull.html_url })),
    )
    if (!pull || !("url" in pull)) throw new Error("GitHub did not return a workflow pull request.")
    return pull
  }
  async function bind(rawInput: AgentMutationScope & { cwd: string }) {
    const input = structuredClone(rawInput)
    const outcome = await mutate("bind", input, async (guard, effect) => {
      const { current, ctx } = await guard()
      if (!current.listed.agents) throw new Error("GitHub agents with Codium are not available right now.")
      if (current.workflow !== "current" || current.options?.mode !== "codium")
        return { state: "failed" as const, workflowUpdate: current.url }
      if (!ctx.info.permissions?.push) throw new Error("GitHub write access is required to connect this repository.")
      const viewer = await githubJson<{ id: number }>(ctx.access, "/user")
      if (!Number.isSafeInteger(viewer.id) || viewer.id < 1) throw new Error("GitHub could not verify your sign-in.")
      const issued = await effect(async () => {
        const issued = await vector(
          GithubAgents.ENDPOINT.bindCode,
          {
            repository: ctx.info.full_name,
            repositoryId: ctx.info.id,
            githubUserId: viewer.id,
            defaultRef: `refs/heads/${ctx.info.default_branch}`,
          },
          true,
          ctx.actor.token ? hash(ctx.actor.token) : undefined,
          ctx.actor.key,
        )
        if (!record(issued) || typeof issued.code !== "string" || !/^vbc_[A-Za-z0-9_-]{43}$/.test(issued.code))
          throw new Error("Vector could not issue a repository connection code.")
        return issued
      })
      if (!record(issued) || typeof issued.code !== "string")
        throw new Error("Vector could not issue a repository connection code.")
      const dispatchedAt = now()
      await effect(async ({ ctx }) => {
        await githubFetch(
          ctx.access,
          `${repoPath(ctx.repo)}/actions/workflows/${encodeURIComponent(GithubAgents.WORKFLOW_FILE.split("/").at(-1)!)}/dispatches`,
          { method: "POST", body: { ref: ctx.info.default_branch, inputs: { mode: "bind", code: issued.code } } },
        )
      })
      let runUrl: string | undefined
      for (let attempt = 0; attempt < 60 && now() - dispatchedAt < 120_000; attempt++) {
        const [connected, runs] = await Promise.all([
          bindings(),
          githubJson<{ workflow_runs?: { id: number; created_at: string; html_url: string }[] }>(
            ctx.access,
            `${repoPath(ctx.repo)}/actions/workflows/${encodeURIComponent(GithubAgents.WORKFLOW_FILE.split("/").at(-1)!)}/runs?event=workflow_dispatch&branch=${encodeURIComponent(ctx.info.default_branch)}&per_page=10`,
          ),
        ])
        runUrl =
          runs.workflow_runs?.find((run) => Date.parse(run.created_at) >= dispatchedAt - 1000)?.html_url ?? runUrl
        if (connected.some((item) => item.repositoryId === String(ctx.info.id) && !item.suspended))
          return { state: "bound" as const, ...(runUrl ? { runUrl } : {}) }
        await fence(ctx.actor)
        await sleep(2000)
      }
      return { state: "pending" as const, ...(runUrl ? { runUrl } : {}) }
    })
    if (!("state" in outcome)) throw new Error("GitHub returned an invalid connection result.")
    return outcome
  }
  async function run(
    rawInput: AgentMutationScope & {
      cwd: string
      prompt: string
      brain?: { previewId: string; approvedSha256: string }
    },
  ) {
    const input = structuredClone(rawInput)
    if (input.brain !== undefined && !deps.engine) throw new Error("Brain attachments are not available in this build.")
    if (typeof input.prompt !== "string" || !input.prompt.trim() || Buffer.byteLength(input.prompt) > 100_000)
      throw new Error("Enter a GitHub task of at most 100,000 bytes.")
    const outcome = await mutate("run", input, async (guard, effect) => {
      const { current, ctx } = await guard()
      if (current.workflow !== "current" || !current.canDispatch)
        throw new Error("Merge the current Vector workflow before running this task.")
      if (
        current.options?.mode === "codium" &&
        (!current.listed.agents ||
          current.bound !== "yours" ||
          current.binding?.codium !== "ready" ||
          current.binding.suspended)
      )
        throw new Error("Connect this repository to Codium before running this task.")
      if (input.brain !== undefined) {
        if (current.options?.mode !== "codium" || !current.listed.brain)
          throw new Error("Repository Brain attachments require a listed Codium desktop run.")
        return effect(async () =>
          (await brain()).start({
            cwd: input.cwd,
            prompt: input.prompt,
            previewId: input.brain!.previewId,
            approvedSha256: input.brain!.approvedSha256,
          }),
        ).then((result) => {
          if (!result || !("dispatchedAt" in result)) throw new Error("GitHub did not confirm this task.")
          return result
        })
      }
      await effect(async ({ ctx }) => {
        await githubFetch(
          ctx.access,
          `${repoPath(ctx.repo)}/actions/workflows/${encodeURIComponent(GithubAgents.WORKFLOW_FILE.split("/").at(-1)!)}/dispatches`,
          { method: "POST", body: { ref: ctx.info.default_branch, inputs: { mode: "task", prompt: input.prompt } } },
        )
      })
      return { dispatchedAt: now() }
    })
    if (!("dispatchedAt" in outcome)) throw new Error("GitHub returned an invalid task result.")
    return outcome
  }
  let brainPromise: Promise<ReturnType<typeof createGithubAgentsBrain>> | undefined
  async function brain() {
    if (!deps.engine) throw new Error("Brain attachments are not available in this build.")
    return (brainPromise ??= (async () => {
      const { createGithubAgentsBrain } = await import("./github-agents-brain")
      return createGithubAgentsBrain({
        context: async (cwd) => {
          const { current, ctx } = await inspect(cwd)
          if (
            !ctx ||
            current.workflow !== "current" ||
            current.options?.mode !== "codium" ||
            !current.listed.brain ||
            current.bound !== "yours" ||
            !current.canDispatch ||
            current.binding?.codium !== "ready" ||
            current.binding.suspended ||
            !current.authorityId
          )
            throw new Error("This repository is no longer authorized for Brain attachments.")
          return { ...ctx, authority: current.authorityId }
        },
        vector: async (path, body, owner, scope) => {
          const { current, ctx } = await inspect(scope.cwd)
          if (!ctx || current.authorityId !== scope.authorityId)
            throw new Error("The repository or sign-in changed. Review the attachment again.")
          return vector(path, body, true, owner, ctx.actor.key)
        },
        token: deps.token,
        engine: deps.engine!,
        fetch: request,
        now,
      })
    })())
  }
  async function readyBrain(cwd: string) {
    const current = await status(cwd)
    if (
      current.workflow !== "current" ||
      current.options?.mode !== "codium" ||
      !current.listed.brain ||
      current.bound !== "yours" ||
      !current.canDispatch ||
      current.binding?.codium !== "ready" ||
      current.binding.suspended
    )
      throw new Error("Connect this repository to a listed Codium desktop run before reviewing Brain attachments.")
    return brain()
  }
  return {
    status,
    preview,
    bindings,
    bind,
    run,
    previewBrain: async (cwd: string) => (await readyBrain(cwd)).preview(cwd),
    returnedArtifacts: async (input: { cwd: string; rid: string }) => (await readyBrain(input.cwd)).artifacts(input),
    previewReturned: async (input: { cwd: string; rid: string; artifactId: string }) =>
      (await readyBrain(input.cwd)).previewReturned(input),
    importReturned: async (input: { previewId: string; approvedSha256: string }) => {
      if (!(await listing()).brain) throw new Error("Returned Brain proposals are not available right now.")
      return (await brain()).importReturned(input)
    },
    clearBrain,
    invalidateAuthority,
    setup: async (rawInput: AgentSetupInput & AgentMutationScope) => {
      const input = structuredClone(rawInput)
      const result = await mutate("setup", input, async (guard, effect) =>
        update((await preview(input)).content, guard, effect),
      )
      if (!("url" in result)) throw new Error("GitHub did not return a workflow pull request.")
      return result
    },
    schedules: async (
      rawInput: AgentMutationScope & { cwd: string; schedules: NonNullable<AgentsWorkflowOptions["schedules"]> },
    ) => {
      const input = structuredClone(rawInput)
      const result = await mutate("schedules", input, async (guard, effect) => {
        const { current } = await guard()
        if (!current.options || current.workflow === "cli-too-old")
          throw new Error("Update the Vector workflow before setting GitHub schedules.")
        if (current.options.mode === "codium" && (!current.listed.agents || !current.listed.scheduled))
          throw new Error("GitHub schedules with Codium are not available right now.")
        return update(
          buildAgentsWorkflow({ ...current.options, schedules: input.schedules, version: deps.version }),
          guard,
          effect,
        )
      })
      if (!("url" in result)) throw new Error("GitHub did not return a workflow pull request.")
      return result
    },
    unbind,
    runs: async (): Promise<AgentRun[]> => {
      const body = await vector(GithubAgents.ENDPOINT.runs)
      if (!record(body) || !Array.isArray(body.runs) || body.runs.length > 200)
        throw new Error("Vector returned invalid GitHub runs.")
      return body.runs.map(runRecord)
    },
  }
}

function hash(value: string) {
  return createHash("sha256").update(value).digest("hex")
}
function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}
function repoPath(repo: GithubRepoRef) {
  return `/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}`
}
function refPath(ref: string) {
  return ref.split("/").map(encodeURIComponent).join("/")
}
function supportedCli(version: string) {
  const parsed = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?$/.exec(version)
  const minimum = GithubAgents.MIN_AGENTS_CLI.split(".").map(Number)
  if (!parsed) return false
  const found = parsed.slice(1, 4).map(Number)
  if (found.some((part) => !Number.isSafeInteger(part))) return false
  for (let index = 0; index < 3; index++) {
    if (found[index] !== minimum[index]) return found[index]! > minimum[index]!
  }
  return parsed[4] === undefined
}
function binding(value: unknown): AgentBinding {
  if (
    !record(value) ||
    typeof value.repositoryId !== "string" ||
    !/^[1-9]\d{0,19}$/.test(value.repositoryId) ||
    typeof value.boundAt !== "number" ||
    !Number.isFinite(value.boundAt) ||
    typeof value.workflowVersion !== "string" ||
    !["ready", "unavailable"].includes(String(value.codium))
  )
    throw new Error("Vector returned an invalid repository connection.")
  return {
    repositoryId: value.repositoryId,
    boundAt: value.boundAt,
    workflowVersion: value.workflowVersion,
    codium: value.codium as "ready" | "unavailable",
    ...(typeof value.lastUsedAt === "number" ? { lastUsedAt: value.lastUsedAt } : {}),
    ...(typeof value.suspended === "string" ? { suspended: value.suspended } : {}),
    ...(value.suspended !== "binder-left" && typeof value.repository === "string"
      ? { repository: value.repository }
      : {}),
    ...(value.suspended !== "binder-left" && record(value.binder) && typeof value.binder.login === "string"
      ? { binder: { login: value.binder.login } }
      : {}),
  }
}
function runRecord(value: unknown): AgentRun {
  if (
    !record(value) ||
    typeof value.rid !== "string" ||
    typeof value.repositoryId !== "string" ||
    typeof value.event !== "string" ||
    typeof value.source !== "string" ||
    !["task", "review", "scheduled"].includes(String(value.purpose)) ||
    typeof value.startedAt !== "number"
  )
    throw new Error("Vector returned an invalid GitHub run.")
  return {
    rid: value.rid,
    repositoryId: value.repositoryId,
    event: value.event,
    source: value.source,
    purpose: value.purpose as AgentRun["purpose"],
    startedAt: value.startedAt,
    ...(typeof value.repository === "string" ? { repository: value.repository } : {}),
    ...(typeof value.runUrl === "string" && /^https:\/\/github\.com\//.test(value.runUrl)
      ? { runUrl: value.runUrl }
      : {}),
    ...(typeof value.endedAt === "number" ? { endedAt: value.endedAt } : {}),
    ...(typeof value.outcome === "string" ? { outcome: value.outcome } : {}),
    ...(["pass", "fail", "none"].includes(String(value.verdict))
      ? { verdict: value.verdict as AgentRun["verdict"] }
      : {}),
  }
}
