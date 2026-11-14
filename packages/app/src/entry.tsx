// @refresh reload

import * as Sentry from "@sentry/solid"
import { render } from "solid-js/web"
import { AppBaseProviders, AppInterface } from "@/app"
import { type Platform, PlatformProvider } from "@/context/platform"
import { dict as en } from "@/i18n/en"
import { dict as zh } from "@/i18n/zh"
import { handleNotificationClick } from "@/utils/notification-click"
import { observeTelemetryPreference, scrubDiagnosticEvent, telemetryEnabled } from "@/features/privacy/telemetry"
import { openExternalUrl, safeExternalUrl, secureExternalAnchor } from "@/utils/external-url"
import { consumeInviteCredentials } from "@/utils/server"
import pkg from "../package.json"
import { normalizeServerUrl, ServerConnection } from "./context/server"
import { VECTOR_ICON } from "./pages/layout/helpers"
import type { createFakeComputer, FakeComputerScript } from "./features/computer/fake-platform"

declare global {
  interface Window {
    __vectorE2E?: {
      computer?: FakeComputerScript
      computerControl?: ReturnType<typeof createFakeComputer>
    }
  }
}

const DEFAULT_SERVER_URL_KEY = "vector.settings.dat:defaultServerUrl"

const getLocale = () => {
  if (typeof navigator !== "object") return "en" as const
  const languages = navigator.languages?.length ? navigator.languages : [navigator.language]
  for (const language of languages) {
    if (!language) continue
    if (language.toLowerCase().startsWith("zh")) return "zh" as const
  }
  return "en" as const
}

const getRootNotFoundError = () => {
  const key = "error.dev.rootNotFound" as const
  const locale = getLocale()
  return locale === "zh" ? (zh[key] ?? en[key]) : en[key]
}

const getStorage = (key: string) => {
  if (typeof localStorage === "undefined") return null
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

const setStorage = (key: string, value: string | null) => {
  if (typeof localStorage === "undefined") return
  try {
    if (value !== null) {
      localStorage.setItem(key, value)
      return
    }
    localStorage.removeItem(key)
  } catch {
    return
  }
}

const readDefaultServerUrl = () => {
  const stored = getStorage(DEFAULT_SERVER_URL_KEY)
  if (!stored) return null
  const safe = normalizeServerUrl(stored)
  if (safe) return safe
  setStorage(DEFAULT_SERVER_URL_KEY, null)
  return null
}
const writeDefaultServerUrl = (url: string | null) =>
  setStorage(DEFAULT_SERVER_URL_KEY, url ? (normalizeServerUrl(url) ?? null) : null)

const notify: Platform["notify"] = async (title, description, href, options) => {
  if (!("Notification" in window)) return

  const permission =
    Notification.permission === "default"
      ? await Notification.requestPermission().catch(() => "denied")
      : Notification.permission

  if (permission !== "granted") return

  const inView = document.visibilityState === "visible" && document.hasFocus()
  if (inView && !options?.force) return

  const notification = new Notification(title, {
    body: description ?? "",
    icon: new URL(VECTOR_ICON, location.href).href,
  })

  notification.onclick = () => {
    handleNotificationClick(href)
    notification.close()
  }
}

const openLink: Platform["openLink"] = (url) => {
  openExternalUrl(url)
}

document.addEventListener(
  "click",
  (event) => {
    if (!(event.target instanceof Element)) return
    const anchor = event.target.closest("a[href]")
    if (!(anchor instanceof HTMLAnchorElement)) return
    if (!safeExternalUrl(anchor.getAttribute("href") ?? "", location.href)) {
      event.preventDefault()
      return
    }
    if (anchor.target !== "_blank") return
    if (!secureExternalAnchor(anchor, location.href)) event.preventDefault()
  },
  { capture: true },
)

const back: Platform["back"] = () => {
  window.history.back()
}

const forward: Platform["forward"] = () => {
  window.history.forward()
}

const restart: Platform["restart"] = async () => {
  window.location.reload()
}

const root = document.getElementById("root")
if (!(root instanceof HTMLElement) && import.meta.env.DEV) {
  throw new Error(getRootNotFoundError())
}

const getCurrentUrl = () => {
  if (location.hostname.includes("vectordev.ai")) return "http://localhost:4096"
  if (import.meta.env.DEV)
    return normalizeServerUrl(
      `${import.meta.env.VITE_VECTOR_SERVER_HOST ?? "localhost"}:${import.meta.env.VITE_VECTOR_SERVER_PORT ?? "4096"}`,
    )!
  return location.origin
}

const getDefaultUrl = () => {
  const lsDefault = readDefaultServerUrl()
  if (lsDefault) return lsDefault
  return getCurrentUrl()
}

const clearLegacyAuthToken = () => {
  const params = new URLSearchParams(location.search)
  if (!params.has("auth_token")) return
  params.delete("auth_token")
  history.replaceState(null, "", location.pathname + (params.size ? `?${params}` : "") + location.hash)
}

const inviteCredentials = consumeInviteCredentials(location, (url) => history.replaceState(null, "", url))
clearLegacyAuthToken()

const platform: Platform = {
  platform: "web",
  version: pkg.version,
  openLink,
  back,
  forward,
  restart,
  notify,
  getDefaultServer: async () => {
    const stored = readDefaultServerUrl()
    return stored ? ServerConnection.Key.make(stored) : null
  },
  setDefaultServer: writeDefaultServerUrl,
}

let sentryStarted = false

const configureCrashDiagnostics = () => {
  if (!import.meta.env.VITE_SENTRY_DSN || !telemetryEnabled()) {
    if (sentryStarted) void Sentry.close(2_000)
    sentryStarted = false
    return
  }
  if (sentryStarted) return
  sentryStarted = true
  Sentry.init({
    dsn: import.meta.env.VITE_SENTRY_DSN,
    sendDefaultPii: false,
    tracesSampleRate: 0,
    beforeSend: scrubDiagnosticEvent,
    environment: import.meta.env.VITE_SENTRY_ENVIRONMENT ?? import.meta.env.MODE,
    release: import.meta.env.VITE_SENTRY_RELEASE ?? `web@${pkg.version}`,
    initialScope: {
      tags: {
        platform: "web",
      },
    },
    integrations: (integrations) => {
      return integrations.filter(
        (i) =>
          i.name !== "Breadcrumbs" && !(import.meta.env.VITE_VECTOR_CHANNEL === "prod" && i.name === "GlobalHandlers"),
      )
    },
  })
}

configureCrashDiagnostics()
observeTelemetryPreference(configureCrashDiagnostics)

async function bootstrap() {
  if (import.meta.env.DEV && window.__vectorE2E?.computer) {
    const { createFakeComputer } = await import("@/features/computer/fake-platform")
    const fake = createFakeComputer(window.__vectorE2E.computer)
    platform.computer = fake
    window.__vectorE2E.computerControl = fake
  }
  if (!(root instanceof HTMLElement)) return
  const server: ServerConnection.Http = {
    type: "http",
    http: {
      url: getCurrentUrl(),
      ...inviteCredentials,
    },
  }
  render(
    () => (
      <PlatformProvider value={platform}>
        <AppBaseProviders>
          <AppInterface
            defaultServer={ServerConnection.Key.make(getDefaultUrl())}
            canonicalLocalServer={ServerConnection.key(server)}
            servers={[server]}
            disableHealthCheck
          />
        </AppBaseProviders>
      </PlatformProvider>
    ),
    root,
  )
}

void bootstrap()
