import type { LocalSource, LocalStatus, LocalUpdate, VectorClient } from "@vectordevai/sdk/v2/client"
import { For, Show, createSignal, onCleanup } from "solid-js"
import { useDialog } from "@vectordevai/ui/context/dialog"
import { ButtonV2 } from "@vectordevai/ui/v2/button-v2"
import { DialogBody, DialogFooter, DialogHeader, DialogTitleGroup, DialogV2 } from "@vectordevai/ui/v2/dialog-v2"
import { showToast } from "@/utils/toast"
import {
  LOOSENING,
  allowChoices,
  allowHosts,
  allowUpdate,
  changesText,
  defaultReason,
  identityChanged,
  refusal,
  sourceName,
  type Refusal,
} from "./local-model"
import "./local.css"

// The Allow dialog (section 8.5): what a source sends, where to and what Vector uses it for, with an editable reason,
// and Allow once, Always allow and Cancel. The dialog is the owner's answer, so Always allow sends `confirm`; under a
// company lock it appears only when the company left `allow` to the user. Other changes that loosen Vector Local (the
// switch, Web access, a new server, a held change) ask through the confirmation below with the engine's own list of
// what they loosen: the first request writes nothing, and only the owner's Apply sends `confirm`.

export function DialogAllowSource(props: {
  source: LocalSource
  status: Pick<LocalStatus, "agent" | "locked" | "policy">
  client: VectorClient
  onDone?: (status?: LocalStatus) => void
}) {
  const dialog = useDialog()
  const choices = () => allowChoices(props.source, props.status)
  const [reason, setReason] = createSignal(defaultReason(props.source))
  const [error, setError] = createSignal("")
  const [pending, setPending] = createSignal(false)
  const name = () => sourceName(props.source.id)
  // Always allow adds an entry with no hosts, which covers every host the source reaches.
  const hosts = () => allowHosts(undefined, props.source.hosts)

  const once = async () => {
    setPending(true)
    const result = await props.client.local
      .grant({ source: props.source.id }, { throwOnError: false })
      .catch((cause: unknown) => ({ error: cause, data: undefined }))
    setPending(false)
    if (!result.data) return setError(message(refusal(result.error)))
    showToast({ title: `${name()} is allowed once`, description: "The next request of this kind goes through." })
    props.onDone?.()
    dialog.close()
  }

  const always = async () => {
    if (!reason().trim()) return setError("Say why Vector may use it. The reason is kept with the entry.")
    setPending(true)
    const result = await props.client.local
      .update({ localUpdate: allowUpdate(props.source, reason()) }, { throwOnError: false })
      .catch((cause: unknown) => ({ error: cause, data: undefined }))
    setPending(false)
    if (!result.data) return setError(message(refusal(result.error)))
    props.onDone?.(result.data)
    dialog.close()
  }

  return (
    <DialogV2 fit class="vector-local-dialog vector-local-allow-dialog">
      <DialogHeader>
        <DialogTitleGroup
          title={`Allow ${name()}?`}
          description={
            props.source.local === "ask-once"
              ? "Vector Local asks before each of these while it is on. Allowing it lets them through."
              : "Vector Local blocks this while it is on. Allowing it lets these requests through."
          }
        />
      </DialogHeader>
      <DialogBody class="vector-local-dialog__body">
        <dl data-slot="local-facts">
          <dt>Sends</dt>
          <dd>{props.source.sends}</dd>
          <dt>To</dt>
          <dd>{hosts()}</dd>
          <dt>Vector uses it for</dt>
          <dd>{props.source.why}</dd>
        </dl>
        <Show when={props.source.note}>{(note) => <p data-slot="local-muted">{note()}</p>}</Show>
        <Show when={choices().always}>
          <label data-slot="local-field">
            <span>Reason</span>
            <textarea
              rows={2}
              value={reason()}
              aria-label="Reason"
              onInput={(event) => {
                setError("")
                setReason(event.currentTarget.value)
              }}
            />
          </label>
        </Show>
        <Show when={choices().note}>{(note) => <p data-slot="local-note">{note()}</p>}</Show>
        <Show when={error()}>
          <p data-slot="local-error" role="alert">
            {error()}
          </p>
        </Show>
      </DialogBody>
      <DialogFooter>
        <ButtonV2 variant="ghost" onClick={() => dialog.close()}>
          Cancel
        </ButtonV2>
        <Show when={choices().once}>
          <ButtonV2 variant="outline" disabled={pending()} data-action="local-allow-once" onClick={() => void once()}>
            Allow once
          </ButtonV2>
        </Show>
        <Show when={choices().always}>
          <ButtonV2
            variant="contrast"
            disabled={pending()}
            data-action="local-allow-always"
            onClick={() => void always()}
          >
            Always allow
          </ButtonV2>
        </Show>
      </DialogFooter>
    </DialogV2>
  )
}

/** "This change would loosen Vector Local. Apply it?" with what the engine said it loosens. */
export function DialogConfirmLoosening(props: {
  changes: readonly string[]
  /** For a server that answers as a different one: the warning, said before the list. */
  warning?: string
  onAnswer: (apply: boolean) => void
}) {
  return (
    <DialogV2 fit class="vector-local-dialog vector-local-confirm-dialog">
      <DialogHeader hideClose>
        <DialogTitleGroup
          title={LOOSENING}
          description={changesText(props.changes) || "It lets more requests through."}
        />
      </DialogHeader>
      <DialogBody class="vector-local-dialog__body">
        <Show when={props.warning}>{(warning) => <p data-slot="local-note">{warning()}</p>}</Show>
        <Show when={props.changes.length > 1}>
          <ul data-slot="local-list">
            <For each={props.changes}>{(change) => <li>{change}</li>}</For>
          </ul>
        </Show>
      </DialogBody>
      <DialogFooter>
        <ButtonV2 variant="ghost" data-action="local-confirm-cancel" onClick={() => props.onAnswer(false)}>
          Cancel
        </ButtonV2>
        <ButtonV2 variant="contrast" data-action="local-confirm-apply" onClick={() => props.onAnswer(true)}>
          Apply
        </ButtonV2>
      </DialogFooter>
    </DialogV2>
  )
}

export type ChangeResult =
  | { readonly type: "applied"; readonly status: LocalStatus }
  | { readonly type: "cancelled" }
  | { readonly type: "failed"; readonly message: string }

/**
 * Changes Vector Local the way the owner's app must: the change goes first without `confirm`, and when the engine says
 * it loosens Vector Local, the owner sees what it loosens and only Apply sends it again with `confirm`.
 */
export function useLocalChange() {
  const dialog = useDialog()
  const state = { open: true }
  onCleanup(() => (state.open = false))

  const confirm = (input: { changes: readonly string[]; warning?: string }) =>
    new Promise<boolean>((resolve) => {
      const answer = { given: false }
      void dialog.push(
        () => (
          <DialogConfirmLoosening
            changes={input.changes}
            warning={input.warning}
            onAnswer={(apply) => {
              answer.given = true
              resolve(apply)
              dialog.close()
            }}
          />
        ),
        () => {
          if (!answer.given) resolve(false)
        },
      )
    })

  const change = async (client: VectorClient, update: LocalUpdate): Promise<ChangeResult> => {
    const send = (confirmed: boolean) =>
      client.local
        .update(
          { localUpdate: { ...update, by: "app", ...(confirmed ? { confirm: true } : {}) } },
          { throwOnError: false },
        )
        .catch((cause: unknown) => ({ error: cause, data: undefined }))
    const first = await send(false)
    if (first.data) return { type: "applied", status: first.data }
    const refused = refusal(first.error)
    if (refused.type !== "confirm") return { type: "failed", message: message(refused) }
    if (!state.open || !(await confirm({ changes: refused.changes }))) return { type: "cancelled" }
    const second = await send(true)
    if (second.data) return { type: "applied", status: second.data }
    return { type: "failed", message: message(refusal(second.error)) }
  }

  /** Add server: reads the server, lists it and pins the identity it answered with, asking first when that loosens. */
  const addServer = async (client: VectorClient, url: string, headers?: Record<string, string>) => {
    const send = (confirmed: boolean) =>
      client.local.servers
        .add({ url, ...(headers ? { headers } : {}), ...(confirmed ? { confirm: true } : {}) }, { throwOnError: false })
        .catch((cause: unknown) => ({ error: cause, data: undefined }))
    const first = await send(false)
    if (first.data) return { type: "added" as const, added: first.data }
    const refused = refusal(first.error)
    if (refused.type !== "confirm") return { type: "failed" as const, message: message(refused) }
    const warning = refused.identity?.length ? identityChanged(hostName(url), refused.identity) : undefined
    if (!state.open || !(await confirm({ changes: refused.changes, warning }))) return { type: "cancelled" as const }
    const second = await send(true)
    if (second.data) return { type: "added" as const, added: second.data }
    return { type: "failed" as const, message: message(refusal(second.error)) }
  }

  return { change, addServer, confirm }
}

export function message(refused: Refusal) {
  if (refused.type === "confirm") return `${LOOSENING} ${changesText(refused.changes)}`.trim()
  return refused.message
}

function hostName(url: string) {
  return URL.canParse(url) ? new URL(url).hostname : url
}
