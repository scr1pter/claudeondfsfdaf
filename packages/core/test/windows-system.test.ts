import { expect, test } from "bun:test"
import { WindowsSystem } from "../src/windows-system"

// F7: taskkill is the fixed system copy in C:\Windows, never one found on PATH, in the working folder or under a
// SystemRoot the user moved.
test("taskkill is the fixed C:\\Windows copy, and its argv kills one pid's whole tree", () => {
  expect(WindowsSystem.TASKKILL).toBe("C:\\Windows\\System32\\taskkill.exe")
  expect(WindowsSystem.taskkillArgs(4242)).toEqual(["/pid", "4242", "/T", "/F"])
})
