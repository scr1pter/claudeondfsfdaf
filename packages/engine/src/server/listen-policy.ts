import { SecurityConfigurationError } from "@vectordevai/core/flag/security"
import { isIP } from "node:net"
import { ServerAuth } from "./auth"

export function assertListenSecurity(
  opts: { hostname: string; unsecured?: boolean; trustedNetwork?: boolean },
  config: ServerAuth.Info,
) {
  // Plain HTTP carries the password in every request, so a network bind needs the caller to say the network is
  // trusted (a container bridge published only to host loopback, a private LAN) or a TLS proxy in front.
  if (ServerAuth.required(config) && !isLoopback(opts.hostname) && opts.trustedNetwork !== true)
    throw new SecurityConfigurationError(
      `Refusing to send the server password over plain HTTP on ${opts.hostname}. On a network you trust, such as a container bridge or a private LAN, pass --trusted-network; otherwise bind loopback behind a TLS reverse proxy or tunnel.`,
    )
  if (ServerAuth.required(config) || opts.unsecured === true || isLoopback(opts.hostname)) return
  throw new SecurityConfigurationError(
    `Refusing to listen on ${opts.hostname} without authentication. Set VECTOR_SERVER_PASSWORD (with --trusted-network on a network you trust), or explicitly pass --unsecured.`,
  )
}

/**
 * The hostname whose requests a listener checks the Host header against, or
 * undefined when it accepts any Host. A passwordless loopback listener trusts
 * every request it gets, and a web page can reach it by pointing its own domain
 * at 127.0.0.1 (DNS rebinding), becoming same-origin with the server. The
 * browser still sends that domain as Host, so these listeners answer only
 * requests addressed to a loopback name or the hostname they were started with.
 * A password stops the attack instead, since the page cannot supply it.
 */
export function guardedHostname(opts: { hostname: string }, config: ServerAuth.Info) {
  if (ServerAuth.required(config) || !isLoopback(opts.hostname)) return undefined
  return opts.hostname
}

/** Whether a request's Host header names this machine's loopback or the configured hostname. */
export function allowedHost(host: string | undefined, hostname: string) {
  // Clients that send no Host are not browsers, so they cannot be rebound.
  if (host === undefined) return true
  if (/[@/?#\\]/.test(host) || !URL.canParse(`http://${host}`)) return false
  const name = normalize(new URL(`http://${host}`).hostname)
  return name === normalize(hostname) || isLoopback(name)
}

function normalize(hostname: string) {
  return hostname
    .toLowerCase()
    .replace(/^\[|\]$/g, "")
    .replace(/\.$/, "")
}

export function isLoopback(hostname: string) {
  const address = normalize(hostname)
  if (address === "localhost") return true
  if (isIP(address) === 4) return address.startsWith("127.")
  if (isIP(address) !== 6) return false
  const normalized = new URL(`http://[${address}]`).hostname
  return normalized === "[::1]" || /^\[::ffff:7f[\da-f]{2}:[\da-f]{1,4}\]$/.test(normalized)
}
