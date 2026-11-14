import { isComputerOverlay } from "./computer-overlay-registry"

type StatusWindow = {
  isDestroyed(): boolean
  webContents: { send(channel: string, status: unknown): void }
}

/** Remote and Vault state belongs to ordinary renderers, never the restricted Hands overlay. */
export function broadcastRendererStatus(
  windows: readonly StatusWindow[],
  channel: "remote-changed" | "vault-changed",
  status: unknown,
) {
  for (const window of windows)
    if (!window.isDestroyed() && !isComputerOverlay(window)) window.webContents.send(channel, status)
}
