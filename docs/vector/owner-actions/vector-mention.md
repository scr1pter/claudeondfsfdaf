# @vector release and owner acceptance

This feature runs repository work in the user's GitHub repository and on the user's Actions minutes. Vector Codium supplies model access. GitHub controls runner availability, scheduling and Actions charges under the repository owner's account and GitHub's terms.

The source checkpoints in [the build progress](../build/vector-at-mention-progress.md) are not production activation or a published CLI. Keep the new switches and public listings off until the integrated checks and the explicit acceptance below pass. The reserved `MIN_AGENTS_CLI` must name an actually published release before users receive a generated workflow.

## Configuration and publication order

| Setting | Purpose | Initial state |
| --- | --- | --- |
| `MODEL_PLANS_ENABLED` and Codium's `codium`/`cloudAgents` runtime switches | Model and GitHub-agent admission | Keep the new service path off pending acceptance |
| `VECTOR_GITHUB_APP_ENABLED`, App id/client id/slug/private key | Scoped installation verification and opt-in publication/desktop dispatch | Existing App setup policy; activate only for a selected test installation |
| `VECTOR_RUN_TOKEN_SECRET` | Signed, short-lived run-domain authority | Dedicated random secret in the production secret store |
| `VECTOR_RUN_ARTIFACT_SECRET` | Per-conversation encrypted artifact keys and separately labeled upload key wraps | Dedicated random secret; rotation can make older artifacts unreadable |
| `VECTOR_GITHUB_BRAIN_ENABLED` | Explicit desktop Brain upload, run and owner-read routes | Unset/false until the complete desktop/run/return path is accepted |
| `CODIUM_LISTED_PERKS` | Public/UI display permission | Add `github-agents` last; `github-no-secret`, `scheduled` and `brain-cloud` retain their own gates |
| `CODIUM_TRACK_B_LIVE` | Track B Brain/playbook listing readiness | Existing Codium rollout rules apply |

The artifact key has a dedicated master or a separately labeled derivation from the license secret. Never paste a key, raw run token, installation token, private key, model credential or account email into issues, logs or acceptance notes. The old pre-A59 `VECTOR_CLOUD_AGENTS_ENABLED` table/backing is no longer the authority.

Deploy the shared signed webhook router before saving the App webhook configuration. Register the `cloud-agents` repository handler alongside Codium's handler. Verify transfer/deletion invalidates the old binding generation, rename changes only the repository name and replayed/unknown deliveries do no extra work. Webhook failure must remain retryable; App uninstall alone does not silently reassign a binding.

## App and workflow trust

Use the registered installation URL to obtain the App slug; never guess the account handle. The App's registered name is not the `/vector` command. Keep the existing permissions in [GitHub App owner actions](github-app.md): task, review, publish and internal dispatch use distinct exact profiles. Publishing uses Contents/Pull requests/Issues write plus Checks/Metadata read, without Actions write. The default publication credential is the repository's `GITHUB_TOKEN`.

An opted-in App publication may trigger repository CI, with the resulting Actions minutes. Inline review comments, server-started bot tickets, and threads containing non-writer content retain the repository-token path. Human/default/fork heads never grant overwrite authority. GitHub configuration changes are held back from publishing independently of model summaries.

The generated workflow has separate route, agent, publish, review and bind jobs. Its OIDC job names/audiences are checked against the actual active GitHub attempt/check-run, current immutable repository/owner ids, exact workflow path/ref/SHA and actual collaborator permissions. Verify both ordinary and immutable OIDC subject formats. Codium refuses runners the user manages; own-key jobs there do not receive the GitHub runner's process-isolation guarantee.

Confirm the runtime's private credential channel, process/PID/proc isolation and inspector/signal hardening on the real supported runner. Inspect the saved session's private runner proof: the engine attests the exact encrypted bytes over its reserved descriptor; cleanup stops the untrusted UID before comparing and copying. A model-written or replaced session artifact must never pass the encrypted-output boundary. A magic prefix alone is insufficient.

## Selected-repository acceptance

1. Publish the intended CLI after its normal release review and confirm the installed executable contains the route/agent/mint/bind/publish/sandbox commands. Generate both modes with that exact version. Exercise the route script from the actual packaged CLI and desktop bundle, including quotes, multiline prompts and hostile mention text.
2. Merge a generated own-key workflow in one selected test repository. Add the free-account CLI credential and provider secrets through GitHub's secret settings. Confirm own-key runs send no cloud-agent or Codium gateway requests. Repeat a manual review, issue task and same-repository PR task. Keep public sharing off unless separately approved.
3. Enable the selected Codium test path, install the App and bind on the actual default branch. Record immutable repository id, workflow version and binding generation, without account credentials. Confirm anyone with current write access can start a repository task using the binder's allowance, and non-writers/bots/forks cannot.
4. Confirm exact model-domain routing, deadline/heartbeat/cancellation, at-once waits and terminal settlement. A partial stopped run produces a draft and neutral reason; completed findings remain visible. Verify actual token replacement, revocation, unbind/rebind and lost-binder access deny old authority.
5. Publish with `GITHUB_TOKEN`; check the PR's CI caveat. Then explicitly opt in to eligible App publishing and verify actual bot attribution, exact one-repository permissions and expected CI. Check moved heads, existing drafts, default-branch heads, forks and held-back `.github` files.
6. Exercise a configured schedule and an unconfigured cron. Confirm the UTC/daylight-saving note, unique schedule minutes/ids and reuse of only the exact schedule's bot-owned proposal. GitHub schedules are best effort and can be disabled after public-repository inactivity.
7. Exercise per-conversation artifact save/restore and wrong-key/thread/repository/generation/tampering/expiry fallback. Check the newest matching artifact is selected, GitHub authorization is removed on signed storage redirects and no artifact/session payload reaches Vector servers.
8. With Brain enabled only for this explicit test, approve exact local repository bytes, upload opaque ciphertext and start the owner desktop run. Check current public-repository omissions and owner/binding/source/listing/allowance gates. A failed upload/ticket bind must not dispatch or fall back. Confirm non-desktop triggers and different newly approved Brain bytes cannot restore older Brain-derived session history.
9. Explicitly read a completed Brain result from the desktop. Verify current marked-owner/repository/generation/actual-artifact checks, local authenticated decryption, readable preview and a separate import approval. New memories/skills enter the review queue as proposed/unpinned; active personal memory, learned statistics and model drafts never gain automatic approval.
10. Exercise account revocation/erasure after creating bindings, codes, tickets, live/settled runs and encrypted uploads. Confirm wrapped keys/ciphertext and owned records disappear while unrelated accounts survive. GitHub ciphertext keeps GitHub's existing expiry/deletion policy; already downloaded plaintext/keys cannot be retracted by revocation.

Record the actual deployment, published CLI, commit, workflow run ids and outcomes in the release evidence. Passing fixtures do not establish real App permissions, runner isolation, hosted storage behavior, scheduling, CI triggering or device UI behavior. Keep a concrete pending item for every acceptance step that has not been observed.

## Rollback

Stop new model admission with Codium's runtime switch, hide public perks and disable the Brain gate. Revoke affected account/run authority and bindings as appropriate; installation credentials already issued by GitHub require GitHub revocation or expiration. Rotate compromised secrets using the existing App and account incident procedures. No rollback can recall a key/plaintext already downloaded to an authorized device.
