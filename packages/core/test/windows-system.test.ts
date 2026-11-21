import { describe, expect, test } from "bun:test"
import { WindowsSystem } from "../src/windows-system"

// F7: taskkill is a system copy found by absolute path, never one found on PATH or in the working folder.
test("taskkill's fixed path is the C:\\Windows copy, and its argv kills one pid's whole tree", () => {
  expect(WindowsSystem.TASKKILL).toBe("C:\\Windows\\System32\\taskkill.exe")
  expect(WindowsSystem.taskkillArgs(4242)).toEqual(["/pid", "4242", "/T", "/F"])
})

describe("findTaskkill", () => {
  test("C:\\Windows's copy wins when it exists, whatever SystemRoot says", () => {
    expect(WindowsSystem.findTaskkill({ SystemRoot: "D:\\Windows" }, () => true)).toBe(
      "C:\\Windows\\System32\\taskkill.exe",
    )
  })

  test("a Windows installed on another drive is found through SystemRoot when C:\\Windows has no taskkill", () => {
    const files = ["D:\\Windows\\System32\\taskkill.exe"]
    expect(WindowsSystem.findTaskkill({ SystemRoot: "D:\\Windows" }, (file) => files.includes(file))).toBe(
      "D:\\Windows\\System32\\taskkill.exe",
    )
  })

  // Every file but the fixed one exists, so only the SystemRoot check stands between each value and a taskkill run
  // from it.
  test("a SystemRoot that is not a plain local drive path is never used", () => {
    const roots = [
      "Windows",
      "..\\Windows",
      "D:Windows",
      "\\Windows",
      "\\\\server\\share\\Windows",
      "\\\\?\\D:\\Windows",
      "\\\\.\\D:\\Windows",
      "D:\\Windows\\..\\Temp",
      "D:\\.\\Windows",
      "D:/Windows",
      "%SystemRoot%",
      "",
    ]
    expect(
      roots.map((root) => WindowsSystem.findTaskkill({ SystemRoot: root }, (file) => file !== WindowsSystem.TASKKILL)),
    ).toEqual(roots.map(() => WindowsSystem.TASKKILL))
  })

  test("nothing found keeps the fixed path, which then fails as before", () => {
    expect(WindowsSystem.findTaskkill({ SystemRoot: "D:\\Windows" }, () => false)).toBe(WindowsSystem.TASKKILL)
    expect(WindowsSystem.findTaskkill({}, () => false)).toBe(WindowsSystem.TASKKILL)
  })
})
