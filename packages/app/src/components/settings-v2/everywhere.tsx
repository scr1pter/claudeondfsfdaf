import {
  Component,
  For,
  Show,
  createEffect,
  createMemo,
  createResource,
  createSignal,
  onCleanup,
  onMount,
} from "solid-js"
import type { Accessor } from "solid-js"
import { useNavigate } from "@solidjs/router"
import { getFilename } from "@vectordevai/core/util/path"
import type { ConfigEverywhereV1 } from "@vectordevai/core/v1/config/everywhere"
import type { EverywherePreferenceWire } from "@vectordevai/core/everywhere/preferences"
import { COMPUTER_CAPS } from "@vectordevai/schema/everywhere"
import { ButtonV2 } from "@vectordevai/ui/v2/button-v2"
import { useDialog } from "@vectordevai/ui/context/dialog"
import { usePlatform } from "@/context/platform"
import { useProjectTrust } from "@/context/project-trust"
import { projectTrustStatus } from "@/context/project-trust-policy"
import { ServerConnection, useServer } from "@/context/server"
import { useOptionalServerSDK, useServerSDK } from "@/context/server-sdk"
import { useOptionalServerSync, useServerSync } from "@/context/server-sync"
import { sessionHref } from "@/utils/session-route"
import { Card, Page } from "./parts/page"
import {
  CLOSED_LID,
  CONTINUE_NOTE,
  HOW_JOBS_RUN,
  JOB_RUNNING,
  OWN_SESSION_LIMITS,
  PAGE_DESCRIPTION,
  PUSH_RULE,
  REPOSITORY_RULE,
  VERSION_NOTE,
  checksLine,
  continueEverywhereJob,
  everywhereJobs,
  everywhereTab,
  everywhereView,
  folderTrustLine,
  howJobsRun,
  jobsLine,
  jobsPage,
  openWorktree,
  type EverywhereJob,
  type FolderTrust,
  type RemoteState,
} from "./everywhere-model"
import "./settings-v2.css"
import "./settings-remote.css"

function useEverywherePreferences(builtin: Accessor<boolean>) {
  const platform = usePlatform()
  const [result, { refetch }] = createResource(
    () => builtin() && platform.everywherePreferences,
    (api) => api.read().catch(() => ({ version: 1, kind: "unavailable" }) as const),
  )
  createEffect(() => {
    if (!builtin() || !platform.everywherePreferences) return
    onCleanup(platform.everywherePreferences.onChange(() => void refetch()))
  })
  return {
    snapshot: () => {
      const current = result()
      return current?.kind === "ready" ? current.snapshot : undefined
    },
    legacy: () => !platform.everywherePreferences || result()?.kind === "unsupported",
    failed: () => {
      const current = result()
      return current !== undefined && current.kind !== "ready" && current.kind !== "unsupported"
    },
    refetch,
  }
}

/**
 * Whether Settings shows the tab; read under the same server the panel reads (the dialog's ServerSync). Settings
 * can also be mounted with no server at all (packages/app/e2e/fixtures/account-settings.jsx), so the server contexts
 * are read without throwing, and with none the tab stays hidden.
 */
export function useEverywhereTab(offered: Accessor<boolean>) {
  const platform = usePlatform()
  const sdk = useOptionalServerSDK()
  const serverSync = useOptionalServerSync()
  const builtin = () => platform.platform === "desktop" && sdk !== undefined && ServerConnection.builtin(sdk().server)
  const preferences = useEverywherePreferences(builtin)
  return () =>
    everywhereTab({
      desktop: platform.platform === "desktop",
      server: sdk !== undefined && serverSync !== undefined,
      builtin: builtin(),
      offered: offered(),
      config: preferences.legacy() ? serverSync?.().globalConfig() : preferences.snapshot(),
    })
}

export const SettingsEverywhereV2: Component<{ offered: boolean }> = (props) => {
  const platform = usePlatform()
  const sdk = useServerSDK()
  const serverSync = useServerSync()
  const server = useServer()
  const trust = useProjectTrust()
  const dialog = useDialog()
  const navigate = useNavigate()
  const remote = platform.remote
  // Only the desktop's own engine, the same build as this app, is read here (EV-21 (a)). The connection is
  // the one ServerSync uses, which a draft's or a session's Settings can point at another server.
  const ours = () => platform.platform === "desktop" && ServerConnection.builtin(sdk().server)
  const preferences = useEverywherePreferences(ours)
  const view = createMemo(() =>
    preferences.legacy()
      ? everywhereView(serverSync().globalConfig(), serverSync().globalConfigFailed())
      : everywhereView(preferences.snapshot(), preferences.failed()),
  )
  const [saving, setSaving] = createSignal(false)
  const [folder, setFolder] = createSignal<string>()
  const writable = () => ours() && preferences.snapshot() !== undefined && !view().locked && !view().invalid
  const editable = () => writable() && props.offered
  const save = async (change: Partial<ConfigEverywhereV1.Info>) => {
    const current = preferences.snapshot()
    const api = platform.everywherePreferences
    if (!writable() || saving() || !current || !api) return false
    setSaving(true)
    setProblem(undefined)
    const answer: EverywherePreferenceWire.ChangeResult = await api
      .update({
        version: 1,
        kind: "update",
        revision: current.revision,
        settings: { ...current.everywhere, ...change },
      })
      .catch(() => ({ version: 1, kind: "unavailable" }) as const)
    await preferences.refetch()
    setSaving(false)
    if (answer.kind === "ready") return true
    if (answer.kind === "cancelled") return false
    setProblem(
      answer.kind === "remote-stayed-on"
        ? "Vector could not save the settings. Vector Remote stayed on. You can turn it off in Settings → Remote."
        : answer.kind === "stale"
          ? "These settings changed while you were editing. Check the current settings and try again."
          : answer.kind === "locked"
            ? "Your company controls these settings."
            : answer.kind === "not-offered"
              ? "Your plan does not currently offer Vector everywhere."
              : "Vector could not save these settings. Check the values and try again.",
    )
    return false
  }
  const pickFolder = async () => {
    if (platform.platform !== "desktop" || !editable() || saving()) return
    const result = await platform
      .openDirectoryPickerDialog({ title: "Choose an allowed repository folder" })
      .catch(() => undefined)
    if (typeof result === "string" && editable()) setFolder(result)
  }
  // `loading` until the desktop answers, so the jobs line never says Remote is off before it knows.
  const [remoteStatus, setRemoteStatus] = createSignal<RemoteState>(remote ? "loading" : undefined)
  const [trusting, setTrusting] = createSignal(false)
  const [problem, setProblem] = createSignal<string>()

  // The first status answer is used only while no change event has arrived, so an older answer never replaces a newer
  // one.
  onMount(() => {
    if (!remote) return
    void remote
      .status()
      .then((next) => setRemoteStatus((current) => (current === "loading" ? next : current)))
      .catch(() => setRemoteStatus((current) => (current === "loading" ? undefined : current)))
    onCleanup(remote.onChange(setRemoteStatus))
  })

  const [localOn, { refetch: readLocal }] = createResource(
    () => ours() && sdk().client,
    (client) =>
      client.local
        .get({}, { throwOnError: false })
        .then((result) => result.data?.policy.enabled === true)
        .catch(() => false),
  )
  createEffect(() => {
    if (!ours()) return
    onCleanup(
      sdk().event.on("global", (event) => {
        if (event.type === "local.updated") void readLocal()
      }),
    )
  })

  const [jobs, { refetch: readJobs }] = createResource(
    () => ours() && sdk().client,
    (client) =>
      client.experimental.session
        .list({ roots: true, limit: 200 }, { throwOnError: false })
        .then((result) => (result.data ? everywhereJobs(result.data) : undefined))
        .catch(() => undefined),
  )

  // Whether a job's commands can run here: the engine's own probe, which loads no folder (it has no instance routing)
  // and is the answer the runner reads. Anything but an answer is undefined, and the page then says it may not.
  const [shell] = createResource(
    () => ours() && sdk().client,
    (client) =>
      client.shell.unattended
        .policy({ throwOnError: false })
        .then((result) => result.data?.shell)
        .catch(() => undefined),
  )

  // Each listed folder's trust, read as Settings → Repository trust reads it, but only for a folder open in Vector on
  // this server: reading any other would load it in the engine, which EV-13 (c) never does just to check. The read
  // uses the open project's own spelling, so it reaches the instance that is already loaded. The source follows the
  // folder list, not the whole view, so a settings change that leaves the folders as they were reads no trust again.
  const folders = createMemo(() => view().projects, undefined, {
    equals: (a, b) => a.length === b.length && a.every((item, index) => item.directory === b[index]?.directory),
  })
  const [trusts] = createResource(
    () => {
      if (!ours()) return false
      const opened = server.projects
        .forServer(ServerConnection.key(sdk().server))
        .list()
        .map((project) => project.worktree)
      return { sdk: sdk(), projects: folders(), opened, version: trust.version() }
    },
    (input) =>
      Promise.all(
        input.projects.map((item) => {
          const worktree = openWorktree(item.directory, input.opened)
          if (!worktree)
            return { directory: item.directory, client: undefined, trust: { kind: "closed" } satisfies FolderTrust }
          const client = input.sdk.createClient({ directory: worktree })
          return client.config.trust
            .get()
            .then((result) => projectTrustStatus(result.data))
            .catch(() => undefined)
            .then((status) => ({
              directory: item.directory,
              client,
              trust: { kind: "read", status } satisfies FolderTrust,
            }))
        }),
      ),
  )
  const trustOf = (directory: string) =>
    trusts.latest?.find((item) => item.directory === directory)?.trust ?? ({ kind: "reading" } satisfies FolderTrust)

  const approve = (directory: string) => {
    const client = trusts.latest?.find((item) => item.directory === directory)?.client
    if (!client || trusting()) return
    setTrusting(true)
    setProblem(undefined)
    void trust.approve(client, sdk().scope).then((status) => {
      setTrusting(false)
      if (!status) setProblem("Vector could not save the approval. Try again in a moment.")
    })
  }

  const line = () => jobsLine({ view: view(), remote: remoteStatus(), localOn: localOn() })
  const settings = () => howJobsRun(view())
  const checks = () =>
    checksLine({ view: view(), os: platform.platform === "desktop" ? platform.os : undefined, shell: shell() })
  // Live events can disable the button immediately. The action also asks the Engine before creating a session.
  const running = (job: EverywhereJob) => serverSync().session.data.session_working(job.id)
  const [continuing, setContinuing] = createSignal(false)
  const page = () => jobsPage(props.offered)
  const serverKey = () => ServerConnection.key(sdk().server)

  const open = (sessionID: string) => {
    if (dialog.active) dialog.close()
    navigate(sessionHref(serverKey(), sessionID))
  }

  const continueJob = async (job: EverywhereJob) => {
    if (continuing() || !ours()) return
    const client = sdk().client
    setContinuing(true)
    setProblem(undefined)
    await continueEverywhereJob({
      job: job.id,
      working: () => running(job),
      current: () => ours() && sdk().client === client,
      status: () =>
        client.session.status({ directory: job.directory }, { throwOnError: false }).then((result) => result.data),
      create: () =>
        client.session
          .create({ directory: job.directory, title: job.continueTitle }, { throwOnError: false })
          .then((result) => result.data?.id),
      open,
      problem: setProblem,
    }).finally(() => setContinuing(false))
  }

  return (
    <div class="settings-v2-content-root">
      <Page
        eyebrow="Vector Codium"
        title="Vector everywhere"
        description={
          preferences.legacy()
            ? PAGE_DESCRIPTION
            : "Jobs started from a chat or an issue run on this computer, each in its own copy of a repository you allow."
        }
      >
        <Show
          when={ours()}
          fallback={
            <p class="settings-remote-muted">
              {platform.platform === "desktop"
                ? "These settings belong to the engine built into this app. Choose this computer's own server to see them."
                : "Vector everywhere is part of the Vector desktop app."}
            </p>
          }
        >
          <div class="settings-v2-section-grid">
            <Card icon="branch" title="On this computer">
              <p
                class="settings-remote-state"
                classList={{ "settings-remote-state--problem": line().problem }}
                role="status"
              >
                {line().text}
              </p>
              <Show when={checks()}>{(text) => <p class="settings-remote-muted">{text()}</p>}</Show>
              <Show when={preferences.legacy()}>
                <p class="settings-remote-muted">{VERSION_NOTE}</p>
              </Show>
              <Show when={writable() && (props.offered || view().written)}>
                <div class="settings-remote-actions">
                  <ButtonV2
                    variant="outline"
                    size="small"
                    disabled={saving()}
                    onClick={() => void save({ enabled: !view().written })}
                  >
                    {view().written ? "Stop taking jobs" : "Allow this computer to take jobs"}
                  </ButtonV2>
                </div>
              </Show>
            </Card>

            <Show when={settings()}>
              {(rows) => (
                <Card
                  icon="sliders"
                  title="How jobs run"
                  description={
                    preferences.legacy()
                      ? HOW_JOBS_RUN
                      : "A job stops at its own limit for dollars or minutes when that is lower."
                  }
                >
                  <Show when={!editable()}>
                    <For each={rows()}>
                      {(row) => (
                        <div class="settings-v2-row-modern" data-component="settings-everywhere-setting">
                          <div class="settings-v2-row-copy">
                            <div class="settings-v2-row-title">{row.label}</div>
                            <Show when={row.note}>
                              {(note) => <div class="settings-v2-row-description">{note()}</div>}
                            </Show>
                          </div>
                          <div class="settings-v2-row-control settings-v2-row-control--compact">{row.value}</div>
                        </div>
                      )}
                    </For>
                  </Show>
                  <Show when={editable()}>
                    <form
                      onSubmit={(event) => {
                        event.preventDefault()
                        const data = new FormData(event.currentTarget)
                        const model = String(data.get("model") ?? "").trim()
                        void save({
                          max_usd: Number(data.get("max_usd")),
                          minutes: Number(data.get("minutes")),
                          at_once: Number(data.get("at_once")),
                          per_day: Number(data.get("per_day")),
                          model: model || undefined,
                          wait_for_computer: data.has("wait_for_computer"),
                          push: data.has("push"),
                          stay_awake: data.has("stay_awake"),
                        })
                      }}
                    >
                      <fieldset class="settings-everywhere-fields" disabled={saving()}>
                        <label>
                          US dollars per job{" "}
                          <input
                            name="max_usd"
                            type="number"
                            min="0"
                            max={COMPUTER_CAPS.maxUsd.max}
                            step="any"
                            required
                            value={view().maxUsd}
                          />
                        </label>
                        <label>
                          Minutes per job{" "}
                          <input
                            name="minutes"
                            type="number"
                            min="1"
                            max={COMPUTER_CAPS.minutes.max}
                            required
                            value={view().minutes}
                          />
                        </label>
                        <label>
                          Jobs at once{" "}
                          <input
                            name="at_once"
                            type="number"
                            min="1"
                            max={COMPUTER_CAPS.atOnce.max}
                            required
                            value={view().atOnce}
                          />
                        </label>
                        <label>
                          Jobs per day{" "}
                          <input
                            name="per_day"
                            type="number"
                            min="1"
                            max={COMPUTER_CAPS.perDay.max}
                            required
                            value={view().perDay}
                          />
                        </label>
                        <label>
                          Model <input name="model" value={view().model ?? ""} placeholder="Your default model" />
                        </label>
                        <label>
                          <input type="checkbox" name="wait_for_computer" checked={view().waitForComputer} /> Wait for
                          my computer
                        </label>
                        <label>
                          <input type="checkbox" name="push" checked={view().push} /> Push changes and open a draft PR
                        </label>
                        <p class="settings-remote-muted">{PUSH_RULE}</p>
                        <label>
                          <input type="checkbox" name="stay_awake" checked={view().stayAwake} /> Stay awake to take jobs
                          while plugged in
                        </label>
                        <p class="settings-remote-muted">{CLOSED_LID}</p>
                        <ButtonV2 variant="outline" size="small" type="submit" disabled={saving()}>
                          Save settings
                        </ButtonV2>
                      </fieldset>
                    </form>
                  </Show>
                </Card>
              )}
            </Show>

            <Card icon="folder" title="Allowed repositories" description={REPOSITORY_RULE}>
              <Show when={editable() && view().projects.length < 64}>
                <div class="settings-remote-actions">
                  <ButtonV2 variant="outline" size="small" disabled={saving()} onClick={() => void pickFolder()}>
                    Choose a folder
                  </ButtonV2>
                </div>
                <Show when={folder()} keyed>
                  {(directory) => (
                    <form
                      class="settings-everywhere-fields"
                      onSubmit={(event) => {
                        event.preventDefault()
                        const repository = String(new FormData(event.currentTarget).get("repository") ?? "").trim()
                        void save({ projects: [...view().projects, { directory, repository }] }).then((ok) => {
                          if (ok) setFolder(undefined)
                        })
                      }}
                    >
                      <p class="settings-v2-list-meta">{directory}</p>
                      <label>
                        GitHub repository <input name="repository" required placeholder="owner/repository" />
                      </label>
                      <ButtonV2 variant="outline" size="small" type="submit" disabled={saving()}>
                        Allow this folder
                      </ButtonV2>
                    </form>
                  )}
                </Show>
              </Show>
              <Show
                when={view().projects.length > 0}
                fallback={<p class="settings-v2-card-description">No folders are listed.</p>}
              >
                <div class="settings-v2-list">
                  <For each={view().projects}>
                    {(item) => {
                      const state = () => folderTrustLine(trustOf(item.directory), getFilename(item.directory))
                      return (
                        <div class="settings-v2-list-item" data-component="settings-everywhere-folder">
                          <p class="settings-v2-list-title">{item.repository}</p>
                          <p class="settings-v2-list-meta">{item.directory}</p>
                          <p
                            class="settings-remote-state"
                            classList={{ "settings-remote-state--problem": state().problem }}
                          >
                            {state().text}
                          </p>
                          <Show when={state().detail}>
                            {(detail) => <p class="settings-v2-row-description">{detail()}</p>}
                          </Show>
                          <div class="settings-remote-actions">
                            <Show when={writable()}>
                              <ButtonV2
                                variant="outline"
                                size="small"
                                disabled={saving()}
                                onClick={() =>
                                  void save({
                                    projects: view().projects.filter((project) => project.directory !== item.directory),
                                  })
                                }
                              >
                                Remove folder
                              </ButtonV2>
                            </Show>
                            <Show when={state().canTrust}>
                              <ButtonV2
                                variant="outline"
                                size="small"
                                disabled={trusting()}
                                onClick={() => approve(item.directory)}
                              >
                                {trusting() ? "Trusting…" : "Trust this repository"}
                              </ButtonV2>
                            </Show>
                          </div>
                        </div>
                      )
                    }}
                  </For>
                </div>
              </Show>
            </Card>

            <Card icon="status" title="Jobs on this computer" description={OWN_SESSION_LIMITS} wide>
              <div class="settings-remote-actions">
                <ButtonV2 variant="outline" size="small" disabled={jobs.loading} onClick={() => void readJobs()}>
                  Refresh
                </ButtonV2>
                <Show when={page()}>
                  {(url) => (
                    <ButtonV2 variant="ghost" size="small" onClick={() => platform.openLink(url())}>
                      Your jobs on vectordev.ai
                    </ButtonV2>
                  )}
                </Show>
              </div>
              <p class="settings-remote-muted">{CONTINUE_NOTE}</p>
              <Show
                when={!jobs.loading}
                fallback={<p class="settings-v2-card-description">Reading this computer's jobs…</p>}
              >
                <Show
                  when={jobs()}
                  fallback={<p class="settings-v2-card-description">Vector could not read this computer's jobs.</p>}
                >
                  {(list) => (
                    <Show
                      when={list().length > 0}
                      fallback={<p class="settings-v2-card-description">No jobs have run on this computer.</p>}
                    >
                      <div class="settings-v2-list">
                        <For each={list()}>
                          {(job) => (
                            <div class="settings-v2-list-item" data-component="settings-everywhere-job">
                              <p class="settings-v2-list-title">{job.title}</p>
                              <p class="settings-v2-list-meta">
                                {job.platformName} · {new Date(job.updated).toLocaleString()}
                              </p>
                              <div class="settings-remote-actions">
                                <ButtonV2 variant="outline" size="small" onClick={() => open(job.id)}>
                                  Open
                                </ButtonV2>
                                <ButtonV2
                                  variant="outline"
                                  size="small"
                                  disabled={running(job) || continuing()}
                                  onClick={() => void continueJob(job)}
                                >
                                  Continue in a new session on this branch
                                </ButtonV2>
                              </div>
                              <Show when={running(job)}>
                                <p class="settings-remote-muted">{JOB_RUNNING}</p>
                              </Show>
                            </div>
                          )}
                        </For>
                      </div>
                    </Show>
                  )}
                </Show>
              </Show>
            </Card>
          </div>
          <Show when={problem()}>
            <p class="settings-v2-error" role="alert">
              {problem()}
            </p>
          </Show>
        </Show>
      </Page>
    </div>
  )
}
