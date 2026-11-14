import { hostname } from "node:os"

// Where this computer meets its phones (WP A41; split out of remote-pairing.ts in WP A42 so the pairing, link and
// route modules carry no Node import and also run in a browser, where the phone app's end-to-end check drives them).
// Everything that reads the process, its environment or the computer's own name is here.

/** The phone app's origin (contract §4.16 VECTOR_PHONE_APP_ORIGIN; A38's PHONE_APP_ADDRESS). */
export const PHONE_APP_ORIGIN = "https://remote.vectordev.ai"

/**
 * The phone app's origin passkeys and pairing links must use. A development build may name a local phone app with
 * VECTOR_PHONE_APP_ORIGIN (https, or http on localhost); a packaged app always uses Vector's own.
 */
export function phoneAppOrigin(packaged: boolean, env: Record<string, string | undefined> = process.env) {
  const override = env.VECTOR_PHONE_APP_ORIGIN?.trim()
  if (packaged || !override) return PHONE_APP_ORIGIN
  try {
    const url = new URL(override)
    const local = url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname)
    if ((url.protocol === "https:" || local) && url.origin === override) return override
  } catch {}
  return PHONE_APP_ORIGIN
}

/** The plain kind of computer the relay lists this one as. Its own name never leaves it unencrypted. */
export function relayName(platform = process.platform) {
  return platform === "darwin" ? "Mac" : platform === "win32" ? "Windows PC" : "Linux computer"
}

/** This computer's name, as its paired phones show it. */
export function computerName(name = hostname(), platform = process.platform) {
  const plain = name
    .replace(/\.(?:local|lan|home)$/i, "")
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .trim()
  return (plain || relayName(platform)).slice(0, 64)
}
