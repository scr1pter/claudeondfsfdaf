import { For, Show, onCleanup, onMount } from "solid-js"
import { createStore } from "solid-js/store"
import { Hands } from "@vectordevai/schema/hands"
import type { PublicSession } from "@vectordevai/schema/public-session"
import { ContentMarkdown } from "./share/content-markdown"
import { readSnapshot, shareID } from "./share/snapshot"
import "./share/public-share.css"

export default function Share() {
  const [state, setState] = createStore<{
    snapshot?: PublicSession.Snapshot
    status: string
    unavailable: boolean
    copied: boolean
  }>({
    status: "Loading public session…",
    unavailable: false,
    copied: false,
  })
  onMount(() => {
    const id = shareID(window.location.pathname)
    if (!id) {
      setState({ unavailable: true, status: "This public session link is invalid." })
      return
    }
    const lifetime = new AbortController()
    let poll: ReturnType<typeof setTimeout> | undefined
    let expiry: ReturnType<typeof setTimeout> | undefined
    let busy = false
    const unavailable = () => {
      lifetime.abort()
      clearTimeout(poll)
      clearTimeout(expiry)
      setState({
        snapshot: undefined,
        unavailable: true,
        status: "This public session has expired or is no longer shared.",
      })
    }
    const checkExpiry = () => {
      if (!state.snapshot || lifetime.signal.aborted) return
      const remaining = state.snapshot.expiresAt - Date.now()
      if (remaining <= 0) return unavailable()
      // Timers can fire just before their deadline, and refresh may be in flight.
      expiry = setTimeout(checkExpiry, Math.min(remaining, 86_400_000))
    }
    const refresh = async () => {
      if (state.snapshot && state.snapshot.expiresAt <= Date.now()) return unavailable()
      if (busy || lifetime.signal.aborted || state.unavailable) return
      busy = true
      const result = await readSnapshot(id, lifetime.signal).then(
        (snapshot) => ({ snapshot }),
        () => ({ error: true as const }),
      )
      busy = false
      if (lifetime.signal.aborted) return
      if ("error" in result) {
        setState(
          "status",
          state.snapshot
            ? "Connection interrupted. Showing the last checked copy; it may have changed or been removed."
            : "The public copy could not be loaded. Retrying shortly…",
        )
      } else {
        const latest = result.snapshot
        if (!latest) return unavailable()
        if (!state.snapshot || latest.revision > state.snapshot.revision) setState({ snapshot: latest })
        if (latest.revision === state.snapshot?.revision) {
          // The same revision carries the same transcript, so only its details are merged. Replacing the snapshot
          // would rebuild every message and close any step a reader has opened, along with its screenshots.
          setState("snapshot", { expiresAt: latest.expiresAt, updatedAt: latest.updatedAt, updates: latest.updates })
          setState("status", "")
          clearTimeout(expiry)
          checkExpiry()
        }
      }
      clearTimeout(poll)
      // Check revocation even for a one-time snapshot; never persist the transcript locally.
      poll = setTimeout(() => {
        if (!document.hidden) void refresh()
      }, 15_000)
    }
    const visible = () => {
      if (!document.hidden) void refresh()
    }
    document.addEventListener("visibilitychange", visible)
    void refresh()
    onCleanup(() => {
      lifetime.abort()
      clearTimeout(poll)
      clearTimeout(expiry)
      document.removeEventListener("visibilitychange", visible)
    })
  })

  return (
    <main class="public-session">
      <nav>
        <a href="https://vectordev.ai" aria-label="Vector home">
          VECTOR
        </a>
        <span>Public session</span>
      </nav>
      <Show when={state.status}>
        <p role="status" class="public-notice">
          {state.status}
        </p>
      </Show>
      <Show when={state.snapshot} keyed>
        {(snapshot) => (
          <>
            <header>
              <p class="public-eyebrow">Shared with anyone who has the link</p>
              <h1>{snapshot.archive.title || "Untitled session"}</h1>
              <p>
                This is a read-only transcript. Conversation text, reasoning, code, and tool input or output may contain
                sensitive information. Attachments are descriptions only; no files or images are fetched.
              </p>
              <Show
                when={snapshot.archive.messages.some((message) =>
                  message.parts.some((part) => part.type === "tool" && part.screenshots?.length),
                )}
              >
                <p>
                  The person who shared this chose to include screenshots from {Hands.NAME}; they can show other things
                  that were on that screen.
                </p>
              </Show>
              <p>
                {snapshot.updates
                  ? "Future conversation updates are public and checked periodically."
                  : "This is a one-time snapshot; future conversation updates are not included."}
              </p>
              <p class="public-meta">
                Updated {new Date(snapshot.updatedAt).toLocaleString()} · Expires{" "}
                {new Date(snapshot.expiresAt).toLocaleString()} · {snapshot.archive.messages.length} messages
              </p>
              <button
                onClick={() =>
                  void navigator.clipboard.writeText(snapshot.url).then(
                    () => setState("copied", true),
                    () => setState("status", "Could not copy the link. Copy it from your address bar."),
                  )
                }
              >
                {state.copied ? "Link copied" : "Copy public link"}
              </button>
            </header>
            <section aria-label="Shared transcript">
              <For each={snapshot.archive.messages}>
                {(message, index) => (
                  <article id={`message-${index() + 1}`} class="public-message">
                    <div class="public-message-heading">
                      <h2>{message.role}</h2>
                      <a href={`#message-${index() + 1}`}>#{index() + 1}</a>
                      <time>{new Date(message.createdAt).toLocaleString()}</time>
                    </div>
                    <For each={message.parts}>{(part) => <TranscriptPart part={part} />}</For>
                  </article>
                )}
              </For>
              <Show when={snapshot.archive.messages.length === 0}>
                <p>No visible messages in this snapshot.</p>
              </Show>
            </section>
            <footer>
              Unsharing removes Vector’s public copy. People who already saw this session may have saved their own
              copies.
            </footer>
          </>
        )}
      </Show>
    </main>
  )
}

function TranscriptPart(props: { part: PublicSession.Part }) {
  const part = props.part
  if (part.type === "text") return <ContentMarkdown text={part.text} expand />
  if (part.type === "reasoning")
    return (
      <details>
        <summary>Reasoning</summary>
        <ContentMarkdown text={part.text} expand />
      </details>
    )
  if (part.type === "attachment")
    return (
      <p class="public-attachment">
        Attachment: {part.name} ({part.mediaType}) — description only
      </p>
    )
  // Only a completed computer step can carry screenshots: embedded PNG, JPEG or WebP data the snapshot schema has
  // already checked, so nothing is fetched. They stay inside the closed step until someone opens it.
  const screenshots = part.screenshots ?? []
  return (
    <details class="public-tool">
      <summary>
        {part.name} · {part.status}
        {screenshots.length
          ? ` · ${screenshots.length} ${screenshots.length === 1 ? "screenshot" : "screenshots"}`
          : ""}
      </summary>
      <Show when={screenshots.length}>
        <h3>Screenshots</h3>
        <div class="public-screenshots">
          <For each={screenshots}>
            {(shot, index) => (
              <img
                src={shot.url}
                alt={`Screenshot ${index() + 1} from ${Hands.NAME}`}
                loading="lazy"
                decoding="async"
              />
            )}
          </For>
        </div>
      </Show>
      <h3>Input</h3>
      <pre>{part.input}</pre>
      <h3>Output</h3>
      <pre>{part.output}</pre>
    </details>
  )
}
