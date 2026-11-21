# everywhere-push-guard: EV-16-home and EV-03

Branch `everywhere-push-guard`, cut from origin/main `b87cc462f`. It covers two Vector v2 leftover P0 items. They share one builder because both edit `packages/desktop/src/main/everywhere-runner.test.ts`. The feature stays dormant: `OFFER_KEYS` is empty and `VECTOR_EVERYWHERE_ENABLED` stays off.

The lane's deviations, handoff and progress files are in the open v2-closeout-ci PR, so the dated entries live here. Fold them back into `vector-everywhere-deviations.md` (EV-16 "Left open" and EV-03 "The draft PR after a stop") once that PR merges.

Files: `packages/desktop/src/main/everywhere-scan.ts` and its test, `packages/desktop/src/main/everywhere-runner.ts` and its test, `packages/web/src/drafts/docs/everywhere.astro` (the unrouted docs draft, not consent text) and `packages/web/test/everywhere-docs.test.ts`.

## 2026-11-21, EV-16 home secrets before push

**What it closes.** This is the second option of the precondition in the deviations log (EV-16, "Left open", the bullet "Plaintext stores and other projects' files in the home folder", :1563 at `b87cc462f`): scan the staged diff before the push. The first option, a tmpfs home folder with the toolchain folders bound back, waits for `packages/engine/src/tool/shell/sandbox.ts`, which scope-finish and v2-closeout-ci hold, and for ruling R3. Until then `$HOME` stays readable inside the sandbox. This change only keeps what a command copies out of `$HOME` from leaving in a push.

**The gap.** Before a push, the only gate was `mayPushDiff`. It checked the added lines with `secretLike` alone, which knows token prefixes and PEM headers. `checkedSummary` did the same. A `DATABASE_PASSWORD=…` line, or a whole `.env.production` copied in from another project, passed the gate and left with the private repository's draft pull request.

**The fix** (desktop only; `everywhere-git.ts` and the `RunnerGit` shape are unchanged):

- `stagedPaths(diff)` reads the `+++ b/<path>`, `rename to` and `copy to` headers outside every hunk. A `+++` line inside a hunk is added content. It removes the tab git appends to a `+++` line whose path holds a space, decodes C-quoted paths (octal bytes as UTF-8), and skips a deletion's `+++ /dev/null`. It returns undefined, which the gate treats as unsafe, for a header it cannot read: a missing `b/` prefix, an empty path, a bad escape, an unterminated quote or invalid UTF-8. These formats were checked against real git output: the tab after `b/my notes/.env`, and `"b/caf\303\251/.env"`. The runner's git runs with no global or system config, and its allowlist refuses `diff.*` and `core.quotepath`, so the prefixes are always git's defaults.
- `credentialPath(path)` judges the file name, lowercased and without Windows' trailing dots and spaces. It is true for:
  - `.env`, and `.env.*` unless the final suffix is `example`, `sample`, `template`, `dist` or `defaults`. So `.env.local.example` is a template, but `.env.example.bak` is not.
  - `.netrc`, `_netrc`, `.pgpass`, `.git-credentials`, `.pypirc`, `.vault-token`, `.s3cfg`, `credentials` and `kubeconfig`.
  - `id_rsa`, `id_dsa`, `id_ecdsa` and `id_ed25519`, with or without `_sk`.
  - `*.pem`, `*.key`, `*.p12`, `*.pfx`, `*.jks`, `*.keystore`, `*.tfvars` and `*.tfstate`.

  The lists are defined in this file. Nothing is imported from VectorScope's `packages/core/src/review/holdback.ts`.
- `envSecret(text)` flags two kinds of line:
  - A `NAME=value` or `NAME: value` assignment anywhere in a line (so a leading `export` or `ENV` changes nothing), when the name is upper-case env style and contains an underscore-delimited secret word: PASSWORD, PASSWD, PASS, PWD, SECRET, TOKEN, API_KEY, APIKEY, ACCESS_KEY, PRIVATE_KEY, CLIENT_SECRET, CREDENTIAL(S) or DSN.
  - npm's `:_authToken=`, `_auth=` and `_password=` lines.

  The value is a quoted string, a `<…>` placeholder, a `${{ … }}` expression or the next word. It is read with a lookahead, so `ENV=DB_PASSWORD=…` is still scanned. These values are placeholders and are skipped: empty, `${…}`, `$VAR`, `${{ secrets.X }}`, `<…>`, `***`, `xxx…`, `changeme` and `your-…`. core's `BrainScan.named` is not used, because it flags code such as `const token = getToken()`.
- `mayPushDiff` returns false when the paths cannot be read, when `envSecret(lines)` is true, or when any staged path is a credential path. In each case this happens before the posting check is asked. `checkedSummary` returns `WITHHELD.secret` when `envSecret(text)` is true.

**Choices beyond the plan's letter, for the reviewer.**

- Names must be upper case, `NAME=value` takes no space before `=`, and `NAME: value` needs a space after `:`. Without these rules the gate flags code: `{ token: getToken() }`, `password: string` and `const API_TOKEN = process.env.API_TOKEN`. The cost is that a lower-case YAML key such as `password: hunter2` is not caught.
- The `your-` placeholder also accepts `your_`.
- `copy to` is read as well as `rename to`. git's default diff does not detect copies, so this only adds coverage.

**What could go wrong.**

- False positives settle the job `held`: the branch stays local and nothing is pushed, so they fail closed. Known shapes: names such as `TOKEN_URL`, `PASS_THROUGH` or `MAX_TOKEN` with a literal value, public certificates in `*.pem`, and non-secret `*.key` files. A summary that names such an assignment is withheld.
- The scan is heuristic. A secret with an unknown name and shape still passes. So do JSON keys (`"DB_PASSWORD": "x"`), lower-case YAML keys, `.envrc` and a `${VAR:-literal}` default. EV-16-socket (R3) and the tmpfs-home follow-up remain.

**Tests.**

- `everywhere-scan.test.ts` has four new cases:
  - :77, "a copied env file or env-style secret never authorizes a push, and the summary is withheld". The posting check is a fake that always answers clean.
  - :93, every credential name and env-form secret is refused before the posting check.
  - :128, templates, placeholders, public keys and code stay pushable.
  - :156, quoted, spaced, renamed and deleted paths, and five headers the gate cannot read.
- `everywhere-runner.test.ts` :542 is "a staged diff carrying … stays on the computer and settles held", in two variants: a `STRIPE_SECRET_KEY` line in `notes.txt`, and a new `config/.env.production`. Each settles `held` with its local branch, with no commit, push, `pushing` report or `open-pr`. Only the summary reaches the posting check.

**Evidence** (each file run alone with `--timeout 30000`):

- Red-before. With main's `everywhere-scan.ts` put back in the working tree and the tests unchanged:
  - The scan file gave 5 pass and 3 fail. The failures were :77, :93 and :156; :128 passes on both, because it guards against over-blocking.
  - The runner file gave 57 pass and 2 fail, both :542 variants.
  - The restored file's sha256 matched.
- Green: scan 8 of 8, runner 60 of 60 (at the end of the branch). `bun typecheck` passed in packages/desktop.
- Mutation M1 deleted the `envSecret(lines)` clause in `mayPushDiff`. The notes.txt line (:79) went red, and so did :93's env lines. The file was restored and its sha256 compared equal.
- Mutation M2 deleted the `paths.some(credentialPath)` check. The `.env.production` line (:80) went red, with :93 and :156. Restored, sha256 equal.

Commits: `ef2f03a78` (scan), `4d0cf9a97` (runner case).

## 2026-11-21, EV-03 no draft PR after a stop

**What it decides.** The open question in the deviations log, EV-03, "The draft PR after a stop heard during the push" (:350 at `b87cc462f`). Lead ruling (v2-rulings, section 3 calls): suppress the PR on `cancelled` only.

**The fix.** `everywhere-runner.ts` :403 now reads:

```ts
const prUrl = abortedFor("cancelled") ? undefined : await deps.openPr({...}).catch(() => undefined)
```

`abortedFor(reason)` (:229) is `controller.signal.aborted && outcome === reason`. The plan's inline form fails typecheck with TS2367: at that point TypeScript narrows `outcome` to `"failed"`, because `abort` assigns it only from callbacks. The helper, defined beside `abort`, reads the declared type and has the same meaning.

Which outcomes still open the PR:

- `cancelled` (a stop, a `lost` answer, a 404 or 409 heartbeat, or the toggle, Vector Local or model switch turned off during the admitted push): the push still finishes, as C3 requires, but no draft PR opens. The delivered `changes` result names the branch and carries no `prUrl`.
- `over-budget` (the deadline): the PR still opens.
- `interrupted` (the lease ran out): the PR still opens.
- If the lead wants `interrupted` suppressed too, the condition becomes `controller.signal.aborted && !abortedFor("over-budget")`. The new :165 case then goes red (mutation M5).

**Docs copy.** The stop paragraph in `packages/web/src/drafts/docs/everywhere.astro` (:150-151) now reads: "Stopping it aborts the job on your computer and nothing more is pushed. A push that has already started finishes, but no draft pull request opens for it." `everywhere-docs.test.ts` pins both sentences and refuses the old clause, "draft pull request can still open".

**Tests.**

- In the switch-stop loop (:966) and the stop, lost, 404 and 409 receipt loop (:1023), the confirmed variants now expect no `open-pr` and no `prUrl`. These cases had pinned the behaviour the deviations log called an open question. They are now stricter.
- The deadline case (:146) now also pins one `open-pr`, with `prUrl` equal to `https://github.com/acme/app/pull/4`.
- New case (:165): a lease that runs out during an admitted push still opens the PR. This pins the ruling's `interrupted` half.

**Evidence.**

- Red-before, with only `everywhere-runner.ts` reverted: 55 pass and 5 fail. The failures were exactly the confirmed variants: the switch stop, and stop, lost, 404 and 409. The restored file's sha256 matched. Green: 60 of 60, and `bun typecheck` passed in packages/desktop.
- Docs red-before, with only the `.astro` page reverted: 16 pass and 1 fail ("says what the contract holds"). Green: 17 of 17. In packages/web, `bun typecheck` (astro check) reported 0 errors.
- Mutation M3, dropping the `cancelled` condition (any abort suppresses): the deadline case :146 went red, and so did :165.
- Mutation M4, making `openPr` unconditional again: the five confirmed stop variants went red, :966 among them.
- Mutation M5, the `!== "over-budget"` alternative: :165 went red.
- Each mutation was restored and its sha256 compared equal.

**Left open (unchanged by this branch).**

- After a stop, the pushed branch has no PR. The settle reports the branch, but under the stop switch the jobs API answers that settle 200 `stop` without recording it, so the reply may name nothing (deviations, EV-03, "A 200 `{action: "stop"}` answer to a settle counts as delivered").
- The "no settle after 404/409" choice, options (b) and (c) at :348, stays the lead's.

Commits: `25af5fa52` (runner), `fd9213e50` (docs copy).

## Commands

```sh
cd packages/desktop && bun --no-env-file test --timeout 30000 ./src/main/everywhere-scan.test.ts
cd packages/desktop && bun --no-env-file test --timeout 30000 ./src/main/everywhere-runner.test.ts
cd packages/web && bun test --timeout 30000 test/everywhere-docs.test.ts
```

CI: `vector-everywhere.yml` runs on `packages/desktop/src/main/everywhere-*`.
