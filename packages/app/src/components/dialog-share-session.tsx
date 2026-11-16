import { For, Show, onCleanup, onMount } from "solid-js"
import { createStore } from "solid-js/store"
import { Schema } from "effect"
import { Hands } from "@vectordevai/schema/hands"
import { PublicSession } from "@vectordevai/schema/public-session"
import { Button } from "@vectordevai/ui/button"
import { Checkbox } from "@vectordevai/ui/checkbox"
import { Dialog } from "@vectordevai/ui/dialog"
import { useDialog } from "@vectordevai/ui/context/dialog"
import { useLanguage } from "@/context/language"
import { useSDK } from "@/context/sdk"
import { usePlatform } from "@/context/platform"
import { OffInLocal } from "@/features/local/off-in-local"

export function DialogShareSession(props: { sessionID: string }) {
  const client = useSDK()().client
  const platform = usePlatform()
  const dialog = useDialog()
  const language = useLanguage()
  const t = (key: Parameters<typeof language.t>[0]) => language.t(key, { name: Hands.NAME })
  const [state, setState] = createStore<{
    preview?: PublicSession.Archive
    previewHash?: string
    // The screenshot choice the reviewed preview and its hash were captured with; publish sends this one.
    previewScreenshots: boolean
    tooLarge: boolean
    screenshots: boolean
    info?: PublicSession.Info
    busy: boolean
    loading: boolean
    acknowledged: boolean
    updates: boolean
    remember: boolean
    days: number
    error: string
    status: string
    confirmUnshare: boolean
  }>({
    previewScreenshots: false,
    tooLarge: false,
    // Screenshot consent belongs to one publication: every dialog starts with it off.
    screenshots: false,
    busy: false,
    loading: true,
    acknowledged: false,
    updates: false,
    remember: false,
    days: 7,
    error: "",
    status: "",
    confirmUnshare: false,
  })
  let alive = true
  let generation = 0
  // The size of the newest screenshot-free review. Screenshots explain a refusal only when that copy fits the limit;
  // otherwise unticking cannot help and the engine's own message applies.
  let textBytes = 0
  onCleanup(() => {
    alive = false
  })
  const refresh = () => {
    // Only the newest request may set the reviewed preview, and loading lasts until its hash is stored, so the
    // review, its hash and the screenshot choice sent with them always belong to one preview.
    const current = ++generation
    const screenshots = state.screenshots
    const latest = () => alive && current === generation
    setState({ loading: true, acknowledged: false, previewHash: undefined, tooLarge: false, error: "" })
    void Promise.allSettled([
      client.session.sharePreview(
        { sessionID: props.sessionID, ...(screenshots ? { includeScreenshots: "true" as const } : {}) },
        { throwOnError: true },
      ),
      client.session.get({ sessionID: props.sessionID }, { throwOnError: true }),
    ])
      .then(async ([preview, session]) => {
        if (!latest()) return
        const info = session.status === "fulfilled" ? session.value.data?.share : undefined
        setState({ info: Schema.is(PublicSession.Info)(info) ? info : undefined })
        if (preview.status === "fulfilled") {
          const archive = Schema.decodeUnknownSync(PublicSession.Archive)(preview.value.data)
          if (typeof crypto === "undefined" || !crypto.subtle)
            throw new Error("Use the Vector desktop app or a secure connection to verify and publish this preview.")
          const body = new TextEncoder().encode(JSON.stringify(preview.value.data))
          const digest = await crypto.subtle.digest("SHA-256", body)
          if (!latest()) return
          if (!screenshots) textBytes = body.byteLength
          setState({
            preview: archive,
            previewHash: Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join(""),
            previewScreenshots: screenshots,
            // The engine also refuses a larger archive; without screenshots its own message stays accurate.
            tooLarge: screenshots && body.byteLength > PublicSession.MAX_BYTES && textBytes <= PublicSession.MAX_BYTES,
          })
        }
        // The engine refuses an opted-in review too large to publish rather than sending every screenshot.
        if (preview.status === "rejected")
          setState(
            screenshots && shareCode(preview.reason) === "TOO_LARGE" && textBytes <= PublicSession.MAX_BYTES
              ? { tooLarge: true }
              : { error: shareError(preview.reason) },
          )
        if (session.status === "rejected") setState("error", shareError(session.reason))
        setState("loading", false)
      })
      .catch((error) => {
        if (latest()) setState({ loading: false, error: shareError(error) })
      })
  }
  onMount(refresh)
  const publish = async () => {
    if (!state.preview || !state.previewHash || state.loading || !state.acknowledged || state.busy || state.tooLarge)
      return
    setState({ busy: true, error: "", status: "" })
    await client.session
      .share(
        {
          sessionID: props.sessionID,
          publicSessionPublish: {
            consent: { version: 1, public: true, updates: state.updates },
            expiresAt: Date.now() + state.days * 86_400_000,
            remember: state.updates && state.remember,
            previewHash: state.previewHash,
            includeScreenshots: state.previewScreenshots,
          },
        },
        { throwOnError: true },
      )
      .then((result) => {
        if (alive)
          setState({
            info: Schema.decodeUnknownSync(PublicSession.Info)(result.data),
            acknowledged: false,
            status: "Public copy created.",
          })
      })
      .catch((error) => {
        if (alive) setState("error", shareError(error))
      })
    if (alive) setState("busy", false)
  }
  const unshare = async () => {
    if (!state.confirmUnshare || state.busy) return
    setState({ busy: true, error: "", status: "" })
    await client.session
      .unshare({ sessionID: props.sessionID }, { throwOnError: true })
      .then(() => {
        if (!alive) return
        setState({
          info: undefined,
          confirmUnshare: false,
          acknowledged: false,
          screenshots: false,
          status: "Public copy removed. The local session is unchanged.",
        })
        // A new publication makes its own screenshot choice, so the opted-in review is not reused.
        if (state.previewScreenshots) refresh()
      })
      .catch((error) => {
        if (alive) setState("error", `${shareError(error)} Your public link is retained so you can retry.`)
      })
    if (alive) setState("busy", false)
  }
  const previewText = () =>
    state.preview?.messages
      .map(
        (message) =>
          `${message.role.toUpperCase()}\n${message.parts
            .map((part) => {
              if (part.type === "attachment") return `Attachment: ${part.name} (${part.mediaType}) — description only`
              if (part.type === "tool")
                return [
                  `${part.name} (${part.status})\nInput:\n${part.input}\nOutput:\n${part.output}`,
                  ...(part.screenshots ?? []).map(
                    (shot) => `Screenshot: ${shot.name} (${shot.mediaType}) — published as an image`,
                  ),
                ].join("\n")
              return `${part.type === "reasoning" ? "Reasoning:\n" : ""}${part.text}`
            })
            .join("\n\n")}`,
      )
      .join("\n\n———\n\n") ?? ""
  // Only a transcript with completed Hands steps can carry screenshots, so other sessions never show the choice.
  const computer = () =>
    state.preview?.messages.some((message) =>
      message.parts.some((part) => part.type === "tool" && part.name === "computer" && part.status === "completed"),
    ) ?? false

  return (
    <Dialog title="Share session publicly" fit>
      <div
        class="flex flex-col gap-4 px-6 pb-5 max-w-[640px] max-h-[75vh] overflow-auto"
        data-component="share-session-dialog"
      >
        <p class="text-14-regular">
          Anyone with the link can read and save the public copy. It includes conversation text, reasoning, code, and
          visible tool input and output, which may contain secrets. Attachments are descriptions only; files are not
          uploaded or fetched.
        </p>
        <OffInLocal source="share" />
        <p class="text-12-regular text-text-weak">
          Publishing uses your Vector account. Sign in through Vector account settings, or run <code>vector login</code>{" "}
          on the connected server.
        </p>
        <Show when={state.loading}>
          <p role="status">Preparing the full visible transcript…</p>
        </Show>
        <Button variant="ghost" disabled={state.busy || state.loading} onClick={refresh}>
          Refresh included transcript
        </Button>
        <Show when={state.preview} keyed>
          {(preview) => (
            <details>
              <summary class="cursor-pointer">Review included transcript ({preview.messages.length} messages)</summary>
              <p class="text-12-regular text-text-weak">
                {preview.title}. Hidden system context and credentials are excluded. Text and tool output are not
                guaranteed to be free of sensitive data.
              </p>
              <textarea
                aria-label="Included transcript"
                readOnly
                value={previewText()}
                class="w-full h-52 rounded border border-border-base p-2 text-12-regular font-mono select-text"
              />
            </details>
          )}
        </Show>
        <Show
          when={state.info}
          fallback={
            <>
              <label class="flex items-center gap-3">
                Expires after
                <select
                  aria-label="Public copy expiry"
                  value={state.days}
                  disabled={state.busy}
                  onChange={(event) => setState("days", Number(event.currentTarget.value))}
                  class="rounded border border-border-base p-2"
                >
                  <For each={[1, 7, 30]}>
                    {(days) => (
                      <option value={days}>
                        {days} {days === 1 ? "day" : "days"}
                      </option>
                    )}
                  </For>
                </select>
              </label>
              <Checkbox
                checked={state.updates}
                disabled={state.busy}
                onChange={(value) => setState({ updates: value, remember: value && state.remember })}
              >
                Include future updates to this conversation until expiry
              </Checkbox>
              <Checkbox
                checked={state.remember}
                disabled={state.busy || !state.updates}
                onChange={(value) => setState("remember", state.updates && value)}
              >
                Also allow automatic public sharing of future sessions on this Vector account
              </Checkbox>
              <Show when={!state.updates}>
                <p class="text-12-regular text-text-weak">
                  Automatic sharing of future sessions requires future updates.
                </p>
              </Show>
              <Show when={state.remember}>
                <p class="text-12-regular text-text-weak">
                  This is account-wide consent for future sessions when automatic sharing is enabled, including
                  sensitive text they may contain. It does not publish existing sessions.
                </p>
                <p class="text-12-regular text-text-weak">{t("computer.share.automatic")}</p>
              </Show>
              <Show when={computer()}>
                <Checkbox
                  checked={state.screenshots}
                  disabled={state.busy || state.loading}
                  description={t("computer.share.help")}
                  onChange={(value) => {
                    setState("screenshots", value)
                    refresh()
                  }}
                >
                  {t("computer.share.includeScreenshots")}
                </Checkbox>
                <Show when={state.screenshots}>
                  <p class="text-12-regular text-text-weak">{t("computer.share.description")}</p>
                </Show>
              </Show>
              <Show when={state.tooLarge}>
                <p role="alert" class="text-12-regular text-text-danger-base">
                  Screenshots make this public copy larger than {PublicSession.MAX_BYTES / 1_000_000} MB. Untick “
                  {t("computer.share.includeScreenshots")}” to publish without them.
                </p>
              </Show>
              <Checkbox
                checked={state.acknowledged}
                disabled={state.busy || state.loading || !state.previewHash || state.tooLarge}
                onChange={(value) => setState("acknowledged", value)}
              >
                I have reviewed the included content and want to make it public
              </Checkbox>
            </>
          }
          keyed
        >
          {(info) => (
            <div class="flex flex-col gap-3">
              <p class="text-14-regular">
                Public until {new Date(info.expiresAt).toLocaleString()}.{" "}
                {info.updates ? "Future updates are public." : "One-time snapshot; future updates are not included."}
              </p>
              <code class="break-all select-text text-12-regular" data-public-share-url>
                {info.url}
              </code>
              <Button
                variant="secondary"
                onClick={() =>
                  void navigator.clipboard.writeText(info.url).then(
                    () => setState("status", "Public link copied."),
                    () => setState("error", "Could not copy the link. Select and copy it above."),
                  )
                }
              >
                Copy public link
              </Button>
              <p class="text-12-regular text-text-weak">
                Unsharing removes Vector’s public copy. People who have already seen it may have saved their own copies.
              </p>
              <Checkbox
                checked={state.confirmUnshare}
                disabled={state.busy}
                onChange={(value) => setState("confirmUnshare", value)}
              >
                Remove this public copy
              </Checkbox>
            </div>
          )}
        </Show>
        <Show when={state.error}>
          <p role="alert" class="text-14-regular text-text-danger-base">
            {state.error}
          </p>
        </Show>
        <Show when={state.status}>
          <p role="status" class="text-14-regular">
            {state.status}
          </p>
        </Show>
        <div class="flex justify-end gap-2">
          <Button variant="ghost" disabled={state.busy} onClick={() => dialog.close()}>
            {state.info ? "Done" : "Cancel"}
          </Button>
          <Show
            when={state.info}
            fallback={
              <Button
                variant="primary"
                disabled={state.busy || state.loading || !state.acknowledged || !state.previewHash || state.tooLarge}
                onClick={() => void publish()}
              >
                {state.busy ? "Publishing…" : "Publish public copy"}
              </Button>
            }
          >
            <Button variant="primary" disabled={state.busy || !state.confirmUnshare} onClick={() => void unshare()}>
              {state.busy ? "Removing…" : "Unshare"}
            </Button>
          </Show>
        </div>
        <Show when={state.error && platform.vectorAccount}>
          <Button
            variant="secondary"
            disabled={state.busy}
            onClick={() => {
              setState("acknowledged", false)
              void platform.vectorAccount?.start().then(
                () => setState("status", "Complete Vector sign-in, then review and publish again."),
                (error) => setState("error", shareError(error)),
              )
            }}
          >
            Sign in to Vector
          </Button>
        </Show>
      </div>
    </Dialog>
  )
}

function shareCode(error: unknown): unknown {
  if (typeof error !== "object" || error === null) return
  if ("code" in error) return error.code
  if ("data" in error) return shareCode(error.data)
  if ("error" in error) return shareCode(error.error)
}

function shareError(error: unknown): string {
  if (typeof error === "object" && error !== null) {
    if ("code" in error && error.code === "SIGN_IN_REQUIRED")
      return "Sign in to your Vector account, then review and publish again."
    if ("message" in error && typeof error.message === "string") return error.message
    if ("data" in error) return shareError(error.data)
    if ("error" in error) return shareError(error.error)
  }
  return "Sharing could not be completed. Try again shortly."
}
