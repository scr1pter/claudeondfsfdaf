import { execFileSync } from "node:child_process"
import { randomBytes, randomUUID } from "node:crypto"
import { mkdir, writeFile } from "node:fs/promises"
import { createDockerRuntime, type DockerRunner } from "../src/docker"
import { record } from "../src/protocol"
import { ascending } from "@vectordevai/schema/identifier"

// Actual isolated engine/Git/SQLite exercise with a scripted, zero-cost provider.
// runc/local storage is permitted only by this explicit development test path.
const image = process.env.VECTOR_WORKSPACES_TEST_IMAGE
if (!image || !/^sha256:[a-f0-9]{64}$/.test(image))
  throw new Error("Set VECTOR_WORKSPACES_TEST_IMAGE to the built image's actual immutable ID.")
const id = randomUUID()
const password = randomBytes(32).toString("hex")
const network = `vector-cloud-smoke-${randomBytes(4).toString("hex")}`
const output = process.env.VECTOR_WORKSPACES_TEST_OUTPUT ?? "/tmp/vector-cloud-workspaces-runtime-smoke"
const docker = (args: string[]) =>
  execFileSync("docker", ["--host=unix:///var/run/docker.sock", ...args], { encoding: "utf8", timeout: 120000 })
let modelCalls = 0
let toolCalls = 0
const model = Bun.serve({
  hostname: "0.0.0.0",
  port: 0,
  async fetch(request) {
    if (request.headers.get("authorization") !== `Bearer ${password}`) return new Response(null, { status: 401 })
    const body = (await request.json()) as { messages: { role: string }[]; tools?: { function?: { name?: string } }[] }
    modelCalls++
    if (modelCalls > 8)
      return Response.json(
        { error: { message: "The fixture exceeded its finite model-call budget." } },
        { status: 422 },
      )
    const write = body.tools?.find((tool) => tool.function?.name === "write")
    const useTool = Boolean(write && !body.messages.some((message) => message.role === "tool"))
    if (useTool) toolCalls++
    const delta = useTool
      ? {
          role: "assistant",
          tool_calls: [
            {
              index: 0,
              id: "call_cloud_write",
              type: "function",
              function: {
                name: "write",
                arguments: JSON.stringify({
                  filePath: "/data/repository/cloud-proof.txt",
                  content: "Written by the actual Vector cloud engine.\n",
                }),
              },
            },
          ],
        }
      : { role: "assistant", content: "Cloud coding proof completed." }
    const chunk = (delta: unknown, finish: string | null) =>
      JSON.stringify({
        id: "chatcmpl-cloud-fixture",
        object: "chat.completion.chunk",
        created: Math.floor(Date.now() / 1000),
        model: "fixture-model",
        choices: [{ index: 0, delta, finish_reason: finish }],
      })
    return new Response(
      `data: ${chunk(delta, null)}\n\ndata: ${chunk({}, useTool ? "tool_calls" : "stop")}\n\ndata: [DONE]\n\n`,
      { headers: { "content-type": "text/event-stream" } },
    )
  },
})
docker(["network", "create", network])
const run: DockerRunner = async (command) => {
  try {
    return {
      code: 0,
      stdout: execFileSync("docker", ["--host=unix:///var/run/docker.sock", ...command.args], {
        encoding: "utf8",
        input: command.input,
        timeout: command.timeoutMs ?? 30000,
        env: { ...process.env, ...command.env },
        stdio: ["pipe", "pipe", "pipe"],
      }),
    }
  } catch (error) {
    await mkdir(output, { recursive: true })
    const stderr =
      error && typeof error === "object" && "stderr" in error ? String(error.stderr) : "Docker command failed."
    await writeFile(
      `${output}/docker-failure.log`,
      `${command.args.slice(0, 2).join(" ")}\n${stderr.replaceAll(password, "[scoped-test-credential]")}`,
    )
    return { code: 1, stdout: "" }
  }
}
const runtime = createDockerRuntime({ image, network, runtime: "runc", allowInsecure: true, run })
try {
  await runtime.create({
    id,
    password,
    model: {
      id: "fixture-model",
      name: "Fixture model",
      baseURL: `http://host.docker.internal:${model.port}/model/${id}/v1`,
      token: password,
    },
  })
  const deadline = Date.now() + 90000
  while (!(await runtime.health(id, password))) {
    if (Date.now() > deadline) throw new Error("The actual engine did not become ready.")
    await Bun.sleep(250)
  }
  docker([
    "exec",
    `vector-ws-${id}`,
    "python3",
    "-c",
    String.raw`import pathlib,subprocess
p=pathlib.Path('/data/repository')
(p/'README.md').write_text('Original repository.\n')
(p/'delete-me.txt').write_text('Remove this tracked file.\n')
(p/'script.sh').write_text('echo fixture\n')
subprocess.run(['git','-C',str(p),'add','README.md','delete-me.txt','script.sh'],check=True)
subprocess.run(['git','-C',str(p),'-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-m','fixture base'],check=True)`,
  ])
  const baseCommit = docker(["exec", `vector-ws-${id}`, "git", "-C", "/data/repository", "rev-parse", "HEAD"]).trim()
  const send = async (path: string, body?: unknown) => {
    const response = await runtime.request(id, password, path, {
      method: body === undefined ? "GET" : "POST",
      headers: { "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    if (!response.ok) throw new Error(`Actual engine request failed: ${path} ${response.status}`)
    return response.status === 204 ? null : response.json()
  }
  const session = (await send("/session", { title: "Cloud persistence proof" })) as { id: string }
  if (!session.id?.startsWith("ses_")) throw new Error("The engine did not create a saved chat.")
  const messageID = `msg_${ascending()}`
  await send(`/session/${session.id}/prompt_async`, {
    messageID,
    model: { providerID: "vector-cloud", modelID: "fixture-model" },
    parts: [{ type: "text", text: "Create /data/repository/cloud-proof.txt with the write tool." }],
  })
  let messages: { info: { role: string; time?: { completed?: number }; error?: unknown }; parts: unknown[] }[] = []
  const finish = Date.now() + 90000
  while (Date.now() < finish) {
    messages = (await send(`/session/${session.id}/message`)) as typeof messages
    if (messages.some((message) => message.info.error)) throw new Error("The actual engine reported a turn error.")
    const status: unknown = await send("/session/status")
    const completed = messages.some(
      (message) =>
        message.info.role === "assistant" &&
        message.info.time?.completed &&
        message.parts.some(
          (part) => record(part) && part.type === "text" && part.text === "Cloud coding proof completed.",
        ),
    )
    if (toolCalls > 0 && completed && record(status) && !status[session.id]) break
    await Bun.sleep(250)
  }
  const content = docker(["exec", `vector-ws-${id}`, "cat", "/data/repository/cloud-proof.txt"])
  if (content !== "Written by the actual Vector cloud engine.\n" || toolCalls !== 1)
    throw new Error("The real write tool did not produce the expected repository change.")
  const beforePause = JSON.stringify(messages)
  await runtime.stop(id)
  docker([
    "run",
    "--rm",
    "--network",
    "none",
    "--user",
    "10001:10001",
    "--read-only",
    "--cap-drop=ALL",
    "--security-opt=no-new-privileges:true",
    "--tmpfs",
    "/tmp:rw,nosuid,nodev,noexec,size=16m",
    "--mount",
    `type=volume,source=vector-ws-data-${id},target=/data`,
    "--entrypoint",
    "python3",
    image,
    "-c",
    String.raw`import pathlib,subprocess
p=pathlib.Path('/data/repository')
(p/'README.md').write_text('Updated without a final newline')
(p/'delete-me.txt').unlink()
(p/'script.sh').chmod(0o755)
(p/'.gitattributes').write_text('README.md filter=evil\n')
subprocess.run(['git','-C',str(p),'config','filter.evil.clean','touch /data/repository/UNSAFE-FILTER-RAN'],check=True)
subprocess.run(['git','-C',str(p),'config','core.fsmonitor','touch /data/repository/UNSAFE-MONITOR-RAN'],check=True)`,
  ])
  const snapshot = await runtime.snapshot(id, { baseCommit })
  if (
    !snapshot.changes.some((change) => change.path === "cloud-proof.txt") ||
    !snapshot.diff.includes("Written by the actual Vector")
  )
    throw new Error("The actual readonly exporter lost the agent's file edit.")
  if (
    !snapshot.diff.includes("No newline at end of file") ||
    !snapshot.changes.some((change) => change.path === "delete-me.txt" && change.content === null) ||
    !snapshot.changes.some((change) => change.path === "script.sh" && change.mode === "100755") ||
    snapshot.changes.some((change) => change.path.startsWith("UNSAFE-"))
  )
    throw new Error("The actual exporter lost file semantics or executed repository configuration.")
  docker([
    "run",
    "--rm",
    "--network",
    "none",
    "--user",
    "10001:10001",
    "--read-only",
    "--cap-drop=ALL",
    "--security-opt=no-new-privileges:true",
    "--mount",
    `type=volume,source=vector-ws-data-${id},target=/data`,
    "--entrypoint",
    "git",
    image,
    "-C",
    "/data/repository",
    "config",
    "--unset",
    "core.fsmonitor",
  ])
  await runtime.start(id)
  const resumeDeadline = Date.now() + 90000
  while (!(await runtime.health(id, password))) {
    if (Date.now() > resumeDeadline) throw new Error("The resumed engine did not become ready.")
    await Bun.sleep(250)
  }
  const restored = await send(`/session/${session.id}/message`)
  await mkdir(output, { recursive: true })
  await writeFile(`${output}/messages-before.json`, beforePause)
  await writeFile(`${output}/messages-restored.json`, JSON.stringify(restored))
  if (JSON.stringify(restored) !== beforePause)
    throw new Error("Saved chat changed or disappeared after restarting the real engine.")
  if (docker(["exec", `vector-ws-${id}`, "cat", "/data/repository/cloud-proof.txt"]) !== content)
    throw new Error("Repository files disappeared on resume.")
  await mkdir(output, { recursive: true })
  await writeFile(
    `${output}/receipt.json`,
    JSON.stringify(
      {
        schemaVersion: 1,
        passed: true,
        image,
        accountTokensInjected: false,
        realEngine: true,
        realGitAndSqlite: true,
        scriptedProvider: true,
        productionIsolation: false,
        modelCalls,
        toolCalls,
        sessionId: session.id,
        savedMessages: messages.length,
        snapshotDigest: snapshot.digest,
        files: snapshot.changes.map((change) => change.path),
        checks: [
          "actual-model-tool-write",
          "persisted-chat",
          "pause-readonly-diff",
          "edit-add-delete-mode-no-final-newline",
          "hostile-git-config-not-executed",
          "engine-restart",
          "restored-history",
          "restored-repository",
        ],
      },
      null,
      2,
    ) + "\n",
  )
  console.info(`Actual cloud engine smoke passed; receipt: ${output}/receipt.json`)
} catch (error) {
  await mkdir(output, { recursive: true })
  try {
    await writeFile(`${output}/engine.log`, docker(["logs", `vector-ws-${id}`]))
  } catch {
    /* Setup may fail before the engine exists. */
  }
  throw error
} finally {
  await runtime.stop(id).catch(() => undefined)
  await runtime.remove(id, { deleteData: true }).catch(() => undefined)
  try {
    docker(["network", "rm", network])
  } catch {
    /* Preserve the original diagnostic. */
  }
  await model.stop(true)
}
