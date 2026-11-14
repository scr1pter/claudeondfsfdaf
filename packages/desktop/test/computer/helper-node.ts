// D14: actual Node pipes/process lifetime against the bundled C1 virtual helper. No Electron or native OS input.
// Usage: node helper-node.ts <computer-helper.mjs> <fake-helper.mjs>
import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { readFile } from "node:fs/promises"
import { pathToFileURL } from "node:url"
import { setTimeout } from "node:timers/promises"

type Runtime = typeof import("../../src/main/computer-helper")
const [runtimeFile, fakeFile] = process.argv.slice(2)
if (!runtimeFile || !fakeFile) throw new Error("Expected the supervisor and fake-helper bundles.")
const { createHelperClient, spawnHelper, ComputerHelper }: Runtime = await import(pathToFileURL(runtimeFile).href)

async function bounded<T>(promise: Promise<T>, ms = 5000): Promise<T> {
  const controller = new AbortController()
  return Promise.race([
    promise.finally(() => controller.abort()),
    setTimeout(ms, undefined, { signal: controller.signal }).then(() => {
      throw new Error("The Node helper check timed out.")
    }),
  ])
}

for (const platform of ["win32", "darwin"] as const) {
  if (platform === "darwin" && process.platform === "win32") continue
  const channel = spawnHelper(
    process.execPath,
    [fakeFile, "--stdio", "--parent-pid", String(process.pid), "--channel", platform === "darwin" ? "fd3" : "stdio"],
    platform,
  )
  const client = createHelperClient(channel)
  try {
    const hello = await bounded(client.request<{ responsible: boolean }>("hello", { protocol: { min: 1, max: 1 } }))
    assert.equal(hello.responsible, true)
    assert.deepEqual(await bounded(client.request("permissions.status")), {
      screen: "granted",
      accessibility: "granted",
    })
    const exited = new Promise<void>((resolve) =>
      client.onEvent((event) => {
        if (event.event === "exit") resolve()
      }),
    )
    channel.end()
    await bounded(exited, 1000)
    await assert.rejects(client.request("permissions.status"), { code: "unavailable" })
    console.log(`PASS helper ${platform}: negotiation, duplex framing and channel EOF`)
  } finally {
    await client.close()
    channel.kill()
  }
}

// D21: a real process replacement preserves the task latch; these remain virtual OS observations only.
const nativePlatform = process.platform === "win32" ? "win32" : "darwin"
const supervisor = new ComputerHelper({
  platform: nativePlatform,
  channel: "dev",
  packaged: false,
  check: async () => {},
  spawn: (_executable, args, platform) => spawnHelper(process.execPath, [fakeFile, ...args], platform),
})
let refreshExits = 0
supervisor.onEvent((event) => {
  if (event.event === "exit") refreshExits++
})
try {
  await bounded(supervisor.start())
  await bounded(supervisor.refreshPermissions())
  assert.equal(refreshExits, 1)
  assert.deepEqual(await bounded(supervisor.request("permissions.status")), {
    screen: "granted",
    accessibility: "granted",
  })
  supervisor.setRunActive(true)
  await bounded(supervisor.refreshPermissions())
  assert.equal(refreshExits, 2)
  await assert.rejects(supervisor.request("displays.list"), { code: "unavailable" })
  assert.deepEqual(await bounded(supervisor.request("permissions.status")), {
    screen: "granted",
    accessibility: "granted",
  })
  await bounded(supervisor.resume())
  const displays = await bounded(supervisor.request<{ displays: unknown[] }>("displays.list"))
  assert.ok(displays.displays.length > 0)
  console.log("PASS helper: permission refresh replaces the Node process and preserves explicit Resume")
} finally {
  await bounded(supervisor.close())
}

// Keep the fake's parent as a separate process. It owns the only channel, so killing it must leave no helper.
const source = `
  const { spawn } = require('node:child_process');
  const helper = spawn(process.execPath, [process.argv[1], '--stdio', '--parent-pid', String(process.pid), '--channel', 'stdio'], {stdio:['pipe','pipe','ignore']});
  helper.on('error', () => process.exit(2));
  let input = Buffer.alloc(0), ready = false;
  helper.stdout.on('data', bytes => {
    input = Buffer.concat([input, bytes]);
    if (ready || input.length < 4 || input.length < 4 + input.readUInt32BE(0)) return;
    const hello = JSON.parse(input.subarray(4, 4 + input.readUInt32BE(0)).toString());
    if (hello.id !== 1 || hello.ok !== true || !hello.responsible) process.exit(2);
    ready = true;
    process.send({helper:helper.pid});
  });
  const body = Buffer.from(JSON.stringify({id:1,op:'hello',protocol:{min:1,max:1}}));
  const header = Buffer.alloc(4); header.writeUInt32BE(body.length);
  helper.stdin.write(Buffer.concat([header,body]));
  setInterval(() => {}, 1000);
`
const parent = spawn(process.execPath, ["-e", source, fakeFile], { stdio: ["ignore", "ignore", "ignore", "ipc"] })
let helperPid: number | undefined
try {
  helperPid = await bounded(
    new Promise<number>((resolve, reject) => {
      parent.once("error", reject)
      parent.once("message", (value) => {
        assert.ok(value && typeof value === "object" && "helper" in value && typeof value.helper === "number")
        resolve(value.helper)
      })
    }),
  )
  // The parent sends its child id only after the actual helper's hello response.
  const exited = new Promise<void>((resolve) => parent.once("exit", () => resolve()))
  parent.kill("SIGKILL")
  await bounded(exited)
  const start = performance.now()
  while (true) {
    try {
      process.kill(helperPid, 0)
    } catch (error) {
      assert.equal((error as NodeJS.ErrnoException).code, "ESRCH")
      break
    }
    // Some container init processes retain exited orphans. A zombie has exited and cannot hold input or serve.
    if (process.platform === "linux") {
      const stat = await readFile(`/proc/${helperPid}/stat`, "utf8").catch(() => "")
      if (!stat || /^\d+ \(.*\) Z /.test(stat)) break
    }
    if (performance.now() - start >= 1000) throw new Error("The helper outlived its parent by one second.")
    await setTimeout(10)
  }
  console.log("PASS helper: parent death leaves no helper within one second")
} finally {
  parent.kill("SIGKILL")
  if (helperPid) {
    try {
      process.kill(helperPid, "SIGKILL")
    } catch {}
  }
}
