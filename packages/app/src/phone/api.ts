import type { PhoneSession } from "./auth"
import { decodePhoneStatus, type PhoneStatus } from "./status"

// The phone app's calls to Vector's API (WP A38). They go to its own origin: the site's API answers on the phone origin
// too, so the CSP's connect-src needs no other Vector host and no request is cross-origin. The account session is
// sent as a bearer token, never a cookie.

type Fetch = (input: string, init?: RequestInit) => Promise<Response>

export class PhoneApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | undefined,
    message: string,
  ) {
    super(message)
  }
}

export async function phoneApi(
  path: string,
  session: PhoneSession | undefined,
  init: { method?: string; body?: unknown } = {},
  fetcher: Fetch = fetch,
): Promise<Record<string, unknown>> {
  if (!path.startsWith("/api/")) throw new Error("The phone app calls only its own API.")
  const response = await fetcher(path, {
    method: init.method ?? "GET",
    headers: {
      accept: "application/json",
      ...(init.body === undefined ? {} : { "content-type": "application/json" }),
      ...(session ? { authorization: `Bearer ${session.accessToken}` } : {}),
    },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    credentials: "omit",
    redirect: "error",
    cache: "no-store",
  }).catch(() => undefined)
  if (!response) throw new PhoneApiError(0, undefined, "Vector could not be reached. Check your connection.")
  const body = (await response.json().catch(() => undefined)) as Record<string, unknown> | undefined
  if (!response.ok) {
    const error = body?.error && typeof body.error === "object" ? (body.error as Record<string, unknown>) : undefined
    const message = typeof error?.message === "string" && error.message.trim() ? error.message : "Something went wrong."
    throw new PhoneApiError(response.status, typeof error?.code === "string" ? error.code : undefined, message)
  }
  return body && typeof body === "object" && !Array.isArray(body) ? body : {}
}

/** The account's Codium status, read for the phone: what it lists and what the plan includes. */
export async function readPhoneStatus(session: PhoneSession, fetcher: Fetch = fetch): Promise<PhoneStatus> {
  return decodePhoneStatus(await phoneApi("/api/model-plans/status", session, {}, fetcher))
}
