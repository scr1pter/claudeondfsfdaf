// How the two lock implementations, flock.ts and effect-flock.ts, treat a file system error. Both read these rules from
// here, so they retry, ignore and report the same errors.
export namespace LockFs {
  /** How long a lock file operation keeps retrying an error that clears by itself before it reports it. */
  export const TRANSIENT_WINDOW_MS = 2_000
  export const TRANSIENT_BASE_DELAY_MS = 10
  export const TRANSIENT_MAX_DELAY_MS = 250

  // Windows reports a path whose delete is still pending as EPERM (ACCESS_DENIED), a file another process holds open as
  // EBUSY (SHARING_VIOLATION or DELETE_PENDING), and a directory whose entries are still being deleted as ENOTEMPTY.
  // They clear once the other handle closes, usually within milliseconds. EMFILE and ENFILE clear once descriptors are
  // freed. A lock root that is really unwritable also reports EPERM on Windows, so these are retried for a short window
  // and then reported, never left to the five-minute lock timeout. EACCES is reported at once.
  const transient = new Set(["EBUSY", "EPERM", "ENOTEMPTY", "EMFILE", "ENFILE"])
  // The path, or a directory on the way to it, no longer exists.
  const gone = new Set(["ENOENT", "ENOTDIR"])

  function field(value: unknown, key: string): unknown {
    if (typeof value !== "object" || value === null) return undefined
    return Reflect.get(value, key)
  }

  /** The errno code of a Node error, or of the system error inside an Effect PlatformError. */
  export function code(err: unknown): string | undefined {
    const direct = field(err, "code")
    if (typeof direct === "string") return direct
    const nested = field(field(field(err, "reason"), "cause"), "code")
    if (typeof nested === "string") return nested
    return undefined
  }

  // An Effect PlatformError's reason tag, for an error that carries no errno code.
  function tag(err: unknown) {
    const value = field(field(err, "reason"), "_tag")
    return typeof value === "string" ? value : undefined
  }

  export function isGone(err: unknown) {
    const value = code(err)
    return value ? gone.has(value) : tag(err) === "NotFound"
  }

  export function isTransient(err: unknown) {
    const value = code(err)
    return value ? transient.has(value) : tag(err) === "Busy"
  }

  export function isExists(err: unknown) {
    const value = code(err)
    return value ? value === "EEXIST" : tag(err) === "AlreadyExists"
  }

  export function nextDelay(delay: number) {
    return Math.min(TRANSIENT_MAX_DELAY_MS, delay * 2)
  }

  /** The error's message, with its errno code when the message does not already name it. */
  export function describe(err: unknown) {
    const text = err instanceof Error ? err.message : String(err)
    const value = code(err)
    return value && !text.includes(value) ? `${text} (${value})` : text
  }

  export function compromised(lockDir: string, detail: string) {
    return `Lock compromised at ${lockDir}: ${detail}`
  }

  /**
   * Why an exclusive create of the lock's heartbeat or meta.json file failed, and, when deleting the lock dir after it
   * failed too, why.
   */
  export function writeFailed(name: string, err: unknown, removal?: { readonly error: unknown }) {
    const detail = isExists(err) ? `${name} already existed` : `${name} could not be created: ${describe(err)}`
    return removal ? `${detail}; removing the lock dir failed: ${describe(removal.error)}` : detail
  }

  export function notRemoved(lockDir: string, err: unknown) {
    return `Lock dir ${lockDir} could not be removed on release: ${describe(err)}`
  }
}
