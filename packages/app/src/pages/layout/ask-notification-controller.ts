import type { Event, PermissionRequest } from "@vectordevai/sdk/v2/client"
import { base64Encode } from "@vectordevai/core/util/encode"
import { isInternalSession } from "../../utils/internal-sessions"
import { rendererNotifies } from "../layout-computer-notify"

type Session = { id: string; title?: string | null; parentID?: string; internal?: string }
type Kind = "permission" | "question"

/** Shared by both visual layouts; only observed asks create alerts, never a re-read of a pending list. */
export function createAskNotificationController(input: {
  resolve(sessionID: string): Promise<Session | undefined>
  autoResponds(request: PermissionRequest, directory: string): boolean | Promise<boolean>
  desktopOwns(): boolean
  preferences(): { permissions: boolean; agent: boolean; permissionSound: boolean }
  copy(kind: Kind, session: Session, directory: string): { title: string; description: string }
  notify(title: string, description: string, href: string): unknown
  sound(): unknown
  phoneAlert?(session: Session): unknown
  viewed(session: Session, directory: string): boolean
  toast(kind: Kind, title: string, description: string, href: string): number
  dismissToast(id: number): void
  now?: () => number
}) {
  const toasts = new Map<string, number>()
  const alerted = new Map<string, number>()
  let closed = false
  const key = (directory: string, sessionID: string) => `${directory}:${sessionID}`
  function dismiss(directory: string, sessionID: string) {
    const sessionKey = key(directory, sessionID)
    const id = toasts.get(sessionKey)
    if (id === undefined) return
    input.dismissToast(id)
    toasts.delete(sessionKey)
    alerted.delete(sessionKey)
  }

  return {
    dismiss,
    async observe(event: { name: string; details: Event }) {
      if (closed) return
      const detail = event.details
      if (
        detail.type === "permission.replied" ||
        detail.type === "question.replied" ||
        detail.type === "question.rejected"
      ) {
        dismiss(event.name, detail.properties.sessionID)
        return
      }
      if (detail.type !== "permission.asked" && detail.type !== "question.asked") return
      if (detail.type === "permission.asked" && (await input.autoResponds(detail.properties, event.name))) return
      if (closed) return
      const session = await input.resolve(detail.properties.sessionID).catch(() => undefined)
      if (closed || !session || isInternalSession(session)) return
      const sessionKey = key(event.name, detail.properties.sessionID)
      const now = (input.now ?? Date.now)()
      if (now - (alerted.get(sessionKey) ?? 0) < 5000) return
      alerted.set(sessionKey, now)
      const kind = detail.type === "permission.asked" ? "permission" : "question"
      const copy = input.copy(kind, session, event.name)
      const href = `/${base64Encode(event.name)}/session/${detail.properties.sessionID}`
      void input.phoneAlert?.(session)
      const notifies = rendererNotifies(detail, input.desktopOwns())
      const preferences = input.preferences()
      if (kind === "permission" && preferences.permissionSound) void input.sound()
      if (notifies && (kind === "permission" ? preferences.permissions : preferences.agent))
        void input.notify(copy.title, copy.description, href)
      if (input.viewed(session, event.name)) return
      dismiss(event.name, detail.properties.sessionID)
      toasts.set(sessionKey, input.toast(kind, copy.title, copy.description, href))
    },
    close() {
      if (closed) return
      closed = true
      for (const id of toasts.values()) input.dismissToast(id)
      toasts.clear()
      alerted.clear()
    },
  }
}
