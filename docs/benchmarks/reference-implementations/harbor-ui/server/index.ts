import { Database } from "bun:sqlite"
import { mkdirSync } from "node:fs"
import { resolve, join } from "node:path"

export type Actor = { id: string; name: string; role: string }
export type Step = { key: string; name: string; kind: string; dependsOn: string[]; durationMs: number; failureMode: string }
export type Project = { id: string; name: string; slug: string; description: string; createdAt: string; updatedAt: string }
export type Environment = { id: string; projectId: string; name: string; protected: boolean; activeReleaseId: string | null; createdAt: string; updatedAt: string }
export type Runbook = { id: string; projectId: string; name: string; description: string; version: number; steps: Step[]; createdAt: string; updatedAt: string }
export type Approval = { actorId: string; decision: string; comment: string; createdAt: string; revision: number }
export type Release = { id: string; projectId: string; environmentId: string; title: string; versionLabel: string; notes: string; authorId: string; status: string; revision: number; runbookId: string | null; runbookVersion: number | null; steps: Step[]; approvals: Approval[]; createdAt: string; updatedAt: string; submittedAt: string | null; startedAt: string | null; finishedAt: string | null; previousReleaseId: string | null }
export type Job = { id: string; releaseId: string; stepKey: string; name: string; kind: string; dependsOn: string[]; status: string; attempts: number; recoveryCount: number; startedAt: string | null; finishedAt: string | null; error: string | null; generation: number }
export type Log = { id: string; jobId: string; sequence: number; event: string; message: string; createdAt: string }
export type Artifact = { id: string; jobId: string; releaseId: string; name: string; size: number; sha256: string; createdAt: string; content: string }
export type Incident = { id: string; projectId: string; environmentId: string; releaseId: string | null; title: string; severity: string; status: string; summary: string; resolution: string; version: number; createdBy: string; createdAt: string; updatedAt: string; resolvedAt: string | null }
export type Note = { id: string; incidentId: string; actorId: string; body: string; createdAt: string }
export type Timeline = { id: string; incidentId: string; type: string; actorId: string; message: string; createdAt: string }
export type Audit = { id: string; sequence: number; projectId: string | null; actorId: string; type: string; entityId: string; details: Record<string, unknown>; createdAt: string }
type Receipt = { actorId: string; key: string; path: string; body: string; response: unknown }
type State = { actors: Actor[]; sessions: Record<string, string>; projects: Project[]; environments: Environment[]; runbooks: Runbook[]; releases: Release[]; jobs: Job[]; logs: Log[]; artifacts: Artifact[]; incidents: Incident[]; notes: Note[]; timeline: Timeline[]; audit: Audit[]; receipts: Receipt[] }
const dir = resolve(process.env.DATA_DIR || ".harbor-data")
mkdirSync(dir, { recursive: true })
const db = new Database(join(dir, "harbor.sqlite"), { create: true })
db.exec("PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS durable_state (id INTEGER PRIMARY KEY CHECK(id=1), body TEXT NOT NULL)")
const saved = db.query("SELECT body FROM durable_state WHERE id=1").get() as { body: string } | null
const state: State = saved ? JSON.parse(saved.body) : { actors: [{ id: "admin", name: "Avery Admin", role: "admin" }, { id: "operator", name: "Owen Operator", role: "operator" }, { id: "viewer", name: "Val Viewer", role: "viewer" }], sessions: {}, projects: [], environments: [], runbooks: [], releases: [], jobs: [], logs: [], artifacts: [], incidents: [], notes: [], timeline: [], audit: [], receipts: [] }
const persist = () => db.query("INSERT INTO durable_state (id,body) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body").run(JSON.stringify(state))
const now = () => new Date().toISOString()
const id = () => crypto.randomUUID()
const clone = <T>(value: T): T => structuredClone(value)
class Fault extends Error { constructor(public status: number, public code: string, message: string) { super(message) } }
const fail = (status: number, message: string): never => { throw new Fault(status, String(status), message) }
const text = (value: unknown, field: string, optional = false) => { if (value === undefined && optional) return ""; if (typeof value !== "string" || (!optional && !value.trim())) return fail(400, `${field} is required`); return value.trim() }
const integer = (value: unknown, field: string, min = 1, max = Number.MAX_SAFE_INTEGER) => { if (!Number.isInteger(value) || typeof value !== "number" || value < min || value > max) return fail(400, `${field} must be an integer from ${min} to ${max}`); return value }
const choice = (value: unknown, values: string[], field: string) => { if (typeof value !== "string" || !values.includes(value)) return fail(400, `Invalid ${field}`); return value }
function keys(body: Record<string, unknown>, allowed: string[]) { if (Object.keys(body).some(key => !allowed.includes(key))) fail(400, "Unexpected or protected field") }
function plan(value: unknown): Step[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 12) return fail(400, "A plan requires 1–12 steps")
  const steps = value.map((raw: unknown) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return fail(400, "Invalid step")
    const item = raw as Record<string, unknown>
    keys(item, ["key", "name", "kind", "dependsOn", "durationMs", "failureMode"])
    const key = text(item.key, "Step key")
    if (!/^[a-z0-9-]{1,32}$/.test(key)) fail(400, "Invalid step key")
    if (!Array.isArray(item.dependsOn) || item.dependsOn.some(dep => typeof dep !== "string") || new Set(item.dependsOn).size !== item.dependsOn.length) fail(400, "Invalid dependencies")
    return { key, name: text(item.name, "Step name"), kind: choice(item.kind, ["check", "build", "deploy"], "step kind"), dependsOn: item.dependsOn as string[], durationMs: integer(item.durationMs, "Duration", 100, 5000), failureMode: choice(item.failureMode, ["never", "once", "always"], "failure mode") }
  })
  if (new Set(steps.map(step => step.key)).size !== steps.length) fail(400, "Duplicate step key")
  const visit = (key: string, path: string[]): void => {
    if (path.includes(key)) fail(400, "Dependency graph contains a cycle")
    const step = steps.find(item => item.key === key) || fail(400, "Unknown dependency")
    step.dependsOn.forEach(dep => visit(dep, [...path, key]))
  }
  steps.forEach(step => visit(step.key, []))
  return steps
}
function find<T extends { id: string }>(list: T[], value: string): T { return list.find(item => item.id === value) || fail(404, "Resource not found") }
function scoped<T extends { id: string; projectId: string }>(list: T[], projectId: string, value: string): T { const item = find(list, value); if (item.projectId !== projectId) fail(404, "Resource not found"); return item }
function audit(projectId: string | null, actorId: string, type: string, entityId: string, details: Record<string, unknown> = {}) { state.audit.push({ id: id(), sequence: (state.audit.at(-1)?.sequence || 0) + 1, projectId, actorId, type, entityId, details, createdAt: now() }) }
function log(job: Job, event: string, message: string) { state.logs.push({ id: id(), jobId: job.id, sequence: state.logs.filter(item => item.jobId === job.id).length + 1, event, message, createdAt: now() }); const release = find(state.releases, job.releaseId); audit(release.projectId, "system", `job.${event}`, job.id, { releaseId: release.id, stepKey: job.stepKey, attempts: job.attempts }) }
function timeline(incident: Incident, actorId: string, type: string, message: string) { state.timeline.push({ id: id(), incidentId: incident.id, type, actorId, message, createdAt: now() }) }
function finish(release: Release) {
  const jobs = state.jobs.filter(job => job.releaseId === release.id)
  if (release.status !== "running" || jobs.some(job => ["queued", "running"].includes(job.status))) return
  release.status = jobs.every(job => job.status === "succeeded") ? "succeeded" : "failed"
  release.finishedAt = release.updatedAt = now()
  if (release.status === "succeeded") { const environment = find(state.environments, release.environmentId); release.previousReleaseId = environment.activeReleaseId; environment.activeReleaseId = release.id; environment.updatedAt = now() }
  audit(release.projectId, "system", `release.${release.status}`, release.id)
}
const configured = Number(process.env.WORKER_LIMIT || 2)
const limit = Number.isInteger(configured) && configured >= 1 && configured <= 4 ? configured : 2
function schedule() {
  state.jobs.filter(job => job.status === "queued").forEach(job => {
    if (job.dependsOn.some(dep => ["failed", "blocked", "cancelled"].includes(find(state.jobs, dep).status))) { job.status = "blocked"; job.finishedAt = now(); job.error = "A dependency did not succeed"; log(job, "blocked", job.error) }
  })
  state.releases.filter(release => release.status === "running").forEach(finish)
  const available = limit - state.jobs.filter(job => job.status === "running").length
  const runnable = state.jobs.filter(job => job.status === "queued" && job.dependsOn.every(dep => find(state.jobs, dep).status === "succeeded") && find(state.releases, job.releaseId).status === "running").slice(0, Math.max(0, available))
  runnable.forEach(job => {
    job.status = "running"; job.attempts++; job.startedAt = now(); job.finishedAt = null; job.error = null; job.generation++
    const generation = job.generation
    const release = find(state.releases, job.releaseId)
    const step = release.steps.find(item => item.key === job.stepKey)!
    log(job, "started", `Attempt ${job.attempts} started`)
    setTimeout(() => {
      if (job.status !== "running" || job.generation !== generation) return
      job.finishedAt = now()
      if (step.failureMode === "always" || (step.failureMode === "once" && job.attempts === 1)) { job.status = "failed"; job.error = "Synthetic step failure"; log(job, "failed", job.error) }
      else {
        job.status = "succeeded"; log(job, "succeeded", "Synthetic step completed")
        const content = `Harbor local artifact\nRelease: ${release.versionLabel}\nStep: ${job.stepKey}\nAttempt: ${job.attempts}\n`
        state.artifacts.push({ id: id(), jobId: job.id, releaseId: release.id, name: `${job.stepKey}-${job.attempts}.txt`, size: Buffer.byteLength(content), sha256: new Bun.CryptoHasher("sha256").update(content).digest("hex"), createdAt: now(), content })
      }
      schedule()
    }, step.durationMs)
  })
  persist()
}
state.jobs.filter(job => job.status === "running").forEach(job => { job.status = "queued"; job.recoveryCount++; job.generation++; log(job, "recovered", "Recovered interrupted work after restart") })
persist()
setInterval(schedule, 50)

const json = (value: unknown, status = 200, headers: Record<string, string> = {}) => Response.json(value, { status, headers })
const empty = () => new Response(null, { status: 204 })
function protectedWrite(actor: Actor) { if (actor.role === "viewer") fail(403, "Viewer cannot change operations") }
function admin(actor: Actor) { if (actor.role !== "admin") fail(403, "Admin permission required") }
function publicArtifact(artifact: Artifact) { const { content, ...publicFields } = artifact; return publicFields }
const server = Bun.serve({ hostname: "127.0.0.1", port: Number(process.env.PORT || 3000), async fetch(request) {
  try {
    const url = new URL(request.url)
    const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent)
    const method = request.method
    if (parts[0] !== "api") {
      const path = resolve("dist", "." + url.pathname)
      if (path.startsWith(resolve("dist") + "/") || path.startsWith(resolve("dist") + "\\")) { const file = Bun.file(path); if (await file.exists()) return new Response(file) }
      const index = Bun.file("dist/index.html")
      return await index.exists() ? new Response(index) : new Response("Build Harbor first", { status: 503 })
    }
    if (url.pathname === "/api/health" && method === "GET") return json({ ok: true })
    if (url.pathname === "/api/actors" && method === "GET") return json({ actors: state.actors })
    if (!["health", "actors", "session", "projects", "dashboard", "jobs", "artifacts", "audit"].includes(parts[1])) fail(404, "Unknown API route")
    let body: Record<string, unknown> = {}
    if (["POST", "PATCH"].includes(method)) {
      const raw = await request.text()
      try { const parsed: unknown = JSON.parse(raw || "{}"); if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) fail(400, "JSON object required"); body = parsed as Record<string, unknown> } catch { return json({ error: { code: "400", message: "Malformed JSON object" } }, 400) }
    }
    const token = request.headers.get("cookie")?.match(/(?:^|;\s*)harbor_session=([^;]+)/)?.[1]
    const actor = state.actors.find(item => item.id === (token && state.sessions[token]))
    if (url.pathname === "/api/session" && method === "POST") {
      keys(body, ["actorId"])
      const selected = state.actors.find(item => item.id === body.actorId) || fail(400, "Select a valid actor")
      const session = crypto.randomUUID() + crypto.randomUUID(); state.sessions[session] = selected.id; persist()
      return json({ actor: selected }, 200, { "Set-Cookie": `harbor_session=${session}; HttpOnly; SameSite=Lax; Path=/` })
    }
    if (!actor) return fail(401, "Select a local actor first")
    if (url.pathname === "/api/session") { if (method === "GET") return json({ actor }); if (method === "DELETE") { delete state.sessions[token!]; persist(); return new Response(null, { status: 204, headers: { "Set-Cookie": "harbor_session=; Max-Age=0; HttpOnly; SameSite=Lax; Path=/" } }) } }
    if (!["GET", "HEAD"].includes(method)) protectedWrite(actor)
    const response = route(parts, method, url, body, actor, request)
    persist()
    return response
  } catch (error) { if (error instanceof Fault) return json({ error: { code: error.code, message: error.message } }, error.status); console.error(error instanceof Error ? error.message : "Unexpected error"); return json({ error: { code: "500", message: "Operation failed" } }, 500) }
} })
console.log(`Harbor listening on ${server.url}`)

function route(parts: string[], method: string, url: URL, body: Record<string, unknown>, actor: Actor, request: Request): Response {
  const q = (url.searchParams.get("q") || "").toLowerCase()
  if (parts[1] === "dashboard" && parts.length === 2 && method === "GET") return json({ counts: { projects: state.projects.length, environments: state.environments.length, activeReleases: state.environments.filter(item => item.activeReleaseId).length, runningJobs: state.jobs.filter(item => item.status === "running").length, openIncidents: state.incidents.filter(item => item.status !== "resolved").length, failedReleases: state.releases.filter(item => item.status === "failed").length }, recentEvents: state.audit.slice(-15).reverse() })
  if (parts[1] === "audit" && parts.length === 2 && method === "GET") return json({ events: state.audit.filter(item => (!url.searchParams.get("projectId") || item.projectId === url.searchParams.get("projectId")) && (!url.searchParams.get("type") || item.type === url.searchParams.get("type")) && item.sequence > Number(url.searchParams.get("after") || 0)).slice(0, 200) })
  if (parts[1] === "jobs") {
    if (parts.length === 2 && method === "GET") return json({ jobs: state.jobs.filter(item => (!url.searchParams.get("status") || item.status === url.searchParams.get("status")) && (!url.searchParams.get("projectId") || find(state.releases, item.releaseId).projectId === url.searchParams.get("projectId"))) })
    const job = find(state.jobs, parts[2])
    if (parts.length === 3 && method === "GET") return json({ job })
    if (parts[3] === "logs" && parts.length === 4 && method === "GET") return json({ logs: state.logs.filter(item => item.jobId === job.id) })
  }
  if (parts[1] === "artifacts" && parts[3] === "content" && parts.length === 4 && method === "GET") { const artifact = find(state.artifacts, parts[2]); return new Response(artifact.content, { headers: { "Content-Type": "text/plain; charset=utf-8", "Content-Disposition": `attachment; filename="${artifact.name}"` } }) }
  if (parts[1] !== "projects") return fail(404, "Unknown API route")
  if (parts.length === 2) {
    if (method === "GET") return json({ projects: state.projects.filter(item => `${item.name} ${item.slug} ${item.description}`.toLowerCase().includes(q)) })
    if (method === "POST") {
      keys(body, ["name", "slug", "description"])
      const name = text(body.name, "Name"), slug = text(body.slug, "Slug"), description = text(body.description, "Description", true)
      if (!/^[a-z0-9-]{2,40}$/.test(slug)) fail(400, "Slug requires 2–40 lowercase letters, digits or hyphens")
      if (state.projects.some(item => item.slug === slug)) fail(409, "Project slug already exists")
      const project = { id: id(), name, slug, description, createdAt: now(), updatedAt: now() }; state.projects.push(project); audit(project.id, actor.id, "project.created", project.id, { name }); return json({ project }, 201)
    }
  }
  const project = find(state.projects, parts[2])
  if (parts.length === 3) {
    if (method === "GET") return json({ project })
    if (method === "PATCH") {
      keys(body, ["name", "slug", "description"])
      const patch = { name: body.name === undefined ? project.name : text(body.name, "Name"), slug: body.slug === undefined ? project.slug : text(body.slug, "Slug"), description: body.description === undefined ? project.description : text(body.description, "Description", true) }
      if (!/^[a-z0-9-]{2,40}$/.test(patch.slug)) fail(400, "Invalid slug")
      if (state.projects.some(item => item.id !== project.id && item.slug === patch.slug)) fail(409, "Project slug already exists")
      Object.assign(project, patch, { updatedAt: now() }); audit(project.id, actor.id, "project.updated", project.id, patch); return json({ project })
    }
    if (method === "DELETE") { if ([...state.environments, ...state.runbooks, ...state.releases, ...state.incidents].some(item => item.projectId === project.id)) fail(409, "Project still has operational records"); state.projects = state.projects.filter(item => item.id !== project.id); audit(project.id, actor.id, "project.deleted", project.id); return empty() }
  }
  if (parts[3] === "export" && parts.length === 4 && method === "GET") return json({ project, ...Object.fromEntries((["environments", "runbooks", "releases", "incidents"] as const).map(key => [key, state[key].filter(item => item.projectId === project.id)])) }, 200, { "Content-Disposition": `attachment; filename="${project.slug}-export.json"` })
  if (parts[3] === "environments") {
    if (parts.length === 4) {
      if (method === "GET") return json({ environments: state.environments.filter(item => item.projectId === project.id) })
      if (method === "POST") {
        keys(body, ["name", "protected"]); const name = text(body.name, "Name")
        if (body.protected !== undefined && typeof body.protected !== "boolean") fail(400, "Protected must be boolean")
        if (state.environments.some(item => item.projectId === project.id && item.name.toLowerCase() === name.toLowerCase())) fail(409, "Environment name already exists")
        const environment = { id: id(), projectId: project.id, name, protected: body.protected === true, activeReleaseId: null, createdAt: now(), updatedAt: now() }; state.environments.push(environment); audit(project.id, actor.id, "environment.created", environment.id, { name }); return json({ environment }, 201)
      }
    }
    const environment = scoped(state.environments, project.id, parts[4])
    if (parts.length === 5) {
      if (method === "GET") return json({ environment })
      if (method === "PATCH") {
        keys(body, ["name", "protected"]); const name = body.name === undefined ? environment.name : text(body.name, "Name")
        if (body.protected !== undefined && typeof body.protected !== "boolean") fail(400, "Protected must be boolean")
        if (state.environments.some(item => item.id !== environment.id && item.projectId === project.id && item.name.toLowerCase() === name.toLowerCase())) fail(409, "Environment name already exists")
        environment.name = name; if (body.protected !== undefined) environment.protected = body.protected as boolean; environment.updatedAt = now(); audit(project.id, actor.id, "environment.updated", environment.id, { name }); return json({ environment })
      }
      if (method === "DELETE") { if (state.releases.some(item => item.environmentId === environment.id) || state.incidents.some(item => item.environmentId === environment.id)) fail(409, "Environment is referenced"); state.environments = state.environments.filter(item => item.id !== environment.id); audit(project.id, actor.id, "environment.deleted", environment.id); return empty() }
    }
  }
  if (parts[3] === "runbooks") {
    if (parts.length === 4) {
      if (method === "GET") return json({ runbooks: state.runbooks.filter(item => item.projectId === project.id) })
      if (method === "POST") { keys(body, ["name", "description", "steps"]); const runbook = { id: id(), projectId: project.id, name: text(body.name, "Name"), description: text(body.description, "Description", true), version: 1, steps: plan(body.steps), createdAt: now(), updatedAt: now() }; state.runbooks.push(runbook); audit(project.id, actor.id, "runbook.created", runbook.id, { name: runbook.name, version: 1 }); return json({ runbook }, 201) }
    }
    const runbook = scoped(state.runbooks, project.id, parts[4])
    if (parts.length === 5) {
      if (method === "GET") return json({ runbook })
      if (method === "PATCH") { keys(body, ["expectedVersion", "name", "description", "steps"]); if (integer(body.expectedVersion, "Expected version") !== runbook.version) fail(409, "Runbook changed; reload and review the latest version"); const patch = { name: body.name === undefined ? runbook.name : text(body.name, "Name"), description: body.description === undefined ? runbook.description : text(body.description, "Description", true), steps: body.steps === undefined ? runbook.steps : plan(body.steps) }; Object.assign(runbook, patch, { version: runbook.version + 1, updatedAt: now() }); audit(project.id, actor.id, "runbook.updated", runbook.id, { version: runbook.version }); return json({ runbook }) }
      if (method === "DELETE") { state.runbooks = state.runbooks.filter(item => item.id !== runbook.id); audit(project.id, actor.id, "runbook.deleted", runbook.id); return empty() }
    }
  }
  if (parts[3] === "releases") {
    if (parts.length === 4) {
      if (method === "GET") return json({ releases: state.releases.filter(item => item.projectId === project.id && `${item.title} ${item.versionLabel} ${item.notes}`.toLowerCase().includes(q) && (!url.searchParams.get("status") || item.status === url.searchParams.get("status")) && (!url.searchParams.get("environmentId") || item.environmentId === url.searchParams.get("environmentId"))) })
      if (method === "POST") {
        keys(body, ["environmentId", "title", "versionLabel", "notes", "runbookId", "steps"])
        const environment = scoped(state.environments, project.id, text(body.environmentId, "Environment"))
        const versionLabel = text(body.versionLabel, "Version label"), title = text(body.title, "Title"), notes = text(body.notes, "Notes", true)
        if ((body.runbookId !== undefined) === (body.steps !== undefined)) fail(400, "Specify one runbook or steps")
        const runbook = body.runbookId === undefined ? null : scoped(state.runbooks, project.id, text(body.runbookId, "Runbook"))
        const steps = runbook ? clone(runbook.steps) : plan(body.steps)
        if (state.releases.some(item => item.environmentId === environment.id && item.versionLabel === versionLabel)) fail(409, "Version label already exists in environment")
        const release: Release = { id: id(), projectId: project.id, environmentId: environment.id, title, versionLabel, notes, authorId: actor.id, status: "draft", revision: 1, runbookId: runbook?.id || null, runbookVersion: runbook?.version || null, steps, approvals: [], createdAt: now(), updatedAt: now(), submittedAt: null, startedAt: null, finishedAt: null, previousReleaseId: null }; state.releases.push(release); audit(project.id, actor.id, "release.created", release.id, { versionLabel }); return json({ release }, 201)
      }
    }
    const release = scoped(state.releases, project.id, parts[4])
    if (parts.length === 5) {
      if (method === "GET") return json({ release })
      if (method === "PATCH") {
        keys(body, ["expectedRevision", "title", "versionLabel", "notes", "steps"]); if (release.status !== "draft") fail(409, "Only drafts can be edited"); if (integer(body.expectedRevision, "Expected revision") !== release.revision) fail(409, "Release changed; reload the latest revision")
        const patch = { title: body.title === undefined ? release.title : text(body.title, "Title"), versionLabel: body.versionLabel === undefined ? release.versionLabel : text(body.versionLabel, "Version label"), notes: body.notes === undefined ? release.notes : text(body.notes, "Notes", true), steps: body.steps === undefined ? release.steps : plan(body.steps) }
        if (state.releases.some(item => item.id !== release.id && item.environmentId === release.environmentId && item.versionLabel === patch.versionLabel)) fail(409, "Version label already exists")
        Object.assign(release, patch, { revision: release.revision + 1, updatedAt: now() }); if (body.steps !== undefined) { release.runbookId = null; release.runbookVersion = null } audit(project.id, actor.id, "release.updated", release.id, { revision: release.revision }); return json({ release })
      }
    }
    if (parts.length === 6 && method === "GET" && parts[5] === "jobs") return json({ jobs: state.jobs.filter(item => item.releaseId === release.id) })
    if (parts.length === 6 && method === "GET" && parts[5] === "artifacts") return json({ artifacts: state.artifacts.filter(item => item.releaseId === release.id).map(publicArtifact) })
    if (parts.length === 6 && method === "POST") {
      const action = parts[5]
      if (action === "run") {
        const key = request.headers.get("Idempotency-Key")
        if (!key || !/^[\x20-\x7e]{1,100}$/.test(key)) return fail(400, "Idempotency-Key required")
        const receipt = state.receipts.find(item => item.actorId === actor.id && item.key === key)
        if (receipt) { if (receipt.path !== url.pathname || receipt.body !== JSON.stringify(body)) fail(409, "Idempotency key conflicts with prior operation"); return json(receipt.response) }
        keys(body, [])
        if (release.status !== "ready") fail(409, "Release must be ready")
        const jobs: Job[] = release.steps.map(step => ({ id: id(), releaseId: release.id, stepKey: step.key, name: step.name, kind: step.kind, dependsOn: [], status: "queued", attempts: 0, recoveryCount: 0, startedAt: null, finishedAt: null, error: null, generation: 0 }))
        jobs.forEach(job => { job.dependsOn = release.steps.find(step => step.key === job.stepKey)!.dependsOn.map(key => jobs.find(item => item.stepKey === key)!.id) })
        state.jobs.push(...jobs); release.status = "running"; release.startedAt = release.updatedAt = now(); jobs.forEach(job => log(job, "queued", "Waiting for worker and dependencies")); audit(project.id, actor.id, "release.started", release.id)
        const response = clone({ release, jobs }); state.receipts.push({ actorId: actor.id, key, path: url.pathname, body: JSON.stringify(body), response }); return json(response)
      }
      if (action === "submit") {
        keys(body, ["expectedRevision"]); if (release.status !== "draft") fail(409, "Only drafts can be submitted"); if (integer(body.expectedRevision, "Expected revision") !== release.revision) fail(409, "Release changed")
        release.status = find(state.environments, release.environmentId).protected ? "awaiting_approval" : "ready"; release.revision++; release.submittedAt = release.updatedAt = now(); audit(project.id, actor.id, "release.submitted", release.id, { revision: release.revision, status: release.status }); return json({ release })
      }
      if (action === "approve") {
        admin(actor); keys(body, ["expectedRevision", "decision", "comment"]); const decision = choice(body.decision, ["approve", "reject"], "decision"), comment = text(body.comment, "Comment")
        if (release.status !== "awaiting_approval") fail(409, "Release is not awaiting approval"); if (release.authorId === actor.id) fail(409, "A release author cannot review their own plan"); if (integer(body.expectedRevision, "Expected revision") !== release.revision) fail(409, "Release changed")
        release.approvals.push({ actorId: actor.id, decision, comment, createdAt: now(), revision: release.revision }); release.status = decision === "approve" ? "ready" : "draft"; release.revision++; release.updatedAt = now(); audit(project.id, actor.id, `release.${decision === "approve" ? "approved" : "rejected"}`, release.id, { comment, revision: release.revision }); return json({ release })
      }
      if (action === "cancel") {
        keys(body, ["reason"]); const reason = text(body.reason, "Reason"); if (release.status !== "running") fail(409, "Only running releases can be cancelled")
        release.status = "cancelled"; release.finishedAt = release.updatedAt = now(); state.jobs.filter(job => job.releaseId === release.id && ["running", "queued"].includes(job.status)).forEach(job => { job.status = "cancelled"; job.generation++; job.finishedAt = now(); job.error = reason; log(job, "cancelled", reason) }); audit(project.id, actor.id, "release.cancelled", release.id, { reason }); return json({ release })
      }
      if (action === "retry") {
        keys(body, []); if (release.status !== "failed") fail(409, "Only failed releases can be retried"); state.jobs.filter(job => job.releaseId === release.id && ["failed", "blocked"].includes(job.status)).forEach(job => { job.status = "queued"; job.finishedAt = null; job.error = null; log(job, "queued", "Retry requested") }); release.status = "running"; release.finishedAt = null; release.updatedAt = now(); audit(project.id, actor.id, "release.retried", release.id); return json({ release })
      }
      if (action === "rollback") {
        admin(actor); keys(body, ["reason"]); const reason = text(body.reason, "Reason"), environment = find(state.environments, release.environmentId)
        if (release.status !== "succeeded" || environment.activeReleaseId !== release.id || !release.previousReleaseId) fail(409, "Rollback requires the active successful release and a predecessor")
        const target = find(state.releases, release.previousReleaseId || fail(409, "No successful rollback target")); if (target.environmentId !== environment.id || target.status !== "succeeded") fail(409, "No successful rollback target")
        environment.activeReleaseId = target.id; environment.updatedAt = now(); release.status = "rolled_back"; release.updatedAt = now(); audit(project.id, actor.id, "release.rolled_back", release.id, { reason, targetReleaseId: target.id }); return json({ release })
      }
    }
  }
  if (parts[3] === "incidents") {
    if (parts.length === 4) {
      if (method === "GET") return json({ incidents: state.incidents.filter(item => item.projectId === project.id && `${item.title} ${item.summary}`.toLowerCase().includes(q) && (!url.searchParams.get("status") || item.status === url.searchParams.get("status")) && (!url.searchParams.get("severity") || item.severity === url.searchParams.get("severity"))) })
      if (method === "POST") {
        keys(body, ["environmentId", "releaseId", "title", "severity", "summary"]); const environment = scoped(state.environments, project.id, text(body.environmentId, "Environment")), linked = body.releaseId ? scoped(state.releases, project.id, text(body.releaseId, "Release")) : null
        if (linked && linked.environmentId !== environment.id) fail(404, "Release does not belong to environment")
        const incident: Incident = { id: id(), projectId: project.id, environmentId: environment.id, releaseId: linked?.id || null, title: text(body.title, "Title"), severity: choice(body.severity, ["sev1", "sev2", "sev3"], "severity"), status: "open", summary: text(body.summary, "Summary", true), resolution: "", version: 1, createdBy: actor.id, createdAt: now(), updatedAt: now(), resolvedAt: null }; state.incidents.push(incident); timeline(incident, actor.id, "created", incident.title); audit(project.id, actor.id, "incident.created", incident.id, { title: incident.title }); return json({ incident }, 201)
      }
    }
    const incident = scoped(state.incidents, project.id, parts[4])
    if (parts.length === 5) {
      if (method === "GET") return json({ incident })
      if (method === "PATCH") {
        keys(body, ["expectedVersion", "title", "severity", "summary", "status", "resolution"]); if (integer(body.expectedVersion, "Expected version") !== incident.version) fail(409, "Incident changed; reload the latest version")
        const status = body.status === undefined ? incident.status : choice(body.status, ["open", "mitigated", "resolved"], "status")
        const transitions: Record<string, string[]> = { open: ["open", "mitigated", "resolved"], mitigated: ["mitigated", "open", "resolved"], resolved: ["resolved", "open"] }
        if (!transitions[incident.status].includes(status)) fail(409, "Invalid incident transition")
        if (status === "resolved" && incident.status !== "resolved") text(body.resolution, "Resolution")
        const patch = { title: body.title === undefined ? incident.title : text(body.title, "Title"), severity: body.severity === undefined ? incident.severity : choice(body.severity, ["sev1", "sev2", "sev3"], "severity"), summary: body.summary === undefined ? incident.summary : text(body.summary, "Summary", true), resolution: body.resolution === undefined ? incident.resolution : text(body.resolution, "Resolution", true) }
        const previous = incident.status; Object.assign(incident, patch, { status, version: incident.version + 1, updatedAt: now() }); if (status !== previous) { incident.resolvedAt = status === "resolved" ? now() : null; timeline(incident, actor.id, "status", `${previous} → ${status}${status === "resolved" ? ": " + incident.resolution : ""}`) } audit(project.id, actor.id, "incident.updated", incident.id, { previousStatus: previous, status, version: incident.version }); return json({ incident })
      }
    }
    if (parts.length === 6 && parts[5] === "notes") {
      if (method === "GET") return json({ notes: state.notes.filter(item => item.incidentId === incident.id) })
      if (method === "POST") { keys(body, ["body"]); const content = text(body.body, "Note"); if (content.length > 4000) fail(400, "Note exceeds 4000 characters"); const note = { id: id(), incidentId: incident.id, actorId: actor.id, body: content, createdAt: now() }; state.notes.push(note); timeline(incident, actor.id, "note", content); audit(project.id, actor.id, "incident.note_added", incident.id, { noteId: note.id }); return json({ note }, 201) }
    }
    if (parts.length === 6 && parts[5] === "timeline" && method === "GET") return json({ events: state.timeline.filter(item => item.incidentId === incident.id) })
  }
  return fail(404, "Unknown API route")
}

