import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import { ConfigManaged } from "../../src/config/managed"
import { LocalPolicy } from "../../src/local-mode/policy"
import { LocalStartup } from "../../src/local-mode/startup"
import { tmpdir } from "../fixture/tmpdir"

// Whether the backstop starts Egress pending: every source Vector Local is read from at start can turn it on, and a
// block Vector cannot decode counts as on, since config keeps it on too.

const folders = (root: string) => ({
  managed: [path.join(root, "managed")],
  preferences: path.join(root, "preferences"),
  config: path.join(root, "config"),
  state: path.join(root, "state"),
})
const write = (file: string, text: string) => {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, text)
}
// On Windows no case here starts PowerShell. trusted() and plantedTrust() each answer with a fixture ACL reader that
// knows only this fixture's managed folder and its policy files that exist: a real read on a busy runner came back
// empty after 15.7 s and failed the planted case closed (job 136883105861). The real owner and access checks still
// judge what the reader answers, POSIX mode and owner checks stay real throughout, and the real PowerShell reader keeps
// its own tests in engine test/config/managed-trust.test.ts.
function trusted(root: string) {
  if (process.platform !== "win32") return { trust: { user: true } }
  return { trust: { user: true, acl: managedAcl(root, { owner: "S-1-5-18", rules: [] }) } }
}
// A company file a standard user could have written, as Windows would describe it: any user may create
// C:\ProgramData\vector and the files in it, and owns and fully controls what they create. Off Windows the real POSIX
// checks judge it.
function plantedTrust(root: string) {
  if (process.platform !== "win32") return {}
  return { trust: { acl: plantedAcl(root) } }
}
// A standard user's SID: the user running Vector, who planted the file.
const PLANTER = "S-1-5-21-1000000000-1000000000-1000000000-1001"
const FULL_CONTROL = 0x1f01ff
function plantedAcl(root: string) {
  return managedAcl(root, { owner: PLANTER, rules: [{ sid: PLANTER, rights: FULL_CONTROL, allow: true }] }, PLANTER)
}
// One owner and set of rules for the managed folder and each of its policy files that exists, and no other path.
function managedAcl(root: string, acl: ConfigManaged.Acl, user?: string): ConfigManaged.AclReader {
  const managed = path.join(root, "managed")
  const owned = new Set([managed, path.join(managed, "vector.json"), path.join(managed, "vector.jsonc")])
  return (paths) => ({
    ...(user ? { user } : {}),
    entries: Object.fromEntries(
      paths.filter((file) => owned.has(file) && fs.existsSync(file)).map((file) => [file, acl]),
    ),
  })
}
const COMPANY = {
  lock: true,
  web: "network",
  endpoints: ["https://gpu.corp.example.com"],
  allow: [{ source: "usage", reason: "Counts", added_at: 1, added_by: "app" }],
  updates: { url: "https://mirror.corp.example.com/vector/" },
}

describe("LocalStartup.enabled", () => {
  test("is off when nothing turns Vector Local on", async () => {
    await using dir = await tmpdir()
    const input = folders(dir.path)
    expect(LocalStartup.enabled({ ...input, env: {} })).toBe(false)
    write(path.join(input.config, "vector.json"), JSON.stringify({ model: "a/b", local: { enabled: false } }))
    write(path.join(input.managed[0]!, "vector.json"), JSON.stringify({ share: "disabled" }))
    expect(LocalStartup.enabled({ ...input, env: {} })).toBe(false)
  })

  test("is on for the environment, the company's policy and the user's own config files", async () => {
    await using dir = await tmpdir()
    const input = folders(dir.path)
    expect(LocalStartup.enabled({ ...input, env: { VECTOR_LOCAL: "1" } })).toBe(true)
    const on = JSON.stringify({ local: { enabled: true } })
    for (const file of [
      path.join(input.managed[0]!, "vector.jsonc"),
      path.join(input.config, "config.json"),
      path.join(input.config, "vector.json"),
      path.join(input.config, "vector.jsonc"),
    ]) {
      write(file, on)
      expect({ file, enabled: LocalStartup.enabled({ ...input, env: {} }) }).toEqual({ file, enabled: true })
      fs.rmSync(file)
    }
    // A company's lock forces it on.
    write(path.join(input.managed[0]!, "vector.json"), JSON.stringify({ local: { lock: true } }))
    expect(LocalStartup.enabled({ ...input, env: {} })).toBe(true)
  })

  test("is on for the desktop's config folder, the config overrides and VECTOR_CONFIG_CONTENT", async () => {
    await using dir = await tmpdir()
    const input = folders(dir.path)
    const desktop = path.join(dir.path, "desktop")
    write(path.join(desktop, "vector.local.jsonc"), `{ "local": { "enabled": true } }`)
    expect(LocalStartup.enabled({ ...input, env: { VECTOR_AGENT_CONFIG_DIR: desktop } })).toBe(true)
    const override = path.join(dir.path, "override.json")
    write(override, JSON.stringify({ local: { enabled: true } }))
    expect(LocalStartup.enabled({ ...input, env: { VECTOR_AGENT_CONFIG: override } })).toBe(true)
    expect(LocalStartup.enabled({ ...input, env: { VECTOR_CONFIG_CONTENT: `{"local":{"enabled":true}}` } })).toBe(true)
  })

  test("reads JSON with comments and trailing commas, as config does", async () => {
    await using dir = await tmpdir()
    const input = folders(dir.path)
    const file = path.join(input.config, "vector.jsonc")
    write(
      file,
      `{\n  "$schema": "https://vectordev.ai/config.json", // the schema\n  /* Vector Local */ "local": { "enabled": true, "web": "none", },\n}`,
    )
    expect(LocalStartup.enabled({ ...input, env: {} })).toBe(true)
    // A comment's or a bracket's characters inside a string are the string's.
    write(file, `{ "$schema": "https://vectordev.ai/config.json", "share": "// ,} /*", "local": { "enabled": false } }`)
    expect(LocalStartup.enabled({ ...input, env: {} })).toBe(false)
    // Text that is not JSON counts when it names a local block, which config's lenient reader may still find.
    write(file, `{ "local": { "enabled": true }`)
    expect(LocalStartup.enabled({ ...input, env: {} })).toBe(true)
    write(file, `{ "model": `)
    expect(LocalStartup.enabled({ ...input, env: {} })).toBe(false)
  })

  test("is on for a local block Vector cannot decode, which config keeps on too", async () => {
    await using dir = await tmpdir()
    const input = folders(dir.path)
    write(path.join(input.config, "vector.json"), JSON.stringify({ local: { enabled: "yes" } }))
    expect(LocalStartup.enabled({ ...input, env: {} })).toBe(true)
  })

  test("is on while the block the owner last let apply still turns it on", async () => {
    await using dir = await tmpdir()
    const input = folders(dir.path)
    // An edit that turned it off while Vector was closed waits for the owner; config keeps the confirmed block.
    write(path.join(input.config, "vector.json"), JSON.stringify({ local: { enabled: false } }))
    write(path.join(input.state, "local-confirmed-0123456789abcdef.json"), JSON.stringify({ local: { enabled: true } }))
    expect(LocalStartup.enabled({ ...input, env: {} })).toBe(true)
    write(path.join(input.state, "local-confirmed-0123456789abcdef.json"), JSON.stringify({ local: null }))
    expect(LocalStartup.enabled({ ...input, env: {} })).toBe(false)
  })

  test("is on for a macOS profile that sets Vector Local, which it cannot convert without running a program", async () => {
    await using dir = await tmpdir()
    const input = folders(dir.path)
    write(path.join(input.preferences, "ai.vector.managed.plist"), "bplist00Ñ\u0001\u0002Ulocal")
    expect(LocalStartup.enabled({ ...input, env: {}, platform: "darwin" })).toBe(true)
    expect(LocalStartup.enabled({ ...input, env: {}, platform: "linux" })).toBe(false)
  })
})

// The policy of a process whose config never resolves it, the desktop's main process: the user's own config and the
// environment decide it, and every other source can only turn it on.
describe("LocalStartup.policy", () => {
  test("is the user's own policy, from the global folder and the desktop's own folder", async () => {
    await using dir = await tmpdir()
    const input = folders(dir.path)
    const desktop = path.join(dir.path, "desktop")
    const env = { VECTOR_CLIENT: "desktop", VECTOR_AGENT_CONFIG_DIR: desktop }
    expect(LocalStartup.policy({ ...input, env })).toMatchObject({ enabled: false })
    write(path.join(input.config, "vector.json"), JSON.stringify({ local: { web_domains: { deny: ["a.example"] } } }))
    write(
      path.join(desktop, "vector.json"),
      JSON.stringify({ local: { enabled: true, web: "network", endpoints: ["http://127.0.0.1:11434"] } }),
    )
    const resolved = LocalStartup.policy({ ...input, env })
    expect(resolved).toMatchObject({
      enabled: true,
      web: "network",
      web_domains: { deny: ["a.example"] },
      endpoints: [{ origin: "http://127.0.0.1:11434", from: "user" }],
    })
    expect(resolved.pending).toBeUndefined()
    // A block Vector cannot decode keeps it on with no web.
    write(path.join(desktop, "vector.json"), JSON.stringify({ local: { enabled: "yes" } }))
    expect(LocalStartup.policy({ ...input, env })).toMatchObject({ enabled: true, web: "none" })
  })

  test("reads a company's file as the engine's config does: its lists, its lock and its mirror", async () => {
    await using dir = await tmpdir()
    const input = { ...folders(dir.path), ...trusted(dir.path) }
    write(
      path.join(input.config, "vector.json"),
      JSON.stringify({ local: { web: "ask", endpoints: ["http://127.0.0.1:1"] } }),
    )
    const company = { ...COMPANY, user_may: ["web"] }
    write(path.join(input.managed[0]!, "vector.json"), JSON.stringify({ local: company }))
    // The pure function the engine resolves, with the same blocks.
    const engine = LocalPolicy.resolve({
      managed: company as never,
      global: { web: "ask", endpoints: ["http://127.0.0.1:1"] },
      env: {},
    })
    const desktop = LocalStartup.policy({ ...input, env: {} })
    expect(desktop).toEqual(engine)
    expect(desktop).toMatchObject({
      enabled: true,
      lock: true,
      web: "network",
      endpoints: [{ origin: "https://gpu.corp.example.com", from: "managed" }],
      allow: [{ source: "usage" }],
      updates: { url: "https://mirror.corp.example.com/vector/" },
    })
  })

  test("leaves out a company file a standard user could have written, as the engine's config does", async () => {
    await using dir = await tmpdir()
    const input = folders(dir.path)
    write(path.join(input.config, "vector.json"), JSON.stringify({ local: { web: "ask" } }))
    const company = path.join(input.managed[0]!, "vector.json")
    write(company, JSON.stringify({ local: COMPANY }))
    // The user running the test owns it: in C:\ProgramData any user may create such a file.
    const planted = LocalStartup.policy({ ...input, ...plantedTrust(dir.path), env: {} })
    expect(planted).toMatchObject({ enabled: false, lock: false, endpoints: [], allow: [] })
    expect(planted.updates).toBeUndefined()
    expect(planted.warnings.some((warning) => warning.startsWith(ConfigManaged.UNTRUSTED))).toBe(true)
    // One another user could change is left out too, whoever owns it.
    if (process.platform !== "win32") {
      fs.chmodSync(company, 0o664)
      expect(LocalStartup.policy({ ...input, ...trusted(dir.path), env: {} })).toMatchObject({
        enabled: false,
        lock: false,
      })
      fs.chmodSync(company, 0o644)
    }
    expect(LocalStartup.policy({ ...input, ...trusted(dir.path), env: {} })).toMatchObject({
      enabled: true,
      lock: true,
    })
  })

  test("a planted company file is left out on Windows without PowerShell, and a failed or timed-out ACL read turns Vector Local on", async () => {
    await using dir = await tmpdir()
    const input = folders(dir.path)
    const managed = input.managed[0]!
    write(path.join(input.config, "vector.json"), JSON.stringify({ local: { web: "ask" } }))
    write(path.join(managed, "vector.json"), JSON.stringify({ local: COMPANY }))
    // The Windows checks on any computer, with the fixture's reader in PowerShell's place: the user running Vector owns
    // the managed folder and its file, and may change both.
    const planted = LocalStartup.policy({ ...input, trust: { platform: "win32", acl: plantedAcl(dir.path) }, env: {} })
    expect(planted).toMatchObject({ enabled: false, lock: false, endpoints: [], allow: [] })
    expect(planted.updates).toBeUndefined()
    expect(planted.warnings).toEqual([
      `${ConfigManaged.UNTRUSTED} ${managed} is not owned by Administrators or SYSTEM.`,
    ])
    // The reader answers only for the managed folder and its policy files that exist.
    const theirs = { owner: PLANTER, rules: [{ sid: PLANTER, rights: FULL_CONTROL, allow: true }] }
    expect(
      plantedAcl(dir.path)([
        managed,
        path.join(managed, "vector.json"),
        path.join(managed, "vector.jsonc"),
        path.join(managed, "other.json"),
      ]),
    ).toEqual({ user: PLANTER, entries: { [managed]: theirs, [path.join(managed, "vector.json")]: theirs } })
    // What the real reader returns when PowerShell fails or runs past its timeout: no entries. The file may hold the
    // company's policy, so Vector Local stays on with Web access None, as job 136883105861 saw.
    const empty = LocalStartup.policy({
      ...input,
      trust: { platform: "win32", acl: () => ({ entries: {} }) },
      env: {},
    })
    expect(empty).toMatchObject({ enabled: true, web: "none", lock: false, endpoints: [] })
    expect(empty.warnings).toEqual([`Vector could not read who may change ${managed}.`])
  })

  test("lets an override and the confirmed block only turn it on and tighten Web access", async () => {
    await using dir = await tmpdir()
    const input = folders(dir.path)
    write(path.join(input.config, "vector.json"), JSON.stringify({ local: { web: "ask" } }))
    const override = path.join(dir.path, "override.json")
    write(
      override,
      JSON.stringify({ local: { enabled: true, web: "network", endpoints: ["http://10.0.0.5:8000"], lock: true } }),
    )
    // What it would let through, or lock, does not apply.
    expect(LocalStartup.policy({ ...input, env: { VECTOR_AGENT_CONFIG: override } })).toMatchObject({
      enabled: true,
      web: "network",
      lock: false,
      endpoints: [],
    })
    expect(
      LocalStartup.policy({ ...input, env: { VECTOR_CONFIG_CONTENT: `{"local":{"enabled":true}}` } }),
    ).toMatchObject({ enabled: true, web: "ask" })
    write(path.join(input.state, "local-confirmed-0123456789abcdef.json"), JSON.stringify({ local: { enabled: true } }))
    expect(LocalStartup.policy({ ...input, env: {} })).toMatchObject({ enabled: true })
  })

  test("turns it on with Web access None for a company policy file it cannot read, as config does", async () => {
    await using dir = await tmpdir()
    const input = { ...folders(dir.path), ...trusted(dir.path) }
    write(path.join(input.config, "vector.json"), JSON.stringify({ local: { enabled: false } }))
    // A folder where the company's file belongs: the file system refuses to read it, as it refuses a file without
    // permission, whoever runs the test.
    const company = path.join(input.managed[0]!, "vector.json")
    fs.mkdirSync(company, { recursive: true })
    expect(LocalStartup.enabled({ ...input, env: {} })).toBe(true)
    expect(LocalStartup.policy({ ...input, env: {} })).toMatchObject({ enabled: true, web: "none" })
    fs.rmSync(company, { recursive: true })
    // A file it may not read, where permissions apply to the user running the test.
    if (process.platform !== "win32" && process.getuid?.() !== 0) {
      write(company, JSON.stringify({ local: { enabled: false } }))
      fs.chmodSync(company, 0o000)
      expect(LocalStartup.policy({ ...input, env: {} })).toMatchObject({ enabled: true, web: "none" })
      fs.chmodSync(company, 0o644)
    }
    // A missing file says nothing.
    fs.rmSync(company, { force: true })
    expect(LocalStartup.policy({ ...input, env: {} })).toMatchObject({ enabled: false })
  })

  test("does not turn it on for a macOS profile, which it cannot read without running a program", async () => {
    await using dir = await tmpdir()
    const input = folders(dir.path)
    write(path.join(input.preferences, "ai.vector.managed.plist"), "bplist00Ñ\u0001\u0002Ulocal")
    expect(LocalStartup.enabled({ ...input, env: {}, platform: "darwin" })).toBe(true)
    expect(LocalStartup.policy({ ...input, env: {}, platform: "darwin" })).toMatchObject({ enabled: false })
  })
})

describe("LocalStartup.managed", () => {
  test("is whether company policy an administrator alone could have written is on this computer", async () => {
    await using dir = await tmpdir()
    const input = { ...folders(dir.path), ...trusted(dir.path) }
    expect(LocalStartup.managed({ ...input, env: {} })).toBe(false)
    write(path.join(input.config, "vector.json"), JSON.stringify({ local: { enabled: true } }))
    expect(LocalStartup.managed({ ...input, env: {} })).toBe(false)
    const company = path.join(input.managed[0]!, "vector.json")
    write(company, JSON.stringify({ share: "disabled" }))
    expect(LocalStartup.managed({ ...input, env: {} })).toBe(true)
    // A file any user could have made, such as a "{}" in C:\ProgramData\vector, is not company policy.
    expect(LocalStartup.managed({ ...folders(dir.path), ...plantedTrust(dir.path), env: {} })).toBe(false)
    if (process.platform !== "win32") {
      fs.chmodSync(company, 0o666)
      expect(LocalStartup.managed({ ...input, env: {} })).toBe(false)
    }
  })
})

describe("LocalStartup.ca", () => {
  test("names the company's certificate files, then the user's, read from the folder of the file that names them", async () => {
    await using dir = await tmpdir()
    const input = { ...folders(dir.path), ...trusted(dir.path) }
    expect(LocalStartup.ca({ ...input, env: {} })).toEqual([])
    write(path.join(input.managed[0]!, "vector.json"), JSON.stringify({ local: { ca: { files: ["corp-root.pem"] } } }))
    write(
      path.join(input.config, "vector.jsonc"),
      `{
        // the lab's own root, written with a comment and an absolute path
        "local": { "ca": { "files": [${JSON.stringify(path.join(dir.path, "lab.pem"))}, "../corp-root-copy.pem",] } },
      }`,
    )
    expect(LocalStartup.ca({ ...input, env: {} })).toEqual([
      path.join(input.managed[0]!, "corp-root.pem"),
      path.join(dir.path, "lab.pem"),
      path.join(dir.path, "corp-root-copy.pem"),
    ])
  })

  test("says which files the company named and which the user's own config did", async () => {
    await using dir = await tmpdir()
    const input = { ...folders(dir.path), ...trusted(dir.path), env: {} }
    const corp = path.join(dir.path, "corp.pem")
    const lab = path.join(dir.path, "lab.pem")
    write(path.join(input.managed[0]!, "vector.json"), JSON.stringify({ local: { ca: { files: [corp] } } }))
    write(path.join(input.config, "vector.json"), JSON.stringify({ local: { ca: { files: [lab, corp] } } }))
    // A file both name is the company's, which needs no one's answer.
    expect(LocalStartup.authorities(input)).toEqual({ company: [corp], user: [lab] })
    expect(LocalStartup.ca(input)).toEqual([corp, lab])
  })

  test("reads only the company's files under a lock, and none from the environment or a block it cannot decode", async () => {
    await using dir = await tmpdir()
    const input = { ...folders(dir.path), ...trusted(dir.path) }
    const user = path.join(dir.path, "user.pem")
    const corp = path.join(dir.path, "corp.pem")
    write(path.join(input.config, "vector.json"), JSON.stringify({ local: { ca: { files: [user] } } }))
    write(path.join(input.config, "config.json"), `{ "local": { "ca": 7 } }`)
    const env = {
      VECTOR_CONFIG_CONTENT: JSON.stringify({ local: { ca: { files: [path.join(dir.path, "env.pem")] } } }),
    }
    expect(LocalStartup.ca({ ...input, env })).toEqual([user])
    write(path.join(input.managed[0]!, "vector.json"), JSON.stringify({ local: { lock: true, ca: { files: [corp] } } }))
    expect(LocalStartup.ca({ ...input, env })).toEqual([corp])
  })

  test("takes none from a managed file a standard user could have written, which drops none of the user's either", async () => {
    await using dir = await tmpdir()
    const input = folders(dir.path)
    const user = path.join(dir.path, "user.pem")
    write(path.join(input.config, "vector.json"), JSON.stringify({ local: { ca: { files: [user] } } }))
    const company = path.join(input.managed[0]!, "vector.json")
    // A file the user running Vector owns, as anyone can create one in C:\ProgramData\vector.
    write(company, JSON.stringify({ local: { lock: true, ca: { files: ["evil.pem"] } } }))
    expect(LocalStartup.ca({ ...input, ...plantedTrust(dir.path), env: {} })).toEqual([user])
    // One another user could change, though only an administrator may own the folder's files.
    if (process.platform !== "win32") {
      fs.chmodSync(company, 0o664)
      expect(LocalStartup.ca({ ...input, ...trusted(dir.path), env: {} })).toEqual([user])
      fs.chmodSync(path.dirname(company), 0o777)
      fs.chmodSync(company, 0o644)
      expect(LocalStartup.ca({ ...input, ...trusted(dir.path), env: {} })).toEqual([user])
      fs.chmodSync(path.dirname(company), 0o755)
    }
    expect(LocalStartup.ca({ ...input, ...trusted(dir.path), env: {} })).toEqual([
      path.join(input.managed[0]!, "evil.pem"),
    ])
  })
})
