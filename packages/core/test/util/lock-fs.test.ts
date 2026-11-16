import { describe, expect, test } from "bun:test"
import * as PlatformError from "effect/PlatformError"
import { LockFs } from "@vectordevai/core/util/lock-fs"

function nodeError(code: string) {
  return Object.assign(new Error(`${code}: injected, rm '/locks/a.lock'`), { code })
}

// As Effect's Node file system reports one (handleErrnoException in @effect/platform-node-shared).
function platformError(tag: PlatformError.SystemErrorTag, code?: string) {
  return PlatformError.systemError({
    _tag: tag,
    module: "FileSystem",
    method: "remove",
    pathOrDescriptor: "/locks/a.lock",
    cause: code ? nodeError(code) : undefined,
  })
}

describe("util.lock-fs", () => {
  test("retries the errors Windows gives a pending delete or an open handle, the same for both error shapes", () => {
    for (const code of ["EBUSY", "EPERM", "ENOTEMPTY", "EMFILE", "ENFILE"]) {
      expect(LockFs.isTransient(nodeError(code))).toBe(true)
      expect(LockFs.isTransient(platformError(code === "EBUSY" ? "Busy" : "Unknown", code))).toBe(true)
    }
    for (const code of ["EACCES", "EEXIST", "ENOENT", "EIO", "EROFS"]) {
      expect(LockFs.isTransient(nodeError(code))).toBe(false)
    }
    expect(LockFs.isTransient(platformError("PermissionDenied", "EACCES"))).toBe(false)
    expect(LockFs.isTransient(platformError("Unknown", "EIO"))).toBe(false)
    // Without an errno code, only the Busy reason is transient.
    expect(LockFs.isTransient(platformError("Busy"))).toBe(true)
    expect(LockFs.isTransient(platformError("Unknown"))).toBe(false)
  })

  test("counts only a missing path as already gone", () => {
    expect(LockFs.isGone(nodeError("ENOENT"))).toBe(true)
    expect(LockFs.isGone(nodeError("ENOTDIR"))).toBe(true)
    expect(LockFs.isGone(platformError("NotFound", "ENOENT"))).toBe(true)
    expect(LockFs.isGone(platformError("NotFound"))).toBe(true)
    expect(LockFs.isGone(nodeError("EPERM"))).toBe(false)
    expect(LockFs.isGone(platformError("Unknown", "EPERM"))).toBe(false)
    expect(LockFs.isGone(platformError("Unknown"))).toBe(false)
  })

  test("caps the retry delay", () => {
    const delays = [LockFs.TRANSIENT_BASE_DELAY_MS]
    while (delays.length < 8) delays.push(LockFs.nextDelay(delays[delays.length - 1]))
    expect(delays).toEqual([10, 20, 40, 80, 160, 250, 250, 250])
  })

  test("names the errno code when the message does not", () => {
    expect(LockFs.describe(platformError("Unknown", "EPERM"))).toBe(
      "Unknown: FileSystem.remove (/locks/a.lock) (EPERM)",
    )
    expect(LockFs.describe(nodeError("EPERM"))).toBe("EPERM: injected, rm '/locks/a.lock'")
    expect(LockFs.writeFailed("heartbeat", nodeError("EEXIST"))).toBe("heartbeat already existed")
    expect(LockFs.writeFailed("heartbeat", platformError("AlreadyExists"))).toBe("heartbeat already existed")
    expect(LockFs.writeFailed("meta.json", nodeError("ENOSPC"), { error: nodeError("EACCES") })).toBe(
      "meta.json could not be created: ENOSPC: injected, rm '/locks/a.lock'; " +
        "removing the lock dir failed: EACCES: injected, rm '/locks/a.lock'",
    )
    expect(LockFs.compromised("/locks/a.lock", "heartbeat already existed")).toBe(
      "Lock compromised at /locks/a.lock: heartbeat already existed",
    )
  })
})
