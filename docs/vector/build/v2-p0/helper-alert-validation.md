# B09 helper phone alerts and Stop validation

## 2026-11-22

Prepared from main `c515de62465db817ff309f4237023f9704fe7983` on `helper-alert-validation`.

A helper's ask reached two phone notification paths: the ordinary ask dispatcher sent an alert named after the helper, and the helper lifecycle notifier sent another named after the root conversation. The shared ask dispatcher now leaves the phone push to the lifecycle notifier when the resolved session has both a parent and an object-valued `metadata.subagent`, matching the task-created session record. Local sounds, notifications and toasts still run. Root asks and child sessions without that lifecycle marker retain their ordinary phone alert.

The helper notifier still owns waiting/interrupted detection, its existing settle and duplicate checks, root-conversation visibility, notification settings and the account/plan gate. No delivery authority, enrollment, consent text or feature default changes.

The session Stop body already publishes `additionalProperties: false`, but the HTTP decoder stripped unsupported controls and returned success. Its schema now rejects excess properties before the task manager is invoked. Valid `helpers`, optional bounded `reason`, path authorization and guest restrictions are unchanged.

## Local evidence

- Ask controller: the new helper case failed against main by recording two ordinary phone sends, then the complete file passed 12 tests. The new child-session controls keep ordinary alerts when lifecycle metadata is absent or malformed.
- Combined real ask/auto-accept/helper/phone modules: the helper case failed with two pushes, then all 6 tests passed with exactly one root-titled push. The ordinary conversation ask still sends its approval alert.
- Actual in-test HTTP route: the stricter excess-field case failed with status 200, then all 6 tests passed with status 400 and no task-manager call for unsupported fields. Existing valid-input and guest cases remain.
- The unchanged helper lifecycle file passed all 8 tests.
- All tests used existing fakes, ran one file at a time with `--timeout 30000`, and shared the canonical Bun workload lock. No app, desktop, browser, notification provider or owner computer was started.
- Canonical `packages/client` generation completed without generated changes. The existing published Stop schema still takes only `helpers` and `reason` and already has `additionalProperties: false`.

This is a local candidate. No feature flag was enabled and no live phone alert was sent.
