import { expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import {
  createDockerRuntime,
  parseWorkspaceSnapshot,
  snapshotDigest,
  type DockerCommand,
  type DockerWorkspaceInput,
} from "../src/docker"

const image = `sha256:${"a".repeat(64)}`
const id = "workspace_0123456789abcdef"
const password = "workspace-secret-".padEnd(64, "a")
const credential = "github-token-that-must-never-enter-argv"
const baseCommit = "b".repeat(40)
const label = "ai.vectordev.cloud-workspace"
const input: DockerWorkspaceInput = {
  id,
  password,
  repository: { owner: "vector", repository: "example", ref: "refs/heads/main" },
  credential,
  model: {
    id: "example-model",
    name: "Example model",
    baseURL: `http://host.docker.internal:4100/model/${id}/v1`,
    token: password,
  },
}

function fixture() {
  const commands: DockerCommand[] = []
  const state = {
    present: false,
    running: false,
    volume: false,
    failInit: false,
    failInitRemoval: false,
    initializers: [] as string[],
  }
  const binding = { "4096/tcp": [{ HostIp: "127.0.0.1", HostPort: "49152" }] }
  const container = {
    Config: { Image: image, User: "10001:10001", Labels: { [label]: "1", [`${label}.id`]: id } },
    HostConfig: {
      ReadonlyRootfs: true,
      Privileged: false,
      Runtime: "runsc",
      NetworkMode: "vector-cloud-test",
      Memory: 4096 * 1048576,
      MemorySwap: 4096 * 1048576,
      NanoCpus: 2e9,
      PidsLimit: 512,
      CapDrop: ["ALL"],
      CapAdd: null,
      SecurityOpt: ["no-new-privileges:true"],
      PublishAllPorts: false,
      PortBindings: structuredClone(binding),
    },
    State: { Running: false },
    NetworkSettings: { Ports: structuredClone(binding) },
    Mounts: [{ Type: "volume", Name: `vector-ws-data-${id}`, Destination: "/data" }],
  }
  const volume = {
    Name: `vector-ws-data-${id}`,
    Driver: "quota-driver",
    Options: { size: String(10 * 1073741824) },
    Labels: { [label]: "1", [`${label}.id`]: id },
  }
  const snapshot = {
    baseCommit,
    changes: [{ path: "hello.txt", mode: "100644" as const, content: Buffer.from("hello\n").toString("base64") }],
    diff: "new hello.txt\n+hello\n",
  }
  const run = async (command: DockerCommand) => {
    commands.push(command)
    const [kind, action] = command.args
    if (kind === "volume" && action === "ls") return { code: 0, stdout: state.volume ? volume.Name : "" }
    if (kind === "volume" && action === "create") {
      state.volume = true
      return { code: 0, stdout: volume.Name }
    }
    if (kind === "volume" && action === "inspect") return { code: state.volume ? 0 : 1, stdout: JSON.stringify(volume) }
    if (kind === "volume" && action === "rm") {
      state.volume = false
      return { code: 0, stdout: volume.Name }
    }
    if (kind === "container" && action === "ls")
      return {
        code: 0,
        stdout: command.args.some((arg) => arg.startsWith("name=") && arg.includes("-init-"))
          ? state.initializers.join("\n")
          : state.present
            ? `vector-ws-${id}`
            : "",
      }
    if (kind === "container" && action === "inspect")
      return { code: 0, stdout: JSON.stringify({ ...container, State: { Running: state.running } }) }
    if (kind === "container" && action === "create") state.present = true
    if (kind === "container" && action === "start") state.running = true
    if (kind === "container" && action === "stop") state.running = false
    if (kind === "container" && action === "rm" && command.args.at(-1) === `vector-ws-${id}`) {
      state.present = false
      state.running = false
    }
    if (kind === "container" && action === "rm" && command.args.at(-1)?.includes("-init-")) {
      if (state.failInitRemoval) return { code: 1, stdout: "" }
      state.initializers = state.initializers.filter((name) => name !== command.args.at(-1))
    }
    return {
      code: kind === "container" && action === "run" && state.failInit ? 1 : 0,
      stdout:
        kind === "container" && action === "run"
          ? JSON.stringify(command.input && "baseCommit" in JSON.parse(command.input) ? snapshot : { baseCommit })
          : "",
    }
  }
  return { commands, state, container, volume, snapshot, run }
}
function runtime(value: ReturnType<typeof fixture>, requestFetch?: typeof fetch) {
  return createDockerRuntime({
    image,
    network: "vector-cloud-test",
    volumeDriver: "quota-driver",
    run: value.run,
    ...(requestFetch ? { fetch: requestFetch } : {}),
  })
}

test("create, pause and resume retain the same quota-bound data volume; deletion is explicit", async () => {
  const value = fixture()
  const docker = runtime(value)
  expect(await docker.create(input)).toEqual({ state: "running", port: 49152, baseCommit })
  expect(value.state.volume).toBe(true)
  await docker.stop(id)
  expect(await docker.inspect(id)).toEqual({ state: "stopped" })
  expect(value.state.volume).toBe(true)
  expect(await docker.start(id)).toEqual({ state: "running", port: 49152 })
  expect(value.commands.filter((item) => item.args[0] === "volume" && item.args[1] === "create")).toHaveLength(1)
  await docker.remove(id)
  expect(value.state.present).toBe(false)
  expect(value.state.volume).toBe(true)
  await docker.remove(id, { deleteData: true })
  expect(value.state.volume).toBe(false)
})

test("container creation enforces isolation and sends clone credentials only through init stdin", async () => {
  const value = fixture()
  await runtime(value).create(input)
  const init = value.commands.find((item) => item.args[0] === "container" && item.args[1] === "run")!
  const create = value.commands.find((item) => item.args[0] === "container" && item.args[1] === "create")!
  expect(init.input).toContain(credential)
  expect(JSON.parse(init.input!).repository).toEqual(input.repository)
  expect(init.args).toContain("python3")
  expect(init.args).not.toContain("sh")
  expect(init.args.join(" ")).toContain("GIT_ASKPASS")
  expect(init.args.join(" ")).toContain("credential.unlink(missing_ok=True)")
  expect(init.args.join(" ")).toContain("core.hooksPath=/dev/null")
  for (const command of value.commands) {
    expect(command.args.join(" ")).not.toContain(credential)
    expect(JSON.stringify(command.env ?? {})).not.toContain(credential)
    expect(command.args.join(" ")).not.toContain(password)
  }
  expect(create.env).toEqual({ VECTOR_SERVER_PASSWORD: password })
  expect(create.args).toContain("VECTOR_SERVER_PASSWORD")
  expect(create.args).toContain("VECTOR_APP_NAMESPACE=vector")
  expect(create.args).toContain("VECTOR_AGENT_CONFIG_DIR=/data/config/vector")
  expect(create.args).toContain("XDG_STATE_HOME=/data/state")
  expect(create.args).toContain("127.0.0.1::4096/tcp")
  for (const command of [create, init]) {
    expect(command.args).toContain("10001:10001")
    expect(command.args).toContain("--read-only")
    expect(command.args).toContain("--cap-drop=ALL")
    expect(command.args).toContain("--security-opt=no-new-privileges:true")
    expect(command.args).toContain("runsc")
    expect(command.args).toContain("4096m")
    expect(command.args).not.toContain("--privileged")
    expect(command.args.join(" ")).not.toContain("docker.sock")
  }
  const volume = value.commands.find((item) => item.args[0] === "volume" && item.args[1] === "create")!
  expect(volume.args).toContain("quota-driver")
  expect(volume.args).toContain(`size=${10 * 1073741824}`)
})

test("production refuses unbounded local volumes and mutable images before issuing a Docker command", () => {
  for (const change of [
    { image: "vector:latest" },
    { volumeDriver: "local" },
    { volumeDriver: "" },
    { runtime: "runc" },
    { network: "host" },
    { network: "bridge" },
    { limits: { cpus: Infinity, memoryMiB: 4096, diskGiB: 10, pids: 512 } },
  ])
    expect(() =>
      createDockerRuntime({ image, network: "vector-cloud-test", volumeDriver: "quota-driver", ...change }),
    ).toThrow("invalid_configuration")
  expect(() =>
    createDockerRuntime({
      image,
      network: "vector-cloud-test",
      volumeDriver: "local",
      runtime: "runc",
      allowInsecure: true,
    }),
  ).not.toThrow()
})

test("invalid identity, URL-shaped repositories, ref option injection and relay substitution are refused", async () => {
  const invalid: DockerWorkspaceInput[] = [
    { ...input, id: "../../another" },
    { ...input, repository: { owner: "https://evil.test", repository: "example", ref: "main" } },
    { ...input, repository: { owner: "vector", repository: "../example", ref: "main" } },
    { ...input, repository: { owner: "vector", repository: "example", ref: "--upload-pack=evil" } },
    { ...input, repository: { owner: "vector", repository: "example", ref: "main;touch /tmp/pwned" } },
    { ...input, model: { ...input.model, baseURL: "https://api.openai.com/v1" } },
    { ...input, model: { ...input.model, baseURL: "http://host.docker.internal:4100/model/someone_else/v1" } },
    { ...input, model: { ...input.model, token: "primary-provider-secret" } },
  ]
  for (const record of invalid) {
    const value = fixture()
    await expect(runtime(value).create(record)).rejects.toThrow("invalid_workspace")
    expect(value.commands).toHaveLength(0)
  }
})

test("unsafe observed containers are refused before start, proxying, stop or deletion", async () => {
  for (const mutate of [
    (value: ReturnType<typeof fixture>) => {
      value.container.Config.Labels[`${label}.id`] = "somebody_else"
    },
    (value: ReturnType<typeof fixture>) => {
      value.container.HostConfig.ReadonlyRootfs = false
    },
    (value: ReturnType<typeof fixture>) => {
      value.container.HostConfig.PortBindings["4096/tcp"][0]!.HostIp = "0.0.0.0"
    },
    (value: ReturnType<typeof fixture>) => {
      value.container.HostConfig.SecurityOpt.push("seccomp=unconfined")
    },
    (value: ReturnType<typeof fixture>) => {
      value.container.Mounts[0]!.Destination = "/var/run/docker.sock"
    },
  ]) {
    const value = fixture()
    value.state.present = true
    mutate(value)
    await expect(runtime(value).start(id)).rejects.toThrow("unsafe_container")
    expect(value.commands.some((item) => item.args[1] === "start")).toBe(false)
  }
})

test("proxy requests are pinned to the inspected loopback port, workspace directory and generated auth", async () => {
  const value = fixture()
  value.state.present = true
  value.state.running = true
  const requests: { url: string; init?: RequestInit }[] = []
  const requestFetch: typeof fetch = Object.assign(
    async (url: string | URL | Request, init?: RequestInit) => {
      requests.push({ url: String(url), init })
      return Response.json({ healthy: true })
    },
    { preconnect: fetch.preconnect },
  )
  const docker = runtime(value, requestFetch)
  await docker.request(id, password, "/api/session?directory=/private", {
    headers: { authorization: "Bearer primary-secret", cookie: "session=secret", "x-vector-directory": "/etc" },
  })
  expect(requests[0]!.url).toBe("http://127.0.0.1:49152/api/session?directory=%2Fdata%2Frepository")
  const headers = new Headers(requests[0]!.init!.headers)
  expect(headers.get("authorization")).toBe(`Basic ${Buffer.from(`vector:${password}`).toString("base64")}`)
  expect(headers.get("cookie")).toBeNull()
  expect(headers.get("x-vector-directory")).toBe("/data/repository")
  expect(requests[0]!.init!.redirect).toBe("error")
  expect(await docker.health(id, password)).toBe(true)
  for (const path of ["//evil.test/private", "http://evil.test", "/api\\evil", "/api#fragment"])
    await expect(docker.request(id, password, path)).rejects.toThrow("invalid_workspace")
})

test("a failed initializer cannot start the engine and is force-retired without leaking its raw output", async () => {
  const value = fixture()
  value.state.failInit = true
  await expect(runtime(value).create(input)).rejects.toThrow("docker_command_failed")
  expect(value.commands.some((item) => item.args[0] === "container" && item.args[1] === "create")).toBe(false)
  expect(
    value.commands.some(
      (item) => item.args[0] === "container" && item.args[1] === "rm" && item.args.at(-1)?.includes("-init-"),
    ),
  ).toBe(true)
})

test("health permits only the fixed legacy-to-v2 fallback and rejects malformed or oversized replies", async () => {
  for (const body of [JSON.stringify({ healthy: true }), "not json", " ".repeat(5000)]) {
    const value = fixture()
    value.state.present = true
    value.state.running = true
    const paths: string[] = []
    const requestFetch: typeof fetch = Object.assign(
      async (url: string | URL | Request) => {
        const path = new URL(String(url)).pathname
        paths.push(path)
        return path === "/global/health" ? new Response(null, { status: 404 }) : new Response(body)
      },
      { preconnect: fetch.preconnect },
    )
    expect(await runtime(value, requestFetch).health(id, password)).toBe(body === JSON.stringify({ healthy: true }))
    expect(paths).toEqual(["/global/health", "/api/health"])
  }
})

test("observed quota drift prevents resuming a stopped workspace", async () => {
  const value = fixture()
  value.state.present = true
  value.state.volume = true
  value.volume.Options.size = "0"
  await expect(runtime(value).start(id)).rejects.toThrow("unsafe_container")
  expect(value.commands.some((item) => item.args[1] === "start")).toBe(false)
})

test("stop retires an owned initializer even if the engine was never created", async () => {
  const value = fixture()
  value.state.initializers = [`vector-ws-${id}-init-deadbeef`]
  await runtime(value).stop(id)
  expect(value.state.present).toBe(false)
  expect(value.state.initializers).toEqual([])
})

test("stop cannot report success or delete data while an initializer remains active", async () => {
  const value = fixture()
  value.state.volume = true
  value.state.failInitRemoval = true
  value.state.initializers = [`vector-ws-${id}-init-deadbeef`]
  const docker = runtime(value)
  await expect(docker.stop(id)).rejects.toThrow("docker_command_failed")
  await expect(docker.remove(id, { deleteData: true })).rejects.toThrow("docker_command_failed")
  expect(value.state.volume).toBe(true)
  expect(value.commands.some((item) => item.args[0] === "volume" && item.args[1] === "rm")).toBe(false)
})

test("deletion before any resources were provisioned is idempotent after positive absence checks", async () => {
  const value = fixture()
  const docker = runtime(value)
  await docker.remove(id, { deleteData: true })
  await docker.remove(id, { deleteData: true })
  expect(value.state).toMatchObject({ present: false, volume: false, initializers: [] })
  expect(value.commands.filter((item) => item.args[0] === "volume" && item.args[1] === "ls")).toHaveLength(2)
  expect(value.commands.some((item) => item.args[1] === "rm")).toBe(false)
})

test("deletion refuses an existing foreign volume rather than treating it as absent", async () => {
  const value = fixture()
  value.state.volume = true
  value.volume.Labels[`${label}.id`] = "someone_else"
  await expect(runtime(value).remove(id, { deleteData: true })).rejects.toThrow("unsafe_container")
  expect(value.state.volume).toBe(true)
  expect(value.commands.some((item) => item.args[0] === "volume" && item.args[1] === "rm")).toBe(false)
})

test("a failed volume enumeration is uncertainty, never successful absent-resource deletion", async () => {
  const value = fixture()
  const docker = createDockerRuntime({
    image,
    network: "vector-cloud-test",
    volumeDriver: "quota-driver",
    run: async (command) =>
      command.args[0] === "volume" && command.args[1] === "ls" ? { code: 1, stdout: "" } : value.run(command),
  })
  await expect(docker.remove(id, { deleteData: true })).rejects.toThrow("docker_command_failed")
})

test("snapshot runs a networkless readonly helper only while paused and binds the exact preview to its digest", async () => {
  const value = fixture()
  value.state.present = true
  value.state.volume = true
  const result = await runtime(value).snapshot(id, { baseCommit })
  expect(result).toEqual({
    ...value.snapshot,
    digest: snapshotDigest(parseWorkspaceSnapshot(value.snapshot, baseCommit)),
  })
  const helper = value.commands.find((item) => item.args[0] === "container" && item.args[1] === "run")!
  expect(helper.args[helper.args.indexOf("--network") + 1]).toBe("none")
  expect(helper.args).toContain(`type=volume,source=vector-ws-data-${id},target=/data,readonly`)
  expect(helper.input).toBe(JSON.stringify({ baseCommit }))
  expect(helper.args.join(" ")).toContain("--no-replace-objects")
  expect(helper.args.join(" ")).toContain("--work-tree=")
  expect(helper.args.join(" ")).not.toContain(credential)
  expect(helper.env).toBeUndefined()
  expect(result.digest).not.toBe(snapshotDigest({ ...result, diff: result.diff + "changed" }))
})

test("running workspaces cannot produce a review snapshot", async () => {
  const value = fixture()
  value.state.present = true
  value.state.running = true
  await expect(runtime(value).snapshot(id, { baseCommit })).rejects.toThrow("workspace_not_running")
  expect(value.commands.some((item) => item.args[0] === "container" && item.args[1] === "run")).toBe(false)
})

test("snapshot admission refuses changed base, unsafe paths, duplicate changes, binary data and oversized previews", () => {
  const change = { path: "hello.txt", mode: "100644", content: Buffer.from("hello\n").toString("base64") }
  for (const patch of [
    { baseCommit: "f".repeat(40) },
    { changes: [{ ...change, path: "../secret" }] },
    { changes: [{ ...change, path: ".git/config" }] },
    { changes: [change, change] },
    { changes: [{ ...change, content: Buffer.from([0]).toString("base64") }] },
    { changes: [{ ...change, content: Buffer.from([255]).toString("base64") }] },
    { diff: "x".repeat(262145) },
  ])
    expect(() =>
      parseWorkspaceSnapshot({ baseCommit, changes: [change], diff: "+hello\n", ...patch }, baseCommit),
    ).toThrow("unsafe_container")
})

test("a repository initialization without a real base commit cannot launch an engine", async () => {
  const value = fixture()
  const docker = createDockerRuntime({
    image,
    network: "vector-cloud-test",
    volumeDriver: "quota-driver",
    run: async (command) =>
      command.args[0] === "container" && command.args[1] === "run"
        ? { code: 0, stdout: JSON.stringify({ baseCommit: null }) }
        : value.run(command),
  })
  await expect(docker.create(input)).rejects.toThrow("unsafe_container")
  expect(value.commands.some((item) => item.args[1] === "create" && item.args[0] === "container")).toBe(false)
})

test.skipIf(process.platform !== "linux")(
  "actual captured initialization and snapshot Python programs parse without executing repository code",
  async () => {
    const value = fixture()
    const docker = runtime(value)
    await docker.create(input)
    await docker.stop(id)
    await docker.snapshot(id, { baseCommit })
    const helpers = value.commands.filter((command) => command.args[0] === "container" && command.args[1] === "run")
    expect(helpers).toHaveLength(2)
    for (const helper of helpers) {
      const index = helper.args.indexOf("-c")
      expect(index).toBeGreaterThan(0)
      const source = helper.args[index + 1]!
      const result = spawnSync("python3", ["-c", "import ast, sys; ast.parse(sys.stdin.read())"], {
        input: source,
        encoding: "utf8",
        timeout: 5000,
        maxBuffer: 65536,
      })
      expect({ status: result.status, error: result.error?.message, stderr: result.stderr }).toEqual({
        status: 0,
        error: undefined,
        stderr: "",
      })
    }
  },
)

// INITIALIZE runs git from its own fixed PATH, so the clone cases need git there and python3 here.
const initializeGit = ["/usr/local/bin/git", "/usr/bin/git", "/bin/git"].find((file) => existsSync(file))
const canInitialize =
  process.platform !== "win32" &&
  initializeGit !== undefined &&
  spawnSync(initializeGit, ["--version"], { timeout: 5000 }).status === 0 &&
  spawnSync("python3", ["--version"], { timeout: 5000 }).status === 0

function git(home: string, args: string[], stdin?: string) {
  return spawnSync(initializeGit!, args, {
    input: stdin,
    encoding: "utf8",
    timeout: 20_000,
    maxBuffer: 16 * 1024 * 1024,
    env: {
      PATH: "/usr/local/bin:/usr/bin:/bin",
      HOME: home,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_TERMINAL_PROMPT: "0",
    },
  })
}

/** main has `main` commits; feature forks at main~`forkBack` and adds `feature` commits. */
function history(input: { main: number; forkBack: number; feature: number }) {
  let stream = ""
  let time = 1_700_000_000
  const commit = (ref: string, mark: number, file: string, from?: number) => {
    const message = `${file} ${mark}\n`
    stream +=
      `commit ${ref}\nmark :${mark}\ncommitter Fixture <fixture@example.invalid> ${time++} +0000\n` +
      `data ${Buffer.byteLength(message)}\n${message}${from ? `from :${from}\n` : ""}` +
      `M 644 inline ${file}\ndata ${Buffer.byteLength(message)}\n${message}\n`
  }
  for (let index = 1; index <= input.main; index++) commit("refs/heads/main", index, "main.txt")
  for (let index = 1; index <= input.feature; index++) {
    const fork = index === 1 ? input.main - input.forkBack : undefined
    commit("refs/heads/feature", input.main + index, "feature.txt", fork)
  }
  return stream
}

/** A local bare `vector/example.git` built with fast-import, whose HEAD names `head`. */
function remote(root: string, stream: string, head: string) {
  const bare = join(root, "remote", "vector", "example.git")
  for (const [args, stdin] of [
    [["init", "--bare", "--quiet", bare]],
    [["-C", bare, "symbolic-ref", "HEAD", head]],
    [["-C", bare, "fast-import", "--quiet"], stream],
  ] as [string[], string?][]) {
    const result = git(root, args, stdin)
    expect({ status: result.status, stderr: result.stderr }).toEqual({ status: 0, stderr: "" })
  }
  return {
    bare,
    rev: (spec: string) => git(root, ["-C", bare, "rev-parse", "--verify", spec]).stdout.trim(),
  }
}

/** Runs the captured INITIALIZE program against the local remote, with each substitution matching exactly once. */
async function initializeClone(root: string, ref: string) {
  const value = fixture()
  await runtime(value).create(input)
  const init = value.commands.find((item) => item.args[0] === "container" && item.args[1] === "run")!
  let source = init.args[init.args.indexOf("-c") + 1]!
  const substitute = (from: string, to: string) => {
    expect(source.split(from)).toHaveLength(2)
    source = source.replace(from, () => to)
  }
  substitute("pathlib.Path('/data')", `pathlib.Path(${JSON.stringify(join(root, "data"))})`)
  substitute("'HOME': '/data/home'", `'HOME': ${JSON.stringify(join(root, "data", "home"))}`)
  substitute("pathlib.Path('/run/git-credential')", `pathlib.Path(${JSON.stringify(join(root, "git-credential"))})`)
  substitute("'https://github.com/'", JSON.stringify(pathToFileURL(join(root, "remote")).href + "/"))
  substitute("'-c', 'protocol.file.allow=never', ", "")
  // Every git process the program starts, children included, appends its trace2 events here.
  const trace = join(root, "trace2.json")
  substitute("'GIT_LFS_SKIP_SMUDGE': '1'", `'GIT_LFS_SKIP_SMUDGE': '1', 'GIT_TRACE2_EVENT': ${JSON.stringify(trace)}`)
  const result = spawnSync("python3", ["-c", source], {
    input: JSON.stringify({ repository: { owner: "vector", repository: "example", ref }, model: input.model }),
    encoding: "utf8",
    timeout: 25_000,
    maxBuffer: 65536,
  })
  expect({ status: result.status, error: result.error?.message, stderr: result.stderr }).toEqual({
    status: 0,
    error: undefined,
    stderr: "",
  })
  const repository = join(root, "data", "repository")
  return {
    repository,
    baseCommit: (JSON.parse(result.stdout) as { baseCommit: string }).baseCommit,
    git: (...args: string[]) => git(root, ["-C", repository, ...args]),
    originHead: () => {
      const file = join(repository, ".git", "refs", "remotes", "origin", "HEAD")
      return existsSync(file) ? readFileSync(file, "utf8") : undefined
    },
    /** The git command name of every traced process, in order. */
    commands: () =>
      (existsSync(trace) ? readFileSync(trace, "utf8") : "")
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as { event: string; name?: string })
        .filter((event) => event.event === "cmd_name")
        .map((event) => event.name),
  }
}

test.skipIf(!canInitialize)(
  "the workspace clone records the default branch with enough history for a branch review",
  async () => {
    const root = mkdtempSync(join(tmpdir(), "vector-ws-clone-"))
    try {
      const origin = remote(root, history({ main: 80, forkBack: 40, feature: 100 }), "refs/heads/main")
      const clone = await initializeClone(root, "refs/heads/feature")
      expect(clone.baseCommit).toBe(origin.rev("refs/heads/feature"))
      // A loose symbolic ref, as ReadOnlyGit's default-branch read requires.
      expect(clone.originHead()).toBe("ref: refs/remotes/origin/main\n")
      const base = clone.git("merge-base", "HEAD", "origin/main")
      expect({ status: base.status, base: base.stdout.trim() }).toEqual({ status: 0, base: origin.rev("main~40") })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  },
)

test.skipIf(!canInitialize)(
  "a branch forked beyond the deepening cap still initializes, bounded-shallow, with the default branch recorded",
  async () => {
    const root = mkdtempSync(join(tmpdir(), "vector-ws-clone-"))
    try {
      const origin = remote(root, history({ main: 80, forkBack: 40, feature: 1200 }), "refs/heads/main")
      const clone = await initializeClone(root, "refs/heads/feature")
      expect(clone.baseCommit).toBe(origin.rev("refs/heads/feature"))
      expect(clone.originHead()).toBe("ref: refs/remotes/origin/main\n")
      const base = clone.git("merge-base", "HEAD", "origin/main")
      expect({ status: base.status, base: base.stdout.trim() }).toEqual({ status: 1, base: "" })
      // depth 64, then four rounds of 256 and no more
      expect(clone.git("rev-list", "--count", "HEAD").stdout.trim()).toBe(String(64 + 4 * 256))
      expect(clone.git("rev-parse", "--is-shallow-repository").stdout.trim()).toBe("true")
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  },
)

test.skipIf(!canInitialize)(
  "the clone's fetches start no automatic git maintenance, which would race the next fetch and die with the container",
  async () => {
    const root = mkdtempSync(join(tmpdir(), "vector-ws-clone-"))
    try {
      remote(root, history({ main: 80, forkBack: 40, feature: 1200 }), "refs/heads/main")
      const commands = (await initializeClone(root, "refs/heads/feature")).commands()
      expect(commands).toContain("fetch")
      expect(commands.filter((name) => name === "maintenance" || name === "gc" || name === "repack")).toEqual([])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  },
)

test.skipIf(!canInitialize)(
  "a default branch name outside the supervisor's branch rule leaves today's depth-1 clone",
  async () => {
    const root = mkdtempSync(join(tmpdir(), "vector-ws-clone-"))
    try {
      // Git accepts "odd+name"; the supervisor's validBranch rule does not.
      const stream = history({ main: 80, forkBack: 40, feature: 10 }) + "reset refs/heads/odd+name\nfrom :80\n\n"
      const origin = remote(root, stream, "refs/heads/odd+name")
      const clone = await initializeClone(root, "refs/heads/feature")
      expect(clone.baseCommit).toBe(origin.rev("refs/heads/feature"))
      expect(clone.originHead()).toBeUndefined()
      expect(clone.git("rev-parse", "--verify", "--quiet", "refs/remotes/origin/odd+name").status).toBe(1)
      expect(clone.git("rev-list", "--count", "HEAD").stdout.trim()).toBe("1")
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  },
)
