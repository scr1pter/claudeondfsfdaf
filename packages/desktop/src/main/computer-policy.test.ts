import { describe, expect, test } from "bun:test"
import { ConfigManaged } from "@vectordevai/core/config/managed"
import { Computer } from "@vectordevai/schema/computer"
import { createComputerPolicy, defaultPolicy, policyAccess } from "./computer-policy"

const APPLE: Computer.AppIdentity = {
  platform: "macos",
  bundleId: "com.apple.calculator",
  apple: true,
  system: true,
  verified: true,
  name: "Calculator",
}
const EDITOR: Computer.AppIdentity = {
  platform: "macos",
  bundleId: "com.example.editor",
  teamId: "TEAM123456",
  apple: false,
  system: false,
  verified: true,
  name: "Editor",
}
const WINDOWS: Computer.WindowsExeIdentity = {
  platform: "windows",
  kind: "exe",
  publisher: "Contoso | Tools 100%",
  product: "Editor | Pro 50%",
  binary: "Editor.exe",
  exe: "C:\\Program Files\\Editor\\Editor.exe",
  verified: true,
  system: false,
  name: "Editor",
}

function managed(computer: unknown) {
  return createComputerPolicy({
    read: () => ({ files: [], policies: [{ source: "mdm", text: JSON.stringify({ computer }) }], ignored: [] }),
  }).get()
}

describe("company-only computer policy", () => {
  test("the unmanaged defaults permit asks but never constitute app consent", () => {
    expect(defaultPolicy()).toEqual({
      managed: false,
      enabled: true,
      defaultAccess: "ask",
      allowAlways: true,
      background: true,
      keepAwake: true,
      apps: new Map(),
      ignored: [],
    })
    expect(policyAccess(APPLE, defaultPolicy())).toBeUndefined()
  })

  test("repository, user, global and environment config are never requested as company sources", () => {
    const files = new Map([
      ["/company/vector.jsonc", '{ "model": "unchanged" }'],
      ["/project/vector.json", '{ "computer": { "enabled": false } }'],
      ["/user/vector.json", '{ "computer": { "enabled": false } }'],
      ["/global/vector.json", '{ "computer": { "enabled": false } }'],
      ["VECTOR_CONFIG_CONTENT", '{ "computer": { "enabled": false } }'],
    ])
    const reads: string[] = []
    const policy = createComputerPolicy({
      read: () => ({ files: ["/company/vector.jsonc"], policies: [], ignored: [] }),
      readFile: (file) => {
        reads.push(file)
        return files.get(file)!
      },
    }).get()
    expect(reads).toEqual(["/company/vector.jsonc"])
    expect(policy).toEqual(defaultPolicy())
  })

  test("managed files merge in order, then the OS policy, preserving omitted restrictions", () => {
    const policy = createComputerPolicy({
      read: () => ({
        files: ["first", "second"],
        policies: [{ source: "mdm", text: '{"computer":{"enabled":false,"keep_awake":false}}' }],
        ignored: [],
      }),
      readFile: (file) =>
        file === "first"
          ? '{ /* comment */ "computer": {"enabled":true,"allow_always":false,"background":false,"away_minutes":10,"screenshot_retention_days":1,},}'
          : '{"computer":{"default_app_access":"deny","away_minutes":20}}',
    }).get()
    expect(policy).toMatchObject({
      managed: true,
      enabled: false,
      allowAlways: false,
      background: false,
      keepAwake: false,
      defaultAccess: "deny",
      awayMinutesMax: 20,
      maxRetentionDays: 1,
    })
  })

  test("two calls within five minutes share the startup read, and the boundary refreshes it", () => {
    const time = { at: 1000, reads: 0, enabled: false }
    const policy = createComputerPolicy({
      now: () => time.at,
      read: () => {
        time.reads++
        return {
          files: [],
          policies: [{ source: "mdm", text: JSON.stringify({ computer: { enabled: time.enabled } }) }],
          ignored: [],
        }
      },
    })
    expect(time.reads).toBe(1)
    expect(policy.get().enabled).toBe(false)
    time.enabled = true
    time.at += 299999
    expect(policy.get().enabled).toBe(false)
    expect(time.reads).toBe(1)
    time.at++
    expect(policy.get().enabled).toBe(true)
    expect(time.reads).toBe(2)
    policy.refresh()
    expect(time.reads).toBe(3)
  })

  test("clock rollback refreshes rather than prolonging a cached policy", () => {
    const time = { at: 1000, reads: 0 }
    const policy = createComputerPolicy({
      now: () => time.at,
      read: () => {
        time.reads++
        return { files: [], policies: [], ignored: [] }
      },
    })
    time.at = 1
    policy.get()
    expect(time.reads).toBe(2)
  })

  test("a returned Map or ignored list cannot change the cached policy", () => {
    const reader = createComputerPolicy({
      read: () => ({
        files: [],
        policies: [{ source: "mdm", text: '{"computer":{"apps":{"macos":{"com.apple.calculator":"deny"}}}}' }],
        ignored: [],
      }),
    })
    const first = reader.get()
    expect(first.apps instanceof Map).toBe(true)
    ;(first.apps as Map<string, "allow" | "deny">).set(Computer.appKey(APPLE), "allow")
    first.ignored.push("modified")
    first.enabled = false
    expect(policyAccess(APPLE, reader.get())).toBe("deny")
    expect(reader.get().ignored).toEqual([])
    expect(reader.get().enabled).toBe(true)
  })

  test("untrusted files are ignored without being read or disabling Hands", () => {
    const policy = createComputerPolicy({
      read: () => ({
        files: [],
        policies: [],
        ignored: [{ source: "/user/pretend-managed.json", reason: ConfigManaged.UNTRUSTED, kind: "untrusted" }],
      }),
      readFile: () => {
        throw new Error("An untrusted file must not be read")
      },
    }).get()
    expect(policy.enabled).toBe(true)
    expect(policy.managed).toBe(false)
    expect(policy.ignored).toHaveLength(1)
  })

  test("an unreadable managed source cannot be erased by a later readable allow", () => {
    const policy = createComputerPolicy({
      read: () => ({
        files: [],
        policies: [{ source: "mdm", text: '{"computer":{"enabled":true}}' }],
        ignored: [{ source: "/company/vector.json", reason: "Access denied", kind: "unreadable" }],
      }),
    }).get()
    expect(policy).toMatchObject({ managed: true, enabled: false, defaultAccess: "deny", allowAlways: false })
    expect(policy.ignored).toHaveLength(1)
  })

  test("a trusted file that becomes unreadable fails closed and recovers on explicit refresh", () => {
    const state = { fail: true }
    const reader = createComputerPolicy({
      read: () => ({ files: ["trusted"], policies: [], ignored: [] }),
      readFile: () => {
        if (state.fail) throw new Error("unreadable")
        return '{"computer":{"enabled":true}}'
      },
    })
    expect(reader.get().enabled).toBe(false)
    state.fail = false
    expect(reader.refresh().enabled).toBe(true)
    expect(reader.get().ignored).toEqual([])
  })

  test("source-reader failure fails closed rather than preserving an obsolete allow", () => {
    const policy = createComputerPolicy({
      read: () => {
        throw new Error("Trust check could not finish")
      },
    }).get()
    expect(policy).toMatchObject({ managed: true, enabled: false, defaultAccess: "deny" })
  })

  test("malformed JSONC or computer configuration never silently restores defaults", () => {
    for (const text of [
      '{"computer":',
      "null",
      "[]",
      '{"computer":null}',
      '{"computer":{"enabled":"yes"}}',
      '{"computer":{"hidden":true}}',
      '{"computer":{"screenshot_retention_days":-1}}',
      '{"computer":{"apps":{"windows":[{"publisher":"Contoso","access":"allow"}]}}}',
    ]) {
      const policy = createComputerPolicy({
        read: () => ({ files: [], policies: [{ source: "mdm", text }], ignored: [] }),
      }).get()
      expect(policy.enabled).toBe(false)
      expect(policy.defaultAccess).toBe("deny")
    }
  })

  test("a Team-ID-less third-party macOS rule is ignored and listed", () => {
    const policy = managed({ apps: { macos: { "com.example.editor": "allow" } } })
    expect(policy.apps.size).toBe(0)
    expect(policy.ignored).toHaveLength(1)
    expect(policy.ignored[0]).toContain("com.example.editor")
    expect(policyAccess(EDITOR, policy)).toBeUndefined()
  })

  test("third-party macOS rules bind the verified bundle and Team ID, ignoring display names", () => {
    const policy = managed({ apps: { macos: { "COM.EXAMPLE.EDITOR@TEAM123456": "allow" } } })
    expect(policy.apps.get("app:macos:com.example.editor@team123456")).toBe("allow")
    expect(policyAccess({ ...EDITOR, name: "A renamed app" }, policy)).toBe("allow")
    expect(policyAccess({ ...EDITOR, teamId: "OTHER12345" }, policy)).toBeUndefined()
    expect(policyAccess({ ...EDITOR, verified: false }, policy)).toBeUndefined()
  })

  test("plain Apple rules match only a verified Apple-anchored identity", () => {
    const policy = managed({ apps: { macos: { "com.apple.calculator": "allow" } } })
    expect(policyAccess(APPLE, policy)).toBe("allow")
    expect(policyAccess({ ...APPLE, apple: false, teamId: "TEAM123456" }, policy)).toBeUndefined()
    expect(policyAccess({ ...APPLE, verified: false }, policy)).toBeUndefined()
  })

  test("a deny beats an overlapping Apple or team allow and case-normalized duplicate", () => {
    const policy = managed({
      apps: {
        macos: {
          "com.apple.calculator": "deny",
          "COM.APPLE.CALCULATOR": "allow",
          "com.apple.calculator@TEAM123456": "allow",
        },
      },
    })
    expect(policyAccess({ ...APPLE, teamId: "TEAM123456" }, policy)).toBe("deny")
  })

  test("verified Windows AUMIDs match exactly and case-insensitively", () => {
    const policy = managed({ apps: { windows: [{ aumid: "Example.Reader_123!App", access: "allow" }] } })
    const app: Computer.AppIdentity = {
      platform: "windows",
      kind: "aumid",
      aumid: "EXAMPLE.READER_123!APP",
      verified: true,
      system: false,
      name: "A different display name",
    }
    expect(policyAccess(app, policy)).toBe("allow")
    expect(policyAccess({ ...app, aumid: "Example.Reader_123!Other" }, policy)).toBeUndefined()
    expect(policyAccess({ ...app, verified: false }, policy)).toBeUndefined()
  })

  test("Windows signer/product/binary keys use the shared escaped encoding", () => {
    const policy = managed({
      apps: {
        windows: [{ publisher: WINDOWS.publisher, product: WINDOWS.product, binary: "EDITOR.EXE", access: "allow" }],
      },
    })
    expect(policy.apps.get(Computer.appKey(WINDOWS))).toBe("allow")
    expect(policyAccess(WINDOWS, policy)).toBe("allow")
    expect(
      policyAccess({ ...WINDOWS, publisher: "Contoso", product: "Tools 100%|Editor | Pro 50%" }, policy),
    ).toBeUndefined()
    expect(policyAccess({ ...WINDOWS, publisher: "A different signer" }, policy)).toBeUndefined()
    expect(policyAccess({ ...WINDOWS, binary: "other.exe" }, policy)).toBeUndefined()
    expect(policyAccess({ ...WINDOWS, verified: false }, policy)).toBeUndefined()
  })

  test("an omitted Windows binary matches the verified product family, with deny winning overlaps", () => {
    const policy = managed({
      apps: {
        windows: [
          { publisher: WINDOWS.publisher, product: WINDOWS.product, access: "deny" },
          { publisher: WINDOWS.publisher, product: WINDOWS.product, binary: WINDOWS.binary, access: "allow" },
        ],
      },
    })
    expect(policyAccess(WINDOWS, policy)).toBe("deny")
    expect(policyAccess({ ...WINDOWS, binary: "other.exe" }, policy)).toBe("deny")
    expect(policyAccess({ ...WINDOWS, product: "Other product" }, policy)).toBeUndefined()
  })

  test("a file's deny survives a later OS-policy allow for the same app", () => {
    const policy = createComputerPolicy({
      read: () => ({
        files: ["company"],
        policies: [{ source: "mdm", text: '{"computer":{"apps":{"macos":{"com.apple.calculator":"allow"}}}}' }],
        ignored: [],
      }),
      readFile: () => '{"computer":{"apps":{"macos":{"com.apple.calculator":"deny"}}}}',
    }).get()
    expect(policyAccess(APPLE, policy)).toBe("deny")
  })

  test("invalid identity rules do not become broader allow rules", () => {
    const policy = managed({
      apps: {
        macos: { "com.example.editor@bad": "allow", "com.apple.*": "allow" },
        windows: [
          { aumid: "", access: "allow" },
          { publisher: "", product: WINDOWS.product, access: "allow" },
          { publisher: WINDOWS.publisher, product: WINDOWS.product, binary: "*", access: "allow" },
          { publisher: WINDOWS.publisher, product: WINDOWS.product, binary: "", access: "allow" },
        ],
      },
    })
    expect(policy.apps.size).toBe(0)
    expect(policy.ignored).toHaveLength(6)
    expect(policyAccess(APPLE, policy)).toBeUndefined()
    expect(policyAccess(WINDOWS, policy)).toBeUndefined()
  })

  test("unmanaged or reserved remote identities cannot manufacture company approval", () => {
    const unmanaged = { ...defaultPolicy(), apps: new Map([[Computer.appKey(APPLE), "allow"]] as const) }
    expect(policyAccess(APPLE, unmanaged)).toBeUndefined()
    expect(
      policyAccess({ platform: "remote", id: "reserved", name: "Remote", verified: false }, managed({})),
    ).toBeUndefined()
  })
})
