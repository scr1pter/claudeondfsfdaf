import fs from "node:fs/promises"
import path from "node:path"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { fileURLToPath } from "node:url"
import { prepare, run, finish } from "../../src/cli/cmd/github.sandbox"
import { GithubSecrets } from "../../src/cli/cmd/github.secrets"

if (process.argv[2] === "--observe") {
  const state = JSON.parse(
    await fs.readFile(path.join(process.env.RUNNER_TEMP!, "vector-sandbox", "state.json"), "utf8"),
  )
  if (
    !state.prepared ||
    state.workspace !== process.env.GITHUB_WORKSPACE ||
    !["/mnt/vector-agent-sandbox", "/var/lib/vector-agent-sandbox", "/home/vector-agent-sandbox"].includes(
      state.container,
    )
  )
    throw new Error("Missing trusted staged checkout")
  await fs.writeFile(
    path.join(process.env.RUNNER_TEMP!, "vector-probe-tools", "stage.json"),
    JSON.stringify({ container: state.container, workspace: state.workspace, uid: state.uid }),
    { mode: 0o600, flag: "wx" },
  )
  const text = await promisify(execFile)(
    "sudo",
    ["-n", "/usr/bin/cat", "--", path.join(state.container, "checkout", "vector-out", "summary.json")],
    { maxBuffer: 262_144 },
  )
  const report = JSON.parse(text.stdout)
  await fs.writeFile(
    path.join(process.env.RUNNER_TEMP!, "vector-probe-tools", "observed.json"),
    JSON.stringify(report),
    { mode: 0o600, flag: "wx" },
  )
  if (process.env.PROBE_SCENARIO === "seal-refusal") {
    // Cause the real finish path to refuse before quarantine, while its live detached child still needs cleanup.
    await promisify(execFile)("sudo", ["-n", "/usr/bin/chmod", "0711", "--", state.container])
  }
} else if (process.argv[2] === "--install") {
  const shim = path.join(process.env.RUNNER_TEMP!, "vector-probe-tools", "vector")
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`
  await fs.writeFile(
    shim,
    `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(fileURLToPath(import.meta.url))} "$@"\n`,
    { mode: 0o755 },
  )
  await promisify(execFile)("sudo", ["-n", "install", "-m", "0755", shim, "/usr/local/bin/vector"])
  const commands = path.dirname(process.env.GITHUB_ENV!)
  if (!(await fs.stat(commands)).isDirectory()) throw new Error("The runner command directory is missing")
  const metadata = path.join(process.env.RUNNER_TEMP!, "vector-probe-tools", "paths.json")
  await fs.writeFile(metadata, JSON.stringify({ commands }), { mode: 0o600 })
  await promisify(execFile)("sudo", ["-n", "install", "-m", "0444", metadata, "/opt/vector-sandbox-probe-paths.json"])
  await GithubSecrets.writeRunToken("vrt_probe.signature", process.env)
  // Bundles and external action sources are already outside checkout. Exercise the real staging path with a
  // small disposable repository, not this monorepo's installed dependency tree and unrelated build outputs.
  const workspace = process.env.GITHUB_WORKSPACE!
  if ((await fs.realpath(workspace)) !== workspace || workspace === "/" || workspace === process.env.HOME)
    throw new Error("Unexpected probe workspace")
  for (const entry of await fs.readdir(workspace))
    await fs.rm(path.join(workspace, entry), { recursive: true, force: true })
  await fs.writeFile(path.join(workspace, "README.md"), "Disposable hosted sandbox fixture\n")
  await promisify(execFile)("git", ["init", "--quiet", workspace])
  // A valid private checkout must be entered only after the launcher switches to its new owner.
  await fs.chmod(workspace, 0o700)
} else {
  if (process.argv[2] !== "github" || process.argv[3] !== "sandbox") throw new Error("Unexpected probe invocation")
  const action = process.argv[4]
  if (action === "prepare") await prepare()
  else if (action === "finish") {
    const pending = finish()
    if (process.env.PROBE_SCENARIO === "cancelled") process.kill(process.pid, "SIGTERM")
    await pending
  } else if (action === "run" && process.argv[5] === "--") process.exitCode = await run(process.argv.slice(6))
  else throw new Error("Unexpected sandbox action")
}
