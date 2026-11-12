import { describe, expect, test } from "bun:test"
import { isTrustedRendererEvent } from "./trusted-renderer"
import { readFile } from "node:fs/promises"

const event = (url: string, topLevel = "vector://renderer/index.html") =>
  ({
    sender: {
      isDestroyed: () => false,
      getURL: () => topLevel,
    },
    senderFrame: { url },
  }) as never

describe("trusted renderer IPC", () => {
  test("GitHub agent methods are fixed preload calls registered through the trusted-frame guard", async () => {
    const [main, preload] = await Promise.all([
      readFile(new URL("./ipc.ts", import.meta.url), "utf8"),
      readFile(new URL("../preload/index.ts", import.meta.url), "utf8"),
    ])
    const names = [
      "status",
      "setup-preview",
      "setup",
      "bind",
      "run",
      "schedules",
      "bindings",
      "unbind",
      "runs",
      "brain-preview",
      "returned-artifacts",
      "returned-preview",
      "returned-import",
    ]
    for (const name of names) {
      expect(main).toMatch(new RegExp('handle\\(\\s*"github-agents-' + name + '"'))
      expect(preload).toContain('ipcRenderer.invoke("github-agents-' + name + '"')
    }
    expect(main).toContain("assertTrustedRenderer(event)")
    expect(main).not.toMatch(/ipcMain\.handle\(\s*["']github-agents-/)
  })
  test("rejects WSL requests sent by an untrusted child frame", () => {
    const trusted = isTrustedRendererEvent(event("https://attacker.example"), {
      windowFor: () => ({}),
      trustedUrl: (url) => url === "vector://renderer/index.html",
    })

    expect(trusted).toBe(false)
  })

  test("accepts the trusted renderer frame", () => {
    const trusted = isTrustedRendererEvent(event("vector://renderer/index.html"), {
      windowFor: () => ({}),
      trustedUrl: (url) => url === "vector://renderer/index.html",
    })

    expect(trusted).toBe(true)
  })
})
