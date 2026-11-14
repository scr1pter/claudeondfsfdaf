// What this phone's browser can do, for the phone app (WP A38).
//
// On iPhone and iPad, a web app added to the Home Screen keeps its own storage, apart from Safari's, and only the
// installed app may receive Web Push (iOS 16.4 and later). Keys made in a Safari tab would never reach the installed
// app, so pairing and alerts happen only inside the installed app there: the phone app shows how to install it
// instead (contract WP A38, "pairing must happen inside the installed Home Screen app on iOS").

export type PhoneEnvironment = {
  /** iPhone, iPad or iPod, including an iPad that reports itself as a Mac. */
  ios: boolean
  /** Running as the installed app (Home Screen on iOS, an installed web app elsewhere), not in a browser tab. */
  standalone: boolean
  /** Service workers, the Push API and notifications are all present. */
  push: boolean
  serviceWorker: boolean
}

type NavigatorLike = {
  userAgent?: string
  platform?: string
  maxTouchPoints?: number
  standalone?: boolean
  serviceWorker?: unknown
}
type WindowLike = {
  matchMedia?: (query: string) => { matches: boolean }
  PushManager?: unknown
  Notification?: unknown
}

export function readEnvironment(nav: NavigatorLike, win: WindowLike): PhoneEnvironment {
  const agent = nav.userAgent ?? ""
  const ios = /\b(iPhone|iPad|iPod)\b/.test(agent) || (nav.platform === "MacIntel" && (nav.maxTouchPoints ?? 0) > 1)
  const standalone =
    nav.standalone === true ||
    Boolean(win.matchMedia?.("(display-mode: standalone)").matches) ||
    Boolean(win.matchMedia?.("(display-mode: fullscreen)").matches)
  const serviceWorker = Boolean(nav.serviceWorker)
  return {
    ios,
    standalone,
    serviceWorker,
    push: serviceWorker && Boolean(win.PushManager) && Boolean(win.Notification),
  }
}

/** Whether this phone may pair with a computer here: anywhere except an iOS browser tab. */
export function canPair(environment: PhoneEnvironment) {
  return !environment.ios || environment.standalone
}

/** Whether phone alerts can be turned on here, or what is needed first. */
export function alertsSupport(environment: PhoneEnvironment): "ready" | "install-first" | "unsupported" {
  if (environment.ios && !environment.standalone) return "install-first"
  if (!environment.push) return "unsupported"
  return "ready"
}

/** How to add the phone app to the Home Screen on this phone. */
export function installSteps(environment: PhoneEnvironment): string[] {
  if (environment.ios)
    return [
      "Tap the Share button in Safari.",
      "Choose Add to Home Screen, then Add.",
      "Open Vector from your Home Screen and sign in there.",
    ]
  return ["Open your browser's menu.", "Choose Install app or Add to Home screen.", "Open Vector from there."]
}
