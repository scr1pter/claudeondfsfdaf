import { test, expect } from "bun:test"
import { spawnSync } from "node:child_process"
import fs from "node:fs"
import net from "node:net"
import os from "node:os"
import path from "node:path"

import { legacyName } from "@vectordevai/core/flag/legacy"
import {
  credentialStorePaths,
  offline,
  sandboxAvailability,
  sandboxEnabled,
  seatbeltProfile,
  wrapCommand,
} from "./sandbox"

const darwin = process.platform === "darwin"
const home = fs.realpathSync(os.homedir())

function workspace(prefix = "sbx-") {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)))
}

function sandboxed(input: {
  command: string
  workspaceRoot: string
  cwd?: string
  allowNetwork?: boolean
  home?: string
}) {
  const wrapped = wrapCommand({
    shell: "/bin/zsh",
    command: input.command,
    cwd: input.cwd ?? input.workspaceRoot,
    env: process.env,
    workspaceRoot: input.workspaceRoot,
    allowNetwork: input.allowNetwork,
    home: input.home,
  })
  expect(wrapped.sandboxed).toBe(true)
  const result = spawnSync(wrapped.command, wrapped.args, {
    cwd: input.cwd ?? input.workspaceRoot,
    env: process.env,
    encoding: "utf8",
  })
  return { status: result.status, output: (result.stdout + result.stderr).trim() }
}

function git(directory: string, args: string[]) {
  const result = spawnSync("git", ["-C", directory, ...args], { encoding: "utf8" })
  expect(result.status, result.stderr).toBe(0)
  return result.stdout.trim()
}

test("sandboxing is an opt-in preview with explicit enable values", () => {
  expect(sandboxEnabled(undefined)).toBe(false)
  expect(sandboxEnabled("")).toBe(false)
  expect(sandboxEnabled("preview")).toBe(false)
  expect(sandboxEnabled("1")).toBe(true)
  expect(sandboxEnabled("true")).toBe(true)
  expect(sandboxEnabled(" yes ")).toBe(true)
  expect(sandboxEnabled("ON")).toBe(true)
  expect(sandboxEnabled("0")).toBe(false)
  expect(sandboxEnabled("false")).toBe(false)
  expect(sandboxEnabled("off")).toBe(false)
})

test("profile grants writes to the workspace and keeps the default deny", () => {
  const profile = seatbeltProfile({ writable: ["/work/space"], denyRead: [], allowNetwork: true })
  expect(profile).toContain("(version 1)")
  expect(profile).toContain("(deny default)")
  expect(profile).toContain('(subpath "/work/space")')
  expect(profile).toContain("(allow file-read*)")
})

test("profile denies reads of secret paths after the broad read allowance", () => {
  const fixtureHome = "/Users/vector-fixture"
  const profile = seatbeltProfile({
    writable: ["/work"],
    denyRead: [`${fixtureHome}/.ssh`, `${fixtureHome}/.aws`, `${fixtureHome}/.config/gh`, "/Library/Keychains"],
    allowNetwork: true,
  })
  expect(profile).toContain(`(subpath "${fixtureHome}/.ssh")`)
  expect(profile).toContain(`(subpath "${fixtureHome}/.aws")`)
  expect(profile).toContain('(subpath "/Library/Keychains")')
  // SBPL is last-match-wins, so a denial emitted before (allow file-read*) would
  // be silently overridden and the whole protection would be decorative.
  expect(profile.indexOf("(deny file-read*")).toBeGreaterThan(profile.indexOf("(allow file-read*)"))
})

test("profile can keep a linked-worktree marker readable but not writable", () => {
  const marker = "/work/linked/.git"
  const profile = seatbeltProfile({
    writable: ["/work/linked", "/repo/.git/worktrees/linked"],
    denyRead: [],
    denyWrite: [marker],
    allowNetwork: true,
  })
  expect(profile.slice(profile.indexOf("(deny file-write*"), profile.indexOf("(deny file-read*"))).toContain(
    `(subpath "${marker}")`,
  )
  expect(profile).not.toContain("(deny file-read*")
})

test("paths with quotes and backslashes cannot break out of the profile literal", () => {
  const profile = seatbeltProfile({ writable: ['/work/we"ird\\dir'], denyRead: [], allowNetwork: true })
  expect(profile).toContain('(subpath "/work/we\\"ird\\\\dir")')
  // The escaped literal must contain exactly one opening and one closing quote.
  const rule = profile.split("\n").find((line) => line.includes("we"))
  expect(rule?.match(/(?<!\\)"/g)).toHaveLength(2)
})

test("network switch renders an allow or a unix-only deny", () => {
  expect(seatbeltProfile({ writable: ["/w"], denyRead: [], allowNetwork: true })).toContain("(allow network*)")
  const denied = seatbeltProfile({ writable: ["/w"], denyRead: [], allowNetwork: false })
  expect(denied).toContain("(deny network*)")
  expect(denied).toContain("(allow network* (local unix) (remote unix))")
  expect(denied).not.toContain("\n(allow network*)")
})

test("availability is honest about platforms that cannot be sandboxed", () => {
  const windows = sandboxAvailability("win32")
  expect(windows.supported).toBe(false)
  expect(windows.mechanism).toBe("none")
  expect(windows.reason).toContain("Windows")

  const other = sandboxAvailability("freebsd")
  expect(other.supported).toBe(false)
  expect(other.reason).toContain("freebsd")
})

test("windows keeps the PowerShell invocation and reports that it is unsandboxed", () => {
  const wrapped = wrapCommand({
    shell: "pwsh",
    command: "Get-ChildItem",
    cwd: "C:\\work",
    env: {},
    workspaceRoot: "C:\\work",
    platform: "win32",
  })
  expect(wrapped.command).toBe("pwsh")
  expect(wrapped.args).toEqual(["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "Get-ChildItem"])
  expect(wrapped.shell).toBe(false)
  expect(wrapped.sandboxed).toBe(false)
  expect(wrapped.reason).toContain("Windows")
})

test("windows non-powershell shells still run through the shell option", () => {
  const wrapped = wrapCommand({
    shell: "bash",
    command: "ls -la",
    cwd: "C:\\work",
    env: {},
    workspaceRoot: "C:\\work",
    platform: "win32",
  })
  expect(wrapped.command).toBe("ls -la")
  expect(wrapped.args).toEqual([])
  expect(wrapped.shell).toBe("bash")
  expect(wrapped.sandboxed).toBe(false)
})

test("an unsupported platform degrades to an unwrapped command with a reason", () => {
  const wrapped = wrapCommand({
    shell: "/bin/sh",
    command: "echo hi",
    cwd: "/work",
    env: { FOO: "bar" },
    workspaceRoot: "/work",
    platform: "freebsd",
  })
  expect(wrapped.sandboxed).toBe(false)
  expect(wrapped.mechanism).toBe("none")
  expect(wrapped.reason).toContain("freebsd")
  // Degrading must leave the command exactly as the shell tool would have run it.
  expect(wrapped.command).toBe("echo hi")
  expect(wrapped.shell).toBe("/bin/sh")
  expect(wrapped.env).toEqual({ FOO: "bar" })
})

test.skipIf(!darwin)("macos produces a runnable sandbox-exec invocation", () => {
  const root = workspace()
  const wrapped = wrapCommand({
    shell: "/bin/zsh",
    command: "echo hi",
    cwd: root,
    env: process.env,
    workspaceRoot: root,
  })
  expect(wrapped.sandboxed).toBe(true)
  expect(wrapped.mechanism).toBe("seatbelt")
  expect(wrapped.command).toBe("/usr/bin/sandbox-exec")
  expect(wrapped.args[0]).toBe("-p")
  expect(wrapped.args[1]).toContain(`(subpath "${root}")`)
  expect(wrapped.args.slice(2)).toEqual(["/bin/zsh", "-c", "echo hi"])
  expect(wrapped.shell).toBe(false)
})

test.skipIf(!darwin)("package-manager credential files are masked inside writable caches", () => {
  const root = workspace()
  const fakeHome = workspace("sandbox-home-")
  const credentials = [
    ".npmrc",
    ".pypirc",
    ".cargo/credentials",
    ".cargo/credentials.toml",
    ".cargo/credentials-backup",
    ".gradle/gradle.properties",
    ".m2/settings.xml",
  ]
  credentials.forEach((entry) => {
    const file = path.join(fakeHome, entry)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, "secret")
  })

  const wrapped = wrapCommand({
    shell: "/bin/zsh",
    command: "true",
    cwd: root,
    env: process.env,
    workspaceRoot: root,
    home: fakeHome,
  })
  expect(wrapped.sandboxed).toBe(true)
  credentials.forEach((entry) => expect(wrapped.args[1]).toContain(`(subpath "${path.join(fakeHome, entry)}")`))

  const denied = sandboxed({
    command: `cat ${credentials.map((entry) => JSON.stringify(path.join(fakeHome, entry))).join(" ")}`,
    workspaceRoot: root,
    home: fakeHome,
  })
  expect(denied.status).not.toBe(0)
  expect(denied.output).not.toContain("secret")
})

test.skipIf(!darwin)("the Vercel and Supabase command-line logins stay out of a sandboxed command", () => {
  const root = workspace()
  const fakeHome = workspace("sandbox-home-")
  const logins = [
    "Library/Application Support/com.vercel.cli/auth.json",
    ".local/share/com.vercel.cli/auth.json",
    ".vercel/auth.json",
    ".supabase/access-token",
  ]
  logins.forEach((entry) => {
    const file = path.join(fakeHome, entry)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, "fixture-cli-login")
  })
  const denied = sandboxed({
    command: `cat ${logins.map((entry) => JSON.stringify(path.join(fakeHome, entry))).join(" ")}`,
    workspaceRoot: root,
    home: fakeHome,
  })
  expect(denied.status).not.toBe(0)
  expect(denied.output).not.toContain("fixture-cli-login")
})

test("credential stores cover the data directory, the CLI default, the earlier product and the desktop vault", () => {
  const fakeHome = workspace("sandbox-home-")
  // The desktop layout: the engine's data directory lives under the app's user data.
  const data = path.join(fakeHome, "Library", "Application Support", "ai.vector.app", "xdg-data", "vector")
  const cliData = path.join(fakeHome, ".local", "share")
  const configHome = path.join(fakeHome, "custom-config")
  // A channel database exists only on disk, so the sandbox has to find it by listing.
  fs.mkdirSync(data, { recursive: true })
  ;["vector-nightly.db", "vector-nightly.db-wal", "vector-nightly.db-shm", "notes.db"].forEach((file) =>
    fs.writeFileSync(path.join(data, file), ""),
  )
  const paths = credentialStorePaths(fakeHome, data, configHome)
  const directories = [
    data,
    path.join(cliData, "vector"),
    path.join(cliData, legacyName!),
    path.join(path.dirname(data), legacyName!),
  ]

  directories.forEach((directory) =>
    [
      "auth.json",
      "mcp-auth.json",
      "cli-auth.json",
      "plugin-oauth-approvals.json",
      // `vector vault` keeps its local vault file at <data>/vault/vault.json (cli/cmd/vault.ts).
      path.join("vault", "vault.json"),
    ].forEach((file) => expect(paths).toContain(path.join(directory, file))),
  )
  // The database keeps integration keys in plain JSON, on every channel and in WAL mode.
  directories.forEach((directory) =>
    ["", "-wal", "-shm"].forEach((suffix) =>
      expect(paths).toContain(path.join(directory, `${path.basename(directory)}.db${suffix}`)),
    ),
  )
  ;["vector-nightly.db", "vector-nightly.db-wal", "vector-nightly.db-shm"].forEach((file) =>
    expect(paths).toContain(path.join(data, file)),
  )
  expect(paths).not.toContain(path.join(data, "notes.db"))
  // macOS keeps Electron user data under Application Support, Linux under $XDG_CONFIG_HOME
  // or ~/.config. Each desktop engine keeps its own stores in the app's xdg-data folder.
  ;[path.join(fakeHome, "Library", "Application Support"), path.join(fakeHome, ".config"), configHome].forEach((root) =>
    ["ai.vector.app", "ai.vector.app.beta", "ai.vector.app.dev"].forEach((id) => {
      expect(paths).toContain(path.join(root, id, "secure-runtime"))
      expect(paths).toContain(path.join(root, id, "xdg-data", "vector", "auth.json"))
      expect(paths).toContain(path.join(root, id, "xdg-data", "vector", "mcp-auth.json"))
      expect(paths).toContain(path.join(root, id, "xdg-data", "vector", "vector.db"))
    }),
  )
  // The rest of the data directory (worktrees, logs, tool output) stays reachable.
  expect(paths).not.toContain(data)
})

test.skipIf(!sandboxAvailability().supported)(
  "an agent cannot read Vector's credential stores or the vault key",
  () => {
    const root = workspace()
    const fakeHome = workspace("sandbox-home-")
    const data = path.join(fakeHome, ".local", "share", "vector")
    const secrets = [
      path.join(data, "auth.json"),
      path.join(data, "mcp-auth.json"),
      path.join(data, "cli-auth.json"),
      path.join(fakeHome, ".local", "share", legacyName!, "auth.json"),
      path.join(fakeHome, ".local", "share", legacyName!, "mcp-auth.json"),
      path.join(data, "vector.db"),
      path.join(
        fakeHome,
        darwin ? "Library/Application Support" : ".config",
        "ai.vector.app",
        "secure-runtime",
        "credential-key.v1",
      ),
      path.join(
        fakeHome,
        darwin ? "Library/Application Support" : ".config",
        "ai.vector.app",
        "xdg-data",
        "vector",
        "auth.json",
      ),
    ]
    const readable = path.join(data, "log", "engine.log")
    ;[...secrets, readable].forEach((file) => {
      fs.mkdirSync(path.dirname(file), { recursive: true })
      fs.writeFileSync(file, file === readable ? "log-line" : "secret")
    })

    const wrapped = wrapCommand({
      shell: "/bin/sh",
      command: [
        ...secrets.map((file) => `cat ${JSON.stringify(file)} 2>/dev/null`),
        `cat ${JSON.stringify(readable)}`,
        ...secrets.map((file) => `printf tamper > ${JSON.stringify(file)} 2>/dev/null`),
        "true",
      ].join("; "),
      cwd: root,
      env: process.env,
      workspaceRoot: root,
      home: fakeHome,
      data,
    })
    expect(wrapped.sandboxed).toBe(true)
    const result = spawnSync(wrapped.command, wrapped.args, { cwd: root, env: process.env, encoding: "utf8" })
    const output = (result.stdout + result.stderr).trim()

    expect(output).not.toContain("secret")
    expect(output).toContain("log-line")
    secrets.forEach((file) => expect(fs.readFileSync(file, "utf8")).toBe("secret"))
  },
)

test.skipIf(!darwin)("linked worktrees keep shared objects, refs, and reflogs read-only", () => {
  // Keep both checkouts outside macOS's broad temporary-directory allowance so
  // this proves the metadata grant does not accidentally open the parent tree.
  // The per-user cache allowances (~/.cache and friends) hang off a stand-in
  // home, so a repository checked out under a real cache root still proves it.
  const fakeHome = workspace("home-")
  const main = fs.realpathSync(fs.mkdtempSync(path.join(process.cwd(), ".sandbox-main-")))
  const linkedParent = fs.realpathSync(fs.mkdtempSync(path.join(process.cwd(), ".sandbox-linked-")))
  const linked = path.join(linkedParent, "checkout")
  const escape = path.join(main, "sandbox-escape.txt")

  try {
    git(main, ["init", "-b", "main"])
    git(main, ["config", "user.name", "Vector Sandbox Test"])
    git(main, ["config", "user.email", "sandbox@vector.test"])
    fs.writeFileSync(path.join(main, "tracked.txt"), "initial\n")
    git(main, ["add", "tracked.txt"])
    git(main, ["commit", "-m", "initial"])
    git(main, ["worktree", "add", "-b", "linked-test", linked])

    const marker = path.join(linked, ".git")
    const gitdir = fs.realpathSync(
      path.resolve(linked, fs.readFileSync(marker, "utf8").match(/^gitdir:\s*(.+?)\s*$/m)?.[1] ?? ""),
    )
    const common = fs.realpathSync(path.resolve(gitdir, fs.readFileSync(path.join(gitdir, "commondir"), "utf8").trim()))
    const protectedPaths = [path.join(common, "objects"), path.join(common, "refs"), path.join(common, "logs", "refs")]
    const probes = protectedPaths.map((directory) => path.join(directory, "vector-sandbox-probe"))

    const wrapped = wrapCommand({
      shell: "/bin/zsh",
      command: "true",
      cwd: linked,
      env: process.env,
      workspaceRoot: linked,
      home: fakeHome,
    })
    expect(wrapped.sandboxed).toBe(true)
    const profile = wrapped.args[1]
    const writableRules = profile.slice(
      profile.indexOf("(allow file-write*"),
      profile.indexOf('(allow file-write* (literal "/dev/null")'),
    )
    expect(writableRules).toContain(`(subpath "${gitdir}")`)
    protectedPaths.forEach((directory) => expect(writableRules).not.toContain(`(subpath "${directory}")`))

    const denyWriteRules = profile.slice(profile.indexOf("(deny file-write*"), profile.indexOf("(deny file-read*"))
    expect(denyWriteRules).toContain(`(subpath "${marker}")`)
    protectedPaths.forEach((directory) => expect(denyWriteRules).toContain(`(subpath "${directory}")`))

    const result = sandboxed({
      workspaceRoot: linked,
      home: fakeHome,
      command: [
        "printf 'linked\\n' >> tracked.txt",
        `printf local > ${JSON.stringify(path.join(gitdir, "vector-sandbox-probe"))}`,
        ...probes.map(
          (probe, index) => `if printf tamper > ${JSON.stringify(probe)} 2>/dev/null; then exit ${91 + index}; fi`,
        ),
        `if printf escape > ${JSON.stringify(escape)} 2>/dev/null; then exit 91; fi`,
        "if printf tamper > .git 2>/dev/null; then exit 92; fi",
      ].join(" && "),
    })

    expect(result.status, result.output).toBe(0)
    expect(fs.readFileSync(path.join(linked, "tracked.txt"), "utf8")).toBe("initial\nlinked\n")
    expect(fs.readFileSync(path.join(gitdir, "vector-sandbox-probe"), "utf8")).toBe("local")
    probes.forEach((probe) => expect(fs.existsSync(probe)).toBe(false))
    expect(fs.existsSync(escape)).toBe(false)
    expect(fs.readFileSync(marker, "utf8")).toStartWith("gitdir:")
  } finally {
    fs.rmSync(linkedParent, { recursive: true, force: true })
    fs.rmSync(main, { recursive: true, force: true })
    fs.rmSync(fakeHome, { recursive: true, force: true })
  }
})

test.skipIf(!darwin)("writes inside the workspace succeed and writes to home are refused", () => {
  const root = workspace()
  expect(sandboxed({ command: "echo hi > inside.txt && cat inside.txt", workspaceRoot: root }).output).toBe("hi")

  const escape = path.join(home, "vector-sandbox-escape-probe.txt")
  const denied = sandboxed({ command: `echo pwned > ${escape} && echo WROTE`, workspaceRoot: root })
  expect(denied.output).not.toContain("WROTE")
  expect(denied.status).not.toBe(0)
  expect(fs.existsSync(escape)).toBe(false)
})

test.skipIf(!darwin)("a denied read is enforced by the kernel, not just written into the profile", () => {
  const root = workspace()
  const secret = workspace("secret-")
  fs.writeFileSync(path.join(secret, "key"), "top-secret")

  const profile = seatbeltProfile({ writable: [root], denyRead: [secret], allowNetwork: false })
  const result = spawnSync(
    "/usr/bin/sandbox-exec",
    ["-p", profile, "/bin/zsh", "-c", `cat ${path.join(secret, "key")}`],
    { cwd: root, env: process.env, encoding: "utf8" },
  )
  expect(result.stdout).not.toContain("top-secret")
  expect(result.status).not.toBe(0)
})

test.skipIf(!darwin)("a secret inside a writable cache root cannot be written either", () => {
  // ~/.gem is a writable cache but ~/.gem/credentials is a denied secret, so the
  // write allowance on the parent must not hand back the credential file.
  const root = workspace()
  const cache = workspace("cache-")
  const secret = path.join(cache, "credentials")
  fs.mkdirSync(secret)

  const profile = seatbeltProfile({ writable: [root, cache], denyRead: [secret], allowNetwork: false })
  const attempt = (target: string) =>
    spawnSync("/usr/bin/sandbox-exec", ["-p", profile, "/bin/zsh", "-c", `echo x > ${target} && echo WROTE`], {
      cwd: root,
      env: process.env,
      encoding: "utf8",
    })

  expect(attempt(path.join(cache, "ok.txt")).stdout.trim()).toBe("WROTE")
  expect(attempt(path.join(secret, "key")).stdout).not.toContain("WROTE")
  expect(fs.existsSync(path.join(secret, "key"))).toBe(false)
})

test.skipIf(!darwin)("a workspace path containing a quote stays contained", () => {
  const root = path.join(workspace(), 'we"ird\\dir')
  fs.mkdirSync(root)

  expect(sandboxed({ command: "echo hi > ok.txt && cat ok.txt", workspaceRoot: root, cwd: root }).output).toBe("hi")

  const escape = path.join(home, "vector-sandbox-quote-probe.txt")
  const denied = sandboxed({ command: `echo x > ${escape} && echo WROTE`, workspaceRoot: root, cwd: root })
  expect(denied.output).not.toContain("WROTE")
  expect(fs.existsSync(escape)).toBe(false)
})

test.skipIf(!darwin)("the toolchain stays readable and executable inside the sandbox", () => {
  const root = workspace()
  expect(sandboxed({ command: "git --version", workspaceRoot: root }).status).toBe(0)
  // Redirection to /dev/null and process substitution break under a naive
  // (deny default) profile, so they are worth proving rather than assuming.
  expect(sandboxed({ command: "diff <(echo a) <(echo a) > /dev/null && echo SAME", workspaceRoot: root }).output).toBe(
    "SAME",
  )
  expect(sandboxed({ command: 'T=$(mktemp) && echo x > "$T" && echo TMPOK', workspaceRoot: root }).output).toBe("TMPOK")
})

test.skipIf(!darwin)(
  "the network switch is enforced against a real socket, and no network still reaches loopback",
  async () => {
    const root = workspace()
    const server = net.createServer((socket) => socket.end("ok"))
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()))
    const address = server.address()
    const port = typeof address === "object" && address ? address.port : 0

    const probe = `nc -z -w 2 127.0.0.1 ${port} > /dev/null 2>&1 && echo CONNECTED || echo BLOCKED`
    expect(sandboxed({ command: probe, workspaceRoot: root, allowNetwork: true }).output).toBe("CONNECTED")
    // Vector Local's Web access None keeps this computer's own servers reachable (a database, a dev server).
    expect(sandboxed({ command: probe, workspaceRoot: root, allowNetwork: false }).output).toBe("CONNECTED")
    // TEST-NET-1 is never routed, so nothing outside is reached either way: a connection the sandbox let through would
    // wait out nc's 2 seconds, and one it refused fails at once.
    const outside = `SECONDS=0; nc -z -w 2 192.0.2.1 443 > /dev/null 2>&1 && echo CONNECTED || echo "BLOCKED after $SECONDS s"`
    expect(sandboxed({ command: outside, workspaceRoot: root, allowNetwork: false }).output).toBe("BLOCKED after 0 s")

    await new Promise<void>((resolve) => server.close(() => resolve()))
  },
)

test.skipIf(!darwin)("a root worktree does not turn into write access to the whole disk", () => {
  const root = workspace()
  const wrapped = wrapCommand({
    shell: "/bin/zsh",
    command: "echo hi",
    cwd: root,
    env: process.env,
    workspaceRoot: "/",
  })
  expect(wrapped.args[1]).not.toContain('(subpath "/")')
  expect(wrapped.args[1]).toContain(`(subpath "${root}")`)

  const escape = path.join(home, "vector-sandbox-root-probe.txt")
  const denied = sandboxed({ command: `echo x > ${escape} && echo WROTE`, workspaceRoot: "/", cwd: root })
  expect(denied.output).not.toContain("WROTE")
  expect(fs.existsSync(escape)).toBe(false)
})

test.skipIf(!darwin)("a profile with no writable roots is still a valid read-only profile", () => {
  const profile = seatbeltProfile({ writable: [], denyRead: [], allowNetwork: false })
  expect(profile).not.toContain("(allow file-write*\n)")
  const result = spawnSync("/usr/bin/sandbox-exec", ["-p", profile, "/bin/zsh", "-c", "echo alive"], {
    cwd: os.tmpdir(),
    env: process.env,
    encoding: "utf8",
  })
  expect(result.stdout.trim()).toBe("alive")
  expect(result.status).toBe(0)
})

// SF-08: the review fix executor's checks ask for writes to the workspace alone. The shell tool never does, and its
// argv is pinned unchanged below.
const bubblewrap = process.platform === "linux" && sandboxAvailability("linux").supported
const flagValues = (args: readonly string[], flag: string) =>
  args.flatMap((arg, index) => (arg === flag ? [args[index + 1]] : []))

test.skipIf(!bubblewrap)(
  "workspace writes bind only the workspace, hide /tmp, /run and Vector's data, and drop capabilities",
  () => {
    const scratch = workspace("sbx-fix-")
    const data = path.join(scratch, "data")
    const tools = path.join(data, "bin")
    const root = path.join(data, "task-worktree", "fix")
    for (const folder of [tools, root]) fs.mkdirSync(folder, { recursive: true })
    try {
      const wrapped = wrapCommand({
        shell: "/bin/sh",
        command: "true",
        cwd: root,
        env: { PATH: `${tools}:/usr/bin:/bin` },
        workspaceRoot: root,
        allowNetwork: false,
        data,
        writes: "workspace",
      })
      expect(wrapped.sandboxed).toBe(true)
      const args = wrapped.args
      // No --new-session: bwrap's namespace init stays in the caller's process group (fix.ts `execute`).
      expect(args.slice(0, 3)).toEqual(["--die-with-parent", "--cap-drop", "ALL"])
      expect(args).not.toContain("--new-session")
      expect(args).toContain("--unshare-net")
      expect(flagValues(args, "--bind")).toEqual([root])
      const tmpfs = flagValues(args, "--tmpfs")
      expect(tmpfs.slice(0, 2)).toEqual(["/tmp", "/run"])
      expect(tmpfs).toContain(data)
      // The data folder's tmpfs, then its PATH folder put back, then the workspace, then the data folder made read-only.
      const at = args.indexOf(data)
      expect(args.slice(at - 1, at + 1)).toEqual(["--tmpfs", data])
      expect(args.indexOf(tools)).toBeGreaterThan(at)
      expect(args[args.indexOf(tools) - 1]).toBe("--ro-bind")
      expect(args.indexOf("--bind")).toBeGreaterThan(args.indexOf(tools))
      expect(args.indexOf("--bind")).toBeGreaterThan(args.lastIndexOf("/run"))
      expect(args.slice(-7)).toEqual(["--remount-ro", data, "--chdir", root, "/bin/sh", "-c", "true"])
      // A data folder that holds the home folder (where the user's tools live) is not hidden.
      const home = wrapCommand({
        shell: "/bin/sh",
        command: "true",
        cwd: root,
        env: {},
        workspaceRoot: root,
        allowNetwork: false,
        home: path.join(data, "home"),
        data,
        writes: "workspace",
      })
      expect(home.args).not.toContain("--remount-ro")
      expect(flagValues(home.args, "--tmpfs")).not.toContain(data)
    } finally {
      fs.rmSync(scratch, { recursive: true, force: true })
    }
  },
)

// Outside /tmp, which the sandbox already replaces, so only the data folder's own mask can hide it.
const varTmp = bubblewrap && fs.existsSync("/var/tmp") && fs.statSync("/var/tmp").isDirectory()

test.skipIf(!varTmp)("in workspace mode Vector's data folder is empty and read-only, but for the workspace", () => {
  const data = fs.realpathSync(fs.mkdtempSync("/var/tmp/sbx-fix-data-"))
  const root = path.join(data, "task-worktree", "fix")
  const secret = path.join(data, "other", "secret.txt")
  fs.mkdirSync(root, { recursive: true })
  fs.mkdirSync(path.dirname(secret))
  fs.writeFileSync(secret, "planted\n")
  try {
    const wrapped = wrapCommand({
      shell: "/bin/sh",
      command: [
        `cat ${secret} 2>/dev/null || echo HIDDEN`,
        `touch ${path.join(data, "written")} 2>/dev/null && echo WROTE || echo DENIED`,
        "echo inside > inside.txt",
      ].join("; "),
      cwd: root,
      env: { PATH: "/usr/bin:/bin" },
      workspaceRoot: root,
      allowNetwork: false,
      data,
      writes: "workspace",
    })
    const result = spawnSync(wrapped.command, wrapped.args, { cwd: root, env: wrapped.env, encoding: "utf8" })
    expect(result.status).toBe(0)
    expect(result.stdout.split("\n")).toEqual(["HIDDEN", "DENIED", ""])
    expect(fs.readFileSync(path.join(root, "inside.txt"), "utf8")).toBe("inside\n")
    expect(fs.existsSync(path.join(data, "written"))).toBe(false)
  } finally {
    fs.rmSync(data, { recursive: true, force: true })
  }
})

test.skipIf(!bubblewrap)("workspace writes keep a linked worktree's Git metadata out of reach", () => {
  const main = workspace("sbx-fix-main-")
  const linked = path.join(workspace("sbx-fix-linked-"), "linked")
  try {
    git(main, ["init", "-q", "-b", "main"])
    git(main, ["-c", "user.name=V", "-c", "user.email=v@v", "commit", "-q", "--allow-empty", "-m", "initial"])
    git(main, ["worktree", "add", "-q", "--detach", linked])
    const wrapped = wrapCommand({
      shell: "/bin/sh",
      command: "true",
      cwd: linked,
      env: { PATH: "/usr/bin:/bin" },
      workspaceRoot: linked,
      allowNetwork: false,
      writes: "workspace",
    })
    const real = fs.realpathSync(linked)
    expect(flagValues(wrapped.args, "--bind")).toEqual([real])
    expect(flagValues(wrapped.args, "--ro-bind")).toContain(path.join(real, ".git"))
    // The default policy grants the linked worktree's own Git folder.
    const shell = wrapCommand({ shell: "/bin/sh", command: "true", cwd: linked, env: {}, workspaceRoot: linked })
    expect(flagValues(shell.args, "--bind").some((file) => file.includes(`${path.sep}worktrees${path.sep}`))).toBe(true)
  } finally {
    fs.rmSync(main, { recursive: true, force: true })
    fs.rmSync(path.dirname(linked), { recursive: true, force: true })
  }
})

test.skipIf(!bubblewrap)("a working folder outside the workspace is refused, not run with wider writes", () => {
  const root = workspace("sbx-fix-")
  try {
    const input = { shell: "/bin/sh", command: "true", cwd: os.tmpdir(), env: {}, workspaceRoot: root } as const
    const wrapped = wrapCommand({ ...input, writes: "workspace" })
    expect(wrapped.sandboxed).toBe(false)
    expect(wrapped.reason).toContain("outside")
    // The refusal carries the sandbox's own reason beside the shell tool's message.
    expect(offline({ ...input, writes: "workspace" })).toMatchObject({
      type: "refused",
      reason: "the working folder is outside the folder the command may write",
    })
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test.skipIf(!bubblewrap)("without workspace writes the shell tool's argv is the one before SF-08, in full", () => {
  const scratch = workspace("sbx-fix-")
  const root = path.join(scratch, "workspace")
  const home = path.join(scratch, "home")
  const data = path.join(scratch, "data", "vector")
  for (const folder of [root, home, data]) fs.mkdirSync(folder, { recursive: true })
  const tmp = fs.realpathSync(os.tmpdir())
  try {
    const input = { shell: "/bin/sh", command: "true", cwd: root, env: {}, workspaceRoot: root, home, data }
    // Printed by wrapCommand at 1f5d62ad (before SF-08) for these inputs, with an empty home and data folder; only
    // the paths are variables, and the resolver mask depends on the host as it always has.
    const before = (network: string[], resolver: string[]) => [
      "--die-with-parent",
      "--unshare-ipc",
      "--unshare-uts",
      "--unshare-pid",
      ...network,
      "--ro-bind",
      "/",
      "/",
      "--dev",
      "/dev",
      "--proc",
      "/proc",
      "--tmpfs",
      "/tmp",
      ...resolver,
      "--bind",
      root,
      root,
      "--bind",
      root,
      root,
      "--bind",
      tmp,
      tmp,
      "--chdir",
      root,
      "/bin/sh",
      "-c",
      "true",
    ]
    expect(wrapCommand({ ...input, allowNetwork: true })).toEqual({
      command: Bun.which("bwrap") ?? "bwrap",
      args: before([], []),
      shell: false,
      env: {},
      sandboxed: true,
      mechanism: "bubblewrap",
    })
    const resolver = fs.existsSync("/run/systemd/resolve") ? ["--tmpfs", "/run/systemd/resolve"] : []
    expect(wrapCommand({ ...input, allowNetwork: false }).args).toEqual(before(["--unshare-net"], resolver))
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true })
  }
})
