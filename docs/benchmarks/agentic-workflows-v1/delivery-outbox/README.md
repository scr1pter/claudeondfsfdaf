# Delivery outbox — independent draft v1

This is a **draft only** existing-application maintenance workload. It is not a frozen instrument, approval to run a paid arm, or evidence about any runtime. Authoring is independent of candidates, paid outputs and optimization hypotheses. Do not expose the evaluator to a coding arm.

The seed implements a single-origin synthetic support dashboard; real-runtime qualification is still pending. The requested upgrade adds durable message admission, a transactional outbox, idempotent local-provider delivery, explicit retry, cancellation and recovery. A protected provider uses its own SQLite database, starts on loopback port zero in the application's process, and persists accepted effects separately from application state. The fixture has no cloud integrations or personal data. There is no timer-based race oracle.

`TASK.md` is public. `seed/fixtures` and dependency pins are public and protected. `evaluator`, `inventory.json`, `controls` and `tools` are independent instrumentation. The complete gate contains 18 API groups and 8 browser checks, with one report row per inventory entry even after an earlier failure. The evaluator hashes source before and after, writes runtime data and all logs outside source, owns only its spawned process trees, and never repairs a submission.

`tools/free_validate.py` runs pure Python positive/negative controls and structural checks only. It does not invoke Bun, install packages, start a server, launch a browser, typecheck, build, or call a model. `tools/freeze_v1.py` previews a portable SHA-256 manifest by default. Its explicit freeze operation requires an operator-supplied production-candidate reference and is forbidden until that candidate is actually frozen. A preview is not a freeze.

Before any use: obtain the exclusive Bun execution slot; run the documented free runtime validation; verify that the unmodified v1 seed starts and retains its existing behavior but fails the upgrade gate as product failure; validate all provider controls; run meaningful positive and negative complete-product controls; inspect the browser evidence; freeze the production candidate first; then review and freeze this task. Never adjust the task after seeing comparative paid results. New task versions require new manifests and new independent validation.

This directory is sole-owned during draft authoring. No git mutation or paid execution is part of this draft.
