import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { GithubAgents } from "@vectordevai/core/github-agents"
import { GithubSecrets } from "../../src/cli/cmd/github.secrets"
import {
  copyBundleFile,
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

test("Codium channel consumes its private run file and excludes inherited own-key secrets", async () => {
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
})

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

test("bundle copy preserves exact regular-file bytes with private output permissions", async () => {
  await using f = await fixture()
  await fs.writeFile(path.join(f.source, "patch.diff"), "fixture diff\n")
  await copyBundleFile(f.source, f.destination, "patch.diff")
  expect(await fs.readFile(path.join(f.destination, "patch.diff"), "utf8")).toBe("fixture diff\n")
  if (process.platform !== "win32")
    expect((await fs.stat(path.join(f.destination, "patch.diff"))).mode & 0o777).toBe(0o600)
  await expect(copyBundleFile(f.source, f.destination, "patch.diff")).rejects.toThrow()
})

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
