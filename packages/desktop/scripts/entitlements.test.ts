import { expect, test } from "bun:test"
import { readFile } from "node:fs/promises"

test("the main app does not permit dyld environment injection and the helper has no entitlements", async () => {
  const main = await readFile(new URL("../resources/entitlements.plist", import.meta.url), "utf8")
  expect(main).not.toContain("com.apple.security.cs.allow-dyld-environment-variables")
  expect(main).toContain("com.apple.security.cs.allow-jit")
  const helper = await readFile(new URL("../native/computer-helper/macos/entitlements.plist", import.meta.url), "utf8")
  expect(helper.match(/<plist\b[^>]*>([\s\S]*?)<\/plist>/)?.[1]?.trim()).toMatch(
    /^(?:<dict\s*\/\s*>|<dict>\s*<\/dict>)$/,
  )
})
