# Foundry independent code review

Review an unchanged archived delivery, using opaque labels and withholding runtime/cost information until scores are saved. Static findings are distinct from measured API/browser gates. Give file/line evidence for each material finding; do not claim a vulnerability was executed unless a test demonstrated it.

Score each axis0 missing/broken,1 fragile,2 competent,3 strong,4 exceptional. Twelve axes, maximum48.

1. Real architecture: actual typed frontend/backend, coherent modules, migrations/schema setup and dependencies.
2. Authentication: real salted password verification, unpredictable revocable sessions and secret-free logs.
3. Workspace/role boundaries: membership checked at server entry and foreign child references/downloads safely scoped.
4. Inventory transactions: bounded stock, immutable movements, rollback and concurrency handling.
5. Fulfillment idempotency: durable keys, failed-key retry, exactly-once movements and atomic order state.
6. Financial correctness: integer cents, stable snapshots, transactional unique numbering and guarded invoice state.
7. Projects/collaboration: durable tasks/comments/assignees, cascades and author permissions.
8. CSV and file handling: robust parsing, atomic import, formula neutralization, owned paths, byte integrity and cleanup.
9. API correctness: validation, consistent errors, protected fields, constraints and sensible resource limits.
10. Client state and live updates: real server data, tenant-safe cache/selection, retry/error behavior and cross-client changes.
11. Maintainability and useful tests: clear types/names, comprehensible change boundaries, meaningful tests rather than mirrored implementation.
12. Operational honesty: reproducible build/start/restart, no fake typecheck/build scripts, local-only dependencies and explicit prototype limitations.

Protected audit/evaluator files are never copied into a model fixture. Inspect package scripts and source for false verification or substituted endpoints. Do not fix the delivered application during review. Record gate limitations, uncovered security/performance cases and residual risks; this benchmark cannot establish production readiness.
