import { isComputerOverlay } from "./computer-overlay-registry"

type RendererEvent = {
  sender: {
    isDestroyed: () => boolean
    getURL: () => string
  }
  senderFrame?: { url: string } | null
}

export function isTrustedRendererEvent<T extends RendererEvent>(
  event: T,
  checks: {
    windowFor: (contents: T["sender"]) => unknown
    trustedUrl: (url?: string) => boolean
  },
) {
  const window = checks.windowFor(event.sender)
  if (event.sender.isDestroyed() || !window || isComputerOverlay(window)) return false
  return checks.trustedUrl(event.senderFrame?.url ?? event.sender.getURL())
}
