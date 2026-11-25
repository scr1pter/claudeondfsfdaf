import { afterEach, describe, expect, test } from "bun:test"
import { chmodSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "fs"
import path from "path"
import { Effect, Layer } from "effect"
import { HttpClient } from "effect/unstable/http"
import { LayerNode } from "@vectordevai/core/effect/layer-node"
import { httpClient } from "@vectordevai/core/effect/app-node-platform"
import { FSUtil } from "@vectordevai/core/fs-util"
import { Npm } from "@vectordevai/core/npm"
import { CrossSpawnSpawner } from "@vectordevai/core/cross-spawn-spawner"
import { Config } from "@/config/config"
import { ConfigManaged } from "@vectordevai/core/config/managed"
import { Auth } from "../../src/auth"
import { Env } from "../../src/env"
import { AuthTest } from "../fake/auth"
import { NpmTest } from "../fake/npm"
import { testEffect } from "../lib/effect"
import { tmpdir } from "../fixture/fixture"
import { NetworkGuard } from "../../../core/test/lib/network-guard"

// Company policy counts only when an administrator is the only one who could have written it. These tests check the
// trust rules on their own (POSIX modes, Windows access rules through a fake reader, the policy key's output) and then
// that the config loader and Vector Local both leave out a managed file a standard user could change.

const guard = NetworkGuard.use()

const managedDirectory = process.env.VECTOR_TEST_MANAGED_CONFIG_DIR!
const engineDirectory = path.resolve(import.meta.dir, "../..")

const it = testEffect(
  LayerNode.compile(LayerNode.group([Config.node, FSUtil.node, Env.node, CrossSpawnSpawner.node]), [
    [Auth.node, AuthTest.empty],
    [Npm.node, NpmTest.noop],
    [
      httpClient,
      Layer.succeed(
        HttpClient.HttpClient,
        HttpClient.make((request) => Effect.die(`unexpected http request: ${request.url}`)),
      ),
    ],
  ]),
)

afterEach(() => {
  rmSync(managedDirectory, { recursive: true, force: true })
  Config.refreshLocal()
  expect(guard.outside()).toEqual([])
})

const SYSTEM = "S-1-5-18"
const ADMINISTRATORS = "S-1-5-32-544"
const USERS = "S-1-5-32-545"
const EVERYONE = "S-1-1-0"
const CREATOR_OWNER = "S-1-3-0"
const SOMEONE = "S-1-5-21-1000-2000-3000-1001"
const FULL = 0x1f01ff
const READ = 0x1200a9

// Access rules as Get-Acl returns them for a folder an administrator made under C:\ProgramData: Users may create
// files there (and own what they create), which the file check catches.
const adminFolder = (...extra: ConfigManaged.AclRule[]): ConfigManaged.Acl => ({
  owner: ADMINISTRATORS,
  rules: [
    { sid: SYSTEM, rights: FULL, allow: true },
    { sid: ADMINISTRATORS, rights: FULL, allow: true },
    { sid: CREATOR_OWNER, rights: FULL, allow: true, inheritOnly: true },
    { sid: USERS, rights: READ | 0x2 | 0x4 | 0x10 | 0x100, allow: true },
    ...extra,
  ],
})
const adminFile = (...extra: ConfigManaged.AclRule[]): ConfigManaged.Acl => ({
  owner: ADMINISTRATORS,
  rules: [
    { sid: SYSTEM, rights: FULL, allow: true },
    { sid: ADMINISTRATORS, rights: FULL, allow: true },
    { sid: USERS, rights: READ, allow: true },
    ...extra,
  ],
})

async function managedFile() {
  const dir = await tmpdir()
  const folder = path.join(dir.path, "vector")
  mkdirSync(folder)
  const file = path.join(folder, "vector.json")
  writeFileSync(file, "{}")
  return { dir, folder, file }
}

function fakeAcl(folder: string, file: string, entries: { folder?: ConfigManaged.Acl; file?: ConfigManaged.Acl }) {
  const reads: (readonly string[])[] = []
  const reader: ConfigManaged.AclReader = (paths) => {
    reads.push(paths)
    return {
      user: SOMEONE,
      entries: Object.fromEntries(
        [
          [folder, entries.folder],
          [file, entries.file],
        ].filter((entry) => entry[1] !== undefined),
      ),
    }
  }
  return { reader, reads }
}

describe("POSIX ownership", () => {
  const owners = [0]

  test("a root-owned file or folder no one else may write is trusted", () => {
    expect(ConfigManaged.posixReason({ path: "/etc/vector/vector.json", uid: 0, mode: 0o100644 }, owners)).toBe(
      undefined,
    )
    expect(ConfigManaged.posixReason({ path: "/etc/vector", uid: 0, mode: 0o040755 }, owners)).toBe(undefined)
  })

  test("a file owned by anyone but root is ignored", () => {
    expect(ConfigManaged.posixReason({ path: "/etc/vector/vector.json", uid: 501, mode: 0o100644 }, owners)).toBe(
      "/etc/vector/vector.json is not owned by root.",
    )
  })

  test("a managed file writable by group or world is ignored", () => {
    expect(ConfigManaged.posixReason({ path: "/etc/vector/vector.json", uid: 0, mode: 0o100664 }, owners)).toBe(
      "/etc/vector/vector.json can be changed by other users.",
    )
    expect(ConfigManaged.posixReason({ path: "/etc/vector/vector.json", uid: 0, mode: 0o100646 }, owners)).toBe(
      "/etc/vector/vector.json can be changed by other users.",
    )
    expect(ConfigManaged.posixReason({ path: "/etc/vector", uid: 0, mode: 0o040777 }, owners)).toBe(
      "/etc/vector can be changed by other users.",
    )
  })

  test("a group write counts even for root's own group, so a Linux access list's mask cannot hide a writer", () => {
    // With an access control list, the group bits are the list's mask: any entry that lets another user write sets them.
    expect(ConfigManaged.posixReason({ path: "/etc/vector", uid: 0, mode: 0o040775 }, owners)).toBe(
      "/etc/vector can be changed by other users.",
    )
  })

  test("a world-writable folder with the sticky bit is trusted, since only owners can replace its entries", () => {
    expect(ConfigManaged.posixReason({ path: "/tmp", uid: 0, mode: 0o041777 }, owners)).toBe(undefined)
    // The sticky bit means nothing on a file.
    expect(ConfigManaged.posixReason({ path: "/tmp/vector.json", uid: 0, mode: 0o101666 }, owners)).toBe(
      "/tmp/vector.json can be changed by other users.",
    )
  })

  test.skipIf(process.platform === "win32")("checks the real file and every folder above it", async () => {
    const { dir, folder, file } = await managedFile()
    await using _ = dir
    // A file the test user made is not root's.
    expect(ConfigManaged.untrusted(file)).toEndWith("is not owned by root.")
    // The test managed folder lets the user own it; no one else may still write it.
    expect(ConfigManaged.untrusted(file, { user: true })).toBe(undefined)
    chmodSync(file, 0o666)
    expect(ConfigManaged.untrusted(file, { user: true })).toBe(`${realpathSync(file)} can be changed by other users.`)
    chmodSync(file, 0o644)
    chmodSync(folder, 0o777)
    expect(ConfigManaged.untrusted(file, { user: true })).toBe(`${realpathSync(folder)} can be changed by other users.`)
    chmodSync(folder, 0o755)
    expect(ConfigManaged.untrusted(path.join(folder, "missing.json"))).toBe(undefined)
  })

  test.skipIf(process.platform === "win32")("follows a link in the managed folder to the file it names", async () => {
    const { dir, folder } = await managedFile()
    await using _ = dir
    const target = path.join(dir.path, "elsewhere")
    mkdirSync(target)
    writeFileSync(path.join(target, "vector.json"), "{}")
    chmodSync(target, 0o777)
    const link = path.join(folder, "vector.jsonc")
    symlinkSync(path.join(target, "vector.json"), link)
    expect(ConfigManaged.untrusted(link, { user: true })).toEndWith("elsewhere can be changed by other users.")
  })
})

describe("Windows access rules", () => {
  test("a folder and file only administrators may change are trusted", async () => {
    const { dir, folder, file } = await managedFile()
    await using _ = dir
    const acl = fakeAcl(folder, file, { folder: adminFolder(), file: adminFile() })
    expect(ConfigManaged.untrusted(file, { platform: "win32", acl: acl.reader })).toBe(undefined)
    expect(acl.reads).toEqual([[folder, file]])
    // SYSTEM and TrustedInstaller own files too.
    expect(
      ConfigManaged.untrusted(file, {
        platform: "win32",
        acl: fakeAcl(folder, file, { folder: adminFolder(), file: { ...adminFile(), owner: SYSTEM } }).reader,
      }),
    ).toBe(undefined)
  })

  test("a file owned by a standard user is ignored", async () => {
    const { dir, folder, file } = await managedFile()
    await using _ = dir
    const acl = fakeAcl(folder, file, { folder: adminFolder(), file: { ...adminFile(), owner: SOMEONE } })
    expect(ConfigManaged.untrusted(file, { platform: "win32", acl: acl.reader })).toBe(
      `${file} is not owned by Administrators or SYSTEM.`,
    )
    // Only the test managed folder lets the user running Vector own it.
    expect(ConfigManaged.untrusted(file, { platform: "win32", acl: acl.reader, user: true })).toBe(undefined)
  })

  test("a file that grants Users or Everyone write access is ignored", async () => {
    const { dir, folder, file } = await managedFile()
    await using _ = dir
    for (const [sid, rights] of [
      [USERS, 0x2],
      [USERS, 0x4],
      [EVERYONE, 0x10000],
      [SOMEONE, 0x40000],
      [USERS, 0x10000000],
      [USERS, 0x40000000],
    ] as const) {
      const acl = fakeAcl(folder, file, { folder: adminFolder(), file: adminFile({ sid, rights, allow: true }) })
      expect(ConfigManaged.untrusted(file, { platform: "win32", acl: acl.reader })).toBe(
        `${file} lets ${sid} change it.`,
      )
    }
  })

  test("a folder that lets Users delete or replace its files is ignored; creating new files is not enough", async () => {
    const { dir, folder, file } = await managedFile()
    await using _ = dir
    const deleting = fakeAcl(folder, file, {
      folder: adminFolder({ sid: USERS, rights: 0x40, allow: true }),
      file: adminFile(),
    })
    expect(ConfigManaged.untrusted(file, { platform: "win32", acl: deleting.reader })).toBe(
      `${folder} lets ${USERS} change it.`,
    )
    const owned = fakeAcl(folder, file, { folder: { ...adminFolder(), owner: SOMEONE }, file: adminFile() })
    expect(ConfigManaged.untrusted(file, { platform: "win32", acl: owned.reader })).toBe(
      `${folder} is not owned by Administrators or SYSTEM.`,
    )
  })

  test("deny rules and rules for what is created inside a folder do not count against it", async () => {
    const { dir, folder, file } = await managedFile()
    await using _ = dir
    const acl = fakeAcl(folder, file, {
      folder: adminFolder({ sid: USERS, rights: FULL, allow: true, inheritOnly: true }),
      file: adminFile({ sid: EVERYONE, rights: FULL, allow: false }),
    })
    expect(ConfigManaged.untrusted(file, { platform: "win32", acl: acl.reader })).toBe(undefined)
  })

  test("a file whose access rules cannot be read is ignored", async () => {
    const { dir, folder, file } = await managedFile()
    await using _ = dir
    const acl = fakeAcl(folder, file, { folder: adminFolder() })
    expect(ConfigManaged.untrusted(file, { platform: "win32", acl: acl.reader })).toBe(
      `Vector could not read who may change ${file}.`,
    )
  })

  test.skipIf(process.platform !== "win32")("checks a real file's access rules with PowerShell", async () => {
    const { dir, file } = await managedFile()
    await using _ = dir
    // A file in the user's temporary folder is the user's, or grants them full control.
    expect(ConfigManaged.untrusted(file)).toBeString()
    expect(ConfigManaged.untrusted(file, { user: true })).toBe(undefined)
    const granted = Bun.spawnSync(["icacls", file, "/grant", `*${EVERYONE}:(W)`])
    expect(granted.exitCode).toBe(0)
    // The verdict is kept until the file changes; rewriting it makes sure this check reads the new rules.
    writeFileSync(file, "{ }")
    expect(ConfigManaged.untrusted(file, { user: true })).toBe(`${file} lets ${EVERYONE} change it.`)
  })

  test.skipIf(process.platform !== "win32")(
    "reads a real folder's access rules in the policy file's place",
    async () => {
      await using dir = await tmpdir()
      const folder = path.join(dir.path, "vector.json")
      mkdirSync(folder)
      // A read that missed the folder would say "Vector could not read who may change" it.
      expect(ConfigManaged.untrusted(folder, { user: true })).toBe(undefined)
    },
  )
})

describe("the Windows policy key", () => {
  test("reads the Config value from reg query's output", () => {
    const text = '{"local":{"enabled":true,"lock":true}}'
    expect(
      ConfigManaged.parseRegistry(
        `\r\nHKEY_LOCAL_MACHINE\\SOFTWARE\\Policies\\Vector\r\n    Config    REG_SZ    ${text}\r\n\r\n`,
      ),
    ).toEqual({ text })
    expect(
      ConfigManaged.parseRegistry(
        `\nHKEY_LOCAL_MACHINE\\SOFTWARE\\Policies\\Vector\n    Config    REG_EXPAND_SZ    {}\n    Other    REG_SZ    x\n`,
      ),
    ).toEqual({ text: "{}" })
  })

  test("reads nothing from a key without the value", () => {
    expect(ConfigManaged.parseRegistry("\r\nHKEY_LOCAL_MACHINE\\SOFTWARE\\Policies\\Vector\r\n")).toBe(undefined)
    expect(ConfigManaged.parseRegistry("    Other    REG_SZ    {}\r\n")).toBe(undefined)
    expect(ConfigManaged.parseRegistry("    Config    REG_SZ    \r\n")).toBe(undefined)
  })

  test("refuses a value of another type or on several lines rather than reading part of it", () => {
    expect(ConfigManaged.parseRegistry('    Config    REG_MULTI_SZ    {"local":\\0{"enabled":true}}\r\n')).toEqual({
      reason: `${ConfigManaged.REGISTRY_KEY} holds Config as REG_MULTI_SZ. Vector reads it only as one line of JSON in a REG_SZ value.`,
    })
    expect(ConfigManaged.parseRegistry("    Config    REG_DWORD    0x1\r\n")).toEqual({
      reason: `${ConfigManaged.REGISTRY_KEY} holds Config as REG_DWORD. Vector reads it only as one line of JSON in a REG_SZ value.`,
    })
    expect(
      ConfigManaged.parseRegistry('    Config    REG_SZ    {\r\n  "local": { "enabled": true }\r\n}\r\n\r\n'),
    ).toEqual({
      reason: `${ConfigManaged.REGISTRY_KEY} holds Config on more than one line. Vector reads it only as one line of JSON.`,
    })
  })
})

describe("system tools and folders", () => {
  test("the tools that read company policy are run by absolute path, never through PATH", () => {
    expect(ConfigManaged.PLUTIL).toBe("/usr/bin/plutil")
    expect(ConfigManaged.REG).toBe("C:\\Windows\\System32\\reg.exe")
    expect(ConfigManaged.POWERSHELL).toBe("C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe")
  })

  test("C:\\ProgramData\\vector is always checked, whatever ProgramData says", () => {
    const previous = process.env.ProgramData
    try {
      process.env.ProgramData = "D:\\Empty"
      expect(ConfigManaged.systemDirectories("win32")).toEqual(["C:\\ProgramData\\vector", "D:\\Empty\\vector"])
      process.env.ProgramData = "c:\\programdata"
      expect(ConfigManaged.systemDirectories("win32")).toEqual(["C:\\ProgramData\\vector"])
      delete process.env.ProgramData
      expect(ConfigManaged.systemDirectories("win32")).toEqual(["C:\\ProgramData\\vector"])
    } finally {
      if (previous === undefined) delete process.env.ProgramData
      else process.env.ProgramData = previous
    }
    expect(ConfigManaged.systemDirectories("darwin")).toEqual(["/Library/Application Support/vector"])
    expect(ConfigManaged.systemDirectories("linux")).toEqual(["/etc/vector"])
  })

  test("reads PowerShell's owner and access rules as SIDs, and leaves out a path it could not read", () => {
    const paths = ["C:\\ProgramData\\vector", "C:\\ProgramData\\vector\\vector.json"]
    expect(
      ConfigManaged.parseAcl(
        [
          `U ${SOMEONE}`,
          `O 0 ${ADMINISTRATORS}`,
          `R 0 ${SYSTEM} ${FULL} 1 0`,
          `R 0 ${CREATOR_OWNER} 268435456 1 1`,
          `R 0 ${USERS} -1610612736 1 0`,
          `R 0 ${EVERYONE} ${FULL} 0 0`,
          "C 0",
          `O 1 ${SYSTEM}`,
          "R 1 broken",
          "C 1",
          "",
        ].join("\r\n"),
        paths,
      ),
    ).toEqual({
      user: SOMEONE,
      entries: {
        [paths[0]!]: {
          owner: ADMINISTRATORS,
          rules: [
            { sid: SYSTEM, rights: FULL, allow: true, inheritOnly: false },
            { sid: CREATOR_OWNER, rights: 0x10000000, allow: true, inheritOnly: true },
            { sid: USERS, rights: -1610612736, allow: true, inheritOnly: false },
            { sid: EVERYONE, rights: FULL, allow: false, inheritOnly: false },
          ],
        },
        [paths[1]!]: undefined,
      },
    })
  })

  test.skipIf(process.platform !== "darwin")(
    "reads the MDM profile with the system's plutil, after the trust check",
    async () => {
      await using dir = await tmpdir()
      const root = path.join(dir.path, "Managed Preferences")
      mkdirSync(root)
      const plist = path.join(root, "ai.vector.managed.plist")
      writeFileSync(
        plist,
        '<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0"><dict><key>model</key><string>company/model</string><key>PayloadUUID</key><string>x</string></dict></plist>\n',
      )
      const source = `mobileconfig:${plist}`
      // A profile a standard user put there is not company policy.
      expect(ConfigManaged.preferences(root)).toEqual({
        source,
        reason: `${realpathSync(plist)} is not owned by root.`,
        kind: "untrusted",
      })
      chmodSync(plist, 0o666)
      expect(ConfigManaged.preferences(root, { user: true })).toEqual({
        source,
        reason: `${realpathSync(plist)} can be changed by other users.`,
        kind: "untrusted",
      })
      chmodSync(plist, 0o644)
      // A plutil earlier in PATH that prints nothing useful is never run.
      const bin = path.join(dir.path, "bin")
      mkdirSync(bin)
      writeFileSync(path.join(bin, "plutil"), "#!/bin/sh\necho '{}'\n", { mode: 0o755 })
      const previous = process.env.PATH
      process.env.PATH = `${bin}:${previous}`
      try {
        expect(ConfigManaged.preferences(root, { user: true })).toEqual({
          source,
          text: JSON.stringify({ model: "company/model" }),
        })
      } finally {
        process.env.PATH = previous
      }
      // A profile plutil cannot convert is reported, not dropped.
      writeFileSync(plist, "not a property list")
      const unreadable = ConfigManaged.preferences(root, { user: true })
      expect(unreadable).toMatchObject({ source, kind: "unreadable" })
      expect(unreadable && "reason" in unreadable ? unreadable.reason : "").toStartWith(
        `Vector could not read ${plist}: `,
      )
    },
  )
})

describe("managed config", () => {
  test("lists a trusted managed file and leaves out one a standard user could change", () => {
    mkdirSync(managedDirectory, { recursive: true })
    const json = path.join(managedDirectory, "vector.json")
    const jsonc = path.join(managedDirectory, "vector.jsonc")
    writeFileSync(json, "{}")
    writeFileSync(jsonc, "{}")
    expect(ConfigManaged.read()).toEqual({ files: [json, jsonc], policies: [], ignored: [] })
    if (process.platform === "win32") return
    chmodSync(jsonc, 0o666)
    // A reason names the file it checked, as the system resolves it.
    expect(ConfigManaged.read()).toEqual({
      files: [json],
      policies: [],
      ignored: [{ source: jsonc, reason: `${realpathSync(jsonc)} can be changed by other users.`, kind: "untrusted" }],
    })
  })

  it.instance(
    "a trusted managed file still overrides the user's config",
    Effect.gen(function* () {
      mkdirSync(managedDirectory, { recursive: true })
      writeFileSync(path.join(managedDirectory, "vector.json"), JSON.stringify({ model: "managed/model" }))
      const config = yield* Config.use.get()
      expect(config.model).toBe("managed/model")
    }),
    { trusted: true, config: { model: "repository/model" } },
  )

  // Windows has no mode bits to loosen; its access rules are checked above.
  const posixInstance = process.platform === "win32" ? it.instance.skip : it.instance
  posixInstance(
    "a managed file a standard user could change is ignored by the config loader and by Vector Local",
    Effect.gen(function* () {
      mkdirSync(managedDirectory, { recursive: true })
      const file = path.join(managedDirectory, "vector.json")
      writeFileSync(file, JSON.stringify({ model: "managed/model", local: { enabled: true, web: "none" } }))
      chmodSync(file, 0o666)
      const config = yield* Config.use.get()
      expect(config.model).toBe("repository/model")
      const policy = Config.refreshLocal()
      expect(policy.enabled).toBe(false)
      expect(policy.warnings).toEqual([
        `${ConfigManaged.UNTRUSTED} ${realpathSync(file)} can be changed by other users.`,
      ])
      chmodSync(file, 0o644)
      expect(Config.refreshLocal()).toMatchObject({ enabled: true, web: "none", warnings: [] })
    }),
    { trusted: true, config: { model: "repository/model" } },
  )
})

describe("the test managed folder", () => {
  test("a process that did not choose it reads the system's folders and ignores a user's file there", async () => {
    await using dir = await tmpdir()
    const folder = path.join(dir.path, "managed")
    mkdirSync(folder)
    writeFileSync(
      path.join(folder, "vector.json"),
      JSON.stringify({
        local: {
          endpoints: ["https://api.openai.com"],
          allow: [{ source: "catalog", reason: "x", added_at: 1, added_by: "app" }],
        },
      }),
    )
    const url = (file: string) => JSON.stringify(new URL(file, import.meta.url).href)
    // Only test/preload.ts chooses a test folder; the variable that tells test files where it is changes nothing.
    const child = Bun.spawn(
      [
        process.execPath,
        "--eval",
        `
        const { ConfigManaged } = await import(${url("../../../core/src/config/managed.ts")})
        const { Config } = await import(${url("../../src/config/config.ts")})
        process.stdout.write(JSON.stringify({ directories: ConfigManaged.directories(), files: ConfigManaged.read().files, policy: Config.local() }) + "\\n")
        process.exit(0)
        `,
      ],
      {
        cwd: engineDirectory,
        env: { ...process.env, VECTOR_TEST_MANAGED_CONFIG_DIR: folder },
        stdout: "pipe",
        stderr: "pipe",
      },
    )
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    expect(stderr.includes("error:") ? stderr : "").toBe("")
    expect(code).toBe(0)
    const result = JSON.parse(stdout.trim().split("\n").at(-1) ?? "")
    expect(result.directories).toEqual(ConfigManaged.systemDirectories())
    expect(result.files).not.toContain(path.join(folder, "vector.json"))
    expect(result.policy.endpoints.map((item: { origin: string }) => item.origin)).not.toContain(
      "https://api.openai.com",
    )
    expect(result.policy.allow.map((item: { source: string }) => item.source)).not.toContain("catalog")
  }, 30_000)

  test("tests read company policy from the folder preload chose", () => {
    expect(ConfigManaged.directories()).toEqual([managedDirectory])
  })
})

describe("macOS access control lists", () => {
  const listing = [
    "drwxr-xr-x  23 root  wheel  736 Sep 24 00:10 /",
    "drwxr-xr-x+  3 root  wheel   96 Oct 22 11:39 /Library/Application Support/vector",
    " 0: group:everyone deny delete",
    " 1: group:wheel allow add_file,delete_child",
    "-rw-r--r--+  1 root  wheel    3 Oct 22 11:39 /Library/Application Support/vector/vector.json",
    " 0: user:root allow write",
    " 1: group:staff inherited allow read,readattr",
  ]
  const paths = ["/Library/Application Support/vector/vector.json", "/Library/Application Support/vector", "/"]

  test("entries for root and wheel, deny entries and read rights do not count", () => {
    expect(ConfigManaged.macAclReason(listing.join("\n"), paths)).toBe(undefined)
  })

  test("an entry that lets another user or group write or replace a file is caught", () => {
    expect(ConfigManaged.macAclReason([...listing, " 2: user:nobody allow write,append"].join("\n"), paths)).toBe(
      "/Library/Application Support/vector/vector.json lets user:nobody change it.",
    )
    const folder = [...listing.slice(0, 3), " 1: group:staff inherited allow add_file", ...listing.slice(4)]
    expect(ConfigManaged.macAclReason(folder.join("\n"), paths)).toBe(
      "/Library/Application Support/vector lets group:staff change it.",
    )
  })

  test.skipIf(process.platform !== "darwin")(
    "a real file's list is checked, though stat does not show it",
    async () => {
      const { dir, folder, file } = await managedFile()
      await using _ = dir
      expect(ConfigManaged.untrusted(file, { user: true })).toBe(undefined)
      expect(Bun.spawnSync(["/bin/chmod", "+a", "user:nobody allow write", file]).exitCode).toBe(0)
      expect(ConfigManaged.untrusted(file, { user: true })).toBe(`${realpathSync(file)} lets user:nobody change it.`)
      expect(Bun.spawnSync(["/bin/chmod", "-N", file]).exitCode).toBe(0)
      expect(Bun.spawnSync(["/bin/chmod", "+a", "group:everyone deny delete", folder]).exitCode).toBe(0)
      expect(ConfigManaged.untrusted(file, { user: true })).toBe(undefined)
    },
  )
})
