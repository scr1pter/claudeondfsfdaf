import type { MemoryBootstrap, MemorySettings, VectorClient } from "@vectordevai/sdk/v2/client"
import { Billing } from "@vectordevai/schema/billing"
import { For, Show, createEffect, createMemo, createResource, on, onCleanup } from "solid-js"
import { createStore } from "solid-js/store"
import { ButtonV2 } from "@vectordevai/ui/v2/button-v2"
import { Switch } from "@vectordevai/ui/v2/switch-v2"
import { DialogBody, DialogFooter, DialogHeader, DialogTitleGroup, DialogV2 } from "@vectordevai/ui/v2/dialog-v2"
import { useDialog } from "@vectordevai/ui/context/dialog"
import { useGlobal } from "@/context/global"
import { useServer } from "@/context/server"
import { usePlatform } from "@/context/platform"
import { useProviders } from "@/hooks/use-providers"
import { onCodiumChange } from "@/vector-account"
import { Persist, persisted } from "@/utils/persist"
import {
  BRAIN_HELPERS,
  askBrainConsent,
  boundedBootstrap,
  brainConsentKey,
  brainControls,
  brainAccessible,
  brainOffered,
  runBrainBootstrap,
  runnableEstimate,
  saveBrainConsent,
} from "./memory-brain-model"
import { distillEstimateLabel } from "./memory-documents-model"

export function SettingsMemoryBrain(props: {
  client: () => VectorClient | undefined
  directory?: string
  settings?: MemorySettings
  onSettings: (settings: MemorySettings) => void
  onReview: () => void
}) {
  const platform = usePlatform()
  const providers = useProviders(() => props.directory)
  const [state, setState] = createStore<{
    saving: boolean
    preparing: boolean
    running: boolean
    model: string
    preview?: MemoryBootstrap
    notice: string
    error: string
    accountRevision: number
    results: { title: string; records: number; failed: boolean }[]
  }>({
    saving: false,
    preparing: false,
    running: false,
    model: "",
    notice: "",
    error: "",
    accountRevision: 0,
    results: [],
  })
  const life = { alive: true, generation: 0 }
  onCleanup(() => {
    life.alive = false
    life.generation++
  })
  const refreshAccount = () => setState("accountRevision", (value) => value + 1)
  onCleanup(onCodiumChange(refreshAccount))
  if (platform.vectorAccount) onCleanup(platform.vectorAccount.onChange(refreshAccount))
  const [plan, { mutate: setPlan }] = createResource(
    () => (platform.vectorAccount?.codium ? { revision: state.accountRevision } : false),
    () => platform.vectorAccount?.codium?.().catch(() => undefined),
  )
  const offered = createMemo(() => brainOffered(plan()))
  const accessible = createMemo(() => brainAccessible(plan()))
  const freshBrain = async () => {
    const revision = state.accountRevision
    const status = await platform.vectorAccount?.codium?.().catch(() => undefined)
    if (!life.alive || revision !== state.accountRevision) return false
    setPlan(status)
    return brainAccessible(status)
  }
  const models = createMemo(() =>
    providers
      .connected()
      .filter((provider) => !Billing.isCodium(provider.id))
      .flatMap((provider) =>
        Object.values(provider.models).map((model) => ({
          value: `${provider.id}/${model.id}`,
          label: `${model.name} · ${provider.name}`,
        })),
      )
      .sort((left, right) => left.label.localeCompare(right.label)),
  )
  // A changed engine, repository, model or permission invalidates the old confirmation. Nothing reruns automatically.
  createEffect(() => {
    props.client()
    props.directory
    props.settings?.codiumHelpers
    props.settings?.distillation
    state.model
    offered()
    state.accountRevision
    life.generation++
    setState({ preview: undefined, results: [] })
  })
  const configure = async (change: { codiumHelpers?: "on" | "off"; distillation?: boolean }) => {
    const client = props.client()
    if (!client || !brainControls(props.settings) || state.saving) return
    setState({ saving: true, error: "", notice: "" })
    const revision = state.accountRevision
    const result = change.codiumHelpers
      ? await saveBrainConsent(change.codiumHelpers, {
          current: () => life.alive && props.client() === client && state.accountRevision === revision,
          available: freshBrain,
          read: () => client.memory.settings.get(),
          write: (value) => client.memory.settings.update(value),
        }).then((result) =>
          result.state === "saved" ? { data: result.settings, error: undefined } : { data: undefined, error: true },
        )
      : await client.memory.settings.update(change).catch(() => ({ data: undefined, error: true }))
    if (!life.alive) return
    setState("saving", false)
    if (props.client() !== client) return
    if (result.error || !result.data || !brainControls(result.data)) {
      setState("error", "Vector could not confirm that this setting was saved. Try again.")
      return
    }
    props.onSettings(result.data)
    setState("notice", "Saved in your personal Brain settings.")
  }
  const prepare = async () => {
    const client = props.client()
    if (
      !client ||
      !props.directory ||
      props.settings?.distillation !== true ||
      state.preparing ||
      state.running ||
      (!state.model && !offered())
    )
      return
    const generation = ++life.generation
    setState({ preparing: true, preview: undefined, results: [], error: "", notice: "" })
    const result = await client.memory.bootstrap
      .prepare({ ...(state.model ? { model: state.model } : {}) })
      .catch(() => ({ data: undefined, error: true }))
    if (!life.alive) return
    setState("preparing", false)
    if (generation !== life.generation || props.client() !== client) return
    if (result.error || !result.data || !boundedBootstrap(result.data)) {
      setState("error", "Vector could not prepare a bounded preview. Nothing was sent to a model. Try again.")
      return
    }
    setState("preview", result.data)
  }
  const confirm = async () => {
    const client = props.client(),
      preview = state.preview
    if (!client || !preview || state.running || state.preparing) return
    const generation = life.generation
    setState({ running: true, error: "", notice: "", results: [] })
    const result = await runBrainBootstrap(preview, {
      current: async (estimate) => {
        if (
          !life.alive ||
          generation !== life.generation ||
          props.client() !== client ||
          props.settings?.distillation !== true
        )
          return false
        if (estimate.costKind === "codium" || Billing.isCodium(estimate.model?.split("/")[0])) {
          if (props.settings.codiumHelpers !== "on" || !offered() || !(await freshBrain())) return false
        }
        return (
          life.alive &&
          generation === life.generation &&
          props.client() === client &&
          props.settings?.distillation === true
        )
      },
      send: (request) => client.memory.distill.run(request),
      result: (title, result) => {
        if (life.alive)
          setState("results", (current) => [
            ...current,
            { title, records: result.records.length, failed: result.error !== undefined },
          ])
      },
    })
    if (!life.alive) return
    setState({ running: false, preview: undefined })
    if (result.state === "failed")
      setState(
        "error",
        "Vector stopped because a document request failed. Any suggestions already returned still wait for your review.",
      )
    if (result.state === "changed")
      setState(
        "notice",
        "The settings, service availability or repository changed. Prepare a new preview before sending anything else.",
      )
    if (result.state === "invalid") setState("error", "This preview is no longer valid. Prepare it again.")
    if (result.state === "done")
      setState(
        "notice",
        "Finished. Suggestions stay in Documents for you to review; none were put in use automatically.",
      )
  }
  return (
    <Show when={brainControls(props.settings)}>
      <div class="settings-v2-card settings-v2-card--wide" data-component="settings-memory-brain">
        <div class="settings-v2-card-head">
          <div class="settings-v2-card-copy">
            <h3 class="settings-v2-card-title">Brain helpers</h3>
            <p class="settings-v2-card-description">Your choices apply to your personal Brain, including the CLI.</p>
          </div>
        </div>
        <div class="settings-v2-card-body">
          <Show when={offered()}>
            <div class="settings-v2-row-modern">
              <div class="settings-v2-row-copy">
                <div class="settings-v2-row-title">{BRAIN_HELPERS.title}</div>
                <div class="settings-v2-row-description">
                  {BRAIN_HELPERS.consent} {BRAIN_HELPERS.control}
                </div>
                <Show when={props.settings?.codiumHelpers === "ask"}>
                  <p class="settings-memory-meta">Off until you choose to enable it.</p>
                </Show>
                <Show when={!accessible() && props.settings?.codiumHelpers !== "on"}>
                  <p class="settings-memory-meta">
                    An active Codium plan is needed to enable these helpers. You can still use your own model below.
                  </p>
                </Show>
              </div>
              <Switch
                aria-label={BRAIN_HELPERS.title}
                checked={props.settings?.codiumHelpers === "on"}
                disabled={state.saving || (props.settings?.codiumHelpers !== "on" && !accessible())}
                onChange={(on) => void configure({ codiumHelpers: on ? "on" : "off" })}
              />
            </div>
          </Show>
          <Show when={props.settings?.distillation !== undefined}>
            <div class="settings-v2-row-modern">
              <div class="settings-v2-row-copy">
                <div class="settings-v2-row-title">Suggest records from documents</div>
                <div class="settings-v2-row-description">
                  Let a model read selected document sections when you ask. Suggestions must quote the document and wait
                  for your review. This also works with your own model, without a Codium subscription.
                </div>
              </div>
              <Switch
                aria-label="Suggest records from documents"
                checked={props.settings?.distillation === true}
                disabled={state.saving}
                onChange={(distillation) => void configure({ distillation })}
              />
            </div>
          </Show>
          <Show when={props.directory && props.settings?.distillation === true}>
            <section class="settings-memory-pad" aria-label="Bootstrap this repository">
              <h4 class="settings-v2-row-title">Bootstrap this repo</h4>
              <p class="settings-memory-meta">{BRAIN_HELPERS.bootstrap}</p>
              <label class="settings-memory-meta">
                Model
                <select
                  class="settings-memory-kind"
                  aria-label="Bootstrap model"
                  value={state.model}
                  disabled={state.preparing || state.running}
                  onChange={(event) => setState("model", event.currentTarget.value)}
                >
                  <option value="">
                    {!offered()
                      ? "Choose your own model"
                      : props.settings?.codiumHelpers === "on"
                        ? "Codium helper when available; local model in Vector Local"
                        : "Configured default model"}
                  </option>
                  <For each={models()}>{(model) => <option value={model.value}>{model.label}</option>}</For>
                </select>
              </label>
              <p class="settings-memory-meta">
                The preview names the model that would actually run. Own-key and local models remain available without a
                subscription.
              </p>
              <div class="settings-memory-actions">
                <ButtonV2
                  size="small"
                  variant="outline"
                  disabled={state.preparing || state.running || state.saving || (!state.model && !offered())}
                  onClick={() => void prepare()}
                >
                  {state.preparing ? "Preparing local preview…" : state.preview ? "Refresh preview" : "Prepare preview"}
                </ButtonV2>
              </div>
              <Show when={state.preview}>
                {(preview) => (
                  <div class="settings-memory-row" data-component="brain-bootstrap-preview">
                    <p class="settings-memory-meta">
                      This preview sends nothing. Confirming runs the available documents one at a time and keeps
                      suggestions for review.
                    </p>
                    <Show when={preview().pending > 0}>
                      <p class="settings-memory-meta">
                        {preview().pending} documents are still being read locally. Refresh this preview when they are
                        ready; they will not be sent automatically.
                      </p>
                    </Show>
                    <Show when={preview().documents.length === 0}>
                      <p class="settings-memory-empty">No eligible documents are ready for a model yet.</p>
                    </Show>
                    <For each={preview().documents}>
                      {(document) => (
                        <div class="settings-memory-row">
                          <strong>{document.title}</strong>
                          <p class="settings-memory-text">{distillEstimateLabel(document.estimate)}</p>
                        </div>
                      )}
                    </For>
                    <div class="settings-memory-actions">
                      <ButtonV2
                        size="small"
                        disabled={
                          state.running ||
                          state.preparing ||
                          state.saving ||
                          !preview().documents.some((document) => runnableEstimate(document.estimate))
                        }
                        onClick={() => void confirm()}
                      >
                        {state.running ? "Requesting suggestions…" : "Send these documents to the model"}
                      </ButtonV2>
                      <ButtonV2
                        size="small"
                        variant="ghost"
                        disabled={state.running}
                        onClick={() => setState("preview", undefined)}
                      >
                        Cancel
                      </ButtonV2>
                    </div>
                  </div>
                )}
              </Show>
              <For each={state.results}>
                {(result) => (
                  <p class="settings-memory-meta">
                    {result.title}: {result.records} suggestions waiting for review.
                    {result.failed ? " The request ended before it finished." : ""}
                  </p>
                )}
              </For>
              <Show when={state.results.some((result) => result.records > 0)}>
                <ButtonV2 size="small" variant="outline" onClick={props.onReview}>
                  Review document suggestions
                </ButtonV2>
              </Show>
            </section>
          </Show>
          <Show when={state.notice}>
            <p role="status" class="settings-memory-notice">
              {state.notice}
            </p>
          </Show>
          <Show when={state.error}>
            <p role="alert" class="settings-memory-error">
              {state.error}
            </p>
          </Show>
        </div>
      </div>
    </Show>
  )
}

/** One global mount covers Account and purchases opened elsewhere; presentation state grants no permission. */
export function CodiumBrainConsent() {
  const platform = usePlatform(),
    server = useServer(),
    global = useGlobal(),
    dialog = useDialog()
  const [state, setState] = createStore({ revision: 0, identityRevision: 0, opening: false })
  const [history, setHistory, , ready] = persisted(
    Persist.global("brain-consent.v1"),
    createStore<{ presented: Record<string, boolean> }>({ presented: {} }),
  )
  const client = createMemo(() => (server.current ? global.ensureServerCtx(server.current).sdk.client : undefined))
  const refresh = () => setState("revision", (value) => value + 1)
  onCleanup(onCodiumChange(refresh))
  if (platform.vectorAccount)
    onCleanup(
      platform.vectorAccount.onChange(() => {
        setState("identityRevision", (value) => value + 1)
        refresh()
      }),
    )
  const [read] = createResource(
    () => {
      const account = platform.vectorAccount,
        current = client()
      return account?.codium && current
        ? { account, current, engine: server.scope(server.key), revision: state.revision }
        : false
    },
    async (input) => {
      const [account, status, settings] = await Promise.all([
        input.account.status().catch(() => undefined),
        input.account.codium!().catch(() => undefined),
        input.current.memory.settings
          .get()
          .then((result) => (result.error ? undefined : result.data))
          .catch(() => undefined),
      ])
      if (!account?.authenticated || !account.email || !status || !settings) return undefined
      return {
        client: input.current,
        key: brainConsentKey(input.engine, account.email),
        account: account.email,
        status,
        settings,
        revision: input.revision,
      }
    },
  )
  // Settings may have answered the question while its dialog was open. Refresh before considering a waiting prompt.
  createEffect(
    on(
      () => !!dialog.active,
      (active, previous) => {
        const current = read.latest
        if (!active && previous && current?.settings.codiumHelpers === "ask" && !history.presented[current.key])
          refresh()
      },
    ),
  )
  createEffect(() => {
    const current = read()
    if (
      !ready() ||
      read.loading ||
      !current ||
      current.revision !== state.revision ||
      state.opening ||
      dialog.active ||
      !askBrainConsent({
        settings: current.settings,
        status: current.status,
        presented: history.presented[current.key] === true,
      })
    )
      return
    // Remember presentation across restarts, even when dismissed. Only the engine's On/Off setting authorizes helpers.
    setHistory("presented", current.key, true)
    setState("opening", true)
    const identityRevision = state.identityRevision
    void dialog.show(
      () => (
        <BrainConsentDialog
          client={current.client}
          account={current.account}
          current={() =>
            read.latest?.key === current.key &&
            state.identityRevision === identityRevision &&
            client() === current.client
          }
          onSaved={refresh}
        />
      ),
      () => setState("opening", false),
    )
  })
  return null
}

function BrainConsentDialog(props: {
  client: VectorClient
  account: string
  current: () => boolean
  onSaved: () => void
}) {
  const platform = usePlatform(),
    dialog = useDialog()
  const [state, setState] = createStore({ saving: false, error: "" })
  const life = { alive: true }
  onCleanup(() => {
    life.alive = false
  })
  const choose = async (codiumHelpers: "on" | "off") => {
    if (state.saving || !props.current()) return
    setState({ saving: true, error: "" })
    const account = await platform.vectorAccount?.status().catch(() => undefined)
    const result =
      account?.authenticated && account.email === props.account && props.current()
        ? await saveBrainConsent(codiumHelpers, {
            current: props.current,
            available: async () => brainAccessible(await platform.vectorAccount?.codium?.().catch(() => undefined)),
            read: () => props.client.memory.settings.get(),
            write: (change) => props.client.memory.settings.update(change),
          })
        : undefined
    if (!life.alive) return
    setState("saving", false)
    if (result?.state !== "saved") {
      setState("error", "Vector could not confirm that your choice was saved. Try again or check Settings → Memory.")
      return
    }
    props.onSaved()
    dialog.close()
  }
  return (
    <DialogV2 fit>
      <DialogHeader>
        <DialogTitleGroup
          title={BRAIN_HELPERS.title}
          description="Your Codium subscription is active. This is a separate, optional choice."
        />
      </DialogHeader>
      <DialogBody>
        <p>{BRAIN_HELPERS.consent}</p>
        <p>{BRAIN_HELPERS.control}</p>
        <p>
          You can change this in Settings → Memory. Dismissing this question without making a choice does not enable
          helpers.
        </p>
        <Show when={!props.current()}>
          <p role="alert">The account or connection changed. Close this question and use Settings → Memory.</p>
        </Show>
        <Show when={state.error}>
          <p role="alert">{state.error}</p>
        </Show>
      </DialogBody>
      <DialogFooter>
        <ButtonV2 variant="outline" disabled={state.saving || !props.current()} onClick={() => void choose("off")}>
          Keep Codium helpers off
        </ButtonV2>
        <ButtonV2 disabled={state.saving || !props.current()} onClick={() => void choose("on")}>
          {state.saving ? "Saving…" : "Use Codium for Brain helpers"}
        </ButtonV2>
      </DialogFooter>
    </DialogV2>
  )
}
