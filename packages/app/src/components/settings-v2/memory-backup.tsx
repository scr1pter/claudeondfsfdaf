import { For, Show, createResource, createSignal, onCleanup, onMount } from "solid-js"
import { ButtonV2 } from "@vectordevai/ui/v2/button-v2"
import { Switch } from "@vectordevai/ui/v2/switch-v2"
import {
  usePlatform,
  type VaultPlatform,
  type VaultResult,
  type VaultStatus,
  type VaultVersions,
} from "@/context/platform"
import { onCodiumChange } from "@/vector-account"
import {
  GITHUB_COPY,
  RECOVERY_COPY,
  bytes,
  lastLine,
  nextLine,
  placeLine,
  readOnlyLine,
  repoValid,
  restoreLine,
  usageLine,
  vectorCopy,
  vectorOffer,
  when,
} from "./memory-backup-model"

// Settings → Memory → Backup (WP A45): Brain Vault on this computer. Choose where backups go (a private GitHub
// repository you own, free, or Brain Vault on Vector while the plan includes it), back up now, keep backing up every
// night while Vector is open, list the versions, restore one, forget one, or delete the vault. The desktop's main
// process encrypts the memory and keeps the vault key; the first backup shows the recovery code once.
export function SettingsMemoryBackup() {
  const platform = usePlatform()
  const vault = platform.vault
  return (
    <Show when={vault} fallback={<p class="settings-memory-empty">Backups are part of the Vector desktop app.</p>}>
      {(current) => <Backup vault={current()} />}
    </Show>
  )
}

function Backup(props: { vault: VaultPlatform }) {
  const platform = usePlatform()
  const [status, setStatus] = createSignal<VaultStatus>()
  const [versions, setVersions] = createSignal<VaultVersions>()
  const [code, setCode] = createSignal<string>()
  const [notice, setNotice] = createSignal("")
  const [problem, setProblem] = createSignal("")
  const [repo, setRepo] = createSignal("")
  const [recovery, setRecovery] = createSignal("")
  const [confirmForget, setConfirmForget] = createSignal<string>()
  const [confirmDelete, setConfirmDelete] = createSignal(false)
  const [busy, setBusy] = createSignal(false)
  const [now, setNow] = createSignal(Date.now())
  const [plan, { refetch }] = createResource(
    () => (platform.vectorAccount?.codium ? true : false),
    () => platform.vectorAccount?.codium?.().catch(() => undefined),
  )
  const offer = () => vectorOffer(plan())

  onMount(() => {
    void props.vault
      .status()
      .then((next) => {
        setStatus(next)
        setRepo(next.githubRepo ?? "")
      })
      .catch(() => undefined)
    onCleanup(props.vault.onChange(setStatus))
    const clock = setInterval(() => setNow(Date.now()), 30_000)
    onCleanup(() => clearInterval(clock))
  })
  onCleanup(onCodiumChange(() => void refetch()))

  const act = async <T extends { ok: boolean; message: string; status: VaultStatus }>(
    work: () => Promise<T>,
    after?: (result: T) => void,
  ) => {
    if (busy()) return
    setBusy(true)
    setNotice("")
    setProblem("")
    try {
      const result = await work()
      setStatus(result.status)
      if (result.ok) setNotice(result.message)
      else setProblem(result.message)
      after?.(result)
    } catch (cause) {
      setProblem(cause instanceof Error && cause.message ? cause.message : "Vector could not do that. Try again.")
    } finally {
      setBusy(false)
    }
  }

  const loadVersions = () =>
    act(
      async () => {
        const result = await props.vault.versions()
        setVersions(result)
        return result.ok ? { ...result, message: "" } : result
      },
      () => setConfirmForget(undefined),
    )

  const backup = () =>
    act(
      () => props.vault.backup(),
      (result: VaultResult) => {
        if (result.code) setCode(result.code)
        if (versions()) void props.vault.versions().then(setVersions)
      },
    )

  const choose = (backend: "vector" | "github") =>
    act(
      () => props.vault.configure({ backend }),
      () => setVersions(undefined),
    )

  const saveRepo = () => {
    const value = repo().trim()
    if (!repoValid(value)) {
      setProblem("Name the repository as owner/repo, for example octocat/brain-vault.")
      return
    }
    void act(
      () => props.vault.configure({ backend: "github", githubRepo: value }),
      () => setVersions(undefined),
    )
  }

  const restore = (version?: string) =>
    act(
      async () => {
        const result = await props.vault.restore({
          ...(version ? { version } : {}),
          ...(recovery().trim() ? { code: recovery().trim() } : {}),
        })
        return { ...result, message: restoreLine(result) }
      },
      (result) => {
        if (result.ok) {
          setRecovery("")
          void props.vault.versions().then(setVersions)
        }
      },
    )

  const forget = (version: string) =>
    act(
      () => props.vault.forget(version),
      (result) => {
        setConfirmForget(undefined)
        if (result.ok) void props.vault.versions().then(setVersions)
      },
    )

  const remove = () =>
    act(
      () => props.vault.remove(),
      () => {
        setConfirmDelete(false)
        setVersions(undefined)
      },
    )

  const copyCode = async () => {
    const value = code()
    if (!value) return
    await navigator.clipboard?.writeText(value).catch(() => undefined)
    setNotice("Copied the recovery code. Keep it somewhere other than this computer.")
  }

  const placeReady = () => {
    const current = status()
    return Boolean(current && (current.backend === "vector" ? offer() : current.githubRepo))
  }

  return (
    <Show when={status()} fallback={<p class="settings-memory-empty">Reading Brain Vault…</p>}>
      {(current) => (
        <>
          <div class="settings-v2-card settings-v2-card--wide" data-component="settings-memory-backup">
            <div class="settings-v2-card-head">
              <div class="settings-v2-card-copy">
                <h3 class="settings-v2-card-title">Back up your memory</h3>
                <p class="settings-v2-card-description">
                  Brain Vault backs up the memory of Vector on this computer, encrypted here before it leaves. A new
                  computer restores it with your recovery code. Nobody else can read it, Vector included.
                </p>
              </div>
            </div>
            <div class="settings-v2-card-body">
              <Show when={!current().secure}>
                <p class="settings-memory-warning">
                  Vector cannot keep a vault key safely on this computer, because the operating system's credential
                  store is not available. Unlock it and restart Vector to back up.
                </p>
              </Show>

              <div class="settings-memory-segments" role="tablist" aria-label="Where backups go">
                <button
                  type="button"
                  role="tab"
                  aria-selected={current().backend === "github"}
                  classList={{ "is-active": current().backend === "github" }}
                  disabled={busy()}
                  onClick={() => void choose("github")}
                >
                  Your GitHub repository
                </button>
                <Show when={offer() || current().backend === "vector"}>
                  <button
                    type="button"
                    role="tab"
                    aria-selected={current().backend === "vector"}
                    classList={{ "is-active": current().backend === "vector" }}
                    disabled={busy()}
                    onClick={() => void choose("vector")}
                  >
                    Brain Vault on Vector
                  </button>
                </Show>
              </div>

              <Show
                when={current().backend === "github"}
                fallback={<p class="settings-v2-row-description">{vectorCopy(offer())}</p>}
              >
                <div class="settings-v2-action-grid">
                  <input
                    class="settings-memory-search"
                    type="text"
                    placeholder="owner/repo"
                    aria-label="Private GitHub repository for backups"
                    spellcheck={false}
                    value={repo()}
                    onInput={(event) => setRepo(event.currentTarget.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") saveRepo()
                    }}
                  />
                  <ButtonV2
                    variant="outline"
                    disabled={busy() || repo().trim() === (current().githubRepo ?? "")}
                    onClick={saveRepo}
                  >
                    Save
                  </ButtonV2>
                </div>
                <p class="settings-v2-row-description">{GITHUB_COPY}</p>
              </Show>

              <div class="settings-v2-row-modern">
                <div class="settings-v2-row-copy">
                  <div class="settings-v2-row-title">Back up every night while Vector is open</div>
                  <div class="settings-v2-row-description">
                    {nextLine(current(), now()) ??
                      "Vector backs up once a day, in the small hours, or soon after you open it when it missed a night."}
                  </div>
                </div>
                <div class="settings-v2-row-control settings-v2-row-control--compact">
                  <Switch
                    checked={current().enabled}
                    disabled={busy()}
                    onChange={(enabled) => void act(() => props.vault.configure({ enabled }))}
                  />
                </div>
              </div>

              <div class="settings-v2-action-grid">
                <ButtonV2
                  variant="contrast"
                  disabled={busy() || !current().secure || !placeReady() || current().running !== undefined}
                  onClick={() => void backup()}
                >
                  Back up now
                </ButtonV2>
              </div>
              <p class="settings-v2-row-description" role="status">
                {placeLine(current())} {lastLine(current(), now())}
              </p>
              <Show when={current().warning}>
                <p class="settings-memory-warning">{current().warning}</p>
              </Show>
              <Show when={current().error && !problem()}>
                <p class="settings-memory-error">Last attempt: {current().error}</p>
              </Show>

              <Show when={code()}>
                {(value) => (
                  <div class="settings-memory-warning" data-component="settings-memory-backup-code">
                    <strong>Your Brain Vault recovery code</strong>
                    <p class="settings-memory-backup-code">{value()}</p>
                    <p>{RECOVERY_COPY}</p>
                    <div class="settings-v2-action-grid">
                      <ButtonV2 variant="outline" icon="copy" onClick={() => void copyCode()}>
                        Copy
                      </ButtonV2>
                      <ButtonV2 variant="outline" icon="check" onClick={() => setCode(undefined)}>
                        I saved it
                      </ButtonV2>
                    </div>
                  </div>
                )}
              </Show>

              <Show when={notice()}>
                <p class="settings-memory-notice" role="status">
                  {notice()}
                </p>
              </Show>
              <Show when={problem()}>
                <p class="settings-memory-error" role="alert">
                  {problem()}
                </p>
              </Show>
            </div>
          </div>

          <div class="settings-v2-card settings-v2-card--wide" data-component="settings-memory-backup-versions">
            <div class="settings-v2-card-head">
              <div class="settings-v2-card-copy">
                <h3 class="settings-v2-card-title">Versions and restore</h3>
                <p class="settings-v2-card-description">
                  A restore brings back what was in use and pinned, in use and pinned; what waited for your review waits
                  again. It never replaces what is in memory now.
                </p>
              </div>
            </div>
            <div class="settings-v2-card-body">
              <div class="settings-v2-action-grid">
                <ButtonV2 variant="outline" disabled={busy() || !placeReady()} onClick={() => void loadVersions()}>
                  {versions() ? "Refresh versions" : "Show versions"}
                </ButtonV2>
              </div>
              <Show when={versions()}>
                {(listing) => (
                  <Show
                    when={listing().ok ? (listing() as Extract<VaultVersions, { ok: true }>) : undefined}
                    fallback={<p class="settings-memory-error">{(listing() as { message: string }).message}</p>}
                  >
                    {(ok) => (
                      <>
                        <Show when={usageLine(ok())}>
                          {(line) => <p class="settings-v2-row-description">{line()}</p>}
                        </Show>
                        <Show when={readOnlyLine(ok(), now())}>
                          {(line) => <p class="settings-memory-warning">{line()}</p>}
                        </Show>
                        <Show when={!ok().mine && ok().snapshots.length > 0}>
                          <p class="settings-v2-row-description">
                            This vault was made on another computer. Enter its recovery code to restore it; this
                            computer then backs up to it.
                          </p>
                          <input
                            class="settings-memory-search"
                            type="password"
                            autocomplete="off"
                            placeholder="Recovery code"
                            aria-label="Recovery code"
                            value={recovery()}
                            onInput={(event) => setRecovery(event.currentTarget.value)}
                          />
                        </Show>
                        <Show
                          when={ok().snapshots.length > 0}
                          fallback={<p class="settings-memory-empty">{ok().label} holds no backup yet.</p>}
                        >
                          <div class="settings-memory-list">
                            <For each={ok().snapshots}>
                              {(snapshot, index) => (
                                <div class="settings-memory-row" data-version={snapshot.id}>
                                  <div class="settings-v2-row-copy">
                                    <div class="settings-v2-row-title">
                                      {when(snapshot.createdAt, now())}
                                      {index() === 0 ? " (newest)" : ""}
                                    </div>
                                    <div class="settings-v2-row-description">
                                      {snapshot.bytes ? bytes(snapshot.bytes) : ""}
                                    </div>
                                  </div>
                                  <div class="settings-v2-action-grid">
                                    <ButtonV2
                                      variant="outline"
                                      disabled={busy() || (!ok().mine && !recovery().trim())}
                                      onClick={() => void restore(snapshot.id)}
                                    >
                                      Restore
                                    </ButtonV2>
                                    <Show
                                      when={confirmForget() === snapshot.id}
                                      fallback={
                                        <ButtonV2
                                          variant="ghost"
                                          disabled={busy()}
                                          onClick={() => setConfirmForget(snapshot.id)}
                                        >
                                          Forget
                                        </ButtonV2>
                                      }
                                    >
                                      <ButtonV2
                                        variant="outline"
                                        disabled={busy()}
                                        onClick={() => void forget(snapshot.id)}
                                      >
                                        Forget this version
                                      </ButtonV2>
                                      <ButtonV2 variant="ghost" onClick={() => setConfirmForget(undefined)}>
                                        Keep
                                      </ButtonV2>
                                    </Show>
                                  </div>
                                </div>
                              )}
                            </For>
                          </div>
                        </Show>
                      </>
                    )}
                  </Show>
                )}
              </Show>
            </div>
          </div>

          <Show when={current().hasVault || versions()?.ok}>
            <div class="settings-v2-card settings-v2-card--wide" data-component="settings-memory-backup-delete">
              <div class="settings-v2-card-head">
                <div class="settings-v2-card-copy">
                  <h3 class="settings-v2-card-title">Delete the vault</h3>
                  <p class="settings-v2-card-description">
                    Deletes every version where backups go now, and the vault itself. Nothing can restore it afterwards.
                  </p>
                </div>
              </div>
              <div class="settings-v2-card-body">
                <div class="settings-v2-action-grid">
                  <Show
                    when={confirmDelete()}
                    fallback={
                      <ButtonV2 variant="outline" disabled={busy()} onClick={() => setConfirmDelete(true)}>
                        Delete vault…
                      </ButtonV2>
                    }
                  >
                    <ButtonV2 variant="danger" disabled={busy()} onClick={() => void remove()}>
                      Delete every version
                    </ButtonV2>
                    <ButtonV2 variant="ghost" onClick={() => setConfirmDelete(false)}>
                      Cancel
                    </ButtonV2>
                  </Show>
                </div>
              </div>
            </div>
          </Show>
        </>
      )}
    </Show>
  )
}
