import { createSignal, Match, onCleanup, onMount, Show, Switch } from "solid-js"
import { phonePath } from "../config"
import { canPair } from "../environment"
import { pairingLinkFromLocation, spacedCode } from "../remote/model"
import { ScannerError, startScanner } from "../remote/scanner"
import { InstallCard, Notice, Panel, type RouteProps } from "./parts"
import { ConnectionNotice, useRemoteView } from "./remote-parts"

// Pairing this phone with a computer (WP A42). The computer shows a QR code in Vector's Settings → Remote; this page
// scans it with the camera (or takes the link pasted), waits for that computer on the relay, makes a passkey for it on
// the person's tap, and shows the six digits the computer shows so the person can confirm they match there. On iPhone
// the installed app keeps its keys apart from Safari, so a Safari tab only explains how to finish in the app.

export function PairRoute(props: RouteProps) {
  const view = useRemoteView(props.remote)
  const [link] = createSignal(pairingLinkFromLocation(location))
  const [pasted, setPasted] = createSignal("")
  const [scanning, setScanning] = createSignal(false)
  const [problem, setProblem] = createSignal<string>()
  const [copied, setCopied] = createSignal(false)
  let video: HTMLVideoElement | undefined
  let stop: (() => void) | undefined

  const prefix = `${location.origin}${phonePath("pair")}#`
  const begin = async (text: string) => {
    stopScan()
    setProblem(undefined)
    await props.remote.startPairing(text)
  }

  const stopScan = () => {
    stop?.()
    stop = undefined
    setScanning(false)
  }

  const scan = async () => {
    setProblem(undefined)
    setScanning(true)
    // The video element mounts with `scanning`.
    await Promise.resolve()
    if (!video) return
    try {
      stop = await startScanner(video, (text) => {
        if (!text.startsWith(prefix)) return false
        void begin(text)
        return true
      })
    } catch (error) {
      setScanning(false)
      setProblem(
        error instanceof ScannerError && error.problem === "denied"
          ? "Vector cannot use the camera. Allow it in this phone's settings, or paste the link instead."
          : "The camera is not available here. Paste the link instead.",
      )
    }
  }

  onMount(() => {
    // The offer is in the address's fragment; it is read once and taken out of the address and its history.
    if (link() && canPair(props.environment)) {
      history.replaceState(null, "", phonePath("pair"))
      void begin(link()!)
    }
  })
  onCleanup(stopScan)

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(link()!)
      setCopied(true)
    } catch {
      setProblem("This browser would not copy the link.")
    }
  }

  const restart = () => {
    props.remote.cancelPairing()
    setPasted("")
  }

  const pairing = () => view().pairing
  const name = () => {
    const current = pairing()
    return ("name" in current && current.name) || "your computer"
  }

  return (
    <Panel title="Pair a computer">
      <Show
        when={canPair(props.environment)}
        fallback={
          <>
            <InstallCard
              environment={props.environment}
              reason="On iPhone and iPad, pairing happens inside the installed app, which keeps its own keys apart from Safari."
            />
            <Show when={link()}>
              <p>Copy this pairing link, open Vector from your Home Screen, choose Devices, then Pair a computer, and paste it.</p>
              <button type="button" class="phone-button" onClick={copy}>
                {copied() ? "Copied" : "Copy the pairing link"}
              </button>
            </Show>
          </>
        }
      >
        <ConnectionNotice remote={props.remote} view={view()} />
        <Switch>
          <Match when={pairing().state === "idle" || pairing().state === "paired" || pairing().state === "failed"}>
            <Show when={pairing().state === "paired"}>
              <p>Paired with {(pairing() as { name: string }).name}.</p>
              <button type="button" class="phone-button" onClick={() => props.navigate(phonePath("sessions"))}>
                Open sessions
              </button>
            </Show>
            <Show when={pairing().state === "failed"}>
              <Notice text={(pairing() as { message: string }).message} />
            </Show>
            <Show when={pairing().state !== "paired"}>
              <p>
                On your computer, open Vector's Settings, then Remote, and choose Pair a phone. Scan the code it shows.
              </p>
              <Show
                when={scanning()}
                fallback={
                  <button type="button" class="phone-button" onClick={scan}>
                    Scan the code
                  </button>
                }
              >
                <video ref={video} class="phone-scanner" muted playsinline autoplay />
                <button type="button" class="phone-button phone-button--quiet" onClick={stopScan}>
                  Stop scanning
                </button>
              </Show>
              <form
                class="phone-form"
                method="post"
                onSubmit={(event) => {
                  event.preventDefault()
                  if (pasted().trim()) void begin(pasted())
                }}
              >
                <label>
                  Or paste the pairing link
                  <input
                    type="url"
                    autocomplete="off"
                    value={pasted()}
                    onInput={(event) => setPasted(event.currentTarget.value)}
                  />
                </label>
                <button type="submit" class="phone-button phone-button--quiet" disabled={!pasted().trim()}>
                  Use this link
                </button>
              </form>
            </Show>
          </Match>
          <Match when={pairing().state === "connecting"}>
            <p>Waiting for {name()} to connect. Keep Vector open on it with the code showing.</p>
            <button type="button" class="phone-button phone-button--quiet" onClick={restart}>
              Cancel
            </button>
          </Match>
          <Match when={pairing().state === "ready"}>
            <p>
              Pair this phone with {name()}. Your phone makes a passkey for it; you use that passkey each time you allow
              a request once from here.
            </p>
            <button type="button" class="phone-button" onClick={() => void props.remote.pair()}>
              Make a passkey and pair
            </button>
            <Notice text={(pairing() as { message?: string }).message} />
            <button type="button" class="phone-button phone-button--quiet" onClick={restart}>
              Cancel
            </button>
          </Match>
          <Match when={pairing().state === "sent"}>
            <p>Waiting for {name()}…</p>
          </Match>
          <Match when={pairing().state === "confirm"}>
            <p>Check that {name()} shows these six digits, then confirm on the computer.</p>
            <p class="phone-code" aria-label="Pairing check code">
              {spacedCode((pairing() as { code: string }).code)}
            </p>
            <p class="phone-meta">If the digits are different, cancel on the computer: someone else may have seen its code.</p>
          </Match>
        </Switch>
        <Notice text={problem()} />
      </Show>
    </Panel>
  )
}
