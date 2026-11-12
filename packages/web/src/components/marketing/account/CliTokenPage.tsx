/** @jsxImportSource react */
import { Check, Copy, LoaderCircle, RefreshCw, TerminalSquare } from "lucide-react"
import { useEffect, useState } from "react"
import { readAccountApiResponse, vectorAccountClient } from "../../../lib/account-client"
import {
  cliSignInCallback,
  cliSignInCancel,
  deletionNeedsSignIn,
  deletionReauthPath,
  desktopSignInCallback,
  desktopSignInRequest,
  desktopSignInStep,
} from "../../../lib/desktop-sign-in"
import "./account.css"

/**
 * /auth/cli — pairs Vector with a Vector account; everyone not signed in bounces to /login.
 * With purpose=cli, `vector login` is waiting on this computer: nothing is minted until the person chooses Approve,
 * then the one-use code goes back to the terminal's loopback listener and the CLI exchanges it for its own grant,
 * which this page never sees. Without parameters, signed-in users get a copyable vct_ token for `vector login
 * --token`, which works with free models only.
 * With purpose=delete, the desktop app is confirming that the person deleting
 * the account is signed in here: nothing happens until they choose Continue,
 * so a link alone cannot sign anyone out, and a sign-in the API finds older
 * than ten minutes has to be made again, after which the page goes straight on.
 */
export function CliTokenPage() {
  const [token, setToken] = useState("")
  const [email, setEmail] = useState("")
  const [error, setError] = useState("")
  const [loading, setLoading] = useState(true)
  const [copied, setCopied] = useState(false)
  const [callback, setCallback] = useState("")
  // Deleting waits for the person to choose Continue on this page, connecting a terminal for Approve.
  const [confirm, setConfirm] = useState(false)
  // Set only by Approve or Continue on this page, so a retry never skips the question the person has not answered.
  const [approved, setApproved] = useState(false)
  // The CLI's code went back to the terminal.
  const [returned, setReturned] = useState(false)
  const query = typeof location !== "undefined" ? new URLSearchParams(location.search) : undefined
  const desktop = query?.get("desktop") === "1"
  const deleting = desktop && query?.get("purpose") === "delete"
  const terminal = desktop && query?.get("purpose") === "cli"

  // Always read the live session: Supabase rotates access tokens, so a token
  // captured at mount goes stale and would 401 on "New token".
  const mint = async (continued = false) => {
    setError("")
    const desktopRequest = desktopSignInRequest(location.search)
    const client = await vectorAccountClient()
    const session = await client.auth.getSession()
    if (session.error) throw session.error
    if (!session.data.session) {
      location.replace(`/login?returnTo=${encodeURIComponent(desktopRequest?.returnPath ?? "/auth/cli")}`)
      return
    }
    setEmail(session.data.session.user.email ?? "")
    if (desktopRequest && desktopSignInStep(continued, desktopRequest) === "ask") {
      setConfirm(true)
      return
    }
    if (desktopRequest) {
      const response = await fetch("/api/account/cli-code", {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          authorization: `Bearer ${session.data.session.access_token}`,
        },
        body: JSON.stringify({
          state: desktopRequest.state,
          challenge: desktopRequest.challenge,
          ...(desktopRequest.purpose ? { purpose: desktopRequest.purpose } : {}),
        }),
      })
      // Read from a copy, so the answer can still be read below when it is not this refusal.
      const refusal: unknown = await response
        .clone()
        .json()
        .catch(() => undefined)
      if (desktopRequest.purpose === "delete" && deletionNeedsSignIn(response.status, refusal)) {
        // Arriving with an earlier Continue but still no fresh sign-in, the page asks rather than signing out again.
        if (!continued) {
          setConfirm(true)
          return
        }
        // Only this browser's session is signed out; the person signs in again and comes straight back here.
        await client.auth.signOut({ scope: "local" })
        location.replace(deletionReauthPath(desktopRequest))
        return
      }
      const payload = await readAccountApiResponse(
        response,
        desktopRequest.purpose === "cli"
          ? "Vector could not connect your terminal."
          : "Vector could not connect this desktop.",
      )
      if (desktopRequest.purpose === "cli") {
        // The code goes only to the terminal's listener; nothing here shows it.
        setReturned(true)
        location.assign(cliSignInCallback(payload, desktopRequest))
        return
      }
      const link = desktopSignInCallback(payload, desktopRequest.state)
      setCallback(link)
      location.assign(link)
      return
    }
    const response = await fetch("/api/account/cli-token", {
      method: "POST",
      headers: { accept: "application/json", authorization: `Bearer ${session.data.session.access_token}` },
    })
    const payload = await readAccountApiResponse(response, "Vector could not create a CLI token.")
    if (typeof payload.token !== "string") throw new Error("Vector could not create a CLI token.")
    setToken(payload.token)
    setCopied(false)
  }

  const fail = (cause: unknown) =>
    setError(cause instanceof Error ? cause.message : "Vector could not create a CLI token.")

  useEffect(() => {
    void mint()
      .catch(fail)
      .finally(() => setLoading(false))
  }, [])

  // Hand out a complete command: pasting a bare token into a shell runs it
  // as a program ("command not found: vct_…"), a full command just works.
  const command = token ? `vector login --token ${token}` : ""

  const copy = () => {
    if (!command) return
    void navigator.clipboard.writeText(command).then(() => setCopied(true))
  }

  if (loading) {
    return (
      <main className="account-loading">
        <LoaderCircle size={28} />
        <p>
          {deleting
            ? "Confirming it is you…"
            : terminal
              ? "Connecting your terminal…"
              : desktop
                ? "Connecting your desktop…"
                : "Preparing your CLI token…"}
        </p>
      </main>
    )
  }

  return (
    <main className="cli-pair-page">
      <div className="cli-pair-card">
        <span className="panel-icon">
          <TerminalSquare size={20} />
        </span>
        <p className="account-kicker">{desktop && !terminal ? "Vector desktop" : "Vector CLI"}</p>
        <h1>
          {confirm && terminal
            ? "Connect the Vector CLI?"
            : confirm
              ? "Delete your Vector account?"
              : returned
                ? "Return to your terminal."
                : deleting
                  ? "Confirm in Vector."
                  : terminal
                    ? "Connect your terminal."
                    : desktop
                      ? "Continue in Vector."
                      : "Connect your terminal."}
        </h1>
        <p className="cli-pair-copy">
          {email ? (
            <>
              Signed in as <strong>{email}</strong>.{" "}
            </>
          ) : null}
          {confirm && terminal
            ? "A terminal on this computer asked to sign in to Vector with this account. Approve only if you just ran vector login; otherwise choose Cancel."
            : confirm
              ? "Vector asked to confirm that you want to delete this account. Continue to confirm it is you, then choose Delete my account in Vector to finish. If you did not start this, close this page."
              : returned
                ? "The Vector CLI is finishing its sign-in. You can close this page."
                : terminal
                  ? "Run vector login in your terminal to connect it."
                  : deleting
                    ? "Open Vector to finish deleting your account there. This link works once and expires in five minutes."
                    : desktop
                      ? "Open Vector to finish signing in. This link works once and expires in five minutes."
                      : "Run this command in your terminal. It links the Vector CLI to your free account and expires in 90 days. A copied token works with free models only; run vector login without it to use Vector Codium."}
        </p>

        {error && <p className="account-error">{error}</p>}

        {command && (
          <div className="cli-pair-token">
            <code>
              <span className="cli-pair-prompt" aria-hidden="true">
                ${" "}
              </span>
              {command}
            </code>
          </div>
        )}
        <div className="cli-pair-actions">
          {confirm && (
            <button
              type="button"
              className="cli-pair-copy-button"
              onClick={() => {
                setApproved(true)
                setConfirm(false)
                setLoading(true)
                void mint(true)
                  .catch(fail)
                  .finally(() => setLoading(false))
              }}
            >
              {terminal ? "Approve" : "Continue"}
            </button>
          )}
          {confirm && terminal && (
            <button
              type="button"
              className="cli-pair-refresh"
              onClick={() => {
                const request = desktopSignInRequest(location.search)
                setConfirm(false)
                // The terminal stops waiting at once; nothing was minted.
                if (request?.purpose === "cli") location.assign(cliSignInCancel(request))
              }}
            >
              Cancel
            </button>
          )}
          {callback && (
            <a className="cli-pair-copy-button" href={callback}>
              Open Vector
            </a>
          )}
          {token && (
            <button type="button" className="cli-pair-copy-button" onClick={copy}>
              {copied ? <Check size={15} /> : <Copy size={15} />}
              {copied ? "Copied" : "Copy command"}
            </button>
          )}
          {/* What the person already approved retries without asking again; a failure before they chose asks first. */}
          {!confirm && !returned && (!terminal || error) && (
            <button type="button" className="cli-pair-refresh" onClick={() => void mint(approved).catch(fail)}>
              <RefreshCw size={14} /> {token ? "New token" : "Try again"}
            </button>
          )}
        </div>

        {!desktop && (
          <ol className="cli-pair-steps">
            <li>
              Install once: <code>npm install -g @vectordevai/cli</code>
            </li>
            <li>Run the command above — it signs the CLI in</li>
            <li>
              <code>vector</code> — start the agent in any repository
            </li>
            <li>
              Signed in, <code>vector models</code> lists the Free models inside of Vector, provided by Vector at no
              cost to you. Connect your own provider with <code>vector auth login</code>
            </li>
          </ol>
        )}
      </div>
    </main>
  )
}
