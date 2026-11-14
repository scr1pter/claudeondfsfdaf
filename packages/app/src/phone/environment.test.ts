import { expect, test } from "bun:test"
import { alertsSupport, canPair, installSteps, readEnvironment } from "./environment"

// WP A38: on iOS, pairing and alerts happen only inside the installed Home Screen app, which keeps its own storage
// apart from Safari's and is the only place iOS delivers Web Push.

const IPHONE =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 Version/17.5 Mobile Safari/604.1"
const ANDROID = "Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 Chrome/141.0 Mobile Safari/537.36"
const MAC = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/18.0 Safari/605.1.15"

const media = (standalone: boolean) => (query: string) => ({ matches: standalone && query.includes("standalone") })
const pushWindow = (standalone: boolean) => ({ matchMedia: media(standalone), PushManager: {}, Notification: {} })

test("an iPhone Safari tab must install first: no pairing, no alerts", () => {
  const environment = readEnvironment({ userAgent: IPHONE, serviceWorker: {} }, { matchMedia: media(false) })
  expect(environment).toEqual({ ios: true, standalone: false, serviceWorker: true, push: false })
  expect(canPair(environment)).toBe(false)
  expect(alertsSupport(environment)).toBe("install-first")
  expect(installSteps(environment).join(" ")).toContain("Add to Home Screen")
})

test("the installed iPhone app pairs and takes alerts", () => {
  const environment = readEnvironment({ userAgent: IPHONE, standalone: true, serviceWorker: {} }, pushWindow(true))
  expect(environment.standalone).toBe(true)
  expect(canPair(environment)).toBe(true)
  expect(alertsSupport(environment)).toBe("ready")
})

test("an installed iPhone app without Web Push (before iOS 16.4) cannot take alerts but can pair", () => {
  const environment = readEnvironment(
    { userAgent: IPHONE, standalone: true, serviceWorker: {} },
    { matchMedia: media(true) },
  )
  expect(canPair(environment)).toBe(true)
  expect(alertsSupport(environment)).toBe("unsupported")
})

test("an iPad that reports itself as a Mac is still iOS", () => {
  const environment = readEnvironment(
    { userAgent: MAC, platform: "MacIntel", maxTouchPoints: 5, serviceWorker: {} },
    pushWindow(false),
  )
  expect(environment.ios).toBe(true)
  expect(canPair(environment)).toBe(false)
  expect(readEnvironment({ userAgent: MAC, platform: "MacIntel", maxTouchPoints: 0 }, {}).ios).toBe(false)
})

test("Android pairs and takes alerts in the browser too", () => {
  const environment = readEnvironment({ userAgent: ANDROID, serviceWorker: {} }, pushWindow(false))
  expect(environment.ios).toBe(false)
  expect(canPair(environment)).toBe(true)
  expect(alertsSupport(environment)).toBe("ready")
  expect(alertsSupport(readEnvironment({ userAgent: ANDROID }, {}))).toBe("unsupported")
})
