import path from "path"
import { existsSync } from "fs"
import { lazy } from "./util/lazy"

export * as WindowsSystem from "./windows-system"

// Windows system tools Vector runs itself, always by absolute path: a bare name would resolve through PATH and, on
// Windows, the working folder first. Windows is taken to live in C:\Windows, as config/managed.ts does.
const WINDOWS = "C:\\Windows"

const taskkillIn = (root: string) => path.win32.join(root, "System32", "taskkill.exe")

/** The fixed C:\Windows taskkill.exe, and the path used when no system copy is found. */
export const TASKKILL = taskkillIn(WINDOWS)

/** The taskkill.exe Windows tree kills run, found on the first kill, so other platforms never look. */
export const taskkill = lazy(() => findTaskkill(process.env, existsSync))

/**
 * C:\Windows's taskkill.exe when it exists. Otherwise, for a Windows installed on another drive or folder, the copy
 * under SystemRoot, but only when SystemRoot is a plain local drive path and the copy is there. Otherwise the fixed
 * path, whose kill then fails as before.
 *
 * Unlike config/managed.ts, which never reads company policy through a tool SystemRoot points at, a tree kill only
 * stops Vector's own children as the user, so the user's SystemRoot is trusted once C:\Windows has no copy.
 */
export function findTaskkill(env: Readonly<Record<string, string | undefined>>, exists: (file: string) => boolean) {
  if (exists(TASKKILL)) return TASKKILL
  const root = env.SystemRoot
  // path.win32.isAbsolute alone also takes \\server\share, \\?\ and a drive-less \Windows; normalize() rewrites . and
  // .. parts, forward slashes and doubled separators.
  if (!root || !path.win32.isAbsolute(root) || !/^[a-z]:/i.test(root) || path.win32.normalize(root) !== root)
    return TASKKILL
  const found = taskkillIn(root)
  return exists(found) ? found : TASKKILL
}

/** taskkill's argv for a forced kill of `pid` and its whole tree. */
export const taskkillArgs = (pid: number) => ["/pid", String(pid), "/T", "/F"]
