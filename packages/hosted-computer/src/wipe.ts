import { chown, lstat, mkdir, readdir, rm } from "node:fs/promises"
import path from "node:path"
import { BROWSER_UID, RUN_DIR } from "./limits"

/*
 * The browser profile wipe (contract WP A54): after every job, with the browser stopped, everything the browser kept is
 * deleted: its profile (cookies, saved sign-ins, history, cache, site data), its home, and the scratch files Chromium
 * leaves in /tmp and /dev/shm. Nothing of one job's browsing is left for the next. The browser's folders live on a
 * memory disk, so a stopped computer keeps none of it either. Links are removed, never followed.
 */

export type WipeOptions = {
  /** Where the browser's profile and home live (`/run/vector/browser`). */
  browserDir?: string
  /** Scratch folders scanned for Chromium's leftovers. */
  scratch?: readonly string[]
  /** Who owns the fresh, empty folders; undefined leaves the caller as owner (tests). */
  uid?: number | undefined
}

const LEFTOVER = /^\.(?:org\.chromium\.|com\.google\.Chrome\.)/

/** The browser's profile and home under `browserDir`. */
export function browserPaths(browserDir = path.join(RUN_DIR, "browser")) {
  return { profile: path.join(browserDir, "profile"), home: path.join(browserDir, "home") }
}

/**
 * Wipes the browser's data. The browser must already be stopped. Answers the number of entries removed. Refuses a
 * browser folder that is a link or not where hostd keeps it.
 */
export async function wipeBrowser(options: WipeOptions = {}) {
  const browserDir = path.resolve(options.browserDir ?? path.join(RUN_DIR, "browser"))
  if (browserDir === "/" || browserDir.split(path.sep).length < 3) throw new Error("Refusing to wipe that folder.")
  const info = await lstat(browserDir).catch(() => undefined)
  if (info && !info.isDirectory()) throw new Error("The browser folder is not a folder.")
  let removed = 0
  if (info)
    for (const entry of await readdir(browserDir)) {
      await rm(path.join(browserDir, entry), { recursive: true, force: true })
      removed++
    }
  for (const scratch of options.scratch ?? ["/tmp", "/dev/shm"]) {
    const entries = await readdir(scratch).catch(() => [] as string[])
    for (const entry of entries.filter((name) => LEFTOVER.test(name))) {
      await rm(path.join(scratch, entry), { recursive: true, force: true })
      removed++
    }
  }
  const uid = "uid" in options ? options.uid : BROWSER_UID
  await mkdir(browserDir, { recursive: true, mode: 0o755 })
  for (const folder of Object.values(browserPaths(browserDir))) {
    await mkdir(folder, { recursive: true, mode: 0o700 })
    if (uid !== undefined) await chown(folder, uid, uid)
  }
  return removed
}
