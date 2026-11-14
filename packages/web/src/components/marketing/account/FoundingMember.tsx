/** @jsxImportSource react */
import React from "react"
import { readAccountApiResponse } from "../../../lib/account-client"

/** What `/api/account/founding` answers for a current founding member (WP A31). */
export type FoundingView = { member: true; number: number; listed: boolean; name?: string; page: string }

const NAME = /^[\p{L}\p{N}][\p{L}\p{N} .'_-]{0,39}$/u

/** The account's founding membership as the API answers it, or undefined for anything else. */
export function readFoundingView(value: unknown): FoundingView | undefined {
  if (!value || typeof value !== "object") return undefined
  const view = value as Record<string, unknown>
  if (
    view.member !== true ||
    typeof view.number !== "number" ||
    !Number.isSafeInteger(view.number) ||
    view.number < 1 ||
    typeof view.listed !== "boolean" ||
    typeof view.page !== "string" ||
    !/^https:\/\/[^\s#]+\/founders#[A-Za-z0-9_-]{22}$/.test(view.page) ||
    (view.name !== undefined && (typeof view.name !== "string" || !NAME.test(view.name)))
  )
    return undefined
  return {
    member: true,
    number: view.number,
    listed: view.listed,
    ...(typeof view.name === "string" ? { name: view.name } : {}),
    page: view.page,
  }
}

/**
 * The account page's founding block: the number, the price lock, and the opt-in for the founders page with an optional
 * display name. Shown only for an account the status names as a founding member; the server decides everything here.
 */
export function FoundingMember(props: { accessToken: string; number: number }) {
  const [view, setView] = React.useState<FoundingView>()
  const [listed, setListed] = React.useState(false)
  const [name, setName] = React.useState("")
  const [saving, setSaving] = React.useState(false)
  const [message, setMessage] = React.useState("")

  React.useEffect(() => {
    const controller = new AbortController()
    void fetch("/api/account/founding", {
      headers: { accept: "application/json", authorization: `Bearer ${props.accessToken}` },
      cache: "no-store",
      signal: controller.signal,
    })
      .then((response) => readAccountApiResponse(response, "Vector could not load your founding membership."))
      .then((value) => {
        const read = readFoundingView(value)
        if (controller.signal.aborted || !read) return
        setView(read)
        setListed(read.listed)
        setName(read.name ?? "")
      })
      .catch(() => undefined)
    return () => controller.abort()
  }, [props.accessToken])

  const save = (event: React.FormEvent) => {
    event.preventDefault()
    const trimmed = name.trim()
    if (trimmed && !NAME.test(trimmed)) {
      setMessage("Use up to 40 letters, numbers, spaces, dots or dashes.")
      return
    }
    setSaving(true)
    setMessage("")
    void fetch("/api/account/founding", {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        authorization: `Bearer ${props.accessToken}`,
      },
      body: JSON.stringify({ listed, ...(trimmed ? { name: trimmed } : {}) }),
    })
      .then((response) => readAccountApiResponse(response, "Vector could not save your choice. Try again."))
      .then((value) => {
        const read = readFoundingView(value)
        if (!read) throw new Error("Vector could not save your choice. Try again.")
        setView(read)
        setMessage(read.listed ? "You're listed on the founders page." : "You're not listed on the founders page.")
      })
      .catch((cause) => setMessage(cause instanceof Error ? cause.message : "Vector could not save your choice."))
      .finally(() => setSaving(false))
  }

  return (
    <div className="model-plans-founding" id="founding">
      <h3>Founding member #{props.number}</h3>
      <p>Your price won't go up while you stay subscribed.</p>
      {view && (
        <form onSubmit={save}>
          <label className="model-plans-founding-choice">
            <input type="checkbox" checked={listed} onChange={(event) => setListed(event.target.checked)} />
            List me on the founders page
          </label>
          {listed && (
            <label>
              Name to show (optional)
              <input
                type="text"
                value={name}
                maxLength={40}
                autoComplete="off"
                onChange={(event) => setName(event.target.value)}
              />
            </label>
          )}
          <button className="acct-button acct-button-secondary" type="submit" disabled={saving}>
            {saving ? "Saving…" : "Save"}
          </button>
          {view.listed && (
            <a href={view.page} rel="noopener">
              Open the founders page
            </a>
          )}
          {message && <p role="status">{message}</p>}
        </form>
      )}
    </div>
  )
}
