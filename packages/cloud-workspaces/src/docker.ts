import { createHash, randomUUID } from "node:crypto"

export type DockerCommand = {
  args: readonly string[]
  input?: string
  env?: Record<string, string>
  timeoutMs?: number
  outputLimit?: number
}
export type DockerCommandResult = { code: number; stdout: string }
export type DockerRunner = (command: DockerCommand) => Promise<DockerCommandResult>
export type DockerLimits = { cpus: number; memoryMiB: number; diskGiB: number; pids: number }
export type DockerRuntimeOptions = {
  image: string
  network: string
  runtime?: string
  volumeDriver?: string
  volumeSizeOption?: string
  limits?: DockerLimits
  /** Explicit local CI/development escape hatch; never use for customer workspaces. */
  allowInsecure?: boolean
  run?: DockerRunner
  fetch?: typeof fetch
}
export type DockerWorkspaceInput = {
  id: string
  password: string
  repository?: { owner: string; repository: string; ref: string }
  credential?: string
  model: { id: string; name: string; baseURL: string; token: string; maxOutputTokens?: number }
}
export type DockerWorkspaceState = {
  state: "running" | "stopped" | "missing"
  port?: number
}
export type ExportWorkspaceChange = { path: string; mode: "100644" | "100755"; content: string | null }
export type ExportWorkspaceSnapshot = {
  baseCommit: string
  changes: ExportWorkspaceChange[]
  diff: string
  digest: string
}

export class DockerRuntimeError extends Error {
  constructor(
    readonly code:
      | "invalid_configuration"
      | "invalid_workspace"
      | "docker_command_failed"
      | "unsafe_container"
      | "workspace_exists"
      | "workspace_not_running",
  ) {
    super(code)
    this.name = "DockerRuntimeError"
  }
}

const DEFAULT_LIMITS = { cpus: 2, memoryMiB: 4096, diskGiB: 10, pids: 512 }
const PORT = "4096/tcp"
const MANAGED = "ai.vectordev.cloud-workspace"
const NAME = /^[a-z0-9][a-z0-9_-]{7,63}$/
const IMAGE = /^(?:[a-z0-9][a-z0-9./:_-]*@)?sha256:[a-f0-9]{64}$/

// This is fixed trusted code, passed as one argv element, never a shell command.
// The repository credential crosses stdin only and exists on a private tmpfs only.
const INITIALIZE = String.raw`
import json, pathlib, subprocess, sys
data = json.load(sys.stdin)
root = pathlib.Path('/data')
if (root / '.vector-workspace-ready').exists() or (root / 'repository').exists():
    raise RuntimeError('workspace already initialized')
for name in ['config/vector', 'share', 'cache', 'state', 'home']:
    (root / name).mkdir(parents=True, exist_ok=True, mode=0o700)
env = {'PATH': '/usr/local/bin:/usr/bin:/bin', 'HOME': '/data/home', 'TMPDIR': '/tmp',
       'GIT_CONFIG_NOSYSTEM': '1', 'GIT_CONFIG_GLOBAL': '/dev/null',
       'GIT_TERMINAL_PROMPT': '0', 'GIT_LFS_SKIP_SMUDGE': '1'}
credential = pathlib.Path('/run/git-credential')
git = ['git', '-c', 'credential.helper=', '-c', 'core.hooksPath=/dev/null',
       '-c', 'protocol.file.allow=never', '-c', 'protocol.ext.allow=never',
       '-c', 'http.followRedirects=false', '-c', 'submodule.recurse=false']
try:
    if data.get('credential'):
        credential.write_text(data['credential'], encoding='utf-8')
        credential.chmod(0o600)
        env['GIT_ASKPASS'] = '/usr/local/bin/vector-workspace-askpass'
    target = root / 'repository'
    subprocess.run(git + ['init', '--', str(target)], env=env, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    if data.get('repository'):
        repository = data['repository']
        url = 'https://github.com/' + repository['owner'] + '/' + repository['repository'] + '.git'
        subprocess.run(git + ['-C', str(target), 'remote', 'add', 'origin', url], env=env, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        subprocess.run(git + ['-C', str(target), 'fetch', '--no-tags', '--depth=1', 'origin', repository['ref']], env=env, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        subprocess.run(git + ['-C', str(target), 'checkout', '--detach', 'FETCH_HEAD'], env=env, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    model = data['model']
    config = {'model': 'vector-cloud/' + model['id'], 'small_model': 'vector-cloud/' + model['id'],
              'enabled_providers': ['vector-cloud'], 'autoupdate': False,
              'permission': {'edit': 'allow', 'bash': 'ask', 'task': 'ask', 'external_directory': 'deny'},
              'provider': {'vector-cloud': {'npm': '@ai-sdk/openai-compatible', 'name': 'Vector Cloud',
                  'options': {'baseURL': model['baseURL'], 'apiKey': model['token']},
                  'models': {model['id']: {'name': model['name'], 'tool_call': True,
                      'limit': {'context': 128000, 'output': model.get('maxOutputTokens', 4096)}}}}}}
    path = root / 'config/vector/vector.json'
    with path.open('x', encoding='utf-8') as output:
        json.dump(config, output)
    path.chmod(0o600)
    (root / '.vector-workspace-ready').write_text('1\n', encoding='utf-8')
    base = subprocess.run(git + ['-C', str(target), 'rev-parse', '--verify', 'HEAD'], env=env, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    print(json.dumps({'baseCommit': base.stdout.decode('ascii').strip() if base.returncode == 0 else None}))
finally:
    credential.unlink(missing_ok=True)
`

// Object reads never invoke repository filters, diff drivers, hooks or programs.
// The agent is stopped; /data is read-only and this helper has no network or token.
const EXPORT = String.raw`
import base64, difflib, hashlib, json, os, pathlib, stat, subprocess, sys
request = json.load(sys.stdin)
root = pathlib.Path('/data/repository')
base = request['baseCommit']
if not root.is_dir() or root.is_symlink() or not (root / '.git').is_dir() or (root / '.git').is_symlink():
    raise RuntimeError('unsupported git directory')
env = {'PATH': '/usr/local/bin:/usr/bin:/bin', 'HOME': '/tmp',
       'GIT_CONFIG_NOSYSTEM': '1', 'GIT_CONFIG_GLOBAL': '/dev/null',
       'GIT_NO_REPLACE_OBJECTS': '1', 'GIT_NO_LAZY_FETCH': '1', 'GIT_TERMINAL_PROMPT': '0'}
git = ['git', '--no-replace-objects', '--git-dir=' + str(root / '.git'), '--work-tree=' + str(root),
       '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false',
       '-c', 'credential.helper=', '-c', 'protocol.allow=never']
def command(args):
    result = subprocess.run(git + args, env=env, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, check=True, timeout=30)
    if len(result.stdout) > 16 * 1024 * 1024:
        raise RuntimeError('git output too large')
    return result.stdout
def valid(path):
    parts = path.split('/')
    if not path or len(path.encode('utf-8')) > 512 or '\\' in path or any(ord(c) < 32 or ord(c) == 127 for c in path) or any(p in ['', '.', '..'] or p.lower() == '.git' for p in parts):
        raise RuntimeError('unsafe path')
    return path
base_files = {}
for entry in command(['ls-tree', '-r', '-z', '--full-tree', base]).split(b'\0'):
    if not entry:
        continue
    info, name = entry.split(b'\t', 1)
    mode, kind, sha = info.decode('ascii').split(' ')
    path = valid(name.decode('utf-8'))
    if mode not in ['100644', '100755', '120000'] or kind != 'blob':
        raise RuntimeError('submodules unsupported')
    base_files[path] = (mode, sha)
candidates = set(base_files)
for entry in command(['ls-files', '--cached', '--others', '--exclude-standard', '-z']).split(b'\0'):
    if entry:
        candidates.add(valid(entry.decode('utf-8')))
if len(candidates) > 50000:
    raise RuntimeError('too many files')
changes = []
diffs = []
total = 0
scanned = 0
for path in sorted(candidates, key=lambda item: item.encode('utf-8')):
    previous = base_files.get(path)
    current = root
    missing = False
    parts = path.split('/')
    for index, part in enumerate(parts):
        current = current / part
        try:
            observed = current.lstat()
        except FileNotFoundError:
            missing = True
            break
        if index != len(parts) - 1 and not stat.S_ISDIR(observed.st_mode):
            raise RuntimeError('unsafe parent')
    if missing:
        if not previous:
            continue
        data = None
        mode = previous[0]
    elif stat.S_ISLNK(observed.st_mode):
        link = os.readlink(current).encode('utf-8')
        sha = hashlib.sha1(b'blob ' + str(len(link)).encode('ascii') + b'\0' + link).hexdigest()
        if previous == ('120000', sha):
            continue
        raise RuntimeError('changed symlink unsupported')
    elif stat.S_ISREG(observed.st_mode):
        mode = '100755' if observed.st_mode & 0o111 else '100644'
        size = observed.st_size
        scanned += size
        if scanned > 512 * 1024 * 1024:
            raise RuntimeError('scan too large')
        digest = hashlib.sha1(b'blob ' + str(size).encode('ascii') + b'\0')
        chunks = []
        fd = os.open(current, os.O_RDONLY | os.O_NOFOLLOW)
        with os.fdopen(fd, 'rb') as source:
            if not stat.S_ISREG(os.fstat(source.fileno()).st_mode):
                raise RuntimeError('unsafe file')
            while True:
                chunk = source.read(65536)
                if not chunk:
                    break
                digest.update(chunk)
                if size <= 4 * 1024 * 1024:
                    chunks.append(chunk)
        if previous == (mode, digest.hexdigest()):
            continue
        if size > 4 * 1024 * 1024:
            raise RuntimeError('changed file too large')
        data = b''.join(chunks)
    else:
        raise RuntimeError('unsupported file kind')
    if previous and previous[0] == '120000':
        raise RuntimeError('changed symlink unsupported')
    if len(changes) >= 100:
        raise RuntimeError('too many changes')
    before = b''
    if previous:
        if int(command(['cat-file', '-s', previous[1]])) > 4 * 1024 * 1024:
            raise RuntimeError('base file too large')
        before = command(['cat-file', 'blob', previous[1]])
    if b'\0' in before or (data is not None and b'\0' in data):
        raise RuntimeError('binary change unsupported')
    old = before.decode('utf-8')
    new = data.decode('utf-8') if data is not None else ''
    total += len(data) if data is not None else 0
    if total > 4 * 1024 * 1024:
        raise RuntimeError('changes too large')
    changes.append({'path': path, 'mode': mode, 'content': base64.b64encode(data).decode('ascii') if data is not None else None})
    header = 'diff --git ' + json.dumps('a/' + path) + ' ' + json.dumps('b/' + path) + '\n'
    if not previous:
        header += 'new file mode ' + mode + '\n'
    elif data is None:
        header += 'deleted file mode ' + previous[0] + '\n'
    elif mode != previous[0]:
        header += 'old mode ' + previous[0] + '\nnew mode ' + mode + '\n'
    lines = []
    for line in difflib.unified_diff(old.splitlines(keepends=True), new.splitlines(keepends=True), fromfile='a/' + path if previous else '/dev/null', tofile='b/' + path if data is not None else '/dev/null'):
        lines.append(line if line.endswith('\n') else line + '\n\\ No newline at end of file\n')
    diffs.append(header + ''.join(lines))
    if sum(len(item.encode('utf-8')) for item in diffs) > 256 * 1024:
        raise RuntimeError('preview too large')
print(json.dumps({'baseCommit': base, 'changes': changes, 'diff': ''.join(diffs)}))
`

export function createDockerRuntime(options: DockerRuntimeOptions) {
  const limits = options.limits ?? DEFAULT_LIMITS
  const runtime = options.runtime ?? "runsc"
  const volumeDriver = options.volumeDriver ?? ""
  const sizeOption = options.volumeSizeOption ?? "size"
  if (
    !IMAGE.test(options.image) ||
    !/^[a-z0-9][a-z0-9_.-]{0,63}$/.test(options.network) ||
    ["host", "none", "bridge"].includes(options.network) ||
    !/^[a-z0-9][a-z0-9_.-]{0,63}$/.test(runtime) ||
    !/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(sizeOption) ||
    !Number.isFinite(limits.cpus) ||
    limits.cpus < 0.25 ||
    limits.cpus > 16 ||
    !Number.isSafeInteger(limits.memoryMiB) ||
    limits.memoryMiB < 256 ||
    limits.memoryMiB > 32768 ||
    !Number.isSafeInteger(limits.diskGiB) ||
    limits.diskGiB < 1 ||
    limits.diskGiB > 100 ||
    !Number.isSafeInteger(limits.pids) ||
    limits.pids < 32 ||
    limits.pids > 2048 ||
    (!options.allowInsecure && (runtime !== "runsc" || !volumeDriver || volumeDriver === "local")) ||
    (volumeDriver && !/^[a-zA-Z0-9][a-zA-Z0-9_.:/-]{0,127}$/.test(volumeDriver))
  )
    throw new DockerRuntimeError("invalid_configuration")
  const run = options.run ?? runDocker
  const requestFetch = options.fetch ?? fetch
  const checked = async (command: DockerCommand) => {
    const result = await run(command).catch(() => {
      throw new DockerRuntimeError("docker_command_failed")
    })
    if (result.code !== 0) throw new DockerRuntimeError("docker_command_failed")
    return result.stdout
  }
  const names = (id: string) => {
    if (!NAME.test(id)) throw new DockerRuntimeError("invalid_workspace")
    return { container: `vector-ws-${id}`, volume: `vector-ws-data-${id}` }
  }
  const hardening = (id: string, overrides: { network?: string; readOnlyVolume?: boolean } = {}) => [
    "--label",
    `${MANAGED}=1`,
    "--label",
    `${MANAGED}.id=${id}`,
    "--user",
    "10001:10001",
    "--read-only",
    "--cap-drop=ALL",
    "--security-opt=no-new-privileges:true",
    "--pids-limit",
    String(limits.pids),
    "--cpus",
    String(limits.cpus),
    "--memory",
    `${limits.memoryMiB}m`,
    "--memory-swap",
    `${limits.memoryMiB}m`,
    "--ulimit",
    "nofile=4096:4096",
    "--runtime",
    runtime,
    "--network",
    overrides.network ?? options.network,
    "--tmpfs",
    "/tmp:rw,nosuid,nodev,noexec,size=128m,mode=1777",
    "--tmpfs",
    "/run:rw,nosuid,nodev,noexec,size=1m,mode=0700,uid=10001,gid=10001",
    "--mount",
    `type=volume,source=${names(id).volume},target=/data${overrides.readOnlyVolume ? ",readonly" : ""}`,
    "--log-driver",
    "local",
    "--log-opt",
    "max-size=10m",
    "--log-opt",
    "max-file=2",
    // Docker client proxy defaults may contain host credentials; never inherit them in a tenant.
    ...[
      "HTTP_PROXY",
      "HTTPS_PROXY",
      "ALL_PROXY",
      "NO_PROXY",
      "http_proxy",
      "https_proxy",
      "all_proxy",
      "no_proxy",
    ].flatMap((name) => ["--env", `${name}=`]),
  ]
  const inspect = async (id: string): Promise<DockerWorkspaceState> => {
    const named = names(id)
    const present = await checked({
      args: ["container", "ls", "--all", "--filter", `name=^/${named.container}$`, "--format", "{{.Names}}"],
    })
    if (!present.trim()) return { state: "missing" }
    if (present.trim() !== named.container) throw new DockerRuntimeError("unsafe_container")
    const raw = dockerJSON(await checked({ args: ["container", "inspect", named.container, "--format", "{{json .}}"] }))
    if (
      !record(raw) ||
      !record(raw.Config) ||
      !record(raw.Config.Labels) ||
      !record(raw.HostConfig) ||
      !record(raw.State) ||
      !record(raw.NetworkSettings)
    )
      throw new DockerRuntimeError("unsafe_container")
    const config = raw.Config
    const host = raw.HostConfig
    if (
      !record(config.Labels) ||
      config.Labels[MANAGED] !== "1" ||
      config.Labels[`${MANAGED}.id`] !== id ||
      config.Image !== options.image ||
      config.User !== "10001:10001" ||
      host.ReadonlyRootfs !== true ||
      host.Privileged !== false ||
      host.Runtime !== runtime ||
      host.NetworkMode !== options.network ||
      host.Memory !== limits.memoryMiB * 1048576 ||
      host.MemorySwap !== limits.memoryMiB * 1048576 ||
      host.NanoCpus !== Math.round(limits.cpus * 1e9) ||
      host.PidsLimit !== limits.pids ||
      !Array.isArray(host.CapDrop) ||
      host.CapDrop.length !== 1 ||
      host.CapDrop[0] !== "ALL" ||
      (host.CapAdd !== null && (!Array.isArray(host.CapAdd) || host.CapAdd.length !== 0)) ||
      !Array.isArray(host.SecurityOpt) ||
      host.SecurityOpt.length !== 1 ||
      !["no-new-privileges", "no-new-privileges:true"].includes(host.SecurityOpt[0]) ||
      host.PublishAllPorts !== false ||
      !loopbackBindings(host.PortBindings, true) ||
      !Array.isArray(raw.Mounts) ||
      raw.Mounts.length !== 1 ||
      !record(raw.Mounts[0]) ||
      raw.Mounts[0].Type !== "volume" ||
      raw.Mounts[0].Name !== named.volume ||
      raw.Mounts[0].Destination !== "/data"
    )
      throw new DockerRuntimeError("unsafe_container")
    if (raw.State.Running !== true) return { state: "stopped" }
    const ports = raw.NetworkSettings.Ports
    if (!loopbackBindings(ports, false) || !record(ports) || !Array.isArray(ports[PORT]))
      throw new DockerRuntimeError("unsafe_container")
    const binding: unknown = ports[PORT][0]
    if (
      !record(binding) ||
      binding.HostIp !== "127.0.0.1" ||
      typeof binding.HostPort !== "string" ||
      !/^\d{1,5}$/.test(binding.HostPort)
    )
      throw new DockerRuntimeError("unsafe_container")
    const port = Number(binding.HostPort)
    if (port < 1024 || port > 65535) throw new DockerRuntimeError("unsafe_container")
    return { state: "running", port }
  }
  const verifyVolume = async (id: string) => {
    const raw = dockerJSON(await checked({ args: ["volume", "inspect", names(id).volume, "--format", "{{json .}}"] }))
    if (
      !record(raw) ||
      raw.Name !== names(id).volume ||
      !record(raw.Labels) ||
      raw.Labels[MANAGED] !== "1" ||
      raw.Labels[`${MANAGED}.id`] !== id ||
      raw.Driver !== (volumeDriver || "local") ||
      (!options.allowInsecure &&
        (!record(raw.Options) || raw.Options[sizeOption] !== String(limits.diskGiB * 1073741824)))
    )
      throw new DockerRuntimeError("unsafe_container")
  }
  const retireInitializers = async (id: string) => {
    const prefix = `${names(id).container}-init-`
    const list = async () => {
      const output = await checked({
        args: [
          "container",
          "ls",
          "--all",
          "--filter",
          `label=${MANAGED}=1`,
          "--filter",
          `label=${MANAGED}.id=${id}`,
          "--filter",
          `name=^/${prefix}[a-f0-9]{8}$`,
          "--format",
          "{{.Names}}",
        ],
        timeoutMs: 15_000,
      })
      const values = output.trim() ? output.trim().split("\n") : []
      if (values.length > 16 || values.some((name) => !new RegExp(`^${prefix}[a-f0-9]{8}$`).test(name)))
        throw new DockerRuntimeError("unsafe_container")
      return values
    }
    for (const name of await list()) {
      const raw = dockerJSON(
        await checked({ args: ["container", "inspect", name, "--format", "{{json .}}"], timeoutMs: 15_000 }),
      )
      if (
        !record(raw) ||
        !record(raw.Config) ||
        !record(raw.Config.Labels) ||
        raw.Config.Labels[MANAGED] !== "1" ||
        raw.Config.Labels[`${MANAGED}.id`] !== id ||
        raw.Config.Image !== options.image ||
        raw.Config.User !== "10001:10001"
      )
        throw new DockerRuntimeError("unsafe_container")
      const removed = await run({ args: ["container", "rm", "--force", name], timeoutMs: 15_000 }).catch(
        () => undefined,
      )
      // --rm may win this race. A nonzero removal is safe only after exact enumeration proves absence.
      if (removed?.code !== 0 && (await list()).includes(name)) throw new DockerRuntimeError("docker_command_failed")
    }
    if ((await list()).length !== 0) throw new DockerRuntimeError("docker_command_failed")
  }
  const start = async (id: string) => {
    const state = await inspect(id)
    if (state.state === "missing") throw new DockerRuntimeError("workspace_not_running")
    await verifyVolume(id)
    if (state.state === "stopped") await checked({ args: ["container", "start", names(id).container] })
    const current = await inspect(id)
    if (current.state !== "running") throw new DockerRuntimeError("workspace_not_running")
    return current
  }
  const request = async (id: string, password: string, path: string, init: RequestInit = {}) => {
    validatePassword(password)
    if (!path.startsWith("/") || path.startsWith("//") || /[\\#\u0000-\u0020]/.test(path))
      throw new DockerRuntimeError("invalid_workspace")
    const state = await inspect(id)
    if (state.state !== "running" || !state.port) throw new DockerRuntimeError("workspace_not_running")
    const url = new URL(path, `http://127.0.0.1:${state.port}`)
    if (url.hostname !== "127.0.0.1" || url.port !== String(state.port))
      throw new DockerRuntimeError("invalid_workspace")
    url.searchParams.set("directory", "/data/repository")
    const headers = new Headers(init.headers)
    for (const name of [
      "authorization",
      "cookie",
      "host",
      "connection",
      "proxy-authorization",
      "transfer-encoding",
      "forwarded",
      "x-forwarded-host",
      "x-forwarded-proto",
    ])
      headers.delete(name)
    headers.set("authorization", `Basic ${Buffer.from(`vector:${password}`).toString("base64")}`)
    headers.set("x-vector-directory", "/data/repository")
    return requestFetch(url, {
      ...init,
      headers,
      redirect: "error",
      signal: init.signal ?? AbortSignal.timeout(120_000),
    })
  }
  return {
    inspect,
    start,
    request,
    async snapshot(id: string, input: { baseCommit: string }): Promise<ExportWorkspaceSnapshot> {
      if (!/^[a-f0-9]{40}$/.test(input.baseCommit)) throw new DockerRuntimeError("invalid_workspace")
      await retireInitializers(id)
      if ((await inspect(id)).state !== "stopped") throw new DockerRuntimeError("workspace_not_running")
      await verifyVolume(id)
      const helper = `${names(id).container}-init-${randomUUID().slice(0, 8)}`
      try {
        const raw = dockerJSON(
          await checked({
            args: [
              "container",
              "run",
              "--rm",
              "--interactive",
              "--name",
              helper,
              ...hardening(id, { network: "none", readOnlyVolume: true }),
              "--workdir",
              "/data",
              "--entrypoint",
              "python3",
              options.image,
              "-c",
              EXPORT,
            ],
            input: JSON.stringify(input),
            timeoutMs: 60_000,
            outputLimit: 8_388_608,
          }),
        )
        const snapshot = parseWorkspaceSnapshot(raw, input.baseCommit)
        return { ...snapshot, digest: snapshotDigest(snapshot) }
      } finally {
        await retireInitializers(id)
      }
    },
    async create(input: DockerWorkspaceInput) {
      const named = names(input.id)
      validatePassword(input.password)
      validateModel(input.model, input.id, input.password)
      validateRepository(input.repository)
      if (
        input.credential !== undefined &&
        (!input.repository ||
          input.credential.length < 1 ||
          input.credential.length > 4096 ||
          /[\u0000-\u0020\u007f]/.test(input.credential))
      )
        throw new DockerRuntimeError("invalid_workspace")
      if ((await inspect(input.id)).state !== "missing") throw new DockerRuntimeError("workspace_exists")
      if (
        (
          await checked({ args: ["volume", "ls", "--filter", `name=^${named.volume}$`, "--format", "{{.Name}}"] })
        ).trim()
      )
        throw new DockerRuntimeError("workspace_exists")
      await checked({
        args: [
          "volume",
          "create",
          "--label",
          `${MANAGED}=1`,
          "--label",
          `${MANAGED}.id=${input.id}`,
          ...(volumeDriver ? ["--driver", volumeDriver] : []),
          ...(!options.allowInsecure ? ["--opt", `${sizeOption}=${limits.diskGiB * 1073741824}`] : []),
          named.volume,
        ],
      })
      await verifyVolume(input.id)
      const initName = `${named.container}-init-${randomUUID().slice(0, 8)}`
      let baseCommit: string | null = null
      try {
        const result = dockerJSON(
          await checked({
            args: [
              "container",
              "run",
              "--rm",
              "--interactive",
              "--name",
              initName,
              ...hardening(input.id),
              "--workdir",
              "/data",
              "--entrypoint",
              "python3",
              options.image,
              "-c",
              INITIALIZE,
            ],
            input: JSON.stringify({ repository: input.repository, credential: input.credential, model: input.model }),
            timeoutMs: 180_000,
          }),
        )
        if (
          !record(result) ||
          (result.baseCommit !== null &&
            (typeof result.baseCommit !== "string" || !/^[a-f0-9]{40}$/.test(result.baseCommit))) ||
          (input.repository && result.baseCommit === null)
        )
          throw new DockerRuntimeError("unsafe_container")
        baseCommit = result.baseCommit as string | null
      } finally {
        // Also retire a timed-out init process; --rm alone waits for process exit.
        await run({ args: ["container", "rm", "--force", initName], timeoutMs: 15_000 }).catch(() => undefined)
        if (
          (
            await checked({
              args: ["container", "ls", "--all", "--filter", `name=^/${initName}$`, "--format", "{{.Names}}"],
              timeoutMs: 15_000,
            })
          ).trim()
        )
          throw new DockerRuntimeError("docker_command_failed")
      }
      await checked({
        args: [
          "container",
          "create",
          "--name",
          named.container,
          "--restart",
          "no",
          ...hardening(input.id),
          "--add-host",
          "host.docker.internal:host-gateway",
          "--publish",
          "127.0.0.1::4096/tcp",
          "--workdir",
          "/data/repository",
          "--env",
          "VECTOR_SERVER_PASSWORD",
          "--env",
          "VECTOR_SERVER_USERNAME=vector",
          "--env",
          "VECTOR_CLOUD_WORKSPACE_WORKER=1",
          "--env",
          "VECTOR_APP_NAMESPACE=vector",
          "--env",
          "VECTOR_AGENT_CONFIG_DIR=/data/config/vector",
          "--env",
          "HOME=/data/home",
          "--env",
          "XDG_CONFIG_HOME=/data/config",
          "--env",
          "XDG_DATA_HOME=/data/share",
          "--env",
          "XDG_CACHE_HOME=/data/cache",
          "--env",
          "XDG_STATE_HOME=/data/state",
          options.image,
          "serve",
          "--hostname",
          "0.0.0.0",
          "--port",
          "4096",
          "--trusted-network",
        ],
        env: { VECTOR_SERVER_PASSWORD: input.password },
      })
      return { ...(await start(input.id)), baseCommit }
    },
    async stop(id: string) {
      await retireInitializers(id)
      if ((await inspect(id)).state === "running")
        await checked({ args: ["container", "stop", "--time", "15", names(id).container], timeoutMs: 30_000 })
    },
    async remove(id: string, input: { deleteData?: boolean } = {}) {
      await retireInitializers(id)
      const state = await inspect(id)
      if (state.state !== "missing") {
        await verifyVolume(id)
        await checked({ args: ["container", "rm", "--force", names(id).container], timeoutMs: 30_000 })
      }
      if (input.deleteData) {
        const volume = names(id).volume
        const present = (
          await checked({ args: ["volume", "ls", "--filter", `name=^${volume}$`, "--format", "{{.Name}}"] })
        ).trim()
        if (!present) return
        if (present !== volume) throw new DockerRuntimeError("unsafe_container")
        await verifyVolume(id)
        await checked({ args: ["volume", "rm", volume], timeoutMs: 30_000 })
      }
    },
    async health(id: string, password: string) {
      for (const path of ["/global/health", "/api/health"]) {
        const response = await request(id, password, path, { signal: AbortSignal.timeout(3000) }).catch(() => undefined)
        if (!response) return false
        if (response.status === 404 && path === "/global/health") {
          await response.body?.cancel()
          continue
        }
        if (!response.ok) {
          await response.body?.cancel()
          return false
        }
        if (!response.body) return false
        const text = await boundedOutput(response.body, 4096, () => undefined).catch(() => undefined)
        const body: unknown = text ? await new Response(text).json().catch(() => undefined) : undefined
        return record(body) && body.healthy === true
      }
      return false
    },
  }
}
export type DockerRuntime = ReturnType<typeof createDockerRuntime>

export function snapshotDigest(snapshot: Omit<ExportWorkspaceSnapshot, "digest">) {
  return createHash("sha256")
    .update(JSON.stringify({ baseCommit: snapshot.baseCommit, changes: snapshot.changes, diff: snapshot.diff }))
    .digest("hex")
}
export function parseWorkspaceSnapshot(raw: unknown, baseCommit: string): Omit<ExportWorkspaceSnapshot, "digest"> {
  if (
    !record(raw) ||
    raw.baseCommit !== baseCommit ||
    !Array.isArray(raw.changes) ||
    raw.changes.length > 100 ||
    typeof raw.diff !== "string" ||
    Buffer.byteLength(raw.diff) > 262144
  )
    throw new DockerRuntimeError("unsafe_container")
  let total = 0
  let previous = ""
  const changes = raw.changes.map((value): ExportWorkspaceChange => {
    if (
      !record(value) ||
      Object.keys(value).some((key) => !["path", "mode", "content"].includes(key)) ||
      typeof value.path !== "string" ||
      !value.path ||
      Buffer.byteLength(value.path) > 512 ||
      /[\\\u0000-\u001f\u007f]/.test(value.path) ||
      value.path.split("/").some((part) => !part || part === "." || part === ".." || part.toLowerCase() === ".git") ||
      (value.mode !== "100644" && value.mode !== "100755") ||
      (value.content !== null && typeof value.content !== "string") ||
      (previous && Buffer.compare(Buffer.from(previous), Buffer.from(value.path)) >= 0)
    )
      throw new DockerRuntimeError("unsafe_container")
    previous = value.path
    if (typeof value.content === "string") {
      if (value.content.length > 5_592_408) throw new DockerRuntimeError("unsafe_container")
      const content = Buffer.from(value.content, "base64")
      if (content.toString("base64") !== value.content || content.includes(0))
        throw new DockerRuntimeError("unsafe_container")
      try {
        new TextDecoder("utf-8", { fatal: true }).decode(content)
      } catch {
        throw new DockerRuntimeError("unsafe_container")
      }
      total += content.byteLength
      if (total > 4_194_304) throw new DockerRuntimeError("unsafe_container")
    }
    return { path: value.path, mode: value.mode, content: value.content }
  })
  return { baseCommit, changes, diff: raw.diff }
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
function dockerJSON(value: string): unknown {
  try {
    return JSON.parse(value)
  } catch {
    throw new DockerRuntimeError("unsafe_container")
  }
}
function loopbackBindings(value: unknown, allowUnallocated: boolean) {
  if (!record(value) || Object.keys(value).length !== 1 || !Array.isArray(value[PORT]) || value[PORT].length !== 1)
    return false
  const binding: unknown = value[PORT][0]
  if (!record(binding) || binding.HostIp !== "127.0.0.1" || typeof binding.HostPort !== "string") return false
  if (allowUnallocated && binding.HostPort === "") return true
  return /^\d{1,5}$/.test(binding.HostPort) && Number(binding.HostPort) >= 1024 && Number(binding.HostPort) <= 65535
}
function validatePassword(password: string) {
  if (!/^[A-Za-z0-9_-]{32,256}$/.test(password)) throw new DockerRuntimeError("invalid_workspace")
}
function validateRepository(repository: DockerWorkspaceInput["repository"]) {
  if (!repository) return
  if (
    !/^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/.test(repository.owner) ||
    !/^[A-Za-z0-9_.-]{1,100}$/.test(repository.repository) ||
    repository.repository === "." ||
    repository.repository === ".." ||
    !/^(?:[a-f0-9]{40}|(?:refs\/heads\/)?[A-Za-z0-9][A-Za-z0-9_./-]{0,199})$/.test(repository.ref) ||
    repository.ref.includes("..") ||
    repository.ref.includes("//") ||
    repository.ref.includes("@{") ||
    repository.ref.endsWith("/") ||
    repository.ref.endsWith(".") ||
    repository.ref.split("/").some((part) => part.startsWith(".") || part.endsWith(".lock"))
  )
    throw new DockerRuntimeError("invalid_workspace")
}
function validateModel(model: DockerWorkspaceInput["model"], id: string, password: string) {
  if (
    !/^[A-Za-z0-9][A-Za-z0-9_./:-]{0,199}$/.test(model.id) ||
    !model.name ||
    model.name.length > 200 ||
    /[\u0000-\u001f\u007f]/.test(model.name) ||
    model.token !== password ||
    (model.maxOutputTokens !== undefined &&
      (!Number.isSafeInteger(model.maxOutputTokens) || model.maxOutputTokens < 1 || model.maxOutputTokens > 32768))
  )
    throw new DockerRuntimeError("invalid_workspace")
  const url = URL.canParse(model.baseURL) ? new URL(model.baseURL) : undefined
  if (
    !url ||
    url.protocol !== "http:" ||
    url.hostname !== "host.docker.internal" ||
    !/^\d{1,5}$/.test(url.port) ||
    Number(url.port) < 1024 ||
    Number(url.port) > 65535 ||
    url.pathname !== `/model/${id}/v1` ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new DockerRuntimeError("invalid_workspace")
}

async function runDocker(command: DockerCommand): Promise<DockerCommandResult> {
  const env = { ...process.env, ...command.env }
  for (const name of ["DOCKER_HOST", "DOCKER_CONTEXT", "DOCKER_TLS", "DOCKER_TLS_VERIFY", "DOCKER_CERT_PATH"])
    delete env[name]
  const child = Bun.spawn(["docker", "--host=unix:///var/run/docker.sock", ...command.args], {
    env,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  })
  const timer = setTimeout(() => child.kill("SIGKILL"), command.timeoutMs ?? 30_000)
  try {
    if (command.input) child.stdin.write(command.input)
    child.stdin.end()
    const output = await Promise.all([
      boundedOutput(child.stdout, command.outputLimit ?? 2_097_152, () => child.kill("SIGKILL")),
      boundedOutput(child.stderr, 65_536, () => child.kill("SIGKILL")),
      child.exited,
    ])
    return { code: output[2], stdout: output[0] }
  } finally {
    clearTimeout(timer)
    if (child.exitCode === null) child.kill("SIGKILL")
  }
}
async function boundedOutput(stream: ReadableStream<Uint8Array>, limit: number, stop: () => void) {
  const reader = stream.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    for (;;) {
      const chunk = await reader.read()
      if (chunk.done) break
      size += chunk.value.byteLength
      if (size > limit) {
        stop()
        await reader.cancel()
        throw new DockerRuntimeError("docker_command_failed")
      }
      chunks.push(chunk.value)
    }
    return Buffer.concat(chunks).toString("utf8")
  } finally {
    reader.releaseLock()
  }
}
