# A24: production benchmark gate

A23 is implemented at `7a7c664d`. Before changing app session or timeline source for A24, this preparation ports the reviewed production benchmark job from `approved-fixes` (PR #19), including its step-scoped trace directory. It also ports the existing child-navigation fixture correction: the task now renders as a phase chip, and modifier-click opens its session.

The manual `test.yml` input `production_benchmark=true` builds the production app and runs the existing three first-navigation scenarios three times each with one Chromium worker. Its engine and provider responses are local browser fixtures. The job preserves the source SHA, run identity, metrics and raw traces. Ordinary browser discovery still excludes the performance directory; this does not restart the parked parity benchmark branch.

Preparation validation: the workflow parses and its production benchmark job exactly matches the reviewed job; formatting and diff whitespace checks pass; the existing first-navigation metrics unit file passes both cases. App types are included in the mandatory pre-push hook. No A24 production source has been changed. The actual baseline must succeed and be recorded here before those edits begin; the same benchmark must run after A24 for comparison, without machine-specific timing thresholds.
