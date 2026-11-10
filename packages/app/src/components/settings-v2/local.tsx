import type { LocalCheckResult, LocalModelCheck, LocalServer, LocalStatus } from "@vectordevai/sdk/v2/client"
import { For, Show, createMemo, createResource, createSignal, onCleanup } from "solid-js"
import { useDialog } from "@vectordevai/ui/context/dialog"
import { ButtonV2 } from "@vectordevai/ui/v2/button-v2"
import { Switch } from "@vectordevai/ui/v2/switch-v2"
import { useServerSync } from "@/context/server-sync"
import { DialogAllowSource, useLocalChange } from "@/features/local/allow-dialog"
import { DialogEgressLog } from "@/features/local/egress-log"
import { LocalCovers } from "@/features/local/egress-popover"
import { OffInLocalRow } from "@/features/local/off-in-local"
import { DialogLocalSetup } from "@/features/local/setup-wizard"
import { useLocalStatus } from "@/features/local/use-local"
import {
  createReadRetry,
  readErrorText,
  readFailure,
  retryText,
  type ReadFailure,
  type RetryState,
} from "@/features/local/read-retry"
import {
  AGENT,
  CHECK_RESULT,
  LOCKED,
  DEFINITION,
  GUEST,
  RESTART,
  ROLES,
  SUBTITLE,
  configRoles,
  enginePlace,
  offInLocal,
  popoverLines,
  refusal,
  retention,
  roleLocked,
  roleModels,
  rolesPatch,
  serverLabels,
  type Role,
} from "@/features/local/local-model"
import { desktopLocal } from "@/utils/desktop-local"
import { installLocalTranscription, localTranscriptionInstalled } from "@/services/local-transcription"
import {
  CERTIFICATES,
  CHECK_STATUS,
  DICTATION_LOCAL,
  SECTIONS,
  allowedRows,
  certificateLines,
  checkVerdict,
  heldText,
  serverRows,
  switchView,
  webChoices,
  webNote,
  webNoteLocked,
} from "./local-model"
import { SettingsMemorySearchModel } from "./memory-search-model"
import "./settings-v2.css"
import "@/features/local/local.css"

// Settings > Vector Local (section 8.5, Personal group): the switch and what it means, Web access, the model servers,
// the roles, the services the user allowed, everything Vector Local keeps off with Allow… where it may be allowed, the
// certificates, the network log and a check of every layer. The owner turns Vector Local on and off here (owner,
// 22 Oct). Every change goes through the Local API, which asks the owner before anything loosens; an invited guest is
// told whose settings these are and sees none of them. When Vector cannot read Vector Local's status or look for model
// servers, the page says what failed and why, tries again on its own while the failure may pass, and offers Try again.

const title = (id: (typeof SECTIONS)[number]["id"]) => SECTIONS.find((section) => section.id === id)!.title

export function SettingsLocalV2() {
  const reader = useLocalStatus({ retry: true })
  const local = useLocalChange()
  const dialog = useDialog()
  const [notice, setNotice] = createSignal("")
  const [error, setError] = createSignal("")
  const [pending, setPending] = createSignal(false)
  const [desktop] = createResource(() => desktopLocal())

  const run = async (update: Parameters<typeof local.change>[1], done: string) => {
    const client = reader.client()
    if (!client) return
    setPending(true)
    setError("")
    setNotice("")
    const result = await local.change(client, update)
    setPending(false)
    // A choice the owner took back, or the engine refused, shows what is in effect again.
    if (result.type !== "applied") reader.refresh()
    if (result.type === "cancelled") return setNotice("Nothing changed.")
    if (result.type === "failed") return setError(result.message)
    reader.set(result.status)
    setNotice(done)
  }

  const setup = () => void dialog.push(() => <DialogLocalSetup reader={reader} onDone={() => reader.refresh()} />)
  const allowSource = (id: string) => {
    const client = reader.client()
    const current = reader.status()
    const source = current?.sources.find((item) => item.id === id)
    if (!client || !current || !source) return
    void dialog.push(() => (
      <DialogAllowSource
        source={source}
        status={current}
        client={client}
        onDone={(next) => (next ? reader.set(next) : reader.refresh())}
      />
    ))
  }

  return (
    <section class="settings-v2-page" data-component="settings-local">
      <div class="settings-v2-page-hero">
        <div>
          <p class="settings-v2-page-kicker">Personal</p>
          <h2 class="settings-v2-page-title">Vector Local</h2>
          <p class="settings-v2-page-subtitle">{SUBTITLE}</p>
        </div>
      </div>

      <Show when={!reader.guest()} fallback={<p data-slot="local-note">{GUEST}</p>}>
        <Show
          when={reader.status()}
          fallback={
            <Show
              when={reader.failure()}
              fallback={
                <p class="settings-v2-card-description">
                  {reader.loading()
                    ? "Reading Vector Local…"
                    : reader.unsupported()
                      ? "This engine does not support Vector Local. Use the current desktop engine, or update this engine before setting it up."
                      : "Vector is not connected to an engine, so it cannot read Vector Local."}
                </p>
              }
            >
              {(failure) => (
                <ReadError
                  failure={failure()}
                  retry={reader.retry()}
                  trying={reader.loading()}
                  remote={reader.remote()}
                  onRetry={reader.again}
                />
              )}
            </Show>
          }
        >
          {(status) => (
            <>
              <Show when={notice()}>
                <p data-slot="local-muted" role="status">
                  {notice()}
                </p>
              </Show>
              <Show when={error()}>
                <p data-slot="local-error" role="alert">
                  {error()}
                </p>
              </Show>

              <SwitchCard
                status={status()}
                pending={pending()}
                restart={desktop.latest?.restartNeeded === true && status().policy.enabled}
                mismatch={desktop.latest?.mismatch}
                onToggle={(enabled) => void run({ enabled }, enabled ? "Vector Local is on." : "Vector Local is off.")}
                onApplyHeld={(changes) => void run({ held: [...changes] }, "The change in your config applies now.")}
                onSetup={setup}
              />

              <div class="settings-v2-card settings-v2-card--wide" data-section="web">
                <div class="settings-v2-card-head">
                  <div class="settings-v2-card-copy">
                    <h3 class="settings-v2-card-title">{title("web")}</h3>
                  </div>
                </div>
                <div class="settings-v2-card-body">
                  <div role="radiogroup" aria-label="Web access" data-slot="local-radios">
                    <For each={webChoices(status())}>
                      {(option) => (
                        <label data-slot="local-option">
                          <input
                            type="radio"
                            name="settings-local-web"
                            value={option.id}
                            checked={option.checked}
                            disabled={option.disabled || pending()}
                            onChange={() => void run({ web: option.id }, `Web access is ${option.label}.`)}
                          />
                          <span>
                            <strong>{option.label}</strong>: {option.description}
                          </span>
                        </label>
                      )}
                    </For>
                  </div>
                  <Show when={webNoteLocked(status())}>{(note) => <p data-slot="local-muted">{note()}</p>}</Show>
                  <Show when={webNote(status().policy)}>{(note) => <p data-slot="local-note">{note()}</p>}</Show>
                </div>
              </div>

              <ServersCard status={status()} reader={reader} onError={setError} onNotice={setNotice} />
              <RolesCard status={status()} reader={reader} />
              <AllowedCard
                status={status()}
                pending={pending()}
                onRemove={(source, name) => void run({ allow: { remove: [source] } }, `${name} is no longer allowed.`)}
              />

              <div class="settings-v2-card settings-v2-card--wide" data-section="off">
                <div class="settings-v2-card-head">
                  <div class="settings-v2-card-copy">
                    <h3 class="settings-v2-card-title">{title("off")}</h3>
                    <p class="settings-v2-card-description">
                      What Vector Local keeps off or asks about while it is on, from every connection Vector makes.
                      Allow… appears where you may let one through.
                    </p>
                  </div>
                </div>
                <div class="settings-v2-card-body">
                  <For each={offInLocal(status())}>
                    {(item) => (
                      <div data-slot="local-row">
                        <OffInLocalRow
                          item={item}
                          status={status()}
                          client={reader.client()}
                          named
                          onAllow={(entry) => allowSource(entry.source.id)}
                        />
                      </div>
                    )}
                  </For>
                </div>
              </div>

              <CertificatesCard reader={reader} />
              <LogCard status={status()} reader={reader} />
              <CheckCard reader={reader} />
            </>
          )}
        </Show>
      </Show>
    </section>
  )
}

function SwitchCard(props: {
  status: LocalStatus
  pending: boolean
  restart: boolean
  mismatch?: string
  onToggle: (enabled: boolean) => void
  onApplyHeld: (changes: readonly string[]) => void
  onSetup: () => void
}) {
  const view = () => switchView(props.status)
  return (
    <div class="settings-v2-card settings-v2-card--wide" data-section="switch">
      <div class="settings-v2-card-head">
        <div class="settings-v2-card-copy">
          <h3 class="settings-v2-card-title">{title("switch")}</h3>
          <p class="settings-v2-card-description">{DEFINITION}</p>
        </div>
        <Switch
          checked={view().on}
          disabled={view().disabled || props.pending}
          onChange={props.onToggle}
          data-action="settings-local-switch"
          hideLabel
        >
          Vector Local
        </Switch>
      </div>
      <div class="settings-v2-card-body">
        <Show when={view().note}>{(note) => <p data-slot="local-note">{note()}</p>}</Show>
        <Show when={props.status.agent}>
          <p data-slot="local-note">{AGENT}</p>
        </Show>
        {/* What the policy's resolver ignored, such as "Ignored a policy file that standard users can change." */}
        <For each={props.status.policy.warnings}>{(warning) => <p data-slot="local-note">{warning}</p>}</For>
        <Show when={props.mismatch}>{(mismatch) => <p data-slot="local-note">{mismatch()}</p>}</Show>
        <Show when={props.restart}>
          <p data-slot="local-note">{RESTART}</p>
        </Show>
        <Show when={props.status.held}>
          {(held) => (
            <div data-slot="local-note" data-component="settings-local-held">
              <p>{heldText(held())}</p>
              <div data-slot="local-actions">
                <ButtonV2
                  size="small"
                  variant="outline"
                  disabled={props.pending || props.status.agent}
                  data-action="settings-local-apply-held"
                  onClick={() => props.onApplyHeld(held().changes)}
                >
                  Review and apply
                </ButtonV2>
              </div>
            </div>
          )}
        </Show>
        <div data-slot="local-actions">
          <ButtonV2 variant="outline" data-action="settings-local-setup" onClick={props.onSetup}>
            Set up Vector Local
          </ButtonV2>
        </div>
        <details data-slot="local-details">
          <summary>What Vector Local covers</summary>
          <LocalCovers status={props.status} />
        </details>
      </div>
    </div>
  )
}

function ServersCard(props: {
  status: LocalStatus
  reader: ReturnType<typeof useLocalStatus>
  onError: (message: string) => void
  onNotice: (message: string) => void
}) {
  const local = useLocalChange()
  const [found, setFound] = createSignal<readonly LocalServer[]>()
  const [finding, setFinding] = createSignal(false)
  const [findFailure, setFindFailure] = createSignal<ReadFailure>()
  const [findRetry, setFindRetry] = createSignal<RetryState>({ attempt: 0, wait: undefined })
  // Find servers, and Try again after it failed, start the waits over; a failure that may pass is looked for again.
  const finder = createReadRetry({ run: () => void find(), onChange: setFindRetry })
  onCleanup(finder.dispose)
  const [typed, setTyped] = createSignal("")
  const [busy, setBusy] = createSignal(false)
  const listed = createMemo(() => new Set(props.status.policy.endpoints.map((endpoint) => endpoint.origin)))
  const locked = () => props.status.locked.includes("endpoints")

  const find = async () => {
    const client = props.reader.client()
    if (!client) return
    setFinding(true)
    const result = await client.local
      .detect({}, { throwOnError: false })
      .then((answer) => ({ data: answer.data, status: answer.response?.status, error: answer.error as unknown }))
      .catch((cause: unknown) => ({ data: undefined, status: undefined, error: cause }))
    setFinding(false)
    const failure = result.data ? undefined : readFailure("servers", result)
    setFindFailure(failure)
    finder.settled(failure)
    if (!result.data) return
    setFound(result.data)
    if (result.data.length === 0)
      props.onNotice(
        `No model server answered ${enginePlace(props.reader.remote())}. Start one, or add it by its address.`,
      )
  }

  const add = async (url: string) => {
    const client = props.reader.client()
    if (!client || !url.trim()) return
    setBusy(true)
    const outcome = await local.addServer(client, url.trim())
    setBusy(false)
    if (outcome.type === "cancelled") return props.onNotice("Nothing changed.")
    if (outcome.type === "failed") return props.onError(outcome.message)
    props.reader.set(outcome.added.status)
    setTyped("")
    props.onNotice(
      `${outcome.added.server.name} at ${outcome.added.server.origin} is on your list, added as ${outcome.added.provider} with ${outcome.added.models.length} ${outcome.added.models.length === 1 ? "model" : "models"}.`,
    )
  }

  const remove = async (origin: string) => {
    const client = props.reader.client()
    if (!client) return
    setBusy(true)
    // Removing a server only tightens Vector Local. Its identity pin stays, so the same address answering as another
    // server later is still noticed when it is added again.
    const result = await local.change(client, { endpoints: { remove: [origin] } })
    setBusy(false)
    if (result.type === "failed") return props.onError(result.message)
    if (result.type === "applied") {
      props.reader.set(result.status)
      props.onNotice(`${origin} is off your list. Its models stop working while Vector Local is on.`)
    }
  }

  return (
    <div class="settings-v2-card settings-v2-card--wide" data-section="servers">
      <div class="settings-v2-card-head">
        <div class="settings-v2-card-copy">
          <h3 class="settings-v2-card-title">{title("servers")}</h3>
          <p class="settings-v2-card-description">
            With Vector Local on, model calls go only to these servers. Find servers asks{" "}
            {props.reader.remote() ?? "this computer"} only; add a server elsewhere by its address. Each server's
            identity is pinned when it is added.
          </p>
        </div>
      </div>
      <div class="settings-v2-card-body">
        <For
          each={serverRows(props.status)}
          fallback={<p data-slot="local-muted">No model server is on your list yet.</p>}
        >
          {(row) => (
            <div data-slot="local-row" data-origin={row.origin}>
              <div data-slot="local-row-copy">
                <strong>{row.host}</strong>
                <span data-slot="local-sub">
                  {row.from} · {row.identity}
                </span>
                <div data-slot="local-labels">
                  <For each={row.labels}>
                    {(label) => (
                      <span data-slot="local-tag" data-tone={label.warn ? "warn" : undefined}>
                        {label.text}
                      </span>
                    )}
                  </For>
                </div>
              </div>
              <Show when={row.removable}>
                <ButtonV2 size="small" variant="ghost" disabled={busy()} onClick={() => void remove(row.origin)}>
                  Remove
                </ButtonV2>
              </Show>
            </div>
          )}
        </For>
        <Show when={found()}>
          {(servers) => (
            <For each={servers().filter((server) => !listed().has(server.origin))}>
              {(server) => (
                <div data-slot="local-row" data-found={server.origin}>
                  <div data-slot="local-row-copy">
                    <strong>
                      {server.name}
                      {server.version ? ` ${server.version}` : ""} at {server.origin}
                    </strong>
                    <span data-slot="local-sub">
                      Found {enginePlace(props.reader.remote())} · {server.models.length}{" "}
                      {server.models.length === 1 ? "model" : "models"}
                    </span>
                    <div data-slot="local-labels">
                      <For each={serverLabels(server)}>{(label) => <span data-slot="local-tag">{label}</span>}</For>
                    </div>
                  </div>
                  <ButtonV2
                    size="small"
                    variant="outline"
                    disabled={busy() || locked()}
                    onClick={() => void add(server.baseURL)}
                  >
                    Add
                  </ButtonV2>
                </div>
              )}
            </For>
          )}
        </Show>
        <div data-slot="local-inline">
          <ButtonV2 variant="outline" disabled={finding()} data-action="settings-local-find" onClick={finder.now}>
            {finding() ? "Looking…" : "Find servers"}
          </ButtonV2>
          <input
            type="url"
            data-slot="local-input"
            placeholder="http://gpu-box:8000"
            aria-label="Server address"
            value={typed()}
            disabled={locked()}
            onInput={(event) => setTyped(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") void add(typed())
            }}
          />
          <ButtonV2
            variant="outline"
            disabled={busy() || locked() || !typed().trim()}
            onClick={() => void add(typed())}
          >
            Add server
          </ButtonV2>
        </div>
        <Show when={findFailure()}>
          {(failure) => (
            <ReadError
              failure={failure()}
              retry={findRetry()}
              trying={finding()}
              remote={props.reader.remote()}
              onRetry={finder.now}
            />
          )}
        </Show>
        <Show when={locked()}>
          <p data-slot="local-muted">{LOCKED}</p>
        </Show>
        <Show when={props.status.policy.lock && !locked()}>
          <p data-slot="local-muted">
            Your company lets you add servers on your network
            {props.status.policy.endpoint_domains.length
              ? ` or matching ${props.status.policy.endpoint_domains.join(", ")}`
              : ""}
            .
          </p>
        </Show>
      </div>
    </div>
  )
}

function RolesCard(props: { status: LocalStatus; reader: ReturnType<typeof useLocalStatus> }) {
  const serverSync = useServerSync()
  const dialog = useDialog()
  const [version, setVersion] = createSignal(0)
  const [checks, setChecks] = createSignal<
    Partial<Record<Role, { running?: boolean; result?: LocalModelCheck; error?: string }>>
  >({})
  const [error, setError] = createSignal("")
  const [config] = createResource(
    () => {
      const client = props.reader.client()
      return client ? { client, version: version() } : false
    },
    (input) =>
      input.client.global.config
        .get({ throwOnError: false })
        .then((result) => result.data)
        .catch(() => undefined),
  )
  const roles = createMemo(() => configRoles(config.latest))
  // The models on servers someone hosts, which a role may use under Vector Local.
  const models = createMemo(() => {
    const catalog = serverSync().data.provider
    return roleModels({ providers: catalog.all.values(), connected: catalog.connected, hosted: catalog.hosted })
  })
  const [dictation, { refetch: recheckDictation }] = createResource(() =>
    localTranscriptionInstalled().catch(() => false),
  )
  const [desktop] = createResource(() => desktopLocal())
  const dictationAsks = () =>
    props.status.policy.enabled && desktop.latest !== undefined && desktop.latest.sources["dictation-model"] !== "allow"

  const save = async (role: Role, model: string) => {
    const client = props.reader.client()
    if (!client || !model) return
    setError("")
    const saved = await client.global.config
      .update({ config: rolesPatch({ [role]: model }) }, { throwOnError: false })
      .catch((cause: unknown) => ({ error: cause, data: undefined }))
    if (saved.error) return setError(`Vector could not save the role: ${refusalMessage(saved.error)}`)
    setVersion((value) => value + 1)
  }

  // `confirmed` answers the engine's question when the model may not fit in free memory, as the wizard's Load it anyway.
  const check = async (role: (typeof ROLES)[number], confirmed = false) => {
    const client = props.reader.client()
    const model = roles()[role.id]
    if (!client || !model || !role.check) return
    setChecks((current) => ({ ...current, [role.id]: { running: true } }))
    const result = await client.local
      .check({ model, role: role.check, ...(confirmed ? { confirmed: true } : {}) }, { throwOnError: false })
      .catch((cause: unknown) => ({ error: cause, data: undefined }))
    setChecks((current) => ({
      ...current,
      [role.id]: result.data?.model
        ? { result: result.data.model }
        : { error: result.data ? "Vector did not check the model." : refusalMessage(result.error) },
    }))
  }

  const install = async (files: FileList | null) => {
    if (!files?.length) return
    const picked = [...files].map((file) => ({ path: file.webkitRelativePath || file.name, file }))
    const done = await installLocalTranscription(picked).then(
      () => undefined,
      (cause: unknown) => (cause instanceof Error ? cause.message : "Vector could not install the dictation model."),
    )
    if (done) return setError(done)
    void recheckDictation()
  }

  const allowDictation = () => {
    const client = props.reader.client()
    const source = props.status.sources.find((item) => item.id === "dictation-model")
    if (!client || !source) return
    void dialog.push(() => (
      <DialogAllowSource
        source={source}
        status={props.status}
        client={client}
        onDone={(next) => next && props.reader.set(next)}
      />
    ))
  }

  return (
    <div class="settings-v2-card settings-v2-card--wide" data-section="roles">
      <div class="settings-v2-card-head">
        <div class="settings-v2-card-copy">
          <h3 class="settings-v2-card-title">{title("roles")}</h3>
          <p class="settings-v2-card-description">
            The model each part of Vector uses. Check runs the role's real tools against the model, two or three
            requests to its server, only when you press it.
          </p>
        </div>
      </div>
      <div class="settings-v2-card-body">
        <For each={ROLES}>
          {(role) => {
            const state = () => checks()[role.id]
            return (
              <div data-slot="local-row" data-role={role.id}>
                <div data-slot="local-row-copy">
                  <strong>{role.label}</strong>
                  <span data-slot="local-sub">{role.description}</span>
                  <Show when={roleLocked(role.id, props.status.policy)}>
                    <span data-slot="local-sub">{LOCKED}</span>
                  </Show>
                  <Show when={state()}>
                    {(current) => (
                      <span data-slot="local-sub" data-result={current().result?.result}>
                        {current().running
                          ? "Checking…"
                          : current().result
                            ? `${CHECK_RESULT[current().result!.result]}${current().result!.message ? `. ${current().result!.message}` : ""}`
                            : current().error}
                      </span>
                    )}
                  </Show>
                </div>
                <div data-slot="local-inline">
                  <select
                    data-slot="local-input"
                    aria-label={role.label}
                    value={roles()[role.id] ?? ""}
                    disabled={roleLocked(role.id, props.status.policy)}
                    onChange={(event) => void save(role.id, event.currentTarget.value)}
                  >
                    <option value="" disabled={roles()[role.id] !== undefined}>
                      {role.id === "small" ? "Picked by Vector from the allowed models" : "Same as the session's model"}
                    </option>
                    <Show when={roles()[role.id] && !models().some((model) => model.key === roles()[role.id])}>
                      <option value={roles()[role.id]}>{roles()[role.id]}</option>
                    </Show>
                    <For each={models()}>{(model) => <option value={model.key}>{model.label}</option>}</For>
                  </select>
                  <Show when={role.check && roles()[role.id]}>
                    <ButtonV2 size="small" variant="ghost" disabled={state()?.running} onClick={() => void check(role)}>
                      Check
                    </ButtonV2>
                  </Show>
                  <Show when={state()?.result?.result === "ask"}>
                    <ButtonV2
                      size="small"
                      variant="outline"
                      data-action="settings-local-check-anyway"
                      onClick={() => void check(role, true)}
                    >
                      Load it anyway
                    </ButtonV2>
                  </Show>
                </div>
              </div>
            )
          }}
        </For>
        <Show when={error()}>
          <p data-slot="local-error" role="alert">
            {error()}
          </p>
        </Show>
        <div data-slot="local-row" data-role="memory-search">
          <div data-slot="local-row-copy">
            <strong>Memory search</strong>
            <SettingsMemorySearchModel client={props.reader.client} />
          </div>
        </div>
        <div data-slot="local-row" data-role="dictation">
          <div data-slot="local-row-copy">
            <strong>Dictation</strong>
            <span data-slot="local-sub">
              {dictation.latest ? "Installed on this computer." : "Not on this computer yet."}
            </span>
            <Show when={dictationAsks() && !dictation.latest}>
              <span data-slot="local-sub">{DICTATION_LOCAL}</span>
            </Show>
          </div>
          <div data-slot="local-inline">
            <label class="settings-v2-file-button">
              Install from folder
              <input
                type="file"
                hidden
                {...({ webkitdirectory: "" } as Record<string, string>)}
                onChange={(event) => void install(event.currentTarget.files)}
              />
            </label>
            <Show when={dictationAsks() && !dictation.latest}>
              <ButtonV2 size="small" variant="ghost" onClick={allowDictation}>
                Allow its download…
              </ButtonV2>
            </Show>
          </div>
        </div>
      </div>
    </div>
  )
}

function AllowedCard(props: {
  status: LocalStatus
  pending: boolean
  onRemove: (source: string, name: string) => void
}) {
  return (
    <div class="settings-v2-card settings-v2-card--wide" data-section="allowed">
      <div class="settings-v2-card-head">
        <div class="settings-v2-card-copy">
          <h3 class="settings-v2-card-title">{title("allowed")}</h3>
          <p class="settings-v2-card-description">Services you or your company let through while Vector Local is on.</p>
        </div>
      </div>
      <div class="settings-v2-card-body">
        <For each={allowedRows(props.status)} fallback={<p data-slot="local-muted">You have allowed no service.</p>}>
          {(row) => (
            <div data-slot="local-row" data-source={row.source}>
              <div data-slot="local-row-copy">
                <strong>{row.name}</strong>
                <span data-slot="local-sub">
                  Sends {row.sends.toLowerCase()} to {row.hosts}.
                </span>
                <span data-slot="local-sub">Reason: {row.reason}</span>
                <span data-slot="local-sub">
                  {row.by}
                  {row.when ? `, ${row.when}` : ""}
                </span>
              </div>
              <Show when={row.removable}>
                <ButtonV2
                  size="small"
                  variant="ghost"
                  disabled={props.pending}
                  onClick={() => props.onRemove(row.source, row.name)}
                >
                  Remove
                </ButtonV2>
              </Show>
            </div>
          )}
        </For>
      </div>
    </div>
  )
}

function CertificatesCard(props: { reader: ReturnType<typeof useLocalStatus> }) {
  const [config] = createResource(
    () => props.reader.client() ?? false,
    (client) =>
      client.global.config
        .get({ throwOnError: false })
        .then((result) => result.data)
        .catch(() => undefined),
  )
  return (
    <div class="settings-v2-card settings-v2-card--wide" data-section="certificates">
      <div class="settings-v2-card-head">
        <div class="settings-v2-card-copy">
          <h3 class="settings-v2-card-title">{title("certificates")}</h3>
          <p class="settings-v2-card-description">{CERTIFICATES}</p>
        </div>
      </div>
      <div class="settings-v2-card-body">
        <For
          each={certificateLines(config.latest)}
          fallback={
            <p data-slot="local-muted">
              Your config lists no certificate files. A company lists them in its policy file as local.ca.files.
            </p>
          }
        >
          {(file) => <code data-slot="local-code">{file}</code>}
        </For>
      </div>
    </div>
  )
}

function LogCard(props: { status: LocalStatus; reader: ReturnType<typeof useLocalStatus> }) {
  const dialog = useDialog()
  const [summary] = createResource(
    () => props.reader.client() ?? false,
    (client) =>
      client.local.egress
        .summary({}, { throwOnError: false })
        .then((result) => result.data)
        .catch(() => undefined),
  )
  const open = () => {
    const client = props.reader.client()
    if (!client) return
    void dialog.push(() => (
      <DialogEgressLog client={client} sources={props.status.sources} retainDays={props.status.log.retain_days} />
    ))
  }
  return (
    <div class="settings-v2-card settings-v2-card--wide" data-section="log">
      <div class="settings-v2-card-head">
        <div class="settings-v2-card-copy">
          <h3 class="settings-v2-card-title">{title("log")}</h3>
          <p class="settings-v2-card-description">
            What Vector sent: where each request went and why, never what it said.{" "}
            {retention(props.status.log.retain_days)} The log records while Vector Local is on.
          </p>
        </div>
        <ButtonV2 variant="outline" data-action="settings-local-open-log" onClick={open}>
          Open
        </ButtonV2>
      </div>
      <div class="settings-v2-card-body">
        <Show when={summary.latest}>
          {(counters) => (
            <ul data-slot="local-lines">
              <For each={popoverLines(counters(), { policy: props.status.policy, sources: props.status.sources })}>
                {(line) => <li>{line.text}</li>}
              </For>
            </ul>
          )}
        </Show>
      </div>
    </div>
  )
}

function CheckCard(props: { reader: ReturnType<typeof useLocalStatus> }) {
  const [report, setReport] = createSignal<LocalCheckResult>()
  const [running, setRunning] = createSignal(false)
  const [error, setError] = createSignal("")
  const run = async () => {
    const client = props.reader.client()
    if (!client) return
    setRunning(true)
    setError("")
    const result = await client.local
      .check({}, { throwOnError: false })
      .catch((cause: unknown) => ({ error: cause, data: undefined }))
    setRunning(false)
    if (!result.data) return setError(refusalMessage(result.error))
    setReport(result.data)
  }
  return (
    <div class="settings-v2-card settings-v2-card--wide" data-section="check">
      <div class="settings-v2-card-head">
        <div class="settings-v2-card-copy">
          <h3 class="settings-v2-card-title">{title("check")}</h3>
          <p class="settings-v2-card-description">
            Reads every layer of Vector Local, one row each: the switch, the policy, the network guard, Vector's own
            services, Web access, each server on your list and the network log.
          </p>
        </div>
        <ButtonV2 variant="outline" disabled={running()} data-action="settings-local-check" onClick={() => void run()}>
          {running() ? "Checking…" : "Run a check"}
        </ButtonV2>
      </div>
      <div class="settings-v2-card-body">
        <Show when={error()}>
          <p data-slot="local-error" role="alert">
            {error()}
          </p>
        </Show>
        <Show when={report()}>
          {(current) => (
            <>
              <p data-slot="local-muted">{checkVerdict(current())}</p>
              <For each={current().rows}>
                {(row) => (
                  <div data-slot="local-row" data-layer={row.layer}>
                    <div data-slot="local-row-copy">
                      <strong>{row.title}</strong>
                      <Show when={row.detail}>{(detail) => <span data-slot="local-sub">{detail()}</span>}</Show>
                    </div>
                    <span data-slot="local-check-layer" data-status={row.status}>
                      {CHECK_STATUS[row.status]}
                    </span>
                  </div>
                )}
              </For>
            </>
          )}
        </Show>
      </div>
    </div>
  )
}

/** What Vector could not read and why, the automatic tries, and Try again. */
function ReadError(props: {
  failure: ReadFailure
  retry: RetryState
  trying: boolean
  remote?: string
  onRetry: () => void
}) {
  const text = () => readErrorText(props.failure, props.remote)
  return (
    <div
      data-slot="local-read-error"
      data-component="settings-local-read-error"
      data-target={props.failure.target}
      data-reason={props.failure.reason}
    >
      <p data-slot="local-error" role="alert">
        {text().title} {text().reason}
      </p>
      <Show when={retryText(props.failure, props.retry, props.trying)}>
        {(line) => (
          <p data-slot="local-muted" role="status">
            {line()}
          </p>
        )}
      </Show>
      <ButtonV2
        size="small"
        variant="outline"
        disabled={props.trying}
        data-action="settings-local-retry"
        onClick={props.onRetry}
      >
        Try again
      </ButtonV2>
    </div>
  )
}

function refusalMessage(error: unknown) {
  const refused = refusal(error)
  return refused.type === "confirm" ? "This change would loosen Vector Local." : refused.message
}
