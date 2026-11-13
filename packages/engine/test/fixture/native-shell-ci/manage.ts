// Installed Root-owned CI management entry; no workspace/code fallback after prepare.
import fs from "node:fs"
import { execFileSync } from "node:child_process"
import {
  CONTROL,
  ROOT,
  TEMP,
  WORKSPACE,
  OUTPUT,
  READER_SHA,
  CATALOG_SHA,
  SUPPORT,
  type Asset,
  cell,
  ci,
  need,
  object,
  exact,
  hashValue,
  revision,
  assets,
  stream,
  jsonFile,
  install,
  writeJSON,
  control,
} from "./common"

async function main() {
  ci()
  const operation = process.argv[2]
  if (operation === "install") {
    need(process.getuid?.() === 0 && process.argv.length === 7)
    const [expectedSHA, runtime, mode, family] = process.argv.slice(3)
    need(hashValue(expectedSHA))
    const selected = cell(runtime, mode, family)
    const read = stream(`${OUTPUT}/receipt.json`, { root: false, collect: 16_384 })
    need(read.sha256 === expectedSHA && read.data)
    const receipt: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(read.data))
    exact(receipt, [
      "v",
      "sourceRevision",
      "assetSHA256",
      "readerSHA256",
      "catalogSHA256",
      "workerSHA256",
      "provisionSHA256",
      "outputs",
    ])
    need(
      receipt.v === 1 &&
        revision(receipt.sourceRevision) &&
        hashValue(receipt.assetSHA256) &&
        receipt.readerSHA256 === READER_SHA &&
        receipt.catalogSHA256 === CATALOG_SHA &&
        hashValue(receipt.workerSHA256) &&
        hashValue(receipt.provisionSHA256),
    )
    const provenance = jsonFile(`${CONTROL}/provision.json`)
    need(
      object(provenance) &&
        provenance.sourceRevision === receipt.sourceRevision &&
        stream(`${CONTROL}/provision.json`).sha256 === receipt.provisionSHA256,
    )
    const runtimes = assets(provenance.runtimes)
    need(runtimes.length === 2 && runtimes[0].path === "runtime/bun" && runtimes[1].path === "runtime/node")
    need(Array.isArray(receipt.outputs) && receipt.outputs.length === 19)
    const outputs = receipt.outputs.map((entry: unknown) => {
      exact(entry, ["path", "bytes", "sha256", "kind"])
      need(
        typeof entry.path === "string" &&
          typeof entry.bytes === "number" &&
          Number.isSafeInteger(entry.bytes) &&
          entry.bytes >= 0 &&
          entry.bytes <= 268_435_456 &&
          hashValue(entry.sha256),
      )
      const match = /^(node|bun)\/(native-shell-(engine|host|payload)\.js|[^/]+\.wasm)$/.exec(entry.path)
      const support = match && Object.entries(SUPPORT).find(([name]) => name === match[2])
      need(
        (match &&
          (support
            ? entry.kind === "asset" && entry.sha256 === support[1]
            : match[3] && entry.kind === "entry-point")) ||
          (/^control\/(controller|preflight|manage)\.mjs$/.test(entry.path) && entry.kind === "entry-point"),
      )
      return { path: entry.path, bytes: entry.bytes, sha256: entry.sha256 }
    })
    need(outputs.every((entry, index) => index === 0 || outputs[index - 1].path < entry.path))
    const bootstrap = provenance.bootstrap
    exact(bootstrap, ["bytes", "sha256"])
    need(
      typeof bootstrap.bytes === "number" &&
        Number.isSafeInteger(bootstrap.bytes) &&
        bootstrap.bytes > 0 &&
        bootstrap.bytes <= 268_435_456 &&
        hashValue(bootstrap.sha256),
    )
    stream(`${CONTROL}/bootstrap.mjs`, { expected: { bytes: bootstrap.bytes, sha256: bootstrap.sha256 } })
    // This program was installed before dependencies. Never replace its authority with a newly compiled manager.
    need(
      outputs.some(
        (entry) =>
          entry.path === "control/manage.mjs" && entry.bytes === bootstrap.bytes && entry.sha256 === bootstrap.sha256,
      ),
    )
    fs.mkdirSync(ROOT, { mode: 0o755 })
    fs.mkdirSync(`${ROOT}/runtime`, { mode: 0o755 })
    fs.mkdirSync(`${CONTROL}/probe`, { mode: 0o755 })
    const installed: Asset[] = []
    for (const entry of outputs) {
      if (entry.path.startsWith("control/")) {
        install(`${OUTPUT}/${entry.path}`, `${CONTROL}/${entry.path.slice(8)}`, entry, false)
        continue
      }
      const [target, name] = entry.path.split("/")
      if (name === "native-shell-host.js" ? target !== "node" : target !== selected.runtime) continue
      const destination = /^native-shell-(engine|host|payload)\.js$/.exec(name)
      const relative = destination ? `${destination[1]}.mjs` : name
      install(
        `${OUTPUT}/${entry.path}`,
        `${ROOT}/${relative}`,
        entry,
        false,
        relative.endsWith(".wasm") ? 0o444 : 0o555,
      )
      installed.push({ path: relative, bytes: entry.bytes, sha256: entry.sha256 })
    }
    for (const entry of runtimes) {
      if (entry.path === "runtime/bun" && selected.runtime === "node") continue
      install(`${CONTROL}/${entry.path}`, `${ROOT}/${entry.path}`, entry)
      installed.push(entry)
    }
    installed.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    need(installed.length === (selected.runtime === "bun" ? 10 : 9))
    const shim = `#!/bin/sh\n[ "$#" -eq 3 ] && [ "$1" = github ] && [ "$2" = sandbox ] || exit 125\ncase "$3" in prepare|finish) ;; *) exit 125 ;; esac\nexec ${CONTROL}/runtime/node ${CONTROL}/controller.mjs "$@"\n`
    fs.writeFileSync(`${CONTROL}/vector`, shim, { flag: "wx", mode: 0o555 })
    writeJSON(`${CONTROL}/cell.json`, selected)
    const names = [
      "bootstrap.mjs",
      "controller.mjs",
      "preflight.mjs",
      "manage.mjs",
      "vector",
      "cell.json",
      "provision.json",
      "runtime/node",
      "runtime/bun",
    ]
    const files = names
      .map((name) => {
        const info = stream(`${CONTROL}/${name}`)
        return { path: name, bytes: info.bytes, sha256: info.sha256 }
      })
      .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    writeJSON(`${CONTROL}/receipt.json`, {
      v: 1,
      sourceRevision: receipt.sourceRevision,
      assetSHA256: receipt.assetSHA256,
      readerSHA256: READER_SHA,
      catalogSHA256: CATALOG_SHA,
      workerSHA256: receipt.workerSHA256,
      provisionSHA256: receipt.provisionSHA256,
      ...selected,
      workspace: WORKSPACE,
      assets: files,
    })
    writeJSON(`${ROOT}/installed.json`, { v: 1, assets: installed })
    control()
    return
  }
  const selected = control()
  const installed = jsonFile(`${ROOT}/installed.json`)
  exact(installed, ["v", "assets"])
  need(installed.v === 1)
  const files = assets(installed.assets)
  const required = new Set([
    "engine.mjs",
    "host.mjs",
    "payload.mjs",
    "runtime/node",
    ...(selected.runtime === "bun" ? ["runtime/bun"] : []),
    ...Object.keys(SUPPORT),
  ])
  need(files.length === required.size && files.every((entry) => required.has(entry.path)))
  for (const entry of files) stream(`${ROOT}/${entry.path}`, { expected: entry })
  if (operation === "workspace") {
    need(process.argv.length === 3 && process.getuid?.() !== 0)
    fs.mkdirSync(WORKSPACE, { mode: 0o700 })
    fs.writeFileSync(`${WORKSPACE}/README.md`, "Synthetic native Shell seam repository\n", { flag: "wx", mode: 0o600 })
    const env = { PATH: "/usr/bin:/bin", LC_ALL: "C", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" }
    execFileSync("/usr/bin/git", ["init", "--quiet", WORKSPACE], { env, stdio: "ignore" })
    execFileSync("/usr/bin/git", ["-C", WORKSPACE, "add", "README.md"], { env, stdio: "ignore" })
    execFileSync(
      "/usr/bin/git",
      [
        "-C",
        WORKSPACE,
        "-c",
        "user.name=Native Shell fixture",
        "-c",
        "user.email=native-shell@vector.test",
        "-c",
        "commit.gpgsign=false",
        "commit",
        "-qm",
        "Synthetic Shell fixture",
      ],
      { env, stdio: "ignore" },
    )
    return
  }
  if (operation === "manifest") {
    need(process.argv.length === 3 && process.getuid?.() === 0)
    const spec = jsonFile("/usr/libexec/vector-sandbox/v1/run.json")
    need(
      object(spec) &&
        ["/mnt/vector-agent-sandbox", "/var/lib/vector-agent-sandbox", "/home/vector-agent-sandbox"].includes(
          String(spec.container),
        ) &&
        typeof spec.nonce === "string" &&
        /^[a-f0-9]{32}$/.test(spec.nonce) &&
        typeof spec.uid === "number" &&
        Number.isSafeInteger(spec.uid) &&
        spec.uid > 0 &&
        typeof spec.gid === "number" &&
        Number.isSafeInteger(spec.gid) &&
        spec.gid > 0,
    )
    const observer = `${spec.container}/native-shell-observer`
    fs.mkdirSync(observer, { mode: 0o755 })
    for (const parent of [
      "/home/vector-agent",
      "/tmp",
      "/var/tmp",
      "/run",
      TEMP,
      "/home/vector-agent/.config/vector",
      "/home/vector-agent/.local/share/vector",
      "/home/vector-agent/.cache/vector",
      "/home/vector-agent/tmp/vector-agent",
    ])
      fs.writeFileSync(`${parent}/native-shell-canary-${spec.nonce}`, "native-shell-synthetic-canary\n", {
        flag: "wx",
        mode: 0o444,
      })
    fs.writeFileSync(`${ROOT}/readonly-control.txt`, "synthetic readonly mount control\n", { flag: "wx", mode: 0o666 })
    fs.chownSync(`${ROOT}/readonly-control.txt`, spec.uid, spec.gid)
    fs.chmodSync(`${ROOT}/readonly-control.txt`, 0o666)
    const hash = (name: string) => {
      const entry = files.find((file) => file.path === `${name}.mjs`)
      need(entry)
      return entry.sha256
    }
    writeJSON(`${ROOT}/manifest.json`, {
      v: 1,
      nonce: spec.nonce,
      runtime: selected.runtime,
      mode: selected.mode,
      family: selected.family,
      sourceRevision: selected.sourceRevision,
      runtimePath: `${ROOT}/runtime/${selected.runtime}`,
      observer,
      fixtureSHA256: { engine: hash("engine"), host: hash("host"), payload: hash("payload") },
      assets: files,
    })
    return
  }
  if (operation === "verify") {
    need(process.argv.length === 3)
    const manifest = jsonFile(`${ROOT}/manifest.json`)
    exact(manifest, [
      "v",
      "nonce",
      "runtime",
      "mode",
      "family",
      "sourceRevision",
      "runtimePath",
      "observer",
      "fixtureSHA256",
      "assets",
    ])
    need(
      manifest.v === 1 &&
        manifest.sourceRevision === selected.sourceRevision &&
        manifest.runtime === selected.runtime &&
        manifest.mode === selected.mode &&
        manifest.family === selected.family &&
        manifest.runtimePath === `${ROOT}/runtime/${selected.runtime}` &&
        JSON.stringify(manifest.assets) === JSON.stringify(files),
    )
    const hashes = manifest.fixtureSHA256
    exact(hashes, ["engine", "host", "payload"])
    for (const name of ["engine", "host", "payload"])
      need(files.some((file) => file.path === `${name}.mjs` && file.sha256 === hashes[name]))
    return
  }
  if (operation === "assert") {
    need(process.argv.length === 7 && process.argv.slice(3).every((value) => value === "success"))
    const report = jsonFile(
      `${TEMP}/native-shell-${selected.runtime}-${selected.mode}-${selected.family}.json`,
      false,
      1_048_576,
    )
    need(
      object(report) &&
        report.v === 1 &&
        report.sourceRevision === selected.sourceRevision &&
        report.runtime === selected.runtime &&
        report.mode === selected.mode &&
        report.family === selected.family &&
        report.assetSHA256 === selected.assetSHA256 &&
        report.bootstrapOmission === "aggregate-instance-bootstrap-only" &&
        report.stoppedBeforeUidSweep === true &&
        report.profileQualification === "separate-required-workflow-gate" &&
        Array.isArray(report.cases),
    )
    const expected =
      selected.family === "baseline"
        ? [
            "inspect",
            "nonzero",
            "timeout",
            "abort",
            "shell-pipeline",
            "stdio",
            "delayed",
            "pipeline",
            "fd-source",
            "fd-dest",
          ]
        : ["death"]
    const rows = report.cases.map((entry: unknown) => {
      need(object(entry) && typeof entry.case === "string")
      return entry
    })
    const kernel = rows.filter((entry) => entry.kernelVerified === true).map((entry) => entry.case)
    const done = rows.filter((entry) => entry.stoppedBeforeUidSweep === true).map((entry) => entry.case)
    need(
      rows.length === (selected.family === "baseline" ? 18 : 1) &&
        JSON.stringify(kernel) === JSON.stringify(expected.filter((name) => !name.startsWith("fd-"))) &&
        JSON.stringify(done) === JSON.stringify(selected.family === "baseline" ? expected : []),
    )
    process.stdout.write(
      "Actual same-host Reader and Shell seam cell succeeded; full bootstrap/floor remain unqualified\n",
    )
    return
  }
  need(false)
}
void main().catch(() => {
  process.stderr.write("Native Shell CI management refused\n")
  process.exitCode = 125
})
