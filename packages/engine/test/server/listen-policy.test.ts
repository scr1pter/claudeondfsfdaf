import { describe, expect, test } from "bun:test"
import { randomUUID } from "node:crypto"
import { rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Option } from "effect"
import { allowedHost, assertListenSecurity, guardedHostname } from "../../src/server/listen-policy"
import { Server } from "../../src/server/server"

const unprotected = { username: "vector", password: Option.none<string>() }

describe("server bind security", () => {
  test("the public listener refuses an unprotected network bind before starting routes", async () => {
    await expect(Server.listen({ hostname: "0.0.0.0", port: 0 })).rejects.toThrow("VECTOR_SERVER_PASSWORD")
  })
  test("allows only loopback addresses without authentication by default", () => {
    for (const hostname of [
      "localhost",
      "LOCALHOST.",
      "127.0.0.1",
      "127.0.0.2",
      "::1",
      "0:0:0:0:0:0:0:1",
      "::ffff:127.0.0.1",
    ]) {
      expect(() => assertListenSecurity({ hostname }, unprotected)).not.toThrow()
    }
    for (const hostname of [
      "0.0.0.0",
      "::",
      "192.168.1.10",
      "example.com",
      "localhost.example.com",
      "::ffff:192.168.1.10",
      "",
    ]) {
      expect(() => assertListenSecurity({ hostname }, unprotected)).toThrow("VECTOR_SERVER_PASSWORD")
      expect(() => assertListenSecurity({ hostname, unsecured: false }, unprotected)).toThrow("--unsecured")
    }
  })

  test("requires explicit unsecured permission and blocks cleartext remote password authentication", () => {
    expect(() => assertListenSecurity({ hostname: "0.0.0.0", unsecured: true }, unprotected)).not.toThrow()
    expect(() =>
      assertListenSecurity({ hostname: "0.0.0.0" }, { ...unprotected, password: Option.some("secret") }),
    ).toThrow("plain HTTP")
    expect(() =>
      assertListenSecurity({ hostname: "0.0.0.0" }, { ...unprotected, guestPassword: Option.some("secret") }),
    ).toThrow("plain HTTP")
    expect(() =>
      assertListenSecurity({ hostname: "127.0.0.1" }, { ...unprotected, password: Option.some("secret") }),
    ).not.toThrow()
    expect(() =>
      assertListenSecurity(
        { hostname: "0.0.0.0" },
        { ...unprotected, password: Option.some(""), guestPassword: Option.some("") },
      ),
    ).toThrow()
  })

  test("requires explicit unsecured permission or a nonempty owner or guest password", () => {
    const network = { hostname: "0.0.0.0", trustedNetwork: true }
    expect(() => assertListenSecurity({ ...network, unsecured: true }, unprotected)).not.toThrow()
    expect(() => assertListenSecurity(network, { ...unprotected, password: Option.some("secret") })).not.toThrow()
    expect(() => assertListenSecurity(network, { ...unprotected, guestPassword: Option.some("secret") })).not.toThrow()
    expect(() => assertListenSecurity(network, unprotected)).toThrow()
    expect(() =>
      assertListenSecurity(network, { ...unprotected, password: Option.some(""), guestPassword: Option.some("") }),
    ).toThrow()
  })

  test("a password listener binds the network only when the network is declared trusted", () => {
    const protectedConfig = { ...unprotected, password: Option.some("secret") }
    // A container publishing only to host loopback, or a private LAN, can carry the password over plain HTTP.
    for (const hostname of ["0.0.0.0", "::", "192.168.1.10"]) {
      expect(() => assertListenSecurity({ hostname, trustedNetwork: true }, protectedConfig)).not.toThrow()
      expect(() => assertListenSecurity({ hostname }, protectedConfig)).toThrow("--trusted-network")
    }
    // The opt-in is about carrying a password: it never stands in for one.
    expect(() => assertListenSecurity({ hostname: "0.0.0.0", trustedNetwork: true }, unprotected)).toThrow(
      "VECTOR_SERVER_PASSWORD",
    )
  })

  test("a container can serve with a password on 0.0.0.0", async () => {
    const previous = process.env.VECTOR_SERVER_PASSWORD
    process.env.VECTOR_SERVER_PASSWORD = "container-secret"
    try {
      await expect(Server.listen({ hostname: "0.0.0.0", port: 0 })).rejects.toThrow("--trusted-network")
      const listener = await Server.listen({ hostname: "0.0.0.0", port: 0, trustedNetwork: true })
      await listener.stop(true)
    } finally {
      if (previous === undefined) delete process.env.VECTOR_SERVER_PASSWORD
      else process.env.VECTOR_SERVER_PASSWORD = previous
    }
  })

  test("only a password-protected loopback listener opens the private Everywhere preferences channel", async () => {
    const previous = process.env.VECTOR_SERVER_PASSWORD
    const everywherePreferencesPath = path.join(os.tmpdir(), `everywhere-preferences-${randomUUID()}.json`)
    const opened = async (options: { hostname: string; trustedNetwork?: boolean }) => {
      const listener = await Server.listen({ ...options, port: 0, everywherePreferencesPath })
      try {
        return await listener.everywherePreferences?.({ version: 1, kind: "read" })
      } finally {
        await listener.stop(true)
      }
    }
    try {
      delete process.env.VECTOR_SERVER_PASSWORD
      expect(await opened({ hostname: "127.0.0.1" })).toBeUndefined()
      process.env.VECTOR_SERVER_PASSWORD = "sidecar-secret"
      expect(await opened({ hostname: "0.0.0.0", trustedNetwork: true })).toBeUndefined()
      expect(await opened({ hostname: "127.0.0.1" })).toMatchObject({
        version: 1,
        kind: "ready",
        snapshot: { revision: 0 },
      })
    } finally {
      if (previous === undefined) delete process.env.VECTOR_SERVER_PASSWORD
      else process.env.VECTOR_SERVER_PASSWORD = previous
      await rm(everywherePreferencesPath, { force: true })
    }
  })

  test("guards the Host header only on a passwordless loopback listener", () => {
    expect(guardedHostname({ hostname: "127.0.0.1" }, unprotected)).toBe("127.0.0.1")
    expect(guardedHostname({ hostname: "localhost" }, unprotected)).toBe("localhost")
    expect(guardedHostname({ hostname: "::1" }, unprotected)).toBe("::1")
    expect(guardedHostname({ hostname: "127.0.0.1" }, { ...unprotected, password: Option.some("secret") })).toBe(
      undefined,
    )
    expect(guardedHostname({ hostname: "127.0.0.1" }, { ...unprotected, guestPassword: Option.some("secret") })).toBe(
      undefined,
    )
    expect(guardedHostname({ hostname: "0.0.0.0" }, unprotected)).toBe(undefined)
  })

  test("accepts loopback names and the configured hostname as Host", () => {
    for (const host of [
      "localhost",
      "localhost:4096",
      "LOCALHOST:4096",
      "localhost.:4096",
      "127.0.0.1",
      "127.0.0.1:4096",
      "127.0.0.2:4096",
      "[::1]:4096",
      "[::ffff:127.0.0.1]:4096",
      undefined,
    ]) {
      expect({ host, allowed: allowedHost(host, "127.0.0.1") }).toEqual({ host, allowed: true })
    }
    expect(allowedHost("[::1]:4096", "::1")).toBe(true)
  })

  test("rejects any other Host, which is what a DNS rebinding page sends", () => {
    for (const host of [
      "attacker.example:4096",
      "attacker.example",
      "localhost.attacker.example:4096",
      "127.0.0.1.attacker.example",
      "192.168.1.10:4096",
      "[::]:4096",
      "evil@127.0.0.1",
      "127.0.0.1/evil",
      "",
    ]) {
      expect({ host, allowed: allowedHost(host, "127.0.0.1") }).toEqual({ host, allowed: false })
    }
  })
})
