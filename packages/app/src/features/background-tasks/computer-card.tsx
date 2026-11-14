import {
  createEffect,
  createMemo,
  createSignal,
  createUniqueId,
  For,
  Match,
  onCleanup,
  onMount,
  Show,
  Switch,
} from "solid-js"
import { createStore } from "solid-js/store"
import { Computer } from "@vectordevai/schema/computer"
import { Hands } from "@vectordevai/schema/hands"
import type { Part, PermissionRequest } from "@vectordevai/sdk/v2"
import { useLanguage } from "@/context/language"
import { useSDK } from "@/context/sdk"
import { useSync } from "@/context/sync"
import { computerAsk } from "@/features/computer/ask-model"
import { useComputerState } from "@/features/computer/use-computer-state"
import { showToast } from "@/utils/toast"
import { cardModel, latestShot, type HolderCard, type QueuedCard } from "./computer-card-model"
import { formatDuration } from "./subagent-model"

type Holder = { sessionID: string; directory: string }

export type ComputerCardProps = {
  rootID: string
  /** The holder's current run, for the latest screenshot. */
  run?: () => Part[] | undefined
  /** Opens the live viewer; absent inside the viewer itself. */
  onWatch?: () => void
  /** Opens the conversation that holds the computer. */
  onOpen: (holder: Holder) => void
  /** Brings the holder's own ask into view: sensitive, handoff and check-in asks are answered there. */
  onReview: (holder: Holder) => void
}

/**
 * The pinned Hands card in the Tasks pane (1.5 K): what Hands is doing for this conversation, or that it waits for
 * another one, with Stop and Take over or Resume. Only an app ask is answered here, with Deny and Allow (once).
 */
export function ComputerCard(props: ComputerCardProps) {
  const computer = useComputerState()
  const card = createMemo(() => cardModel(computer?.state(), props.rootID))
  return (
    <Switch>
      <Match when={card()?.kind === "holder" && (card() as HolderCard)}>
        {(holder) => <HolderView {...props} card={holder()} />}
      </Match>
      <Match when={card()?.kind === "queued" && (card() as QueuedCard)}>
        {(queued) => <QueuedView {...props} card={queued()} />}
      </Match>
    </Switch>
  )
}

function HolderView(props: ComputerCardProps & { card: HolderCard }) {
  const language = useLanguage()
  const sdk = useSDK()
  const sync = useSync()
  const computerState = useComputerState()
  const desktop = computerState?.desktop
  const titleID = createUniqueId()
  const t = (key: Parameters<typeof language.t>[0], params?: Record<string, string | number>) =>
    language.t(key, { name: Hands.NAME, ...params })
  const [now, setNow] = createSignal(Date.now())
  createEffect(() => {
    if (!props.card.stop) return
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), 1000)
    onCleanup(() => clearInterval(timer))
  })
  const shot = createMemo(() => latestShot(props.run?.()))
  // Only an app ask whose request this conversation still has pending is answered on the card.
  const appRequest = createMemo(() => {
    const ask = props.card.ask
    if (ask?.kind !== "app") return
    return (sync().data.permission[props.card.holder.sessionID] ?? []).find(
      (request) => request.id === ask.requestID && request.permission === "computer_app",
    )
  })
  const pause = () => {
    const value = props.card.pause
    if (!value) return
    const app = value.app ?? language.t("ui.tool.computer.theApp")
    return { text: t(value.key, { app }), detail: value.detail && t(value.detail, { app }) }
  }
  const run = (action: () => Promise<unknown>) =>
    void action().catch(() => showToast({ variant: "error", title: language.t("common.requestFailed") }))
  // Input stops first on the desktop (INV-R1). Without it, or when the desktop rejects the stop (its helper is gone or
  // main's handler fails), the holder shown at the click has its turn aborted, so Stop still ends the run; the toast
  // shows only when that abort fails too.
  const stop = () => {
    const sessionID = props.card.holder.sessionID
    const abort = () => sdk().client.session.abort({ sessionID })
    run(() =>
      desktop
        ? desktop.command("stop").catch((error) => {
            console.error("[computer] the desktop could not stop the run; aborting the holder's turn", error)
            return abort()
          })
        : abort(),
    )
  }

  return (
    <article
      class="vector-bg-tasks-computer"
      data-computer-card="holder"
      data-phase={props.card.phase}
      aria-labelledby={titleID}
    >
      <div class="vector-bg-tasks-card-head">
        <h3 id={titleID} class="vector-bg-tasks-card-title">
          {t("computer.tasks.title")}
        </h3>
        <span class="vector-bg-tasks-computer-status" data-phase={props.card.phase}>
          {t(props.card.status)}
        </span>
      </div>
      <Show
        when={pause()}
        fallback={<Show when={props.card.step}>{(step) => <p class="vector-bg-tasks-computer-step">{step()}</p>}</Show>}
      >
        {(sentence) => (
          <>
            <p class="vector-bg-tasks-computer-step" data-computer-pause>
              {sentence().text}
            </p>
            <Show when={sentence().detail}>
              {(detail) => <p class="vector-bg-tasks-computer-detail">{detail()}</p>}
            </Show>
          </>
        )}
      </Show>
      <Show when={props.card.apps.length > 0}>
        <ul class="vector-bg-tasks-computer-apps" aria-label="Apps">
          <For each={props.card.apps}>
            {(app) => (
              <li>
                <Show when={app.icon}>{(icon) => <img src={icon()} alt="" width="14" height="14" />}</Show>
                <span>{app.name}</span>
              </li>
            )}
          </For>
        </ul>
      </Show>
      <p class="vector-bg-tasks-meta">
        <Show when={props.card.stop}>
          <time class="vector-bg-tasks-time">
            {t("computer.tasks.elapsed", { duration: formatDuration(now() - props.card.startedAt) })}
          </time>
        </Show>
        <span>
          {t(props.card.actions === 1 ? "computer.tasks.action" : "computer.tasks.actions", {
            count: props.card.actions,
          })}
        </span>
        <Show when={props.card.waiting > 0}>
          <span>{t("computer.tasks.waitingCount", { count: props.card.waiting })}</span>
        </Show>
      </p>
      <Show when={shot()}>
        {(latest) => (
          <Show
            when={latest().image}
            fallback={<p class="vector-bg-tasks-computer-removed">{t("computer.timeline.screenshotRemoved")}</p>}
          >
            {(image) => (
              <Show
                when={props.onWatch}
                fallback={
                  <img
                    class="vector-bg-tasks-computer-shot"
                    src={image().url}
                    alt=""
                    width="160"
                    height="100"
                    decoding="async"
                  />
                }
              >
                {(watch) => (
                  <button
                    type="button"
                    class="vector-bg-tasks-computer-thumb"
                    aria-label={t("computer.action.watch")}
                    onClick={() => watch()()}
                  >
                    <img src={image().url} alt="" width="160" height="100" decoding="async" />
                  </button>
                )}
              </Show>
            )}
          </Show>
        )}
      </Show>
      <Switch>
        <Match when={appRequest()}>
          {(request) => (
            <Show when={request().id} keyed>
              {(requestID) => <AppAsk request={request()} requestID={requestID} />}
            </Show>
          )}
        </Match>
        <Match when={props.card.ask?.kind === "pointer" && props.card.ask}>
          {(ask) => <p class="vector-bg-tasks-computer-step">{ask().title}</p>}
        </Match>
        <Match when={props.card.ask}>
          <button
            type="button"
            class="vector-bg-tasks-computer-link"
            data-computer-review
            onClick={() => props.onReview(props.card.holder)}
          >
            {t("computer.tasks.reviewAsk")}
          </button>
        </Match>
      </Switch>
      <div class="vector-bg-tasks-computer-actions">
        <Show when={props.onWatch}>
          {(watch) => (
            <button type="button" class="vector-bg-tasks-computer-button" onClick={() => watch()()}>
              {t("computer.action.watch")}
            </button>
          )}
        </Show>
        <Show when={desktop && props.card.takeOver}>
          <button
            type="button"
            class="vector-bg-tasks-computer-button"
            onClick={() => run(() => desktop!.command("takeover"))}
          >
            {t("computer.action.takeOver")}
          </button>
        </Show>
        <Show when={desktop && props.card.resume}>
          <button
            type="button"
            class="vector-bg-tasks-computer-button"
            disabled={computerState?.state()?.backend === "local-windows" && !computerState?.resumeReady?.()}
            onClick={() => run(() => desktop!.command("resume"))}
          >
            {t("computer.action.resume")}
          </button>
        </Show>
        <Show when={props.card.stop}>
          <button type="button" class="vector-bg-tasks-computer-button" data-variant="stop" onClick={stop}>
            {t("computer.action.stop")}
          </button>
        </Show>
      </div>
    </article>
  )
}

function QueuedView(props: ComputerCardProps & { card: QueuedCard }) {
  const language = useLanguage()
  const desktop = useComputerState()?.desktop
  const titleID = createUniqueId()
  const t = (key: Parameters<typeof language.t>[0], params?: Record<string, string | number>) =>
    language.t(key, { name: Hands.NAME, ...params })
  return (
    <article class="vector-bg-tasks-computer" data-computer-card="queued" aria-labelledby={titleID}>
      <div class="vector-bg-tasks-card-head">
        <h3 id={titleID} class="vector-bg-tasks-card-title">
          {t("computer.tasks.title")}
        </h3>
      </div>
      <p class="vector-bg-tasks-computer-step">{t(props.card.status, { title: props.card.title ?? "" })}</p>
      <div class="vector-bg-tasks-computer-actions">
        <Show when={props.card.holder}>
          {(holder) => (
            <button type="button" class="vector-bg-tasks-computer-button" onClick={() => props.onOpen(holder())}>
              {t("computer.action.openTask")}
            </button>
          )}
        </Show>
        {/* Fails only this conversation's pending call; the holder keeps the computer (1.5 G). */}
        <Show when={desktop}>
          {(computer) => (
            <button
              type="button"
              class="vector-bg-tasks-computer-button"
              data-variant="stop"
              onClick={() =>
                void computer()
                  .command("stop-session", { sessionID: props.rootID })
                  .catch(() => showToast({ variant: "error", title: language.t("common.requestFailed") }))
              }
            >
              {t("computer.action.stop")}
            </button>
          )}
        </Show>
      </div>
    </article>
  )
}

/**
 * Deny and Allow (once) for the app ask the holder is waiting on, above the same access line and warnings the dock
 * shows (observe or control; not verified, category, built by Vector, local network), so Allow is never offered
 * without them. Allow is inert for 700 ms from when the card shows this request, nothing takes focus, and each
 * request is answered once; a failed reply can be tried again. Keyed by request ID, so a new ask starts over and an
 * old reply can never answer it.
 */
function AppAsk(props: { request: PermissionRequest; requestID: string }) {
  const language = useLanguage()
  const sdk = useSDK()
  const model = createMemo(() => computerAsk(props.request, { t: language.t }))
  const [state, setState] = createStore({ armed: false, decided: false })
  let timer: ReturnType<typeof setTimeout> | undefined
  let disposed = false
  onMount(() => {
    timer = setTimeout(() => setState("armed", true), Computer.LIMITS.askArmMs)
  })
  onCleanup(() => {
    disposed = true
    clearTimeout(timer)
  })
  const decide = (reply: "once" | "reject", event: MouseEvent) => {
    if (disposed || state.decided) return
    if (reply === "once" && (!state.armed || model()?.kind !== "app")) return
    if (reply === "once" && !model()?.enterAllowed && event.detail === 0) return
    setState("decided", true)
    void sdk()
      .client.permission.reply({ requestID: props.requestID, reply }, { throwOnError: true })
      .catch(() => {
        if (disposed) return
        setState("decided", false)
        showToast({ variant: "error", title: language.t("common.requestFailed") })
      })
  }
  return (
    <div class="vector-bg-tasks-computer-ask" data-computer-ask={props.requestID}>
      <p class="vector-bg-tasks-computer-step">{model()?.title ?? language.t("computer.name", { name: Hands.NAME })}</p>
      <Show when={model()?.body}>{(body) => <p class="vector-bg-tasks-computer-detail">{body()}</p>}</Show>
      <For each={model()?.warnings ?? []}>
        {(warning) => (
          <p class="vector-bg-tasks-computer-detail" data-variant="warning">
            {warning}
          </p>
        )}
      </For>
      <div class="vector-bg-tasks-computer-actions">
        <button
          type="button"
          class="vector-bg-tasks-computer-button"
          disabled={state.decided}
          onClick={(event) => decide("reject", event)}
        >
          {language.t("computer.action.deny")}
        </button>
        <Show when={model()?.kind === "app"}>
          <button
            type="button"
            class="vector-bg-tasks-computer-button"
            data-variant="primary"
            data-computer-arming={!state.armed ? "true" : undefined}
            disabled={state.decided || !state.armed}
            onClick={(event) => decide("once", event)}
          >
            {language.t("computer.action.allow")}
          </button>
        </Show>
      </div>
    </div>
  )
}
