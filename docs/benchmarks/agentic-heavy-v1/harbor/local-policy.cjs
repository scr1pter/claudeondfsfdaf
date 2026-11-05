"use strict"

// Same loopback HTTP-origin restriction as the shared browser driver. No DNS,
// external proxy, redirect target or client credentials widen this allowlist.
function allowedURL(value, origins) {
  try {
    const url = new URL(value)
    return url.protocol === "http:" && url.hostname === "127.0.0.1" && !url.username && !url.password && origins.has(url.origin)
  } catch {
    return false
  }
}
module.exports = { allowedURL }
