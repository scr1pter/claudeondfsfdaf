import { createSignal, onCleanup, Show, type JSX } from "solid-js"
import type { PhoneRemote, RemoteView } from "../remote/client"
import { remoteNotice } from "../remote/model"

// Pieces Remote's phone pages share (WP A42): the connection's state as a signal, and what to say about it.

export function useRemoteView(remote: PhoneRemote) {
  const [view, setView] = createSignal<RemoteView>(remote.view())
  onCleanup(remote.subscribe(setView))
  return view
}

export function ConnectionNotice(props: { remote: PhoneRemote; view: RemoteView }) {
  const notice = () => remoteNotice(props.view)
  const [busy, setBusy] = createSignal(false)
  const act = async (work: () => Promise<unknown>) => {
    if (busy()) return
    setBusy(true)
    try {
      await work()
    } finally {
      setBusy(false)
    }
  }
  return (
    <Show when={notice()}>
      {(current) => (
        <div class="phone-notice phone-stack" role="status">
          <span>{current().text}</span>
          <Show when={current().action === "reconnect"}>
            <button
              type="button"
              class="phone-button phone-button--quiet"
              disabled={busy()}
              onClick={() => act(() => props.remote.connect())}
            >
              Connect again
            </button>
          </Show>
          <Show when={current().action === "reset"}>
            <button
              type="button"
              class="phone-button phone-button--quiet"
              disabled={busy()}
              onClick={() => act(() => props.remote.reset())}
            >
              Set up this phone again
            </button>
          </Show>
        </div>
      )}
    </Show>
  )
}

/** A button that asks once more before doing something that cannot be undone. */
export function ConfirmButton(props: {
  label: string
  confirm: string
  onConfirm: () => Promise<unknown> | unknown
  quiet?: boolean
  disabled?: boolean
}) {
  const [asking, setAsking] = createSignal(false)
  const [busy, setBusy] = createSignal(false)
  let timer: ReturnType<typeof setTimeout> | undefined
  onCleanup(() => timer && clearTimeout(timer))
  const click = async () => {
    if (busy()) return
    if (!asking()) {
      setAsking(true)
      timer = setTimeout(() => setAsking(false), 5_000)
      return
    }
    if (timer) clearTimeout(timer)
    setBusy(true)
    try {
      await props.onConfirm()
    } finally {
      setBusy(false)
      setAsking(false)
    }
  }
  return (
    <button
      type="button"
      class={props.quiet || !asking() ? "phone-button phone-button--quiet" : "phone-button phone-button--danger"}
      disabled={props.disabled || busy()}
      onClick={click}
    >
      {asking() ? props.confirm : props.label}
    </button>
  )
}

export function Row(props: { title: JSX.Element; meta?: JSX.Element; children?: JSX.Element }) {
  return (
    <div class="phone-row">
      <div class="phone-row-text">
        <strong>{props.title}</strong>
        <Show when={props.meta}>
          <span class="phone-meta">{props.meta}</span>
        </Show>
      </div>
      <Show when={props.children}>
        <div class="phone-row-actions">{props.children}</div>
      </Show>
    </div>
  )
}
