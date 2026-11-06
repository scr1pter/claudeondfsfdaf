import { describe, expect, test } from "bun:test"
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { browserPaths, wipeBrowser } from "../src/wipe"

// WP A54: after every job the browser's profile (cookies, sign-ins, history, cache), its home and Chromium's scratch
// files are deleted, and empty folders made again. Links are removed, never followed.

describe("the profile wipe", () => {
  test("everything the browser kept is deleted and fresh, empty folders remain", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "vector-wipe-"))
    try {
      const browserDir = path.join(root, "run", "browser")
      const scratch = path.join(root, "tmp")
      const outside = path.join(root, "precious")
      const { profile, home } = browserPaths(browserDir)
      mkdirSync(path.join(profile, "Default"), { recursive: true })
      mkdirSync(home, { recursive: true })
      mkdirSync(scratch, { recursive: true })
      mkdirSync(outside, { recursive: true })
      writeFileSync(path.join(profile, "Default", "Cookies"), "session=1")
      writeFileSync(path.join(profile, "Default", "Login Data"), "saved")
      writeFileSync(path.join(home, ".pki"), "x")
      writeFileSync(path.join(outside, "keep.txt"), "keep")
      symlinkSync(outside, path.join(profile, "link-out"))
      writeFileSync(path.join(scratch, ".org.chromium.Chromium.abc"), "x")
      writeFileSync(path.join(scratch, "agent-notes.txt"), "keep")
      expect(await wipeBrowser({ browserDir, scratch: [scratch], uid: undefined })).toBe(3)
      expect(readdirSync(profile)).toEqual([])
      expect(readdirSync(home)).toEqual([])
      expect(existsSync(path.join(scratch, ".org.chromium.Chromium.abc"))).toBe(false)
      expect(existsSync(path.join(scratch, "agent-notes.txt"))).toBe(true)
      // The link was removed; what it pointed to was not touched.
      expect(existsSync(path.join(outside, "keep.txt"))).toBe(true)
      expect((lstatSync(profile).mode & 0o777).toString(8)).toBe("700")
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("a browser folder that is a link, or a folder too near the root, is refused", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "vector-wipe-"))
    try {
      const target = path.join(root, "target")
      mkdirSync(target)
      writeFileSync(path.join(target, "keep"), "x")
      symlinkSync(target, path.join(root, "browser"))
      await expect(wipeBrowser({ browserDir: path.join(root, "browser"), scratch: [], uid: undefined })).rejects.toThrow()
      expect(existsSync(path.join(target, "keep"))).toBe(true)
      await expect(wipeBrowser({ browserDir: "/", scratch: [], uid: undefined })).rejects.toThrow()
      await expect(wipeBrowser({ browserDir: "/tmp", scratch: [], uid: undefined })).rejects.toThrow()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
