// Checks run inside the cloud computer's image (contract WP A54), as root in a privileged container, by the image job
// in CI (test/image.test.ts starts it when VECTOR_TEST_HOSTED_IMAGE names a built image). Plain Node, no dependency:
// it uses the image's own hostd bundle. Each check prints one JSON line; the exit code is the number of failures.
//
// The container lacks the user namespaces Chromium's sandbox needs, so only here Chromium runs with --no-sandbox; the
// real-microVM check (script/microvm-check.ts) starts it with its sandbox on, as hostd does.
import { execFileSync, spawn, spawnSync } from "node:child_process"
import { generateKeyPairSync, randomBytes, sign } from "node:crypto"
import { existsSync, readFileSync, statSync, writeFileSync, mkdirSync, readdirSync } from "node:fs"
import net from "node:net"

let failures = 0
const report = (check, ok, detail) => {
  if (!ok) failures++
  console.log(JSON.stringify({ check, ok, ...(detail === undefined ? {} : { detail: String(detail).slice(0, 400) }) }))
}
const sh = (command, args, options = {}) => spawnSync(command, args, { encoding: "utf8", timeout: 60_000, ...options })
const asUser = (uid, groups, command) => [
  "/usr/bin/setpriv", `--reuid=${uid}`, `--regid=${uid}`, groups ? `--groups=${groups}` : "--clear-groups",
  "--no-new-privs", "--inh-caps=-all", "--bounding-set=-all", "--", ...command,
]
const session = `hs_${Array.from(randomBytes(26), (byte) => "abcdefghijklmnopqrstuvwxyz234567"[byte % 32]).join("")}`

// ── The image as built ─────────────────────────────────────────────────────────────────────────────────────────────
report("agent is uid 10001", sh("id", ["-u", "agent"]).stdout.trim() === "10001")
report("agent's groups are agent and share only", sh("id", ["-G", "agent"]).stdout.trim().split(/\s+/).sort().join(",") === "10001,10010")
const privileged = sh("find", ["/", "-xdev", "-type", "f", "-perm", "/6000"]).stdout.trim()
report("no setuid or setgid file", privileged === "", privileged)
report(
  "no sudo, doas or su on the disk",
  ["sudo", "doas", "su"].every((name) => ["/bin", "/usr/bin", "/sbin", "/usr/sbin", "/usr/local/bin"].every((dir) => !existsSync(`${dir}/${name}`))),
)
for (const binary of ["/usr/bin/setpriv", "/usr/bin/xdotool", "/usr/bin/ffmpeg", "/usr/bin/chromium-browser", "/usr/bin/git", "/usr/bin/tar", "/usr/sbin/nft", "/usr/bin/node", "/usr/local/bin/vector"])
  report(`${binary} is installed`, existsSync(binary))
const writable = sh("find", ["/opt/vector", "/usr/lib/vector", "/etc/chromium", "(", "!", "-user", "root", "-o", "-perm", "/022", ")", "-print"]).stdout.trim()
report("system components are root's and not writable by others", writable === "", writable)

// ── Boot ───────────────────────────────────────────────────────────────────────────────────────────────────────────
const boot = sh("/opt/vector/boot.sh", ["--run-host", "vector-check.invalid", "--session", session], { timeout: 120_000 })
report("boot.sh finishes", boot.status === 0, boot.stderr)
// When boot stops, the services' own logs say why (each check's detail keeps 400 characters: the end of each log).
if (boot.status !== 0)
  for (const file of existsSync("/run/vector/log") ? readdirSync("/run/vector/log") : [])
    report(`boot log ${file}`, false, readFileSync(`/run/vector/log/${file}`, "utf8").slice(-400))
report("boot.sh refuses extra arguments", sh("/opt/vector/boot.sh", ["--run-host", "a.invalid", "--session", session, "--x"]).status !== 0)

const output = sh("nft", ["list", "chain", "inet", "vector", "output"]).stdout
report("the firewall's output policy is drop", output.includes("policy drop"))
report("the firewall allows tcp/443", output.includes("tcp dport 443 accept"))

// Listening TCP sockets, from /proc/net/tcp and tcp6 (state 0A).
const listening = ["/proc/net/tcp", "/proc/net/tcp6"].flatMap((file) =>
  existsSync(file)
    ? readFileSync(file, "utf8").split("\n").slice(1).map((line) => line.trim().split(/\s+/)).filter((f) => f[3] === "0A").map((f) => parseInt(f[1].split(":").pop(), 16))
    : [],
)
report("the viewer port is the only TCP listener", listening.length > 0 && listening.every((port) => port === 6080), listening.join(","))
report("VNC does not listen on TCP", !listening.includes(5900))
const vnc = "/run/vector/vnc/vnc.sock"
report("the VNC socket exists", existsSync(vnc))
if (existsSync(vnc)) {
  const info = statSync(vnc)
  report("the VNC socket is the viewer group's only", info.gid === 10002 && (info.mode & 0o007) === 0, (info.mode & 0o777).toString(8))
}

const probe = (uid, code) => {
  const [file, ...args] = asUser(uid, "", ["/usr/bin/node", "-e", code])
  return sh(file, args, { timeout: 30_000 }).stdout.trim()
}
const tcp = (host, port) =>
  `const s=require("net").connect({host:${JSON.stringify(host)},port:${port},timeout:4000});s.on("connect",()=>{console.log("open");s.destroy()});s.on("timeout",()=>{console.log("closed");s.destroy()});s.on("error",()=>console.log("closed"))`
report("the agent cannot open the VNC socket", probe(10001, `const s=require("net").connect(${JSON.stringify(vnc)});s.on("connect",()=>{console.log("open");s.destroy()});s.on("error",()=>console.log("closed"))`) === "closed")
report("the agent cannot reach the viewer proxy on loopback", probe(10001, tcp("127.0.0.1", 6080)) === "closed")
const https = probe(10001, tcp("1.1.1.1", 443))
const http = probe(10001, tcp("1.1.1.1", 80))
report("the agent reaches tcp/443", https === "open", https)
report("the agent cannot reach port 80", http === "closed", http)

const data = sh("findmnt", ["-no", "SOURCE,OPTIONS", "/data"]).stdout.trim()
report("the agent's disk is a nosuid, nodev loop mount", /^\/dev\/loop\d+ .*nosuid.*nodev|^\/dev\/loop\d+ .*nodev.*nosuid/.test(data), data)
const size = Number(sh("df", ["-B1", "--output=size", "/data"]).stdout.trim().split("\n").pop())
report("the agent's disk is at most 10 GB", size > 0 && size <= 10_000_000_000, size)
report("/tmp is a memory disk", sh("findmnt", ["-no", "FSTYPE", "/tmp"]).stdout.trim() === "tmpfs")
report("the agent cannot write to the system disk", probe(10001, `try{require("fs").writeFileSync("/var/lib/vector/x","x");console.log("open")}catch{console.log("closed")}`) === "closed")
report("the agent cannot read the display cookie", probe(10001, `try{require("fs").readFileSync("/run/vector/x/auth");console.log("open")}catch{console.log("closed")}`) === "closed")

// ── Viewer tokens ──────────────────────────────────────────────────────────────────────────────────────────────────
const { privateKey, publicKey } = generateKeyPairSync("ed25519")
const key = publicKey.export({ format: "jwk" }).x
mkdirSync("/run/vector/viewer", { recursive: true })
writeFileSync("/run/vector/viewer/state.json", JSON.stringify({ session, key, control: "agent", updatedAt: Date.now() }), { mode: 0o640 })
execFileSync("chown", ["0:10002", "/run/vector/viewer/state.json"])
const mint = (claims) => {
  const now = Math.floor(Date.now() / 1000)
  const payload = Buffer.from(JSON.stringify({ aud: "vector-viewer", sid: session, computer: "vh-0123456789abcdef-1", mode: "view", jti: randomBytes(16).toString("base64url"), iat: now, exp: now + 300, ...claims })).toString("base64url")
  return `vvt1.${payload}.${sign(null, Buffer.from("vector-viewer-token-v1." + payload), privateKey).toString("base64url")}`
}
const viewer = (token) =>
  new Promise((resolve) => {
    const socket = net.connect(6080, "127.0.0.1")
    let buffer = Buffer.alloc(0)
    let upgraded = false
    const done = (value) => { socket.destroy(); resolve(value) }
    setTimeout(() => done("timeout"), 8000)
    socket.on("connect", () =>
      socket.write(`GET /socket HTTP/1.1\r\nHost: 127.0.0.1:6080\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nOrigin: https://127.0.0.1:6080\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: ${randomBytes(16).toString("base64")}\r\n\r\n`),
    )
    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk])
      if (!upgraded) {
        const end = buffer.indexOf("\r\n\r\n")
        if (end < 0) return
        if (!buffer.subarray(0, 12).toString().includes("101")) return done("refused")
        upgraded = true
        buffer = buffer.subarray(end + 4)
        const text = Buffer.from(token)
        const mask = randomBytes(4)
        const header = text.length < 126 ? Buffer.from([0x81, 0x80 | text.length]) : Buffer.from([0x81, 0x80 | 126, text.length >> 8, text.length & 255])
        socket.write(Buffer.concat([header, mask, Buffer.from(text.map((byte, i) => byte ^ mask[i % 4]))]))
      }
      if (buffer.length >= 2) {
        const opcode = buffer[0] & 0x0f
        if (opcode === 8) return done(`closed ${buffer.length >= 4 ? buffer.readUInt16BE(2) : ""}`.trim())
        if (opcode === 2 && buffer.length >= 2 + 12) return done(buffer.subarray(2, 14).toString("latin1"))
      }
    })
    socket.on("error", () => done("error"))
  })
const token = mint({})
report("a viewer token opens the live view", (await viewer(token)).startsWith("RFB 003."))
report("a viewer token is single use", (await viewer(token)) === "closed 4003")
report("an expired viewer token is refused", (await viewer(mint({ iat: Math.floor(Date.now() / 1000) - 600, exp: Math.floor(Date.now() / 1000) - 300 }))) === "closed 4003")
report("another session's viewer token is refused", (await viewer(mint({ sid: `hs_${"a".repeat(26)}` }))) === "closed 4003")

// ── The browser: policy and credential guard ───────────────────────────────────────────────────────────────────────
const bundle = await import("/opt/vector/hostd.mjs")
const profile = `/tmp/check-profile-${randomBytes(4).toString("hex")}`
mkdirSync(profile, { recursive: true })
execFileSync("chown", ["10004:10004", profile])
const browserArgs = asUser(10004, "", ["/usr/bin/chromium-browser", "--headless=new", "--no-sandbox", `--user-data-dir=${profile}`, "--remote-debugging-pipe", "about:blank"])
const browser = spawn(browserArgs[0], browserArgs.slice(1), { stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"], env: { HOME: profile, PATH: "/usr/bin:/bin" } })
const pipe = new bundle.CdpPipe((chunk) => browser.stdio[3].write(chunk))
browser.stdio[4].on("data", (chunk) => pipe.feed(chunk))
let step = "guard start"
try {
  const guard = new bundle.BrowserGuard(pipe, readFileSync("/opt/vector/credential-guard.js", "utf8"))
  await guard.start()
  step = "create target"
  const { targetId } = await pipe.send("Target.createTarget", { url: "about:blank" })
  step = "attach"
  const { sessionId } = await pipe.send("Target.attachToTarget", { targetId, flatten: true })
  step = "page enable"
  await pipe.send("Page.enable", {}, sessionId)
  step = "checks"
  await pipe.send("Emulation.setFocusEmulationEnabled", { enabled: true }, sessionId)
  const blocked = await pipe.send("Page.navigate", { url: "https://hosted-run.vectordev.ai/" }, sessionId)
  report("the browser policy blocks the run-API host", String(blocked.errorText ?? "").includes("BLOCKED_BY_ADMINISTRATOR"), blocked.errorText)
  await pipe.send("Page.navigate", { url: "data:text/html,<input type=password id=p><input id=q name=search>" }, sessionId)
  await new Promise((resolve) => setTimeout(resolve, 1500))
  await pipe.send("Runtime.evaluate", { expression: "document.getElementById('p').focus()" }, sessionId)
  report("the guard sees a focused password field", (await guard.focusedSecret()) === "credential")
  await pipe.send("Runtime.evaluate", { expression: "document.getElementById('q').focus()" }, sessionId)
  report("the guard lets an ordinary field through", (await guard.focusedSecret()) === undefined)
} catch (error) {
  report("the browser checks ran", false, `${step}: ${error.message}`)
} finally {
  browser.kill("SIGKILL")
}

// ── The profile wipe ───────────────────────────────────────────────────────────────────────────────────────────────
mkdirSync("/run/vector/browser/profile/Default", { recursive: true })
writeFileSync("/run/vector/browser/profile/Default/Cookies", "fixture")
writeFileSync("/run/vector/browser/home/.pki", "fixture")
writeFileSync("/tmp/.org.chromium.Chromium.fixture", "fixture")
await bundle.wipeBrowser()
report("the wipe empties the profile", readdirSync("/run/vector/browser/profile").length === 0)
report("the wipe empties the browser's home", readdirSync("/run/vector/browser/home").length === 0)
report("the wipe removes Chromium's scratch files", !existsSync("/tmp/.org.chromium.Chromium.fixture"))
report("the fresh profile is the browser user's", statSync("/run/vector/browser/profile").uid === 10004)

process.exit(failures)
