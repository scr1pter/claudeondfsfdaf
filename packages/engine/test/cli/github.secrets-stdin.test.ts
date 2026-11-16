// V18c: the secret channel loader in a fresh Bun process: the channel line arrives on stdin, which closes after it.
// Something reads `process.stdin.isTTY` first, as the CLI's startup does. With that, and stdin given as bytes to
// Bun.spawn, as the CLI tests give it, Bun 1.3.14's `for await` over process.stdin ended with none of the bytes, and
// V18b's lane run 42455742210 failed in github.agent-cli.test.ts; through a node:child_process pipe, as
// `vector github sandbox run` writes the line, it read them all. The loader now reads stdin's events either way, closes
// stdin, and refuses a stdin that is already closed instead of waiting; it resumes a stdin that something paused, which
// a 'data' listener alone would leave waiting until the job's timeout. Each case spawns Bun, so this file runs in the
// lane only.

import { afterAll, expect, test } from "bun:test"
import { spawn } from "node:child_process"
import fs from "node:fs/promises"
import path from "node:path"
import { CHANNEL, cleanup, folder } from "./github.agent-fixture"

afterAll(cleanup)

const LOADER = path.resolve(import.meta.dir, "../../src/cli/cmd/github.secrets.ts")
const SCRIPT = `import { GithubSecrets } from ${JSON.stringify(LOADER)}
void process.stdin.isTTY
if (process.argv[2] === "pause") process.stdin.pause()
await new Promise((resolve) => setTimeout(resolve, 300))
await GithubSecrets.credentials
  .load({ GITHUB_ACTIONS: "true", VECTOR_MODE: "own-key", VECTOR_SECRET_CHANNEL: "stdin" })
  .then(
    () => console.log("loaded=" + GithubSecrets.credentials.loaded() + " destroyed=" + process.stdin.destroyed),
    () => console.log("refused"),
  )
`

async function script() {
  const file = path.join(await folder("vector-secrets-stdin-"), "child.ts")
  await fs.writeFile(file, SCRIPT)
  return file
}

async function child(stdin: Uint8Array, args: string[] = []) {
  const file = await script()
  const proc = Bun.spawn([process.execPath, file, ...args], {
    env: { PATH: process.env.PATH ?? "" },
    stdin,
    stdout: "pipe",
    stderr: "pipe",
  })
  // A loader that waits for an end that never comes would hold the job until Actions times it out.
  const timer = setTimeout(() => proc.kill("SIGKILL"), 20_000)
  try {
    const [code, out, err] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ])
    return { code, out: out.trim(), err }
  } finally {
    clearTimeout(timer)
  }
}

test("the loader reads the channel line after an early stdin access, and closes stdin", async () => {
  const line = JSON.stringify({ v: 1, githubToken: CHANNEL.githubToken, cliToken: CHANNEL.cliToken, keys: {} })
  const run = await child(new TextEncoder().encode(`${line}\n`))
  expect(run.code, run.err).toBe(0)
  expect(run.out).toBe("loaded=true destroyed=true")
}, 30_000)

// Without the loader's resume() a paused stdin delivers nothing, and the child is killed after 20 seconds.
test("the loader reads the channel line from a stdin that something paused", async () => {
  const line = JSON.stringify({ v: 1, githubToken: CHANNEL.githubToken, cliToken: CHANNEL.cliToken, keys: {} })
  const run = await child(new TextEncoder().encode(`${line}\n`), ["pause"])
  expect(run.code, run.err).toBe(0)
  expect(run.out).toBe("loaded=true destroyed=true")
}, 30_000)

// The sandbox writes the line through a node:child_process pipe and ends it (github.sandbox.ts).
test("the loader reads the channel line the sandbox's way, through a pipe it ends", async () => {
  const line = JSON.stringify({ v: 1, githubToken: CHANNEL.githubToken, cliToken: CHANNEL.cliToken, keys: {} })
  const proc = spawn(process.execPath, [await script()], {
    env: { PATH: process.env.PATH ?? "" },
    stdio: ["pipe", "pipe", "pipe"],
  })
  const timer = setTimeout(() => proc.kill("SIGKILL"), 20_000)
  const out: Buffer[] = []
  proc.stdout.on("data", (chunk: Buffer) => out.push(chunk))
  proc.stdin.end(`${line}\n`)
  const code = await new Promise((resolve) => proc.on("exit", resolve))
  clearTimeout(timer)
  expect(code).toBe(0)
  expect(Buffer.concat(out).toString().trim()).toBe("loaded=true destroyed=true")
}, 30_000)

test("a stdin closed with nothing on it is refused at once", async () => {
  const run = await child(new Uint8Array())
  expect(run.code, run.err).toBe(0)
  expect(run.out).toBe("refused")
}, 30_000)
