import fs from "node:fs/promises"
import { spawn, execFile } from "node:child_process"
import { promisify } from "node:util"
import { randomBytes } from "node:crypto"
import { setTimeout } from "node:timers/promises"
import { LinuxIsolation } from "@vectordevai/core/process-isolation/linux"
import { ProcessIsolation } from "@vectordevai/core/process-isolation"
import {
  HOST,
  ENGINE,
  MANIFEST,
  PREFIX,
  CASES,
  ARTIFACT,
  CANARY_ROOTS,
  need,
  exact,
  digest,
  decodeManifest,
  rootFile,
  verifyAssets,
  boundedFile,
  json,
} from "./native-shell-payload"

const execute = promisify(execFile)
const ENV = { PATH: "/usr/bin:/bin", LC_ALL: "C" }

// Fixed CI-only Root metadata observer. No caller-selected path, executable, source, signal or file contents.
// Actual invocation is held behind Root's independent CPython installed-profile/startup qualification gate.
const OBSERVE = String.raw`
import errno, fcntl, json, os, pathlib, select, signal, stat, sys
ROOT='/usr/libexec/vector-native-shell'
MASKS=('/home/vector-agent','/tmp','/var/tmp','/run','/home/runner/work/_temp')
CANARIES=MASKS+('/home/vector-agent/.config/vector','/home/vector-agent/.local/share/vector','/home/vector-agent/.cache/vector','/home/vector-agent/tmp/vector-agent')
CASES=('engine','inspect','nonzero','timeout','abort','shell-pipeline','stdio','delayed','pipeline','fd-source','fd-dest','death')
def need(ok):
    if not ok: raise RuntimeError('Fixed Shell observer refused')
def regular(name,owner,limit,directory=None):
    fd=os.open(name,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK|os.O_CLOEXEC,dir_fd=directory)
    try:
        before=os.fstat(fd)
        need(stat.S_ISREG(before.st_mode) and before.st_uid==owner and before.st_nlink==1 and before.st_size<=limit)
        data=os.read(fd,limit+1); after=os.fstat(fd)
        need(len(data)==before.st_size and len(data)<=limit and
             (before.st_dev,before.st_ino,before.st_mtime_ns,before.st_ctime_ns,before.st_uid,before.st_mode)==
             (after.st_dev,after.st_ino,after.st_mtime_ns,after.st_ctime_ns,after.st_uid,after.st_mode))
        return data
    finally: os.close(fd)
def text(pid,name,limit=65536):
    with open(f'/proc/{pid}/{name}','rb') as stream: data=stream.read(limit+1)
    need(len(data)<=limit)
    return data.decode('utf-8','strict')
def file_id(info): return {'device':str(info.st_dev),'inode':str(info.st_ino)}
def departed(pin):
    poll=select.poll(); poll.register(pin,select.POLLIN)
    events=poll.poll(0)
    need(all(fd==pin and not mask&~(select.POLLIN|select.POLLHUP) for fd,mask in events))
    return any(mask&(select.POLLIN|select.POLLHUP) for fd,mask in events)
need(os.geteuid()==0 and len(sys.argv)>=3)
operation,nonce=sys.argv[1:3]
manifest=json.loads(regular(ROOT+'/manifest.json',0,16384))
spec=json.loads(regular('/usr/libexec/vector-sandbox/v1/run.json',0,65536))
need(manifest['nonce']==nonce==spec['nonce'] and spec['container'] in
     ('/mnt/vector-agent-sandbox','/var/lib/vector-agent-sandbox','/home/vector-agent-sandbox'))
uid,gid=spec['uid'],spec['gid']; observer=spec['container']+'/native-shell-observer'
need(type(uid) is int and uid>0 and type(gid) is int and gid>0 and manifest['observer']==observer)
item=os.lstat(observer)
need(stat.S_ISDIR(item.st_mode) and item.st_uid==item.st_gid==0 and not item.st_mode&0o022 and os.path.realpath(observer)==observer)
def member(pid,full=False,expected=uid):
    pin=None; descriptors=[]
    try:
        pin=os.pidfd_open(pid,0)
        raw=text(pid,'stat',8192); fields=raw[raw.rindex(')')+2:].split()
        values=dict(line.split(':',1) for line in text(pid,'status').splitlines() if ':' in line)
        users=[int(x) for x in values['Uid'].split()]; groups=[int(x) for x in values['Gid'].split()]
        if expected not in users: return None
        need(users==[expected]*4 and len(groups)==4 and len(set(groups))==1 and fields[19].isdigit())
        if fields[0] in ('Z','X','x'):
            need(departed(pin)); return None
        namespaces={}
        for name,kind in (('user',0x10000000),('mnt',0x00020000),('pid',0x20000000)):
            fd=os.open(f'/proc/{pid}/ns/{name}',os.O_RDONLY|os.O_CLOEXEC); descriptors.append(fd)
            need(fcntl.ioctl(fd,0xB703)==kind)
            namespaces[name]=file_id(os.fstat(fd))
        value={'pid':pid,'start':fields[19],'uid':expected,'gid':groups[0],'group':int(fields[2]),
               'nspid':[int(x) for x in values['NSpid'].split()], 'namespaces':namespaces,
               'uidMap':[int(x) for x in text(pid,'uid_map',4096).split()],
               'gidMap':[int(x) for x in text(pid,'gid_map',4096).split()],
               'groups':[int(x) for x in values['Groups'].split()],
               'capabilities':{k:values[k].strip() for k in ('CapInh','CapPrm','CapEff','CapBnd','CapAmb')},
               'nnp':int(values['NoNewPrivs'].strip())}
        if full:
            fds=[]
            names=os.listdir(f'/proc/{pid}/fd'); need(len(names)<=256)
            for name in names:
                need(name.isdigit())
                try:
                    info=os.stat(f'/proc/{pid}/fd/{name}')
                    fds.append({'fd':int(name),**file_id(info),'kind':'file' if stat.S_ISREG(info.st_mode) else 'directory' if stat.S_ISDIR(info.st_mode) else 'other'})
                except FileNotFoundError: pass
            value['fds']=fds
            mounts=[]
            for target in MASKS:
                fd=os.open(f'/proc/{pid}/root'+target,os.O_RDONLY|os.O_DIRECTORY|os.O_CLOEXEC); descriptors.append(fd)
                info=os.fstat(fd)
                mounts.append({'path':target,**file_id(info),'uid':info.st_uid,'gid':info.st_gid,
                               'mode':stat.S_IMODE(info.st_mode),'readonly':bool(os.fstatvfs(fd).f_flag&os.ST_RDONLY),
                               'empty':len(os.listdir(fd))==0})
            value['masks']=mounts
            image=os.open(f'/proc/{pid}/exe',os.O_PATH|os.O_CLOEXEC); descriptors.append(image)
            value['executable']={**file_id(os.fstat(image)),'readonly':bool(os.fstatvfs(image).f_flag&os.ST_RDONLY)}
        after=text(pid,'stat',8192); after=after[after.rindex(')')+2:].split()
        again=dict(line.split(':',1) for line in text(pid,'status').splitlines() if ':' in line)
        if departed(pin): return None
        need(after[19]==fields[19] and after[0] not in ('Z','X','x') and [int(x) for x in again['Uid'].split()]==users)
        return value
    except (FileNotFoundError,ProcessLookupError): return None
    except (ValueError,KeyError,IndexError):
        # proc can return empty/truncated bytes after open when an unrelated task exits. Only this exact
        # pinned process's terminal poll authorizes ignoring that parse race; live malformed data still fails.
        if pin is not None and departed(pin): return None
        raise
    finally:
        for fd in descriptors: os.close(fd)
        if pin is not None: os.close(pin)
def engine():
    return json.loads(regular(observer+'/engine.json',0,4096))
def alive_engine():
    saved=engine(); value=member(saved['pid'])
    need(value and value['start']==saved['start'])
    return value
if operation=='controls':
    need(len(sys.argv)==3)
    os.setgroups([]); os.setresgid(gid,gid,gid); os.setresuid(uid,uid,uid)
    for parent in CANARIES:
        fd=os.open(parent+'/native-shell-canary-'+nonce,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK|os.O_CLOEXEC)
        try:
            info=os.fstat(fd)
            need(stat.S_ISREG(info.st_mode) and info.st_nlink==1 and 0<info.st_size<=128)
            need(os.read(fd,129)==b'native-shell-synthetic-canary\n')
        finally: os.close(fd)
    fd=os.open(ROOT+'/readonly-control.txt',os.O_WRONLY|os.O_APPEND|os.O_NOFOLLOW|os.O_NONBLOCK|os.O_CLOEXEC)
    os.close(fd)
    result={'readableCanaries':len(CANARIES),'dacWritableControl':True}
elif operation=='register':
    need(len(sys.argv)==4 and sys.argv[3].isdigit())
    value=member(int(sys.argv[3]),True); need(value)
    args=text(value['pid'],'cmdline',16384).split(chr(0))
    need(ROOT+'/engine.mjs' in args)
    expected=os.stat(manifest['runtimePath']); actual=os.stat(f"/proc/{value['pid']}/exe")
    need((actual.st_dev,actual.st_ino)==(expected.st_dev,expected.st_ino))
    need(os.listdir(f"/proc/{value['pid']}/root/proc")==[])
    fd=os.open(observer+'/engine.json',os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW|os.O_CLOEXEC,0o444)
    try: os.write(fd,json.dumps({'pid':value['pid'],'start':value['start']}).encode('ascii'))
    finally: os.close(fd)
    result=value
elif operation in ('control','kill-engine'):
    need(len(sys.argv)==3); value=alive_engine(); pin=os.pidfd_open(value['pid'],0)
    try:
        again=member(value['pid']); need(again and again['start']==value['start'])
        signal.pidfd_send_signal(pin,signal.SIGUSR2 if operation=='control' else signal.SIGKILL)
    finally: os.close(pin)
    result={'sent':True,'pid':value['pid'],'start':value['start']}
elif operation=='snapshot':
    need(len(sys.argv)==3)
    result=[value for name in os.listdir('/proc') if name.isdigit() and (value:=member(int(name))) is not None]
    need(len(result)<=64)
    broker=member(spec['broker']['pid'],expected=0)
    need(broker and broker['start']==spec['broker']['start'])
elif operation=='inspect':
    need(len(sys.argv)==5 and sys.argv[3].isdigit() and sys.argv[4].isdigit())
    result=member(int(sys.argv[3]),True); need(result and result['start']==sys.argv[4])
elif operation=='ack':
    need(len(sys.argv)==5 and sys.argv[3] in CASES and sys.argv[4] in ('baseline','release','abort','stopped','summary'))
    parent=os.open(observer,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW|os.O_CLOEXEC)
    try:
        fd=os.open(sys.argv[3]+'-'+sys.argv[4]+'.ack',os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW|os.O_CLOEXEC,0o444,dir_fd=parent)
        os.close(fd)
    finally: os.close(parent)
    result={'ack':True}
elif operation in ('hints','counters'):
    need(len(sys.argv)==4 and sys.argv[3] in CASES)
    directory=spec['stage']+'/.native-shell-'+nonce
    fd=os.open(directory,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW|os.O_CLOEXEC)
    try:
        info=os.fstat(fd); need(info.st_uid==uid and info.st_gid==gid and stat.S_IMODE(info.st_mode)==0o700)
        names=os.listdir(fd); need(len(names)<=64)
        suffix='.json' if operation=='hints' else '.count'
        chosen=[name for name in names if name.startswith(sys.argv[3]+'-') and name.endswith(suffix)]
        need(len(chosen)<=4)
        data=[regular(name,uid,4096,fd) for name in chosen]
        if operation=='hints': result=[json.loads(value) for value in data]
        else:
            need(all(value==b'1\n' for value in data)); result=chosen
    finally: os.close(fd)
else: raise RuntimeError('Unknown fixed observer operation')
output=json.dumps(result,separators=(',',':')).encode('ascii')
need(len(output)<=262144); os.write(1,output)
`

type Identity = {
  pid: number
  start: string
  uid: number
  gid: number
  group: number
  nspid: number[]
  namespaces: Record<"user" | "mnt" | "pid", { device: string; inode: string }>
  uidMap: number[]
  gidMap: number[]
  groups: number[]
  capabilities: Record<string, string>
  nnp: number
}
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}
function identity(value: unknown): Identity {
  need(record(value))
  const row: Record<string, unknown> = value
  need(
    typeof row.pid === "number" &&
      Number.isSafeInteger(row.pid) &&
      row.pid > 1 &&
      typeof row.start === "string" &&
      /^[0-9]{1,32}$/.test(row.start),
  )
  for (const name of ["uid", "gid", "group", "nnp"])
    need(typeof row[name] === "number" && Number.isSafeInteger(row[name]))
  const numbers = (v: unknown) => {
    need(Array.isArray(v) && v.every((x) => typeof x === "number" && Number.isSafeInteger(x)))
    return v
  }
  exact(row.namespaces, ["user", "mnt", "pid"])
  const namespace = (v: unknown) => {
    exact(v, ["device", "inode"])
    need(
      typeof v.device === "string" &&
        typeof v.inode === "string" &&
        /^[0-9]+$/.test(v.device) &&
        /^[0-9]+$/.test(v.inode),
    )
    return { device: v.device, inode: v.inode }
  }
  need(row.capabilities !== null && typeof row.capabilities === "object" && !Array.isArray(row.capabilities))
  exact(row.capabilities, ["CapInh", "CapPrm", "CapEff", "CapBnd", "CapAmb"])
  const capabilities: Record<string, string> = {}
  for (const [name, item] of Object.entries(row.capabilities)) {
    need(typeof item === "string" && /^[a-f0-9]+$/.test(item))
    capabilities[name] = item
  }
  need(
    typeof row.uid === "number" &&
      typeof row.gid === "number" &&
      typeof row.group === "number" &&
      typeof row.nnp === "number",
  )
  return {
    pid: row.pid,
    start: row.start,
    uid: row.uid,
    gid: row.gid,
    group: row.group,
    nnp: row.nnp,
    nspid: numbers(row.nspid),
    uidMap: numbers(row.uidMap),
    gidMap: numbers(row.gidMap),
    groups: numbers(row.groups),
    capabilities,
    namespaces: {
      user: namespace(row.namespaces.user),
      mnt: namespace(row.namespaces.mnt),
      pid: namespace(row.namespaces.pid),
    },
  }
}
const same = (a: Identity, b: Identity) => a.pid === b.pid && a.start === b.start && a.uid === b.uid

async function configuration() {
  need(process.platform === "linux" && ProcessIsolation.nativeBuild().enabled)
  const manifest = decodeManifest(json(await rootFile(MANIFEST, 16_384)))
  const spec = LinuxIsolation.decodeSpec(await rootFile(LinuxIsolation.SPEC, 65_536))
  need(manifest.nonce === spec.nonce && manifest.observer === spec.container + "/native-shell-observer")
  need((await fs.realpath(process.execPath)) === "/usr/libexec/vector-native-shell/runtime/node")
  await verifyAssets(manifest)
  return { manifest, spec }
}

async function driver() {
  const { manifest } = await configuration()
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of process.stdin) {
    const block = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += block.length
    need(size <= 131_072)
    chunks.push(block)
  }
  const value = json(Buffer.concat(chunks))
  need(record(value))
  const channel: Record<string, unknown> = value
  need(typeof channel.githubToken === "string")
  const env: Record<string, string | undefined> = {
    ...process.env,
    GITHUB_TOKEN: channel.githubToken,
    VECTOR_MODE: manifest.mode,
  }
  const { GithubSecrets } = await import("../../src/cli/cmd/github.secrets")
  if (manifest.mode === "codium") {
    exact(channel, ["v", "githubToken", "runToken", "keys"])
    need(typeof channel.runToken === "string")
    await GithubSecrets.writeRunToken(channel.runToken, env)
  } else {
    exact(channel, ["v", "githubToken", "cliToken", "keys"])
    exact(channel.keys, ["DEEPSEEK_KEY"])
    need(typeof channel.cliToken === "string" && typeof channel.keys.DEEPSEEK_KEY === "string")
    env.VECTOR_CLI_TOKEN = channel.cliToken
    env.VECTOR_SECRET_ENV_NAMES = "DEEPSEEK_KEY"
    env.DEEPSEEK_KEY = channel.keys.DEEPSEEK_KEY
  }
  const { run } = await import("../../src/cli/cmd/github.sandbox")
  // Actual production capture/clean-env/holder wrapper; secrets exist in this JS object and stdin only.
  const code = await run([manifest.runtimePath, ENGINE], env)
  process.stdout.write(PREFIX + JSON.stringify({ v: 1, event: "driver-exit", nonce: manifest.nonce, code }) + "\n")
  process.exitCode = code
}

async function main() {
  const { manifest, spec } = await configuration()
  need(
    process.env.GITHUB_ACTIONS === "true" &&
      process.env.RUNNER_ENVIRONMENT === "github-hosted" &&
      process.env.VECTOR_AGENT_SUDO !== "1" &&
      process.env.RUNNER_TEMP === LinuxIsolation.HOST_TEMP &&
      process.env.VECTOR_MODE === manifest.mode,
  )
  const runtime = await fs.realpath(process.execPath)
  const hostRuntime = await fs.lstat(runtime)
  need(hostRuntime.isFile() && hostRuntime.uid === 0 && hostRuntime.gid === 0 && !(hostRuntime.mode & 0o022))
  const root = async (operation: string, ...args: string[]): Promise<unknown> => {
    need(
      ["controls", "register", "control", "kill-engine", "snapshot", "inspect", "ack", "hints", "counters"].includes(
        operation,
      ),
    )
    const result = await execute(
      "/usr/bin/sudo",
      ["-n", "/usr/bin/python3", "-I", "-S", "-B", "-c", OBSERVE, operation, manifest.nonce, ...args],
      { env: ENV, timeout: 5_000, maxBuffer: 262_144 },
    )
    return json(Buffer.from(result.stdout))
  }
  const snapshot = async () => {
    const values = await root("snapshot")
    need(Array.isArray(values))
    return values.map(identity)
  }
  const controls = await root("controls")
  exact(controls, ["readableCanaries", "dacWritableControl"])
  need(controls.readableCanaries === CANARY_ROOTS.length && controls.dacWritableControl === true)
  const ack = async (name: string, phase: string) => {
    await root("ack", name, phase)
  }
  const random = () => randomBytes(32).toString("base64url")
  const channel = {
    v: 1,
    githubToken: "synthetic_" + random(),
    ...(manifest.mode === "codium"
      ? { runToken: `vrt_${random()}.${random()}` }
      : { cliToken: `vct_${random()}.${random()}` }),
    keys: manifest.mode === "codium" ? {} : { DEEPSEEK_KEY: "synthetic_" + random() },
  }
  const secrets = Object.values(channel).flatMap((value) =>
    typeof value === "string"
      ? [value]
      : value !== null && typeof value === "object"
        ? Object.values(value).filter((item): item is string => typeof item === "string")
        : [],
  )
  const clean: Record<string, string> = {}
  for (const name of [
    "GITHUB_ACTIONS",
    "RUNNER_ENVIRONMENT",
    "RUNNER_TEMP",
    "GITHUB_WORKSPACE",
    "GITHUB_EVENT_PATH",
    "VECTOR_MODE",
    "PATH",
    "HOME",
  ])
    if (process.env[name] !== undefined) clean[name] = process.env[name]!
  const child = spawn(runtime, [HOST, "driver"], { env: clean, stdio: ["pipe", "pipe", "pipe"] })
  need(child.stdin && child.stdout && child.stderr)
  child.stdin.end(JSON.stringify(channel) + "\n")
  let pending = ""
  let tail = ""
  let bytes = 0
  let protocolError: unknown
  let engine: Identity | undefined
  let baseline: Identity[] | undefined
  let current: string | undefined
  let originalMasks: Record<string, { device: string; inode: string }> | undefined
  let heldFile: { device: string; inode: string } | undefined
  let proofIdentity: { device: string; inode: string } | undefined
  let summary = false
  let driverExit: number | undefined
  let control = false
  let deathSent = false
  let rounds = 0
  const report: Array<Record<string, unknown>> = []
  const expected = manifest.family === "engine-death" ? ["death"] : [...CASES]
  const modes = (name: string) =>
    name.startsWith("fd-")
      ? []
      : name === "pipeline" || name === "shell-pipeline"
        ? ["pipe-source", "pipe-sink"]
        : ["timeout", "abort", "death"].includes(name)
          ? [name, "daemon"]
          : [name]
  const verifyCounters = async (name: string) => {
    const count = await root("counters", name)
    need(Array.isArray(count) && count.every((value) => typeof value === "string"))
    need(
      JSON.stringify(count.toSorted()) ===
        JSON.stringify(
          modes(name)
            .map((mode) => `${name}-${mode}.count`)
            .toSorted(),
        ),
    )
    return count.length
  }
  const stopped = async (allowDeadEngine = false) => {
    need(baseline && engine)
    const deadline = Date.now() + 5_000
    while (true) {
      const now = await snapshot()
      const retained = baseline.filter((row) => !allowDeadEngine || !same(row, engine!))
      need(
        retained.every((row) => now.some((item) => same(row, item))),
        "A retained keeper/baseline process disappeared",
      )
      const extras = now.filter((row) => !baseline!.some((item) => same(row, item)))
      if (extras.length === 0 && (!allowDeadEngine || !now.some((row) => same(row, engine!)))) return
      need(Date.now() < deadline, "A scoped identity survived before UID sweep")
      await setTimeout(10)
    }
  }
  const observed = async (name: string) => {
    const wanted = ["timeout", "abort", "death", "pipeline", "shell-pipeline"].includes(name) ? 2 : 1
    const deadline = Date.now() + 2_000
    let hints: unknown
    while (true) {
      hints = await root("hints", name)
      need(Array.isArray(hints))
      if (hints.length === wanted) break
      need(hints.length < wanted && Date.now() < deadline, "Actual payload readiness was not observed in time")
      await setTimeout(10)
    }
    const now = await snapshot()
    const facts: Identity[] = []
    const seen = new Set<string>()
    for (const hint of hints) {
      exact(hint, ["v", "case", "mode", "pid", "uid", "gid", "namespaces"])
      need(hint.v === 1 && hint.case === name && typeof hint.pid === "number" && hint.uid === 1000 && hint.gid === 1000)
      need(typeof hint.mode === "string" && modes(name).includes(hint.mode) && !seen.has(hint.mode))
      seen.add(hint.mode)
      exact(hint.namespaces, ["user", "mnt", "pid"])
      const matches = now.filter(
        (row) => row.nspid.at(-1) === hint.pid && JSON.stringify(row.namespaces) === JSON.stringify(hint.namespaces),
      )
      need(matches.length === 1)
      const member = matches[0]!
      need(facts.every((row) => !same(row, member)))
      need(
        member.uid === spec.uid &&
          member.gid === spec.gid &&
          member.groups.length === 0 &&
          member.nnp === 1 &&
          JSON.stringify(member.uidMap) === JSON.stringify([1000, spec.uid, 1]) &&
          JSON.stringify(member.gidMap) === JSON.stringify([1000, spec.gid, 1]) &&
          member.namespaces.user.inode !== String(spec.namespaces.user) &&
          member.namespaces.pid.inode !== String(spec.namespaces.pid) &&
          Object.values(member.capabilities).every((value) => /^0+$/.test(value)),
      )
      const full = await root("inspect", String(member.pid), member.start)
      need(
        full !== null &&
          typeof full === "object" &&
          "masks" in full &&
          Array.isArray(full.masks) &&
          full.masks.length === 5 &&
          "executable" in full &&
          full.executable !== null &&
          typeof full.executable === "object" &&
          "readonly" in full.executable &&
          full.executable.readonly === true,
      )
      for (const [index, mask] of full.masks.entries()) {
        need(
          mask !== null &&
            typeof mask === "object" &&
            "path" in mask &&
            typeof mask.path === "string" &&
            mask.path === LinuxIsolation.MASKS[index] &&
            "readonly" in mask &&
            mask.readonly === true &&
            "empty" in mask &&
            mask.empty === true &&
            "uid" in mask &&
            mask.uid === spec.uid &&
            "gid" in mask &&
            mask.gid === spec.gid &&
            "mode" in mask &&
            mask.mode === 0o755 &&
            "device" in mask &&
            typeof mask.device === "string" &&
            "inode" in mask &&
            typeof mask.inode === "string",
        )
        const original = originalMasks?.[mask.path]
        need(original && (original.device !== mask.device || original.inode !== mask.inode))
      }
      need("fds" in full && Array.isArray(full.fds))
      const proofPath = LinuxIsolation.HOST_TEMP + "/vector-sandbox/session-proof.json"
      const proof = manifest.mode === "codium" ? await fs.stat(proofPath, { bigint: true }) : undefined
      for (const fd of full.fds) {
        need(fd !== null && typeof fd === "object" && "device" in fd && "inode" in fd)
        need(
          !heldFile || fd.device !== heldFile.device || fd.inode !== heldFile.inode,
          "A held private file handle reached the payload",
        )
        need(
          !proof || fd.device !== String(proof.dev) || fd.inode !== String(proof.ino),
          "A real proof handle reached the payload",
        )
        for (const namespace of Object.values(engine!.namespaces))
          need(
            fd.device !== namespace.device || fd.inode !== namespace.inode,
            "An ancestor namespace handle reached the payload",
          )
      }
      facts.push(member)
    }
    if (name === "shell-pipeline")
      need(facts.every((row) => JSON.stringify(row.namespaces) === JSON.stringify(facts[0]!.namespaces)))
    if (name === "pipeline")
      need(
        facts[0]!.namespaces.user.inode !== facts[1]!.namespaces.user.inode &&
          facts[0]!.namespaces.pid.inode !== facts[1]!.namespaces.pid.inode,
      )
    report.push({
      case: name,
      payloads: facts.map((row) => ({ pid: row.pid, start: row.start, uid: row.uid, namespaces: row.namespaces })),
      kernelVerified: true,
    })
  }
  const handle = async (line: string) => {
    const value = json(Buffer.from(line))
    need(record(value))
    const item: Record<string, unknown> = value
    need(item.v === 1 && item.nonce === manifest.nonce && typeof item.event === "string")
    if (item.event === "engine-ready") {
      exact(item, [
        "v",
        "event",
        "nonce",
        "pid",
        "runtime",
        "mode",
        "family",
        "channelSHA256",
        "proof",
        "heldFile",
        "omission",
      ])
      need(
        !engine &&
          item.mode === manifest.mode &&
          item.runtime === manifest.runtime &&
          item.family === manifest.family &&
          item.channelSHA256 === digest(Buffer.from(JSON.stringify(channel))) &&
          typeof item.pid === "number" &&
          item.omission === "aggregate-instance-bootstrap-only",
      )
      const registered = await root("register", String(item.pid))
      engine = identity(registered)
      need(engine.uid === spec.uid && engine.gid === spec.gid)
      need(
        registered !== null &&
          typeof registered === "object" &&
          "masks" in registered &&
          Array.isArray(registered.masks) &&
          registered.masks.length === LinuxIsolation.MASKS.length &&
          "fds" in registered &&
          Array.isArray(registered.fds) &&
          "executable" in registered &&
          registered.executable !== null &&
          typeof registered.executable === "object" &&
          "readonly" in registered.executable &&
          registered.executable.readonly === true,
      )
      originalMasks = {}
      for (const [index, mask] of registered.masks.entries()) {
        need(
          mask !== null &&
            typeof mask === "object" &&
            "path" in mask &&
            typeof mask.path === "string" &&
            mask.path === LinuxIsolation.MASKS[index] &&
            "device" in mask &&
            typeof mask.device === "string" &&
            "inode" in mask &&
            typeof mask.inode === "string",
        )
        originalMasks[mask.path] = { device: mask.device, inode: mask.inode }
      }
      exact(item.heldFile, ["device", "inode"])
      need(typeof item.heldFile.device === "string" && typeof item.heldFile.inode === "string")
      heldFile = { device: item.heldFile.device, inode: item.heldFile.inode }
      need(
        registered.fds.some(
          (fd: unknown) =>
            fd !== null &&
            typeof fd === "object" &&
            "kind" in fd &&
            fd.kind === "file" &&
            "device" in fd &&
            fd.device === heldFile!.device &&
            "inode" in fd &&
            fd.inode === heldFile!.inode,
        ),
      )
      baseline = await snapshot()
      need(
        baseline.some((row) => same(row, engine!)) &&
          baseline.some((row) => row.pid === spec.keeper.pid && row.start === spec.keeper.start),
      )
      if (manifest.mode === "codium") {
        exact(item.proof, ["device", "inode"])
        const proof = await fs.stat(LinuxIsolation.HOST_TEMP + "/vector-sandbox/session-proof.json", { bigint: true })
        need(proof.isFile() && proof.nlink === 1n && !(Number(proof.mode) & 0o077) && proof.uid !== BigInt(spec.uid))
        need(item.proof.device === String(proof.dev) && item.proof.inode === String(proof.ino))
        proofIdentity = { device: String(proof.dev), inode: String(proof.ino) }
        const fd3 = registered.fds.find(
          (fd: unknown) => fd !== null && typeof fd === "object" && "fd" in fd && fd.fd === 3,
        )
        need(
          fd3 !== null &&
            typeof fd3 === "object" &&
            "device" in fd3 &&
            fd3.device === String(proof.dev) &&
            "inode" in fd3 &&
            fd3.inode === String(proof.ino),
        )
      } else
        need(
          item.proof === null &&
            !(await fs
              .lstat(LinuxIsolation.HOST_TEMP + "/vector-sandbox/session-proof.json")
              .catch((error: NodeJS.ErrnoException) => {
                if (error.code === "ENOENT") return undefined
                throw error
              })),
        )
      await root("control")
      return
    }
    if (item.event === "signal-control") {
      exact(item, ["v", "event", "nonce", "count"])
      need(engine && !control && item.count === 1)
      control = true
      await ack("engine", "baseline")
      return
    }
    if (item.event === "round-begin") {
      exact(item, ["v", "event", "nonce", "case"])
      need(control && engine && !current && item.case === expected[rounds])
      current = String(item.case)
      await stopped()
      await ack(current, "baseline")
      if (!current.startsWith("fd-")) {
        await observed(current)
        if (current === "death") {
          await root("kill-engine")
          deathSent = true
          await stopped(true)
          need((await verifyCounters(current)) === 2)
          return
        }
        await ack(current, "release")
        if (current === "abort") await ack(current, "abort")
      }
      return
    }
    if (item.event === "round-done") {
      need(current && item.case === current && manifest.family === "baseline")
      exact(item, [
        "v",
        "event",
        "nonce",
        "case",
        ...(current.startsWith("fd-")
          ? ["refused"]
          : ["inspect", "nonzero", "timeout", "abort", "shell-pipeline"].includes(current)
            ? ["exit", "asks", "metadata", "outputSHA256"]
            : ["exit", "stdoutBytes", "stderrBytes", "stdoutSHA256", "stderrSHA256"]),
      ])
      const count = await verifyCounters(current)
      if (current.startsWith("fd-")) need(item.refused === true)
      await stopped()
      report.push({ case: current, stoppedBeforeUidSweep: true, counters: count, result: item })
      await ack(current, "stopped")
      current = undefined
      rounds++
      return
    }
    if (item.event === "engine-summary") {
      exact(item, ["v", "event", "nonce", "cases", "proofWritten", "signalCount", "emptyProc"])
      need(
        manifest.family === "baseline" &&
          !current &&
          !summary &&
          rounds === CASES.length &&
          item.cases === CASES.length &&
          item.signalCount === 1 &&
          item.emptyProc === true &&
          item.proofWritten === (manifest.mode === "codium"),
      )
      if (manifest.mode === "codium") {
        const { GithubSessionProof } = await import("../../src/cli/cmd/github.session-proof")
        const name = LinuxIsolation.HOST_TEMP + "/vector-sandbox/session-proof.json"
        const info = await fs.lstat(name, { bigint: true })
        need(
          info.isFile() &&
            info.nlink === 1n &&
            !(Number(info.mode) & 0o077) &&
            proofIdentity?.device === String(info.dev) &&
            proofIdentity.inode === String(info.ino),
        )
        const proof = GithubSessionProof.parse(await boundedFile(name, GithubSessionProof.LIMIT))
        need(proof.sha256 === digest(ARTIFACT) && proof.bytes === ARTIFACT.length)
      }
      summary = true
      await ack("engine", "summary")
      return
    }
    if (item.event === "driver-exit") {
      exact(item, ["v", "event", "nonce", "code"])
      need(driverExit === undefined && typeof item.code === "number")
      driverExit = item.code
      return
    }
    throw new Error("Unknown engine protocol event")
  }
  const failed = Promise.withResolvers<never>()
  void failed.promise.catch(() => {})
  let escalation: ReturnType<typeof globalThis.setTimeout> | undefined
  const fail = (error: unknown) => {
    if (protocolError !== undefined) return
    protocolError = error
    child.kill("SIGTERM")
    if (engine) void root("kill-engine").catch(() => {})
    escalation = globalThis.setTimeout(() => {
      child.kill("SIGKILL")
      child.stdin?.destroy()
      child.stdout?.destroy()
      child.stderr?.destroy()
      child.unref()
      failed.reject(new Error("The bounded native Shell host failed; cleanup remains unqualified"))
    }, 1_000)
  }
  let queue = Promise.resolve()
  const receive = (chunk: Buffer, protocol: boolean) => {
    bytes += chunk.length
    const combined = tail + chunk.toString("utf8")
    need(
      bytes <= 1_048_576 && secrets.every((value) => !combined.includes(value)),
      "Output limit or synthetic secret disclosure",
    )
    tail = combined.slice(-4096)
    if (!protocol) return
    pending += chunk.toString("utf8")
    need(Buffer.byteLength(pending) <= 65_536)
    while (pending.includes("\n")) {
      const end = pending.indexOf("\n")
      const line = pending.slice(0, end)
      pending = pending.slice(end + 1)
      if (!line.startsWith(PREFIX)) continue
      need(Buffer.byteLength(line) <= 4096)
      queue = queue
        .then(() => handle(line.slice(PREFIX.length)))
        .catch((error: unknown) => {
          fail(error)
        })
    }
  }
  child.stdout.on("data", (chunk: Buffer) => {
    try {
      receive(chunk, true)
    } catch (error) {
      fail(error)
    }
  })
  child.stderr.on("data", (chunk: Buffer) => {
    try {
      receive(chunk, false)
    } catch (error) {
      fail(error)
    }
  })
  child.stdin.on("error", fail)
  const deadline = globalThis.setTimeout(() => fail(new Error("Cell deadline exceeded")), 180_000)
  try {
    const ended = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
      child.once("error", reject)
      child.once("close", (code, signal) => resolve({ code, signal }))
    })
    const result = await Promise.race([ended, failed.promise])
    await queue
    need(!protocolError && pending.length === 0 && engine && control)
    if (manifest.family === "baseline")
      need(summary && rounds === CASES.length && result.code === 0 && driverExit === 0)
    else need(deathSent && !summary && result.code !== 0 && driverExit !== undefined && driverExit !== 0)
    const now = await snapshot()
    need(!now.some((row) => same(row, engine!)))
    const retained = baseline!.filter((row) => !same(row, engine!))
    need(
      retained.every((row) => now.some((member) => same(row, member))) &&
        now.every((row) => retained.some((member) => same(row, member))),
    )
    const output = {
      v: 1,
      sourceRevision: manifest.sourceRevision,
      runtime: manifest.runtime,
      mode: manifest.mode,
      family: manifest.family,
      assetSHA256: ProcessIsolation.nativeBuild().entrySHA,
      cases: report,
      bootstrapOmission: "aggregate-instance-bootstrap-only",
      stoppedBeforeUidSweep: true,
      profileQualification: "separate-required-workflow-gate",
    }
    const encoded = JSON.stringify(output)
    need(Buffer.byteLength(encoded) <= 1_048_576 && secrets.every((value) => !encoded.includes(value)))
    await fs.writeFile(
      `${LinuxIsolation.HOST_TEMP}/native-shell-${manifest.runtime}-${manifest.mode}-${manifest.family}.json`,
      encoded + "\n",
      { flag: "wx", mode: 0o600 },
    )
    process.stdout.write("Native Shell host witness passed before final UID sweep\n")
  } finally {
    globalThis.clearTimeout(deadline)
    globalThis.clearTimeout(escalation)
  }
}

void (process.argv[2] === "driver" ? driver() : main()).catch(() => {
  process.stderr.write("Native Shell host fixture refused\n")
  process.exitCode = 125
})
