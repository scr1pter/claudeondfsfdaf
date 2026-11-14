import { describe, expect, test } from "bun:test"
import { matchPostImage, parseUnifiedDiff, renderPatch, type DiffFile } from "@vectordevai/core/review/diff"
import { holdbackFiles } from "@vectordevai/core/review/holdback"
import type { HeadFile } from "@vectordevai/core/review/prompt"

// The payload holdback (VS-34a) over synthetic diffs. Placeholders only: token-like literals and private key headers
// are assembled at run time, as in redact.test.ts and scan.test.ts, so no token-like literal sits in the source.

const [rsaBegin, rsaEnd] = ["BEGIN", "END"].map((word) => `-----${word} RSA ${"PRIVATE"} KEY-----`)
const [sshBegin, sshEnd] = ["BEGIN", "END"].map((word) => `-----${word} OPENSSH ${"PRIVATE"} KEY-----`)
const [pkBegin, pkEnd] = ["BEGIN", "END"].map((word) => `-----${word} ${"PRIVATE"} KEY-----`)

const t = {
  ghp: "ghp_" + "a1B2".repeat(9),
  gho: "gho_" + "b2C3".repeat(9),
  ghu: "ghu_" + "c3D4".repeat(9),
  ghs: "ghs_" + "d4E5".repeat(9),
  ghr: "ghr_" + "e5F6".repeat(9),
  pat: "github_pat_" + "11AB".repeat(6) + "_" + "cd34".repeat(10),
  sk: "sk-" + "e5F6".repeat(8),
  proj: "sk-proj-" + "g7H8".repeat(8),
  ant: "sk-ant-api03-" + "i9J0".repeat(8),
  xoxb: "xoxb-" + "1234567890-" + "k1L2m3N4o5P6",
  akia: "AKIA" + "Z7Q2W4E6R8T0Y1U3",
  aws: "A1b2C3d4/".repeat(5).slice(0, 40),
  jwt: "eyJ" + "hbGciOiJIUzI1NiJ9" + "." + "eyJzdWIiOiIxMjM0In0" + "." + "c2lnbmF0dXJlLXBsYWNlaG9sZGVy",
  aiza: "AIza" + "Sy" + "B".repeat(33),
  live: "sk_" + "live_" + "m1N2o3P4q5R6s7T8",
  rk: "rk_" + "live_" + "u9V0w1X2y3Z4a5B6",
  npm: "npm_" + "c7D8".repeat(9),
  glpat: "glpat-" + "e9F0g1H2i3J4k5L6m7N8",
  hf: "hf_" + "o9P0".repeat(8),
  vct: "vct_" + "synthetic-placeholder.token",
  bearer: "q1W2e3R4t5Y6u7I8o9P0",
  slack: "https://hooks.slack.com/services/" + "T0000000/B0000000/" + "X".repeat(24),
  discord: "https://discord.com/api/webhooks/" + "123456789012345678/" + "abcDEF_ghi-jkl",
  office: "https://acme.webhook.office.com/" + "webhookb2/" + "0000-1111@2222/IncomingWebhook/abcd/efgh",
  db: "S3cretPassw0rdXY",
  pw: "pw12",
}

// The body of a private key: base64 lines, the last one short as a real key's often is.
const rsaBody = ["MIIEpAIBAAKCAQEA" + "x1Y2".repeat(12), "y3Z4".repeat(16), "QmF6PQ=="]
const sshBody = ["b3BlbnNzaC1rZXktdjEAAAAA" + "Bm9uZQ".repeat(5), "AAAAEw=="]

function added(path: string, lines: string[]) {
  return parseUnifiedDiff(
    [
      `diff --git a/${path} b/${path}`,
      "new file mode 100644",
      "--- /dev/null",
      `+++ b/${path}`,
      `@@ -0,0 +1,${lines.length} @@`,
      ...lines.map((line) => `+${line}`),
    ].join("\n"),
  )[0]
}

function binary(path: string) {
  return parseUnifiedDiff(
    [`diff --git a/${path} b/${path}`, "new file mode 100644", `Binary files /dev/null and b/${path} differ`].join(
      "\n",
    ),
  )[0]
}

// One modified file from its hunks, each a header and its prefixed lines.
function modified(path: string, ...hunks: string[][]) {
  return parseUnifiedDiff(
    [`diff --git a/${path} b/${path}`, `--- a/${path}`, `+++ b/${path}`, ...hunks.flat()].join("\n"),
  )[0]
}

// Everything holdback sends of a file, as one text: the rendered diff and the patch.
const sent = (file: DiffFile) => `${renderPatch([file])}\n${file.patch}`

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") Object.values(value).forEach(deepFreeze)
  return Object.freeze(value)
}

describe("holdbackFiles", () => {
  test("holds back key material, env and credential files by path, at the root and nested, in any case", () => {
    const cases = [
      ["server.pem", "secret-file"],
      ["cert.key", "secret-file"],
      ["store.p12", "secret-file"],
      [".ssh/config", "secret-file"],
      ["home/.ssh/known_hosts", "secret-file"],
      [".aws/credentials", "secret-file"],
      [".git/config", "secret-file"],
      ["infra/.aws/config", "secret-file"],
      ["home/.aws/credentials", "secret-file"],
      ["vendor/x/.git/config", "secret-file"],
      ["vendor/lib/.git/config", "secret-file"],
      ["certs/tls.key", "secret-file"],
      [".npmrc", "secret-file"],
      ["packages/a/.npmrc", "secret-file"],
      [".env", "env-file"],
      ["config/.env", "env-file"],
      [".env.local", "env-file"],
      ["apps/web/.env.production", "env-file"],
      [".env.example.bak", "env-file"],
      [".env.ts", "env-file"],
      // The read tool denies `*.env` and `*.env.*` too, so these are never sent either.
      ["prod.env", "env-file"],
      ["deploy/app.env", "env-file"],
      ["config/production.env.local", "env-file"],
      ["docker/app.env.json", "env-file"],
      // A shell or SQL script sets values, although isCodePath counts it as source.
      ["deploy/prod.env.sh", "env-file"],
      ["secrets.env.ps1", "env-file"],
      ["staging.env.bash", "env-file"],
      ["scripts/dev.env.zsh", "env-file"],
      ["db/seed.env.sql", "env-file"],
      [".envrc", "credential-file"],
      ["config/prod/.envrc", "credential-file"],
      [".netrc", "credential-file"],
      ["home/.netrc", "credential-file"],
      [".pypirc", "credential-file"],
      [".pgpass", "credential-file"],
      [".htpasswd", "credential-file"],
      ["deploy/.htpasswd", "credential-file"],
      ["credentials", "credential-file"],
      ["ops/credentials", "credential-file"],
      ["id_rsa", "credential-file"],
      ["keys/id_rsa", "credential-file"],
      ["id_dsa", "credential-file"],
      ["id_ecdsa", "credential-file"],
      ["id_ed25519", "credential-file"],
      ["deploy/id_ed25519", "credential-file"],
      ["keys/id_ecdsa_sk", "credential-file"],
      ["keys/id_ed25519_sk", "credential-file"],
      ["putty.ppk", "credential-file"],
      ["certs/client.pfx", "credential-file"],
      ["android/release.jks", "credential-file"],
      ["app/release.keystore", "credential-file"],
      // Lowercased first, so the same on every platform.
      [".ENV", "env-file"],
      ["Config/.Env.Local", "env-file"],
      ["Server.PEM", "secret-file"],
      ["ID_RSA", "credential-file"],
      ["Credentials", "credential-file"],
      ["keys/Id_Ed25519", "credential-file"],
    ] as const
    const files = cases.map(([path]) => (path.endsWith(".pfx") ? binary(path) : added(path, ["value"])))
    const result = holdbackFiles(files, { ignored: [] })
    expect(result.held).toEqual(cases.map(([path, reason]) => ({ path, status: "added", reason })))
    expect(result.files).toEqual([])
    expect(result.redactions).toEqual([])
  })

  test("judges a deletion by its path and a rename by its old or new path, and a copy by its new path", () => {
    const key = "sk-" + "q7R8".repeat(8)
    const deletion = parseUnifiedDiff(
      [
        "diff --git a/.env b/.env",
        "deleted file mode 100644",
        "--- a/.env",
        "+++ /dev/null",
        "@@ -1,2 +0,0 @@",
        `-OPENAI_API_KEY=${key}`,
        "-REGION=eu",
      ].join("\n"),
    )[0]
    const away = parseUnifiedDiff(
      ["diff --git a/id_rsa b/notes.txt", "similarity index 100%", "rename from id_rsa", "rename to notes.txt"].join(
        "\n",
      ),
    )[0]
    const toward = parseUnifiedDiff(
      [
        "diff --git a/notes.txt b/keys/id_ed25519",
        "similarity index 100%",
        "rename from notes.txt",
        "rename to keys/id_ed25519",
      ].join("\n"),
    )[0]
    const copy = parseUnifiedDiff(
      [
        "diff --git a/id_rsa b/backup/notes.txt",
        "copy from id_rsa",
        "copy to backup/notes.txt",
        "--- a/id_rsa",
        "+++ b/backup/notes.txt",
        "@@ -0,0 +1,5 @@",
        `+${rsaBegin}`,
        ...rsaBody.map((line) => `+${line}`),
        `+${rsaEnd}`,
      ].join("\n"),
    )[0]
    const result = holdbackFiles([deletion, away, toward, copy], { ignored: [] })
    expect(result.held).toEqual([
      { path: ".env", status: "deleted", reason: "env-file" },
      { path: "notes.txt", oldPath: "id_rsa", status: "renamed", reason: "credential-file" },
      { path: "keys/id_ed25519", oldPath: "notes.txt", status: "renamed", reason: "credential-file" },
    ])
    expect("oldPath" in result.held[0]).toBe(false)
    expect(JSON.stringify(result)).not.toContain(key)
    // A copy has no old path: it is sent, and its content is redacted like any other file's.
    expect(result.files.map((file) => [file.path, file.status])).toEqual([["backup/notes.txt", "added"]])
    expect(result.files[0].hunks[0].lines.map((line) => line.text)).toEqual([
      rsaBegin,
      "[redacted]",
      "[redacted]",
      "[redacted]",
      rsaEnd,
    ])
  })

  test("sends templates and names that only look like key material or credentials", () => {
    const paths = [
      ".env.example",
      "config/.env.example",
      ".env.sample",
      ".env.template",
      ".env.dist",
      ".env.defaults",
      ".env.local.example",
      // The read tool denies this one (`*.env.*`); holdback sends a source file that reads env, redacted.
      "src/config.env.ts",
      "src/vite.env.d.ts",
      "src/env.ts",
      "docs/env.md",
      ".envrc.example",
      ".environment",
      ".env-cmdrc",
      "src/netrc.ts",
      "src/credentials.ts",
      "src/credentials/index.ts",
      "docs/credentials.md",
      "id_rsa.pub",
      "keys/id_ed25519.pub",
      "src/id_rsa_test.go",
      "src/keyboard.ts",
      "monkey.key.ts",
      "src/tokenizer.ts",
      "src/keystore.ts",
      "keystore.md",
    ]
    const files = [...paths.map((path) => added(path, ["value"])), binary("logo.png")]
    const result = holdbackFiles(files, { ignored: [] })
    expect(result.held).toEqual([])
    expect(result.files).toEqual(files)
  })

  test("pins what it does not hold back by path: key backups and other `id_` names", () => {
    const result = holdbackFiles(
      ["id_rsa.bak", "id_rsa.old", "keys/id_xmss"].map((path) => added(path, ["value"])),
      { ignored: [] },
    )
    expect(result.held).toEqual([])
  })

  test("redacts every token shape in place, and keeps each line, prefix and number where it was", () => {
    const shaped = [
      `const a = "${t.ghp}"`,
      `const b = "${t.pat}"`,
      `const c = "${t.sk}"`,
      `const d = "${t.proj}"`,
      `const e = "${t.ant}"`,
      `const f = "${t.xoxb}"`,
      `const g = "${t.akia}"`,
      // An AWS secret on the next line beside its key ID.
      `const h = "${t.aws}"`,
      `const i = "${t.jwt}"`,
      `const j = "${t.aiza}"`,
      `const k = "${t.live}"`,
      `const l = "${t.rk}"`,
      `const m = "${t.npm}"`,
      `const n = "${t.glpat}"`,
      `const o = "${t.hf}"`,
      `const p = "${t.vct}"`,
      `const q = "${t.gho}"`,
      `const r = "${t.ghu}"`,
      `const s = "${t.ghs}"`,
      `const t = "${t.ghr}"`,
      `headers: { Authorization: "Bearer ${t.bearer}" }`,
      `const slack = "${t.slack}"`,
      `const discord = "${t.discord}"`,
      `const office = "${t.office}"`,
      `const db = "postgres://app:${t.db}@db:5432/app", x = 1`,
      `const cache = "redis://u:${t.pw}@cache:6379"; connect()`,
      `const deploy = "placeholder-deploy-token-0001"`,
    ]
    const file = modified("src/config.ts", [
      `@@ -1,3 +1,${shaped.length + 2} @@ export const config = {`,
      " // settings",
      "-const old = 1",
      ...shaped.map((line) => `+${line}`),
      " export {}",
      "\\ No newline at end of file",
    ])
    const result = holdbackFiles([file], { ignored: [], env: { DEPLOY_TOKEN: "placeholder-deploy-token-0001" } })
    const out = result.files[0]
    for (const secret of [...Object.values(t), "placeholder-deploy-token-0001"]) expect(sent(out)).not.toContain(secret)
    expect(out.hunks.map((hunk) => hunk.lines.map((line) => [line.kind, line.oldLine, line.newLine]))).toEqual(
      file.hunks.map((hunk) => hunk.lines.map((line) => [line.kind, line.oldLine, line.newLine])),
    )
    expect([out.path, out.status, out.additions, out.deletions, out.binary]).toEqual([
      file.path,
      file.status,
      file.additions,
      file.deletions,
      file.binary,
    ])
    expect(parseUnifiedDiff(out.patch)[0].hunks).toEqual(out.hunks)
    expect(out.hunks[0].lines.at(-1)).toEqual({
      kind: "context",
      oldLine: 3,
      newLine: shaped.length + 2,
      text: "export {}",
      noNewline: true,
    })
    expect(out.patch.split("\n").at(-1)).toBe("\\ No newline at end of file")
    const texts = out.hunks[0].lines.filter((line) => line.kind === "add").map((line) => line.text)
    expect(texts).toEqual([
      ..."abcdefghijklmnopqrst".split("").map((name) => `const ${name} = "[redacted]"`),
      `headers: { Authorization: "[redacted]" }`,
      `const slack = "[redacted]"`,
      `const discord = "[redacted]"`,
      `const office = "[redacted]"`,
      // Only the password: the user name, host, quote and the code after it stay.
      `const db = "postgres://app:[redacted]@db:5432/app", x = 1`,
      `const cache = "redis://u:[redacted]@cache:6379"; connect()`,
      `const deploy = "[redacted]"`,
    ])
    expect(result.redactions).toEqual([{ path: "src/config.ts", diff: shaped.length, head: 0 }])
  })

  test("redacts a private key's body line by line, added or deleted, keeps its marks, and redacts hunk headers", () => {
    const keys = added("test/fixtures/keys.ts", [
      "export const rsa = `",
      rsaBegin,
      ...rsaBody,
      rsaEnd,
      "`",
      `export const one = "${pkBegin}\\n${rsaBody[0]}\\n${rsaBody[2]}\\n${pkEnd}"`,
    ])
    const removal = modified("deploy/setup.sh", [
      `@@ -1,7 +1,1 @@ TOKEN="${t.ghp}"`,
      " echo setup",
      "-cat > key <<EOF",
      `-${sshBegin}`,
      ...sshBody.map((line) => `-${line}`),
      `-${sshEnd}`,
      "-EOF",
    ])
    const result = holdbackFiles([keys, removal], { ignored: [] })
    expect(result.files[0].hunks[0].lines.map((line) => line.text)).toEqual([
      "export const rsa = `",
      rsaBegin,
      "[redacted]",
      "[redacted]",
      "[redacted]",
      rsaEnd,
      "`",
      `export const one = "${pkBegin}\\n[redacted]\\n[redacted]\\n${pkEnd}"`,
    ])
    expect(result.files[1].hunks[0].lines.map((line) => line.text)).toEqual([
      "echo setup",
      "cat > key <<EOF",
      sshBegin,
      "[redacted]",
      "[redacted]",
      sshEnd,
      "EOF",
    ])
    expect(result.files[1].hunks[0].header).toBe('@@ -1,7 +1,1 @@ TOKEN="[redacted]"')
    expect(result.files[1].patch.split("\n")[0]).toBe('@@ -1,7 +1,1 @@ TOKEN="[redacted]"')
    for (const file of result.files) {
      for (const secret of [...rsaBody, ...sshBody, t.ghp]) expect(sent(file)).not.toContain(secret)
      expect(parseUnifiedDiff(file.patch)[0].hunks).toEqual(file.hunks)
    }
    expect(result.redactions).toEqual([
      { path: "test/fixtures/keys.ts", diff: 5, head: 0 },
      { path: "deploy/setup.sh", diff: 3, head: 0 },
    ])
  })

  test("reads a path's diff and head file as one, so a key ID or a key header outside the hunk still counts", () => {
    const [before, after] = ["Old1", "New2"].map((tag) => `${tag}${"r5S6".repeat(9)}`)
    const aws = modified("deploy/aws.ts", [
      "@@ -4,5 +4,5 @@ export const aws = {",
      '   bucket: "assets",',
      '   prefix: "uploads/",',
      "   timeout: 30,",
      `-  secret: "${before}",`,
      `+  secret: "${after}",`,
      " }",
    ])
    const awsHead = [
      "export const aws = {",
      `  id: "${t.akia}",`,
      '  region: "us-east-1",',
      '  bucket: "assets",',
      '  prefix: "uploads/",',
      "  timeout: 30,",
      `  secret: "${after}",`,
      "}",
      "",
    ].join("\n")
    const body = Array.from({ length: 7 }, (_, index) => `L${index}${"m1N2".repeat(15)}`)
    const changed = `L4${"z9Y8".repeat(15)}`
    const pem = modified("src/fixtures/rsa.ts", [
      "@@ -4,7 +4,7 @@",
      ...body.slice(1, 4).map((line) => ` ${line}`),
      `-${body[4]}`,
      `+${changed}`,
      ...body.slice(5).map((line) => ` ${line}`),
      " QmF6PQ==",
    ])
    const pemHead = [
      "export const key = `",
      rsaBegin,
      ...body.slice(0, 4),
      changed,
      ...body.slice(5),
      "QmF6PQ==",
      rsaEnd,
      "`",
      "",
    ].join("\n")
    const heads: HeadFile[] = [
      { path: "deploy/aws.ts", text: awsHead, exact: true },
      { path: "src/fixtures/rsa.ts", text: pemHead, exact: true },
    ]
    const result = holdbackFiles([aws, pem], { ignored: [], headFiles: heads })
    const secrets = [t.akia, before, after, ...body, changed, "QmF6PQ=="]
    for (const file of result.files) for (const secret of secrets) expect(sent(file)).not.toContain(secret)
    for (const head of result.headFiles!) for (const secret of secrets) expect(head.text).not.toContain(secret)
    expect(result.files[0].hunks[0].lines.map((line) => line.text).slice(3, 5)).toEqual([
      '  secret: "[redacted]",',
      '  secret: "[redacted]",',
    ])
    expect(result.headFiles![1].text.split("\n")).toEqual([
      "export const key = `",
      rsaBegin,
      ...Array(8).fill("[redacted]"),
      rsaEnd,
      "`",
      "",
    ])
    // A line the diff and its head file share reads the same in both, so packing can still annotate the head file.
    result.files.forEach((file, index) => expect(matchPostImage(result.headFiles![index].text, file)).toBe(true))
    expect(result.redactions).toEqual([
      { path: "deploy/aws.ts", diff: 2, head: 2 },
      { path: "src/fixtures/rsa.ts", diff: 8, head: 8 },
    ])
    // Without the head file the hunks alone hold neither the key ID nor the key's header: a known gap, pinned.
    const alone = holdbackFiles([aws, pem], { ignored: [] })
    expect(sent(alone.files[0])).toContain(after)
    expect(sent(alone.files[1])).toContain(changed)
  })

  test("redacts head files whole or only hunks, drops those of held paths, and keeps their flags", () => {
    const client = added("src/client.ts", ["export const client = {", `  token: "${t.ghp}",`, "}"])
    const env = added(".env", [`GITHUB_TOKEN=${t.ghp}`])
    const big = added("src/big.ts", [`export const key = "${t.sk}"`, "export const ok = true"])
    const heads: HeadFile[] = [
      { path: "src/client.ts", text: `export const client = {\n  token: "${t.ghp}",\n}\n`, exact: true },
      { path: ".env", text: `GITHUB_TOKEN=${t.ghp}\n`, exact: true },
      // Only the hunks, as the engine sends a file over 40 KB.
      { path: "src/big.ts", text: renderPatch([big]), exact: false },
      // A head file no changed file is sent with, and one already annotated.
      { path: "src/other.ts", text: `const other = "${t.hf}"\nconst ok = 1`, exact: true, annotated: true },
    ]
    const result = holdbackFiles([client, env, big], { ignored: [], headFiles: heads })
    expect(result.held.map((file) => file.path)).toEqual([".env"])
    expect(result.headFiles).toEqual([
      { path: "src/client.ts", text: 'export const client = {\n  token: "[redacted]",\n}\n', exact: true },
      { path: "src/big.ts", text: renderPatch([result.files[1]]), exact: false },
      { path: "src/other.ts", text: 'const other = "[redacted]"\nconst ok = 1', exact: true, annotated: true },
    ])
    expect(result.headFiles![1].text).toContain('+export const key = "[redacted]"')
    expect(result.redactions).toEqual([
      { path: "src/client.ts", diff: 1, head: 1 },
      { path: "src/big.ts", diff: 1, head: 1 },
      { path: "src/other.ts", diff: 0, head: 1 },
    ])
    expect("headFiles" in holdbackFiles([client], { ignored: [] })).toBe(false)
    expect(holdbackFiles([env], { ignored: [], headFiles: [heads[1]] }).headFiles).toEqual([])
    // A head file is dropped by its own path too, whether or not a changed file has it.
    expect(
      holdbackFiles([], { ignored: [], headFiles: [{ path: ".env", text: "PASSWORD=hunter2\n", exact: true }] }),
    ).toEqual({ files: [], headFiles: [], held: [], redactions: [], ignoredCommitted: [] })
  })

  test("leaves look-alike code, placeholders and fake keys without a secret's shape unchanged", () => {
    const lines = [
      'import { Tokenizer } from "./tokenizer"',
      "const maxTokens = 4096",
      "const token = process.env.GITHUB_TOKEN",
      "type Login = { password: string; token?: string }",
      'const example = { apiKey: "<your-api-key>", secret: "${SECRET}" }',
      "// TOKEN=xxxx",
      'const masked = { "password": "[redacted]" }',
      'const remote = "https://oauth2:${GITLAB_TOKEN}@gitlab.com/acme/tools.git"',
      'const TEST_KEY = "test"',
      'const fake = "not-a-real-key"',
      'const KEY_PREFIX = "sk-"',
      'const short = ["ghp_short", "sk-short"]',
      "if (password === confirm) return",
      "const fresh = await getToken()",
      "const secretKey = deriveKey(salt)",
      'const checksum = "2d711642b726b04401627ca9fbac32f5c8530fb1903cc4db02258717921a4881"',
      'const id = "0fec1b80-dea9-4156-ba03-a573ab295a1a"',
      'const commit = "da39a3ee5e6b4b0d3255bfef95601890afd80709"',
      `const pub = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI${"x1Y2".repeat(10)} deploy@ci"`,
      'const logo = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=="',
      `// The key starts with ${sshBegin}, then its body.`,
      // The generic assigned-secret rule is dropped (the kill criterion): only a value's own shape counts.
      'const password = "hunter2hunter2"',
      // "Basic" and a long name on the next line are no token.
      "const headers = { // Basic",
      "  authorizationHeaderName,",
      "}",
    ]
    const file = added("src/lookalike.ts", lines)
    const result = holdbackFiles([file], {
      ignored: [],
      headFiles: [{ path: file.path, text: lines.join("\n"), exact: true }],
    })
    expect(result.files).toEqual([file])
    expect(result.headFiles).toEqual([{ path: file.path, text: lines.join("\n"), exact: true }])
    expect(result.redactions).toEqual([])
  })

  test("redacts an AWS key ID and keeps a commit beside it, and redacts fake keys that have a real key's shape", () => {
    const file = added("docs/aws.md", [
      `Use ${"AKIA"}${"IOSFODNN7EXAMPLE"} with ${"wJalrXUtnFEMI/K7MDENG/"}${"bPxRfiCYEXAMPLEKEY"}.`,
      "Fixed in da39a3ee5e6b4b0d3255bfef95601890afd80709.",
      `Stripe test key: ${"sk_" + "test_"}${"a1B2c3D4e5F6g7H8"}`,
      `Temporary: ${"ASIA"}${"Z7Q2W4E6R8T0Y1U3"}`,
    ])
    expect(holdbackFiles([file], { ignored: [] }).files[0].hunks[0].lines.map((line) => line.text)).toEqual([
      "Use [redacted] with [redacted].",
      "Fixed in da39a3ee5e6b4b0d3255bfef95601890afd80709.",
      "Stripe test key: [redacted]",
      "Temporary: [redacted]",
    ])
  })

  test("pins a known false positive: beside an AWS key ID, any 40-character run of a secret's characters goes", () => {
    const name = "name=thisIsAVeryLongIdentifierNameForTesting1"
    const lines = (body: string[]) =>
      holdbackFiles([added("src/aws.ts", body)], { ignored: [] }).files[0].hunks[0].lines.map((line) => line.text)
    const far = Array.from({ length: 20 }, (_, index) => `step(${index})`)
    expect(lines([`const id = "${t.akia}"`, ...far, name])).toEqual([
      'const id = "[redacted]"',
      ...far,
      "name=[redacted]",
    ])
    expect(lines([...far, name])).toEqual([...far, name])
  })

  test("lists gitignored files that were committed and drops none of them", () => {
    const files = [
      added("dist/app.js", ["x()"]),
      added(".env", ["A=1"]),
      parseUnifiedDiff(
        [
          "diff --git a/old.txt b/old.txt",
          "deleted file mode 100644",
          "--- a/old.txt",
          "+++ /dev/null",
          "@@ -1 +0,0 @@",
          "-x",
        ].join("\n"),
      )[0],
      added("src/a.ts", ["y()"]),
    ]
    const result = holdbackFiles(files, { ignored: ["dist/app.js", ".env", "old.txt", "unchanged/path.txt"] })
    expect(result.ignoredCommitted).toEqual(["dist/app.js", ".env"])
    expect(result.files.map((file) => file.path)).toEqual(["dist/app.js", "old.txt", "src/a.ts"])
    expect(result.held.map((file) => file.path)).toEqual([".env"])
  })

  test("is pure: frozen inputs, the same result twice, and nothing changed", () => {
    const files = [added("src/a.ts", [`const a = "${t.ghp}"`]), added(".env", ["A=1"])]
    const input = {
      ignored: ["src/a.ts"],
      headFiles: [{ path: "src/a.ts", text: `const a = "${t.ghp}"\n`, exact: true }],
    }
    const copy = structuredClone({ files, input })
    deepFreeze(files)
    deepFreeze(input)
    const first = holdbackFiles(files, input)
    expect(holdbackFiles(files, input)).toEqual(first)
    expect({ files, input }).toEqual(copy)
  })

  test("takes time in proportion to a long deletion beside an exact head file", () => {
    // A modified file of one kept line and many removed ones: copying a list per removed line took 12 s at 80 000.
    const count = 100_000
    const file = modified("src/long.ts", [
      `@@ -1,${count + 1} +1,1 @@`,
      " kept",
      ...Array.from({ length: count }, (_, index) => `-line ${index}`),
    ])
    const started = performance.now()
    const result = holdbackFiles([file], {
      ignored: [],
      headFiles: [{ path: "src/long.ts", text: "kept", exact: true }],
    })
    expect(performance.now() - started).toBeLessThan(1_000)
    expect(result.files).toEqual([file])
    expect(result.headFiles).toEqual([{ path: "src/long.ts", text: "kept", exact: true }])
  })

  test("redacts with another BrainScan reading when one is given, for the measurement window only", () => {
    const file = added("deploy/compose.yml", [`DB_PASSWORD=${t.db}`, `token: "${t.ghp}"`])
    const lines = (reading?: { code: true }) =>
      holdbackFiles([file], { ignored: [], reading }).files[0].hunks[0].lines.map((line) => line.text)
    expect(lines()).toEqual([`DB_PASSWORD=${t.db}`, 'token: "[redacted]"'])
    expect(lines({ code: true })).toEqual(["DB_PASSWORD=[redacted]", 'token: "[redacted]"'])
  })

  test("redacts the environment's secret values only when they are passed", () => {
    const file = added("deploy/run.sh", ["curl -H 'x-token: placeholder-deploy-token-0001' https://example.com"])
    const env = { DEPLOY_TOKEN: "placeholder-deploy-token-0001" }
    expect(holdbackFiles([file], { ignored: [], env }).files[0].hunks[0].lines[0].text).toBe(
      "curl -H 'x-token: [redacted]' https://example.com",
    )
    expect(holdbackFiles([file], { ignored: [] }).files).toEqual([file])
  })
})
