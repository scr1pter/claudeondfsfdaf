import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { GithubAgents } from "@vectordevai/core/github-agents"
import { GithubSecrets } from "../../src/cli/cmd/github.secrets"
import { GithubSessionProof } from "../../src/cli/cmd/github.session-proof"
import { ProcessIsolation } from "@vectordevai/core/process-isolation"
import {
  copyBundleFile,
  engineLaunch,
  namespaceProbeFailure,
  prepare,
  preparedFor,
  run,
  finish,
  sandboxEnvironment,
  secretChannel,
  validateCheckoutTree,
} from "../../src/cli/cmd/github.sandbox"

async function fixture() {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "vector-sandbox-")))
  const source = path.join(directory, "source")
  await fs.mkdir(source)
  return {
    directory,
    source,
    destination: path.join(directory, "destination"),
    env: {
      GITHUB_ACTIONS: "true",
      RUNNER_ENVIRONMENT: "github-hosted",
      VECTOR_MODE: "codium",
      RUNNER_TEMP: directory,
      GITHUB_TOKEN: "fixture-github-private",
      VECTOR_CLI_TOKEN: "vct_fixture.signature",
      VECTOR_SECRET_ENV_NAMES: "CUSTOM_CREDENTIAL,AWS_ACCESS_KEY_ID",
      CUSTOM_CREDENTIAL: "fixture-custom-private",
      AWS_ACCESS_KEY_ID: "fixture-access-private",
    },
    async [Symbol.asyncDispose]() {
      await fs.rm(directory, { recursive: true, force: true })
    },
  }
}

test("the sandbox environment excludes every credential and runner file command but preserves explicit own-key consent", async () => {
  await using f = await fixture()
  const env = {
    ...f.env,
    VECTOR_MODE: "own-key",
    PATH: [path.join(f.directory, "go", "bin"), path.join(f.directory, "rust", "bin"), ".", "relative/bin", ""].join(
      path.delimiter,
    ),
    MODEL: "anthropic/example",
    SHARE: "true",
    VECTOR_SHARE_CONSENT: "explicit-fixture-consent",
    ACTIONS_ID_TOKEN_REQUEST_TOKEN: "fixture-oidc-private",
    ACTIONS_RUNTIME_TOKEN: "fixture-runtime-private",
    GITHUB_ENV: "/runner/env",
    GITHUB_OUTPUT: "/runner/output",
    GITHUB_PATH: "/runner/path",
    GITHUB_STATE: "/runner/state",
    GITHUB_STEP_SUMMARY: "/runner/summary",
    GH_TOKEN: "fixture-gh-private",
    VECTOR_RUN_TOKEN: "fixture-run-private",
    NODE_OPTIONS: "--require=untrusted",
    UNLISTED_VALUE: "not-in-the-contract",
  }
  const clean = sandboxEnvironment(env, {
    node: path.join(f.directory, "node", "bin", "node"),
    home: f.directory,
    temporary: f.directory,
    event: path.join(f.directory, "event"),
  })
  const allowed: readonly string[] = GithubAgents.SANDBOX_ENV_ALLOW
  expect(Object.keys(clean).every((name) => allowed.includes(name))).toBe(true)
  expect(clean.SHARE).toBe("true")
  expect(clean.VECTOR_SHARE_CONSENT).toBe("explicit-fixture-consent")
  expect(clean.MODEL).toBe(env.MODEL)
  expect(clean.VECTOR_SECRET_CHANNEL).toBe("stdin")
  expect(clean.HOME).toBe(f.directory)
  const paths = clean.PATH!.split(path.delimiter)
  expect(paths[0]).toBe(path.join(f.directory, "node", "bin"))
  expect(paths).toContain(path.join(f.directory, "go", "bin"))
  expect(paths).toContain(path.join(f.directory, "rust", "bin"))
  expect(paths).not.toContain(".")
  expect(paths).not.toContain("relative/bin")
  expect(paths).not.toContain("")
  for (const [name, value] of Object.entries(env)) {
    if (
      name.startsWith("ACTIONS_") ||
      name.includes("TOKEN") ||
      [
        "GITHUB_ENV",
        "GITHUB_OUTPUT",
        "GITHUB_PATH",
        "GITHUB_STATE",
        "GITHUB_STEP_SUMMARY",
        "CUSTOM_CREDENTIAL",
        "AWS_ACCESS_KEY_ID",
        "NODE_OPTIONS",
        "UNLISTED_VALUE",
      ].includes(name)
    ) {
      expect(clean[name]).toBeUndefined()
      expect(Object.values(clean)).not.toContain(value)
    }
  }
})

test("tool PID isolation is derived from the trusted launcher, never an inherited environment override", async () => {
  await using f = await fixture()
  const locations = {
    node: path.join(f.directory, "node"),
    home: f.directory,
    temporary: f.directory,
    event: path.join(f.directory, "event"),
  }
  const inherited = { ...f.env, [GithubAgents.TOOL_PID_NAMESPACE_ENV]: "pid", [GithubAgents.SESSION_PROOF_ENV]: "fd3" }
  expect(sandboxEnvironment(inherited, locations)[GithubAgents.TOOL_PID_NAMESPACE_ENV]).toBeUndefined()
  expect(sandboxEnvironment(inherited, locations)[GithubAgents.SESSION_PROOF_ENV]).toBeUndefined()
  expect(
    sandboxEnvironment(
      { ...inherited, [GithubAgents.TOOL_PID_NAMESPACE_ENV]: "off" },
      { ...locations, toolIsolation: "pid" },
    )[GithubAgents.TOOL_PID_NAMESPACE_ENV],
  ).toBe("pid")
})

test("session copying refuses an unproven or changed artifact even if it is a bounded regular file", async () => {
  await using f = await fixture()
  const bytes = Buffer.from("fixture ciphertext bytes")
  await fs.writeFile(path.join(f.source, GithubAgents.SESSION_FILE), bytes)
  await expect(copyBundleFile(f.source, f.destination, GithubAgents.SESSION_FILE)).rejects.toThrow()
  await expect(fs.stat(path.join(f.destination, GithubAgents.SESSION_FILE))).rejects.toThrow()
  const proof = GithubSessionProof.digest(bytes)
  await fs.writeFile(path.join(f.source, GithubAgents.SESSION_FILE), "model-planted plaintext")
  await expect(copyBundleFile(f.source, f.destination, GithubAgents.SESSION_FILE, proof)).rejects.toThrow()
  await expect(fs.stat(path.join(f.destination, GithubAgents.SESSION_FILE))).rejects.toThrow()
  await fs.writeFile(path.join(f.source, GithubAgents.SESSION_FILE), bytes)
  if (process.platform === "win32") return
  await copyBundleFile(f.source, f.destination, GithubAgents.SESSION_FILE, proof)
  expect(await fs.readFile(path.join(f.destination, GithubAgents.SESSION_FILE))).toEqual(bytes)
})

test("private session provenance has one fixed bounded record and no path-selected authority", () => {
  const proof = GithubSessionProof.digest(Buffer.from("fixture ciphertext"))
  expect(GithubSessionProof.parse(Buffer.from(JSON.stringify(proof) + "\n"))).toEqual(proof)
  for (const value of [
    JSON.stringify(proof),
    JSON.stringify(proof) + "\n\n",
    JSON.stringify({ ...proof, path: "/tmp/model" }) + "\n",
    "x".repeat(257),
  ])
    expect(() => GithubSessionProof.parse(Buffer.from(value))).toThrow()
  expect(GithubSessionProof.attestSessionArtifact(Buffer.from("untrusted process"))).toBe(false)
})

test("private credential holders keep the captured process boundary after environment changes", async () => {
  const env: Record<string, string | undefined> = {
    GITHUB_ACTIONS: "true",
    VECTOR_MODE: "own-key",
    VECTOR_SECRET_CHANNEL: "stdin",
    [GithubAgents.TOOL_PID_NAMESPACE_ENV]: GithubSecrets.toolBoundary(),
  }
  const holder = GithubSecrets.createGithubSecrets()
  expect(holder.isolatedTools()).toBe(false)
  await holder.load(
    env,
    (async function* () {
      yield JSON.stringify({ v: 1, githubToken: "fixture-github", cliToken: "vct_fixture.signature", keys: {} }) + "\n"
    })(),
  )
  env[GithubAgents.TOOL_PID_NAMESPACE_ENV] = "off"
  env.GITHUB_ACTIONS = "false"
  expect(holder.isolatedTools()).toBe(true)
})

test("the launcher names the tool boundary its build has, and a holder accepts only that one", async () => {
  expect(GithubSecrets.toolBoundary(true)).toBe("pid")
  expect(GithubSecrets.toolBoundary(false)).toBe("guard")
  expect(GithubSecrets.toolBoundary()).toBe(ProcessIsolation.FLOOR ? "pid" : "guard")
  const channel = async function* () {
    yield JSON.stringify({ v: 1, githubToken: "fixture-github", cliToken: "vct_fixture.signature", keys: {} }) + "\n"
  }
  for (const floor of [true, false]) {
    const env = (boundary: string) => ({
      GITHUB_ACTIONS: "true",
      VECTOR_MODE: "own-key",
      VECTOR_SECRET_CHANNEL: "stdin",
      [GithubAgents.TOOL_PID_NAMESPACE_ENV]: boundary,
    })
    const accepted = GithubSecrets.createGithubSecrets(undefined, floor)
    await accepted.load(env(GithubSecrets.toolBoundary(floor)), channel())
    expect(accepted.isolatedTools()).toBe(true)
    const mismatched = GithubSecrets.createGithubSecrets(undefined, floor)
    await expect(mismatched.load(env(GithubSecrets.toolBoundary(!floor)), channel())).rejects.toThrow()
    expect(mismatched.loaded()).toBe(false)
  }
})

test("a Codium session proof needs the launcher's boundary and descriptor, with or without the floor", async () => {
  for (const floor of [true, false]) {
    const load = async (env: Record<string, string>) => {
      let activated = 0
      const holder = GithubSecrets.createGithubSecrets(() => activated++, floor)
      await holder.load(
        { GITHUB_ACTIONS: "true", VECTOR_MODE: "codium", VECTOR_SECRET_CHANNEL: "stdin", ...env },
        (async function* () {
          yield JSON.stringify({ v: 1, githubToken: "fixture-github", runToken: "vrt_fixture.signature", keys: {} }) +
            "\n"
        })(),
      )
      return { holder, activated }
    }
    const boundary = { [GithubAgents.TOOL_PID_NAMESPACE_ENV]: GithubSecrets.toolBoundary(floor) }
    const proven = await load({ ...boundary, [GithubAgents.SESSION_PROOF_ENV]: "fd3" })
    expect(proven.holder.sessionProof()).toBe(true)
    expect(proven.activated).toBe(1)
    const unmarked = await load({ [GithubAgents.SESSION_PROOF_ENV]: "fd3" })
    expect(unmarked.holder.sessionProof()).toBe(false)
    // Codium still applies the hosted tool guards without a marker.
    expect(unmarked.activated).toBe(1)
    expect((await load(boundary)).holder.sessionProof()).toBe(false)
  }
})

test("a run needs prepared private state, and only a floor build needs its verified tool namespace", () => {
  const state = {
    v: 1 as const,
    workspace: "/runner/work/repo",
    container: "/mnt/vector-agent-sandbox",
    created: true,
    mode: "codium" as const,
    sudo: false,
    uid: 1001,
    gid: 1001,
    prepared: true,
  }
  const target = { workspace: state.workspace, mode: "codium" }
  expect(preparedFor(state, target, false)).toBe(true)
  expect(preparedFor(state, target, true)).toBe(false)
  expect(preparedFor({ ...state, isolatedTools: true }, target, true)).toBe(true)
  expect(preparedFor({ ...state, mode: "own-key", sudo: true }, { ...target, mode: "own-key" }, true)).toBe(true)
  for (const floor of [true, false]) {
    const verified = { ...state, isolatedTools: true }
    expect(preparedFor(undefined, target, floor)).toBe(false)
    expect(preparedFor({ ...verified, prepared: false }, target, floor)).toBe(false)
    expect(preparedFor({ ...verified, created: false }, target, floor)).toBe(false)
    expect(preparedFor({ ...verified, uid: undefined }, target, floor)).toBe(false)
    expect(preparedFor({ ...verified, gid: undefined }, target, floor)).toBe(false)
    expect(preparedFor(verified, { ...target, workspace: "/runner/work/other" }, floor)).toBe(false)
    expect(preparedFor(verified, { ...target, mode: "own-key" }, floor)).toBe(false)
  }
})

test("only a floor build wraps the engine in its empty-proc mount namespace", () => {
  const inner = ["/usr/bin/prlimit", "--core=0:0", "--", "/usr/bin/setpriv", "--no-new-privs", "--", "/bin/true"]
  expect(engineLaunch(inner, "/runner/work/repo", false, false)).toEqual(["-n", ...inner])
  expect(engineLaunch(inner, "/runner/work/repo", true, true)).toEqual(["-n", ...inner])
  expect(engineLaunch(inner, "/runner/work/repo", false, true)).toEqual([
    "-n",
    ProcessIsolation.BINARY,
    ...ProcessIsolation.engineArguments(inner[0]!, inner.slice(1), "/runner/work/repo"),
  ])
  const locations = { node: "/opt/node/bin/node", home: "/home/agent", temporary: "/home/agent/tmp", event: "/e.json" }
  const env = { GITHUB_ACTIONS: "true", RUNNER_ENVIRONMENT: "github-hosted", VECTOR_MODE: "codium" }
  for (const boundary of ["pid", "guard"] as const)
    expect(
      sandboxEnvironment(env, { ...locations, toolIsolation: boundary })[GithubAgents.TOOL_PID_NAMESPACE_ENV],
    ).toBe(boundary)
})

test("a refused namespace probe names its kind with bounded, control-free stderr", () => {
  const error = namespaceProbeFailure("tool PID/proc", {
    code: 1,
    stderr: "\x1b[31mbwrap: setting up uid map: Permission denied\x1b[0m\r\n\x07extra\tline\n",
  })
  expect(error.message).toBe(
    "The mandatory tool PID/proc namespace probe failed (exit 1): bwrap: setting up uid map: Permission denied extra line. The run is refused.",
  )
  const long = namespaceProbeFailure("engine mount", { code: 2, stderr: "x".repeat(5000) }).message
  expect(long).toContain("x".repeat(800) + ". The run is refused.")
  expect(long).not.toContain("x".repeat(801))
  expect(namespaceProbeFailure("engine mount", { code: -1, stderr: "" }).message).toContain("no diagnostic")
})

test("Codium never downgrades the tool process boundary to a legacy unset marker", async () => {
  const holder = GithubSecrets.createGithubSecrets()
  await holder.load(
    { GITHUB_ACTIONS: "true", VECTOR_MODE: "codium", VECTOR_SECRET_CHANNEL: "stdin" },
    (async function* () {
      yield JSON.stringify({ v: 1, githubToken: "fixture-github", runToken: "vrt_fixture.signature", keys: {} }) + "\n"
    })(),
  )
  expect(holder.isolatedTools()).toBe(true)
})

test("own-key self-hosted and explicit sudo contexts do not claim a verified PID boundary", async () => {
  const holder = GithubSecrets.createGithubSecrets()
  await holder.load(
    { GITHUB_ACTIONS: "true", VECTOR_MODE: "own-key", VECTOR_SECRET_CHANNEL: "stdin" },
    (async function* () {
      yield JSON.stringify({ v: 1, githubToken: "fixture-github", cliToken: "vct_fixture.signature", keys: {} }) + "\n"
    })(),
  )
  expect(holder.isolatedTools()).toBe(false)
})

test("debugger transports are refused without confusing the Node signal-disable option with inspection", () => {
  for (const argument of ["--inspect", "--inspect=0", "--inspect-brk=127.0.0.1:9229", "--inspect-wait", "--debug"])
    expect(GithubSecrets.debuggerRequested([argument], {})).toBe(true)
  expect(GithubSecrets.debuggerRequested(["--disable-sigusr1", "--user-agent=vector/preview"], {})).toBe(false)
  expect(GithubSecrets.debuggerRequested([], { NODE_OPTIONS: '--trace-warnings "--inspect=0"' })).toBe(true)
  expect(GithubSecrets.debuggerRequested([], { BUN_OPTIONS: "--inspect-brk" })).toBe(true)
  expect(GithubSecrets.debuggerRequested([], { BUN_INSPECT: "127.0.0.1:9229" })).toBe(true)
})

test.skipIf(process.platform === "win32")(
  "Codium channel consumes its private run file and excludes inherited own-key secrets",
  async () => {
    await using f = await fixture()
    await GithubSecrets.writeRunToken("vrt_fixture.signature", f.env)
    const line = await secretChannel(f.env)
    expect(JSON.parse(line)).toEqual({
      v: 1,
      githubToken: f.env.GITHUB_TOKEN,
      runToken: "vrt_fixture.signature",
      keys: {},
    })
    expect(line.endsWith("\n")).toBe(true)
    await expect(fs.stat(GithubSecrets.runTokenPath(f.env))).rejects.toThrow()
    expect(line).not.toContain(f.env.VECTOR_CLI_TOKEN)
    expect(line).not.toContain(f.env.CUSTOM_CREDENTIAL)
  },
)

test("own-key channel captures exactly listed keys without reading any run credential", async () => {
  await using f = await fixture()
  let reads = 0
  const env = { ...f.env, VECTOR_MODE: "own-key", UNLISTED_KEY: "fixture-unlisted-private" }
  const line = await secretChannel(env, {
    readRunToken: async () => {
      reads++
      throw new Error("Own-key must not read a run token")
    },
  })
  expect(reads).toBe(0)
  expect(JSON.parse(line)).toEqual({
    v: 1,
    githubToken: env.GITHUB_TOKEN,
    cliToken: env.VECTOR_CLI_TOKEN,
    keys: { CUSTOM_CREDENTIAL: env.CUSTOM_CREDENTIAL, AWS_ACCESS_KEY_ID: env.AWS_ACCESS_KEY_ID },
  })
  expect(line).not.toContain(env.UNLISTED_KEY)
  await expect(secretChannel({ ...env, VECTOR_SECRET_ENV_NAMES: "MISSING_KEY" })).rejects.toThrow()
  await expect(
    secretChannel({ ...env, VECTOR_SECRET_ENV_NAMES: "NODE_OPTIONS", NODE_OPTIONS: "--require=private" }),
  ).rejects.toThrow()
})

test("Codium refuses sudo opt-in and self-hosted execution before reading a credential", async () => {
  await using f = await fixture()
  let reads = 0
  const files = {
    readRunToken: async () => {
      reads++
      return "vrt_fixture.signature"
    },
  }
  await expect(secretChannel({ ...f.env, VECTOR_AGENT_SUDO: "1" }, files)).rejects.toThrow()
  await expect(secretChannel({ ...f.env, RUNNER_ENVIRONMENT: "self-hosted" }, files)).rejects.toThrow()
  expect(reads).toBe(0)
})

test.skipIf(process.platform === "win32")(
  "bundle copy preserves exact regular-file bytes with private output permissions",
  async () => {
    await using f = await fixture()
    await fs.writeFile(path.join(f.source, "patch.diff"), "fixture diff\n")
    await copyBundleFile(f.source, f.destination, "patch.diff")
    expect(await fs.readFile(path.join(f.destination, "patch.diff"), "utf8")).toBe("fixture diff\n")
    expect((await fs.stat(path.join(f.destination, "patch.diff"))).mode & 0o777).toBe(0o600)
    await expect(copyBundleFile(f.source, f.destination, "patch.diff")).rejects.toThrow()
  },
)

test("bundle copy refuses unknown names, directories, links and oversized files", async () => {
  await using f = await fixture()
  await expect(copyBundleFile(f.source, f.destination, "../../outside")).rejects.toThrow()
  await fs.mkdir(path.join(f.source, "patch.diff"))
  await expect(copyBundleFile(f.source, f.destination, "patch.diff")).rejects.toThrow()
  await fs.rmdir(path.join(f.source, "patch.diff"))
  await fs.writeFile(path.join(f.source, "original"), "private fixture")
  await fs.symlink(path.join(f.source, "original"), path.join(f.source, "patch.diff"))
  await expect(copyBundleFile(f.source, f.destination, "patch.diff")).rejects.toThrow()
  await fs.unlink(path.join(f.source, "patch.diff"))
  await fs.link(path.join(f.source, "original"), path.join(f.source, "patch.diff"))
  await expect(copyBundleFile(f.source, f.destination, "patch.diff")).rejects.toThrow()
  await fs.unlink(path.join(f.source, "patch.diff"))
  await fs.writeFile(path.join(f.source, "summary.json"), "")
  await fs.truncate(path.join(f.source, "summary.json"), GithubAgents.PATCH_LIMITS.summaryBytes + 1)
  await expect(copyBundleFile(f.source, f.destination, "summary.json")).rejects.toThrow()
  const linked = path.join(f.directory, "linked")
  await fs.symlink(f.source, linked, "dir")
  await expect(copyBundleFile(linked, f.destination, "summary.json")).rejects.toThrow()
})

test("checkout preflight permits ordinary repository symlinks without following them but refuses multiply linked files", async () => {
  await using f = await fixture()
  const outside = path.join(f.directory, "outside")
  await fs.writeFile(outside, "outside checkout")
  await fs.symlink(outside, path.join(f.source, "link"))
  await fs.mkdir(path.join(f.source, "nested"))
  await fs.writeFile(path.join(f.source, "nested", "file"), "repository")
  await validateCheckoutTree(f.source)
  expect(await fs.readFile(outside, "utf8")).toBe("outside checkout")
  await fs.link(outside, path.join(f.source, "hardlink"))
  await expect(validateCheckoutTree(f.source)).rejects.toThrow("refused")
  await expect(validateCheckoutTree(path.join(f.source, "link"))).rejects.toThrow("refused")
})

test("checkout preflight bounds directory depth before any privileged operation", async () => {
  await using f = await fixture()
  let directory = f.source
  for (let level = 0; level < 65; level++) {
    directory = path.join(directory, "d")
    await fs.mkdir(directory)
  }
  await expect(validateCheckoutTree(f.source)).rejects.toThrow("refused")
})

// The generated v3 jobs use ubuntu-latest; the sandbox entrypoints are explicitly Linux-only.
test.skipIf(process.platform === "linux")(
  "unsupported sandbox platforms refuse before creating private state",
  async () => {
    await using f = await fixture()
    await expect(prepare(f.env)).rejects.toThrow()
    await expect(run(["node", "fixture.js"], f.env)).rejects.toThrow()
    await expect(finish(f.env)).rejects.toThrow()
    expect(await fs.readdir(f.directory)).toEqual(["source"])
  },
)

test.skipIf(process.platform !== "win32")(
  "Windows cannot create a bundle without POSIX private directory guarantees",
  async () => {
    await using f = await fixture()
    await fs.writeFile(path.join(f.source, "patch.diff"), "fixture diff\n")
    await expect(copyBundleFile(f.source, f.destination, "patch.diff")).rejects.toThrow()
    await expect(fs.stat(path.join(f.destination, "patch.diff"))).rejects.toThrow()
    expect(await fs.readFile(path.join(f.source, "patch.diff"), "utf8")).toBe("fixture diff\n")
  },
)
