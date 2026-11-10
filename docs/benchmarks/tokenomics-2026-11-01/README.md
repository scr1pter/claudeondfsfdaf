# Tokenomics study: code, evidence and reproduction

The canonical combined checkout is [tokenomics-complete](https://github.com/scr1pter/claudeondfsfdaf/tree/tokenomics-complete). It contains the product fixes, tests and this evidence. The source branch is [tokenomics-efficiency](https://github.com/scr1pter/claudeondfsfdaf/tree/tokenomics-efficiency); the report branch is [tokenomics-gaps](https://github.com/scr1pter/claudeondfsfdaf/tree/tokenomics-gaps). These branches have not been merged into `main` or released.

```sh
git clone --branch tokenomics-complete https://github.com/scr1pter/claudeondfsfdaf.git vector
```

See the [full report](../../vector/build/tokenomics-gaps.md), [numerical results](live-results.json), [sanitized request ledger](usage-receipts.json), and [per-check functional results](foundry/evaluation-results.json). The ledger retains all 449 provider receipts and $11.2319408 in usage-derived cost, including diagnostics, failed attempts and repairs. Synthetic case labels replace runtime labels; provider IDs, request hashes, headers, credentials and transcripts are excluded. Output includes reasoning; do not charge the reasoning subset a second time. These are recorded usage calculations, not invoice reconciliation.

## Included benchmark material

`foundry/instrument` contains the exact executed core specification, evaluator, controls, review rubrics and five-file empty scaffold. `foundry/submissions` contains all five selected synthetic applications: original Vector, original Codex, native-patch first, native-patch repaired, and readiness first. Their authored files are byte-identical to the saved evaluated submissions. Six screenshots inside Codex's own submission are synthetic app verification artifacts; they are not the separate blinded review's complete image set.

The [snapshot manifest](foundry/snapshot-manifest.json) hashes all 18 copied core/scaffold files, 97 submission files, and the sanitized outcome projection. It records the original full frozen-instrument hash as provenance. This public subset has its own manifest; it does not pretend to be the entire original 116-file historical freeze. Raw runtime logs, machine homes, controller configuration, dependencies and historical files containing workstation paths are excluded. Credentials never belong in this public repository. No paid runner or automatic provider/deployment operation is enabled here.

Verify the published snapshots without running any application or model:

```sh
python docs/benchmarks/tokenomics-2026-11-01/foundry/verify_snapshot.py
```

## Run the free instrument controls

Use Python 3.11 or newer and Node 24. These commands make no model calls. Run them from `foundry/instrument`:

```sh
python -m unittest test_instrument.py
node --test browser-eval.test.cjs
```

## Re-evaluate a saved application

The executed operating profile was Windows, Bun 1.3.14, Node 24.22.0, Playwright 1.59.1 and Chrome. Other operating systems have not been validated by this study. Install these tools and the app's locked dependencies on the new machine. Tool locations are explicit arguments, with no dependency on the original workstation paths.

Copy one `foundry/submissions/<case>` into a **new disposable directory outside the repository**. From that copied app, run `bun install --frozen-lockfile`. Keep evaluation outputs separate. With real absolute tool paths substituted, run:

```sh
python <instrument>/evaluate.py --app <copied-app> --out <new-output> --bun <bun-executable> --node <node-executable> --playwright-module <playwright-package-directory> --chrome <chrome-executable>
```

Dependency installation may download packages. The evaluator runs local app processes and browser checks using synthetic identities; it does not call a model, read API credentials or deploy anything. Keep one Bun workload at a time. The `--out` directory must be new. A missing prerequisite is a failure or a not-run result, never a pass.

Expected corrected outcomes are 32/32 API groups and 40/40 browser checks for every saved case except `native-first`, which has one genuine API failure and still passes all browser checks. Rerunning saved applications is free of model charges; it is not a fresh model-generation benchmark. Broader cost superiority, production readiness and new paid results are not implied.
