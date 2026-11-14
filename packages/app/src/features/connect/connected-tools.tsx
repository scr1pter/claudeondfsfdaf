import { For, Show, createEffect, createMemo, createResource, on, onCleanup } from "solid-js"
import { createStore } from "solid-js/store"
import { useParams } from "@solidjs/router"
import type { Config } from "@vectordevai/sdk/v2/client"
import type { Connect } from "@vectordevai/schema/connect"
import { Button } from "@vectordevai/ui/button"
import { useServerSDK } from "@/context/server-sdk"
import { externalAgentsApi } from "@/features/agents/external-agent-desktop"
import { createConnectClient } from "./client"
import { actionableFindings, taskReviewFixGuidance } from "./connect-model"
import { actOnFindings } from "./findings-card-model"
import { requestComposerPrompt } from "@/utils/composer-handoff"
import { memberRows, parseReviewSettings, readReviewSettings, reviewSettingsPatch, verdictLabel } from "./connect-model"

export function ConnectedTools(props: {
  directory?: string
  config?: Config
  confirm: (title: string, apply: () => void) => void
  save: (patch: Config) => Promise<void>
}) {
  const sdk = useServerSDK()
  const params = useParams()
  const scope = createMemo(() => (props.directory ? sdk().ensureDirSdkContext(props.directory) : undefined))
  const client = createMemo(() => {
    const selected = scope()
    return selected ? createConnectClient(selected.client) : undefined
  })
  const [state, setState] = createStore({
    after_run: "off",
    before_commit: "offer",
    max_rounds: "1",
    max_cost_usd: "2",
    error: "",
    saving: false,
    acting: "",
    epoch: Symbol(),
  })
  createEffect(on(client, () => setState({ acting: "", error: "" })))
  const saved = createMemo(() => readReviewSettings(props.config), undefined, {
    equals: (a, b) =>
      a.after_run === b.after_run &&
      a.before_commit === b.before_commit &&
      a.max_rounds === b.max_rounds &&
      a.max_cost_usd === b.max_cost_usd,
  })
  createEffect(
    on([client, saved], ([, settings]) => {
      setState({ ...settings, max_rounds: String(settings.max_rounds), max_cost_usd: String(settings.max_cost_usd) })
    }),
  )
  let pending: AbortController | undefined
  let blocked: ReturnType<typeof createConnectClient> | undefined
  let disposed = false
  let actionRead: AbortController | undefined
  const [data, { refetch, mutate }] = createResource(
    () => {
      const api = client()
      const epoch = state.epoch
      return !disposed && api && api !== blocked ? { api, epoch } : undefined
    },
    async (
      request,
    ): Promise<{
      client: ReturnType<typeof createConnectClient>
      epoch: symbol
      members: ReturnType<typeof memberRows>
      runs: readonly Connect.Run[]
      externalFailed: boolean
    }> => {
      const api = request.api
      pending?.abort()
      const abort = new AbortController()
      pending = abort
      const signal = AbortSignal.any([abort.signal, AbortSignal.timeout(30_000)])
      const [members, runs] = await Promise.all([api.list(undefined, signal), api.runs(undefined, signal)]).catch(
        () => {
          if (request.epoch === state.epoch && api === client()) retire(api)
          throw new Error("Connected tools access could not be verified.")
        },
      )
      // Refused owner routes must not trigger discovery commands on this desktop.
      if (disposed || abort.signal.aborted || api !== client() || request.epoch !== state.epoch)
        throw new Error("The connected workspace changed.")
      const external = await (externalAgentsApi()
        ?.detect?.()
        .then((agents) => ({ agents, failed: false }))
        .catch(() => ({ agents: [], failed: true })) ?? { agents: [], failed: false })
      const desktop: Connect.Member[] = external.agents.map((agent) => ({
        id: `external:${agent.id}`,
        kind: "agent",
        title: agent.name,
        summary: "Uses this agent's own model and account settings.",
        owner: "user",
        place: "local",
        reach: "ui",
        state: agent.state === "ready" ? "ready" : agent.state === "not-installed" ? "not-installed" : "unavailable",
        ...(agent.state === "ready"
          ? {}
          : {
              reason:
                agent.state === "signed-out"
                  ? "Sign in to this agent in Agents."
                  : agent.state === "not-installed"
                    ? "Install this agent from Agents."
                    : "Check this agent's sign-in in Agents.",
            }),
      }))
      if (disposed || abort.signal.aborted || api !== client() || request.epoch !== state.epoch)
        throw new Error("The connected workspace changed.")
      return {
        client: api,
        epoch: request.epoch,
        members: memberRows(members, desktop),
        runs,
        externalFailed: external.failed,
      }
    },
  )
  const retire = (denied?: ReturnType<typeof createConnectClient>) => {
    blocked = denied
    pending?.abort()
    actionRead?.abort()
    mutate(undefined)
    setState({
      epoch: Symbol(),
      acting: "",
      saving: false,
      error: denied ? "Connected tools access could not be verified." : "",
    })
  }
  onCleanup(() => {
    disposed = true
    retire()
  })
  const loaded = () => {
    if (disposed) return
    const value = data.latest
    if (!value || data.error || value.client !== client() || value.epoch !== state.epoch) return
    return value
  }
  createEffect(() => {
    const server = sdk()
    const directory = props.directory
    const stop = server.event.listen((event) => {
      if (server !== sdk()) return
      if (
        (event.name === "global" &&
          (event.details.type === "server.connected" || event.details.type === "global.disposed")) ||
        (event.name === directory && event.details.type === "server.instance.disposed")
      ) {
        retire()
      }
    })
    onCleanup(stop)
  })
  createEffect(() => {
    const active = scope()
    if (!active) return
    let timer: ReturnType<typeof setTimeout> | undefined
    const stop = active.event.on("connect.run.updated", () => {
      if (timer) return
      timer = setTimeout(() => {
        timer = undefined
        void refetch()
      }, 250)
    })
    onCleanup(() => {
      stop()
      if (timer) clearTimeout(timer)
    })
  })
  const save = () => {
    if (disposed) return
    setState("error", "")
    try {
      const settings = parseReviewSettings(state)
      const active = client()
      const directory = props.directory
      const epoch = state.epoch
      const current = () =>
        !disposed && !!active && active === client() && directory === props.directory && epoch === state.epoch
      props.confirm("Save connected review settings?", () => {
        if (!current()) return
        setState("saving", true)
        void props
          .save(reviewSettingsPatch(settings))
          .catch((error: unknown) => {
            if (!current()) return
            setState("error", error instanceof Error ? error.message : "Could not save the review settings.")
          })
          .finally(() => {
            if (current()) setState("saving", false)
          })
      })
    } catch (error) {
      setState("error", error instanceof Error ? error.message : "Check the review settings.")
    }
  }
  const fix = async (run: Connect.Run, action: "fix" | "worktree") => {
    const active = client()
    const directory = props.directory
    const sessionID = params.id
    const epoch = state.epoch
    if (disposed || !active || !sessionID || state.acting || !actionableFindings(run, sessionID, true).length) return
    const abort = new AbortController()
    actionRead?.abort()
    actionRead = abort
    const current = () =>
      !disposed &&
      !abort.signal.aborted &&
      active === client() &&
      directory === props.directory &&
      sessionID === params.id &&
      epoch === state.epoch
    setState({ acting: run.id, error: "" })
    await actOnFindings(
      { run: run.id, sessionID, action },
      {
        load: (id, session) =>
          active.get(id, session, AbortSignal.any([abort.signal, AbortSignal.timeout(30_000)])).catch(() => {
            if (current()) retire(active)
            throw new Error("Connected review access could not be verified.")
          }),
        send: (text) => current() && requestComposerPrompt({ text, send: true }),
        dismiss: async () => {
          throw new Error("A repair does not dismiss findings.")
        },
      },
    )
      .catch((error: unknown) => {
        if (current()) setState("error", error instanceof Error ? error.message : "Could not send these findings.")
      })
      .finally(() => {
        if (actionRead === abort) actionRead = undefined
        if (current()) setState("acting", "")
      })
  }
  return (
    <div class="settings-v2-card settings-v2-card--wide" data-component="connected-tools">
      <div class="settings-v2-card-head" style={{ "grid-template-columns": "1fr" }}>
        <div class="settings-v2-card-copy">
          <h3 class="settings-v2-card-title">Connected tools</h3>
          <p class="settings-v2-card-description">See where your workspace tools run and where they send your code.</p>
        </div>
      </div>
      <div class="settings-v2-card-body">
        <Show when={!props.directory}>
          <p>Open a workspace to view its connected tools.</p>
        </Show>
        <Show when={props.directory && data.error}>
          <p role="alert">Could not load connected tools. Only the engine's owner can view them.</p>
        </Show>
        <Show when={data.loading && !loaded()}>
          <p>Loading connected tools…</p>
        </Show>
        <Show when={loaded()}>
          {(loaded) => (
            <>
              <Show when={loaded().externalFailed}>
                <p role="status">Could not check external agents on this computer. Refresh to try again.</p>
              </Show>
              <For each={loaded().members}>
                {(member) => (
                  <div class="settings-v2-row-modern">
                    <div class="settings-v2-row-copy">
                      <div class="settings-v2-row-title">{member.title}</div>
                      <p class="settings-v2-row-description">{member.summary}</p>
                      <p class="settings-v2-row-description">
                        Runs: {member.placeLabel}. Sends code:{" "}
                        {member.id.startsWith("external:") ? "Uses this agent's own settings" : member.destinationLabel}
                        .
                      </p>
                      <p class="settings-v2-row-description">
                        {member.stateLabel}
                        {member.reason ? `: ${member.reason}` : ""}.{" "}
                        {member.reach === "connect"
                          ? "Ask Vector to use it."
                          : member.reach === "ui"
                            ? "Open it in the workspace."
                            : member.reach === "none"
                              ? "No action is available."
                              : `Reached through ${member.reach}.`}
                      </p>
                    </div>
                  </div>
                )}
              </For>
              <Show when={props.config}>
                <label class="settings-v2-field">
                  <span class="settings-v2-field-label">After the agent changes files</span>
                  <select
                    aria-label="After-run review"
                    value={state.after_run}
                    disabled={state.saving}
                    onChange={(event) => setState("after_run", event.currentTarget.value)}
                  >
                    <option value="off">Off</option>
                    <option value="report">Review and report</option>
                    <option value="repair">Review and ask the agent to repair blocking findings</option>
                  </select>
                  <span class="settings-v2-row-description">Applying a fix still asks for your approval.</span>
                </label>
                <label class="settings-v2-field">
                  <span class="settings-v2-field-label">Before a commit</span>
                  <select
                    aria-label="Before-commit review"
                    value={state.before_commit}
                    disabled={state.saving}
                    onChange={(event) => setState("before_commit", event.currentTarget.value)}
                  >
                    <option value="off">Off</option>
                    <option value="offer">Offer a review</option>
                    <option value="run">Run a review</option>
                  </select>
                </label>
                <label class="settings-v2-field">
                  <span class="settings-v2-field-label">Maximum review rounds per request</span>
                  <input
                    aria-label="Review rounds"
                    type="number"
                    min="1"
                    max="3"
                    step="1"
                    value={state.max_rounds}
                    disabled={state.saving}
                    onInput={(event) => setState("max_rounds", event.currentTarget.value)}
                  />
                </label>
                <label class="settings-v2-field">
                  <span class="settings-v2-field-label">Review cap for priced models (USD)</span>
                  <input
                    aria-label="Review cap"
                    inputmode="decimal"
                    value={state.max_cost_usd}
                    disabled={state.saving}
                    onInput={(event) => setState("max_cost_usd", event.currentTarget.value)}
                  />
                  <span class="settings-v2-row-description">
                    Local models use step and time limits. Codium uses your plan allowance.
                  </span>
                </label>
                <Button variant="primary" size="normal" disabled={state.saving} onClick={save}>
                  Save review settings
                </Button>
              </Show>
              <For each={loaded().runs}>
                {(run) => (
                  <div class="settings-v2-row-modern">
                    <div class="settings-v2-row-copy">
                      <div class="settings-v2-row-title">
                        {run.result ? verdictLabel(run.result) : "Review in progress"}
                      </div>
                      <p class="settings-v2-row-description">
                        {run.result?.summary ?? run.progress?.message ?? "Queued"}
                      </p>
                      <Show when={actionableFindings(run, params.id, true).length > 0}>
                        <Show when={taskReviewFixGuidance(run)}>
                          {(guidance) => (
                            <p class="settings-v2-row-description" role="status">
                              {guidance()}
                            </p>
                          )}
                        </Show>
                        <div class="flex flex-wrap gap-2">
                          <Button
                            variant="secondary"
                            size="small"
                            disabled={!!state.acting || !!taskReviewFixGuidance(run)}
                            title={taskReviewFixGuidance(run)}
                            onClick={() => void fix(run, "fix")}
                          >
                            Fix
                          </Button>
                          <Button
                            variant="secondary"
                            size="small"
                            disabled={!!state.acting || !!taskReviewFixGuidance(run)}
                            title={taskReviewFixGuidance(run)}
                            onClick={() => void fix(run, "worktree")}
                          >
                            Fix in a worktree
                          </Button>
                        </div>
                      </Show>
                    </div>
                    <Show when={run.status !== "done"}>
                      <Button
                        variant="ghost"
                        size="normal"
                        onClick={() =>
                          void loaded()
                            .client.cancel(run.id, run.request.requester.sessionID)
                            .then(() => refetch())
                            .catch(() => setState("error", "Could not cancel this review."))
                        }
                      >
                        Cancel review
                      </Button>
                    </Show>
                  </div>
                )}
              </For>
            </>
          )}
        </Show>
        <Show when={state.error}>
          <p role="alert" class="settings-v2-error">
            {state.error}
          </p>
        </Show>
        <Button
          variant="ghost"
          size="normal"
          disabled={!props.directory || data.loading}
          onClick={() => {
            if (blocked) retire()
            else void refetch()
          }}
        >
          Refresh connected tools
        </Button>
      </div>
    </div>
  )
}
