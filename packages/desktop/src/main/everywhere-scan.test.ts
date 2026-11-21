import { installFetchGuard } from "../../../web/test/lib/everywhere-fetch-guard"
import { expect, test } from "bun:test"
import { createJobId, randomId, type EverywhereJob } from "@vectordevai/schema/everywhere"
import { WITHHELD } from "@vectordevai/schema/everywhere-policy"
import { addedLines, checkedSummary, mayPushDiff, type PostingCheck } from "./everywhere-scan"

installFetchGuard()

const NOW = Date.now()
const JOB: EverywhereJob = {
  v: 1, jid: createJobId(NOW), platform: "slack", kind: "mention", requester: { label: "Requester", self: true },
  repository: { id: 101, fullName: "acme/app", shared: false }, task: "Fix retry handling", context: [],
  limits: { maxUsd: 50, minutes: 120, deadline: NOW + 120 * 60_000 }, reply: { format: "slack", maxChars: 1500 },
  lease: { id: randomId(), expiresAt: NOW + 5 * 60_000 },
}

/** A new file as `git diff --cached` writes it. */
function added(path: string, ...lines: string[]) {
  const count = lines.length === 1 ? "" : `,${lines.length}`
  return `diff --git a/${path} b/${path}\nnew file mode 100644\nindex 0000000..1111111\n--- /dev/null\n+++ b/${path}\n@@ -0,0 +1${count} @@\n${lines.map((line) => `+${line}\n`).join("")}`
}

/** A local posting check that always answers clean, counting what reaches it. */
function cleanCheck() {
  const seen = { calls: 0 }
  const check: PostingCheck = async (parts) => { seen.calls++; return { status: "clean", parts } }
  return { seen, check }
}

test("only added text reaches the local posting check, and binary or secret changes stay local", async () => {
  const diff = "--- a/file\n+++ b/file\n@@ -1 +1 @@\n-old private text\n+new text\n"
  expect(addedLines(diff)).toBe("new text")
  let calls = 0
  const check = async (parts: readonly string[]) => { calls++; expect(parts).toEqual(["new text"]); return { status: "clean" as const, parts } }
  expect(await mayPushDiff(diff, ["ses_fixture"], check)).toBe(true)
  expect(await mayPushDiff("GIT binary patch\nliteral 3", [], check)).toBe(false)
  expect(await mayPushDiff("@@ -0,0 +1 @@\n+-----BEGIN PRIVATE KEY-----\n", [], check)).toBe(false)
  expect(calls).toBe(1)
})

test("changed, unavailable and interactive posting decisions never authorize a push", async () => {
  const diff = "@@ -0,0 +1 @@\n+new text\n"
  let calls = 0
  expect(await mayPushDiff(diff, [], async () => { calls++; return { status: "ask", parts: ["new text"] } })).toBe(false)
  expect(await mayPushDiff(diff, [], async () => { calls++; return { status: "changed", parts: ["new text"] } })).toBe(false)
  expect(await mayPushDiff(diff, [], async () => { calls++; throw new Error("fake outage") })).toBe(false)
  expect(calls).toBe(3)
})

test("three-plus additions are hunk content, so secrets and privacy checks cannot be skipped", async () => {
  const diff = "diff --git a/file b/file\n--- a/file\n+++ b/file\n@@ -0,0 +1,2 @@\n+++private marker\n++++source text\n"
  expect(addedLines(diff)).toBe("++private marker\n+++source text")
  let calls = 0
  expect(await mayPushDiff(diff, [], async (parts) => {
    calls++
    expect(parts).toEqual(["++private marker\n+++source text"])
    return { status: "ask", parts }
  })).toBe(false)
  let secretChecks = 0
  expect(await mayPushDiff("@@ -0,0 +1 @@\n+++-----BEGIN PRIVATE KEY-----\n", [], async (parts) => {
    secretChecks++
    return { status: "clean", parts }
  })).toBe(false)
  expect(secretChecks).toBe(0)
  expect(calls).toBe(1)
})

test("truncated or extra hunk content fails closed and multiple valid hunks retain every addition", () => {
  expect(addedLines("@@ -0,0 +1,2 @@\n+only one\n")).toBeUndefined()
  expect(addedLines("@@ -0,0 +1 @@\n+one\n+extra\n")).toBeUndefined()
  expect(addedLines("+headerless content\n")).toBeUndefined()
  expect(addedLines("@@ -1,2 +1,2 @@\n keep\n-old\n+++new\n@@ -8 +8 @@\n-old\n+last\n\\ No newline at end of file\n")).toBe("++new\nlast")
})

// EV-16-home: a command can copy another project's .env out of the home folder into the checkout, and the push would
// carry it. The gate refuses env-form secrets and credential files before the posting check is asked.
test("a copied env file or env-style secret never authorizes a push, and the summary is withheld", async () => {
  const { seen, check } = cleanCheck()
  expect(await mayPushDiff(added("notes.txt", "DATABASE_PASSWORD=hunter2hunter2"), ["ses_fixture"], check)).toBe(false)
  expect(await mayPushDiff(added("config/.env.production", "FOO=bar"), ["ses_fixture"], check)).toBe(false)
  expect(seen.calls).toBe(0)
  expect(await mayPushDiff(added(".env.example", "API_KEY="), ["ses_fixture"], check)).toBe(true)
  expect(await mayPushDiff(added(".env.example", "API_KEY=<your key>"), ["ses_fixture"], check)).toBe(true)
  expect(await mayPushDiff(added("src/auth.ts", "const token = getToken()"), ["ses_fixture"], check)).toBe(true)
  expect(seen.calls).toBe(3)
  const summary = cleanCheck()
  expect(await checkedSummary(JOB, "Copied DB_PASSWORD=hunter2hunter2 from the other project into notes.txt.", ["ses_fixture"], summary.check)).toBe(WITHHELD.secret)
  expect(summary.seen.calls).toBe(0)
  expect(await checkedSummary(JOB, "Documented API_KEY=<your key> in the example file.", ["ses_fixture"], summary.check)).not.toBe(WITHHELD.secret)
  expect(summary.seen.calls).toBe(1)
})

test("every credential file name and env-form secret the gate knows keeps the branch local", async () => {
  const { seen, check } = cleanCheck()
  const files = [
    ".env", "app/.env.local", ".env.example.bak", "deploy/.ENV.", ".netrc", "_netrc", ".pgpass", ".git-credentials",
    ".pypirc", ".vault-token", ".s3cfg", "home/.aws/credentials", ".ssh/id_rsa", "id_dsa", "id_ecdsa", "id_ed25519",
    "id_ecdsa_sk", "id_ed25519_sk", "certs/server.pem", "tls.key", "store.p12", "store.pfx", "release.jks",
    "debug.keystore", "prod.tfvars", "terraform.tfstate", ".kube/kubeconfig",
  ]
  for (const file of files) expect({ file, push: await mayPushDiff(added(file, "fixture text"), [], check) }).toEqual({ file, push: false })
  const lines = [
    "export GITHUB_TOKEN=abc123def456",
    '  POSTGRES_PASSWORD: "hunter2"',
    "  - MYSQL_ROOT_PASSWORD=hunter2",
    "ENV DB_PASSWORD=hunter2",
    "ENV=DB_PASSWORD=hunter2",
    "SENTRY_DSN=https://abc123@o1.ingest.example.io/1",
    "AWS_SECRET_ACCESS_KEY=abcdEFGH1234",
    "STRIPE_APIKEY=abcd1234",
    "S3_ACCESS_KEY=abcd1234",
    "SIGNING_PRIVATE_KEY=abcd1234",
    "OAUTH_CLIENT_SECRET=abcd1234",
    "GOOGLE_CREDENTIALS=abcd1234",
    "SERVICE_CREDENTIAL=abcd1234",
    "DB_PASS=abcd1234",
    "DB_PASSWD=abcd1234",
    "REDIS_PWD=abcd1234",
    "TOKEN='abcd 1234'",
    "//registry.npmjs.org/:_authToken=abcd1234",
    "_auth=dXNlcjpwYXNz",
    "_password=cGFzcw==",
  ]
  for (const line of lines) expect({ line, push: await mayPushDiff(added("notes.txt", line), [], check) }).toEqual({ line, push: false })
  expect(seen.calls).toBe(0)
})

test("templates, placeholders, public keys and code stay pushable", async () => {
  const { seen, check } = cleanCheck()
  const files = [
    ".env.example", ".env.sample", ".env.template", ".env.dist", ".env.defaults", ".env.local.example", ".ssh/id_rsa.pub",
    "src/keys.ts", "src/environment.ts", "docs/credentials.md",
  ]
  for (const file of files) expect({ file, push: await mayPushDiff(added(file, "fixture text"), [], check) }).toEqual({ file, push: true })
  const lines = [
    "API_KEY=",
    "API_KEY=<your key>",
    "DB_PASSWORD=${DB_PASSWORD}",
    'DB_PASSWORD="${DB_PASSWORD}"',
    "export TOKEN=$TOKEN",
    "  GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}",
    "PASSWORD=***",
    "PASSWORD=xxxx",
    "SECRET=changeme",
    "API_KEY=your-api-key",
    "PASSPORT_ID=12345",
    "MAX_TOKENS=4096",
    "const token = getToken()",
    "  password: string",
    "//registry.npmjs.org/:_authToken=${NPM_TOKEN}",
  ]
  for (const line of lines) expect({ line, push: await mayPushDiff(added("notes.txt", line), [], check) }).toEqual({ line, push: true })
  expect(seen.calls).toBe(files.length + lines.length)
})

test("quoted, spaced, renamed and deleted paths are read, and a path the gate cannot read keeps the branch local", async () => {
  const { check } = cleanCheck()
  const file = (target: string, line = "FOO=bar") => `diff --git a/x b/x\nnew file mode 100644\n--- /dev/null\n+++ ${target}\n@@ -0,0 +1 @@\n+${line}\n`
  // git C-quotes unusual bytes, and ends a +++ line with a tab when its path holds a space.
  expect(await mayPushDiff(file(String.raw`"b/caf\303\251/.env"`), [], check)).toBe(false)
  expect(await mayPushDiff(file(String.raw`"b/\056env"`), [], check)).toBe(false)
  expect(await mayPushDiff(file(String.raw`"b/caf\303\251/.env.example"`), [], check)).toBe(true)
  expect(await mayPushDiff(file("b/my notes/.env\t"), [], check)).toBe(false)
  expect(await mayPushDiff(file("b/my notes/readme.txt\t"), [], check)).toBe(true)
  const renamed = (to: string) => `diff --git a/sample.txt b/${to}\nsimilarity index 100%\nrename from sample.txt\nrename to ${to}\n`
  expect(await mayPushDiff(renamed(".env"), [], check)).toBe(false)
  expect(await mayPushDiff(renamed("notes.txt"), [], check)).toBe(true)
  // Removing a credential file publishes nothing of it.
  expect(await mayPushDiff("diff --git a/.env b/.env\ndeleted file mode 100644\n--- a/.env\n+++ /dev/null\n@@ -1 +0,0 @@\n-FOO=bar\n", [], check)).toBe(true)
  for (const unreadable of ["c/file", "b/", String.raw`"b/bad\q"`, String.raw`"b/caf\303/x.txt"`, String.raw`"b/open`])
    expect({ unreadable, push: await mayPushDiff(file(unreadable), [], check) }).toEqual({ unreadable, push: false })
})
