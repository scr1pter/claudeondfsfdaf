import { describe, expect, test } from "bun:test"
import type { PermissionRequest, Session } from "@vectordevai/sdk/v2/client"
import { base64Encode } from "@vectordevai/core/util/encode"
import {
  autoRespondsPermission,
  isDirectoryAutoAccepting,
  phoneTurnAllows,
  sessionLineage,
} from "./permission-auto-respond"

const session = (input: { id: string; parentID?: string }) =>
  ({
    id: input.id,
    parentID: input.parentID,
  }) as Session

const permission = (sessionID: string, name?: string) =>
  ({
    sessionID,
    permission: name,
  }) as Pick<PermissionRequest, "sessionID" | "permission">

describe("autoRespondsPermission", () => {
  test("uses a parent session's directory-scoped auto-accept", () => {
    const directory = "/tmp/project"
    const sessions = [session({ id: "root" }), session({ id: "child", parentID: "root" })]
    const autoAccept = {
      [`${base64Encode(directory)}/root`]: true,
    }

    expect(autoRespondsPermission(autoAccept, sessions, permission("child"), directory)).toBe(true)
  })

  test("uses a parent session's legacy auto-accept key", () => {
    const sessions = [session({ id: "root" }), session({ id: "child", parentID: "root" })]

    expect(autoRespondsPermission({ root: true }, sessions, permission("child"), "/tmp/project")).toBe(true)
  })

  test("defaults to requiring approval when no lineage override exists", () => {
    const sessions = [session({ id: "root" }), session({ id: "child", parentID: "root" }), session({ id: "other" })]
    const autoAccept = {
      other: true,
    }

    expect(autoRespondsPermission(autoAccept, sessions, permission("child"), "/tmp/project")).toBe(false)
  })

  test("inherits a parent session's false override", () => {
    const directory = "/tmp/project"
    const sessions = [session({ id: "root" }), session({ id: "child", parentID: "root" })]
    const autoAccept = {
      [`${base64Encode(directory)}/root`]: false,
    }

    expect(autoRespondsPermission(autoAccept, sessions, permission("child"), directory)).toBe(false)
  })

  test("prefers a child override over parent override", () => {
    const directory = "/tmp/project"
    const sessions = [session({ id: "root" }), session({ id: "child", parentID: "root" })]
    const autoAccept = {
      [`${base64Encode(directory)}/root`]: false,
      [`${base64Encode(directory)}/child`]: true,
    }

    expect(autoRespondsPermission(autoAccept, sessions, permission("child"), directory)).toBe(true)
  })

  test("falls back to directory-level auto-accept", () => {
    const directory = "/tmp/project"
    const sessions = [session({ id: "root" })]
    const autoAccept = {
      [`${base64Encode(directory)}/*`]: true,
    }

    expect(autoRespondsPermission(autoAccept, sessions, permission("root"), directory)).toBe(true)
  })

  test("leaves every Vector Cloud change to the user, and answers only the read-only dry run", () => {
    const directory = "/tmp/project"
    const sessions = [session({ id: "root" })]
    const autoAccept = {
      [`${base64Encode(directory)}/*`]: true,
      [`${base64Encode(directory)}/root`]: true,
    }
    const asked = (name: string, always?: string[]) => ({ sessionID: "root", permission: name, always })

    expect(autoRespondsPermission(autoAccept, sessions, asked("edit"), directory)).toBe(true)
    expect(autoRespondsPermission(autoAccept, sessions, asked("bash", []), directory)).toBe(true)
    // A migration dry run only reads.
    expect(
      autoRespondsPermission(
        autoAccept,
        sessions,
        asked("vector_cloud_inspect", ["supabase/shop-db/production"]),
        directory,
      ),
    ).toBe(true)
    // Publishing and production moves, databases (billed), hosting settings and
    // domains, and host variables, whether or not the request could be
    // remembered, under directory, session and legacy auto-accept alike.
    for (const name of [
      "vector_cloud_publish",
      "vector_cloud_database",
      "vector_cloud_environment",
      "vector_cloud_hosting",
    ]) {
      expect(autoRespondsPermission(autoAccept, sessions, asked(name), directory)).toBe(false)
      expect(
        autoRespondsPermission(autoAccept, sessions, asked(name, [`vercel/shop/production/${name}`]), directory),
      ).toBe(false)
      expect(
        autoRespondsPermission(
          { root: true },
          sessions,
          asked(name, ["supabase/shop-db/production/create_bucket"]),
          directory,
        ),
      ).toBe(false)
    }
    // Any other cloud request that asks every time is left to the user too.
    expect(autoRespondsPermission(autoAccept, sessions, asked("vector_cloud_inspect", []), directory)).toBe(false)
  })

  test("session-level override takes precedence over directory-level", () => {
    const directory = "/tmp/project"
    const sessions = [session({ id: "root" })]
    const autoAccept = {
      [`${base64Encode(directory)}/*`]: true,
      [`${base64Encode(directory)}/root`]: false,
    }

    expect(autoRespondsPermission(autoAccept, sessions, permission("root"), directory)).toBe(false)
  })

  test("never auto-approves doom-loop continuation", () => {
    const directory = "/tmp/project"
    expect(
      autoRespondsPermission(
        { [`${base64Encode(directory)}/*`]: true, root: true },
        [session({ id: "root" })],
        permission("root", "doom_loop"),
        directory,
      ),
    ).toBe(false)
  })

  test.each(["browser_sensitive", "computer_observe", "computer_interact", "computer_sensitive"])(
    "never auto-approves %s",
    (name) => {
      const directory = "/tmp/project"
      expect(
        autoRespondsPermission(
          { [`${base64Encode(directory)}/*`]: true, root: true },
          [session({ id: "root" })],
          permission("root", name),
          directory,
        ),
      ).toBe(false)
    },
  )

  test("never auto-accepts a doom_loop request on an auto-accepting lineage", () => {
    const directory = "/tmp/project"
    const sessions = [session({ id: "root" }), session({ id: "child", parentID: "root" })]
    const autoAccept = {
      [`${base64Encode(directory)}/root`]: true,
    }

    expect(autoRespondsPermission(autoAccept, sessions, permission("child", "doom_loop"), directory)).toBe(false)
    expect(autoRespondsPermission(autoAccept, sessions, permission("child", "edit"), directory)).toBe(true)
  })
})

describe("isDirectoryAutoAccepting", () => {
  test("returns true when directory key is set", () => {
    const directory = "/tmp/project"
    const autoAccept = { [`${base64Encode(directory)}/*`]: true }
    expect(isDirectoryAutoAccepting(autoAccept, directory)).toBe(true)
  })

  test("returns false when directory key is not set", () => {
    expect(isDirectoryAutoAccepting({}, "/tmp/project")).toBe(false)
  })

  test("returns false when directory key is explicitly false", () => {
    const directory = "/tmp/project"
    const autoAccept = { [`${base64Encode(directory)}/*`]: false }
    expect(isDirectoryAutoAccepting(autoAccept, directory)).toBe(false)
  })
})

// Vector Remote (WP A41, S6): a turn a paired phone started is never auto-approved, even where auto-accept is on.
describe("phone turns and auto-accept", () => {
  const sessions = [session({ id: "root" }), session({ id: "child", parentID: "root" }), session({ id: "other" })]

  test("asks the desktop about the request's session and every session above it", async () => {
    expect(sessionLineage(sessions, "child")).toEqual(["child", "root"])
    const asked: string[][] = []
    const allowed = await phoneTurnAllows(
      async (ids) => {
        asked.push(ids)
        return ids.includes("root")
      },
      sessionLineage(sessions, "child"),
    )
    expect(asked).toEqual([["child", "root"]])
    expect(allowed).toBe(false)
  })

  test("leaves auto-accept as it was for turns started on this computer", async () => {
    expect(await phoneTurnAllows(async () => false, ["other"])).toBe(true)
    // Outside the desktop app no phone can start a turn.
    expect(await phoneTurnAllows(undefined, ["other"])).toBe(true)
  })

  test("a check that fails or answers oddly counts as a phone's turn", async () => {
    expect(await phoneTurnAllows(async () => Promise.reject(new Error("main process gone")), ["root"])).toBe(false)
    expect(await phoneTurnAllows(async () => undefined as unknown as boolean, ["root"])).toBe(false)
  })

  test("the provider asks before every auto-accept answer, and holds the request when a phone started its turn", async () => {
    const source = await Bun.file(new URL("./permission.tsx", import.meta.url)).text()
    // Every path that answers by itself goes through autoRespond, which asks phoneTurnAllows first.
    expect(source.match(/respondOnce\(/g)?.length).toBe(2)
    expect(source).toContain("phoneTurnAllows(")
    expect(source).toContain("if (held().has(permission.id)) return false")
  })
})
