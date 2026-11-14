/** @jsxImportSource react */
import { Eye, EyeOff } from "lucide-react"
import { type SubmitEventHandler, useEffect, useMemo, useRef, useState } from "react"
import {
  rememberAccountReturnPath,
  safeReturnPath,
  takeAccountReturnPath,
  vectorAccountClient,
} from "../../../lib/account-client"
import "./account.css"

type Mode = "signin" | "register"

export function GoogleMark() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path
        fill="#4285F4"
        d="M21.6 12.23c0-.71-.06-1.4-.18-2.06H12v3.9h5.38a4.6 4.6 0 0 1-1.99 3.02v2.53h3.23c1.89-1.74 2.98-4.3 2.98-7.39Z"
      />
      <path
        fill="#34A853"
        d="M12 22c2.7 0 4.96-.9 6.62-2.38l-3.23-2.53c-.9.6-2.04.96-3.39.96-2.6 0-4.81-1.76-5.6-4.12H3.07v2.6A10 10 0 0 0 12 22Z"
      />
      <path
        fill="#FBBC05"
        d="M6.4 13.93A6 6 0 0 1 6.08 12c0-.67.12-1.32.32-1.93v-2.6H3.07A10 10 0 0 0 2 12c0 1.61.39 3.13 1.07 4.53l3.33-2.6Z"
      />
      <path
        fill="#EA4335"
        d="M12 5.95c1.47 0 2.78.5 3.82 1.49l2.87-2.87A9.6 9.6 0 0 0 12 2a10 10 0 0 0-8.93 5.47l3.33 2.6c.79-2.36 3-4.12 5.6-4.12Z"
      />
    </svg>
  )
}

export function AuthPage() {
  const [mode, setMode] = useState<Mode>("signin")
  // The form asks for the email first. Continue reveals the password (and the name, when creating an
  // account) below it in the same form, and the next submit signs in or signs up as before.
  const [revealed, setRevealed] = useState(false)
  const [name, setName] = useState("")
  const [email, setEmail] = useState("")
  const [password, setPassword] = useState("")
  const [visible, setVisible] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState("")
  const [notice, setNotice] = useState("")
  const firstRevealed = useRef<HTMLInputElement>(null)
  const returnTo = useMemo(
    () => safeReturnPath(new URLSearchParams(globalThis.location?.search ?? "").get("returnTo")),
    [],
  )
  // Vector sent the person here to sign in again before it deletes their account.
  const reauth = useMemo(() => new URLSearchParams(globalThis.location?.search ?? "").get("reauth") === "1", [])

  useEffect(() => {
    void vectorAccountClient()
      .then((client) => client.auth.getSession())
      .then(({ data }) => {
        if (data.session) location.replace(returnTo)
      })
      .catch((cause) => setError(cause instanceof Error ? cause.message : "Vector accounts are unavailable."))
  }, [returnTo])

  useEffect(() => {
    if (revealed) firstRevealed.current?.focus()
  }, [revealed, mode])

  const google = () => {
    setError("")
    setLoading(true)
    rememberAccountReturnPath(returnTo)
    void vectorAccountClient()
      .then((client) =>
        client.auth.signInWithOAuth({
          provider: "google",
          options: {
            redirectTo: `${location.origin}/account`,
            // Choosing the account again makes this a deliberate step rather than a silent pass-through.
            ...(reauth ? { queryParams: { prompt: "select_account" } } : {}),
          },
        }),
      )
      .then(({ error: authError }) => {
        if (authError) throw authError
      })
      .catch((cause) => {
        setError(cause instanceof Error ? cause.message : "Google sign-in could not start.")
        setLoading(false)
      })
  }

  const submit: SubmitEventHandler<HTMLFormElement> = (event) => {
    event.preventDefault()
    if (!revealed) {
      setRevealed(true)
      return
    }
    setError("")
    setNotice("")
    setLoading(true)
    rememberAccountReturnPath(returnTo)
    void vectorAccountClient()
      .then((client) =>
        mode === "signin"
          ? client.auth.signInWithPassword({ email, password })
          : client.auth.signUp({
              email,
              password,
              options: {
                data: { full_name: name.trim() },
                emailRedirectTo: `${location.origin}/account`,
              },
            }),
      )
      .then(({ data, error: authError }) => {
        if (authError) throw authError
        if (data.session) {
          takeAccountReturnPath()
          location.assign(returnTo)
          return
        }
        setNotice("Check your inbox to confirm your email, then come back to sign in.")
        setMode("signin")
        setLoading(false)
      })
      .catch((cause) => {
        setError(cause instanceof Error ? cause.message : "Vector could not sign you in.")
        setLoading(false)
      })
  }

  const switchMode = () => {
    setError("")
    setNotice("")
    setMode(mode === "signin" ? "register" : "signin")
    setVisible(false)
  }

  return (
    <section className="signin-form" aria-labelledby="auth-title">
      <h1 id="auth-title">
        {reauth ? "Sign in again to confirm it is you" : mode === "signin" ? "Log in" : "Create account"}
      </h1>
      {reauth && <p className="signin-sub">Vector asks for a fresh sign-in before it deletes your account.</p>}

      <button className="signin-button signin-primary" type="button" onClick={google} disabled={loading}>
        <GoogleMark />
        Continue with Google
      </button>

      <div className="signin-divider">
        <span>or</span>
      </div>

      <form className="signin-email" onSubmit={submit} aria-busy={loading}>
        <label className="signin-field">
          <span>Email</span>
          <input
            className="signin-input"
            type="email"
            value={email}
            onInput={(event) => setEmail(event.currentTarget.value)}
            autoComplete="email"
            autoCapitalize="none"
            spellCheck={false}
            placeholder="name@example.com"
            required
          />
        </label>
        {revealed && mode === "register" && (
          <label className="signin-field">
            <span>Name</span>
            <input
              ref={firstRevealed}
              className="signin-input"
              value={name}
              onInput={(event) => setName(event.currentTarget.value)}
              autoComplete="name"
              placeholder="Your name"
              required
            />
          </label>
        )}
        {revealed && (
          <label className="signin-field">
            <span>Password</span>
            <span className="signin-password">
              <input
                ref={mode === "signin" ? firstRevealed : undefined}
                className="signin-input"
                type={visible ? "text" : "password"}
                value={password}
                onInput={(event) => setPassword(event.currentTarget.value)}
                autoComplete={mode === "signin" ? "current-password" : "new-password"}
                minLength={8}
                placeholder={mode === "signin" ? "Your password" : "At least 8 characters"}
                required
              />
              <button
                type="button"
                aria-label={visible ? "Hide password" : "Show password"}
                aria-pressed={visible}
                onClick={() => setVisible((value) => !value)}
              >
                {visible ? <EyeOff size={16} aria-hidden="true" /> : <Eye size={16} aria-hidden="true" />}
              </button>
            </span>
          </label>
        )}

        {notice && (
          <p className="auth-notice" role="status">
            {notice}
          </p>
        )}
        {error && (
          <p className="auth-error" role="alert">
            {error}
          </p>
        )}

        <button className="signin-button signin-secondary" disabled={loading}>
          {loading ? "Please wait…" : !revealed ? "Continue" : mode === "signin" ? "Log in" : "Create account"}
        </button>
      </form>

      <p className="signin-switch">
        {mode === "signin" ? "Don’t have an account?" : "Already have an account?"}{" "}
        <button type="button" onClick={switchMode} disabled={loading}>
          {mode === "signin" ? "Sign up" : "Log in"}
        </button>
      </p>
      <p className="signin-legal">
        By continuing, you agree to Vector’s <a href="/legal/terms">Terms of Service</a> and acknowledge the{" "}
        <a href="/legal/privacy">Privacy Policy</a>.
      </p>
    </section>
  )
}
