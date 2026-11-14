# @vector v2 finish plan (branch `v2-vector`)

Checked 2026-11-14, 06:15–06:40 UTC. Read-only planning. Nothing was committed or pushed and no PR was opened.

What I did:
- Created the worktree `<worktree>` on the new branch `v2-vector` from `origin/build-integrate`.
- Unset the branch's upstream, so a bare `git push` cannot target `build-integrate`.
- Fast-forwarded the branch to the newest `build-integrate` head, `29603fc90`.
- Ran `bun install --ignore-scripts`.
- Ran two single test files and the engine typecheck (results in §2).

Inputs:
- The @vector docs on `build-integrate`: `docs/vector/build/vector-at-mention-{spec,progress,deviations}.md`.
- `vector-v2-finish-plan.md` §1, §3, §4 items 14–18, and §5 A4/A8.
- The CI logs named below. Saved copies are in the scratchpad folder `atv/`.

---

## 0. Live state: read this before touching the branch

- **`build-integrate` moved twice since `50b4f82c2`.** Both commits are by "Vector Build Agent":
  - `e88012584` (06:10 UTC): "repair command and Windows fixtures".
  - `29603fc90` (06:28 UTC): "include GitHub installation options in help".
- `v2-vector` = `29603fc90`, fast-forwarded with no local commits.
- `vector-at-mention` has not moved (`c0d10fb85`). `v2` = `8fecdf108`, which is main plus the CI trigger. A merge of `origin/v2` into `v2-vector` is clean (`git merge-tree`).
- **`build-native-shell` is also live:** `8b2cbc76f` → … → `33e04ec12` (04:44) → `faa1fa09b` (06:31 UTC).
- **The Build Agent is fixing the same red test groups right now.** This is the open finish-plan decision A3. Until the orchestrator stops it or splits the work:
  - Re-fetch before every `v2-vector` commit, and fast-forward or merge `build-integrate` first.
  - Never redo a fix it has already pushed.
  - Never push to `build-integrate`.
- The remote URL in the shared checkout is `scr1pter/bjikdoy`. `gh` resolves `scr1pter/claudeondfsfdaf`, so use `-R scr1pter/claudeondfsfdaf` as the rules say.
- Refs are shared by every worktree of this repository, so other agents' fetches update `origin/*` here too. Always re-read heads before acting.

---

## 1. The sandbox lane failure: exact cause and fix

### 1.1 Symptom

- Lane 43216635783 (`50b4f82c2`) and lane 43565027861 (`e88012584`): every `sandbox (...)` job fails at "Prepare the agent sandbox" with the generic `refused()` error (`packages/engine/src/cli/cmd/github.sandbox.ts:36-37`): "The GitHub agent sandbox could not verify its isolation or cleanup."
- The later step failures are only consequences: "Missing trusted staged checkout" and `observed.json` ENOENT.
- The other lane jobs pass: hosted API, engine and core (at `50b4f82c2`), and desktop bundle.

### 1.2 Where it fails

`prepare()` runs two namespace probes after the UID, ptrace and core checks:
- **Engine-mount probe**, `github.sandbox.ts:505-514`. Root runs `bwrap` with the engine arguments. It passes.
- **Tool probe**, `github.sandbox.ts:515-523`. It runs `sudo prlimit … setpriv --reuid=<agent> --no-new-privs … env -i /usr/bin/bwrap --unshare-user --unshare-pid --unshare-ipc --unshare-uts --bind / / --proc /proc /bin/true`, using `argumentsForTool` (`packages/core/src/process-isolation.ts:50-66`). It exits 1, so `throw refused()` at `:523` fires.

### 1.3 Cause C1: the failure you can see

GitHub's `ubuntu-24.04` image sets `kernel.apparmor_restrict_unprivileged_userns=1`. An unconfined, unprivileged `bwrap --unshare-user` is attached to the restricted profile and cannot write its uid map.

Evidence: `build-isolation` ran the same probe code with its stderr exposed (`af4efb44d`):
- Run 43178633851: "The mandatory tool PID/proc namespace probe failed (exit 1): bwrap: setting up uid map: Permission denied".
- Run 43182119477 (`4fb36af93`) logs `/proc/sys/kernel/apparmor_restrict_unprivileged_userns=1`, "Diagnostic unprofiled tool namespace: exit 1" and "Diagnostic profiled tool namespace: exit 0". Here root entered a Vector-only AppArmor label before `setpriv`.

The failure came in with the V16 "process-isolation continuation" on `build-github-ui`:
- Commits `1c9c8a166`, `6cce8c8c9`, `e519639ad`, `899be5cd1`, `5c0c9b539` and `017f7144b`, merged into `build-integrate` by `ae5e3e61a`.
- It is recorded at `vector-at-mention-deviations.md:616-625` and `vector-at-mention-spec.md:266`.
- The lane was last green at `c0d10fb85` (43178097816). `build-github-ui`'s own lane, 43162549391, was already red in the same way.

### 1.4 Cause C2: a second blocker hidden behind C1

Even with user namespaces allowed, the first real tool the hosted engine starts fails. In plain terms, the design cannot work with bubblewrap on any Linux host:
- `run()` wraps the engine itself in `bwrap engineArguments` (`github.sandbox.ts:663`). That gives the engine an empty, read-only tmpfs `/proc` (`process-isolation.ts:31-34`).
- Every tool launch then nests `bwrap` (`ProcessIsolation.launch`, `process-isolation.ts:70-81`, via `cross-spawn-spawner.ts:299` and others).
- A nested `bwrap` needs a real procfs:
  - it reads `/proc/sys/kernel/overflowuid`;
  - it writes `/proc/self/uid_map`;
  - mounting `--proc` requires a fully visible procfs.
- Evidence: run 43202763321 (`a65787b6c`, label entered). Preparation passed. The actual ShellTool inside the engine then failed with "bwrap: Can't read /proc/sys/kernel/overflowuid: No such file or directory" (probe step `probeToolProcesses`).
- `build-isolation` dropped this path at `15cb6bf28` in favour of a root-side namespace-entry broker. That broker is the native-isolation work (§4).
- **Caution:** the green "Vector at-mention" runs on `build-isolation` and `build-native-shell` (for example 43333155627) are **not** the @vector matrix. Those branches replace `vector-at-mention.yml` with a one-job "Vector namespace-entry experiment".

### 1.5 The fix: needs an orchestrator decision, because it changes a documented security boundary

Bounded diagnostics come first, whichever option is chosen:
- Port the `github.sandbox.ts` part of `af4efb44d` (`namespaceProbeFailure`: bounded, escape-stripped stderr from the fixed `/bin/true` probes only).
- That hunk applies cleanly. The workflow hunk of the same commit does not, so leave it.
- A refusal then names the failing probe instead of "could not verify".

**Fix A (recommended for v2 "code-finished"): hold the bubblewrap floor until native isolation replaces it.** Production stays off.
- Add one build-time selection, default off, in the same style as native-shell's `GithubIsolation.enabled()`.
- When the floor is off:
  - `prepare` skips both bubblewrap probes (`github.sandbox.ts:504-525`) and does not require `isolatedTools` (`:578`).
  - `run` does not wrap the engine (`:663`) and sends no `toolIsolation: "pid"` (`:610`).
  - `ProcessIsolation.launch` is a pass-through.
  - Codium no longer forces the floor at `github.secrets.ts:291`.
- Keep the kernel-path guard (`assertToolPath`/`assertKernelPath`, `process-isolation.ts:99-130`) and the native-loader check active for hosted runs. To do that, split `required()` into a path-guard switch and a floor switch.
- Keep the FD3 session proof (`:626-637`, `:785-850`). It does not depend on bubblewrap.
- Tests:
  - `process-isolation.test.ts` and `github.sandbox.test.ts`: cases with the floor on and with it off.
  - `sandbox-tool-probe.ts:275-284,349-376` and the lane's "Assert isolation…" step: assert the floor fields (PID invisibility, SIGUSR1, engine proc hidden) only when the probe reports the floor on.
- Docs:
  - A new deviation entry citing C1 and C2 with the run ids above.
  - Turn `spec.md:266` into a native-isolation ship gate.
  - Owner-actions note: hosted Codium @vector (the `cloudAgents` switch and listing) stays off until native isolation qualifies.
- Expected result: all 7 sandbox jobs green, as at `c0d10fb85` (43178097816).
- Cost: low. Two lane iterations.
- Risk: same-UID tools are not separated from the engine in this build. That is acceptable only because activation is off and native isolation is already the ship-ready gate (finish plan §2, @vector row).

**Fix B (alternative, if the owner wants a working floor in v2 before native isolation): repair the floor.**
- Load a reviewed Vector-only AppArmor profile in `prepare` with `apparmor_parser` (fixed argv), and remove it in `finish`.
  - Start from `build-isolation:packages/engine/script/isolation-apparmor-diagnostic.profile`.
  - Root enters it with `/usr/bin/aa-exec --profile=… --` before `prlimit`/`setpriv`, as native-shell's `DIAGNOSTIC_PROFILE` does (`github.sandbox.ts:18` on native-shell).
  - Never attach it to `/usr/bin/bwrap`, and change no sysctl.
- Remove the engine-level `bwrap` with its empty `/proc`. Keep per-tool user, PID, IPC and UTS namespaces with a private `/proc`.
- Add a post-open check to the in-process file tools: compare the opened file's device with the device of `/proc` and `/sys`, and refuse on a match.
- Add a nested probe launched from an engine-shaped context, so a C2-type failure refuses at `prepare` and not at the first tool call.
- Trade-off: this drops deviation item 5's empty-`/proc` kernel backstop, and `sandbox-tool-probe.ts:283-284` ("The engine can still open its process filesystem") would no longer hold. It needs a security review and a spec change.
- Cost: medium. Three or four lane iterations.

**Fix C (final): native isolation (§4).** It replaces both options at ship-ready.

---

## 2. The 5 red test groups from 43178097560, as of `29603fc90`

| # | Group (43178097560) | Status on `build-integrate` / `v2-vector` | Fix |
|---|---|---|---|
| 1 | `test/codium-plan-names.test.ts:93` (unit, linux) | **Still red.** Reproduced locally at `e88012584` (5 pass, 1 fail). The line is `docs/vector/build/vector-at-mention-progress.md:1042`: "agent Codium 10" matches `/\bCodium (?:10|50|100|200)\b/` (test `:14`). | Cherry-pick `3d7283bda` from `build-isolation` ("agent Codium: 10"). It applies cleanly (`git apply --check`). |
| 2 | Help snapshot, `help-snapshots.test.ts:144` | **Partly fixed by the Build Agent.** `e88012584` added the 4 github subcommands to `vector github --help`; `29603fc90` added `install --help`'s `--own-key`/`--schedule`. **Still red:** compat 43566525486 (windows job 132361479328) shows `vector github run --help` missing `--phase` (snap `:822-837`). The test stops at the first mismatch, so `github review --help` may differ too. | Regenerate once instead of one diff per push: `bun test --timeout 30000 test/cli/help/help-snapshots.test.ts --update-snapshots` from `packages/engine`. Review that the diff touches only `vector github …` blocks, then commit. Coordinate with the Build Agent (A3). |
| 3 | Connection inventory, `egress-inventory.test.ts` (linux 2/4, windows 2/12) | **Fixed** in `e88012584`: 6 entries for `github-agents.ts`, `review/workflow.ts`, `github.agent.ts`, `github.cloud.ts`, `github.run-helpers.ts` and `github.session.ts`. Passed in compat 43565027802 on ubuntu and windows (5/5). | None. Confirm in `test.yml`. |
| 4 | Windows `writeBundle`, 5 cases (`github.bundle.test.ts:578` and others; windows 10/12) | **Rewritten in `e88012584`:** mode check only off Windows, the marker filename test skipped on win32, a new Windows held-back case, forward-slash script paths, and the 100755 check only off Windows. Passes on Linux (lane 43565027861: only the agent-phase test failed in `github*.test.ts`). **Windows not verified:** the compat job stops at the help step before the bundle step, and `test.yml` has never run here. | Verify on Windows: compat on `29603fc90` (43566525572 dispatch / 43566525486 push), or `test.yml` on the PR. |
| 5 | Agent phase "no reaction, comment, push or network git call" (windows 6/12; `git config --local core.hooksPath` failed) | **Regressed on Linux and macOS in `e88012584`** (lane 43565027861, job 132356863324; `github.agent-phase.test.ts:469`: `outcome: "no-changes"`). Exact cause: under `bun test`, `process.execPath` is Bun. `bun -e` evaluates as ESM, so `require` is undefined inside the `eval`. The shell command throws a ReferenceError before writing README.md. Reproduced locally. `bun -e "eval('require(…)')"` gives a ReferenceError; `node -e` works. | At test lines 442-443, use `process.getBuiltinModule('node:fs')` and `process.getBuiltinModule('node:child_process')` instead of `require(...)`. Verified locally with a temporary edit, then reverted: the test passed (1 pass, 0 fail). Works on Bun 1.3.14 and Node 24.22. Windows still needs CI. |

Also:
- `bun typecheck` in `packages/engine` passes at `e88012584`.
- **`test.yml` (full suite, all OSes) has never run on this tree.** Its first run will be on the draft PR into v2. Expect new Windows-only cases from the V24/V25/V27 test files.
- `github-compat.yml` is a temporary Build Agent workflow. It runs on push to `build-integrate` only (`:3-5`) and by dispatch. On `v2-vector`, dispatch it. Before the v2 merge, remove it or point it elsewhere.

---

## 3. What V24, V25, V27 and V30 still need, and what has to wait

### V24: desktop main

Built in `e34523980`: 23 files, `desktop/src/main/github-agents.ts` and `github-agents-brain.ts`, IPC, preload and tests. Browser validation passed: 43216635830 and 43565027734.

Remaining:
1. **The version flip** (spec 2.11.4):
   - `packages/core/src/review/workflow.ts:18` still has `GITHUB_WORKFLOW_VERSION = "2"`. Set it to `GithubAgents.WORKFLOW_VERSION`.
   - Update the hard-coded `"2"` in `engine/test/cli/github.workflow.test.ts:145,195,279,328,483`, `github.review.test.ts:1780`, `github.run-routing.test.ts:122`, `engine/script/verify-sharing.ts:484` and `verify-github-app.ts:347`.
   - Update the comment at `core/src/github-agents.ts:6-7`.
2. A progress entry for V24. Today it is mentioned only in deviations ("Combined desktop integration review", `deviations.md:628`).
3. **Waits on the owner (A1 and spec §4 step 7):**
   - `vectorRequiredCliVersion` is `"1.99.99"` (`packages/desktop/package.json:6`).
   - `MIN_AGENTS_CLI` is a provisional `"1.99.113"` (`github-agents.ts:12`).
   - Raise both only to an actually published CLI release.

### V25: App UI

Built in `3b2476494`, plus `4c8e7390b` and `e706636ad`. App types and E2E types passed locally per the commit message. Browser lane green.

Remaining:
1. The copy is written inline in the components (`setup-card.tsx`, `run-dialog.tsx`, `agents-model.ts:3`), not in `packages/app/src/i18n/en.ts` as spec V25 lists. Move it there or record a deviation.
2. The pending "final V24/V25 cross-surface copy audit" (`progress.md:1158`).
3. A progress entry.
4. A5 (fold the UI into the redesign) is the owner's call.

### V27 runtime: built pieces versus missing pieces

**Built:**
- Server key `api/cloud-agents/artifact-key.ts`.
- Owner read `owner-artifact-key.ts`.
- The Brain prepare, commit, download and desktop-run routes (all behind `VECTOR_GITHUB_BRAIN_ENABLED`, which is off: `api/_lib/cloud-agents-desktop.ts:75`, `cloud-agents-owner-artifact.ts:50`, `cloud-agents-readiness.ts:66`).
- The VSA1 codec, newest-artifact selection and restore predicate (`engine/src/cli/cmd/github.session.ts:135,197,284,360,392`).
- The runner side of the session proof: the FD3 bridge (`github.sandbox.ts:626-637`) and the proof-checked copy into `vector-session` (`:785-790`, `:828-850`).
- The workflow upload of `vector-session-<thread>` (`core/src/review/workflow.ts:702-703`).
- Desktop preview and import (`desktop/src/main/github-agents-brain.ts:114,192,269,361`), with the engine's local `/experimental/brain/preview` and `/experimental/brain/run-proposals/import` routes.

**Missing: the Actions engine side does none of this yet.**
1. **Save and restore.**
   - Nothing calls the codec: `encryptConversation`, `latestConversation` and `decryptConversation` are used only by the desktop.
   - The engine never calls `GithubAgents.ENDPOINT.artifactKey` (`github-agents.ts:38`). `github.cloud.ts` calls only mint, bind, heartbeat and settle (`:244,332,363,382`).
   - Add a key client in `github.cloud.ts` that uses the run token.
   - Restore before the session starts (`github.agent.ts:459-461`): pick the newest artifact with `GITHUB_TOKEN` `actions: read`, decrypt, check `allowConversationRestore`, then import using `cli/cmd/import.ts`. Any failure falls back to the thread.
   - Save after the share flush and before `writeBundle` (`:559`): export, encrypt, write `vector-out/session.vsa`.
2. **Runner attestation.** `GithubSessionProof.attestSessionArtifact` (`github.session-proof.ts:35`) has no caller. Call it right after the encrypted bytes are written. The `session-replaced` matrix scenario proves it once the lane is green (§1).
3. **The desktop Brain transport is broken end to end.**
   - The App dispatch sends the input `brain_upload` (`api/_lib/github-app.ts:725`).
   - The v3 workflow declares only `mode, prompt, pr, code, ticket` (`workflow.ts:768-773`). GitHub rejects undeclared `workflow_dispatch` inputs with a 422, so every Brain-start dispatch would fail.
   - Fix: add the input (golden test), pass it to the agent step, and add a `brain-download` endpoint constant and engine client.
   - Use the immutable `brain/bundle.json` as context, and collect model drafts into `brain/proposals.json` inside the encrypted manifest under the separately labeled Brain key.
4. **Preview and import.** The desktop and UI exist, but no real run produces `session.vsa` or proposals yet. After items 1–3, add a CI case: a returned artifact, then the owner preview, then a one-shot import.
5. Tests:
   - Agent-phase cases for restore (newest of several), fallback (wrong key, rebind, tamper), refusal of a Brain-provenance restore, and the proof write.
   - Spec V27 test list: thread 5 asking for thread 6, and INV-P5.
6. Switch the privacy copy to "encrypted per conversation" (V29) only after items 1–3 pass in CI.

### V30: acceptance

Both journeys exist and pass in the lane at `50b4f82c2`:
- Server journey (`packages/web/test/cloud-agents-journey.test.ts`): hosted API job 131177429211, run against Valkey (`VECTOR_TEST_REDIS_URL`, `vector-at-mention.yml:125-130`).
- Engine journey (`github.agents-journey.test.ts`): 5 cases in job 131177429641.

Remaining:
1. The whole lane green, including the sandbox matrix. The matrix is V16's runner proof.
2. Add the V27 cases above to the journeys, plus the V24 v3 flip.
3. `test.yml`, `typecheck.yml` and `verify.yml` green at the exact PR head.
4. Update the progress doc. Its header still says "Work only on branch `vector-at-mention`" (`progress.md:3`), so name `v2-vector`. Update the PR body to match.

### What waits for Codium or A59 on v2

The v2 order is process-finish, release-coordination, codium, then @vector. I simulated that sequence with objects only, then merged `v2-vector` on top:
- **1 conflict:** `packages/core/src/cross-spawn-spawner.ts`, against #26's `OwnedProcess`.
- Resolution: keep both. `ProcessIsolation.launch` builds the file and arguments, then `OwnedProcess.track` tracks the launched process. Under Fix A, `launch` is a pass-through.
- Release-coordination and codium add 0 conflicts. Codium's last commit `1ce8f5f30` already has an equivalent here (`8d5e79a7e`).

After codium is on v2:
- The A59 joint check on v2: allowance `27e140de9`; verifier, gateway-hook and meter registrations; real-Redis mint and admission; the final webhook registration from `d8516df3d`.
- V31 (Ship Desk capture job, workflow golden) once A49 is on v2.

### What waits for the owner (never done by agents)

Spec §4:
- Step 3: register the GitHub App. Its name must not be "vector". Save the webhook only after the A47 router is deployed.
- Step 4: set `VECTOR_RUN_TOKEN_SECRET` and `VECTOR_RUN_ARTIFACT_SECRET` (Production scope). Leave `VECTOR_CLOUD_AGENTS_ENABLED` unset.
- Step 5: decode one live OIDC token per event on a private repository.
- Step 6: confirm the sandbox assumptions.
- Step 7: publish an npm CLI at or above `MIN_AGENTS_CLI`, and raise `vectorRequiredCliVersion` (A1).
- Step 8: acceptance on a private repository after A59, with the `cloudAgents` switch on only for that run.
- Step 9: listing (`CODIUM_LISTED_PERKS`).
- Step 11: legal read.

Also:
- A8: O1–O15 (build with the defaults).
- A5.
- Keep `VECTOR_GITHUB_BRAIN_ENABLED` and the other activation flags off.

---

## 4. Native isolation status (for a later step)

**Heads:**
- `build-isolation` `cf34ffe29` (11-12 23:57): 33 own commits, 117 behind `v2-vector`.
- `build-native-shell` `faa1fa09b` (11-14 06:31, **active**): 47 own commits, 117 behind.
- Both are based on `017f7144b`, which is already inside `build-integrate`.

**Design.** It moves to a Python namespace-entry keeper:
- `packages/core/src/process-isolation/linux/entry.py` (about 1,835 lines), plus `linux.ts`, `runtime.ts`, `build.ts`, `directory-identity.ts` (711 lines) and `engine/src/cli/cmd/github.isolation.ts`.
- Selection happens at compile time (`GithubIsolation.enabled()`) and is inactive by default.
- Shared commands are routed through native lifecycle plans (`140223e36`).
- The legacy bubblewrap path on native-shell still gives the engine an empty `/proc`, so C2 still applies to it.

**CI:**
- At `93387de55`: `test` 43320552566 and `typecheck` 43320558105 passed.
- "Genuine native Shell seam" has failed since `90573a13e`. The latest failure, 43552166332 (`4505c43dd`), is at "Actual native prepare…": `stage: prepare-keeper-wait`, `RuntimeError`, exit 125.
- The seam runs at `a38361628` and `33e04ec12` (43555802828, 43558143508) were cancelled. `faa1fa09b` targets keeper startup.
- "Native guard unit checks" 43558143656 passed.

**Open qualification** (`native-isolation-status.md:23-25` on native-shell):
- Prove the installed Python metadata observer and runtime/profile provenance on the same host.
- A reviewed immutable installer, and a workflow running the full baseline matrix plus four fresh Engine-death cells.
- Full bootstrap; preconstruction alias and canary cases; native profile/LSM compatibility; root installation; production-floor qualification.
- That document states: "No production activation is authorized by this document."

**Integration hazards when its turn comes:**
- Its `vector-at-mention.yml` deletes the 7-job @vector matrix (−338 lines) and replaces it with the experiment. Move the experiment into its own workflow, such as `native-shell.yml`, before merging.
- 5 conflicts against `v2-vector` today: `vector-at-mention.yml`, `core/test/github-agents.test.ts`, `github.agent-phase.test.ts`, `github.bundle.test.ts` and `egress-inventory.test.ts`.
- It touches `cross-spawn-spawner.ts`, the same file as #26 and Hands. Finish-plan item 40 (one design review of that spawn code) applies.

---

## 5. Proposed order of work on `v2-vector` (after this plan is accepted)

1. Re-fetch and fast-forward or merge `build-integrate`, and `vector-at-mention` if it moves. Get the orchestrator's answer on A3 first, or agree who fixes what.
2. Commit the test fixes: group 1 (`3d7283bda`), group 5 (`getBuiltinModule`), group 2 (one regenerated snapshot) unless the Build Agent has already landed them.
3. Commit the bounded probe diagnostics (§1.5).
4. Commit Fix A, or Fix B if the orchestrator picks it, with the docs and owner note.
5. The V24 version flip.
6. Re-fetch and push `v2-vector` (fast-forward only). Open the draft PR once with `gh pr create -R scr1pter/claudeondfsfdaf --base v2 --head v2-vector --draft`.
   - `test`, `verify` and `typecheck` run on the PR. The lane runs on `pull_request` (path filter).
   - Dispatch `github-compat.yml` and `github-desktop-validation.yml` with `--ref v2-vector`.
7. V27 runtime items 1–5 with tests, then the V30 journey extension.
8. After codium lands on v2: merge `origin/v2`, resolve `cross-spawn-spawner.ts`, run the A59 joint check, then V31.
9. Update the progress doc (V24, V25, V27, V30 entries and the branch name), the deviations doc and the PR body.
   - After the merge, the orchestrator closes #25 as superseded.
   - Remove `github-compat.yml` before the v2 merge.
