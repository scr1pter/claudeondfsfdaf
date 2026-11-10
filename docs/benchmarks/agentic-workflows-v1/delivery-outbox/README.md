# Delivery outbox â€” independent v1

This existing-application maintenance workload upgrades a synthetic support dashboard with durable delivery semantics. It was authored independently of runtime candidates and paid outputs. The production candidate `a35c03d6a9bb16f16ec0187ad69c6c6420d10f19` was frozen before final qualification and review. These free controls do not establish a runtime performance claim or select a winner.

`TASK.md` is public. `seed` is the working v1 application, with protected local-provider fixtures and pinned dependency/runtime files. Only the seed and public task are copied to a coding arm. `evaluator`, `inventory.json`, `controls` and `tools` are independent instrumentation and remain outside that arm's workspace. The complete gate has 18 API groups and 8 browser workflows, with a report row for every inventory item.

The provider starts on loopback port zero in the application process and owns separate durable synthetic SQLite receipts. Databases, profiles, logs and evaluation outputs stay outside application source. Explicit barriers and release controls establish failure windows; elapsed sleeps never establish delivery correctness. Browser observations use the common fenced local driver, and the frontend uses the application origin alone.

Read `VALIDATION.md` for executed evidence, exact projections, retained free failures and limits. Current status: runtime-qualified on both the old-focus and actual planned envelope browser profiles. The independently reviewed `FREEZE-v1.json` governs final bytes; coordinated committed-byte verification governs admission. No paid Task 3 arm is admitted until its reviewed final freeze is committed and its bytes verified.

`tools/free_validate.py` runs pure Python controls without Bun, servers, browsers or model calls. `tools/qualify_fixture.py` performs explicit real-fixture free qualification. `tools/freeze_v1.py` defaults to a read-only preview. Final freeze requires an already-frozen candidate, independent approval, runtime evidence and a matching runtime projection. `--check` verifies the manifest and physical bytes against Git clean-filter bytes; `--git-mode index` verifies actual staged blobs, and `--git-mode head` actual committed blobs. These checks never stage or commit.

The private reference and semantic mutants are calibration controls, not study submissions. Publish sanitized exact reference source outside this frozen task root after all paid study arms finish, so another computer can reproduce qualification without leaking a solution into an active coding arm.
