import { expect, test } from "bun:test"
import { registerComputerOverlay } from "./computer-overlay-registry"
import { broadcastRendererStatus } from "./renderer-status"

test("Remote and Vault broadcasts exclude registered overlays and destroyed windows", () => {
  for (const channel of ["remote-changed", "vault-changed"] as const) {
    const sent: { target: string; channel: string; status: unknown }[] = []
    const window = (target: string, destroyed = false) => ({
      isDestroyed: () => destroyed,
      webContents: {
        send: (channel: string, status: unknown) => {
          sent.push({ target, channel, status })
        },
      },
    })
    const ordinary = window("ordinary")
    const overlay = window("overlay")
    registerComputerOverlay(overlay)
    const status = { state: "fixture" }
    broadcastRendererStatus([ordinary, overlay, window("destroyed", true)], channel, status)
    expect(sent).toEqual([{ target: "ordinary", channel, status }])
    // A live overlay remains excluded from subsequent broadcasts, regardless of the current status.
    broadcastRendererStatus([overlay], channel, { state: "changed" })
    expect(sent).toHaveLength(1)
  }
})
