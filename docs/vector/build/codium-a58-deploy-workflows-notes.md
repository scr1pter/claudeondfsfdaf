# A58: Deploy workflows

A58 adds the three hosted workflows of contract §6.2: CI for the hosted services on pull requests, the dispatch-only
deploy of the two Cloudflare Workers (A39's relay, A46's ops Worker), and the dispatch-only image build and bake for
the cloud computer (A54). It builds on A56's budget workflow (same environment, same pinned Vercel CLI). No workflow was
run, nothing was pushed or deployed, and no Cloudflare, Vercel, GitHub or registry API was called. Readings of the
contract are in `codium-deviations.md` under "A58 Deploy workflows (9 Nov 2026)".

## What changed

| Area | Files |
|---|---|
| CI | `.github/workflows/vector-hosted-ci.yml` (new): pull requests on the hosted paths; typecheck (api, schema, core, desktop, relay, ops-worker, hosted-computer, cloud); the hosted tests against Valkey and Postgres; both Workers' dry runs and smoke tests; the image built and booted in Docker. `contents: read`, no secret. Also `workflow_call` (`services_only`) and `workflow_dispatch` |
| Codium lane | `.github/workflows/vector-codium.yml`: its relay, ops-worker and hosted-image jobs moved into `vector-hosted-ci.yml`; one `hosted` job calls it with `services_only: true` |
| Deploy | `.github/workflows/vector-hosted-deploy.yml` (new): dispatch, `target` relay, ops or all; preflight with no secret; deploy jobs in `hosted-production` with `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` |
| Image | `.github/workflows/vector-hosted-image.yml` (new): dispatch with `generation`, `min_disk_generation`, `cli_version`; preflight with no secret; one job in `hosted-production` that builds, checks, pushes and bakes |
| Scripts | `packages/cloud/src/hosted-workers.ts` (new: the Worker config and secret-name checks), `packages/cloud/src/hosted-image.ts` (new: the CLI from a published release, the registry tag, sign-in and digest), `packages/cloud/src/codium-ci-tests.ts` (`--hosted`) |
| Workers | `packages/relay/package.json`, `packages/ops-worker/package.json`: scripts `deploy` and `secret-names` |
| Tests | `packages/cloud/src/workflow-compliance.test.ts` (the hosted workflows; the three files join the pinning list), `hosted-workers.test.ts`, `hosted-image.test.ts` (new); `packages/cloud/package.json` test script |
| Docs | `docs/vector/owner-actions/remote.md` and `hosted-ops.md` (step 6, deploy), `hosted-computer.md` ("Building and baking"), `docs/vector/MODEL-PLANS.md` (A58 bullet), `codium-deviations.md` |

No edits to `api/_lib/model-plan-*.ts`. No generator inputs changed.

## How it works

**Hosted CI.** Pull requests that touch `api/`, `test/`, the relay, the ops Worker, the cloud computer, the schema,
core's Vault, WebAuthn or Remote crypto, the desktop's `remote-*`, `vault-*` or `hosted-*` modules, the hosted scripts,
the hosted SQL, `bun.lock` or the hosted workflows run it. It holds no secret and can only read. The tests job builds the
same dependencies as the Codium lane and runs `codium-ci-tests.ts --hosted`: every root test and the tests of those
parts, one Bun process per file. The relay and ops-worker jobs run `bun run dry-run` (`wrangler deploy --dry-run`) and
`bun run smoke`; the image job builds with a stand-in CLI and runs `test/image.test.ts` against it. The Codium lane runs
only these last three jobs, through the same file.

**Deploy (`vector-hosted-deploy.yml`).** The owner dispatches it on `main` and picks `relay`, `ops` or `all`.

1. `preflight` (no environment, `contents: read`, `actions: read`, no secret): `hosted-production` has a required
   reviewer; its deployment branches are protected branches only; `main` is protected; the dispatched commit is an
   ancestor of `origin/main`. It outputs that commit.
2. `relay` and/or `ops` (`hosted-production`, so each waits for approval): check out the preflight's commit with no
   stored credential, check it is still on `main`, install from the lockfile without the shared cache, run
   `hosted-workers.ts config <target>` (name, a real kill-flag namespace id, no secret in `vars`), the dry run,
   `bun run secret-names | hosted-workers.ts secrets <target>` (every secret the owner must set is there; names only),
   then `bun run deploy`. Only those last two steps see the Cloudflare token and account id. Nothing sets a secret.

**Image (`vector-hosted-image.yml`).** The owner dispatches it on `main` with the generation, the oldest disk generation
it accepts, and an exact published CLI version.

1. `preflight`: the same four checks, then the inputs (whole numbers from 1, the minimum not above the generation, a
   stable `x.y.z` version), written as outputs. The image job reads only those outputs.
2. `image` (`hosted-production`): same checkout, check and install; `bun run build` in `packages/hosted-computer`;
   `hosted-image.ts cli` puts the release's `linux-x64-baseline-musl` binary at `bin/vector` after checking the manifest,
   size, SHA-256, the archive's entries and the ELF header, and writes the release's source commit, which must be on
   `main`; `docker build --platform linux/amd64` with both generations; `test/image.test.ts` against the built image;
   then the push step (registry tag from `VECTOR_HOSTED_IMAGE_REPOSITORY`, `vercel vcr login docker` into a temporary
   Docker config deleted at the end, a generation already in the registry refused, `docker push`, the digest read back);
   then `bake-snapshot.ts --image <digest> --generation <n>`, whose `VECTOR_HOSTED_BASE_SNAPSHOT=<id>` line is printed
   and copied to the run's summary. Only the push and bake steps see `VECTOR_HOSTED_VERCEL_TOKEN`.

## Tests run here (one file at a time, from `packages/cloud`)

| File | Result |
|---|---|
| `src/hosted-workers.test.ts` | 7 pass |
| `src/hosted-image.test.ts` | 8 pass |
| `src/workflow-compliance.test.ts` | 45 pass |
| `src/hosted-budget.test.ts` (unchanged; now in the package's test script) | 21 pass |

What the compliance tests run for real: each preflight's environment check, branch-rule check and main check are run as
written in bash, with only `gh` stubbed; the main check runs against a scratch git repository with a bare origin (a
commit on `main` passes; a commit off `main`, an unprotected or unreadable `main`, or a checkout that is not the
dispatched commit is refused). The image inputs check runs as written. The push step runs as written with `bun` and
`docker` stubbed: it signs in before the registry lookup, refuses a generation already present or an unreadable
lookup, and writes `image=<digest>`. A mutation check (the ancestry line replaced by `true`) made the main test fail;
the file was restored.

Typecheck: `packages/cloud`, `packages/relay`, `packages/ops-worker` (`tsgo --noEmit`) are clean. No `api/` file
changed.

## CI only

- **`vector-hosted-ci.yml` has never run.** Its first pull request (or the Codium lane's next push, which calls it with
  `services_only`) is the first run. Calling a workflow that also has `pull_request` and its own `concurrency` (a
  distinct group name) from the Codium lane is standard GitHub behaviour but has not been seen working here. The tests
  job's `--hosted` set has not run in CI as a whole; every file in it already runs in the Codium lane.
- **The deploy and image workflows have never run.** They need the default branch (GitHub lists dispatch workflows only
  from there), the `hosted-production` settings, a protected `main`, and for the image Vercel's written OK. Never
  exercised anywhere: `wrangler secret list` and `wrangler deploy` against Cloudflare with an API token,
  `vercel vcr login docker` at `vercel@65.3.1` (it may not have `vcr`), the registry's "not found" wording for a new tag,
  `docker inspect`'s RepoDigests for a VCR push, the bake on Vercel, and the published CLI fetched from the download
  store.

## For the owner

Before the first dispatch, in GitHub: protect `main` with a branch protection rule; in the `hosted-production`
environment keep yourself as required reviewer and set its deployment branches to protected branches only; add the
secrets `CLOUDFLARE_API_TOKEN` (Workers Scripts: Edit on the Workers' account) and `CLOUDFLARE_ACCOUNT_ID`, and for the
image the secret `VECTOR_HOSTED_VERCEL_TOKEN` and the variables `VECTOR_HOSTED_VERCEL_TEAM_ID`,
`VECTOR_HOSTED_VERCEL_PROJECT_ID` and `VECTOR_HOSTED_IMAGE_REPOSITORY`. Commit each Worker's real namespace id and set
its secrets with `wrangler secret put` first (owner-actions/remote.md and hosted-ops.md, steps 2 to 5); the deploy
refuses otherwise.

## Not done

- The CLI's notice files are not copied into the image (A54's Dockerfile takes only `bin/vector`); for the legal read.
- No rollback dispatch: rolling a Worker back means dispatching an older commit of `main` from a protected branch, or
  `wrangler rollback` by the owner.
- Nothing was pushed, deployed or run. bun.lock was not touched.

**Status, 9 Nov 2026 (P8 review).** The sections above describe their own day. The image job's registry login runs
`vercelCli`, which since P8's review (`codium-p8-repairs.md`) installs the pinned CLI with npm, install scripts off and
no secret in npm's environment, instead of `npx --yes`. Images built from now on carry hostd's signed heartbeats, which
the server requires; a computer from an older image is refused.

**Status, 15 Nov 2026 (Codium finish CI0).** `vector-codium.yml`'s `workflow_dispatch` now takes two optional string
inputs, `base` (the remote branch the test picker compares with instead of `origin/main`) and `browser_specs` (up to ten
more app browser specs). They reach `codium-ci-tests.ts` only as step environment (`CODIUM_CI_BASE`,
`CODIUM_CI_BROWSER_SPECS`), where `diffBase` and `requestedBrowserSpecs` check them before git or Playwright sees them.
Pushes, `--hosted` and `vector-hosted-ci.yml` are unchanged. The reasons and counts are in `codium-deviations.md`
("Codium finish: CI0 lane dispatch inputs"); the first dispatch's run is recorded in a later dated line.

**Status, 15 Nov 2026 (Codium finish TB).** The inputs work as dispatched. Vector Codium run 43659654730 (base
`origin/release-finish`, no specs) and run 43661511343 (the same base and four receipt specs), both on 02c9fc14: each
Select step's env shows the values, the browser jobs (132645885892 and 132651657817) ran 2 and 6 specs and passed, and
each Codium tests job (132645886182 and 132651658143) picked 120 files and ran in about two minutes, against 40 minutes
and a timeout before CI0. Neither run is green: both stop at "Codium: 119/120 test files passed" on
`packages/web/test/model-plan-gateway-hooks.test.ts`, plus the exerciser's four review-memory MISS lines. The ids,
steps and the failure's cause are in `codium-deviations.md` (the CI0 section's dated line and "Codium finish: Track B
receipts and P4 closings").

**Status, 15 Nov 2026 (Codium finish H2b).** Closes the "Not done" bullet on the CLI's notice files. The image now
carries `LICENSE`, `THIRD_PARTY_NOTICES.md` and `DEPENDENCY_NOTICES.md` in `/usr/share/vector/` (root's, files 0644,
folder 0755), the folder the Vector CLI container uses, next to `/usr/local/bin/vector`. The image workflow's `cli`
step (`hosted-image.ts cli --output packages/hosted-computer/bin/vector --notices packages/hosted-computer/notices`)
copies them unchanged from the same verified release archive as the binary, before the binary. It refuses to run
when the binary or the notices folder already exists, and each copy refuses to write over anything. The CI image job's stand-in step writes placeholder files under the same names, so CI still
builds without a release; that image is never pushed. `in-image.mjs` checks the folder, the files' owner and modes, and
that the agent can read them. No notice text was edited and `DEPENDENCY_NOTICES.md` was not regenerated. The legal read
of these files as shipped stays the owner's (spec 8.2 step 15). The real files in a real image are checked only by the
owner's vector-hosted-image.yml run. Tests: `packages/cloud` `src/hosted-image.test.ts` and
`src/workflow-compliance.test.ts`, and `packages/hosted-computer` `test/image.test.ts`, run locally; the Docker job is
CI. `codium-deviations.md` "Codium finish: H2 image notices (15 Nov 2026)".
