export * as BrainUpload from "./upload"

// Browser-safe desktop adapter. Its transport lives in the desktop's authenticated account bridge; no account
// credential or server-chosen URL is accepted here. Merely previewing repository context performs no upload.
export type Selection = { readonly bytes: Uint8Array; readonly sha256: string }
export type Reference = { readonly uploadId: string; readonly sha256: string }
export type Transport = (kind: "prepare" | "commit", body: Readonly<Record<string, unknown>>) => Promise<unknown>
export function base64url(bytes: Uint8Array) {
  let binary = ""
  for (let start = 0; start < bytes.length; start += 8192) binary += String.fromCharCode(...bytes.subarray(start, start + 8192))
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}
export function fromBase64url(value: string) {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("Invalid Brain attachment encoding.")
  const binary = atob(value.replace(/-/g, "+").replace(/_/g, "/"))
  const bytes = Uint8Array.from(binary, (item) => item.charCodeAt(0))
  if (base64url(bytes) !== value) throw new Error("Invalid Brain attachment encoding.")
  return bytes
}
const record = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === "object" && !Array.isArray(value))
const digest = async (bytes: Uint8Array) => Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", Uint8Array.from(bytes))),
  (byte) => byte.toString(16).padStart(2, "0")).join("")

/** All payload inspection happens locally. Vector's upload server receives and stores only opaque ciphertext. */
export function validate(bytes: Uint8Array, publicRepository: boolean) {
  let value: unknown
  try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) }
  catch { throw new Error("Invalid repository Brain preview. Prepare it again locally.") }
  const refuse = () => new Error("This Brain preview contains private, personal, or unsupported context. Prepare it again locally.")
  if (!record(value) || value.format !== "vector-brain-run" || value.version !== 1 ||
    Object.keys(value).some((item) => !["format", "version", "memory", "insights"].includes(item)) ||
    !record(value.memory) || value.memory.format !== "vector-memory" || value.memory.version !== 1 || value.memory.scope !== "repository" ||
    !Array.isArray(value.memory.documents) || value.memory.documents.length || !Array.isArray(value.memory.entries) || value.memory.entries.length > 200 ||
    (value.memory.skills !== undefined && (!Array.isArray(value.memory.skills) || value.memory.skills.length > 20)) ||
    !record(value.insights) || value.insights.format !== "vector-workflow-insights" || value.insights.version !== 1 ||
    !Array.isArray(value.insights.rows) || value.insights.rows.length > 100) throw refuse()
  const kinds = new Set(["decision", "lesson", "fact", "term", "failure"])
  for (const entry of value.memory.entries) if (!record(entry) || entry.scope !== "repository" || entry.status !== "active" ||
    entry.private || entry.file || entry.skill || typeof entry.kind !== "string" || !kinds.has(entry.kind)) throw refuse()
  const skills = value.memory.skills ?? []
  if (!Array.isArray(skills) || (publicRepository && skills.length)) throw refuse()
  for (const entry of skills) if (!record(entry) || entry.scope !== "repository" || entry.status !== "active" ||
    entry.private || entry.file || entry.kind !== "skill" || !record(entry.skill)) throw refuse()
  for (const row of value.insights.rows) if (!record(row) || Object.keys(row).some((item) =>
    !["tier", "model", "effort", "split", "runs", "passRate", "checkedShare"].includes(item))) throw refuse()
}

/** Call only after the owner approves this exact preview and taps Start from the desktop dispatch form. */
export async function upload(input: {
  repositoryId: string; selection: Selection; approvedSha256: string; includeBrain: boolean; transport: Transport
}): Promise<Reference> {
  const { selection } = input
  if (!input.includeBrain || !/^[1-9]\d{0,15}$/.test(input.repositoryId) || !Number.isSafeInteger(Number(input.repositoryId)) ||
    selection.bytes.byteLength < 1 || selection.bytes.byteLength > 512 * 1024 || !/^[0-9a-f]{64}$/.test(selection.sha256) ||
    input.approvedSha256 !== selection.sha256 || await digest(selection.bytes) !== selection.sha256)
    throw new Error("Review and approve the exact Brain attachment before starting this run.")
  validate(selection.bytes, false)
  const prepared = await input.transport("prepare", { repositoryId: input.repositoryId, sha256: selection.sha256,
    bytes: selection.bytes.byteLength, includeBrain: true })
  if (!record(prepared) || typeof prepared.uploadId !== "string" || !/^vbu_[A-Za-z0-9_-]{32}$/.test(prepared.uploadId) ||
    typeof prepared.key !== "string" || prepared.key.length !== 43 || typeof prepared.aad !== "string" || prepared.aad.length > 256 ||
    typeof prepared.expiresAt !== "number" || prepared.expiresAt <= Date.now() || typeof prepared.publicRepository !== "boolean") throw new Error("Vector could not prepare this Brain attachment.")
  const parts = prepared.aad.split("|")
  if (parts.length !== 5 || parts[0] !== "vector-brain-upload-v1" || parts[2] !== input.repositoryId ||
    parts[4] !== prepared.uploadId || !/^[1-9]\d*$/.test(parts[3]!)) throw new Error("The Brain attachment repository changed. Review it again.")
  validate(selection.bytes, prepared.publicRepository)
  const keyBytes = fromBase64url(prepared.key)
  if (keyBytes.length !== 32) throw new Error("Invalid Brain attachment encryption key.")
  const key = await crypto.subtle.importKey("raw", Uint8Array.from(keyBytes), "AES-GCM", false, ["encrypt"])
  keyBytes.fill(0)
  const nonce = crypto.getRandomValues(new Uint8Array(12))
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce,
    additionalData: new TextEncoder().encode(prepared.aad), tagLength: 128 }, key, Uint8Array.from(selection.bytes))
  const committed = await input.transport("commit", { uploadId: prepared.uploadId,
    nonce: base64url(nonce), ciphertext: base64url(new Uint8Array(ciphertext)) })
  if (!record(committed) || committed.uploadId !== prepared.uploadId || committed.sha256 !== selection.sha256 ||
    committed.bytes !== selection.bytes.byteLength || typeof committed.approvedAt !== "number" || committed.approvedAt <= 0)
    throw new Error("Vector could not confirm this exact Brain attachment. Start no run with it.")
  return { uploadId: prepared.uploadId, sha256: selection.sha256 }
}
