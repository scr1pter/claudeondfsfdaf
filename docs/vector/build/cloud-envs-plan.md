# Vector cloud environments: the answer and a build plan

Checked against shipped main 6eaf445a using only grep, sed and git. Nothing was built, tested or run live. Prices come from the sandbox research, read on 2026-10-26. Per-hour figures are estimates.

## 1. Short answer

**Partly, yes.** Vector already has an agent that works in your GitHub repo on GitHub's machines. You start it with a GitHub comment, then you can close your laptop and a pull request (PR) shows up. What it can't do yet is the Claude-Code-on-the-web experience: start from the Vector app, watch it live, and follow up in the same session. There is no Vector-hosted sandbox, and nothing in the code starts a cloud machine.

### What works today (exists and works)

1. **Install the workflow.**
   - In the desktop app, "Set up automatic reviews" opens a PR that adds `.github/workflows/vector.yml` (packages/desktop/src/main/github-pr.ts:683-740).
   - The task job is always included in that file (packages/core/src/review/workflow.ts:343).
   - Or, in a terminal, run `vector github install` (packages/engine/src/cli/cmd/github.handler.ts:176-393).
   - Merge the PR.
2. **Add two repo secrets.**
   - `VECTOR_CLI_TOKEN`, created at vectordev.ai/auth/cli (github.handler.ts:252-253).
   - Your own model-provider key (workflow.ts:158-168). You need one in practice because Vector's free models are "Built, switched off" (docs/vector/SERVICE-INDEPENDENCE-STATUS.md:24).
3. **Let Actions open PRs.** In the repo's Settings → Actions → General, tick "Allow GitHub Actions to create and approve pull requests" (github.handler.ts:255-256).
4. **Start a task.** On an issue, comment `/vector <task>`. The trigger words are in packages/engine/src/cli/cmd/github.route.ts:8.
   - Vector makes a `vector/issueN-<timestamp>` branch, commits, pushes and opens a PR (github.handler.ts:660-736, 1131-1143).
   - The PR lists the files changed, the checks it ran, the cost and the judge's verdict (packages/engine/src/cli/cmd/github.evidence.ts:182-213).
   - The agent runs on GitHub's computers, so your laptop can be off.
5. **Follow up.** Comment `/vector <change>` on that PR and it commits onto the same branch (github.handler.ts:1570-1714).
6. **Optional: bring a run back to your laptop.** `vector pr <n>` loads the run into a local session, but only if the run was shared publicly (packages/engine/src/cli/cmd/pr.ts:16-109).

**Limits of this path today:**
- GitHub's machines install CLI 1.99.99, not main (packages/desktop/package.json:6; workflow.ts:155-157).
- Each task has a 45-minute limit and no dollar cap (workflow.ts:253). Only reviews have caps (packages/core/src/review/types.ts:265-266).
- PRs opened with GitHub's built-in token (`GITHUB_TOKEN`) don't trigger your other CI (packages/web/src/pages/docs/vectorscope.astro:75-80).
- The agent's shell can see `GITHUB_TOKEN` and your provider keys:
  - Only Vector's own secrets are removed from the shell (packages/core/src/child-environment.ts:83-94, used at packages/engine/src/tool/shell.ts:1255).
  - In this mode the checkout step leaves the token in the local git config (workflow.ts:265-269).
- Vector's own git steps never push to the default branch. Issues always become a PR (github.handler.ts:660-736).

### What is missing for the Claude-Code-on-the-web experience

| Step | Status | Evidence |
|---|---|---|
| Pick a repo in Vector and describe a task | **Absent.** The desktop app has no "run in cloud" or dispatch action. The website's Cloud Agent was retired. | github-pr.ts:45-837 (no dispatch or comment posting); packages/web/src/data/vector-releases.ts:427 |
| Start a run from a button or API with a prompt | **Unfinished.** The CLI handles a manual dispatch with a `PROMPT`. The generated workflow, though, requires a `pr` input and turns every manual dispatch into a review. | github.route.ts:49-55; github.handler.ts:622-659, 819-828; workflow.ts:78-85, 309-313 |
| Close the laptop, get commits or a PR | **Works** (comment trigger only) | see above |
| Watch it live, privately | **Absent.** The only live view is a public share, which is off by default and not turned on in production. | workflow.ts:291-293; github-pr.ts:594; docs/vector/owner-actions/public-shares.md:3 |
| Follow up in the same environment | **Partial.** Same branch, but every run starts a new session with no transcript, and the agent's questions are blocked. | github.handler.ts:595-602, 945-970 |
| Branded bot whose PRs trigger CI | **Unfinished.** Coded, but no Vector GitHub App is registered. | docs/vector/owner-actions/github-app.md:3 |
| Vector-run sandbox (private repo, live session, pushes) | **Absent.** A prototype on Vercel Sandbox (public repos only, push blocked) was deleted in commit e7a2b8f2. | `git show 3ef6d223:api/_lib/cloud-agent.ts` :441-451, :266-267 |
| Runs while the laptop is off, started from Vector | **Absent.** Scheduled tasks need the desktop app running. | packages/web/src/pages/docs/automations.astro:19-20 |

## 2. Three ways to build it

| | (A) GitHub Actions as the cloud environment, started and watched from Vector | (B) Vector-managed sandboxes on Vercel Sandbox | (C) Your user's own server running `vector serve` |
|---|---|---|---|
| **Who pays for compute** | The user, through their GitHub Actions minutes. Free on public repos. Private repos get 2,000 min/month on Free, then $0.006/min (docs.github.com/en/billing/concepts/product-billing/github-actions). | You. Rates: CPU $0.128/hr, charged only while busy; memory $0.0212/GB-hr (vercel.com/docs/vercel-sandbox/pricing). | The user, for their own VM or VPS. |
| **Your cost per user-hour** | $0 for compute. Models use the user's own keys. | About $0.11 (estimate: 2 vCPU, 4 GB, CPU busy 10% of the time), plus model costs if you pay for them. If your Vercel team is on Pro (an assumption from the research, not stated in the docs), the $20/month credit covers about 180 hours first. | $0. The user pays about $0.05–0.09/hr for a small VM (research estimate: fly.io/sprites, docs.fly.io/about/pricing). |
| **Setup for the user** | Merge one PR from the desktop (that flow already exists), add 2 secrets and change 1 setting. | Install the Vector GitHub App on chosen repos and sign in. Nothing else. | Hard: rent a VM, install the CLI, set `VECTOR_CLI_TOKEN` and `VECTOR_SERVER_PASSWORD`, add a TLS tunnel, clone with their own GitHub login, then add the server in Settings > Servers (packages/app/src/components/dialog-select-server.tsx:186-205). |
| **Max run time** | GitHub allows 6 h per job (docs.github.com/en/actions/reference/limits). Vector sets 45 min (workflow.ts:253). App tokens last 1 h (github-app.md:57). | 24 h per session on Pro, resumable (vercel.com/docs/vercel-sandbox/pricing). | No limit. |
| **Follow-ups and interactive** | Follow-ups are new runs on the same branch. Not interactive. | Yes. The sandbox saves its disk when stopped, so follow-ups reuse it. Live steering is possible by connecting the app to a `vector serve` inside the sandbox. | Fully interactive (desktop, TUI, web UI). No setup is needed for that, but none of it was tested live. |
| **Isolation and security** | A fresh GitHub VM per job. Today the agent can read `GITHUB_TOKEN` and provider keys. App mode hides the token from the model's tools (packages/engine/src/cli/cmd/github.git.ts:5-40). | A microVM per session. Vercel's firewall adds the GitHub token to outgoing requests, so it never enters the sandbox (vercel.com/docs/vercel-sandbox/concepts/firewall). You carry the multi-tenant risk. | Only as safe as the user's box. Basic auth only, no TLS of its own (packages/engine/src/server/listen-policy.ts:5-19). |
| **Build size (rough guess)** | Small to medium, about 1–2 weeks solo | Large, about 4–8 weeks solo plus ongoing operations | None to small (docs now; a setup wizard or SSH support later) |

There is also a terms issue. Per the research, GitHub's terms forbid offering Actions as part of a commercial service (docs.github.com/en/site-policy/github-terms/github-terms-for-additional-products-and-features). So (A) has to stay "runs in your own repo on your own minutes" and must not be sold as Vector's hosted product.

Other providers from the research:
- Cloudflare Containers are about $0.09/hr after a $5/month plan. That is cheaper at scale but needs more glue code (developers.cloudflare.com/containers/pricing).
- E2B, Daytona and Modal cost about $0.17–0.24/hr. Their free credits are fine for prototyping.
- E2B and Daytona put the GitHub token inside the sandbox, where the agent can read it.

## 3. Recommendation and phased plan

**Build (A) first, register the GitHub App second, and build (B) only after a paid plan exists to fund it. Document (C) now as a power-user option.** (A) costs you $0 in compute, reuses almost all existing code, works on private repos and already does "close the laptop, get a PR".

### Phase 0: now, almost no code (owner)
- **Publish a new npm CLI and bump the pinned version.** Runners stay on 1.99.99 until you do (packages/desktop/package.json:6; packages/engine/script/publish-vector.ts:1-40).
- **Write a docs page for (C).** Run `vector serve` on loopback behind an HTTPS tunnel and add it in Settings > Servers (packages/engine/src/cli/cmd/serve.ts:6-23; packages/app/src/context/server.tsx:72-77). Note that `--trusted-network` is not in 1.99.99.

### Phase 1 (MVP): "Run in GitHub" from the Vector app
1. **Workflow generator.** In packages/core/src/review/workflow.ts, update `buildWorkflowYaml` and the route script:
   - Make `pr` optional and add `prompt` and `branch` inputs to the manual dispatch. Today `pr` is required (:309-313) and every dispatch becomes a review (:78-85).
   - Send a dispatch that has a prompt to the task job. The CLI side already handles that route (github.route.ts:49-55).
   - Bump `VECTOR_WORKFLOW_VERSION` so the desktop can tell when a repo's workflow is out of date.
2. **Follow-ups on the same branch.** When `branch` is set, packages/engine/src/cli/cmd/github.handler.ts should check out that branch instead of creating a new one (:622-659, 1101-1177).
3. **Carry the session over.** Save the run's session as a private Actions artifact and import it on the next run, reusing the import logic in pr.ts:16-109. Then the follow-up has the earlier transcript (today :595-605 starts fresh).
   - Replace the per-comment concurrency group (workflow.ts:254-257) with a per-branch queue.
   - Careful: the code notes that GitHub keeps only one queued run per group, so a plain shared group would drop tasks.
4. **Desktop button.** Add a new main-process module next to packages/desktop/src/main/github-pr.ts:
   - Pick a repo from `listRepos` (packages/desktop/src/main/github-auth.ts:343), so no local clone is needed.
   - Call `POST /repos/{o}/{r}/actions/workflows/vector.yml/dispatches` with the existing sign-in (packages/desktop/src/main/github-access.ts:10-16).
   - Show progress with `listCiRuns` and `failedStepLog` (packages/desktop/src/main/ci-watch.ts:96-135), and the PR link at the end.
   - Wire it up in packages/desktop/src/main/ipc.ts.
5. **Safety in the same release.**
   - Add a task dollar cap, mirroring the review caps (types.ts:265-266).
   - Remove `GITHUB_TOKEN`, `GH_TOKEN` and provider keys from the agent's shell in GitHub-run mode (child-environment.ts:83-94).
   - Set `persist-credentials: false` for every job (workflow.ts:265-269).
   - Do all pushes through the credential path the model's tools can't use (github.git.ts).

### Phase 2: identity (owner action plus small code)
- **Register the Vector GitHub App** and pass the acceptance checks (docs/vector/owner-actions/github-app.md:8, 63-71). Then set `VECTOR_GITHUB_APP_ENABLED`. This gives you:
  - a branded bot instead of github-actions[bot];
  - PRs that trigger the repo's CI;
  - one-repo tokens that last 1 hour (packages/engine/src/cli/cmd/github.auth.ts:57-182; api/github/token.ts).
- **Keep the token lifetime in mind.** App tokens last 1 hour (github-app.md:57). Before raising the 45-minute task limit in App mode, add token refresh.

### Phase 3: Vector-hosted sandboxes (B) on Vercel Sandbox
- **Job API.** Add new `api/cloud-runs/*` functions (create, status, events, follow-up, stop).
  - Revive the run table and orchestrator from `git show 3ef6d223:api/_lib/cloud-agent.ts` and `3ef6d223:api/agents/runs.ts`.
  - Remove its public-repo-only and no-push limits (:113-125, :266-267).
  - Rate limiting and state can use api/_lib/persistent-store.ts and api/_lib/abuse.ts.
- **GitHub auth outside Actions.** Add the App's user authorization so you can prove the Vector user can reach that repo. Then mint installation tokens server-side with `repository_ids: [repo]`.
  - Extend api/_lib/github-app.ts for this.
  - Respect github-app.md:49: no unauthenticated `installation_id` callback and no PAT uploads.
- **Token handling.** The firewall adds the token to github.com and api.github.com traffic, and a new token replaces it about every 50 minutes.
  - Use a **read-only** token while the agent works and a **write** token only for Vector's own push and PR step.
  - Otherwise the agent could push anywhere the token can reach.
- **Inside the sandbox.**
  - Build a snapshot from the recipe in packages/cloud/container/Dockerfile.
  - Clone, then run the branch/commit/PR helpers and evidence code (github.handler.ts:1101-1406, github.evidence.ts) or `vector run --format json` (packages/engine/src/cli/cmd/run.ts:203-204).
  - The user's project still needs its own language runtimes, which is a gap.
- **Live view and follow-ups.**
  - Start `vector serve` in the sandbox with a random password, following packages/desktop/src/main/wsl/sidecar.ts:40-60.
  - Let the desktop connect through a cloud server type in server.tsx:277-317, or through a cloud workspace adapter (packages/engine/src/control-plane/types.ts:46-59, modelled on the dev-only debug-workspace-plugin.ts:46-68).
  - Don't use the adapter's current env handoff. It sends every saved provider credential (`VECTOR_AUTH_CONTENT`, packages/engine/src/control-plane/workspace.ts:539-547).
- **Billing hooks.**
  - Meter sandbox minutes per user and give a free monthly quota.
  - Set a hard cap in Vercel Spend Management.
  - Copy the Stripe and ledger pattern in api/_lib/model-plan-*.ts once sales are on. Today `MODEL_PLANS_ENABLED=false` (docs/vector/MODEL-PLANS.md:7) and nothing meters compute.

### Auth model
- **Use a GitHub App with per-repo installation tokens, not PATs.**
  - Tokens last 1 hour, cover one repo, can't exceed what the user granted, and commits show as the bot.
  - Your own policy forbids uploading a user's PAT (github-app.md:49).
  - A PAT is long-lived, reaches every repo the user can, and would sit on your servers.
- **Keep the App without Workflows permission** (github-app.md:8), so the agent can't edit CI files.

### Safety rules
- Always push to a `vector/*` branch and open a PR.
- Direct-to-main is a per-repo opt-in that you build later, never the default. Tell users to protect `main` with rulesets.
- Refuse fork PRs (packages/engine/src/cli/cmd/github.app.ts:90-93).
- Keep public sharing opt-in.
- Never run subscription-signed-in external agents on hosted or remote runners (docs/vector/handoff-2026-10/legality-agents.json:101).

### Decisions for you
1. **Models in cloud runs:** users' own keys only (recommended for the MVP), or Vector pays, which needs model plans switched on.
2. **The GitHub App:** register it, and pick its org and name. For (B), also decide whether to add user authorization.
3. **Free cloud quota and price** for (B), and your Vercel spending cap.
4. **Direct-to-main:** whether it is ever allowed.
5. **Provider for (B):** Vercel (fits your stack and reuses the prototype) or Cloudflare (cheaper at scale).
6. **Owner setup steps:** fix Vector's own Actions billing block and create the container registry (docs/vector/owner-actions/container-registry.md:3). Both are only needed for publishing the container image.

## 4. Costs and risks in plain words

- **Compute is cheap; models are expensive.**
  - (A) costs you nothing; users spend their own Actions minutes.
  - (B) is about $0.11 per user-hour (estimate). For example, 100 users × 10 hours a month is about $110/month in compute, much of it covered by the Pro credit if you are on Pro.
  - An agent hour usually costs much more in model tokens than in compute. The evidence bundle already measures it per run (github.evidence.ts:258-271).
  - If you ever pay for models, set per-user caps before launch.
- **Runaway cost.** Tasks have no dollar cap today. Fix that before promoting this feature.
- **Security.** An agent with write access is reading issue text and repo files, either of which can try to manipulate it. Today it can also read the tokens.
  - Phase 1 must hide the tokens from it.
  - Phase 3 must keep the write token out of the sandbox during the agent phase.
  - In (B), you hold other people's private code, so your privacy policy needs updating.
- **Abuse.** Free hosted compute attracts crypto miners and spammers. You need sign-in, quotas, network limits and a kill switch.
- **Terms.** Don't sell Actions as Vector's hosted product. Subscription-based external agents stay local-only.
- **Solo-founder load.** (A) is mostly code you already have. (B) is a running service: incidents, rotating the App key, outages and support. Only take it on when paying users want live, long-running sessions.
- **Estimates.** All dollar and time figures are estimates from public price pages (URLs above) and a reference session I made up. Nothing here was run live.

---

# Sandbox research (2026-10-26)

**Short answer: yes, Vector can have cloud environments.** The setup that fits your budget is Vercel Sandbox, which you already pay for with Pro. Add a "Vector" GitHub App that users install on only the repos they choose. Your backend gives the sandbox a one-hour token for one repo, Vercel's firewall adds that token to GitHub traffic so the agent never sees it, and the agent pushes to a `vector/*` branch and opens a pull request.

All pages below were read on 2026-10-26. Where a page shows its own update date, it's in brackets.

## Comparison

"$/hr" is a reference session I calculated from the published rates: 2 vCPU, 4 GB RAM, one hour, with the CPU busy about 10% of the time because the agent mostly waits on the AI model. It doesn't include AI model costs, which will be much bigger.

| Option | Isolation | Max runtime | Cold start | Exact rates (source) | ≈$/hr | Persistence | Egress and GitHub token handling |
|---|---|---|---|---|---|---|---|
| **Vercel Sandbox** (Pro) | Firecracker microVM, own kernel | 24 h per session on Pro (45 min on Hobby). Stopping and resuming has no overall limit | "Milliseconds"; resuming from a snapshot is faster | CPU $0.128 per hour, charged only while the CPU is busy. Memory $0.0212/GB-hr. Creations $0.60 per 1M. Snapshots $0.08/GB-month. Paid from Pro's $20/month credit first. Max 8 vCPU / 16 GB. vercel.com/docs/vercel-sandbox/pricing [2026-09-10] | **$0.11** | Saves the disk automatically on stop. Snapshots expire 30 days after last use (configurable) | Downloads are free; uploads go under the "Flat Rate CDN" on Pro. A built-in firewall can add the GitHub token to outgoing requests itself, so the token never enters the sandbox (vercel.com/docs/vercel-sandbox/concepts/firewall [2026-09-16]) |
| **Cloudflare Sandbox SDK / Containers** | microVM, own kernel. Generally available since 2026-04-13 | No max stated. Sleeps after 10 min idle by default; `keepAlive` prevents that | Median 648 ms in a benchmark Cloudflare cites. About 30 s for boot + clone + install, 2 s when restoring from a backup | CPU $0.000020 per vCPU-second, charged only while busy. Memory $0.0000025/GiB-s. Disk $0.00000007/GB-s. Needs the $5/month Workers Paid plan, which includes 25 GiB-hours memory and 375 vCPU-minutes. Max 4 vCPU / 12 GiB. developers.cloudflare.com/containers/pricing [2026-10-05] | **~$0.09** (2 vCPU, 8 GiB) | Backup and restore to R2 storage. Snapshots were "rolling out" as of April | $0.025/GB in North America/Europe after 1 TB free. A built-in egress proxy can add credentials, so the token stays outside |
| **E2B** | Firecracker microVM | 24 h on Pro, 1 h on Hobby | Not stated officially. Resuming takes about 1 s | $0.000014 per vCPU-second and $0.0000045/GiB-s, charged for the whole time it runs. Hobby: $100 one-time credit. Pro: $150/month. e2b.dev/pricing | $0.166 | Pause saves memory and disk, kept indefinitely. Storage is included | Token has to be inside the sandbox, where the agent can read it |
| **Daytona** | Containers by default (separate namespaces); full VMs optional | No max stated. Stops after 15 min idle (can be turned off). Archived after 7 days stopped | Claims under 90 ms | $0.0504 per vCPU-hour, $0.0162/GiB-hr, $0.000108/GiB-hr storage after 5 GiB. Charged per second. $200 free credit. daytona.io/pricing | $0.166 | Stop, archive, snapshots | Tiers 1–2 have restricted network access you can't change per sandbox (Tier 2 needs a card and $25 top-up); full internet needs a $500 top-up. Token has to be inside |
| **Modal Sandboxes** | gVisor container or a VM | 24 h (default 5 min) | Not stated | $0.00003942 per core-second (1 core = 2 vCPU) and $0.00000667/GiB-s, which is 3× the normal rate. $30/month free credit on Starter. modal.com/pricing | ~$0.24 | Disk snapshots kept 30 days by default; memory snapshots are experimental | Domain and IP allowlists. Experimental header injection with secrets kept outside |
| **Fly Machines / Sprites** | Firecracker | No max | Restarting a stopped machine: under 1 s. Creating a new one: low tens of seconds. Resume from suspend: a few hundred ms | Machines in the cheapest regions (iad/ewr): performance-2x 4 GB is $66/month (~$0.092/hr); shared-cpu-2x 2 GB is $13.39/month. Sprites: $0.0385 per CPU-hour and $0.021875/GB-hr, charged only on actual use. docs.fly.io/about/pricing and fly.io/sprites | $0.05 (Sprites) to $0.09 | Volumes $0.15/GB-month. Sprites take checkpoints automatically | $0.02/GB in North America/Europe. You build the token handling yourself |
| **GitHub Actions** | New VM for every job | 6 h per job (5 days on self-hosted runners) | Not measured | Free for public repos. Private repos: 2,000 min/month on Free, 3,000 on Pro, billed to the repo owner. Linux 2-core is $0.006/min. docs.github.com/en/billing/concepts/product-billing/github-actions | $0 for you ($0.36/hr for the user after their free minutes) | None (cache only) | Built-in `GITHUB_TOKEN`, ends with the job. Pushes made with it don't start other workflows. GitHub's terms forbid offering Actions as part of a commercial service |
| **GitHub Codespaces API** | Full VM | Shuts down after 12 h. Idle timeout is 5–240 min | Not measured | 2-core $0.18/hr, storage $0.07/GB-month. Free accounts get 120 compute-hours/month (~60 h on 2-core). Billed to the user. docs.github.com/en/billing/concepts/product-billing/github-codespaces | $0 for you | Disk persists | Needs a user token with the broad `codespace` scope. Not a good fit for unattended agents |

Cold starts marked "not stated" or "not measured" are numbers I couldn't find on an official page.

## How a GitHub App gets push access to only the repos a user picks

1. **Register the "Vector" GitHub App** with these repository permissions:
   - Contents: write
   - Pull requests: write
   - Metadata: read
   - Workflows: write, only if the agent needs to edit `.github/workflows`

   Turn on "request user authorization during installation" and device flow (for the desktop app). Keep the app's private key on your server only, never in the desktop app.
2. **The user installs the app** and chooses "Only select repositories."
3. **Your backend creates a short-lived token per session.** It signs a JWT and calls `POST /app/installations/{id}/access_tokens` with:
   - `repository_ids: [<that one repo>]`
   - `permissions: {contents: "write", pull_requests: "write"}`

   The token lasts 1 hour and can never exceed what the user granted at install. Don't assume tokens are 40 characters: GitHub is rolling out a new `ghs_APPID_JWT` format.
4. **Check that the person is allowed to use that repo before creating a token.** The GitHub App's user token (lasts 8 h, refresh token lasts 6 months) only covers repos both the user and the app can reach. Use it to confirm the Vector user can access that installation's repo. Without this check, one Vector user could point the agent at someone else's repo that also has the app installed.
5. **Keep the token out of the agent's reach.** Have the sandbox's egress proxy add it to requests (Vercel `transform`, Cloudflare `outboundByHost`). This is the same design Claude Code on the web uses. On Vercel:
   - git uses `https://github.com`, and the `*.github.com` pattern doesn't match `github.com` itself, so list both.
   - git needs `Basic base64("x-access-token:<token>")`; the API at api.github.com takes `Bearer`.
   - For runs longer than an hour, create a new token about every 50 minutes and update the policy with `sandbox.update({networkPolicy})`.
6. **Push to a `vector/<session>` branch and open a pull request.** Users should protect their main branch with rulesets. Commits show as `vector[bot]`. Using the user's own token instead attributes commits to the user, at the cost of broader reach.

## Recommendation

**Main option: Vercel Sandbox.**
- It costs nothing new: sandbox use comes out of Pro's $20/month credit first. At about $0.11/hr, that's roughly 180 agent-hours a month (my estimate) before you pay anything extra.
- It has 24-hour sessions, sandboxes that save and resume automatically, and microVM isolation.
- The firewall keeps the GitHub token out of the agent's reach.
- Set a cap in Spend Management and give each user an hours limit, because AI model costs will be far bigger than compute.

How it fits together:
- The desktop app calls your API on Vercel.
- The API starts a sandbox with `Sandbox.create` from a snapshot that already has Bun and the Vector engine installed.
- The agent clones the repo through the injected token and runs Vector's engine without a UI, streaming events back to your server.
- It pushes a branch, opens a pull request, then stops. The sandbox saves itself so the user can send follow-ups later.

**Runner-up: Cloudflare.** It's the cheapest at scale ($5/month plus about $0.06–0.09/hr, charged only while the CPU is busy) and also keeps the token outside the sandbox. It needs more glue code, tops out at 4 vCPU / 12 GiB, and its snapshot feature is newer.

**Free options:**
- **Prototyping credits:** Daytona ($200 one-time), E2B ($100 one-time) and Modal ($30/month) are fine for experiments. E2B Pro at $150/month is too expensive for you.
- **Free compute through the user's own GitHub Actions:** this could be an opt-in "Run in GitHub Actions" mode, where the user adds a workflow to their own repo, like Anthropic's claude-code-action. It costs Vector nothing: free on public repos, and the user's own minutes on private ones. But it's capped at 6 hours and isn't interactive. Don't sell it as Vector's hosted product, because GitHub's terms forbid offering Actions as part of a commercial service.

**Skip:**
- **Codespaces:** it needs broad user tokens, stops after 12 hours, idle timeouts stop unattended agents, and it bills the user.
- **Raw Fly Machines:** the compute is cheap, but you'd build all the lifecycle and token handling yourself.
- **Claude Code self-hosted environments:** Team/Enterprise only and for Claude Code sessions, so it isn't a way to host Vector.

Sources: the pages named in the table, plus:
- docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-an-installation-access-token-for-a-github-app
- docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-user-access-token-for-a-github-app
- docs.github.com/en/actions/reference/limits
- docs.github.com/en/site-policy/github-terms/github-terms-for-additional-products-and-features
- developers.cloudflare.com/containers/platform-details/limits [2026-10-21]
- blog.cloudflare.com/sandbox-ga
- docs.e2b.dev/sandbox/persistence
- modal.com/docs/guide/sandboxes
- daytona.io/docs/en/limits
- code.claude.com/docs/en/claude-code-on-the-web