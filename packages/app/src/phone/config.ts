// The phone app (WP A38): one web app on one origin for every phone surface. Remote's sessions, approvals and devices,
// the cloud computer's live view, the production (ops) cards and phone alerts all live on this origin, under one
// service worker, so a phone installs Vector once and grants notifications and the camera once (contract §6.1 and
// appendix A item 7). The server pieces it talks to are on the same origin (`/api/...`), so the CSP needs no API host.

/** The phone app's origin. The server's `VECTOR_PHONE_APP_ORIGIN` names the same one. */
export const PHONE_ORIGIN = "https://remote.vectordev.ai"

/** Where the bundle is served on that origin. Every page, asset, the manifest and the worker live under it. */
export const PHONE_BASE = "/phone/"

/**
 * The service worker's script and its scope. The scope is the whole origin, wider than the script's folder, which
 * the `Service-Worker-Allowed: /` header on the script allows (vercel.json): one worker for every phone surface.
 */
export const PHONE_SW_URL = "/phone/sw.js"
export const PHONE_SW_SCOPE = "/"

/** The deployed build's version file, read with no cache for the version handshake (version.ts). */
export const PHONE_VERSION_URL = "/phone/version.json"

/** The website pages the phone links out to. */
export const SITE = "https://vectordev.ai"
export const MANAGE_URL = `${SITE}/account`
export const PLANS_URL = `${SITE}/codium`

/** A path inside the phone app for one of its routes, or its home. */
export function phonePath(route?: string) {
  return route ? `${PHONE_BASE}${route}` : PHONE_BASE
}
