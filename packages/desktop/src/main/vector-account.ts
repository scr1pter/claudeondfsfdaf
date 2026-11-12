import { createHash, randomBytes } from "node:crypto"
import type { VectorAccountStatus, VectorBillingResult, VectorDeletionResult } from "@vectordevai/app/vector-account"
import { ModelPlanStatus } from "@vectordevai/core/model-plan-status"
import { Option, Schema } from "effect"
import type { BillingOutcome } from "./billing-navigation"

type StoredAccount = {
  ciphertext: string
  email: string
  name?: string
  /** The profile photo as a data URL, so the renderer shows it without loading a third-party URL. */
  avatar?: string
  /** The https URL that photo came from, so an unchanged photo is not downloaded again. */
  avatarSource?: string
  /** When the name and photo last came from vectordev.ai. */
  profileAt?: number
  expiresAt: number
}
type Pending = { state: string; verifier: string; expiresAt: number; exchanging?: boolean }
/** The ten-minute deletion grant vectordev.ai gave for a fresh sign-in. Main-process memory only, never stored. */
type Grant = { value: string; email: string; expiresAt: number }
type Dependencies = {
  read(): unknown
  write(value: StoredAccount): void
  clear(): Promise<void>
  available(): Promise<boolean>
  encrypt(token: string): Promise<string>
  decrypt(ciphertext: string): Promise<string>
  openBrowser(url: string): Promise<void>
  fetch(url: string, options: RequestInit): Promise<Response>
  sync(token: string | undefined): Promise<void>
  /** Writes the signed-in token to the local server again, which reads that account's Codium models now. */
  models(token: string): Promise<void>
  changed(status: VectorAccountStatus): void
  /** Shows a Stripe page in Vector's billing window and resolves when that window is done. */
  billingWindow(url: string): Promise<BillingOutcome>
  /** Brings the open billing window forward, for a request made while it is open. */
  focusBilling(): void
  now?(): number
}

const secureStorageError =
  "Vector cannot store your account securely. Unlock the operating system credential store and try again."
const PROFILE_INTERVAL_MS = 24 * 60 * 60 * 1_000
const PHOTO_BYTES = 256 * 1024
const PHOTO_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"]
const photoData = /^data:image\/(?:png|jpeg|webp|gif);base64,[A-Za-z0-9+/]+={0,2}$/

export function createVectorAccount(deps: Dependencies) {
  const now = deps.now ?? Date.now
  const state: {
    pending?: Pending
    /** The browser sign-in that confirms deleting the account, kept apart so a normal sign-in is not disturbed. */
    reauth?: Pending
    grant?: Grant
    error?: string
    refreshing?: boolean
    /** A billing request is under way, from asking vectordev.ai until its window is done. */
    billing?: boolean
    work: Promise<void>
  } = {
    work: Promise.resolve(),
  }
  const stored = () => {
    const value = deps.read()
    if (
      !value ||
      typeof value !== "object" ||
      !("ciphertext" in value) ||
      !("email" in value) ||
      !("expiresAt" in value) ||
      typeof value.ciphertext !== "string" ||
      typeof value.email !== "string" ||
      typeof value.expiresAt !== "number"
    )
      return
    const avatar =
      "avatar" in value &&
      typeof value.avatar === "string" &&
      value.avatar.length <= PHOTO_BYTES * 2 &&
      photoData.test(value.avatar)
        ? value.avatar
        : undefined
    const avatarSource = "avatarSource" in value ? photoSource(value.avatarSource) : undefined
    return {
      ciphertext: value.ciphertext,
      email: value.email,
      // Sign-ins saved before names were stored have none; the app then shows the email.
      ...("name" in value && typeof value.name === "string" && value.name ? { name: value.name } : {}),
      // The photo and its source go together; anything else is dropped and the app shows the initial.
      ...(avatar && avatarSource ? { avatar, avatarSource } : {}),
      ...("profileAt" in value && typeof value.profileAt === "number" ? { profileAt: value.profileAt } : {}),
      expiresAt: value.expiresAt,
    }
  }
  const status = (): VectorAccountStatus => {
    const account = stored()
    const authenticated = Boolean(account && account.expiresAt > now())
    const deletion =
      state.grant && state.grant.expiresAt > now()
        ? ("confirmed" as const)
        : state.reauth && state.reauth.expiresAt > now()
          ? ("confirming" as const)
          : undefined
    return {
      authenticated,
      pending: Boolean(state.pending && state.pending.expiresAt > now()),
      ...(authenticated && account
        ? {
            email: account.email,
            ...(account.name ? { name: account.name } : {}),
            ...(account.avatar ? { avatar: account.avatar } : {}),
            expiresAt: account.expiresAt,
            ...(deletion ? { deletion } : {}),
          }
        : {}),
      ...(state.error ? { error: state.error } : {}),
    }
  }
  const notify = () => {
    const value = status()
    deps.changed(value)
    return value
  }
  const queue = (operation: () => Promise<void>) => {
    const work = state.work.then(operation, operation)
    state.work = work.catch(() => {})
    return work
  }
  const fail = (message: string) => {
    state.error = message
    return notify()
  }
  const token = async () => {
    const account = stored()
    if (!account || account.expiresAt <= now() || !(await deps.available())) return
    return deps.decrypt(account.ciphertext)
  }
  const browserSignIn = async (pending: Pending, purpose?: "delete") => {
    const url = new URL("https://vectordev.ai/auth/cli")
    url.search = new URLSearchParams({
      desktop: "1",
      ...(purpose ? { purpose } : {}),
      state: pending.state,
      code_challenge: createHash("sha256").update(pending.verifier).digest("base64url"),
      code_challenge_method: "S256",
    }).toString()
    return deps
      .openBrowser(url.href)
      .then(() => true)
      .catch(() => false)
  }
  const pendingSignIn = () => ({
    state: randomBytes(32).toString("base64url"),
    verifier: randomBytes(32).toString("base64url"),
    expiresAt: now() + 300_000,
  })
  // Display only, so every failure keeps the last good name and photo.
  const applyProfile = async (ciphertext: string, profile: { name: string; source?: string }) => {
    const current = stored()
    const kept = profile.source && current?.avatarSource === profile.source ? current.avatar : undefined
    const photo = kept ?? (profile.source ? await downloadPhoto(profile.source, deps.fetch) : undefined)
    // Settled once the account has no photo or this one is in hand; otherwise the next refresh tries again.
    const settled = !profile.source || Boolean(photo)
    await queue(async () => {
      const account = stored()
      // Signed out, or signed in again as someone else, while the photo downloaded.
      if (!account || account.ciphertext !== ciphertext) return
      deps.write({
        ciphertext: account.ciphertext,
        email: account.email,
        ...(profile.name ? { name: profile.name } : {}),
        ...(photo && profile.source ? { avatar: photo, avatarSource: profile.source } : {}),
        // A photo that could not be downloaded keeps the last good one.
        ...(!settled && account.avatar ? { avatar: account.avatar, avatarSource: account.avatarSource } : {}),
        ...(settled ? { profileAt: now() } : account.profileAt ? { profileAt: account.profileAt } : {}),
        expiresAt: account.expiresAt,
      })
    }).catch(() => undefined)
    notify()
  }

  // One billing request: ask vectordev.ai for the Stripe page, then show it in the billing window. A smaller plan and
  // Keep my plan are answered without a page.
  const openBilling = async (input: unknown): Promise<VectorBillingResult> => {
    const request = billingRequest(input)
    if (!request) return { outcome: "failed", message: "Vector could not open billing for that choice." }
    const secret = await token().catch(() => undefined)
    if (!secret) return { outcome: "failed", message: "Sign in to Vector to manage billing." }
    const response = await deps
      .fetch(`${ModelPlanStatus.API_URL}/${request.route}`, {
        method: request.method,
        // vectordev.ai takes these routes only as JSON, the DELETE that keeps the plan included.
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          authorization: `Bearer ${secret}`,
        },
        body: JSON.stringify(request.body),
        redirect: "error",
        signal: AbortSignal.timeout(15_000),
      })
      .catch(() => undefined)
    if (!response)
      return {
        outcome: "failed",
        message: "Vector could not reach vectordev.ai. Check your connection and try again.",
      }
    const payload: unknown = await response.json().catch(() => undefined)
    const error = apiError(payload)
    // A vectordev.ai from before 1.99.109 takes only a website session on these routes, and hands the account token
    // to Supabase, which refuses it. And the billing portal, which can charge the saved card, opens only for a sign-in
    // made in Vector 1.99.109 or later (DESKTOP_SIGN_IN_REQUIRED). Neither answer is a sign-out: the website still
    // does all of this.
    if (
      !response.ok &&
      (error?.code === "SESSION_INVALID" ||
        error?.code === "SIGN_IN_REQUIRED" ||
        error?.code === "DESKTOP_SIGN_IN_REQUIRED" ||
        (!error && (response.status === 404 || response.status === 405)))
    ) {
      await deps
        .openBrowser(request.kind === "checkout" ? ModelPlanStatus.PURCHASE_URL : ModelPlanStatus.MANAGE_URL)
        .catch(() => undefined)
      return { outcome: "website" }
    }
    if (!response.ok)
      return { outcome: "failed", message: error?.message ?? "Vector could not open billing. Try again shortly." }
    const answer = payload && typeof payload === "object" ? payload : {}
    // Keep my plan drops the scheduled change; a smaller plan is scheduled for the renewal date.
    if (request.kind === "keep")
      return "scheduled" in answer && answer.scheduled === false
        ? { outcome: "kept" }
        : { outcome: "failed", message: "Vector could not keep your plan. Try again shortly." }
    const scheduled = request.kind === "change" ? scheduledChange(answer) : undefined
    if (scheduled) return { outcome: "scheduled", ...scheduled }
    const url = "url" in answer ? answer.url : undefined
    if (
      typeof url !== "string" ||
      !url.startsWith(request.kind === "portal" ? "https://billing.stripe.com/" : "https://checkout.stripe.com/")
    )
      return { outcome: "failed", message: "Vector could not open billing. Try again shortly." }
    const outcome = await deps.billingWindow(url)
    if (outcome === "failed")
      return {
        outcome: "failed",
        message: "Vector could not open the Stripe page. Check your connection and try again.",
      }
    return { outcome }
  }

  return {
    status,
    /** Main process only: the signed-in token for requests to vectordev.ai, never sent to a renderer. */
    token,
    /**
     * Startup: refreshes the name and photo from vectordev.ai at most once a day, and only while signed in, so a
     * sign-in saved before either was carried gets them without signing in again.
     */
    async refreshProfile() {
      const account = stored()
      if (
        !account ||
        account.expiresAt <= now() ||
        state.refreshing ||
        (account.profileAt !== undefined && now() - account.profileAt < PROFILE_INTERVAL_MS)
      )
        return status()
      state.refreshing = true
      const secret = await token().catch(() => undefined)
      const response = secret
        ? await deps
            .fetch("https://vectordev.ai/api/account/profile", {
              headers: { accept: "application/json", authorization: `Bearer ${secret}` },
              redirect: "error",
              signal: AbortSignal.timeout(15_000),
            })
            .catch(() => undefined)
        : undefined
      const payload: unknown = await response?.json().catch(() => undefined)
      if (response?.ok && payload && typeof payload === "object")
        await applyProfile(account.ciphertext, {
          name: "name" in payload && typeof payload.name === "string" ? payload.name.trim().slice(0, 120) : "",
          source: "avatar" in payload ? photoSource(payload.avatar) : undefined,
        })
      state.refreshing = false
      return status()
    },
    /** The account's Vector Codium plan and balances. The token goes only to vectordev.ai; the renderer gets the result. */
    async codium() {
      return ModelPlanStatus.fetchStatus(await token().catch(() => undefined), deps.fetch)
    },
    async start() {
      if (!(await deps.available())) return fail(secureStorageError)
      state.error = undefined
      const pending = pendingSignIn()
      state.pending = pending
      if (!(await browserSignIn(pending))) {
        state.pending = undefined
        state.error = "Vector could not open your browser. Try signing in again."
      }
      return notify()
    },
    /** The monthly plans vectordev.ai sells, by name and price; read here so the renderer needs no network. */
    offers() {
      return ModelPlanStatus.fetchOffers(deps.fetch)
    },
    /**
     * After a purchase: has the local server read the account's Codium models now instead of keeping its list for up to
     * a minute. It runs in the account queue with the token stored when it runs, so a sign-out or another sign-in asked
     * for earlier comes first and is never undone, and it does nothing while signed out. A failed write leaves the list
     * the server keeps, which lapses within the minute.
     */
    async refreshModels() {
      await queue(async () => {
        const secret = await token()
        if (secret) await deps.models(secret)
      }).catch(() => undefined)
    },
    /**
     * Opens Codium checkout, an upgrade's checkout or Stripe's customer portal in Vector's billing window, or schedules a
     * smaller plan or keeps the current one. The account token goes only to vectordev.ai, and the window loads only the
     * Stripe address vectordev.ai answers with. One request runs at a time: another, from a second page or dialog, gets
     * "busy" and the open window comes forward, so no request reports how a different one ended and no second Stripe
     * session is made.
     */
    async billing(input: unknown): Promise<VectorBillingResult> {
      if (state.billing) {
        deps.focusBilling()
        return { outcome: "busy" }
      }
      state.billing = true
      return openBilling(input).finally(() => {
        state.billing = undefined
      })
    },
    /**
     * Deleting the account needs a sign-in on vectordev.ai from the last few minutes, made in the browser because
     * Google refuses sign-in inside an app window. The answer comes back to consume() as a ten-minute grant.
     */
    async confirmDeletion() {
      if (!status().authenticated) return fail("Sign in to Vector before deleting your account.")
      state.error = undefined
      state.grant = undefined
      const reauth = pendingSignIn()
      state.reauth = reauth
      if (!(await browserSignIn(reauth, "delete"))) {
        state.reauth = undefined
        state.error = "Vector could not open your browser. Try again."
      }
      return notify()
    },
    cancelDeletion() {
      state.reauth = undefined
      state.grant = undefined
      state.error = undefined
      return notify()
    },
    /** Deletes the account with the grant the fresh sign-in gave, then forgets it on this machine. */
    async deleteAccount(email: unknown): Promise<VectorDeletionResult> {
      const grant = state.grant
      if (!grant || grant.expiresAt <= now()) {
        state.grant = undefined
        notify()
        return { deleted: false, message: "Your confirmation expired. Confirm with your Vector sign-in again." }
      }
      if (typeof email !== "string" || email.trim().toLowerCase() !== grant.email.trim().toLowerCase())
        return { deleted: false, message: "Type the email address on this account to confirm." }
      const response = await deps
        .fetch("https://vectordev.ai/api/account/delete", {
          method: "POST",
          headers: {
            accept: "application/json",
            "content-type": "application/json",
            authorization: `Bearer ${grant.value}`,
          },
          body: JSON.stringify({ confirm: email.trim() }),
          redirect: "error",
          signal: AbortSignal.timeout(30_000),
        })
        .catch(() => undefined)
      const payload: unknown = await response?.json().catch(() => undefined)
      if (
        !response?.ok ||
        !payload ||
        typeof payload !== "object" ||
        !("deleted" in payload) ||
        payload.deleted !== true
      ) {
        const error = apiError(payload)
        // A used or expired grant cannot be retried; anything else can, with the same confirmation.
        if (error?.code === "DELETION_GRANT_INVALID" || error?.code === "DELETION_GRANT_USED") state.grant = undefined
        notify()
        return {
          deleted: false,
          message: error?.message ?? "Vector could not delete your account. Check your connection and try again.",
        }
      }
      state.grant = undefined
      state.reauth = undefined
      state.pending = undefined
      state.error = undefined
      // The account and its tokens are gone on vectordev.ai, so this machine forgets it even if the local server
      // cannot be told; the token it still holds no longer works anywhere.
      await queue(async () => {
        await deps.sync(undefined).catch(() => undefined)
        await deps.clear()
      }).catch(() => undefined)
      notify()
      return { deleted: true }
    },
    cancel() {
      state.pending = undefined
      state.error = undefined
      return notify()
    },
    async logout() {
      state.pending = undefined
      state.reauth = undefined
      state.grant = undefined
      state.error = undefined
      await queue(async () => {
        await deps.sync(undefined)
        await deps.clear()
      }).catch(() => {
        state.error = "Vector could not finish signing out. Start the local server and try again."
      })
      return notify()
    },
    async restore() {
      await queue(async () => {
        const account = stored()
        if (!account) return
        if (account.expiresAt <= now()) {
          await deps.sync(undefined)
          await deps.clear()
          state.error = "Your Vector sign-in expired. Sign in again."
          return
        }
        if (!(await deps.available())) throw new Error(secureStorageError)
        await deps.sync(await deps.decrypt(account.ciphertext))
      }).catch(() => {
        state.error = "Vector could not restore your account securely. Unlock the credential store or sign in again."
      })
      return notify()
    },
    async consume(urls: string[]) {
      const remaining: string[] = []
      for (const raw of urls) {
        const url = URL.canParse(raw) ? new URL(raw) : undefined
        // Even malformed account callbacks must stay out of generic renderer events/logs.
        if (
          !(url?.protocol === "vector:" && url.hostname === "auth") &&
          !/^vector:\/\/auth(?:[/?#\\]|$)/i.test(raw.trim())
        ) {
          remaining.push(raw)
          continue
        }
        // The deletion confirmation has its own slot, matched by its state, so a sign-in started meanwhile still works.
        const reauth = state.reauth && url?.searchParams.get("state") === state.reauth.state ? state.reauth : undefined
        const pending = reauth ?? state.pending
        if (
          !url ||
          url.protocol !== "vector:" ||
          url.hostname !== "auth" ||
          url.pathname !== "/callback" ||
          url.hash ||
          url.username ||
          url.password ||
          url.port ||
          url.searchParams.size !== 2 ||
          url.searchParams.getAll("code").length !== 1 ||
          url.searchParams.getAll("state").length !== 1 ||
          !/^[A-Za-z0-9_-]{43}$/.test(url.searchParams.get("code") ?? "") ||
          !pending ||
          pending.expiresAt <= now() ||
          url.searchParams.get("state") !== pending.state
        ) {
          fail("This sign-in link is no longer valid. Start sign-in again in Vector.")
          continue
        }
        if (pending.exchanging) continue
        pending.exchanging = true
        const response = await deps
          .fetch("https://vectordev.ai/api/account/cli-exchange", {
            method: "POST",
            headers: { "content-type": "application/json", accept: "application/json" },
            body: JSON.stringify({
              code: url.searchParams.get("code"),
              state: pending.state,
              verifier: pending.verifier,
            }),
            redirect: "error",
            signal: AbortSignal.timeout(15_000),
          })
          .catch(() => undefined)
        const payload: unknown = await response?.json().catch(() => undefined)
        if (reauth) {
          if (state.reauth !== reauth) continue
          state.reauth = undefined
          const grant = deletionGrant(payload, response?.ok === true, now())
          const email = stored()?.email
          if (!grant) {
            fail("Vector could not confirm it is you. The link may have expired; start again from Delete account.")
            continue
          }
          // The grant deletes whichever account signed in on the website, so it must be the one in this app.
          if (!email || grant.email.trim().toLowerCase() !== email.trim().toLowerCase()) {
            fail(
              `You confirmed as ${grant.email}. Sign in to vectordev.ai as ${email ?? "this account"} and try again.`,
            )
            continue
          }
          state.grant = { ...grant, email }
          state.error = undefined
          notify()
          continue
        }
        if (state.pending !== pending) continue
        if (
          !response?.ok ||
          !payload ||
          typeof payload !== "object" ||
          !("token" in payload) ||
          typeof payload.token !== "string" ||
          !payload.token.startsWith("vct_") ||
          !("expiresAt" in payload) ||
          typeof payload.expiresAt !== "number" ||
          payload.expiresAt <= now() ||
          !("user" in payload) ||
          !payload.user ||
          typeof payload.user !== "object" ||
          !("email" in payload.user) ||
          typeof payload.user.email !== "string" ||
          // Only a grant minted for this app: a CLI grant, or an unmarked token, is never kept here.
          tokenClient(payload.token) !== "desktop"
        ) {
          state.pending = undefined
          fail("Vector could not complete sign-in. The link may have expired; start sign-in again.")
          continue
        }
        const name =
          "name" in payload.user && typeof payload.user.name === "string" ? payload.user.name.trim().slice(0, 120) : ""
        const source = "avatar" in payload.user ? photoSource(payload.user.avatar) : undefined
        const account = { token: payload.token, email: payload.user.email, name, expiresAt: payload.expiresAt }
        const committed: { ciphertext?: string } = {}
        await queue(async () => {
          if (state.pending !== pending) return
          if (!(await deps.available())) throw new Error(secureStorageError)
          const ciphertext = await deps.encrypt(account.token)
          if (state.pending !== pending) return
          deps.write({
            ciphertext,
            email: account.email,
            ...(account.name ? { name: account.name } : {}),
            expiresAt: account.expiresAt,
          })
          committed.ciphertext = ciphertext
          // Persistence is the commit point. A newer browser flow must not be
          // cancelled when this earlier engine synchronization completes.
          state.pending = undefined
          state.error = undefined
          await deps.sync(account.token)
        }).catch(() => {
          if (state.pending === pending) state.pending = undefined
          if (!state.pending)
            state.error =
              "Vector could not finish secure setup. Unlock the credential store and restart Vector, or sign in again."
        })
        notify()
        // The exchange carries the current name and photo, so this sign-in needs no profile refresh.
        if (committed.ciphertext) await applyProfile(committed.ciphertext, { name: account.name, source })
      }
      return remaining
    },
  }
}

/**
 * Which billing request the renderer asked for, checked here, since it reaches the main process over IPC: a monthly
 * plan's checkout, a plan change (POST /change), keeping the plan (DELETE /change), or the portal's home, cancel or
 * card step. Codium sells no top-ups, and the portal no longer changes plans.
 */
function billingRequest(input: unknown) {
  if (!input || typeof input !== "object" || !("kind" in input)) return
  const plan =
    "plan" in input && typeof input.plan === "string" && /^[a-z0-9-]{1,40}$/.test(input.plan) ? input.plan : ""
  if (input.kind === "checkout" && plan)
    return { kind: "checkout" as const, route: "checkout", method: "POST", body: { plan } }
  if (input.kind === "change" && plan)
    return { kind: "change" as const, route: "change", method: "POST", body: { plan } }
  if (input.kind === "keep") return { kind: "keep" as const, route: "change", method: "DELETE", body: {} }
  if (input.kind !== "portal") return
  const flow = "flow" in input ? input.flow : undefined
  if (flow !== undefined && flow !== "cancel" && flow !== "payment_method_update") return
  return { kind: "portal" as const, route: "portal", method: "POST", body: flow ? { flow } : {} }
}

/** A smaller plan /change scheduled for the renewal date: `{scheduled: {plan, at}}`. */
function scheduledChange(answer: object) {
  const scheduled = "scheduled" in answer ? answer.scheduled : undefined
  if (!scheduled || typeof scheduled !== "object" || !("plan" in scheduled) || !("at" in scheduled)) return
  if (typeof scheduled.plan !== "string" || typeof scheduled.at !== "number" || !Number.isFinite(scheduled.at)) return
  return { plan: scheduled.plan, at: scheduled.at }
}

// The client a vct_ sign-in token was minted for, read without verifying it: only vectordev.ai can verify the
// signature, and this decides only what the desktop keeps.
const Claims = Schema.fromJsonString(Schema.Struct({ client: Schema.optional(Schema.String) }))
function tokenClient(token: string) {
  const parts = token.startsWith("vct_") ? token.slice(4).split(".") : []
  if (parts.length !== 2) return
  return Option.getOrUndefined(Schema.decodeUnknownOption(Claims)(Buffer.from(parts[0]!, "base64url").toString("utf8")))
    ?.client
}

/** vectordev.ai's `{ error: { code, message } }`, with the message kept to a line the app can show. */
function apiError(payload: unknown) {
  const error = payload && typeof payload === "object" && "error" in payload ? payload.error : undefined
  if (!error || typeof error !== "object") return
  const code = "code" in error && typeof error.code === "string" ? error.code : undefined
  const message =
    "message" in error && typeof error.message === "string" && error.message.trim()
      ? error.message.trim().slice(0, 300)
      : undefined
  return { code, message }
}

/** The exchange's answer to a deletion confirmation: a vdg_ grant, never a sign-in token. */
function deletionGrant(payload: unknown, ok: boolean, now: number) {
  if (
    !ok ||
    !payload ||
    typeof payload !== "object" ||
    "token" in payload ||
    !("grant" in payload) ||
    typeof payload.grant !== "string" ||
    !/^vdg_[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(payload.grant) ||
    !("expiresAt" in payload) ||
    typeof payload.expiresAt !== "number" ||
    payload.expiresAt <= now ||
    !("user" in payload) ||
    !payload.user ||
    typeof payload.user !== "object" ||
    !("email" in payload.user) ||
    typeof payload.user.email !== "string"
  )
    return
  // vectordev.ai grants ten minutes; a longer answer is not trusted past that.
  return { value: payload.grant, email: payload.user.email, expiresAt: Math.min(payload.expiresAt, now + 600_000) }
}

type LocalServer = { url: string; username: string | null; password: string | null }
type Fetcher = (url: string, init: RequestInit) => Promise<Response>

/** The account token may only be copied to the app's authenticated local sidecar. */
export async function syncVectorAccount(connection: LocalServer, token: string | undefined, fetcher: Fetcher = fetch) {
  const server = await writeCredential(connection, token, fetcher)
  const refreshed = await fetcher(new URL("/global/dispose", server.url).href, {
    method: "POST",
    headers: { authorization: server.authorization },
    redirect: "error",
    signal: AbortSignal.timeout(10_000),
  })
  if (!refreshed.ok) throw new Error("Vector could not refresh the local account connection.")
}

/**
 * Writes the signed-in token to the local sidecar again, unchanged: the write makes it read that account's Codium
 * models now (ControlHttpApi.authSet). Nothing reloads, so running sessions carry on.
 */
export async function refreshVectorModels(connection: LocalServer, token: string, fetcher: Fetcher = fetch) {
  await writeCredential(connection, token, fetcher)
}

async function writeCredential(connection: LocalServer, token: string | undefined, fetcher: Fetcher) {
  const url = new URL(connection.url)
  if (
    url.protocol !== "http:" ||
    !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
    url.username ||
    url.password ||
    !connection.username ||
    !connection.password
  )
    throw new Error("Vector account setup requires the authenticated local server.")
  const authorization = `Basic ${Buffer.from(`${connection.username}:${connection.password}`).toString("base64")}`
  const response = await fetcher(new URL("/auth/vector", url).href, {
    method: token ? "PUT" : "DELETE",
    headers: { authorization, "content-type": "application/json" },
    ...(token ? { body: JSON.stringify({ type: "api", key: token }) } : {}),
    redirect: "error",
    signal: AbortSignal.timeout(10_000),
  })
  if (!response.ok) throw new Error("Vector could not update the local account credential.")
  return { url, authorization }
}

/** Google's avatar hosts over https only, the same list vectordev.ai checks before it hands a photo out. */
function photoSource(value: unknown) {
  if (typeof value !== "string" || value.length > 2_048) return
  const url = URL.parse(value)
  if (
    !url ||
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.port ||
    !/^lh\d\.googleusercontent\.com$/.test(url.hostname)
  )
    return
  return url.href
}

/**
 * The photo is downloaded here, in the main process, and handed to the renderer as a data URL, so the renderer never
 * loads a third-party URL and its content security policy stays as it is. Any failure returns nothing.
 */
async function downloadPhoto(source: string, fetcher: Dependencies["fetch"]) {
  const response = await fetcher(source, {
    headers: { accept: PHOTO_TYPES.join(",") },
    redirect: "error",
    signal: AbortSignal.timeout(10_000),
  }).catch(() => undefined)
  const type = response?.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() ?? ""
  const reader = response?.body?.getReader()
  if (
    !response?.ok ||
    !reader ||
    !PHOTO_TYPES.includes(type) ||
    Number(response.headers.get("content-length")) > PHOTO_BYTES
  ) {
    await reader?.cancel().catch(() => undefined)
    return
  }
  // The declared length can be missing or wrong, so the cap holds while reading.
  const chunks: Uint8Array[] = []
  let received = 0
  while (true) {
    const next = await reader.read().catch(() => undefined)
    if (!next) return
    if (next.done) break
    received += next.value.byteLength
    if (received > PHOTO_BYTES) {
      await reader.cancel().catch(() => undefined)
      return
    }
    chunks.push(next.value)
  }
  if (!received) return
  return `data:${type};base64,${Buffer.concat(chunks).toString("base64")}`
}
