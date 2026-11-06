import { imageLinkAllowed, opsMerge, opsRoute } from "@vectordevai/app/ops"
import { Egress } from "@vectordevai/core/local-mode/egress"
import { EgressGuard } from "@vectordevai/core/local-mode/guard"
import { ModelPlanStatus } from "@vectordevai/core/model-plan-status"
import { ShipDesk } from "@vectordevai/schema/ship-desk"
import type { GithubAccess, GithubRepoRef } from "./github-api"

// Production checks on the desktop (WP A50): Settings → Production asks the main process, which holds the account token,
// and the main process asks vectordev.ai. The token never reaches the renderer. Three things only:
//
// - `request`: one of the requests the screens may make (packages/app/src/features/cloud/ops/ops-requests.ts), checked
//   by shape here; vectordev.ai checks everything again and decides from the plan (S1).
// - `image`: a Ship Desk screenshot, through the 60-second signed link vectordev.ai gives: the link must point at
//   Cloudflare R2, no redirect is followed, at most 5 MB is read, and only a PNG or WebP by its signature is handed to
//   the renderer, as a data URL (the renderer's CSP shows images from data: only).
// - `merge`: Undo (a revert pull request) or Approve (a Ship Desk card) merged with the person's own GitHub sign-in in
//   Vector, at the commit the card showed, so a commit nobody looked at is never merged. Vector's server never merges
//   (S9); this is the person's own merge from their own computer.
//
// Requests are Vector Local's `production-checks` source (blocked under Vector Local); merges are its `github` source.

export type OpsResult =
  | { ok: true; body: Record<string, unknown> }
  | { ok: false; status?: number; code?: string; message: string }
export type OpsImageResult = { ok: true; src: string } | { ok: false; message: string }
export type OpsMergeResult = { ok: true; message: string } | { ok: false; code?: string; message: string }

type MergeStrategy = "squash" | "merge" | "rebase"
type Dependencies = {
  token(): Promise<string | undefined>
  /** The network, through Vector Local's guard for `production-checks`. */
  fetch?: (url: string, init: RequestInit) => Promise<Response>
  /** The person's GitHub sign-in in Vector (github-access.ts). */
  github(): Promise<GithubAccess | undefined>
  /** GitHub's merge with that sign-in (github-pr.ts putPullRequestMerge). */
  merge(
    access: GithubAccess,
    repo: GithubRepoRef,
    number: number,
    merge: { strategy: MergeStrategy; head?: string },
  ): Promise<unknown>
  site?: string
}

const ANSWER_BYTES = 256 * 1024
const UNREACHABLE = "Vector could not reach vectordev.ai. Check your connection and try again."
const LOCAL_OFF = "Vector Local keeps production checks off on this computer. Allow them in Settings → Vector Local."

function apiError(payload: unknown) {
  const error = payload && typeof payload === "object" && "error" in payload ? payload.error : undefined
  if (!error || typeof error !== "object") return undefined
  const code = "code" in error && typeof error.code === "string" ? error.code : undefined
  const message =
    "message" in error && typeof error.message === "string" && error.message.trim()
      ? error.message.trim().slice(0, 300)
      : undefined
  return { code, message }
}

async function limitedBytes(response: Response, limit: number) {
  const reader = response.body?.getReader()
  if (!reader) return new Uint8Array()
  const chunks: Uint8Array[] = []
  let length = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    length += value.byteLength
    if (length > limit) {
      await reader.cancel().catch(() => undefined)
      return undefined
    }
    chunks.push(value)
  }
  const bytes = new Uint8Array(length)
  let at = 0
  for (const chunk of chunks) {
    bytes.set(chunk, at)
    at += chunk.byteLength
  }
  return bytes
}

export function createDesktopOps(deps: Dependencies) {
  const site = deps.site ?? ModelPlanStatus.SITE
  const send = (url: string, init: RequestInit) =>
    Egress.fetch(
      "production-checks",
      url,
      init,
      deps.fetch ? (target, options) => deps.fetch!(String(target), options ?? {}) : undefined,
    )

  async function request(input: unknown): Promise<OpsResult> {
    const route = opsRoute(input)
    if (!route) return { ok: false, message: "Vector could not send that to production checks." }
    const secret = await deps.token().catch(() => undefined)
    if (!secret)
      return { ok: false, status: 401, code: "SIGN_IN", message: "Sign in to Vector to see production checks." }
    const response = await send(`${site}${route.path}`, {
      method: route.method,
      headers: {
        accept: "application/json",
        authorization: `Bearer ${secret}`,
        ...(route.body ? { "content-type": "application/json" } : {}),
      },
      ...(route.body ? { body: JSON.stringify(route.body) } : {}),
      redirect: "error",
      signal: AbortSignal.timeout(20_000),
    }).catch((cause: unknown) => (cause instanceof Error ? cause : new Error(String(cause))))
    if (response instanceof EgressGuard.EgressBlocked) return { ok: false, code: "LOCAL_OFF", message: LOCAL_OFF }
    if (response instanceof Error) return { ok: false, message: UNREACHABLE }
    const text = await response.text().catch(() => "")
    let payload: unknown
    try {
      payload = text && text.length <= ANSWER_BYTES ? JSON.parse(text) : undefined
    } catch {
      payload = undefined
    }
    if (!response.ok) {
      const error = apiError(payload)
      return {
        ok: false,
        status: response.status,
        ...(error?.code ? { code: error.code } : {}),
        message: error?.message ?? "Vector could not load production checks. Try again shortly.",
      }
    }
    if (!payload || typeof payload !== "object" || Array.isArray(payload))
      return { ok: false, message: "Vector could not read production checks. Try again shortly." }
    return { ok: true, body: payload as Record<string, unknown> }
  }

  async function image(input: unknown): Promise<OpsImageResult> {
    const value = input && typeof input === "object" ? (input as Record<string, unknown>) : {}
    const answer = await request({ kind: "image", card: value.card, n: value.n })
    if (!answer.ok) return { ok: false, message: answer.message }
    const url = typeof answer.body.url === "string" ? answer.body.url : ""
    if (!imageLinkAllowed(url)) return { ok: false, message: "Vector could not load this screenshot." }
    const response = await send(url, { redirect: "error", signal: AbortSignal.timeout(20_000) }).catch(() => undefined)
    if (!response?.ok) {
      await response?.body?.cancel().catch(() => undefined)
      return { ok: false, message: "Vector could not load this screenshot." }
    }
    const bytes = await limitedBytes(response, ShipDesk.LIMITS.imageBytes).catch(() => undefined)
    const sniffed = bytes ? ShipDesk.sniffImage(bytes) : undefined
    if (!bytes || !sniffed) return { ok: false, message: "This screenshot is not a picture Vector shows." }
    return { ok: true, src: `data:${sniffed.type};base64,${Buffer.from(bytes).toString("base64")}` }
  }

  async function merge(input: unknown): Promise<OpsMergeResult> {
    const target = opsMerge(input)
    if (!target) return { ok: false, message: "Vector could not merge that pull request." }
    const access = await deps.github().catch(() => undefined)
    if (!access)
      return {
        ok: false,
        code: "GITHUB_SIGN_IN",
        message: "Sign in to GitHub in Vector to merge here, or open the pull request in GitHub.",
      }
    const [owner, name] = target.repository.split("/") as [string, string]
    // The repository's allowed merge methods decide: GitHub answers 405 for one it does not allow.
    for (const strategy of ["squash", "merge", "rebase"] as const) {
      try {
        await deps.merge(access, { owner, name }, target.number, {
          strategy,
          ...(target.headSha ? { head: target.headSha } : {}),
        })
        return { ok: true, message: `Merged #${target.number} in ${target.repository}.` }
      } catch (cause) {
        const status = (cause as { status?: unknown } | null)?.status
        if (status === 405) continue
        // GitHub answers 409 when the branch moved past the commit the card showed: nobody has looked at that commit.
        if (status === 409)
          return {
            ok: false,
            code: "GITHUB_REFUSED",
            message: "New commits landed on this pull request after Vector showed it. Open it in GitHub to review them.",
          }
        if (status === 401 || status === 403 || status === 404)
          return {
            ok: false,
            code: "GITHUB_REFUSED",
            message: "Your GitHub sign-in cannot merge this pull request. Open it in GitHub instead.",
          }
        const message =
          cause instanceof Error && cause.message ? cause.message.slice(0, 300) : "GitHub did not merge it."
        return { ok: false, message }
      }
    }
    return {
      ok: false,
      code: "GITHUB_REFUSED",
      message: "GitHub would not merge this pull request yet (a check or review may be required). Open it in GitHub.",
    }
  }

  return { request, image, merge }
}
