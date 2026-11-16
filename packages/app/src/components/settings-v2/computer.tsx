import { For, Show, createMemo, onCleanup, onMount } from "solid-js"
import { createStore } from "solid-js/store"
import type { Computer } from "@vectordevai/schema/computer"
import { Hands } from "@vectordevai/schema/hands"
import { useDialog } from "@vectordevai/ui/context/dialog"
import { ButtonV2 } from "@vectordevai/ui/v2/button-v2"
import { SelectV2 } from "@vectordevai/ui/v2/select-v2"
import { Switch } from "@vectordevai/ui/v2/switch-v2"
import { useLanguage } from "@/context/language"
import { usePlatform } from "@/context/platform"
import { ComputerMainCopy } from "@/features/computer/main-copy"
import { ComputerOnboarding } from "@/features/computer/onboarding-model"
import { ComputerInputSetup } from "@/features/computer/input-setup"
import { requestComposerPrompt } from "@/utils/composer-handoff"
import { createComputerSettings, type AppResult } from "./computer-controller"
import { ComputerSettings } from "./computer-model"
import "./settings-v2.css"

// The Hands Settings page (section 1.5 K): the status pill, the Use switch, the permission rows from onboarding,
// how it works, the stop shortcut, the app lists and screenshots. Controls a company sets are disabled and say so.
// The page reads permissions on open, on window focus and on Check again, never on a timer (D6b.7).

type Key = Parameters<ReturnType<typeof useLanguage>["t"]>[0]

const PERMISSION_STATUS = {
  granted: "computer.status.granted",
  denied: "computer.status.denied",
  unknown: "computer.status.unknown",
  "reset-after-update": "computer.status.resetAfterUpdate",
} as const satisfies Record<Computer.PermissionsView["rows"][number]["status"], Key>
const MODES = [
  { id: "background", title: "computer.mode.background", description: "computer.mode.background.description" },
  { id: "foreground", title: "computer.mode.foreground", description: "computer.mode.foreground.description" },
] as const
const POINTERS = [
  { id: "ask", title: "computer.settings.mouse.ask" },
  { id: "take", title: "computer.settings.mouse.take" },
] as const

export function SettingsComputerV2(props: { computer: Computer.ComputerPlatform }) {
  const language = useLanguage()
  const dialog = useDialog()
  const platform = usePlatform()
  const controller = createComputerSettings(props.computer)
  const [store, setStore] = createStore({
    state: controller.state,
    recording: false,
    chord: undefined as "keys" | "reserved" | undefined,
    confirming: false,
    blocking: false,
    query: "",
    results: undefined as AppResult[] | undefined,
  })
  const ui = { mounted: true, timer: undefined as ReturnType<typeof setTimeout> | undefined }
  onMount(() => {
    const unsubscribe = controller.subscribe((state) => setStore("state", state))
    void controller.start()
    onCleanup(unsubscribe)
  })
  onCleanup(() => {
    ui.mounted = false
    clearTimeout(ui.timer)
    controller.dispose()
  })

  const t = (key: Key, params?: Record<string, string | number>) => language.t(key, { name: Hands.NAME, ...params })
  const settings = () => store.state.settings
  const os = () => ComputerSettings.platformOf(store.state.backend)
  const busy = () => store.state.loading || store.state.saving
  const locked = (field: keyof Computer.ComputerPrefs) => {
    const current = settings()
    return !current || ComputerSettings.locked(field, current)
  }
  const pill = createMemo(() => ComputerSettings.status(store.state, props.computer.supported))
  const effective = createMemo(() => {
    const current = settings()
    return current && ComputerSettings.effective(current)
  })
  const rows = createMemo(() => ComputerOnboarding.rowsFor(store.state.permissions, settings()?.prefs ?? {}))
  const always = createMemo(() => ComputerSettings.alwaysRows(settings()?.always ?? []))
  const company = createMemo(() => {
    const current = settings()
    return current && ComputerSettings.companyRows(current.policy)
  })
  const blocked = createMemo(() => {
    const current = settings()
    return current && ComputerSettings.blockedRows(current)
  })
  const retention = createMemo(() => ComputerSettings.retentionOptions(settings()?.policy.maxRetentionDays))
  let retentionControl: HTMLDivElement | undefined
  const date = (at: number) => new Intl.DateTimeFormat(language.intl(), { dateStyle: "medium" }).format(at)

  const use = async (next: boolean) => {
    if (!next) return void controller.setPrefs({ enabled: false })
    // Only onboarding's Finish turns Hands on (D6a.1). It replaces the Settings dialog, as every dialog.show does.
    const { showComputerOnboarding } = await import("@/features/computer/onboarding")
    if (!ui.mounted) return
    showComputerOnboarding(dialog, {
      computer: props.computer,
      onTry: (text) => requestComposerPrompt({ text, send: false, mention: "computer" }),
    })
  }
  // A native radio checks itself when clicked. A refused save publishes no settings, so nothing would uncheck the
  // choice that was not saved: once the save settles, the whole group shows what main holds again.
  const choose = (input: HTMLInputElement, patch: Partial<Computer.ComputerPrefs>, saved: () => string | undefined) =>
    void controller.setPrefs(patch).then(() =>
      input
        .closest('[role="radiogroup"]')
        ?.querySelectorAll("input")
        .forEach((radio) => (radio.checked = radio.value === saved())),
    )
  const record = (event: KeyboardEvent) => {
    event.preventDefault()
    event.stopPropagation()
    const result = ComputerSettings.recordChord(event, os())
    if (result.type === "pending") return
    if (result.type === "cancel") return setStore({ recording: false, chord: undefined })
    if (result.type === "invalid") return setStore("chord", result.reason)
    setStore({ recording: false, chord: undefined })
    if (result.accelerator !== settings()?.prefs.stopChord) void controller.setPrefs({ stopChord: result.accelerator })
  }
  const search = (query: string) => {
    setStore("query", query)
    clearTimeout(ui.timer)
    controller.cancelSearch()
    if (!query.trim()) return setStore("results", undefined)
    ui.timer = setTimeout(() => {
      void controller.searchApps(query.trim()).then((results) => {
        if (results && ui.mounted) setStore("results", results)
      })
    }, 150)
  }
  const closeSearch = () => {
    clearTimeout(ui.timer)
    controller.cancelSearch()
    setStore({ blocking: false, query: "", results: undefined })
  }
  const remove = () => {
    setStore("confirming", false)
    void controller.deleteScreenshots()
  }
  const managed = (field: keyof Computer.ComputerPrefs) => (
    <Show when={settings() && locked(field)}>
      <p data-slot="computer-locked">{t("computer.settings.managed")}</p>
    </Show>
  )

  return (
    <section class="settings-v2-page" data-component="settings-computer">
      <div class="settings-v2-page-hero">
        <div>
          <h2 class="settings-v2-page-title">{t("computer.name")}</h2>
          <p class="settings-v2-page-subtitle">{t("computer.mention.description")}</p>
        </div>
      </div>

      <div data-computer-status data-slot="computer-status">
        <Show
          when={pill()}
          fallback={
            <Show when={props.computer.supported}>
              <p data-slot="computer-muted">{language.t("common.loading")}</p>
            </Show>
          }
        >
          {(current) => (
            <p role="status" data-slot="computer-pill" data-kind={current().kind}>
              {t(current().key)}
            </p>
          )}
        </Show>
        <Show when={pill()?.note}>{(note) => <p data-slot="computer-note">{t(note())}</p>}</Show>
        <Show when={store.state.failed}>
          <ButtonV2
            size="small"
            variant="outline"
            disabled={store.state.checking}
            onClick={() => void controller.check()}
          >
            {t("computer.action.checkAgain")}
          </ButtonV2>
        </Show>
      </div>
      <Show when={store.state.error}>
        {(key) => (
          <p role="alert" data-slot="computer-error">
            {t(key())}
          </p>
        )}
      </Show>

      <Show when={props.computer.supported && settings()}>
        {(current) => (
          <>
            <div class="settings-v2-card settings-v2-card--wide" data-section="use">
              <div class="settings-v2-card-head">
                <div class="settings-v2-card-copy">
                  <h3 class="settings-v2-card-title">{t("computer.settings.use")}</h3>
                  <p class="settings-v2-card-description">{t("computer.onboarding.description")}</p>
                </div>
                <Switch
                  checked={current().prefs.enabled === true && current().policy.enabled === true}
                  disabled={busy() || locked("enabled") || locked("consentedAt")}
                  onChange={(next) => void use(next)}
                  hideLabel
                >
                  {t("computer.settings.use")}
                </Switch>
              </div>
              <div class="settings-v2-card-body">
                <Show when={locked("enabled") || locked("consentedAt")}>
                  <p data-slot="computer-locked">{t("computer.settings.managed")}</p>
                </Show>
              </div>
            </div>

            <div class="settings-v2-card settings-v2-card--wide" data-section="permissions">
              <div class="settings-v2-card-head">
                <div class="settings-v2-card-copy">
                  <h3 class="settings-v2-card-title">{t("computer.onboarding.permissions")}</h3>
                  <p class="settings-v2-card-description">
                    {t(
                      os() === "macos"
                        ? "computer.onboarding.macos.instruction"
                        : "computer.onboarding.windows.description",
                    )}
                  </p>
                </div>
              </div>
              <div class="settings-v2-card-body">
                <Show when={os() === "windows"}>
                  <ComputerInputSetup
                    computer={props.computer}
                    value={store.state.permissions?.windows?.inputSetup}
                    disabled={busy() || !current().prefs.consentedAt}
                    onChange={controller.inputSetupChanged}
                    onResume={store.state.phase === "paused" ? () => props.computer.command("resume") : undefined}
                  />
                </Show>
                <For each={rows()}>
                  {(row) => (
                    <div
                      class="settings-v2-row-modern"
                      data-onboarding-row={row.id}
                      data-permission={row.id === "screen" || row.id === "accessibility" ? row.id : undefined}
                    >
                      <div class="settings-v2-row-copy">
                        <div class="settings-v2-row-title">
                          {t(row.title)}
                          <Show when={row.status}>
                            {(status) => (
                              <span data-slot="computer-badge" data-status={status()}>
                                {t(PERMISSION_STATUS[status()])}
                              </span>
                            )}
                          </Show>
                        </div>
                        <Show when={row.description}>
                          {(description) => <div class="settings-v2-row-description">{t(description())}</div>}
                        </Show>
                      </div>
                      <Show when={row.open || row.reset}>
                        <div data-slot="computer-actions">
                          <Show when={row.open}>
                            {(id) => (
                              <ButtonV2
                                size="small"
                                variant="outline"
                                disabled={busy()}
                                onClick={() => void controller.openPane(id())}
                              >
                                {t(
                                  id() === "windows-capture"
                                    ? "computer.action.openPrivacy"
                                    : "computer.action.openSystemSettings",
                                )}
                              </ButtonV2>
                            )}
                          </Show>
                          <Show when={row.reset && store.state.permissions?.canReset}>
                            <ButtonV2
                              size="small"
                              variant="outline"
                              disabled={busy()}
                              onClick={() => void controller.reset(row.reset!)}
                            >
                              {t("computer.action.reset")}
                            </ButtonV2>
                          </Show>
                        </div>
                      </Show>
                    </div>
                  )}
                </For>
                <div data-slot="computer-actions">
                  <ButtonV2
                    size="small"
                    variant="outline"
                    disabled={store.state.checking}
                    onClick={() => void controller.check()}
                  >
                    {t("computer.action.checkAgain")}
                  </ButtonV2>
                </div>
              </div>
            </div>

            <div class="settings-v2-card settings-v2-card--wide" data-section="working">
              <div class="settings-v2-card-head">
                <div class="settings-v2-card-copy">
                  <h3 class="settings-v2-card-title">{t("computer.settings.whileWorking")}</h3>
                </div>
              </div>
              <div class="settings-v2-card-body">
                <Show when={os() === "macos"}>
                  <div role="radiogroup" aria-label={t("computer.settings.whileWorking")} data-slot="computer-options">
                    <For each={MODES}>
                      {(mode) => (
                        <label data-slot="computer-option">
                          <input
                            type="radio"
                            name="computer-mode"
                            value={mode.id}
                            checked={effective()?.mode === mode.id}
                            disabled={busy() || locked("mode")}
                            onChange={(event) =>
                              choose(event.currentTarget, { mode: mode.id }, () => effective()?.mode)
                            }
                          />
                          <span>
                            <strong>{t(mode.title)}</strong>
                            <span>{t(mode.description)}</span>
                          </span>
                        </label>
                      )}
                    </For>
                  </div>
                  {managed("mode")}
                  <div role="radiogroup" aria-label={t("computer.settings.mouse")} data-slot="computer-options">
                    <p data-slot="computer-subhead">{t("computer.settings.mouse")}</p>
                    <For each={POINTERS}>
                      {(pointer) => (
                        <label data-slot="computer-option">
                          <input
                            type="radio"
                            name="computer-pointer"
                            value={pointer.id}
                            checked={current().prefs.pointer === pointer.id}
                            disabled={busy() || locked("pointer")}
                            onChange={(event) =>
                              choose(event.currentTarget, { pointer: pointer.id }, () => settings()?.prefs.pointer)
                            }
                          />
                          <span>
                            <strong>{t(pointer.title)}</strong>
                          </span>
                        </label>
                      )}
                    </For>
                  </div>
                  {managed("pointer")}
                </Show>
                <div class="settings-v2-row-modern" data-row="keep-awake">
                  <div class="settings-v2-row-copy">
                    <div class="settings-v2-row-title">{t("computer.settings.keepAwake")}</div>
                    <div class="settings-v2-row-description">{t("computer.settings.keepAwake.description")}</div>
                    {managed("keepAwake")}
                  </div>
                  <div class="settings-v2-row-control settings-v2-row-control--compact">
                    <Switch
                      checked={effective()?.keepAwake === true}
                      disabled={busy() || locked("keepAwake")}
                      onChange={(next) => void controller.setPrefs({ keepAwake: next })}
                      hideLabel
                    >
                      {t("computer.settings.keepAwake")}
                    </Switch>
                  </div>
                </div>
                <div class="settings-v2-row-modern" data-row="notify">
                  <div class="settings-v2-row-copy">
                    <div class="settings-v2-row-title">{t("computer.settings.notifications")}</div>
                    {managed("notify")}
                  </div>
                  <div class="settings-v2-row-control settings-v2-row-control--compact">
                    <Switch
                      checked={current().prefs.notify === true}
                      disabled={busy() || locked("notify")}
                      onChange={(next) => void controller.setPrefs({ notify: next })}
                      hideLabel
                    >
                      {t("computer.settings.notifications")}
                    </Switch>
                  </div>
                </div>
                <div class="settings-v2-row-modern" data-row="stop">
                  <div class="settings-v2-row-copy">
                    <div class="settings-v2-row-title">{t("computer.settings.stop")}</div>
                    <div class="settings-v2-row-description">
                      {t("computer.settings.stop.description", {
                        shortcut: ComputerMainCopy.chord(current().prefs.stopChord, os()),
                      })}
                    </div>
                    <Show when={store.recording}>
                      <input
                        data-slot="computer-recorder"
                        data-dialog-keys="capture"
                        readOnly
                        aria-label={t("computer.settings.stop.record")}
                        placeholder={t("computer.settings.stop.record")}
                        ref={(element) => {
                          // A listener on the input itself, not Solid's document-level delegation, so stopping the
                          // event keeps it from the dialog's own Escape handling (the dialog stack skips it by the
                          // data attribute above).
                          element.addEventListener("keydown", record)
                          queueMicrotask(() => element.focus())
                        }}
                        onBlur={() => setStore({ recording: false, chord: undefined })}
                      />
                      <Show when={store.chord}>
                        {(reason) => (
                          <p role="alert" data-slot="computer-error">
                            {t(
                              reason() === "reserved"
                                ? "computer.settings.stop.reserved"
                                : "computer.settings.stop.invalid",
                            )}
                          </p>
                        )}
                      </Show>
                    </Show>
                    {managed("stopChord")}
                  </div>
                  <div class="settings-v2-row-control settings-v2-row-control--compact">
                    <ButtonV2
                      size="small"
                      variant="outline"
                      disabled={busy() || store.recording || locked("stopChord")}
                      onClick={() => setStore({ recording: true, chord: undefined })}
                    >
                      {t("computer.action.change")}
                    </ButtonV2>
                  </div>
                </div>
              </div>
            </div>

            <div class="settings-v2-card settings-v2-card--wide" data-section="always">
              <div class="settings-v2-card-head">
                <div class="settings-v2-card-copy">
                  <h3 class="settings-v2-card-title">{t("computer.settings.always")}</h3>
                </div>
              </div>
              <div class="settings-v2-card-body">
                <Show when={current().alwaysReset}>
                  <p data-slot="computer-note">{t("computer.settings.always.reset")}</p>
                </Show>
                <Show when={current().policy.allowAlways !== true}>
                  <p data-slot="computer-note">{t("computer.ask.always.company")}</p>
                </Show>
                <Show
                  when={always().length > 0}
                  fallback={<p data-slot="computer-muted">{t("computer.settings.always.empty")}</p>}
                >
                  <ul data-slot="computer-list">
                    <For each={always()}>
                      {(app) => (
                        <li data-slot="computer-app" data-key={app.key}>
                          <div data-slot="computer-app-copy">
                            <strong>{app.name}</strong>
                            <Show when={app.publisher}>
                              {(publisher) => <span>{t("computer.ask.publisher", { publisher: publisher() })}</span>}
                            </Show>
                            <Show when={!app.publisher && app.teamId}>
                              {(teamId) => <span>{t("computer.settings.always.team", { teamId: teamId() })}</span>}
                            </Show>
                            <Show when={app.addedAt}>
                              {(at) => <span>{t("computer.settings.always.added", { date: date(at()) })}</span>}
                            </Show>
                          </div>
                          <ButtonV2
                            size="small"
                            variant="outline"
                            disabled={busy()}
                            onClick={() => void controller.removeAlways(app.key)}
                          >
                            {t("computer.action.remove")}
                          </ButtonV2>
                        </li>
                      )}
                    </For>
                  </ul>
                  <div data-slot="computer-actions">
                    <ButtonV2
                      size="small"
                      variant="ghost"
                      disabled={busy()}
                      onClick={() => void controller.removeAllAlways()}
                    >
                      {t("computer.action.removeAll")}
                    </ButtonV2>
                  </div>
                </Show>
              </div>
            </div>

            <Show when={current().policy.managed === true && company()}>
              {(rules) => (
                <div class="settings-v2-card settings-v2-card--wide" data-section="company">
                  <div class="settings-v2-card-head">
                    <div class="settings-v2-card-copy">
                      <h3 class="settings-v2-card-title">{t("computer.settings.company")}</h3>
                      <p class="settings-v2-card-description">{t("computer.settings.company.description")}</p>
                    </div>
                  </div>
                  <div class="settings-v2-card-body">
                    <For
                      each={[
                        { id: "allowed", title: "computer.settings.company.allowed" as const, apps: rules().allowed },
                        { id: "denied", title: "computer.settings.company.denied" as const, apps: rules().denied },
                      ].filter((group) => group.apps.length > 0)}
                    >
                      {(group) => (
                        <div data-company={group.id}>
                          <p data-slot="computer-subhead">{t(group.title)}</p>
                          <ul data-slot="computer-list">
                            <For each={group.apps}>
                              {(app) => (
                                <li data-slot="computer-app" data-key={app.key}>
                                  <div data-slot="computer-app-copy">
                                    <strong>{app.name}</strong>
                                  </div>
                                </li>
                              )}
                            </For>
                          </ul>
                        </div>
                      )}
                    </For>
                    <For each={rules().ignored}>
                      {(id) => <p data-slot="computer-note">{t("computer.policy.ignoredMacRule", { id })}</p>}
                    </For>
                  </div>
                </div>
              )}
            </Show>

            <Show when={blocked()}>
              {(lists) => (
                <div class="settings-v2-card settings-v2-card--wide" data-section="blocked">
                  <div class="settings-v2-card-head">
                    <div class="settings-v2-card-copy">
                      <h3 class="settings-v2-card-title">{t("computer.settings.blocked")}</h3>
                    </div>
                  </div>
                  <div class="settings-v2-card-body">
                    <div data-blocked="builtin">
                      <p data-slot="computer-subhead">{t("computer.settings.blocked.builtIn")}</p>
                      <ul data-slot="computer-list">
                        <For each={lists().never}>
                          {(group) => (
                            <li data-slot="computer-app" data-group={group.id}>
                              <div data-slot="computer-app-copy">
                                <strong>{t(group.title)}</strong>
                                <Show when={"description" in group && group.description}>
                                  {(description) => <span>{t(description())}</span>}
                                </Show>
                              </div>
                            </li>
                          )}
                        </For>
                      </ul>
                    </div>
                    <Show when={lists().defaults.length > 0}>
                      <div data-blocked="default">
                        <p data-slot="computer-subhead">{t("computer.settings.blocked.default")}</p>
                        <ul data-slot="computer-list">
                          <For each={lists().defaults}>
                            {(row) => (
                              <li data-slot="computer-app" data-group={row.id} data-allowed={row.allowed || undefined}>
                                <div data-slot="computer-app-copy">
                                  <strong>{row.title ? t(row.title) : row.name}</strong>
                                </div>
                                <ButtonV2
                                  size="small"
                                  variant="outline"
                                  disabled={busy() || !row.editable}
                                  onClick={() =>
                                    void (row.allowed
                                      ? controller.blockDefault(row.keys)
                                      : controller.allowDefault(row.keys))
                                  }
                                >
                                  {t(row.allowed ? "computer.action.block" : "computer.action.allow")}
                                </ButtonV2>
                              </li>
                            )}
                          </For>
                        </ul>
                        {managed("unblocked")}
                      </div>
                    </Show>
                    <div data-blocked="yours">
                      <p data-slot="computer-subhead">{t("computer.settings.blocked.yours")}</p>
                      <ul data-slot="computer-list">
                        <For each={lists().yours}>
                          {(app) => (
                            <li data-slot="computer-app" data-key={app.key}>
                              <div data-slot="computer-app-copy">
                                <strong>{app.name}</strong>
                                <Show when={app.addedAt}>
                                  {(at) => <span>{t("computer.settings.always.added", { date: date(at()) })}</span>}
                                </Show>
                              </div>
                              <ButtonV2
                                size="small"
                                variant="outline"
                                disabled={busy() || !app.editable}
                                onClick={() => void controller.unblock(app.key)}
                              >
                                {t("computer.action.unblock")}
                              </ButtonV2>
                            </li>
                          )}
                        </For>
                      </ul>
                      {managed("blocked")}
                      <Show
                        when={store.blocking}
                        fallback={
                          <div data-slot="computer-actions">
                            <ButtonV2
                              size="small"
                              variant="outline"
                              disabled={busy() || locked("blocked")}
                              onClick={() => setStore("blocking", true)}
                            >
                              {t("computer.action.blockApp")}
                            </ButtonV2>
                          </div>
                        }
                      >
                        <div data-slot="computer-search">
                          <input
                            type="search"
                            data-slot="computer-search-input"
                            aria-label={t("computer.settings.blocked.search")}
                            placeholder={t("computer.settings.blocked.search")}
                            value={store.query}
                            ref={(element) => queueMicrotask(() => element.focus())}
                            onInput={(event) => search(event.currentTarget.value)}
                          />
                          <ButtonV2 size="small" variant="ghost" onClick={closeSearch}>
                            {t("common.cancel")}
                          </ButtonV2>
                        </div>
                        <Show when={store.results}>
                          {(results) => (
                            <Show
                              when={results().length > 0}
                              fallback={<p data-slot="computer-muted">{t("computer.settings.blocked.none")}</p>}
                            >
                              <ul data-slot="computer-list" aria-label={t("computer.settings.blocked.search")}>
                                <For each={results()}>
                                  {(app) => (
                                    <li data-slot="computer-app" data-key={app.key}>
                                      <div data-slot="computer-app-copy">
                                        <strong>{app.name}</strong>
                                      </div>
                                      <ButtonV2
                                        size="small"
                                        variant="outline"
                                        disabled={busy()}
                                        aria-label={`${t("computer.action.block")} ${app.name}`}
                                        onClick={() => void controller.block(app).then((done) => done && closeSearch())}
                                      >
                                        {t("computer.action.block")}
                                      </ButtonV2>
                                    </li>
                                  )}
                                </For>
                              </ul>
                            </Show>
                          )}
                        </Show>
                      </Show>
                    </div>
                  </div>
                </div>
              )}
            </Show>

            <div class="settings-v2-card settings-v2-card--wide" data-section="screenshots">
              <div class="settings-v2-card-head">
                <div class="settings-v2-card-copy">
                  <h3 class="settings-v2-card-title">{t("computer.settings.screenshots")}</h3>
                  <p class="settings-v2-card-description">{t("computer.settings.screenshots.description")}</p>
                </div>
              </div>
              <div class="settings-v2-card-body">
                <div class="settings-v2-row-modern" data-row="retention">
                  <div class="settings-v2-row-copy">
                    <div class="settings-v2-row-title">{t("computer.settings.screenshots.keep")}</div>
                    {managed("retention")}
                  </div>
                  <div class="settings-v2-row-control" ref={retentionControl}>
                    {/* Inside the modal Settings dialog, a list portalled to the body sits under the dialog's layer
                        and is marked aria-hidden, so it opens inside the dialog's content instead, as the server row
                        menu does. */}
                    <SelectV2
                      mount={retentionControl?.closest<HTMLElement>('[data-slot="dialog-content"]') ?? undefined}
                      appearance="inline"
                      options={retention()}
                      current={effective()?.retention}
                      value={(option) => option}
                      label={(option) => t(ComputerSettings.RETENTION_LABEL[option])}
                      disabled={busy() || locked("retention")}
                      onSelect={(option) => {
                        if (option && option !== effective()?.retention) void controller.setPrefs({ retention: option })
                      }}
                    />
                  </div>
                </div>
                <Show
                  when={store.confirming}
                  fallback={
                    <div data-slot="computer-actions">
                      <ButtonV2
                        size="small"
                        variant="danger"
                        disabled={store.state.deleting}
                        onClick={() => setStore("confirming", true)}
                      >
                        {t("computer.settings.screenshots.delete")}
                      </ButtonV2>
                    </div>
                  }
                >
                  <div
                    role="group"
                    aria-label={t("computer.settings.screenshots.confirm.title")}
                    data-slot="computer-confirm"
                  >
                    <strong>{t("computer.settings.screenshots.confirm.title")}</strong>
                    <p>{t("computer.settings.screenshots.confirm.description")}</p>
                    <div data-slot="computer-actions">
                      <ButtonV2 size="small" variant="ghost" onClick={() => setStore("confirming", false)}>
                        {language.t("common.cancel")}
                      </ButtonV2>
                      <ButtonV2 size="small" variant="danger" disabled={store.state.deleting} onClick={remove}>
                        {language.t("common.delete")}
                      </ButtonV2>
                    </div>
                  </div>
                </Show>
                <Show when={store.state.deleted !== undefined}>
                  <p role="status" data-slot="computer-muted">
                    {t("computer.settings.screenshots.deleted", { count: store.state.deleted ?? 0 })}
                  </p>
                </Show>
              </div>
            </div>

            <div data-slot="computer-actions">
              <ButtonV2
                size="small"
                variant="ghost"
                onClick={() => platform.openLink(`https://vectordev.ai/docs/${Hands.DOCS}`)}
              >
                {t("computer.settings.docs")}
              </ButtonV2>
            </div>
          </>
        )}
      </Show>
    </section>
  )
}
