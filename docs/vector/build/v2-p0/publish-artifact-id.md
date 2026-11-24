# V31 publish artifact identity

## 2026-11-22

Prepared from main `c515de62465db817ff309f4237023f9704fe7983` on `publish-artifact-id`.

The generated v3 publish job downloaded `vector-run-<run_id>-<run_attempt>` by name. BT12's V31 review records that an earlier capture job can upload an artifact named for a later attempt. A later trusted upload can then fail on that collision while name-based publish still finds the planted bundle.

The runner-owned bundle upload now has step ID `bundle`. Its built-in `artifact-id` output becomes the agent job's `bundle` output. Publish passes only that ID to `actions/download-artifact@v4`; it has no artifact-name selector or fallback. This applies to Codium, own-key and scheduled workflows.

Two details preserve the existing failure and filesystem contracts:

- The download step requires a nonempty bundle ID. The action otherwise interprets a missing selector as downloading all artifacts. A skipped or unsuccessful upload leaves publish with no bundle and its existing generic failure response, before optional repository-token acquisition or a publish mutation.
- `merge-multiple: true` preserves `summary.json` and `patch.diff` directly under the runner's `vector-bundle` directory. ID-mode download otherwise adds an artifact-name subdirectory even for one ID.

Bundle names, retention, sandbox-finish ordering, session artifacts, route checks, permissions and the publish command remain unchanged. The workflow generator emits the new selection for future setup/reinstall; existing repository workflow files are not edited by this package. Feature flags and owner activation gates remain unchanged, including the separate A49 capture follow-up.

## Local evidence

The new workflow regression failed against main because the upload step had no ID. It checks the exact upload-output-to-job-output-to-download chain, empty-ID guard, flattened destination and absence of a name fallback in all three generated workflow modes.

The complete workflow test file passed 43 tests with the fix. Its three goldens were regenerated through Bun's snapshot update mode. The expression allowlist includes only the two added artifact-output expressions. The existing in-process journey fixture now resolves the stand-in upload ID, with an empty value when mint skips the agent; its direct bundle copy remains a stand-in for the Actions artifact service.

Actual GitHub Actions artifact-service execution remains CI evidence. No real customer GitHub API, credential, app, capture browser or notification provider was used locally.
