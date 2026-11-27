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
  CONTINUE_NOTE,
  HOW_JOBS_RUN,
  JOB_RUNNING,
  OWN_SESSION_LIMITS,
  PAGE_DESCRIPTION,
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

// Settings → Vector everywhere (VE-41): whether this computer takes jobs started from a chat or an issue, the settings
// they run with, which folders they may use, and the jobs that ran here. The page reads the `everywhere` block of this
// computer's own engine and writes none of it: an older Vector on the same computer cannot read a settings file with
// that key, so the write waits for storage outside user/global config (EV-21, "Ruling on (a)"). No IPC, preload or
// platform change.

/**
 * Whether Settings shows the tab; read under the same server the panel reads (the dialog's ServerSync). Settings
 * can also be mounted with no server at all (packages/app/e2e/fixtures/account-settings.jsx), so the server contexts
 * are read without throwing, and with none the tab stays hidden.
 */
export function useEverywhereTab(offered: Accessor<boolean>) {
  const platform = usePlatform()
  const sdk = useOptionalServerSDK()
  const serverSync = useOptionalServerSync()
  return () =>
    everywhereTab({
      desktop: platform.platform === "desktop",
      server: sdk !== undefined && serverSync !== undefined,
      builtin: sdk !== undefined && ServerConnection.builtin(sdk().server),
      offered: offered(),
      config: serverSync?.().globalConfig(),
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
  const view = createMemo(() => everywhereView(serverSync().globalConfig(), serverSync().globalConfigFailed()))
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
      <Page eyebrow="Vector Codium" title="Vector everywhere" description={PAGE_DESCRIPTION}>
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
              <p class="settings-remote-muted">{VERSION_NOTE}</p>
            </Card>

            {/* Read-only: what the settings file says, with no control (EV-21, "Ruling on (a)"). */}
            <Show when={settings()}>
              {(rows) => (
                <Card icon="sliders" title="How jobs run" description={HOW_JOBS_RUN}>
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
                </Card>
              )}
            </Show>

            <Card icon="folder" title="Allowed repositories" description={REPOSITORY_RULE}>
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
