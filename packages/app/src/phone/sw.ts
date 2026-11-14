import { readAlertKey } from "./alert-keys"
import { clickTarget, decodePushPayload, notificationFor, openAlert } from "./alerts"

// The phone app's one service worker (WP A38), registered for the whole phone origin. It shows phone alerts and opens
// the app where a tap points. It has no fetch handler: pages, the API and the live views always come from the network,
// so nothing an account sees is cached on the phone, and a deploy reaches the next load. The build bundles it into one
// classic script, /phone/sw.js.
//
// The DOM typings the app compiles against do not include a worker's scope, so it declares the little it uses.

type Extendable = { waitUntil(promise: Promise<unknown>): void }
type PushEventLike = Extendable & { data: { text(): string } | null }
type NotificationEventLike = Extendable & { notification: { data: unknown; close(): void } }
type WindowClientLike = { url: string; focus(): Promise<unknown>; navigate(url: string): Promise<unknown> }
type WorkerScope = {
  location: { origin: string }
  registration: { showNotification(title: string, options: Record<string, unknown>): Promise<void> }
  clients: {
    claim(): Promise<void>
    matchAll(options: { type: "window"; includeUncontrolled: boolean }): Promise<readonly WindowClientLike[]>
    openWindow(url: string): Promise<unknown>
  }
  skipWaiting(): Promise<void>
  addEventListener(type: "install" | "activate", listener: (event: Extendable) => void): void
  addEventListener(type: "push", listener: (event: PushEventLike) => void): void
  addEventListener(type: "notificationclick", listener: (event: NotificationEventLike) => void): void
}

const worker = self as unknown as WorkerScope

// A new build's worker takes over at once: it holds no cache an older page could depend on.
worker.addEventListener("install", (event) => event.waitUntil(worker.skipWaiting()))
worker.addEventListener("activate", (event) => event.waitUntil(worker.clients.claim()))

worker.addEventListener("push", (event) => {
  event.waitUntil(
    (async () => {
      let text: string | undefined
      try {
        text = event.data?.text()
      } catch {
        text = undefined
      }
      const alert = await openAlert(decodePushPayload(text), readAlertKey)
      const notification = notificationFor(alert)
      await worker.registration.showNotification(notification.title, notification.options)
    })(),
  )
})

worker.addEventListener("notificationclick", (event) => {
  event.notification.close()
  const target = new URL(clickTarget(event.notification.data), worker.location.origin).toString()
  event.waitUntil(
    (async () => {
      const windows = await worker.clients.matchAll({ type: "window", includeUncontrolled: true })
      const open = windows.find((client) => new URL(client.url).origin === worker.location.origin)
      if (!open) return worker.clients.openWindow(target)
      await open.navigate(target).catch(() => undefined)
      return open.focus()
    })(),
  )
})
