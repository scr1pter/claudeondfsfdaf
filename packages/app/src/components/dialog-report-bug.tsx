import { createEffect, createSignal, on, Show } from "solid-js"

type ReportBugApi = {
  reportBug?: (input: {
    message: string
    email?: string
  }) => Promise<{ delivered: boolean; tracked?: boolean; error?: string }>
}

// Desktop routes through the main process; the web build has no window.api and
// can reach the endpoint directly since it is served from the same origin.
async function submitReport(input: {
  message: string
  email?: string
}): Promise<{ delivered: boolean; tracked?: boolean; error?: string }> {
  const api = (globalThis.window as unknown as { api?: ReportBugApi } | undefined)?.api
  if (api?.reportBug)
    return api.reportBug(input).catch(() => ({ delivered: false, error: "Vector could not reach the report service." }))

  const response = await fetch("/api/support/bug-report", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
    redirect: "error",
    signal: AbortSignal.timeout(20_000),
  }).catch(() => undefined)
  if (!response) return { delivered: false, error: "Vector could not reach the report service." }
  if (!response.ok) {
    const body = (await response.json().catch(() => undefined)) as { error?: { message?: string } } | undefined
    return { delivered: false, error: body?.error?.message ?? "The report could not be delivered." }
  }
  const body: unknown = await response.json().catch(() => undefined)
  return body && typeof body === "object" && "delivered" in body && body.delivered === true
    ? { delivered: true }
    : { delivered: false, error: "Vector could not confirm report delivery. Your draft is still here." }
}

export function DialogReportBug(props: { open: boolean; onClose: () => void; initialMessage?: string }) {
  const [message, setMessage] = createSignal("")
  const [email, setEmail] = createSignal("")
  const [sending, setSending] = createSignal(false)
  const [error, setError] = createSignal<string>()
  const [sent, setSent] = createSignal(false)
  // The desktop keeps the report's id, so Settings > Account can show what becomes of it (WP A33).
  const [tracked, setTracked] = createSignal(false)

  createEffect(
    on(
      () => props.open,
      (open) => {
        if (!open) return
        setMessage((props.initialMessage ?? "").slice(0, 8_000))
        setError(undefined)
        setSent(false)
        setTracked(false)
      },
    ),
  )

  const close = () => {
    if (sending()) return
    setMessage("")
    setEmail("")
    setError(undefined)
    setSent(false)
    props.onClose()
  }

  const send = async () => {
    if (!message().trim() || message().length > 8_000 || sending()) return
    setSending(true)
    setError(undefined)
    const result = await submitReport({ message: message().trim(), email: email().trim() || undefined })
    setSending(false)
    if (!result.delivered) {
      setError(result.error ?? "The report could not be delivered.")
      return
    }
    setTracked(result.tracked === true)
    setSent(true)
  }

  return (
    <Show when={props.open}>
      <div
        class="fixed inset-0 z-[100] grid place-items-center bg-black/55 backdrop-blur-sm"
        role="presentation"
        onClick={(event) => {
          if (event.target === event.currentTarget) close()
        }}
      >
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Report a bug"
          class="w-[520px] max-w-[calc(100vw-32px)] rounded-xl border border-[color:var(--vx-line)] bg-[color:var(--vx-surface)] p-5 shadow-2xl"
          onKeyDown={(event) => {
            if (event.key === "Escape") close()
          }}
        >
          <Show
            when={!sent()}
            fallback={
              <div class="flex flex-col gap-3">
                <h2 class="text-[15px] font-semibold text-white">Thanks — report sent</h2>
                <p class="text-[12.5px] text-white/60">
                  Your report reached the Vector team. If you left an email, we may reply there.
                </p>
                <Show when={tracked()}>
                  <p class="text-[12.5px] text-white/60">Settings &gt; Account shows what becomes of it.</p>
                </Show>
                <button
                  type="button"
                  class="self-end rounded-[6px] bg-[color:var(--vx-purple)] px-3 py-1.5 text-[12.5px] font-medium text-white"
                  onClick={close}
                >
                  Close
                </button>
              </div>
            }
          >
            <div class="flex flex-col gap-3">
              <h2 class="text-[15px] font-semibold text-white">Report a bug</h2>
              <p class="text-[12.5px] text-white/55">
                Review the report and remove private details before sending. The desktop app adds its version and
                platform.
              </p>
              <textarea
                autofocus
                rows={7}
                aria-label="Bug report"
                maxLength={8_000}
                value={message()}
                placeholder="What happened? What did you expect instead?"
                class="w-full resize-none rounded-[6px] border border-[color:var(--vx-line)] bg-[color:var(--vx-canvas)] p-2.5 text-[12.5px] text-white outline-none placeholder:text-white/28 focus:border-[color:var(--vx-purple)]"
                onInput={(event) => setMessage(event.currentTarget.value)}
              />
              <input
                type="email"
                aria-label="Reply email (optional)"
                maxLength={320}
                value={email()}
                placeholder="Your email (optional, so we can reply)"
                class="w-full rounded-[6px] border border-[color:var(--vx-line)] bg-[color:var(--vx-canvas)] px-2.5 py-1.5 text-[12.5px] text-white outline-none placeholder:text-white/28 focus:border-[color:var(--vx-purple)]"
                onInput={(event) => setEmail(event.currentTarget.value)}
              />
              <Show when={error()}>
                <p class="text-[12px] text-rose-300">{error()}</p>
              </Show>
              <div class="flex justify-end gap-2">
                <button
                  type="button"
                  class="rounded-[6px] px-3 py-1.5 text-[12.5px] text-white/60 hover:text-white"
                  onClick={close}
                  disabled={sending()}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  disabled={!message().trim() || message().length > 8_000 || sending()}
                  class="rounded-[6px] bg-[color:var(--vx-purple)] px-3 py-1.5 text-[12.5px] font-medium text-white disabled:opacity-50"
                  onClick={() => void send()}
                >
                  {sending() ? "Sending…" : "Report"}
                </button>
              </div>
            </div>
          </Show>
        </div>
      </div>
    </Show>
  )
}
