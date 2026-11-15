# Cloud workspaces pilot

This implementation was built on the isolated `cloud-workspaces` branch from main `4299d743` and is merged with the `v2` integration branch. It adds `/workspaces`, an authenticated account gateway, a separate workspace supervisor and persistent container workspaces. It has local and hosted CI validation; it is not a deployed cloud service or a published desktop release. Its one dependency on another feature is account deletion, which on `v2` is Codium's staged deletion (WP A57, below). Codium sales and plan entitlements are not prerequisites for this pilot.

The pilot is off by default. Until the gateway answers `enabled` for an account, the account page shows no cloud workspaces section and its deletion copy does not mention them. The production site build still publishes `/workspaces`, and before sign-in that page says the pilot is private and not open to everyone yet.

## Product behavior

A pilot account can create a workspace from a GitHub repository, start a saved chat, approve a requested action and continue the same workspace from another browser. The page polls for updates every five seconds while visible and every twenty seconds while hidden. Each workspace keeps its repository, engine database and chat history on its own volume. Pause retains those files. Start reconnects to the saved engine data; a paused workspace must be started to read its full chat history. Delete removes the workspace and its data.

Public repositories need no clone token. A private repository needs an explicitly supplied GitHub token with access to that repository. The clone token exists temporarily in the initializer's private `/run` tmpfs and is removed after checkout; it is not stored in workspace metadata.

To publish code, first pause and review the exported diff. Publication takes another read-only snapshot and requires the same digest. A separately supplied, one-shot GitHub token stays in the supervisor and never reaches the engine or its tools. The server creates a deterministic workspace branch and a **draft pull request**. It does not force-push or merge. The first pilot supports one published snapshot per workspace; the saved receipt reconciles a retry whose reply was lost. Further changes after publication require continuing the existing pull request outside this publication action or creating another workspace. A changed original base branch is refused rather than overwritten.

## Architecture and authority

```mermaid
flowchart LR
  B[Signed-in browser] --> G[Account API gateway]
  G -->|Signed account, route and body| S[Workspace supervisor]
  S --> D[One engine and volume per workspace]
  D -->|Workspace-scoped credential| M[Bounded model relay]
  M --> P[Configured model provider]
  S -->|Reviewed snapshot, one-shot token| H[GitHub draft PR]
  S --> Q[SQLite metadata and control receipts]
```

- `api/cloud-workspaces.ts` and its library authenticate browser or existing CLI account tokens, check account revocation, require persistent rate limiting and enforce the pilot account allowlist. The browser cannot select a supervisor URL, engine address, host filesystem path or account identity.
- `signing.ts` binds the verified account, HTTP method, fixed route, timestamp, nonce and body hash with HMAC. The supervisor persists used nonces and rejects replay. The account token is not forwarded to the supervisor or container.
- `store.ts` uses SQLite WAL, prepared queries and immediate transactions. Ownership predicates protect account reads and writes. Creating/running quotas, total workspace quotas, account-scoped creation idempotency, revision CAS and model-call reservations survive restart. Public workspace metadata omits the engine password, runtime identity, idempotency key, call count, original commit and owner identity.
- `docker.ts` selects only managed containers and volumes with matching labels, image and resource configuration. Containers use UID/GID 10001, a read-only root, no added capabilities, no new privileges, finite memory/CPU/PID limits, bounded logs and private temporary files. Engine ports bind to host loopback. The Docker socket and host directories are not mounted in tenant containers.
- `worker/entry.mjs` embeds the existing Node engine through `Server.listen`, as desktop does. The gateway authenticates the account and the engine requires a workspace-scoped server password. This does not change or relax the standalone CLI's account gate. A long-lived account token and the primary provider key are never injected into the engine.
- `service.ts` owns lifecycle changes, the model relay, publication receipts and account-close fences. Model calls use the configured provider/model only, with the primary key retained on the supervisor. Engine routes exposed to the browser are a finite session, message, status, model and approval API, rather than an arbitrary engine proxy.
- The read-only exporter compares files against the original checkout commit, without running repository hooks, filters or diff drivers. Publication is limited to at most 100 changed text files, 4 MiB of changed content and a 256 KiB diff. Unsafe paths and changed symlinks or unsupported binary content are refused.

## Pilot limits and recovery

| Limit                                         | Default                             |
| --------------------------------------------- | ----------------------------------- |
| Creating/running workspaces per account       | 2                                   |
| Total retained workspaces per account         | 10                                  |
| Model requests over a workspace's lifetime    | 50                                  |
| Maximum output tokens per model request       | 4,096                               |
| Running lifetime per explicit Start           | 120 minutes                         |
| Container CPU, memory, disk and PID allowance | 2 CPUs, 4,096 MiB, 10 GiB, 512 PIDs |
| Reaper interval                               | 20 seconds                          |

The model counter does not reset on pause, Start or supervisor restart. These are request and resource limits, not a metered dollar budget or a billing integration. The stored `runningSince` boundary does not move when a model request updates workspace activity. Model admission checks that boundary directly, and the reaper retires expired engines.

Pause blocks new model admission before stopping the engine. Unknown model outcomes persist a block; they are not silently retried against the provider. After a supervisor restart, active engines are blocked and their retirement is attempted before the service starts listening. The user must explicitly Start and send a new turn. A separate durable pending-retirement record denies engine POSTs and model admission until the old engine is confirmed stopped, so a new prompt cannot clear that quarantine; failed retirement retains the active quota and is retried by the reaper, including creating workspaces. Private `message-identities.ts` storage allocates the engine's canonical chronological message IDs from stable client request UUIDs, bounded to 500 allocations per workspace. A durable payload hash rejects changed content under the same ID, retries do not dispatch the same turn twice, and the host confirms the saved user row before acknowledging delivery. This avoids the legacy engine loop's reliance on user/assistant ID ordering without trusting random browser-generated engine IDs.

On the host, a signed `/accounts/close` first records a durable closed-account fence. From then on the host refuses further workspace access and model admission for the account, cancels active publication where possible, and erases the account's containers and data in the background. It answers `{ "closed": true, "remaining": n }`, where `n` counts the account's workspaces not erased yet, and answers the same way for an account it already closed. The reaper retries unfinished cleanup every 20 seconds and fails (the supervisor logs "Cloud workspace cleanup needs attention.") while a closed account still has a workspace it could not erase. Account ids are compared in lower case, whatever case a request was signed in. Deleting workspace data also removes its model guard and local publication receipt. A GitHub request already sent may have completed; deterministic branch/PR checks reconcile uncertain publication replies without force-pushing. Existing GitHub pull requests are not deleted by workspace or account deletion.

On the website, account deletion is Codium's staged deletion (`api/_lib/codium-erase.ts`, WP A57). It revokes the account's tokens first, which refuses the gateway. Right after that attempt, whatever it answered, it sends the signed `/accounts/close` to the host, best effort. The host is therefore fenced even while Codium's reconcile or billing cancellation keeps the deletion from reaching its erase. The erase's first part, `workspaces`, takes that close's outcome instead of asking the host again. A deployment never given a workspace host (neither `VECTOR_WORKSPACES_ORIGIN` nor `VECTOR_WORKSPACES_SECRET`) skips the part; a partial setting, an unreachable host or a refused close fails it. A failed part is handled like every other part: the deletion answers pending, the tombstone records `workspaces`, the account's own Codium records and the identity wait, and the cleanup cron retries it with a backoff and alerts the owner after repeated failures. The close is repeated on every retry and on the follow-up pass after the identity is gone. The identity can go while the host is still erasing in the background, because access is already closed. The follow-up pass then fails the part until the host reports `remaining: 0`, so the deletion stays due, backs off and alerts the owner while any workspace data is left. Each close waits for the host at most 10 seconds, and inside a deletion only until the deletion's deadline. Deploy the host before a website that expects `remaining`: the website treats an answer without it as a failed close.

## Operator setup

Use `packages/cloud-workspaces/.env.example` as a variable reference. Configure gateway variables on the account API deployment and runtime variables on the dedicated Linux supervisor host. Store real keys through the deployment's secret mechanism; none belongs in public website environment variables or the repository.

1. Provision a dedicated Docker host with `runsc` and a volume driver that actually enforces the configured disk quota. Verify quota exhaustion and recovery on that driver. The default local volume driver is refused in production.
2. Create a dedicated custom Docker network and enforce tenant/host/network segmentation outside this package. Engine loopback publishing and a custom network name do not themselves provide that policy. Tenant traffic must reach the scoped model relay through the Docker host gateway, while tenant access to other tenants, host services and infrastructure credentials remains denied.
3. Prepare and build the reviewed source engine image below. Configure `VECTOR_WORKSPACES_IMAGE` using its immutable digest or image ID; mutable tags are refused by the runtime.
4. Put the supervisor behind a TLS endpoint for the account gateway. The supervisor also listens on a host address reachable by its containers for the scoped relay. Restrict ingress with the host firewall/proxy; do not expose tenant engine ports. Give the gateway and supervisor the same newly generated HMAC secret, at least 32 characters long.
5. Configure the supervisor's fixed OpenAI-compatible model origin, model ID and provider key. Keep that primary key on the supervisor. Configure the persistent metadata directory and resource limits; the total workspace limit must be at least the active limit.
6. Keep `VECTOR_WORKSPACES_ENABLED=false` initially. Configure the existing account authentication, revocation and persistent abuse-limit services on the gateway, then set the exact comma-separated pilot account UUIDs. Enable only after operator validation and deployment review.

The gateway requires `VECTOR_WORKSPACES_ORIGIN`, `VECTOR_WORKSPACES_SECRET`, `VECTOR_WORKSPACES_ENABLED` and `VECTOR_WORKSPACES_ACCOUNTS`, plus the repository's existing Supabase/account and persistent Redis rate-limit configuration. Account deletion continues contacting a configured workspace host even after the pilot switch is turned off; retain its cleanup configuration until outstanding workspace data is retired.

The supervisor reads `NODE_ENV`, `HOST`, `PORT` and these `VECTOR_WORKSPACES_` variables:

| Variable suffix                  | Meaning/default                                                            |
| -------------------------------- | -------------------------------------------------------------------------- |
| `DATA`                           | Persistent SQLite directory; default `./data`                              |
| `SECRET`                         | Required shared signing secret                                             |
| `IMAGE`                          | Required immutable engine image                                            |
| `NETWORK`                        | Required dedicated custom Docker network                                   |
| `RUNTIME`                        | `runsc`                                                                    |
| `VOLUME_DRIVER`                  | Required production quota driver                                           |
| `VOLUME_SIZE_OPTION`             | Driver option name, default `size`; value is disk allowance in bytes       |
| `RELAY_ORIGIN`                   | Container-visible relay origin; default `http://host.docker.internal:4097` |
| `MODEL` / `MODEL_NAME`           | Required model ID / optional display name                                  |
| `MODEL_ORIGIN` / `MODEL_KEY`     | Required model API base URL and supervisor-only key                        |
| `MAX_ACTIVE` / `MAX_TOTAL`       | 2 / 10                                                                     |
| `MAX_MODEL_CALLS` / `MAX_OUTPUT` | 50 / 4,096                                                                 |
| `MAX_RUN_MINUTES`                | 120                                                                        |
| `DEV_UNSAFE`                     | Explicit non-production fixture escape hatch; leave unset in production    |

The current Docker adapter expects the container-visible relay at `http://host.docker.internal:<port>`. HTTPS is required for the separately configured public gateway-to-supervisor origin. The host's account API signing secret, provider key and persistent SQLite directory require backups/access controls appropriate to private workspace data. Volume backup, restore, capacity and retention policy are operator responsibilities.

### Host startup and TLS ingress

A dedicated Ubuntu 24.04 Linux host is a suitable pilot starting point, with capacity for both 4 GiB engines plus the supervisor/OS, a compatible `runsc`, and a verified quota driver. Run one supervisor process for its metadata directory and Docker host; the lifecycle leases are process-local. The following templates are unvalidated production setup examples, not infrastructure provisioning or deployment approval.

Install the reviewed source and pinned dependencies at `/opt/vector/source`, Bun at `/opt/vector/bin/bun`, and create a dedicated `vector-workspaces` service account. Give only that supervisor access to the rootful Docker socket; Docker-group membership grants powerful host control. Store the supervisor environment in root-owned `/etc/vector/cloud-workspaces.env` with mode `0600`. Create `/var/lib/vector/cloud-workspaces` owned by the service account with mode `0700`. A minimal `/etc/systemd/system/vector-workspaces.service` is:

```ini
[Unit]
Description=Vector cloud workspace supervisor
After=network-online.target docker.service
Requires=docker.service

[Service]
Type=simple
User=vector-workspaces
Group=vector-workspaces
SupplementaryGroups=docker
WorkingDirectory=/opt/vector/source/packages/cloud-workspaces
EnvironmentFile=/etc/vector/cloud-workspaces.env
ExecStart=/opt/vector/bin/bun src/main.ts
Restart=on-failure
RestartSec=5
TimeoutStopSec=150
UMask=0077
NoNewPrivileges=true

[Install]
WantedBy=multi-user.target
```

Keep the pilot disabled while validating this host. After the operator's deployment review, load/start the unit with `systemctl daemon-reload` and `systemctl enable --now vector-workspaces`. Inspect `systemctl status vector-workspaces` and its journal for startup/configuration errors. A supervisor restart deliberately pauses the old engines as described above.

A Caddy TLS proxy can expose only the signed control routes. Replace the example hostname and configure its DNS/certificate access before using this template:

```caddyfile
workspaces.example.com {
    @control path /workspaces /workspaces/* /accounts/close
    handle @control {
        reverse_proxy 127.0.0.1:4097
    }
    handle {
        respond 404
    }
}
```

Set the gateway's `VECTOR_WORKSPACES_ORIGIN=https://workspaces.example.com`; keep the supervisor's relay origin at `http://host.docker.internal:4097`. Bind the supervisor so that its Docker bridge can reach that port, but deny direct Internet access to `4097` with the host/network policy. The public proxy intentionally exposes no `/model/` route. Validate that an unsigned HTTPS `/workspaces` request receives `401`, the scoped relay works from a tenant engine, other tenant/host destinations remain blocked, and the gateway remains disabled until the full pilot sign-in/cleanup checks are approved. A TLS response alone does not validate production isolation.

## Build and validation commands

The following commands are local/CI procedures, not a deployment. Run package tests from their package directories. Bun 1.3.14, Node 24, installed pinned workspace dependencies and a Linux Docker host are the relevant runtime inputs.

```sh
# From packages/cloud-workspaces:
bun test test --timeout 30000
bun typecheck

# From test:
bun test cloud-workspaces-api.test.ts cloud-workspaces-node.test.ts account-delete-api.test.ts account-delete.test.ts site-publication.test.ts --timeout 30000

# From packages/web:
bun test src/lib/cloud-workspaces-client.test.ts --timeout 30000
bun test test/cloud-workspaces-page.test.ts --timeout 30000
bun test test/account-page.test.ts --timeout 30000
bun typecheck

# From packages/engine:
bun typecheck --project ../../tsconfig.json
```

The two page tests each register a `Bun.plugin` that compiles their React island, so they run as separate commands and never share a Bun process. The `packages/engine` command typechecks the hosted API in `api/` against the root `tsconfig.json`, which `typecheck.yml` does not cover.

Prepare a new build-context directory from the repository root:

```sh
bun packages/cloud-workspaces/script/prepare-engine.ts /tmp/vector-cloud-engine-context --preview
docker build --file packages/cloud-workspaces/container/engine.Dockerfile \
  --tag vector-cloud-engine-fixture --iidfile /tmp/vector-cloud-engine.id \
  /tmp/vector-cloud-engine-context
VECTOR_WORKSPACES_TEST_IMAGE="$(cat /tmp/vector-cloud-engine.id)" \
  bun packages/cloud-workspaces/script/runtime-smoke.ts
```

`prepare-engine.ts` compiles the existing desktop Node engine, copies its runtime assets and pinned dependencies, and writes source/catalog/bundle identities to `CONTAINER-INFO.json`. Production preparation requires a clean, reviewed checkout and omits `--preview`. The development runtime smoke explicitly uses `runc` and local storage; it creates isolated fixture resources and removes them afterward. It runs a scripted, zero-cost provider, exercises the real write tool, exports the paused diff and verifies saved chat/files after engine restart. It makes no real model-provider call or GitHub publication.

To exercise the production-built page, first build and serve its local assets:

```sh
# From the repository root:
bun --cwd packages/web build
node script/prune-vector-site.mjs
node packages/cloud-workspaces/script/serve-preview.mjs
```

In a second terminal, install the browser fixture if necessary and run it:

```sh
# Install from packages/cloud-workspaces:
bunx playwright install --with-deps chromium

# Run from the repository root:
VECTOR_WORKSPACES_TEST_URL=http://127.0.0.1:3457 \
  bun packages/cloud-workspaces/script/browser-smoke.ts
```

The browser script opens independent desktop/mobile browser contexts against the actual page and intercepts account/workspace responses. Its fixture covers history continuity, follow-up, Allow once, pause/review, digest-bound publication controls, responsive layout, disabled/unavailable service and signed-out gating. It does not authenticate a production account or create hosted compute or a real pull request.

`.github/workflows/vector-workspaces.yml` adds a dedicated read-only-permission CI lane for package/API/client tests, the account and workspace page tests, the package, website and hosted API typechecks, the production website, browser fixture and actual Docker engine smoke. It runs on manual dispatch, on pull requests that touch these files and on pushes to `main` that touch them, and keeps its source-bound artifacts with each run. Each run on `main` keeps its own concurrency group, so a later merge never cancels an earlier one. GitHub offers manual dispatch only for a workflow that is on the default branch, so until this file is on `main` a branch is checked through a pull request. `test.yml` also runs the two page tests in its Linux unit job on pull requests and pushes to `main` (step "Run website account and workspace page tests"), as long as the job's earlier steps pass.

## Evidence scope and remaining external gates

The local evidence below was recorded at `b258a726`, before the merge with `v2`; its file hashes describe that revision, not the current head. Hosted CI on the pull request is the current evidence: the "Vector cloud workspaces" workflow runs the package suite, the gateway and account-deletion tests (`account-delete.test.ts` included), the browser client contracts, both typechecks, the production website build, the browser fixture and the Docker engine smoke at each head. At `b258a726`, the cloud package suite passed **67 tests / 590 assertions**, the API/Node/account-deletion/site-pruning group passed **38 tests / 289 assertions**, and the browser client contracts passed **18 tests / 67 assertions**. Package and website typechecks passed. The [validation record](./evidence/cloud-workspaces-validation.json) holds that revision's source scope and the completion status of each check, including the production website build and browser rerun. The [runtime receipt](./evidence/cloud-workspaces-runtime.json) scopes the actual Node engine smoke: two scripted-provider model calls, one real write-tool action and three saved messages; fixture changes additionally cover text edits, additions, deletion, executable mode, a missing final newline and hostile Git configuration that was not executed, with identical chat and files after restart. The [browser receipt](./evidence/cloud-workspaces-browser.json) records the production-page fixture's checks and intercepted backend scope. These receipts do not establish real provider inference, live publication or a deployed service, and counts from different suites are not evidence of a larger combined live trial.

No production service, cloud account infrastructure, real provider inference, live GitHub publication or production `runsc`/quota-driver isolation was validated by those checks. The remaining operator gates are:

- provision and validate the dedicated host, quota driver, network policy, image distribution, TLS ingress, private data backups and cleanup under infrastructure failures;
- configure production account/abuse services and the closed pilot allowlist, with approval for the actual deployment;
- validate real sign-in and cross-device continuation against that deployment;
- test an explicitly authorized repository/token publication to GitHub and reconcile its actual draft PR;
- validate the selected real model endpoint and its operational spending controls under an approved inference budget;
- retain the hosted CI run of the commit that is finally merged, with its source-bound artifacts.

These are external validation/deployment steps. This document does not enable the gateway, connect production credentials, publish a site or authorize a deployment.

## Finish lane record

Packages WS-01, WS-02, WS-03, WS-04a, WS-04b and WS-05 are planned for `workspaces-finish`, branched from `release-finish` at `0ee486e3`; each lands as its own entry below, and a package without an entry has not landed. Each entry records what landed, what is deferred, decisions, deviations and local evidence. Hosted CI run ids and head SHAs live once, in "Evidence scope and remaining external gates" (WS-05(b)), not here.

### WS-01: page tests in CI and the lane's triggers (2026-11-15)

What landed:

- `vector-workspaces.yml` gains "Website page tests" right after "Browser client contracts" (from `packages/web`, `test/cloud-workspaces-page.test.ts` then `test/account-page.test.ts`, one `bun test --timeout 30000` command each; both always run and report, and the step fails if either fails) and "Typecheck hosted API" right after "Website typecheck" (from `packages/engine`, `bun typecheck --project ../../tsconfig.json`, the command `vector-sharing.yml` and `vector-free-models.yml` use).
- Its `push` trigger moves from the retiring `cloud-workspaces` branch to `main`, with the same `paths` list as `pull_request`; `workflow_dispatch` stays. Both lists add the account island (`packages/web/src/components/marketing/account/**`), the download panel it embeds (`packages/web/src/components/marketing/download/**`), `packages/web/src/pages/account.astro`, the two page tests, `test/cloud-workspaces-node.test.ts`, `test/account-delete-api.test.ts`, `test/site-publication.test.ts` and `script/prune-vector-site.mjs`.
- `test.yml`'s Linux unit job gains "Run website account and workspace page tests" right after "Run website release copy tests". It runs both files, each in its own `GITHUB_ACTIONS=false bun test --timeout 30000` process, always reports both and fails if either fails. The comment above the release copy step gains one clause naming it. Nothing else in `test.yml` changed.
- "Build and validation commands" lists the two page tests and the hosted API typecheck, and its workflow paragraph names dispatch, pull requests and pushes to `main` instead of the retired branch.

Local evidence (uncommitted tree on `0ee486e3`, Bun 1.3.14, every Bun command through the workload lock, one file per process):

- `test/cloud-workspaces-page.test.ts`: 1 pass, 4 assertions; `test/account-page.test.ts`: 3 pass, 15 assertions. Both also passed in the planning baseline at `0ee486e3`, so no product code or expectation changed.
- Hosted API typecheck from `packages/engine`: clean. `packages/web` typecheck: clean.
- Both workflows parse with `yaml.safe_load`; a scratch structural check confirmed the step order, the shared `paths` list, that every listed path or glob matches a file, `contents: read`, and that the `test.yml` diff holds only the comment clause and the new step.
- The new `test.yml` script exits 0 as written, and exits 1 with the second file swapped for a missing one while still running and reporting the first. The `vector-workspaces.yml` script, under the runner's default `bash -e`, exits 0 as written, and exits 1 with the first file swapped for a missing one while still running and reporting the second.
- `packages/cloud/src/workflow-compliance.test.ts`: 51 pass, 0 fail.
- Full `turbo typecheck --concurrency=2`: 27 of 27 tasks successful.
- `origin/main` re-checked at `58f85edc`: `vector-workspaces.yml` is still absent there.

CI: pending, recorded by the commit stage in "Evidence scope" (WS-05(b)). The `vector-workspaces.yml` dispatch is **blocked, not green**: the file is absent from `origin/main` at `58f85edc`, and GitHub dispatches only workflows on the default branch. It runs after PR #33 merges, or on a pull request from this branch. The new `test.yml` step is verified by the first pull-request run that contains it.

Deviations:

- D1: the `vector-workspaces.yml` dispatch is blocked, as above.
- D2 (deliberate, outside WS-01's enumerated items (a)-(d), for the reviewer to accept explicitly; if rejected, revert to `group: vector-workspaces-${{ github.ref }}`): moving `push` to `main` under the old `vector-workspaces-${{ github.ref }}` group with `cancel-in-progress` would let each merge cancel the run of the merge before it, leaving a cancelled check in `main`'s history and no engine-smoke evidence for that commit. The workflow therefore adopts `vector-everywhere.yml`'s concurrency idiom: each run on `main` keeps its own group (`run_id`), and pull requests and branches still cancel stale runs.
- D3: the `paths` filter leaves out files the new steps read: the root `tsconfig.json` and `packages/engine/**` (hosted API typecheck and engine smoke), `packages/web/src/lib/account-client*` (imported by the account island), `packages/schema/src/codium-*` (the plan copy that feeds the no-credits/prices assertion), and the whole of `packages/web/src/components` and `src/lib` scanned by the email check. They stay out as specified. `test.yml`'s Linux unit job backstops only the page tests, and only once its earlier steps pass. On pull requests the hosted API typecheck has no backstop for those files: `vector-sharing.yml`, `vector-free-models.yml` and `vector-at-mention.yml` run the same command, but their pull-request paths never list the root `tsconfig.json` and list `packages/engine` only in part. On pushes to `main`, `vector-at-mention.yml` runs it for every change. Widening the list is the lead's call; if approved, add at least `tsconfig.json` and `packages/web/src/lib/account-client*` to both lists, keeping them identical.
- D4: no cloud-workspaces progress or deviations file exists in `docs/vector/build`, so the lane record lives in this section; a later package may move it.
- D5: the plan's edit to the "Evidence scope" paragraph was dropped, because no hosted run has executed the new steps yet; WS-05(b) rewrites that paragraph with this lane's runs.
- D6: the package asked for two separate commands in "Website page tests". They stay two commands, but use `test.yml`'s `status` idiom instead of plain `bash -e` lines, so a failure in the first file no longer hides the second file's result.
