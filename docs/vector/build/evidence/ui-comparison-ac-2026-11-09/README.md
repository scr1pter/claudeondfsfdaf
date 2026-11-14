# First-navigation comparison on AC power

**All 60 scenario runs passed. This comparison does not show a general UI
speedup.** Opening an existing conversation was modestly slower on the candidate
in both run orders. The other two scenarios were mixed or broadly similar.
There were zero observed blank or unknown samples in every run.

Performed on 9 November 2026 (Pacific), on one Windows ThinkPad with an
i9-13950HX, 127.66 GiB RAM and the Balanced power scheme. All 46 power samples,
taken approximately every 10 seconds, reported AC power. This establishes the
sampled power state, not continuous power or thermal isolation.

## Results

Each cell shows baseline → candidate median milliseconds, followed by the
candidate-minus-baseline difference. Positive differences mean later observation.
There are ten repeats per scenario per revision, pooled across the two orders.
Full values, ranges and separate batch medians are in [summary.json](summary.json).

| Scenario                 | First destination observed | Stable destination observed |
| ------------------------ | -------------------------- | --------------------------- |
| Existing conversation    | 85.3 → 96.5 (+11.2 ms)     | 208.4 → 227.6 (+19.2 ms)    |
| New conversation         | 101.5 → 101.4 (−0.1 ms)    | 164.2 → 154.8 (−9.5 ms)     |
| Child-agent conversation | 72.5 → 77.7 (+5.2 ms)      | 133.3 → 128.4 (−4.9 ms)     |

These are DOM visibility observations after each scenario's navigation trigger.
“Stable” is the timestamp of the third consecutive destination-only sample.
They are not browser FCP, model response time, full task duration or native
desktop acceptance. Route-triggered and click-triggered scenarios have different
start semantics; compare each scenario with itself across revisions.

The existing-conversation path is a profiling follow-up for the multiagent UI
owner. Its median was later in both orders. This study compares whole revisions
and does not identify one source edit as the cause. No production UI change or
timing threshold was introduced to make these results pass.

## Controlled method

- Baseline: `4299d7432aaac8b1937c5986729360e6b9f176f5`.
- Candidate: `82a7d26ce2bea3751f59076e6a26469eea632b00`.
- Both used the candidate's pinned first-navigation harness and mock helper
  against their own production app builds. The performance directory and
  dependency lockfile are identical across revisions; the mock helper changed,
  so sharing it avoids a fixture-version confound. This is a new common-harness
  comparison rather than a byte-for-byte replay of a historical run.
- Workspace dependencies resolved to each build's own core, UI and session-UI
  source. The baseline was a separate detached checkout with a frozen install;
  no shared workspace junctions or app `.env` files were used.
- Bun 1.3.14, Node 24.22.0, Playwright 1.59.1, Chromium Headless Shell 1217,
  Vite 7.1.4 and Solid 1.9.10. Same headless project, viewport, dev channel,
  isolated port 4487, synthetic API responses and explicit build settings.
- Five repeats per scenario per arm, one worker, zero retries, profiling off.
  Order was baseline/candidate, then candidate/baseline: A-B-B-A. Production
  builds and tests ran serially. Server reuse was disabled; original completion,
  blank and unknown assertions were retained.

One host, two nonrandomized batches and shared background activity limit the
conclusion. Thermal/cache state and scheduling remain possible confounders.
The reverse order checks one source of bias; these are not independent platform
replications or proof of a general performance change. The complete timeline
benchmark, native Mac/Windows acceptance, model quality and provider costs remain
separate work.

## Reproduce and inspect

Use the [comparison runner](../../../../../scripts/release-readiness/compare_ui.py)
and [shared config](../../../../../scripts/release-readiness/compare-ui.playwright.config.ts)
from the published coordination checkout, whose first-navigation harness matches
`82a7d26c`. Install frozen dependencies in that toolkit and both pinned source
checkouts. Put the recorded Bun and Node versions on PATH. On Windows AC power,
from the coordination repository:

```text
python -B scripts/release-readiness/compare_ui.py --baseline-root <baseline-checkout> --candidate-root <candidate-checkout> --output <fresh-forward-directory> --repeats 5
python -B scripts/release-readiness/compare_ui.py --baseline-root <baseline-checkout> --candidate-root <candidate-checkout> --output <fresh-reversed-directory> --repeats 5 --order candidate-first
```

The runner refuses existing output directories. It records raw logs, records and
power samples; the published version rejects missing/duplicate scenario-repeat
identities and retries, bounds each arm to 20 minutes, and cleans up its owned
test process tree on abnormal exit. A real synthetic parent/child cleanup probe
passed without targeting a user's app.

The forward batch predates those extra runner safeguards. Its raw records were
independently revalidated against all three scenarios and repeat indices 0–4;
they were not retrospectively labelled as guarded execution. The reversed batch
used the hardened runner. Both executed controller digests are recorded in the
summary. The controller changes did not alter timing instrumentation or app code.
The published runner also resolves the harness from its own toolkit checkout,
allowing either app build root to be an untouched detached source revision. In
these recorded runs the candidate and toolkit shared the same checkout.

`forward/` and `reversed/` preserve every raw result, console log, power journal
and run context as lossless gzip files, with SHA-256 digests and verified
decompression. Compression also preserves exact bytes across Git line-ending
settings. Data is synthetic and was scanned for common credential patterns;
no company documents or real provider responses are included. No paid model
calls were made, and no other agent's branch was modified.
