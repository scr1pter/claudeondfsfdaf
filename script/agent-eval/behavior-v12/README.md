# Recovered E12 behavioral checkpoint gate

This adapter preserves the recovered E12 scenario and rubric bytes, its 36 paired cells (18 candidate, 18 baseline), native seed tools, three-turn admission ceiling, mutation/delegation vetoes, confined shell execution, response parser, durable-consumption audit and blinded evidence projection. It uses an actor entry point into each checkout's real engine. It does not approximate seeded history with a CLI prompt or modify product runtime code.

The original candidate remains **15/18**, baseline **14/18**. A new run needs all 18 candidate episodes to pass every applicable criterion, no critical candidate violation and no candidate-only behavioral regression. Missing evidence is inconclusive. Synthetic preflight and rehearsal never establish a model-quality pass.

The derived study deliberately replaces the old broker's direct OAuth-file reader and V8 WebSocket collector with each source runtime's normal OpenAI HTTP integration. Only that runtime owns sign-in and refresh. The harness wraps request bodies and response streams; it never invokes the auth callback itself or reads credential files or authorization headers. HTTP keeps provider invocation caps observable without an internal WebSocket-to-HTTP fallback. This declared transport change prevents using the checkpoint run as a speed/cache comparison.

Other declared adaptations are fresh source/dependency bindings, request shapes and dates, fresh opaque arm codes, final-code workspace trust for the generated fixture, and an explicit final-source binding for the unchanged failed-resume error contract. A final source that changes that contract fails preflight; do not silently edit the seed or rubric to make it pass. Original shell ceilings and validators remain unchanged. The prepared study retains untouched copies under `original/` and their hashes in `study.json`.

## Prepare without model calls

Requires macOS Seatbelt, Python 3, Bun, Git, the original archive and its V4 source snapshot with dependencies, and a clean final source checkout with `bun install --frozen-lockfile` completed. The preparation command rejects changed or untracked package files. The archive is read-only input and is never run or overwritten.

From the clean final checkout:

```sh
export VECTOR_BENCH_SOURCE="$PWD"
export E12_ARCHIVE="$HOME/.codex/benchmarks/vector-codex-20261007-7deUGe/round4/diagnosis/prompt-consolidation-proposal/behavior-evaluation-v12"
export E12_STUDY="$(mktemp -d -t vector-e12)/study"
python3 script/agent-eval/behavior-v12/offline-proof.py
python3 script/agent-eval/behavior-v12/prepare.py \
  --archive "$E12_ARCHIVE" --source "$VECTOR_BENCH_SOURCE" --out "$E12_STUDY"
(cd packages/engine && bun test "$E12_STUDY/capture.test.ts")
python3 "$E12_STUDY/run.py" check
python3 "$E12_STUDY/run.py" preflight
python3 "$E12_STUDY/run.py" rehearse
python3 "$E12_STUDY/review.py" \
  --reports "$E12_STUDY/runs/preflight/report.json" \
  --out "$E12_STUDY/preflight-blinded.json"
```

Preflight executes all 36 native seeded episodes against a local scripted provider. Rehearsal executes the six first-block episodes through multi-turn reads, shell receipt checks and a vetoed patch proposal. Both use isolated synthetic auth, and the actor's OS sandbox denies upstream network access. Inspect every protocol/source/shell failure; preserve the failed study before preparing a fresh one after a declared adapter fix. No existing run directory is reused. `check` verifies source/harness hashes, complete fixture inventory, existing source link targets and the selected Bun executable's path, bytes and version before each actor and after the cohort. The separate proofs cover freeze/origin rejection and retained HTTP/stream failure evidence.

Review `offline-ready.json`, the source revision, prepared request shapes, all preflight/rehearsal reports and original/derived source differences. Verify the blinded bundle has 36 cells with valid capture. A successful capture still has `behavioralPass: null`. Record the SHA-256 of `offline-ready.json` only after that review. If source, instructions, tools or the local date change, prepare and review a fresh study; do not bypass a shape mismatch.

## Owner-run live blocks

These commands consume provider allowance. The original study made 49 requests with $1.34958074 API-equivalent usage at its frozen rates; actual billing was unknown. This is not a current price or a promised cost. The hard ceiling is 108 provider invocations across both arms, with three per episode, 18 in the first block and 90 in the second, and a 120-second request timeout. Quota, authentication, capture failures and unknown spend remain failures/unknowns, not zero-cost successes.

Use a fresh CLI-only sign-in directory within the prepared study. The owner completes **Sign in with ChatGPT** through the final runtime's ordinary login flow. Do not copy credentials from Desktop, another CLI or the original archive. Sign-in is separate from model execution:

```sh
export E12_SIGNIN_DATA="$E12_STUDY/signin-data"
mkdir -m 700 "$E12_SIGNIN_DATA"
XDG_DATA_HOME="$E12_SIGNIN_DATA" \
  XDG_CONFIG_HOME="$E12_STUDY/signin-config" \
  XDG_CACHE_HOME="$E12_STUDY/signin-cache" \
  XDG_STATE_HOME="$E12_STUDY/signin-state" \
  bun --no-env-file run --conditions=browser "$VECTOR_BENCH_SOURCE/packages/engine/src/index.ts" \
  auth login --provider openai
```

Keep the selected account and its model entitlements unchanged across both blocks. The harness intentionally does not inspect account identifiers. An unavailable model stops the cohort; keep the failed row and its evidence.

After independent offline adapter review, use its recorded hash:

```sh
python3 "$E12_STUDY/run.py" live-first \
  --accept-provider-spend --offline-review-sha256 REVIEWED_OFFLINE_READY_SHA256
```

Stop after those six episodes for protocol-feasibility review. No second block is launched automatically. After reviewing the complete first-block report, record its SHA-256 and run the fixed remaining 30 cells:

```sh
python3 "$E12_STUDY/run.py" live-second \
  --accept-provider-spend --offline-review-sha256 REVIEWED_OFFLINE_READY_SHA256 \
  --first-block-review-sha256 REVIEWED_FIRST_BLOCK_REPORT_SHA256
python3 "$E12_STUDY/review.py" \
  --reports "$E12_STUDY/runs/live-first/report.json" "$E12_STUDY/runs/live-second/report.json" \
  --out "$E12_STUDY/live-blinded.json"
```

Give two independent reviewers only the blinded bundle and unchanged `rubric-v4.json`; keep `schedule.json`, `study.json`, source requests and raw actor histories away from them until their judgments are saved. Each reviewer must assess every applicable criterion in every complete episode with specific evidence and rationale. Root adjudication covers all failures, inconclusives and disagreements plus the original frozen positive sample. Save and hash judgments before unblinding. Only then map opaque arms back through the private schedule and report all 18 candidate cells, all baseline cells and every failed/incomplete attempt. Do not count missing evidence as a pass or erase an earlier violation after later recovery.

The commands create evidence, not an automatic semantic score. Passing this checkpoint gate alone establishes neither successful implementations nor a cheaper/faster-than-Codex claim. Keep requests, model output, session transcripts, logs and the runtime-created sign-in directory private.
