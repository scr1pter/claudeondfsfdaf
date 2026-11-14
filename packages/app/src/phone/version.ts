// The phone app's version handshake (WP A38), two halves.
//
// 1. With the server. The phone app is a web app a phone keeps open for days, and its service worker outlives every
//    tab. Each deploy writes `/phone/version.json` ({build, protocol, minDesktop}); the running app reads it with no
//    cache when it starts and when it comes back to the front, and reloads once onto a newer build (`staleBuild`,
//    `shouldReload`). A new service worker takes over at once (sw.ts), so alerts are decoded by the new code too.
// 2. With the desktop. Remote (A41/A42) opens every encrypted connection with a hello naming each side's protocol and
//    the oldest peer it still speaks; `negotiate` picks the protocol both speak or says which side must update. A
//    phone never guesses at a desktop message it does not understand.

declare const __VECTOR_PHONE_BUILD__: string | undefined

/** The Remote protocol this phone app speaks. Raised only with a desktop release that speaks it too. */
export const PHONE_PROTOCOL = 1
/** The oldest desktop protocol this phone app still speaks. */
export const PHONE_MIN_DESKTOP_PROTOCOL = 1

/** This bundle's build id (set by the phone build), or "dev" outside a build. */
export function phoneBuild(): string {
  return typeof __VECTOR_PHONE_BUILD__ === "string" && __VECTOR_PHONE_BUILD__ ? __VECTOR_PHONE_BUILD__ : "dev"
}

export type DeployedVersion = { build: string; protocol: number; minDesktop: number }

const BUILD = /^[A-Za-z0-9._-]{1,64}$/

/** The deployed `version.json`, or undefined when it is not one. */
export function decodeVersion(body: unknown): DeployedVersion | undefined {
  if (!body || typeof body !== "object" || Array.isArray(body)) return undefined
  const value = body as Record<string, unknown>
  if (typeof value.build !== "string" || !BUILD.test(value.build)) return undefined
  if (!isProtocol(value.protocol) || !isProtocol(value.minDesktop) || value.minDesktop > value.protocol)
    return undefined
  return { build: value.build, protocol: value.protocol, minDesktop: value.minDesktop }
}

/** The `version.json` a build writes for itself. */
export function versionFile(build: string): DeployedVersion {
  return { build, protocol: PHONE_PROTOCOL, minDesktop: PHONE_MIN_DESKTOP_PROTOCOL }
}

/** Whether a newer build is deployed than the one running. A development bundle never reloads itself. */
export function staleBuild(running: string, deployed: DeployedVersion | undefined) {
  return running !== "dev" && deployed !== undefined && deployed.build !== running
}

/**
 * Whether to reload onto the deployed build now: only when it is newer and this tab has not already reloaded for that
 * same build (a CDN still serving the older bundle would otherwise reload forever).
 */
export function shouldReload(running: string, deployed: DeployedVersion | undefined, reloadedFor: string | null) {
  return staleBuild(running, deployed) && deployed!.build !== reloadedFor
}

/** One side's hello on a Remote connection. */
export type Hello = { protocol: number; minPeer: number }

export type Handshake = { ok: true; protocol: number } | { ok: false; update: "phone" | "desktop" }

/**
 * The protocol a phone and a desktop use, or which of them must update: the newer side keeps speaking the older one
 * as long as that is not below its own minimum. A malformed hello is treated as a desktop too old to talk to.
 */
export function negotiate(phone: Hello, desktop: unknown): Handshake {
  const peer = decodeHello(desktop)
  if (!peer) return { ok: false, update: "desktop" }
  if (peer.protocol < phone.minPeer) return { ok: false, update: "desktop" }
  if (phone.protocol < peer.minPeer) return { ok: false, update: "phone" }
  return { ok: true, protocol: Math.min(phone.protocol, peer.protocol) }
}

/** This phone app's own hello. */
export function phoneHello(): Hello {
  return { protocol: PHONE_PROTOCOL, minPeer: PHONE_MIN_DESKTOP_PROTOCOL }
}

function decodeHello(value: unknown): Hello | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
  const hello = value as Record<string, unknown>
  if (!isProtocol(hello.protocol) || !isProtocol(hello.minPeer) || hello.minPeer > hello.protocol) return undefined
  return { protocol: hello.protocol, minPeer: hello.minPeer }
}

function isProtocol(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1 && value <= 1_000
}
