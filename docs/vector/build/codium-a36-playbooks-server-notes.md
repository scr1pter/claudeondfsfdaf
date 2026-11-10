# A36: Playbooks server

A36 follows A43 (`613a2395`) and implements the contract's WP A36 on top of A05 (the entitlement snapshot) and A37
(`r2-presign.ts`). No engine route, config schema or SDK input changed, so no generator ran. No service, account,
bucket or provider was called: the store and the R2 bucket are fakes in the tests.

## What changed

- **`api/account/playbooks.ts` (new).** `GET /api/account/playbooks` answers `[{name, version, sha256, url}]`, every
  published playbook with a presigned GET to its file that lives 10 minutes.
  - Dark: until `listedPerks()` has `playbooks`, every request (any method, signed in or not) gets 404 `NOT_FOUND`,
    before any sign-in, snapshot or rate counter is read.
  - Only a valid, unrevoked `vct_` account token; run tokens and sessions get 401 (S3).
  - 60 requests an hour per account.
  - `requireEntitlement(account, "playbooks")` from the snapshot (S1): Pro, Max and Ultra while active or renewing
    (§4.4). Refusals are the contract's 402/403/503. With a fresh snapshot the route reaches only the store: no Stripe
    call and no bucket call (M4); signing is local.
- **`api/_lib/playbooks.ts` (new).** The library and its links.
  - The library is one hash, `vector:codium:<mode>:playbooks`: field = name, value =
    `{v: 1, name, version, sha256, bytes, key, publishedAt}`.
  - A version's file is `playbooks/<name>/<version>.json` in `vector-media` (live) or
    `playbooks/test/<name>/<version>.json` (test).
  - `decodePlaybookRecord` refuses a record whose key is not exactly that path for its name, version and the server's
    mode, so a bad record is never listed or signed, and a live server never reads the test library.
  - `readPlaybooks` (HVALS, newest version per name, sorted, at most 50), `readPlaybook`, `playbookLinks`,
    `publishPlan` (new, same, or refused), `recordPlaybook` (HSET) and `withdrawPlaybook` (HDEL).
  - `playbooksReady`: Track B live, the media bucket configured, the store configured and at least two published.
- **`api/_lib/codium-perks.ts`.** `playbooks` gets that readiness check. It still also needs `CODIUM_LISTED_PERKS`,
  `CODIUM_TRACK_B_LIVE=true` and the perk switch, as before.
- **`packages/schema/src/playbooks.ts` (new, `@vectordevai/schema/playbooks`).** `NAME` (`vector-` and lower-case
  words, at most 64 characters), `VERSION` (`x.y.z`), `MAX_BYTES` (256 KiB, a saved workflow's limit),
  `LINK_SECONDS` (600), `MAX_LISTED` (50), `MINIMUM` (2), the `Link` type, `compareVersions`, and `decodeLinks` for
  B07's client. Browser-safe.
- **`packages/core/src/playbooks/commands.ts` (new).** The skill command allowlist: the learned skills' `simple`,
  `helper` and `check` from Track B's `brain/skill.ts`, copied unchanged because that module is not on this branch.
  `allowed(command)` is helper or check. B01 should make this file a re-export of BrainSkill's.
- **`packages/core/src/playbooks/check.ts` (new).** `PlaybookCheck.validate({name, bytes, env?})`, the check every
  playbook passes before it is published.
  - The name, at most 256 KiB, UTF-8 without a byte-order mark, one JSON object, nesting at most 32.
  - In every string, keys included: no hidden characters, no secret (by shape, name or wording, or a value of the
    publisher's own secret settings), no `!` followed by a backtick, no unbalanced backtick, no open fence.
  - Every code span is an allowed command or a repository file (one relative path, not a secrets file, not a script
    to run). Every line of a fenced block is an allowed command, unless the block is marked json, yaml, text, diff or
    markdown. A template value inside a command is refused.
  - It answers the commands and files the playbook names.
- **`script/playbooks-publish.ts` (new, owner).**
  - `check <file.json>...` runs the check alone, with no settings and no network, for CI and for the playbooks'
    own repository.
  - `publish <file.json> --version x.y.z --mode live|test` checks the file and works out the next step: a higher
    version is new, the same version with the same file does nothing, anything else is refused.
  - It then asks the bucket for the key (HEAD). The same file (R2's ETag is the MD5) is not uploaded again, and
    another file is refused.
  - If the key is free, it uploads through a presigned PUT that signs the exact `content-length` and
    `content-type: application/json`, then records the version.
  - `list` and `withdraw <name>`.
  - Settings are `KV_REST_API_*` and `VECTOR_R2_ACCOUNT_ID` with `VECTOR_R2_MEDIA_*`. None is printed.
- **Docs.** `docs/vector/MODEL-PLANS.md` gains "Vector Playbooks". The contract readings are in `codium-deviations.md`
  under "A36 Playbooks server (4 Nov 2026)".

## Edits to `api/_lib/model-plan-*.ts`

None.

## Tests

Run one file at a time with `--timeout 30000`: root tests from `test/`, package tests from their package.

| File                                                                              | Result   |
| --------------------------------------------------------------------------------- | -------- |
| `test/playbooks-api.test.ts` (new; the contract's `playbooks-api.test.ts`)        | 15 pass  |
| `packages/core/test/playbooks/commands.test.ts` (new)                             | 11 pass  |
| `packages/web/test/codium-public.test.ts` (unchanged; listing)                    | 13 pass  |
| `test/api-module-loading.test.ts` (unchanged)                                     | 1 pass   |
| `test/codium-mode.test.ts` (unchanged; key spelling)                              | 18 pass  |

`test/playbooks-api.test.ts` covers:
- Dark: 404 for every request when the perk is not in `CODIUM_LISTED_PERKS`, Track B is not live, Codium is off, the
  bucket is not configured, the perk switch or the `codium` switch is off, one playbook is left, or the store is down.
  In each case nothing about the account is read.
- Readiness: Track B, bucket, store, and at least two published.
- Downloads for Pro, Max and a renewing Ultra: the exact listing, the 10-minute host-only links to the test keys, and
  `decodeLinks` accepting it. A download through the link has the listed SHA-256.
- M4: only the store is reached.
- S1: Plus (403 with `{perk: "playbooks", plan: "vector-50"}`), no plan, paused, frozen and ended.
- S3: no token, run tokens, a malformed token and a revoked account.
- Only GET, and the hourly limit.
- Malformed library records are never listed or signed, and a live server does not read the test library.
- The script:
  - `check` needs no settings and reaches nothing, and refuses `npm publish` and `git push`.
  - `publish` sends HEAD, then one signed PUT of exactly the file, then writes the record; a rerun does nothing.
  - A changed file under a published version, an older version, and a withdrawn version with other content are
    refused. A bad playbook is never uploaded.
  - Missing settings are named, and nothing printed holds a setting's value. `list`, `withdraw` and the command line.
- `publishPlan`, `compareVersions` and `decodeLinks`.

`packages/core/test/playbooks/commands.test.ts`:
- BrainSkill's own command cases from Track B (`simple`, `check`, `helper`, leading assignments), run unchanged
  against the copy.
- The publish check: allowed commands and files pass and are listed. Every disallowed span is refused in a prompt, a
  title or a description: publish, push, `rm -rf`, `make deploy`, `curl`, `bash -c`, a bare word, scripts,
  `../`, absolute paths, `~`, secrets files, `;` and `$()`.
- Command blocks versus data blocks, an open fence, template values, `!` before a backtick, stray backticks, hidden
  characters, secrets (wording, token shape, a setting's value), keys, the name, size, encoding and shape, and
  `repositoryFile`.

**CI only:** nothing in A36 needs a service, so every case ran here. The Codium lane picks both new test files; neither
has run in CI yet. Never exercised anywhere: a real upload to and download from R2. The SigV4 signer itself is checked
against AWS's published example in `test/r2-presign.test.ts` (A37).

**Status on 8 Nov 2026.** A36 went up with the A36–A43 batch (head `aa35701e`). `test/playbooks-api.test.ts` passed in
Vector Codium run 41942473092, Codium tests job 126966439936 (15 pass). That run was red only in its Remote relay job,
and the next run, 41958430737 (head `31820732`), was green. For `packages/core/test/playbooks/commands.test.ts` the
file-level result is unconfirmed: the job logs read hold only their last ~5,000 lines, and this file is not in them.

Typecheck:
- `packages/schema` and `packages/core`: `tsgo --noEmit`, clean.
- Root `tsconfig.json` (api): clean.
- `script/playbooks-publish.ts` and `test/playbooks-api.test.ts` are outside every typecheck config, as before. They
  were also checked once with a scratch config (bun and node types) and are clean.

## For Track B (B01, B07)

- B01: make `packages/core/src/playbooks/commands.ts` re-export `BrainSkill.simple`, `helper` and `check`, and keep
  `packages/core/test/playbooks/commands.test.ts` passing.
- B07's client:
  - reads the listing with `Playbooks.decodeLinks`, downloads each `url` within 10 minutes and checks the SHA-256
    before writing `workflows/<name>.json`;
  - can run `PlaybookCheck.validate` again on install;
  - should add its workflow schema check to `script/playbooks-publish.ts` once the schema is on this branch: models
    only as `codium:floor|default|ceiling`, nested stages naming only `vector-*` playbooks.
- The estimate API's `{kind: "playbook", id}` band is not built (`model-plan-estimate.ts` leaves it to Track B).

## Owner steps

- `vector-media`'s lifecycle rules (contract §6.1: 30 and 90 days) must not cover `playbooks/`, or published files
  disappear.
- Publish with `bun script/playbooks-publish.ts publish <file> --version 1.0.0 --mode test` on the preview store first.
  List `playbooks` only after Track B ships and two playbooks are proven.

## Not done

- Every client piece (B07), and the estimate band.
- bun.lock was not touched. Nothing was pushed or deployed.
