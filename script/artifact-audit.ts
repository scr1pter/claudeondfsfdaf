#!/usr/bin/env bun
/**
 * Byte-level audit for every release artifact before it is published.
 *
 *   bun script/artifact-audit.ts <file-or-directory>...
 *
 * Directories are walked recursively (symbolic links are skipped, so macOS framework
 * aliases are scanned once). `.tar.gz`/`.tgz` archives are scanned after streaming
 * decompression, `.zip` archives entry by entry, and every other file (native binaries,
 * `app.asar`, notices, manifests) as raw bytes.
 *
 * It fails on:
 * - the former product name, case-insensitive, in UTF-8 and both UTF-16 byte orders,
 *   except inside the precise allowlist below;
 * - retired upstream hosts;
 * - borrowed OAuth registrations and shared-key literals, except the Codex CLI client that Sign in with
 *   ChatGPT used, which the provider policy still names but no longer uses by default (23 October 2026).
 *
 * The former name is never written here. Like packages/core/src/flag/legacy.ts and the
 * upstream-free compliance test, it is derived from the MIT notice in THIRD_PARTY_NOTICES.md.
 *
 * Allowlist (docs/vector/owner-actions/binary-identifiers.md), each class counted:
 * - license: the match sits inside an exact line of THIRD_PARTY_NOTICES.md or LICENSE that
 *   carries the name, either as a packaged notice file or as notice text a bundle embeds;
 * - monaco: Monaco's camel-case method that opens a code editor, exactly the name in the
 *   casing the notices display (first letter lowered) followed by `Editor`;
 * - bun: Bun's built-in trusted-package table entry (the name plus `-ai`), recognised only
 *   between its pinned alphabetical neighbours;
 * - node: Node.js `util.styleText`'s local variable for the opening ANSI codes, the Monaco
 *   casing plus `s`, inside Electron's executable;
 * - drizzle: drizzle-orm's no-op encoder export, `no` + the name with its third letter
 *   capitalised + `r`, in the engine bundle the desktop app embeds.
 * The last two were approved on 1 October 2026 under the owner's rule that only license text
 * and third-party code may carry the name: both are unrelated words that happen to contain it.
 */
import path from "node:path"
import { createReadStream } from "node:fs"
import { lstat, readdir } from "node:fs/promises"
import { Readable } from "node:stream"
import { fileURLToPath } from "node:url"

// This build-only audit uses Bun streams without granting ambient Bun APIs to desktop runtime code.
declare const Bun: {
  file(file: string): {
    size: number
    text(): Promise<string>
    stream(): ReadableStream<Uint8Array<ArrayBuffer>>
    slice(start: number, end?: number): Blob
  }
}

const root = path.resolve(fileURLToPath(new URL("../", import.meta.url)))
// Bytes of surrounding text kept around each match: longer than any notice line.
const CONTEXT = 256
// The Codex CLI's public client is the one borrowed registration allowed. The owner re-enabled Sign in with ChatGPT
// with it on 10 October 2026 and turned it off on 23 October 2026; provider-policy.ts still names it, with the sign-in
// off by default, until a release removes it (docs/vector/owner-actions/chatgpt.md). Every other stays here.
const credentials = [
  { label: "retired public model key assignment", value: 'apiKey:"public"' },
  { label: "retired public model key assignment", value: 'apiKey: "public"' },
  { label: "retired shared key hash", value: "1d89f9fdb23ee96d4e603201f6861dab6e143c5c3c00469a018a2d94bdc03d4e" },
  { label: "borrowed GitHub OAuth registration", value: "Ov23li8tweQw6odWQebz" },
  { label: "borrowed OAuth registration", value: "b1a00492-073a-47ea-816f-4c329264a828" },
]
// Bun's default trusted-package table is alphabetical; the entry sits between these
// neighbours on macOS/Linux and on Windows respectively.
const bunNeighbours = [
  { before: "oniguruma", after: "optipng-bin" },
  { before: "grpc", after: "event-loop-stats" },
]

type Encoding = "utf-8" | "utf-16le" | "utf-16be"
type Kind = "former-name" | "retired-host" | "credential"
type Needle = { kind: Kind; label: string; wide: boolean; bytes: string; length: number; caseless: boolean }
type Context = { before: string; match: string; after: string }
type Reading = Context & { encoding: Encoding; start: number }
type Rules = Awaited<ReturnType<typeof loadRules>>

export type AllowedClass = "license" | "monaco" | "bun" | "node" | "drizzle"
export type Violation = {
  file: string
  offset: number
  kind: Kind
  label: string
  // "utf-16" when the bytes read as the text in either byte order.
  encoding: Encoding | "utf-16"
  context: string
}
export type AuditReport = {
  files: number
  bytes: number
  allowed: Record<AllowedClass, number>
  violations: Violation[]
}

export async function auditArtifacts(paths: string[], options?: { chunkSize?: number }) {
  if (!paths.length) throw new Error("Name at least one artifact file or directory to audit")
  const rules = await loadRules()
  const report: AuditReport = {
    files: 0,
    bytes: 0,
    allowed: { license: 0, monaco: 0, bun: 0, node: 0, drizzle: 0 },
    violations: [],
  }
  const chunkSize = options?.chunkSize ?? 4 * 1024 * 1024
  for (const file of (await Promise.all(paths.map((item) => listFiles(path.resolve(item))))).flat()) {
    report.files++
    if (/\.(?:tar\.gz|tgz)$/i.test(file)) {
      const stream = Bun.file(file).stream().pipeThrough(new DecompressionStream("gzip"))
      await scan(stream, `${file} (decompressed)`, rules, report, chunkSize)
      continue
    }
    if (/\.zip$/i.test(file)) {
      await scanZip(file, rules, report, chunkSize)
      continue
    }
    await scan(Bun.file(file).stream(), file, rules, report, chunkSize)
  }
  if (!report.files) throw new Error(`No artifact files found under ${paths.join(", ")}`)
  return report
}

export async function assertCleanArtifacts(paths: string[]) {
  const report = await auditArtifacts(paths)
  console.log(
    [
      `Artifact audit: ${report.files} files, ${(report.bytes / 1024 / 1024).toFixed(1)} MiB scanned`,
      `  allowed license notice text: ${report.allowed.license}`,
      `  allowed Monaco open-editor method names: ${report.allowed.monaco}`,
      `  allowed Bun built-in package table entries: ${report.allowed.bun}`,
      `  allowed Node.js styleText variable names: ${report.allowed.node}`,
      `  allowed drizzle-orm no-op encoder names: ${report.allowed.drizzle}`,
      `  violations: ${report.violations.length}`,
      ...report.violations
        .slice(0, 50)
        .map(
          (item) =>
            `  ${item.kind}: ${item.label} (${item.encoding}) in ${item.file} at byte ${item.offset}: ${item.context}`,
        ),
    ].join("\n"),
  )
  if (report.violations.length)
    throw new Error(
      `Refusing to publish: ${report.violations.length} artifact audit violation(s) — the former product name outside the allowlist, a retired upstream host, or a borrowed credential`,
    )
  return report
}

async function loadRules() {
  const notices = await Bun.file(path.join(root, "THIRD_PARTY_NOTICES.md")).text()
  const name = notices
    .split("<!-- vector-upstream-attribution -->")[1]
    ?.match(/^Copyright \(c\) \d{4} (.+)$/m)?.[1]
    ?.trim()
    .toLowerCase()
  if (!name) throw new Error("The upstream MIT copyright notice is missing from THIRD_PARTY_NOTICES.md")
  const license = await Bun.file(path.join(root, "LICENSE")).text()
  // Monaco's method uses the display casing the notices print, with its first letter lowered.
  const display = [notices, license]
    .flatMap((text) => text.match(new RegExp(name, "gi")) ?? [])
    .find((item) => item !== name && item !== item.toUpperCase())
  if (!display) throw new Error("The notices no longer show the former name's display casing")
  const monaco = display[0].toLowerCase() + display.slice(1)
  const drizzle = name.slice(0, 2) + name[2].toUpperCase() + name.slice(3)
  // Every position of the name inside each notice line that carries it.
  const legal = [
    ...new Set(
      [notices, license]
        .flatMap((text) => text.split(/\r?\n/))
        .map((line) => line.trim())
        .filter((line) => line.toLowerCase().includes(name)),
    ),
  ].flatMap((line) => {
    const parts = line.toLowerCase().split(name)
    return parts.slice(0, -1).map((_, index) => ({ line, index: parts.slice(0, index + 1).join(name).length }))
  })
  const values = [
    { kind: "former-name" as const, label: "former product name", value: name, caseless: true },
    { kind: "retired-host" as const, label: "former product domain", value: `${name}.ai`, caseless: true },
    {
      kind: "retired-host" as const,
      label: "retired public model catalog service",
      value: "://models.dev",
      caseless: true,
    },
    ...credentials.map((item) => ({ kind: "credential" as const, ...item, caseless: false })),
  ]
  const needles = values.flatMap((item): Needle[] => {
    // Both UTF-16 byte orders contain the little-endian bytes without the final NUL, so one
    // search finds either order; classify() then reads the match each valid way.
    const wide = Buffer.from(item.value, "utf16le").toString("latin1")
    return [
      { ...item, wide: false, bytes: Buffer.from(item.value).toString("latin1"), length: item.value.length },
      { ...item, wide: true, bytes: wide.slice(0, -1), length: wide.length },
    ]
  })
  // Hides every audited value in printed context, not just the reported match.
  const mask = new RegExp(values.map((item) => item.value.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")).join("|"), "gi")
  return {
    name,
    monaco,
    drizzle,
    legal,
    needles,
    mask,
    reach: CONTEXT + Math.max(...needles.map((needle) => needle.length)),
  }
}

async function listFiles(item: string): Promise<string[]> {
  const info = await lstat(item)
  if (info.isSymbolicLink()) return []
  if (info.isFile()) return [item]
  if (!info.isDirectory()) return []
  const entries = (await readdir(item)).sort()
  return (await Promise.all(entries.map((entry) => listFiles(path.join(item, entry))))).flat()
}

// Streams one artifact, keeping CONTEXT bytes on either side of every match across chunks.
async function scan(
  stream: ReadableStream<Uint8Array>,
  file: string,
  rules: Rules,
  report: AuditReport,
  chunkSize: number,
) {
  let tail = Buffer.alloc(0)
  let base = 0
  let next = 0
  let pending: Uint8Array[] = []
  let size = 0
  const flush = (final: boolean) => {
    const data = Buffer.concat([tail, ...pending])
    pending = []
    size = 0
    const limit = final ? data.length : data.length - rules.reach
    if (limit <= next - base) {
      tail = data
      return
    }
    const text = data.toString("latin1")
    const lower = text.toLowerCase()
    rules.needles.forEach((needle) => {
      const haystack = needle.caseless ? lower : text
      for (
        let at = haystack.indexOf(needle.bytes, next - base);
        at !== -1 && at < limit;
        at = haystack.indexOf(needle.bytes, at + 1)
      )
        classify(data, at, needle, base, file, rules, report)
    })
    next = base + limit
    const keep = Math.max(0, limit - CONTEXT)
    tail = data.subarray(keep)
    base += keep
  }
  const reader = stream.getReader()
  for (let read = await reader.read(); !read.done; read = await reader.read()) {
    report.bytes += read.value.length
    pending.push(read.value)
    size += read.value.length
    if (size >= chunkSize) flush(false)
  }
  flush(true)
}

function classify(
  data: Buffer,
  at: number,
  needle: Needle,
  base: number,
  file: string,
  rules: Rules,
  report: AuditReport,
) {
  const readings: Reading[] = needle.wide
    ? [
        ...(data[at + needle.length - 1] === 0 ? [read(data, at, needle.length, "utf-16le")] : []),
        ...(at > 0 && data[at - 1] === 0 ? [read(data, at - 1, needle.length, "utf-16be")] : []),
      ]
    : [read(data, at, needle.length, "utf-8")]
  const allowed =
    needle.kind === "former-name" ? readings.map((item) => allowedClass(item, rules)).find(Boolean) : undefined
  if (allowed) {
    report.allowed[allowed]++
    return
  }
  const shown = readings[0] ?? read(data, at, needle.length - 1, "utf-16le")
  report.violations.push({
    file,
    offset: base + shown.start,
    kind: needle.kind,
    label: needle.label,
    encoding: readings.length === 1 ? shown.encoding : needle.wide ? "utf-16" : "utf-8",
    // Audited values are masked so logs never repeat a name or credential.
    context: [shown.before.slice(-40), `[${needle.label}]`, shown.after.slice(0, 40)]
      .map((part) => part.replace(rules.mask, "[audited value]").replace(/[^\x20-\x7e]/g, "."))
      .join(""),
  })
}

function read(data: Buffer, at: number, length: number, encoding: Encoding): Reading {
  const width = encoding === "utf-8" ? 1 : 2
  const back = Math.min(at, CONTEXT)
  const end = at + length
  const ahead = Math.max(0, Math.min(data.length - end, CONTEXT))
  return {
    encoding,
    start: at,
    before: decode(data.subarray(at - (back - (back % width)), at), encoding),
    match: decode(data.subarray(at, end), encoding),
    after: decode(data.subarray(end, end + ahead - (ahead % width)), encoding),
  }
}

function allowedClass(context: Context, rules: Rules): AllowedClass | undefined {
  const size = rules.name.length
  const legal = rules.legal.some(
    (item) =>
      item.line.slice(item.index, item.index + size) === context.match &&
      context.before.endsWith(item.line.slice(0, item.index)) &&
      context.after.startsWith(item.line.slice(item.index + size)),
  )
  if (legal) return "license"
  if (
    context.match === rules.monaco &&
    !/[\w$]$/.test(context.before.replace(/_$/, "")) &&
    /^Editor(?![\w$])/.test(context.after)
  )
    return "monaco"
  if (context.match === rules.monaco && !/[\w$]$/.test(context.before) && /^s(?![\w$])/.test(context.after))
    return "node"
  if (context.match === rules.drizzle && /(?<![\w$])no$/.test(context.before) && /^r(?![\w$])/.test(context.after))
    return "drizzle"
  const previous = context.before.replace(/(?:\s|\\[nr]|\0)*$/, "")
  const following = context.after.slice(3).replace(/^(?:\s|\\[nr]|\0)*/, "")
  if (
    context.match === rules.name &&
    context.after.startsWith("-ai") &&
    bunNeighbours.some((item) => previous.endsWith(item.before) && following.startsWith(item.after))
  )
    return "bun"
}

// Zip entries are deflated individually, so each is inflated from the central directory.
async function scanZip(file: string, rules: Rules, report: AuditReport, chunkSize: number) {
  const archive = Bun.file(file)
  const trailer = Buffer.from(await archive.slice(Math.max(0, archive.size - 65_557)).arrayBuffer())
  const end = trailer.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]))
  if (end === -1) throw new Error(`${file} is not a zip archive`)
  const offset = trailer.readUInt32LE(end + 16)
  const directory = Buffer.from(await archive.slice(offset, offset + trailer.readUInt32LE(end + 12)).arrayBuffer())
  await scan(new Blob([directory]).stream(), `${file} (central directory)`, rules, report, chunkSize)
  for (let at = 0; at + 46 <= directory.length && directory.readUInt32LE(at) === 0x02014b50; ) {
    const method = directory.readUInt16LE(at + 10)
    const compressed = directory.readUInt32LE(at + 20)
    const uncompressed = directory.readUInt32LE(at + 24)
    const nameLength = directory.readUInt16LE(at + 28)
    const local = directory.readUInt32LE(at + 42)
    const entry = directory.subarray(at + 46, at + 46 + nameLength).toString("utf8")
    at += 46 + nameLength + directory.readUInt16LE(at + 30) + directory.readUInt16LE(at + 32)
    if (method !== 0 && method !== 8) throw new Error(`${file}: ${entry} uses unsupported zip method ${method}`)
    const header = Buffer.from(await archive.slice(local, local + 30).arrayBuffer())
    if (header.length !== 30 || header.readUInt32LE(0) !== 0x04034b50)
      throw new Error(`${file}: ${entry} has an invalid local header`)
    const start = local + 30 + header.readUInt16LE(26) + header.readUInt16LE(28)
    if (start > offset || compressed > offset - start) throw new Error(`${file}: ${entry} has an invalid payload range`)
    if (compressed === 0) {
      if (method !== 0 || uncompressed !== 0) throw new Error(`${file}: ${entry} has an invalid empty payload`)
      continue
    }
    // Bun 1.3.14 file-slice streams can spin after their last byte, even for nonempty ranges.
    // Keep payloads bounded and streaming, using an inclusive Node range with a finite EOF.
    const raw = Readable.toWeb(
      createReadStream(file, { start, end: start + compressed - 1 }),
    ) as unknown as ReadableStream<Uint8Array<ArrayBuffer>>
    await scan(
      method === 8 ? raw.pipeThrough(new DecompressionStream("deflate-raw")) : raw,
      `${file}:${entry}`,
      rules,
      report,
      chunkSize,
    )
  }
}

function decode(bytes: Buffer, encoding: Encoding) {
  if (encoding === "utf-8") return bytes.toString("latin1")
  if (encoding === "utf-16le") return bytes.toString("utf16le")
  return Buffer.from(bytes).swap16().toString("utf16le")
}

if (import.meta.main) await assertCleanArtifacts(process.argv.slice(2))
