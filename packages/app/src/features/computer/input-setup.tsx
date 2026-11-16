import { For, Show, onCleanup, onMount } from "solid-js"
import { createStore } from "solid-js/store"
import { Option, Schema } from "effect"
import { Computer } from "@vectordevai/schema/computer"
import { Hands } from "@vectordevai/schema/hands"
import { Button } from "@vectordevai/ui/button"
import { useLanguage } from "@/context/language"
import { ComputerSendGate } from "./send-gate"

/** Trusted setup controls only. Status polling never sends an input event or resumes a run. */
export function ComputerInputSetup(props: {
  computer: Computer.ComputerPlatform
  value?: Computer.InputSetupStatus
  disabled?: boolean
  onChange(value: Computer.InputSetupStatus | undefined): void
  onResume?: () => Promise<void>
}) {
  const language = useLanguage()
  const [store, setStore] = createStore({ value: props.value, busy: false })
  let disposed = false
  const t = (key: Parameters<typeof language.t>[0]) => language.t(key, { name: Hands.NAME })
  const update = async (action: Computer.InputSetupAction) => {
    if (disposed || store.busy) return
    if (action !== "status") {
      setStore("value", undefined)
      props.onChange(undefined)
    }
    setStore("busy", true)
    try {
      if (!props.computer.inputSetup) throw new Error("Input setup unavailable")
      const value = await ComputerSendGate.bounded(props.computer.inputSetup(action))
      const decoded = Schema.decodeUnknownOption(Computer.InputSetupStatus, { onExcessProperty: "error" })(value)
      if (Option.isNone(decoded)) throw new Error("Input setup unavailable")
      if (!disposed) {
        setStore("value", decoded.value)
        props.onChange(decoded.value)
      }
    } catch {
      if (!disposed) {
        setStore("value", { state: "unavailable", mouse: false, keyboard: false })
        props.onChange(undefined)
      }
    } finally {
      if (!disposed) setStore("busy", false)
    }
  }
  onMount(() => {
    void update("status")
    const timer = setInterval(() => void update("status"), 1000)
    onCleanup(() => clearInterval(timer))
  })
  onCleanup(() => {
    disposed = true
  })
  return (
    <section
      data-component="computer-input-setup"
      class="flex flex-col gap-3 rounded-lg border border-border-weak-base p-4"
    >
      <h3 class="font-medium">{t("computer.inputSetup.title")}</h3>
      <p role="status" aria-live="polite">
        {t(
          store.value?.state === "calibrating" && store.value.mouse && store.value.keyboard
            ? "computer.inputSetup.checking"
            : `computer.inputSetup.${store.value?.state ?? "unavailable"}`,
        )}
      </p>
      <Show when={!store.value?.mouse || !store.value?.keyboard}>
        <p>{t("computer.inputSetup.instruction")}</p>
      </Show>
      <div class="flex flex-wrap gap-4">
        <For each={["mouse", "keyboard"] as const}>
          {(kind) => (
            <p data-input-setup={kind}>
              {t(`computer.inputSetup.${kind}`)}:{" "}
              {t(store.value?.[kind] ? "computer.inputSetup.complete" : "computer.inputSetup.pending")}
            </p>
          )}
        </For>
      </div>
      <p class="text-text-weak">{t("computer.inputSetup.privacy")}</p>
      <p>{t("computer.inputSetup.explicit")}</p>
      <div class="flex flex-wrap gap-2">
        <Button
          disabled={props.disabled || store.busy || store.value?.state === "calibrating"}
          onClick={() => void update("start")}
        >
          {t("computer.inputSetup.start")}
        </Button>
        <Button variant="secondary" disabled={props.disabled || store.busy} onClick={() => void update("reset")}>
          {t("computer.inputSetup.reset")}
        </Button>
        <Show when={props.onResume}>
          <Button
            disabled={props.disabled || store.busy || !Computer.inputSetupReady(store.value)}
            onClick={() =>
              void props.onResume?.().catch(() => {
                void update("status")
              })
            }
          >
            {t("computer.action.resume")}
          </Button>
        </Show>
      </div>
    </section>
  )
}
