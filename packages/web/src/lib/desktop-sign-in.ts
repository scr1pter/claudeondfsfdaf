export function desktopSignInRequest(search: string) {
  const query = new URLSearchParams(search)
  if (query.get("desktop") !== "1") return
  const state = query.get("state") ?? ""
  const challenge = query.get("code_challenge") ?? ""
  const purpose = query.get("purpose")
  const port = query.get("port")
  if (
    query.get("code_challenge_method") !== "S256" ||
    !/^[A-Za-z0-9_-]{43}$/.test(state) ||
    !/^[A-Za-z0-9_-]{43}$/.test(challenge) ||
    (purpose !== null && purpose !== "delete" && purpose !== "cli") ||
    // The terminal's callback port comes only with a CLI sign-in, and a CLI sign-in always names one.
    (purpose === "cli") !== (port !== null) ||
    (port !== null && !loopbackPort(port))
  )
    throw new Error(
      purpose === "cli"
        ? "Run vector login again to connect your terminal securely."
        : "Start sign-in from Vector to connect this desktop securely.",
    )
  const destination = new URLSearchParams({
    desktop: "1",
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
    // Vector asks for this sign-in to confirm deleting the account; the API then needs a recent sign-in. The CLI asks
    // for a CLI grant, which only this saved purpose can buy (the API binds it to the code).
    ...(purpose === "delete" || purpose === "cli" ? { purpose } : {}),
    ...(purpose === "cli" && port !== null ? { port } : {}),
  })
  const request = { state, challenge, returnPath: `/auth/cli?${destination}` }
  if (purpose === "cli") return { ...request, purpose: "cli" as const, port: Number(port), confirmed: false }
  // The person already chose Continue, then signed in again (see deletionReauthPath).
  if (purpose === "delete") return { ...request, purpose: "delete" as const, confirmed: query.get("confirmed") === "1" }
  return { ...request, purpose: undefined, confirmed: false }
}

export function desktopSignInCallback(payload: Record<string, unknown>, state: string) {
  return `vector://auth/callback?${new URLSearchParams({ code: signInCode(payload, state), state })}`
}

/**
 * Where the browser returns a CLI sign-in: the terminal's own listener on this computer. Only the port comes from the
 * link; the host and path are fixed, so a link cannot send the code anywhere else.
 */
export function cliSignInCallback(payload: Record<string, unknown>, request: { state: string; port: number }) {
  return `${cliLoopback(request)}?${new URLSearchParams({ code: signInCode(payload, request.state), state: request.state })}`
}

/** Tells the waiting terminal that the person cancelled here, so `vector login` ends at once instead of timing out. */
export function cliSignInCancel(request: { state: string; port: number }) {
  return `${cliLoopback(request)}?${new URLSearchParams({ error: "access_denied", state: request.state })}`
}

/**
 * Whether /auth/cli mints a code now or first asks on the page. Deleting the account waits for Continue (or a Continue
 * chosen before signing in again); connecting a terminal waits for Approve, so a link alone can neither sign anyone out
 * nor connect a terminal someone else started to this account. A desktop sign-in goes straight on.
 */
export function desktopSignInStep(continued: boolean, request: { purpose?: "delete" | "cli"; confirmed?: boolean }) {
  if (request.purpose === "delete") return deletionConfirmation(continued, request)
  if (request.purpose === "cli") return continued ? ("send" as const) : ("ask" as const)
  return "send" as const
}

function signInCode(payload: Record<string, unknown>, state: string) {
  if (typeof payload.code !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(payload.code) || payload.state !== state)
    throw new Error("Vector could not prepare a secure sign-in link. Start sign-in again.")
  return payload.code
}

function loopbackPort(value: string) {
  return /^[1-9][0-9]{3,4}$/.test(value) && Number(value) >= 1024 && Number(value) <= 65535
}

function cliLoopback(request: { port: number }) {
  if (!loopbackPort(String(request.port))) throw new Error("Run vector login again to connect your terminal securely.")
  return `http://127.0.0.1:${request.port}/callback`
}

/**
 * What /auth/cli does when Vector asks to confirm deleting the account: wait until the person chooses Continue on the
 * page, so a link alone cannot sign anyone out or send a confirmation; or go straight on when they chose it before
 * signing in again. Whether the sign-in is recent enough is the API's to say (deletionNeedsSignIn), so a browser clock
 * that is off never decides it.
 */
export function deletionConfirmation(continued: boolean, request: { confirmed?: boolean }) {
  return continued || request.confirmed ? ("send" as const) : ("ask" as const)
}

/** Whether vectordev.ai refused to confirm a deletion only because this browser's sign-in is not recent. */
export function deletionNeedsSignIn(status: number, payload: unknown) {
  const error = payload && typeof payload === "object" && "error" in payload ? payload.error : undefined
  return (
    status === 401 &&
    Boolean(error && typeof error === "object" && "code" in error && error.code === "RECENT_SIGN_IN_REQUIRED")
  )
}

/**
 * Where to sign in again before confirming a deletion. The way back says the person already chose Continue, so they
 * are not asked twice; it counts only with the fresh sign-in, since the API checks that whatever the link says.
 */
export function deletionReauthPath(request: { returnPath: string }) {
  return `/login?${new URLSearchParams({ returnTo: `${request.returnPath}&confirmed=1`, reauth: "1" })}`
}
