// The prompt-trust banner's rules (section 8.3), apart from the component so they can be tested on their own.

/** A held prompt file as the server lists it: its fingerprint now, none for a file that is gone. */
export type HeldFile = { readonly path: string; readonly fingerprint?: string }

/**
 * Events after which the held list may have changed: an instance reloaded and worked out its hold again, or the server
 * restarted or reconnected. A reload may be any directory's, since paths are spelled differently; a read is cheap.
 */
const REFRESH = new Set(["server.instance.disposed", "global.disposed", "server.connected"])

export function refreshes(type: string | undefined) {
  return type !== undefined && REFRESH.has(type)
}

/** What Approve sends: exactly the files the banner shows, with the fingerprints they had when it read them. */
export function approval(files: readonly HeldFile[]) {
  return {
    files: files.map((file) =>
      file.fingerprint ? { path: file.path, fingerprint: file.fingerprint } : { path: file.path },
    ),
  }
}

/** What an approval's answer means: approved, refused because the held files changed since they were read, or failed. */
export function outcome(status: number) {
  if (status === 409) return "changed" as const
  return status >= 200 && status < 300 ? ("approved" as const) : ("failed" as const)
}
