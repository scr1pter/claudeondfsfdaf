// Initial trusted CI phase only. Acceptance explicitly trusts the two pinned setup actions, not /opt ownership or hashes alone.
import fs from "node:fs"
import { ACTIONS, CONTROL, TEMP, ci, need, revision, stream, install, writeJSON } from "./common"

ci()
need(process.getuid?.() === 0 && process.argv.length === 5 && process.versions.node === "24.15.0")
const [node, bun, sourceRevision] = process.argv.slice(2)
need(revision(sourceRevision) && fs.realpathSync(process.execPath) === node)
fs.mkdirSync(CONTROL, { mode: 0o755 })
fs.mkdirSync(`${CONTROL}/runtime`, { mode: 0o755 })
const runtimes = [
  { path: "runtime/bun", source: bun },
  { path: "runtime/node", source: node },
].map((entry) => {
  // Setup-action paths may have writable ancestors. Capture one pinned FD before dependencies/payload, then
  // exclusively install its exact bytes. The declared source authenticity boundary is the pinned CI action.
  const info = stream(entry.source, { root: false })
  need(fs.statSync(entry.source).mode & 0o111)
  install(entry.source, `${CONTROL}/${entry.path}`, info, false)
  return { path: entry.path, bytes: info.bytes, sha256: info.sha256 }
})
const bootstrap = stream(`${TEMP}/native-shell-bootstrap.mjs`, { root: false })
install(`${TEMP}/native-shell-bootstrap.mjs`, `${CONTROL}/bootstrap.mjs`, bootstrap, false)
const sources = ["common.ts", "manage.ts"].map((name) => {
  const relative = `packages/engine/test/fixture/native-shell-ci/${name}`
  const source = stream(`${process.cwd()}/${relative}`, { root: false })
  return { path: relative, bytes: source.bytes, sha256: source.sha256 }
})
writeJSON(`${CONTROL}/provision.json`, {
  v: 1,
  sourceRevision,
  trust: "pinned-setup-actions-in-trusted-ci-before-payload",
  actions: ACTIONS,
  nodeVersion: "24.15.0",
  bunVersion: "1.3.14",
  runtimes,
  bootstrap: { bytes: bootstrap.bytes, sha256: bootstrap.sha256 },
  sources,
})
