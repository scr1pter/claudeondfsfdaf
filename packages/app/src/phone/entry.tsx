import { render } from "solid-js/web"
import { PhoneApp } from "./app"
import { PHONE_SW_SCOPE, PHONE_SW_URL } from "./config"
import "./phone.css"

// The phone app's entry (WP A38): https://remote.vectordev.ai/phone/, built on its own (`bun run build:phone`) into
// dist-phone, which the website build copies to /phone. It shares nothing with the desktop app's bundle.

if ("serviceWorker" in navigator) {
  // One worker for the whole phone origin. `updateViaCache: "none"` makes every update check fetch the script itself.
  void navigator.serviceWorker
    .register(PHONE_SW_URL, { scope: PHONE_SW_SCOPE, updateViaCache: "none" })
    .catch(() => undefined)
}

const root = document.getElementById("root")
if (root) render(() => <PhoneApp />, root)
