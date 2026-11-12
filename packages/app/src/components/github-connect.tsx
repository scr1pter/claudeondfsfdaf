import { Button } from "@vectordevai/ui/button"
import { Icon } from "@vectordevai/ui/icon"
import { Spinner } from "@vectordevai/ui/spinner"
import { For, Show, createSignal, onCleanup, onMount } from "solid-js"

import { showToast } from "@/utils/toast"
import { filterGithubRepos, relativeTime } from "./github-connect-domain"

// The desktop bridge to GitHub (window.api.github) and the pieces of UI the push and clone dialogs share: the
// device-flow sign-in and the repository list.

export type GithubStatus = {
  ghInstalled: boolean
  authenticated: boolean
  login?: string
  detail: string
}

export type GithubPublishResult = {
  ok: boolean
  url?: string
  error?: string
  log: string
}

export type GithubAuthStatus = {
  configured: boolean
  authenticated: boolean
  login?: string
  avatarUrl?: string
}

export type GithubDeviceCode = {
  userCode: string
  verificationUri: string
  expiresIn: number
}

export type GithubRepo = {
  owner: string
  name: string
  fullName: string
  private: boolean
  pushedAt?: string
  defaultBranch?: string
  htmlUrl: string
  canPush?: boolean
}

export type GithubCloneRepo = { owner: string; name: string }
export type GithubCloneParse = { ok: true; repo: GithubCloneRepo } | { ok: false; error: string }
export type GithubCloneParent = { path: string; isDefault: boolean }
export type GithubClonePhase = "starting" | "receiving" | "resolving" | "checkout"
export type GithubCloneProgress = { runId: string; phase: GithubClonePhase; percent: number; message: string }
export type GithubCloneFailure = {
  ok: false
  kind:
    | "invalid"
    | "busy"
    | "exists"
    | "git-missing"
    | "git-outdated"
    | "auth"
    | "not-found"
    | "network"
    | "disk"
    | "canceled"
    | "failed"
  error: string
  detail?: string
  suggestedFolder?: string
}
export type GithubCloneResult = { ok: true; directory: string; reused: boolean; fullName: string } | GithubCloneFailure

export type GithubApi = {
  detect(options?: { refresh?: boolean }): Promise<GithubStatus>
  publish(input: {
    projectPath: string
    name?: string
    private?: boolean
    description?: string
    commitMessage?: string
  }): Promise<GithubPublishResult>
  auth?: {
    status(): Promise<GithubAuthStatus>
    start(input?: { workflow?: boolean }): Promise<GithubDeviceCode>
    openVerification(): Promise<void>
    complete(): Promise<{ ok: boolean; login?: string; error?: string }>
    cancel(): Promise<void>
    logout(): Promise<void>
  }
  repos?: {
    list(): Promise<GithubRepo[]>
    create(input: {
      name: string
      private: boolean
      description?: string
    }): Promise<{ owner: string; name: string; fullName: string; private: boolean; htmlUrl: string }>
  }
  pushOauth?(input: {
    projectPath: string
    repo?: { owner: string; name: string }
    createNew?: { name: string; private: boolean; description?: string }
    commitMessage?: string
  }): Promise<GithubPublishResult>
  clone?: {
    parent(): Promise<GithubCloneParent>
    pickParent(): Promise<GithubCloneParent | null>
    parse(input: string): Promise<GithubCloneParse>
    start(input: { runId: string; repo: string; folder: string; parent: string }): Promise<GithubCloneResult>
    cancel(runId: string): Promise<void>
    subscribe(cb: (progress: GithubCloneProgress) => void): () => void
  }
}

export function githubApi() {
  return (globalThis.window as unknown as { api?: { github?: GithubApi } }).api?.github
}

export function messageOf(error: unknown) {
  if (error instanceof Error && error.message) return error.message
  return String(error)
}

// GitHub's device flow: show a one-time code, open github.com/login/device, and wait for the user to approve it.
// Leaving mid-flow cancels the poll in the main process.
export function GithubDeviceSignIn(props: {
  intro: string
  autoStart?: boolean
  workflow?: boolean // also ask for GitHub's workflow permission
  closeLabel?: string
  onConnected: (login?: string) => void
  onClose: () => void
}) {
  const auth = githubApi()?.auth
  const [deviceCode, setDeviceCode] = createSignal<GithubDeviceCode>()
  const [authError, setAuthError] = createSignal<string>()
  const [starting, setStarting] = createSignal(false)
  const [copied, setCopied] = createSignal(false)

  let disposed = false
  let waiting = false
  let copyTimer: ReturnType<typeof setTimeout> | undefined
  onCleanup(() => {
    disposed = true
    if (copyTimer) clearTimeout(copyTimer)
    if (waiting) void auth?.cancel().catch(() => {})
  })

  async function startAuth() {
    if (!auth || starting()) return
    setStarting(true)
    setAuthError(undefined)
    try {
      setDeviceCode(await auth.start(props.workflow ? { workflow: true } : undefined))
      void waitForAuthorization()
    } catch (error) {
      setAuthError(messageOf(error))
      showToast({ variant: "error", title: "Could not reach GitHub", description: messageOf(error) })
    }
    setStarting(false)
  }

  async function waitForAuthorization() {
    if (!auth) return
    waiting = true
    const outcome = await auth
      .complete()
      .catch((error: unknown) => ({ ok: false, login: undefined, error: messageOf(error) }))
    waiting = false
    if (disposed) return
    if (outcome.ok) {
      props.onConnected(outcome.login)
      return
    }
    setAuthError(outcome.error || "GitHub did not authorize this device.")
  }

  async function openVerification() {
    try {
      await auth?.openVerification()
    } catch (error) {
      showToast({ variant: "error", title: "Could not open GitHub", description: messageOf(error) })
    }
  }

  async function copyCode() {
    const code = deviceCode()?.userCode
    if (!code) return
    try {
      await navigator.clipboard.writeText(code)
      setCopied(true)
      if (copyTimer) clearTimeout(copyTimer)
      copyTimer = setTimeout(() => setCopied(false), 2000)
    } catch (error) {
      showToast({ variant: "error", title: "Copy failed", description: messageOf(error) })
    }
  }

  onMount(() => {
    if (props.autoStart) void startAuth()
  })

  return (
    <Show
      when={deviceCode()}
      fallback={
        <div class="flex flex-col items-center gap-4 p-8 pt-4 text-center">
          <Icon name="github" size="large" />
          <div class="text-16-medium text-text-strong">Connect GitHub</div>
          <p class="max-w-[380px] text-13-regular text-text-weak">{props.intro}</p>
          <Show when={authError()}>
            <div class="w-full rounded-lg border border-[rgba(236,94,94,0.35)] bg-[rgba(236,94,94,0.08)] px-4 py-3 text-12-regular text-text-strong">
              {authError()}
            </div>
          </Show>
          <div class="flex items-center gap-2">
            <Button type="button" variant="ghost" onClick={() => props.onClose()}>
              {props.closeLabel ?? "Close"}
            </Button>
            <Button type="button" variant="primary" onClick={() => void startAuth()} disabled={starting()}>
              {starting() ? "Contacting GitHub…" : "Connect GitHub"}
            </Button>
          </div>
        </div>
      }
    >
      <div class="flex flex-col items-center gap-4 p-8 pt-4 text-center">
        <div class="text-13-regular text-text-weak">
          Enter this code at <span class="text-13-medium text-text-strong">github.com/login/device</span>
        </div>
        <div class="flex items-center gap-2">
          <div class="select-all rounded-lg border border-border-weak-base bg-surface-base px-5 py-3 font-mono text-[24px] font-medium tracking-[0.3em] text-text-strong">
            {deviceCode()?.userCode}
          </div>
          <Button type="button" size="small" onClick={() => void copyCode()}>
            {copied() ? "Copied" : "Copy"}
          </Button>
        </div>
        <Show when={deviceCode()?.expiresIn}>
          <div class="text-11-regular text-text-weak">
            Code expires in about {Math.max(1, Math.round((deviceCode()?.expiresIn ?? 0) / 60))} minutes.
          </div>
        </Show>
        <Show when={props.workflow}>
          <div class="max-w-[360px] text-12-regular text-text-weak">
            GitHub also asks to let Vector change workflow files. Approve it so Vector can open the pull request that
            sets up this repository's workflow.
          </div>
        </Show>
        <Button type="button" onClick={() => void openVerification()}>
          Open GitHub
        </Button>
        <Show
          when={authError()}
          fallback={
            <div class="flex items-center gap-2 text-12-regular text-text-weak">
              <Spinner class="size-3.5" />
              Waiting for you to authorize…
            </div>
          }
        >
          <div class="w-full rounded-lg border border-[rgba(236,94,94,0.35)] bg-[rgba(236,94,94,0.08)] px-4 py-3 text-12-regular text-text-strong">
            {authError()}
          </div>
          <Button type="button" size="small" onClick={() => void startAuth()} disabled={starting()}>
            {starting() ? "Contacting GitHub…" : "Try again"}
          </Button>
        </Show>
        <Button type="button" variant="ghost" onClick={() => props.onClose()}>
          {props.closeLabel ?? "Cancel"}
        </Button>
      </div>
    </Show>
  )
}

// The signed-in user's repositories as radio rows, most recently pushed first (the order GitHub returns them in).
export function GithubRepoOptions(props: {
  repos?: GithubRepo[]
  error?: string
  query: string
  selected?: string
  disabled?: boolean
  emptyText: string
  onSelect: (repo: GithubRepo) => void
  onRetry: () => void
}) {
  return (
    <div class="max-h-[200px] overflow-y-auto rounded-lg border border-border-weak-base">
      <Show
        when={props.repos}
        fallback={
          <div class="flex items-center gap-2 px-4 py-3 text-12-regular text-text-weak">
            <Spinner class="size-3.5" />
            Loading repositories…
          </div>
        }
      >
        <Show when={props.error}>
          <div class="flex items-center justify-between gap-3 px-4 py-3">
            <span class="text-12-regular text-text-weak">{props.error}</span>
            <Button type="button" size="small" onClick={() => props.onRetry()}>
              Retry
            </Button>
          </div>
        </Show>
        <For
          each={filterGithubRepos(props.repos ?? [], props.query)}
          fallback={
            <Show when={!props.error}>
              <div class="px-4 py-3 text-12-regular text-text-weak">{props.emptyText}</div>
            </Show>
          }
        >
          {(repo) => {
            const selected = () => props.selected === repo.fullName
            return (
              <button
                type="button"
                role="radio"
                aria-checked={selected()}
                disabled={props.disabled}
                onClick={() => props.onSelect(repo)}
                class="flex w-full items-center gap-3 px-4 py-2.5 text-left transition-colors hover:bg-surface-raised-base-hover"
                classList={{ "bg-surface-raised-base": selected() }}
              >
                <span class="grid size-3.5 shrink-0 place-items-center rounded-full border border-border-weak-base">
                  <Show when={selected()}>
                    <span class="size-2 rounded-full bg-[rgb(139,92,246)]" />
                  </Show>
                </span>
                <span class="min-w-0 flex-1 truncate text-13-medium text-text-strong">{repo.fullName}</span>
                <Show when={repo.private}>
                  <span class="shrink-0 rounded-full border border-border-weak-base px-2 py-0.5 text-11-medium text-text-weak">
                    Private
                  </span>
                </Show>
                <Show when={relativeTime(repo.pushedAt)}>
                  <span class="shrink-0 text-11-regular text-text-weak">{relativeTime(repo.pushedAt)}</span>
                </Show>
              </button>
            )
          }}
        </For>
      </Show>
    </div>
  )
}
