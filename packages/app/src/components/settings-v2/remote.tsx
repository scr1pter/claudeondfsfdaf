import { Component, For, Match, Show, Switch, createMemo, createResource, createSignal, onCleanup, onMount } from "solid-js"
import { ButtonV2 } from "@vectordevai/ui/v2/button-v2"
import { usePlatform, type RemoteStatus } from "@/context/platform"
import { onCodiumChange } from "@/vector-account"
import { encodeQr, qrPath } from "@/utils/qr/encode"
import { Card, Page, ToggleRow } from "./parts/page"
import {
  PHONE_APP_ADDRESS,
  minutesAndSeconds,
  pairedCountLine,
  pairedSince,
  phoneLine,
  secondsLeft,
  spacedCode,
  stateLine,
} from "./remote-model"
import "./settings-v2.css"
import "./settings-remote.css"

// Settings → Remote (WP A42): Vector Remote on this computer. Turn it on, pair a phone with the QR code and the six-digit
// check, see the paired phones, remove one, or disconnect them all. The main process keeps the keys and the connection
// (A41); the phone app at remote.vectordev.ai is the other half. vectordev.ai decides from the plan whether this
// computer may connect, and the relay refuses one over the plan's computer count (S1).
export const SettingsRemoteV2: Component = () => {
  const platform = usePlatform()
  const remote = platform.remote
  const [status, setStatus] = createSignal<RemoteStatus>()
  const [problem, setProblem] = createSignal<string>()
  const [notice, setNotice] = createSignal<string>()
  const [busy, setBusy] = createSignal(false)
  const [confirmAll, setConfirmAll] = createSignal(false)
  const [now, setNow] = createSignal(Date.now())
  const [plan, { refetch }] = createResource(
    () => (platform.vectorAccount?.codium ? true : false),
    () => platform.vectorAccount?.codium?.().catch(() => undefined),
  )

  onMount(() => {
    if (!remote) return
    void remote
      .status()
      .then(setStatus)
      .catch(() => undefined)
    onCleanup(remote.onChange(setStatus))
    const clock = setInterval(() => setNow(Date.now()), 1_000)
    onCleanup(() => clearInterval(clock))
  })
  onCleanup(onCodiumChange(() => void refetch()))

  const act = async (work: () => Promise<RemoteStatus | void>, done?: string) => {
    if (!remote || busy()) return
    setBusy(true)
    setProblem(undefined)
    setNotice(undefined)
    try {
      const next = await work()
      if (next) setStatus(next)
      if (done) setNotice(done)
    } catch (cause) {
      setProblem(cause instanceof Error && cause.message ? cause.message : "Vector could not do that. Try again.")
    } finally {
      setBusy(false)
    }
  }

  const pairing = () => status()?.pairing ?? { state: "idle" as const }
  const qr = createMemo(() => {
    const current = pairing()
    if (current.state !== "waiting") return undefined
    try {
      return qrPath(encodeQr(current.link))
    } catch {
      return undefined
    }
  })
  const left = () => {
    const current = pairing()
    return current.state === "waiting" || current.state === "confirm" ? secondsLeft(current.expiresAt, now()) : 0
  }

  return (
    <div class="settings-v2-content-root">
      <Page
        eyebrow="Vector Codium"
        title="Remote"
        description={`Watch and answer this computer's agents from your phone, end-to-end encrypted through Vector's relay. The phone app is at ${PHONE_APP_ADDRESS}.`}
      >
        <Show
          when={remote && status()}
          fallback={<p class="settings-remote-muted">Remote is part of the Vector desktop app.</p>}
        >
          {(current) => (
            <div class="settings-v2-section-grid">
              <Card icon="link" title="On this computer" description={pairedCountLine(plan()) ?? undefined}>
                <ToggleRow
                  title="Vector Remote"
                  description="While it is on and a phone is paired, this computer keeps one encrypted connection to Vector's relay."
                  checked={current().enabled}
                  onChange={(value) => void act(() => remote!.setEnabled(value))}
                />
                <p
                  class="settings-remote-state"
                  classList={{ "settings-remote-state--problem": stateLine(current()).problem }}
                  role="status"
                >
                  {stateLine(current()).text}
                </p>
                <Show when={current().state === "revoked"}>
                  <ButtonV2
                    variant="outline"
                    disabled={busy()}
                    onClick={() => void act(() => remote!.disconnectAll(), "Remote started over on this computer.")}
                  >
                    Start over
                  </ButtonV2>
                </Show>
              </Card>

              <Card icon="share" title="Pair a phone" description="Pairing needs this computer and the phone side by side.">
                <Switch>
                  <Match when={pairing().state === "waiting"}>
                    <div class="settings-remote-pair" data-component="settings-remote-qr">
                      <Show when={qr()} fallback={<p class="settings-remote-muted">The code could not be drawn.</p>}>
                        {(code) => (
                          <svg
                            class="settings-remote-qr"
                            viewBox={`0 0 ${code().size} ${code().size}`}
                            role="img"
                            aria-label="Pairing code for Vector Remote"
                            shape-rendering="crispEdges"
                          >
                            <rect width={code().size} height={code().size} fill="#fff" />
                            <path d={code().d} fill="#000" />
                          </svg>
                        )}
                      </Show>
                      <ol class="settings-remote-steps">
                        <li>
                          On your phone, open {PHONE_APP_ADDRESS}. On iPhone, add it to your Home Screen and open it from
                          there.
                        </li>
                        <li>Sign in with the same Vector account, choose Devices, then Pair a computer.</li>
                        <li>Scan this code, then check that both screens show the same six digits.</li>
                      </ol>
                      <p class="settings-remote-muted">This code works for {minutesAndSeconds(left())}.</p>
                      <ButtonV2 variant="outline" disabled={busy()} onClick={() => void act(() => remote!.cancelPairing())}>
                        Cancel
                      </ButtonV2>
                    </div>
                  </Match>
                  <Match when={pairing().state === "confirm" && pairing()}>
                    {(waiting) => {
                      const confirm = waiting() as { code: string; phone: string }
                      return (
                        <div class="settings-remote-pair" data-component="settings-remote-confirm">
                          <p>
                            {confirm.phone} wants to pair. Check that it shows the same six digits:
                          </p>
                          <p class="settings-remote-code" aria-label="Pairing check code">
                            {spacedCode(confirm.code)}
                          </p>
                          <div class="settings-remote-actions">
                            <ButtonV2
                              variant="contrast"
                              disabled={busy()}
                              onClick={() => void act(() => remote!.confirmPairing(confirm.code))}
                            >
                              They match
                            </ButtonV2>
                            <ButtonV2
                              variant="outline"
                              disabled={busy()}
                              onClick={() =>
                                void act(
                                  () => remote!.cancelPairing(),
                                  "Pairing stopped. Start again if you still want to pair that phone.",
                                )
                              }
                            >
                              They don't match
                            </ButtonV2>
                          </div>
                        </div>
                      )
                    }}
                  </Match>
                  <Match when={true}>
                    <Show when={pairing().state === "paired"}>
                      <p class="settings-remote-muted">Paired with {(pairing() as { phone: string }).phone}.</p>
                    </Show>
                    <Show when={pairing().state === "failed"}>
                      <p class="settings-remote-error" role="alert">
                        {(pairing() as { message: string }).message}
                      </p>
                    </Show>
                    <ButtonV2
                      variant="contrast"
                      disabled={busy() || current().phones.length >= current().limit}
                      onClick={() => void act(async () => (await remote!.startPairing()).status)}
                    >
                      Pair a phone
                    </ButtonV2>
                    <Show when={current().phones.length >= current().limit}>
                      <p class="settings-remote-muted">
                        This computer has {current().limit} phones paired, the most it keeps. Remove one first.
                      </p>
                    </Show>
                  </Match>
                </Switch>
              </Card>

              <Card icon="user" title="Paired phones" wide>
                <Show
                  when={current().phones.length}
                  fallback={<p class="settings-remote-muted">No phone is paired with this computer.</p>}
                >
                  <ul class="settings-remote-phones">
                    <For each={current().phones}>
                      {(phone) => (
                        <li class="settings-remote-phone">
                          <div>
                            <strong>{phone.name}</strong>
                            <span class="settings-remote-muted">
                              {phoneLine(phone)} · paired {pairedSince(phone.pairedAt)}
                            </span>
                          </div>
                          <ButtonV2
                            variant="outline"
                            disabled={busy()}
                            onClick={() => void act(() => remote!.unpair(phone.device), `${phone.name} was removed.`)}
                          >
                            Remove
                          </ButtonV2>
                        </li>
                      )}
                    </For>
                  </ul>
                  <div class="settings-remote-actions">
                    <ButtonV2
                      variant="danger"
                      disabled={busy()}
                      onClick={() => {
                        if (!confirmAll()) return void setConfirmAll(true)
                        setConfirmAll(false)
                        void act(async () => {
                          const next = await remote!.disconnectAll()
                          setNotice(
                            next.killed
                              ? "Every phone was disconnected. Pair a phone again to use Remote."
                              : "This computer's phones were removed. Vector could not reach vectordev.ai to close the other connections; try again.",
                          )
                          return next
                        })
                      }}
                    >
                      {confirmAll() ? "Disconnect every phone now?" : "Disconnect all phones"}
                    </ButtonV2>
                  </div>
                  <p class="settings-remote-muted">
                    Disconnect all phones gives this computer new keys, so no phone paired before can reach it, and
                    closes every Remote connection on your account.
                  </p>
                </Show>
              </Card>
            </div>
          )}
        </Show>
        <Show when={notice()}>
          <p class="settings-remote-muted" role="status">
            {notice()}
          </p>
        </Show>
        <Show when={problem()}>
          <p class="settings-remote-error" role="alert">
            {problem()}
          </p>
        </Show>
      </Page>
    </div>
  )
}
