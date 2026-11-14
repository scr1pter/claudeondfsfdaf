import { Component, For, Show, Suspense, createMemo, createSignal, onCleanup, onMount } from "solid-js"
import { createStore, reconcile } from "solid-js/store"
import { Dialog } from "@vectordevai/ui/v2/dialog-v2"
import { TabsV2 } from "@vectordevai/ui/v2/tabs-v2"
import { Icon } from "@vectordevai/ui/icon"
import { useDialog } from "@vectordevai/ui/context/dialog"
import { usePlatform } from "@/context/platform"
import type { VectorAccountStatus } from "@/vector-account"
import { settingsIdentity } from "./account-model"
import { SettingsAccountV2 } from "./account"
import { SettingsGeneralV2 } from "./general"
import { SettingsProvidersV2 } from "./providers"
import { SettingsModelsV2 } from "./models"
import { SettingsServersV2 } from "./servers"
import { SettingsUsageV2 } from "./usage"
import { SettingsAboutV2 } from "./about"
import { SettingsProjectTrustV2 } from "./project-trust"
import { SettingsSubagentsV2 } from "./subagents"
import { SettingsComputerV2 } from "./computer"
import { SettingsSpendLimitsV2 } from "./spend-limits"
import { SettingsMemoryV2 } from "./memory"
import { SettingsLocalV2 } from "./local"
import { SettingsKeybinds } from "../settings-keybinds"
import { spendLimitsApi } from "@/features/economics/spend-limits-api"
import {
  filterSettingsGroups,
  isSettingsTab,
  settingsGroups,
  settingsItemCount,
  type SettingsTab,
} from "./settings-registry"
import "./settings-v2.css"
import "./settings-workspace.css"

export type SettingsWorkspaceProps = {
  sessionID?: string
  section?: SettingsTab
  repositoryPath?: string
  /** The folder the active session runs in, when it is an agent or parallel workspace apart from the repository. */
  sessionDirectory?: string
  onBack?: () => void
  class?: string
}

/**
 * The settings application surface. It deliberately has no dialog dependency,
 * so desktop routes and workspace tabs can mount it as a first-class full-page
 * destination while the legacy dialog entry point can keep using the same UI.
 */
export const SettingsWorkspace: Component<SettingsWorkspaceProps> = (props) => {
  const platform = usePlatform()
  let searchInput: HTMLInputElement | undefined
  const [query, setQuery] = createSignal("")
  const [section, setSection] = createSignal<SettingsTab>(props.section ?? "general")
  // Spend limits live in the desktop ledger and the account in the desktop main process, which the web build does
  // not have.
  const available = (item: SettingsTab) => {
    if (item === "spend") return !!spendLimitsApi()
    if (item === "account") return !!platform.vectorAccount
    if (item === "computer") return !!platform.computer
    return true
  }
  const groups = createMemo(() =>
    filterSettingsGroups(query()).map((group) => ({
      ...group,
      items: group.items.filter((item) => available(item.value)),
    })),
  )
  const resultCount = createMemo(() => settingsItemCount(groups()))
  const visibleItems = createMemo(() => new Set(groups().flatMap((group) => group.items.map((item) => item.value))))
  // The header names whoever is signed in to Vector; `failed` holds a photo that would not load.
  const [header, setHeader] = createStore<{ account: VectorAccountStatus; failed?: string }>({
    account: { authenticated: false, pending: false },
  })
  const identity = createMemo(() => settingsIdentity(header.account, header.failed))

  onMount(() => {
    const vectorAccount = platform.vectorAccount
    if (!vectorAccount) return
    onCleanup(vectorAccount.onChange((next) => setHeader("account", reconcile(next))))
    void vectorAccount
      .status()
      .then((next) => setHeader("account", reconcile(next)))
      .catch(() => undefined)
  })

  const panel = (item: SettingsTab) => {
    if (item === "account") return <SettingsAccountV2 onUsage={() => setSection("usage")} />
    if (item === "usage") return <SettingsUsageV2 />
    if (item === "spend") return <SettingsSpendLimitsV2 />
    if (item === "about") return <SettingsAboutV2 />
    if (item === "trust")
      return <SettingsProjectTrustV2 repositoryPath={props.repositoryPath} sessionDirectory={props.sessionDirectory} />
    if (item === "subagents") return <SettingsSubagentsV2 />
    if (item === "computer")
      return <Show when={platform.computer}>{(computer) => <SettingsComputerV2 computer={computer()} />}</Show>
    if (item === "memory")
      return <SettingsMemoryV2 repositoryPath={props.repositoryPath} sessionDirectory={props.sessionDirectory} />
    if (item === "local") return <SettingsLocalV2 />
    if (item === "providers") return <SettingsProvidersV2 />
    if (item === "models") return <SettingsModelsV2 />
    if (item === "servers") return <SettingsServersV2 />
    // The editor loads its v2 controls lazily; its own boundary keeps that from suspending whatever opened Settings.
    if (item === "shortcuts")
      return (
        <Suspense>
          <SettingsKeybinds v2 />
        </Suspense>
      )
    return <SettingsGeneralV2 section={item} sessionID={props.sessionID} />
  }

  return (
    <div class={`settings-v2-workspace ${props.class ?? ""}`}>
      <TabsV2
        orientation="vertical"
        variant="settings"
        value={section()}
        onChange={(value) => {
          if (isSettingsTab(value)) setSection(value)
        }}
        class="settings-v2 settings-v2--fullscreen"
      >
        <TabsV2.List>
          <aside class="settings-v2-nav-shell" aria-label="Settings categories">
            <div class="settings-v2-nav-topline">
              <Show when={props.onBack}>
                <button type="button" class="settings-v2-back" aria-label="Back" onClick={props.onBack}>
                  <Icon name="arrow-left" size="small" />
                  <span>Back</span>
                </button>
              </Show>
            </div>

            <div class="settings-v2-brand-row" data-identity={identity() ? "account" : "vector"}>
              <Show when={identity()} fallback={<img src="/vector-logo.png" alt="" class="settings-v2-brand-mark" />}>
                {(person) => (
                  <Show
                    when={person().photo}
                    fallback={
                      <span class="settings-v2-brand-mark settings-v2-brand-avatar" aria-hidden="true">
                        {person().initials}
                      </span>
                    }
                  >
                    {(photo) => (
                      <img
                        src={photo()}
                        alt=""
                        class="settings-v2-brand-mark settings-v2-brand-avatar"
                        referrerpolicy="no-referrer"
                        decoding="async"
                        draggable={false}
                        onError={() => setHeader("failed", photo())}
                      />
                    )}
                  </Show>
                )}
              </Show>
              <div class="settings-v2-brand-text">
                <div class="settings-v2-brand-name" title={identity()?.name}>
                  {identity()?.name ?? "Vector"}
                </div>
                <div class="settings-v2-brand-subtitle">Settings</div>
              </div>
            </div>

            <label class="settings-v2-nav-search">
              <Icon name="magnifying-glass" size="small" />
              <input
                ref={searchInput}
                type="search"
                value={query()}
                onInput={(event) => {
                  const value = event.currentTarget.value
                  const start = event.currentTarget.selectionStart ?? value.length
                  const end = event.currentTarget.selectionEnd ?? value.length
                  setQuery(value)
                  queueMicrotask(() => {
                    searchInput?.focus()
                    searchInput?.setSelectionRange(start, end)
                  })
                }}
                placeholder="Search settings"
                aria-label="Search settings"
                autofocus
              />
              <Show when={query()}>
                <button type="button" aria-label="Clear settings search" onClick={() => setQuery("")}>
                  <Icon name="close-small" size="small" />
                </button>
              </Show>
            </label>

            <div class="settings-v2-nav-groups">
              <For each={settingsGroups}>
                {(group) => (
                  <div
                    class="settings-v2-nav-group"
                    classList={{
                      "settings-v2-nav-group--hidden":
                        !!query().trim() && !group.items.some((item) => visibleItems().has(item.value)),
                    }}
                  >
                    <TabsV2.SectionTitle>{group.title}</TabsV2.SectionTitle>
                    <div class="settings-v2-nav-items">
                      <For each={group.items}>
                        {(item) => (
                          <TabsV2.Trigger
                            value={item.value}
                            classList={{
                              "settings-v2-nav-item--hidden":
                                !available(item.value) || (!!query().trim() && !visibleItems().has(item.value)),
                            }}
                          >
                            <Icon name={item.icon} />
                            {item.label}
                          </TabsV2.Trigger>
                        )}
                      </For>
                    </div>
                  </div>
                )}
              </For>
              <Show when={query() && resultCount() === 0}>
                <div class="settings-v2-nav-empty">
                  <strong>No settings found</strong>
                  <span>Try a feature name such as model, memory, update, or notifications.</span>
                </div>
              </Show>
            </div>

            <div class="settings-v2-nav-footer">
              <span>Vector {platform.version || "Development"}</span>
              <span>{platform.platform === "desktop" ? "Desktop" : "Web"}</span>
            </div>
          </aside>
        </TabsV2.List>

        <For each={filterSettingsGroups("").flatMap((group) => group.items)}>
          {(item) => (
            <TabsV2.Content value={item.value} class="settings-v2-panel">
              {panel(item.value)}
            </TabsV2.Content>
          )}
        </For>
      </TabsV2>
    </div>
  )
}

export const DialogSettings: Component<Omit<SettingsWorkspaceProps, "onBack">> = (props) => {
  const dialog = useDialog()

  return (
    <Dialog size="x-large" variant="settings" class="settings-v2-dialog">
      <SettingsWorkspace {...props} onBack={() => dialog.close()} />
    </Dialog>
  )
}
