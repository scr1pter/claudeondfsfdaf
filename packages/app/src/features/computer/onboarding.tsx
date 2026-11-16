import { createMemo, For, onCleanup, onMount, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { Button } from "@vectordevai/ui/button"
import { Dialog } from "@vectordevai/ui/dialog"
import { useDialog } from "@vectordevai/ui/context/dialog"
import type { Computer } from "@vectordevai/schema/computer"
import { Hands } from "@vectordevai/schema/hands"
import { useLanguage } from "@/context/language"
import { ComputerOnboarding } from "./onboarding-model"
import { createComputerOnboarding } from "./onboarding-controller"
import { ComputerInputSetup } from "./input-setup"

export type ComputerOnboardingOptions = {
  computer: Computer.ComputerPlatform
  onTry?: (text: string) => boolean | Promise<boolean>
  onFinished?: () => void
}

/** Use this opener so close-start cancels pending work before the shared dialog's exit animation finishes. */
export function showComputerOnboarding(dialog: ReturnType<typeof useDialog>, options: ComputerOnboardingOptions) {
  const controller = createComputerOnboarding(options.computer)
  return dialog.show(() => <ComputerOnboardingDialog {...options} controller={controller} />, controller.dispose)
}

function ComputerOnboardingDialog(
  props: ComputerOnboardingOptions & { controller: ReturnType<typeof createComputerOnboarding> },
) {
  const language = useLanguage()
  const dialog = useDialog()
  const [store, setStore] = createStore({
    state: props.controller.state,
    example: undefined as string | undefined,
    insertionFailed: false,
    finishing: false,
  })
  const t = (key: Parameters<typeof language.t>[0], params?: Record<string, string>) =>
    language.t(key, { name: Hands.NAME, mention: Hands.MENTION, ...params })
  const platform = () => props.controller.platform(store.state)
  const blocked = () => props.controller.blocked(store.state)
  const ready = () => props.controller.ready(store.state)
  const busy = () => store.state.loading || store.state.saving || store.finishing
  const step = createMemo(
    () =>
      ComputerOnboarding.steps(platform(), store.state.permissions).find((step) => step.id === store.state.step) ??
      ComputerOnboarding.steps(platform()).find((step) => step.id === store.state.step)!,
  )
  const rows = createMemo(() => ComputerOnboarding.rowsFor(store.state.permissions, store.state.settings?.prefs ?? {}))
  const examples = createMemo(() => [
    t("computer.onboarding.example.receipts", { app: platform() === "windows" ? "Excel" : "Numbers" }),
    t("computer.onboarding.example.chart", { app: "Excel", destinationApp: "PowerPoint" }),
    platform() === "windows"
      ? t("computer.onboarding.example.builtApp")
      : t("computer.onboarding.example.simulator", { app: "iOS Simulator" }),
  ])
  onMount(() => {
    const unsubscribe = props.controller.subscribe((state) => setStore("state", state))
    void props.controller.start()
    onCleanup(unsubscribe)
  })
  onCleanup(props.controller.dispose)

  const finish = async () => {
    if (store.finishing) return
    setStore({ finishing: true, insertionFailed: false })
    const saved = await props.controller.finish()
    if (!props.controller.active()) return
    if (!saved) {
      setStore("finishing", false)
      return
    }
    props.onFinished?.()
    if (store.example && props.onTry) {
      const inserted = await Promise.resolve()
        .then(() => props.onTry!(store.example!))
        .catch(() => false)
      if (!props.controller.active()) return
      if (!inserted) {
        setStore({ finishing: false, insertionFailed: true })
        return
      }
    }
    props.controller.dispose()
    dialog.close()
  }
  const close = () => {
    props.controller.dispose()
    dialog.close()
  }
  const statusKeys = {
    granted: "computer.status.granted",
    denied: "computer.status.denied",
    unknown: "computer.status.unknown",
    "reset-after-update": "computer.status.resetAfterUpdate",
  } as const

  return (
    <div data-component="computer-onboarding" class="contents">
      <Dialog title={t(step().title)} fit>
        <div class="flex max-h-[75vh] flex-col gap-4 overflow-y-auto px-6 pb-6 text-14-regular">
          <For each={step().description}>{(key) => <p>{t(key)}</p>}</For>
          <Show when={store.state.loading}>
            <p role="status">{language.t("common.loading")}</p>
          </Show>
          <Show when={!store.state.loading && blocked()}>{(key) => <p role="alert">{t(key())}</p>}</Show>
          <Show when={store.state.error}>{(key) => <p role="alert">{t(key())}</p>}</Show>
          <Show when={store.state.step !== "consent"}>
            <Show when={platform() === "windows"}>
              <ComputerInputSetup
                computer={props.computer}
                value={store.state.permissions?.windows?.inputSetup}
                disabled={busy() || !!blocked()}
                onChange={props.controller.inputSetupChanged}
              />
            </Show>
            <For each={rows()}>
              {(row) => (
                <div
                  data-onboarding-row={row.id}
                  data-permission={row.id === "screen" || row.id === "accessibility" ? row.id : undefined}
                  class="flex flex-col gap-2 rounded-lg border border-border-weak-base p-3"
                >
                  <div class="flex items-start justify-between gap-3">
                    <p class="font-medium">{t(row.title)}</p>
                    <Show when={row.status}>{(status) => <span role="status">{t(statusKeys[status()])}</span>}</Show>
                  </div>
                  <Show when={row.description}>{(description) => <p>{t(description())}</p>}</Show>
                  <Show when={row.open || row.reset}>
                    <div class="flex flex-wrap gap-2">
                      <Show when={row.open}>
                        {(id) => (
                          <Button
                            variant="secondary"
                            disabled={busy()}
                            onClick={() => void props.controller.openPane(id())}
                          >
                            {t(
                              id() === "windows-capture"
                                ? "computer.action.openPrivacy"
                                : "computer.action.openSystemSettings",
                            )}
                          </Button>
                        )}
                      </Show>
                      <Show when={row.reset && store.state.permissions?.canReset}>
                        <Button
                          variant="secondary"
                          disabled={busy()}
                          onClick={() => void props.controller.reset(row.reset!)}
                        >
                          {t("computer.action.reset")}
                        </Button>
                      </Show>
                    </div>
                  </Show>
                </div>
              )}
            </For>
          </Show>
          <Show when={store.state.step === "try"}>
            <p>{t("computer.onboarding.chooseExample")}</p>
            <For each={examples()}>
              {(example) => (
                <button
                  type="button"
                  class="rounded-lg border border-border-weak-base p-3 text-left hover:bg-surface-raised-base"
                  aria-pressed={store.example === example}
                  disabled={busy() || !props.onTry}
                  onClick={() => setStore({ example, insertionFailed: false })}
                >
                  {example}
                </button>
              )}
            </For>
            <Show when={store.insertionFailed}>
              <p role="alert">{t("computer.onboarding.exampleNeedsComposer")}</p>
            </Show>
          </Show>
          <div class="flex flex-wrap justify-end gap-2">
            <Button variant="ghost" onClick={close}>
              {t("computer.action.notNow")}
            </Button>
            <Show when={store.state.step !== "consent" || store.state.error}>
              <Button
                variant="secondary"
                disabled={busy() || store.state.checking}
                onClick={() => void props.controller.check()}
              >
                {t("computer.action.checkAgain")}
              </Button>
            </Show>
            <Show when={store.state.step === "consent"}>
              <Button
                variant="primary"
                disabled={busy() || !!blocked()}
                onClick={() => void props.controller.consent()}
              >
                {t("computer.onboarding.turnOn")}
              </Button>
            </Show>
            <Show when={store.state.step === "permissions"}>
              <Button variant="primary" disabled={busy() || !ready()} onClick={() => props.controller.advance()}>
                {t("computer.action.continue")}
              </Button>
            </Show>
            <Show when={store.state.step === "try"}>
              <Button variant="primary" disabled={busy() || !ready()} onClick={() => void finish()}>
                {t("computer.action.finish")}
              </Button>
            </Show>
          </div>
        </div>
      </Dialog>
    </div>
  )
}
