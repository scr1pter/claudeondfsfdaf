import { afterAll, afterEach, beforeAll, expect } from "bun:test"

/*
 * The fetch guard for Vector everywhere tests (contract section 9). While installed, any fetch to a host other than
 * 127.0.0.1, localhost or [::1] fails, and the test that made it fails too, even if the code under test caught the
 * error. Only the host is recorded, never the URL, which could carry test data.
 */

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"])

function hostOf(input: RequestInfo | URL) {
  try {
    const url = typeof input === "string" ? new URL(input) : input instanceof URL ? input : new URL(input.url)
    return url.hostname
  } catch {
    return "(unreadable address)"
  }
}

export type FetchGuard = { readonly violations: string[] }

/** Installs the guard for the whole test file: call once at the top level. */
export function installFetchGuard(): FetchGuard {
  const guard: FetchGuard = { violations: [] }
  const original = globalThis.fetch
  beforeAll(() => {
    const guarded = (input: RequestInfo | URL, init?: RequestInit) => {
      const host = hostOf(input)
      if (!LOOPBACK.has(host)) {
        guard.violations.push(host)
        return Promise.reject(new Error(`The fetch guard stopped a request to ${host}.`))
      }
      return original(input, init)
    }
    globalThis.fetch = Object.assign(guarded, { preconnect: original.preconnect }) as typeof fetch
  })
  afterEach(() => {
    const seen = guard.violations.splice(0)
    expect(seen).toEqual([])
  })
  afterAll(() => {
    globalThis.fetch = original
  })
  return guard
}
