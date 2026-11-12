import { createHash, randomBytes } from "node:crypto"
import { constants } from "node:fs"
import fs from "node:fs/promises"
import { spawn } from "node:child_process"
import { LinuxIsolation } from "@vectordevai/core/process-isolation/linux"
import { GithubIsolationBuild } from "./github.isolation-build"

// Only Root's exact-module build plugin replaces the inactive source stub. No ambient global/env lookup exists.

export const PROFILE_PATH = "/etc/apparmor.d/vector-sandbox-v1"
export const PROFILE = `abi <abi/4.0>,
profile vector-sandbox-v1 flags=(attach_disconnected,mediate_deleted) {
  file,
  network,
  unix,
  signal,
  ptrace,
  capability setuid,
  capability setgid,
  capability setpcap,
  capability setfcap,
  capability dac_override,
  capability sys_admin,
  capability sys_chroot,
  mount,
  umount,
  pivot_root,
  userns,
}
`
const PROFILE_SHA = digest(PROFILE)
const PARENTS = ["/", "/usr", "/usr/libexec", "/etc", "/etc/apparmor.d"] as const
const BASE = "/usr/libexec/vector-sandbox"
const REFUSAL = "The trusted Linux runner adapter refused its fixed installation or lifetime contract."

export interface Asset {
  readonly v: 1
  readonly entry: string
  readonly sha256: string
}
export interface Scope {
  readonly container: string
  readonly uid: number
  readonly gid: number
}
export interface State extends Scope {
  readonly v: 1
  readonly phase: "intent" | "ready"
  readonly installNonce: string
  readonly assetSHA: string
  readonly namespaceNonce?: string
}
export interface Metadata {
  readonly kind: "directory" | "file" | "other"
  readonly uid: number
  readonly gid: number
  readonly mode: number
  readonly canonical: string
  readonly nlink: number
  readonly sha256?: string
}
export interface Invocation {
  readonly file: "/usr/bin/sudo"
  readonly args: readonly string[]
  readonly input: string
  readonly timeout: number
  readonly maxOutput: number
  readonly env: Readonly<Record<string, string>>
}
export interface Ports {
  readonly temporary: string
  readonly asset: Asset
  readonly inspect: (name: string) => Promise<Metadata | undefined>
  readonly execute: (invocation: Invocation) => Promise<string>
  readonly nonce: () => string
}

function refused(): never {
  throw new Error(REFUSAL)
}
function digest(value: string | Uint8Array) {
  return createHash("sha256").update(value).digest("hex")
}
function exact(value: unknown, keys: readonly string[]): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) refused()
  const found = Reflect.ownKeys(value)
  if (found.length !== keys.length || found.some((key) => typeof key !== "string" || !keys.includes(key))) refused()
}
function hex(value: unknown, size: number): asserts value is string {
  if (typeof value !== "string" || !new RegExp(`^[a-f0-9]{${size}}$`).test(value)) refused()
}
function scope(value: Scope) {
  if (!LinuxIsolation.CONTAINERS.some((container) => container === value.container)) refused()
  for (const id of [value.uid, value.gid]) if (!Number.isSafeInteger(id) || id <= 0 || id > 0x7fff_ffff) refused()
}
export function parseState(value: unknown): State {
  const keys = ["v", "phase", "container", "uid", "gid", "installNonce", "assetSHA"]
  if (value && typeof value === "object" && "phase" in value && value.phase === "ready") keys.push("namespaceNonce")
  exact(value, keys)
  if (value.v !== 1 || (value.phase !== "intent" && value.phase !== "ready")) refused()
  if (typeof value.container !== "string" || typeof value.uid !== "number" || typeof value.gid !== "number") refused()
  scope({ container: value.container, uid: value.uid, gid: value.gid })
  hex(value.installNonce, 32)
  hex(value.assetSHA, 64)
  const namespaceNonce = value.phase === "ready" ? value.namespaceNonce : undefined
  if (value.phase === "ready") hex(namespaceNonce, 32)
  return Object.freeze<State>({
    v: 1,
    phase: value.phase,
    container: value.container,
    uid: value.uid,
    gid: value.gid,
    installNonce: value.installNonce,
    assetSHA: value.assetSHA,
    ...(typeof namespaceNonce === "string" ? { namespaceNonce } : {}),
  })
}
export function validState(value: unknown) {
  try {
    parseState(value)
    return true
  } catch {
    return false
  }
}

// Fixed root control program. The sole stdin payload is the build-embedded asset; command paths are never inputs.
// Its lock is held across prepare/inspect/cleanup. A busy/missing/partial owner refuses, never adopts or retries.
const CONTROL =
  `PROFILE = ${JSON.stringify(PROFILE)}\n` +
  String.raw`
import array, fcntl, hashlib, json, os, pathlib, select, stat, subprocess, sys
ROOT = "/usr/libexec/vector-sandbox/v1"
BASE = "/usr/libexec/vector-sandbox"
ENTRY = ROOT + "/entry.py"
PRIVATE = ROOT + "/private"
INSTALL = PRIVATE + "/install.json"
LOCK = PRIVATE + "/install.lock"
POLICY = "/etc/apparmor.d/vector-sandbox-v1"
PROFILES = "/sys/kernel/security/apparmor/profiles"
ENV = {"PATH":"/usr/bin:/bin","LC_ALL":"C"}
def need(ok):
    if not ok: raise RuntimeError("Fixed runner control refused")
def sha(data): return hashlib.sha256(data).hexdigest()
def secure(name, mode, directory=False):
    item = os.lstat(name)
    need(os.path.realpath(name) == name and item.st_uid == item.st_gid == 0 and stat.S_IMODE(item.st_mode) == mode)
    need(stat.S_ISDIR(item.st_mode) if directory else stat.S_ISREG(item.st_mode) and item.st_nlink == 1)
    for parent in pathlib.Path(name).parents:
        info = parent.lstat()
        need(stat.S_ISDIR(info.st_mode) and info.st_uid == info.st_gid == 0 and not info.st_mode & 0o022 and
             os.path.realpath(parent) == str(parent))
    return item
def read(name, mode, limit):
    secure(name, mode)
    fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC | os.O_NONBLOCK)
    try:
        info = os.fstat(fd)
        need(stat.S_ISREG(info.st_mode) and info.st_uid == info.st_gid == 0 and info.st_nlink == 1 and
             stat.S_IMODE(info.st_mode) == mode and info.st_size <= limit)
        data = os.read(fd, limit + 1)
        need(len(data) == info.st_size and len(data) <= limit)
        return data
    finally: os.close(fd)
def write(name, data, mode):
    fd = os.open(name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC, mode)
    try:
        os.fchmod(fd, mode)
        with os.fdopen(fd, "wb", closefd=False) as stream:
            stream.write(data); stream.flush(); os.fsync(fd)
    finally: os.close(fd)
def record(value, first=False):
    data = json.dumps(value,separators=(",",":")).encode("ascii")
    if first: write(INSTALL, data, 0o600); return
    temporary = PRIVATE + "/install-" + os.urandom(16).hex() + ".tmp"
    write(temporary, data, 0o600)
    os.replace(temporary, INSTALL)
def loaded():
    with open(PROFILES,"rb") as stream: data = stream.read(1048577)
    need(len(data) <= 1048576)
    return [line for line in data.decode("ascii","strict").splitlines() if line.startswith("vector-sandbox-v1 ")]
def executable(name):
    resolved = os.path.realpath(name)
    need(resolved.startswith("/usr/") and not resolved.startswith(("/usr/local/","/usr/libexec/vector-sandbox/")))
    item = os.lstat(resolved)
    need(stat.S_ISREG(item.st_mode) and item.st_uid == item.st_gid == 0 and not item.st_mode & 0o022 and
         item.st_mode & 0o111)
    secure(resolved,stat.S_IMODE(item.st_mode))
    return resolved
def native_state():
    value = json.loads(read(PRIVATE + "/state.json", 0o600, 65536).decode("utf-8","strict"))
    public = value["public"]
    need(public["uid"] == uid and public["gid"] == gid and public["container"] == container and
         public["stage"] == container + "/checkout" and public["scratch"] == container + "/tool-scratch" and
         public["directory"] == container + "/tool-namespaces" and
         public["socket"] == container + "/tool-namespaces/broker.sock")
    return value
# A separate fixed, secret-free client runs as the disposable agent, because the broker intentionally refuses Root.
# It compiles only digest-verified production source bytes, closes every received handle, and never enters it.
CLIENT = r'''
import ctypes, errno, hashlib, json, os, pathlib, stat, sys
from types import SimpleNamespace
sys.dont_write_bytecode = True
def need(ok):
    if not ok: raise RuntimeError("Fixed status asset refused")
entry = "/usr/libexec/vector-sandbox/v1/entry.py"
need(len(sys.argv) == 2 and len(sys.argv[1]) == 64 and all(c in "0123456789abcdef" for c in sys.argv[1]))
need(os.path.realpath(entry) == entry)
for parent in pathlib.Path(entry).parents:
    info = parent.lstat()
    need(stat.S_ISDIR(info.st_mode) and info.st_uid == info.st_gid == 0 and not info.st_mode & 0o022 and
         os.path.realpath(parent) == str(parent))
source = os.open(entry,os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC | os.O_NONBLOCK)
try:
    before = os.fstat(source)
    need(stat.S_ISREG(before.st_mode) and before.st_uid == before.st_gid == 0 and before.st_nlink == 1 and
         stat.S_IMODE(before.st_mode) == 0o444 and 0 < before.st_size <= 131072)
    code = os.read(source,131073)
    after = os.fstat(source)
    need(len(code) == before.st_size and len(code) <= 131072 and hashlib.sha256(code).hexdigest() == sys.argv[1] and
         (after.st_dev,after.st_ino,after.st_uid,after.st_gid,after.st_nlink,after.st_mode,after.st_size,
          after.st_mtime_ns,after.st_ctime_ns) ==
         (before.st_dev,before.st_ino,before.st_uid,before.st_gid,before.st_nlink,before.st_mode,before.st_size,
          before.st_mtime_ns,before.st_ctime_ns))
finally: os.close(source)
# No SourceFileLoader/import/cache fallback: this exact validated byte buffer defines protocol functions only.
namespace = {"__name__":"vector_native_status","__file__":entry}
exec(compile(code,entry,"exec",dont_inherit=True),namespace)
native = SimpleNamespace(**namespace)
request = json.loads(sys.stdin.buffer.read(65537).decode("utf-8","strict"))
need(type(request) is dict and set(request) == {"public","maskSources"})
public = native.validate_spec(request["public"])
protected_targets = native.validate_masks(public["keeper"]["pid"],public["keeper"]["start"],public["uid"],public["gid"],request["maskSources"])
for capability in range(64):
    if native.LIBC.prctl(24, capability, 0, 0, 0) != 0:
        native.require(ctypes.get_errno() == errno.EINVAL)
native.require(native.LIBC.prctl(47,4,0,0,0) == 0 and native.LIBC.prctl(38,1,0,0,0) == 0)
os.setgroups([])
os.setresgid(public["gid"],public["gid"],public["gid"])
os.setresuid(public["uid"],public["uid"],public["uid"])
native.require(os.getgroups() == [] and os.getuid() == public["uid"] and os.getgid() == public["gid"])
native.assert_capabilities_dropped()
descriptors = native.receive_namespaces(public)
try: native.require(len(descriptors) == 3)
finally:
    for descriptor in descriptors.values(): os.close(descriptor)
print(json.dumps({"v":1,"event":"broker-live","nonce":public["nonce"],"masks":True,
                  "protectedMountTargets":protected_targets}),flush=True)
'''
def proc_text(pid, name, limit=65536):
    with open(f"/proc/{pid}/{name}","rb") as stream: data = stream.read(limit + 1)
    need(len(data) <= limit)
    return data.decode("ascii","strict")
def identity(row, user, group):
    pid = row["pid"]
    need(type(pid) is int and pid > 1)
    text = proc_text(pid,"stat",8192)
    fields = text[text.rindex(")") + 2:].split()
    status = dict(line.split(":",1) for line in proc_text(pid,"status").splitlines() if ":" in line)
    need(len(fields) >= 20 and fields[19] == row["start"] and fields[0] not in ("Z","X","x") and
         status["Pid"].split() == [str(pid)] and status["Uid"].split() == [str(user)] * 4 and
         status["Gid"].split() == [str(group)] * 4)
def endpoint(public):
    secure(public["directory"],0o755,True)
    item = os.lstat(public["socket"])
    need(os.path.realpath(public["socket"]) == public["socket"] and stat.S_ISSOCK(item.st_mode) and
         item.st_uid == 0 and item.st_gid == gid and stat.S_IMODE(item.st_mode) == 0o660 and
         item.st_dev == public["socketIdentity"]["device"] and item.st_ino == public["socketIdentity"]["inode"])
def live(public, mask_sources):
    descriptors = []
    try:
        # Pin first. Reused PID paths cannot pass the final poll of the original process identity.
        for row in (public["keeper"],public["broker"]): descriptors.append(os.pidfd_open(row["pid"],0))
        identity(public["keeper"],uid,gid); identity(public["broker"],0,0)
        namespace_fds = {}
        try:
            kinds = {"user":0x10000000,"mnt":0x00020000,"pid":0x20000000}
            for kind, number in kinds.items():
                fd = os.open(f"/proc/{public['keeper']['pid']}/ns/{kind}",os.O_RDONLY | os.O_CLOEXEC)
                namespace_fds[kind] = fd
                info = os.fstat(fd)
                need(info.st_dev == public["devices"][kind] and info.st_ino == public["namespaces"][kind] and
                     fcntl.ioctl(fd,0xB703) == number)
            owner = array.array("I",[0]); fcntl.ioctl(namespace_fds["user"],0xB704,owner,True)
            need(owner[0] == uid)
            for kind in ("mnt","pid"):
                owner_fd = fcntl.ioctl(namespace_fds[kind],0xB701)
                try: need(os.fstat(owner_fd).st_ino == public["namespaces"]["user"])
                finally: os.close(owner_fd)
            need(proc_text(public["keeper"]["pid"],"uid_map").split() == ["0",str(uid),"1"] and
                 proc_text(public["keeper"]["pid"],"gid_map").split() == ["0",str(gid),"1"])
            endpoint(public)
            probe = subprocess.run([python,"-I","-S","-B","-c",CLIENT,asset_sha],input=json.dumps({"public":public,"maskSources":mask_sources}).encode("ascii"),
                                   stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,check=True,timeout=3,
                                   env=ENV,close_fds=True)
            need(len(probe.stdout) <= 4096)
            proof = json.loads(probe.stdout.decode("ascii","strict"))
            need(type(proof) is dict and set(proof) == {"v","event","nonce","masks","protectedMountTargets"} and
                 proof["v"] == 1 and proof["event"] == "broker-live" and proof["nonce"] == public["nonce"] and
                 proof["masks"] is True and type(proof["protectedMountTargets"]) is list and
                 len(proof["protectedMountTargets"]) <= 64)
            endpoint(public)
            identity(public["keeper"],uid,gid); identity(public["broker"],0,0)
            for fd in descriptors:
                poll = select.poll(); poll.register(fd,select.POLLIN); need(not poll.poll(0))
            return {"keeper":True,"broker":True,"namespaces":True,"socket":True,"admission":True,"masks":True,
                    "protectedMountTargets":proof["protectedMountTargets"]}
        finally:
            for fd in namespace_fds.values(): os.close(fd)
    finally:
        for fd in descriptors: os.close(fd)
need(os.geteuid() == 0 and sys.version_info >= (3,12) and len(sys.argv) == 8)
operation, uid, gid, container, nonce, asset_sha, profile_sha = sys.argv[1:]
uid, gid = int(uid), int(gid)
need(operation in ("install","prepare","inspect","cleanup") and 0 < uid <= 2147483647 and 0 < gid <= 2147483647)
need(container in ("/mnt/vector-agent-sandbox","/var/lib/vector-agent-sandbox","/home/vector-agent-sandbox"))
need(len(nonce) == 32 and len(asset_sha) == len(profile_sha) == 64 and
     all(c in "0123456789abcdef" for c in nonce + asset_sha + profile_sha))
need(sha(PROFILE.encode("utf-8")) == profile_sha)
for parent in ("/","/usr","/usr/libexec","/etc","/etc/apparmor.d"): secure(parent,0o755,True)
python = executable("/usr/bin/python3")
parser = executable("/usr/sbin/apparmor_parser")
expected = {"v":1,"uid":uid,"gid":gid,"container":container,"nonce":nonce,"assetSHA":asset_sha,"profileSHA":profile_sha}
if operation == "install":
    data = sys.stdin.buffer.read(262145)
    need(len(data) <= 262144)
    asset = json.loads(data.decode("utf-8","strict"))
    need(set(asset) == {"v","entry","sha256"} and type(asset["v"]) is int and asset["v"] == 1)
    code = asset["entry"].encode("utf-8","strict")
    need(0 < len(code) <= 131072 and sha(code) == asset["sha256"] == asset_sha)
    need(not os.path.lexists(BASE) and not os.path.lexists(POLICY) and not loaded())
    os.mkdir(BASE,0o755); os.chmod(BASE,0o755)
    os.mkdir(ROOT,0o755); os.chmod(ROOT,0o755)
    os.mkdir(PRIVATE,0o700); os.chmod(PRIVATE,0o700)
    write(LOCK,b"",0o600)
    record({**expected,"phase":"files"},True)
    write(ENTRY,code,0o444)
    write(POLICY,PROFILE.encode("utf-8"),0o444)
secure(BASE,0o755,True); secure(ROOT,0o755,True); secure(PRIVATE,0o700,True)
lock = os.open(LOCK,os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC | os.O_NONBLOCK)
try:
    info = os.fstat(lock)
    need(stat.S_ISREG(info.st_mode) and info.st_uid == info.st_gid == 0 and info.st_nlink == 1 and
         stat.S_IMODE(info.st_mode) == 0o600)
    fcntl.flock(lock,fcntl.LOCK_EX | fcntl.LOCK_NB)
    installation = json.loads(read(INSTALL,0o600,4096).decode("ascii","strict"))
    need(set(installation) == set(expected) | {"phase"} and all(installation[key] == item for key,item in expected.items()))
    need(sha(read(ENTRY,0o444,131072)) == asset_sha and sha(read(POLICY,0o444,4096)) == profile_sha)
    if operation == "install":
        need(installation["phase"] == "files" and not loaded())
        subprocess.run([parser,"--add",POLICY],check=True,timeout=5,env=ENV,
                       stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,close_fds=True)
        need(loaded() == ["vector-sandbox-v1 (enforce)"])
        installation["phase"] = "installed"; record(installation)
        print(json.dumps({"v":1,"event":"installed","installNonce":nonce,"assetSHA":asset_sha,"profileSHA":profile_sha}),flush=True)
    else:
        need(loaded() == ["vector-sandbox-v1 (enforce)"])
        if operation == "prepare":
            need(installation["phase"] == "installed")
            installation["phase"] = "preparing"; record(installation)
            # The trusted setup child retains this secret-free lifetime lock if its controller dies. Its own
            # keeper/broker close_fds/pass_fds omit the lock, so cleanup cannot overtake still-running setup.
            subprocess.run([python,"-I","-S",ENTRY,"prepare",str(uid),str(gid),container],
                           check=True,timeout=45,env=ENV,stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,
                           stderr=subprocess.DEVNULL,close_fds=True,pass_fds=(lock,))
        value = native_state()
        if operation in ("prepare","inspect"):
            need(installation["phase"] == ("preparing" if operation == "prepare" else "ready") and
                 value["phase"] == "adopted" and value["brokerPending"] is False)
            public = json.loads(read(ROOT + "/run.json",0o444,65536).decode("utf-8","strict"))
            need(public == value["public"])
            proof = live(public, value["maskSources"])
            if operation == "prepare": installation["phase"] = "ready"; record(installation)
            print(json.dumps({"v":1,"event":"ready","installNonce":nonce,"assetSHA":asset_sha,"public":public,
                              "live":proof}),flush=True)
        else:
            need(installation["phase"] in ("preparing","ready"))
            result = subprocess.run([python,"-I","-S",ENTRY,"cleanup"],check=True,timeout=15,env=ENV,
                                    stdin=subprocess.DEVNULL,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,
                                    close_fds=True,pass_fds=(lock,))
            need(len(result.stdout) <= 4096)
            receipt = json.loads(result.stdout.decode("ascii","strict"))
            need(receipt == {"v":1,"event":"isolation-stopped","uidStoppedBeforeBroker":True,
                             "brokerStopped":True,"nonce":value["public"]["nonce"]})
            after = native_state()
            need(after["phase"] == "broker-stopped" and after["public"] == value["public"] and
                 not os.path.lexists(ROOT + "/run.json"))
            installation["phase"] = "stopped"; record(installation)
            print(json.dumps({"v":1,"event":"stopped","installNonce":nonce,"assetSHA":asset_sha,
                              "namespaceNonce":receipt["nonce"],"uidStoppedBeforeBroker":True,"brokerStopped":True}),flush=True)
finally: os.close(lock)
`

export function enabled() {
  return GithubIsolationBuild.enabled
}

/** Only trusted runner code constructs this port. It is never a request/configuration JSON service. */
export function create(ports: Ports) {
  LinuxIsolation.hostedTemporary(ports.temporary)
  exact(ports.asset, ["v", "entry", "sha256"])
  if (ports.asset.v !== 1 || typeof ports.asset.entry !== "string" || !ports.asset.entry.isWellFormed()) refused()
  hex(ports.asset.sha256, 64)
  if (
    !ports.asset.entry ||
    Buffer.byteLength(ports.asset.entry) > 131_072 ||
    digest(ports.asset.entry) !== ports.asset.sha256
  )
    refused()
  // Freeze a copy: a dependency cannot retarget the next root invocation after intent was persisted.
  const asset = Object.freeze({ ...ports.asset })
  async function metadata(name: string, mode: number, kind: Metadata["kind"], sha256?: string) {
    const item = await ports.inspect(name)
    if (
      !item ||
      item.canonical !== name ||
      item.kind !== kind ||
      item.uid !== 0 ||
      item.gid !== 0 ||
      item.mode !== mode
    )
      refused()
    if (kind === "file" && (item.nlink !== 1 || item.sha256 !== sha256)) refused()
  }
  async function parents() {
    for (const name of PARENTS) await metadata(name, 0o755, "directory")
  }
  async function installed() {
    await parents()
    await metadata(BASE, 0o755, "directory")
    await metadata(LinuxIsolation.ROOT, 0o755, "directory")
    await metadata(`${LinuxIsolation.ROOT}/private`, 0o700, "directory")
    await metadata(LinuxIsolation.ENTRY, 0o444, "file", asset.sha256)
    await metadata(PROFILE_PATH, 0o444, "file", PROFILE_SHA)
  }
  function matching(input: State) {
    const state = parseState(input)
    if (state.assetSHA !== asset.sha256) refused()
    return state
  }
  async function invoke(operation: "install" | "prepare" | "inspect" | "cleanup", state: State) {
    const output = await ports.execute({
      file: "/usr/bin/sudo",
      args: Object.freeze([
        "-n",
        LinuxIsolation.PYTHON,
        "-I",
        "-S",
        "-c",
        CONTROL,
        operation,
        String(state.uid),
        String(state.gid),
        state.container,
        state.installNonce,
        state.assetSHA,
        PROFILE_SHA,
      ]),
      input: operation === "install" ? JSON.stringify(asset) : "",
      timeout: operation === "prepare" ? 50_000 : operation === "cleanup" ? 20_000 : 10_000,
      maxOutput: 65_536,
      env: Object.freeze({ PATH: "/usr/bin:/bin", LC_ALL: "C" }),
    })
    if (typeof output !== "string" || Buffer.byteLength(output) > 65_536) refused()
    const result: unknown = JSON.parse(output)
    return result
  }
  function ready(result: unknown, state: State) {
    exact(result, ["v", "event", "installNonce", "assetSHA", "public", "live"])
    if (
      result.v !== 1 ||
      result.event !== "ready" ||
      result.installNonce !== state.installNonce ||
      result.assetSHA !== state.assetSHA
    )
      refused()
    exact(result.live, ["keeper", "broker", "namespaces", "socket", "admission", "masks", "protectedMountTargets"])
    for (const key of ["keeper", "broker", "namespaces", "socket", "admission", "masks"])
      if (result.live[key] !== true) refused()
    LinuxIsolation.assertMaskMountTargets(result.live.protectedMountTargets)
    const spec = LinuxIsolation.parseSpec(result.public)
    if (
      spec.container !== state.container ||
      spec.uid !== state.uid ||
      spec.gid !== state.gid ||
      (state.phase === "ready" && spec.nonce !== state.namespaceNonce)
    )
      refused()
    return parseState({ ...state, phase: "ready", namespaceNonce: spec.nonce })
  }
  return Object.freeze({
    intent(input: Scope) {
      scope(input)
      return parseState({
        v: 1,
        phase: "intent",
        container: input.container,
        uid: input.uid,
        gid: input.gid,
        installNonce: ports.nonce(),
        assetSHA: asset.sha256,
      })
    },
    async prepare(input: State) {
      const state = matching(input)
      if (state.phase !== "intent") refused()
      await parents()
      const result = await invoke("install", state)
      exact(result, ["v", "event", "installNonce", "assetSHA", "profileSHA"])
      if (
        result.v !== 1 ||
        result.event !== "installed" ||
        result.installNonce !== state.installNonce ||
        result.assetSHA !== asset.sha256 ||
        result.profileSHA !== PROFILE_SHA
      )
        refused()
      await installed()
      return ready(await invoke("prepare", state), state)
    },
    async validate(input: State) {
      const state = matching(input)
      if (state.phase !== "ready") refused()
      await installed()
      return ready(await invoke("inspect", state), state)
    },
    async cleanup(input: State) {
      const state = matching(input)
      await installed()
      const result = await invoke("cleanup", state)
      exact(result, [
        "v",
        "event",
        "installNonce",
        "assetSHA",
        "namespaceNonce",
        "uidStoppedBeforeBroker",
        "brokerStopped",
      ])
      if (
        result.v !== 1 ||
        result.event !== "stopped" ||
        result.installNonce !== state.installNonce ||
        result.assetSHA !== asset.sha256 ||
        result.uidStoppedBeforeBroker !== true ||
        result.brokerStopped !== true
      )
        refused()
      hex(result.namespaceNonce, 32)
      if (state.phase === "ready" && result.namespaceNonce !== state.namespaceNonce) refused()
      return Object.freeze({ artifactsAllowed: state.phase === "ready", namespaceNonce: result.namespaceNonce })
    },
  })
}
export type Adapter = ReturnType<typeof create>

async function inspect(name: string): Promise<Metadata | undefined> {
  const item = await fs.lstat(name).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined
    throw new Error(REFUSAL)
  })
  if (!item) return
  const canonical = await fs.realpath(name)
  const base = { uid: item.uid, gid: item.gid, mode: item.mode & 0o7777, canonical, nlink: item.nlink }
  if (item.isSymbolicLink()) return { ...base, kind: "other" }
  if (item.isDirectory()) return { ...base, kind: "directory" }
  if (!item.isFile() || ![LinuxIsolation.ENTRY, PROFILE_PATH].includes(name)) return { ...base, kind: "other" }
  const file = await fs.open(name, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const pinned = await file.stat()
    if (!pinned.isFile() || pinned.dev !== item.dev || pinned.ino !== item.ino || pinned.size > 131_072) refused()
    const bytes = Buffer.alloc(131_073)
    const result = await file.read(bytes, 0, bytes.length, 0)
    if (result.bytesRead !== pinned.size || result.bytesRead > 131_072) refused()
    const after = await file.stat()
    if (
      after.size !== pinned.size ||
      after.mode !== pinned.mode ||
      after.uid !== pinned.uid ||
      after.gid !== pinned.gid ||
      after.nlink !== pinned.nlink ||
      after.mtimeMs !== pinned.mtimeMs ||
      after.ctimeMs !== pinned.ctimeMs
    )
      refused()
    return { ...base, kind: "file", sha256: digest(bytes.subarray(0, result.bytesRead)) }
  } finally {
    await file.close()
  }
}

function execute(invocation: Invocation): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(invocation.file, [...invocation.args], { env: invocation.env, stdio: ["pipe", "pipe", "pipe"] })
    const output: Buffer[] = []
    let size = 0
    let failed = false
    const fail = () => {
      if (failed) return
      failed = true
      clearTimeout(timer)
      child.kill("SIGKILL")
      child.stdin.destroy()
      child.stdout.destroy()
      child.stderr.destroy()
      reject(new Error(REFUSAL))
    }
    const timer = setTimeout(fail, invocation.timeout)
    child.stdout.on("data", (chunk: Buffer) => {
      size += chunk.length
      if (size > invocation.maxOutput) {
        fail()
        return
      }
      output.push(chunk)
    })
    // Root/native diagnostics are intentionally never forwarded: only bounded fixed receipts leave this port.
    child.stderr.on("data", (chunk: Buffer) => {
      size += chunk.length
      if (size > invocation.maxOutput) fail()
    })
    child.on("error", fail)
    child.stdin.on("error", fail)
    child.on("close", (code) => {
      clearTimeout(timer)
      if (failed || code !== 0) {
        reject(new Error(REFUSAL))
        return
      }
      try {
        resolve(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(output)))
      } catch {
        reject(new Error(REFUSAL))
      }
    })
    child.stdin.end(invocation.input)
  })
}

/** Compile-time CI selection only. True + absent/bad bytes refuses; it never selects the legacy tool path. */
export function fromBuild(temporary: string | undefined): Adapter {
  if (!enabled() || GithubIsolationBuild.asset === undefined) refused()
  return create({
    asset: GithubIsolationBuild.asset,
    temporary: LinuxIsolation.hostedTemporary(temporary),
    inspect,
    execute,
    nonce: () => randomBytes(16).toString("hex"),
  })
}

export * as GithubIsolation from "./github.isolation"
