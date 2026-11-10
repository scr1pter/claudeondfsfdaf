/** @jsxImportSource react */
import { LoaderCircle } from "lucide-react"
import { useEffect, useState } from "react"
import vectorMark from "../../../assets/vector-mark.webp"
import { readAccountApiResponse, takeAccountReturnPath, vectorAccountClient } from "../../../lib/account-client"
import { FreeDownload } from "../download/FreeDownload"
import { CliLaunchPanel } from "./CliLaunchPanel"
import { ModelPlans } from "./ModelPlans"
import "../download/download.css"
import "./account.css"

type AccountState = {
  user: { id: string; email: string; name?: string }
  // Decided by api/account/status against the Design Lab's allowlist, so this page never carries anyone's address.
  // It only shows the Design tab; api/design-lab still decides who may open the lab.
  owner?: boolean
}

/**
 * /account — the signed-in page. One column, flat sections, no marketing.
 * Download, CLI, account.
 */
export function AccountPage(props: { preview?: AccountState }) {
  const [token, setToken] = useState("")
  const [account, setAccount] = useState<AccountState | undefined>(props.preview)
  const [loading, setLoading] = useState(!props.preview)
  const [action, setAction] = useState("")
  const [error, setError] = useState("")
  const [deleting, setDeleting] = useState(false)
  const [confirmEmail, setConfirmEmail] = useState("")

  const loadAccount = (accessToken: string) =>
    fetch("/api/account/status", {
      headers: { accept: "application/json", authorization: `Bearer ${accessToken}` },
    }).then(async (response) => {
      const payload = await readAccountApiResponse(response, "Vector could not load your account.")
      if (!isAccountState(payload)) throw new Error("Vector could not load your account.")
      setAccount(payload)
    })

  useEffect(() => {
    // Design-preview mode (dev-only route) renders fixtures without auth.
    if (props.preview) return
    let unsubscribe: (() => void) | undefined
    void vectorAccountClient()
      .then(async (client) => {
        const listener = client.auth.onAuthStateChange((event, session) => {
          if (session) setToken(session.access_token)
          if (event === "SIGNED_OUT") location.replace("/login")
        })
        unsubscribe = () => listener.data.subscription.unsubscribe()
        const parameters = new URLSearchParams(location.search)
        const code = parameters.get("code")
        if (code) {
          const exchange = await client.auth.exchangeCodeForSession(code)
          if (exchange.error) throw exchange.error
          const returnTo = takeAccountReturnPath()
          history.replaceState({}, "", "/account")
          if (returnTo !== "/account") {
            location.replace(returnTo)
            return
          }
        }
        const session = await client.auth.getSession()
        if (session.error) throw session.error
        if (!session.data.session) {
          location.replace(`/login?returnTo=${encodeURIComponent(`${location.pathname}${location.search}`)}`)
          return
        }
        const accessToken = session.data.session.access_token
        setToken(accessToken)
        await loadAccount(accessToken)
      })
      .catch((cause) => setError(cause instanceof Error ? cause.message : "Vector could not load your account."))
      .finally(() => setLoading(false))
    return () => unsubscribe?.()
  }, [])

  const deleteAccount = () => {
    if (!token || !account) return
    setAction("delete")
    setError("")
    void fetch("/api/account/delete", {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ confirm: confirmEmail }),
    })
      .then(async (response) => {
        await readAccountApiResponse(response, "Vector could not delete your account.")
        // The identity is gone; end the session before anything tries to use it.
        const client = await vectorAccountClient()
        await client.auth.signOut().catch(() => undefined)
        location.replace("/?deleted=1")
      })
      .catch((cause) => {
        setError(cause instanceof Error ? cause.message : "Vector could not delete your account.")
      })
      .finally(() => setAction(""))
  }

  const signOut = () => {
    setAction("signout")
    void vectorAccountClient()
      .then((client) => client.auth.signOut({ scope: "local" }))
      .finally(() => location.replace("/login"))
  }

  if (loading) {
    return (
      <main className="account-loading">
        <LoaderCircle size={28} />
        <p>Loading your Vector account…</p>
      </main>
    )
  }

  return (
    <main className="acct">
      <header className="acct-header">
        <div className="acct-header-inner">
          <a className="acct-brand" href="/" aria-label="Vector home">
            <img src={vectorMark.src} alt="" />
            <span>Vector</span>
          </a>
          <nav aria-label="Account navigation">
            {account?.owner === true && <a href="/design">Design</a>}
            <a href="/docs">Docs</a>
            <button type="button" onClick={signOut} disabled={Boolean(action)}>
              Sign out
            </button>
          </nav>
        </div>
      </header>

      <div className="acct-body">
        <h1>Account</h1>
        <p className="acct-meta">{account?.user.email}</p>

        {error && <p className="account-error">{error}</p>}

        <ModelPlans accessToken={token} preview={props.preview ? true : undefined} />

        <section className="acct-section">
          <h2>Download Vector</h2>
          <p>Installers for macOS, Windows, and Linux, free with your Vector account.</p>
          <FreeDownload accessToken={token} />
        </section>

        <CliLaunchPanel
          accessToken={token}
          previewToken={props.preview ? "vct_eyJ2IjoxLCJzdWIiOiJwcmV2aWV3IiwiZXhwIjoxfQ.previewsignature0000000000000000000000" : undefined}
        />

        <section className="acct-section">
          <h2>Account</h2>
          <dl className="acct-rows">
            <div>
              <dt>Email</dt>
              <dd>{account?.user.email}</dd>
            </div>
            {account?.user.name && (
              <div>
                <dt>Name</dt>
                <dd>{account.user.name}</dd>
              </div>
            )}
          </dl>
          <button className="acct-button acct-button-secondary" type="button" onClick={signOut} disabled={Boolean(action)}>
            Sign out
          </button>

          <div className="acct-danger">
            <h3>Delete this account</h3>
            {deleting ? (
              <>
                <p className="acct-fine">
                  This cannot be undone. Vector deletes your account and sign-in and stops the CLI tokens this account
                  has issued. Any Vector Codium plan ends at once, and the credits left, this month's or purchased, can
                  no longer be used. Repositories on your own machine are not touched, and neither is anything you have
                  already published to your own cloud accounts.
                </p>
                <label className="acct-danger-label" htmlFor="acct-delete-confirm">
                  Type <strong>{account?.user.email}</strong> to confirm
                </label>
                <input
                  id="acct-delete-confirm"
                  className="acct-danger-input"
                  type="email"
                  autoComplete="off"
                  spellCheck={false}
                  value={confirmEmail}
                  onChange={(event) => setConfirmEmail(event.target.value)}
                  placeholder={account?.user.email}
                />
                <div className="acct-danger-actions">
                  <button
                    className="acct-button acct-button-danger"
                    type="button"
                    onClick={deleteAccount}
                    disabled={
                      Boolean(action) ||
                      confirmEmail.trim().toLowerCase() !== (account?.user.email ?? "").trim().toLowerCase()
                    }
                  >
                    {action === "delete" ? "Deleting…" : "Delete my account"}
                  </button>
                  <button
                    className="acct-button acct-button-secondary"
                    type="button"
                    onClick={() => {
                      setDeleting(false)
                      setConfirmEmail("")
                    }}
                    disabled={Boolean(action)}
                  >
                    Keep my account
                  </button>
                </div>
              </>
            ) : (
              <>
                <p className="acct-fine">
                  Deleting removes your sign-in and stops your CLI tokens. It cannot be undone.
                </p>
                <button
                  className="acct-button acct-button-quiet"
                  type="button"
                  onClick={() => setDeleting(true)}
                  disabled={Boolean(action)}
                >
                  Delete account…
                </button>
              </>
            )}
          </div>
        </section>
      </div>
    </main>
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value))
}

function isAccountState(value: Record<string, unknown>): value is AccountState {
  if (!isRecord(value.user)) return false
  if (typeof value.user.id !== "string" || typeof value.user.email !== "string") return false
  if (value.owner !== undefined && typeof value.owner !== "boolean") return false
  return value.user.name === undefined || typeof value.user.name === "string"
}
