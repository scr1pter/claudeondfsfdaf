import { expect, test } from "bun:test"
import type { ServerConnection } from "@/context/server"
import { ServerScope } from "@/utils/server-scope"
import { desktopOwns, rendererNotifies } from "./layout-computer-notify"

const permission = (name: string) => ({ type: "permission.asked", properties: { permission: name } })
const question = (metadata?: unknown) => ({ type: "question.asked", properties: { metadata } })

const handoff = question({ computer: { kind: "handoff", app: "Mail", reason: "password" } })
const checkIn = question({ computer: { kind: "check_in", actions: 40, minutes: 5 } })

test("the renderer skips computer_* asks and handoff questions when platform.computer exists", () => {
  expect(rendererNotifies(permission("computer_app"), true)).toBe(false)
  expect(rendererNotifies(permission("computer_sensitive"), true)).toBe(false)
  expect(rendererNotifies(handoff, true)).toBe(false)
})

test("the same asks notify when the desktop does not own the run", () => {
  expect(rendererNotifies(permission("computer_app"), false)).toBe(true)
  expect(rendererNotifies(permission("computer_sensitive"), false)).toBe(true)
  expect(rendererNotifies(handoff, false)).toBe(true)
})

test("check-ins, ordinary permission asks and ordinary questions always notify", () => {
  for (const owned of [true, false]) {
    expect(rendererNotifies(checkIn, owned)).toBe(true)
    expect(rendererNotifies(permission("bash"), owned)).toBe(true)
    expect(rendererNotifies(permission("edit"), owned)).toBe(true)
    expect(rendererNotifies(question(), owned)).toBe(true)
    expect(rendererNotifies(question({ other: true }), owned)).toBe(true)
  }
})

test("only the exact handoff shape is skipped", () => {
  expect(rendererNotifies(question("handoff"), true)).toBe(true)
  expect(rendererNotifies(question([{ computer: { kind: "handoff" } }]), true)).toBe(true)
  expect(rendererNotifies(question({ computer: "handoff" }), true)).toBe(true)
  expect(rendererNotifies(question({ computer: [{ kind: "handoff" }] }), true)).toBe(true)
  expect(rendererNotifies(question({ computer: { kind: "Handoff" } }), true)).toBe(true)
  expect(rendererNotifies(question({ kind: "handoff" }), true)).toBe(true)
})

test("a permission ask with no name, or a prefix elsewhere in the name, still notifies", () => {
  expect(rendererNotifies({ type: "permission.asked", properties: {} }, true)).toBe(true)
  expect(rendererNotifies(permission("mcp_computer_app"), true)).toBe(true)
})

test("another tool's permission that shares the computer_ prefix still notifies", () => {
  // A plugin tool or an MCP server named "computer use" (`computer_use_<tool>`) can ask such an id; the desktop sends
  // nothing for it.
  expect(rendererNotifies(permission("computer_screenshot"), true)).toBe(true)
  expect(rendererNotifies(permission("computer_observe"), true)).toBe(true)
  expect(rendererNotifies(permission("computer_app_extra"), true)).toBe(true)
})

test("the desktop owns runs only on its built-in engine, never on another loopback server", () => {
  const scope = (key: string, canonical?: string) =>
    ServerScope.fromServerKey(key as ServerConnection.Key, canonical as ServerConnection.Key | undefined)
  const computer = { supported: true }
  expect(desktopOwns(computer, scope("sidecar"))).toBe(true)
  // The web build's own server is its canonical local server; only an injected platform.computer makes it owned.
  expect(desktopOwns(computer, scope("http://localhost:4096", "http://localhost:4096"))).toBe(true)
  expect(desktopOwns(computer, scope("http://localhost:4096"))).toBe(false)
  expect(desktopOwns(computer, scope("http://127.0.0.1:4096"))).toBe(false)
  expect(desktopOwns(computer, scope("wsl:Ubuntu"))).toBe(false)
  expect(desktopOwns(computer, scope("ssh:build-box"))).toBe(false)
  expect(desktopOwns({ supported: false }, scope("sidecar"))).toBe(false)
  expect(desktopOwns(undefined, scope("sidecar"))).toBe(false)
})
