# Production UI scenario completion

Source: `02098b2b6d971b5346bdd368e95236d8d2d939dc`, Windows x64, Bun 1.3.14,
Node 24.22.0, pinned Playwright Chromium Headless Shell 1217.
This is a single functional completion run with synthetic API fixtures, not a
before/after performance study, real-model evaluation or native desktop acceptance.
The machine reported battery power before the run. Trace capture was enabled.
Do not use these timings as a speed improvement claim.

From `packages/app`, with `VECTOR_PERFORMANCE=1`, an explicit run ID and trace
directory, and `PLAYWRIGHT_PORT`, `PLAYWRIGHT_SERVER_PORT` and
`PLAYWRIGHT_BASE_URL` targeting the isolated port 4487:

```text
bun x --no-install playwright test --config e2e/performance/playwright.config.ts timeline/first-navigation-benchmark.spec.ts --project chromium --workers 1 --repeat-each 1 --retries 0
```

The existing configuration built the production app and started its own preview
server. It did not reuse or restart a user's app or engine. The run exited 0:
**3 passed, 0 failed**, with zero blank or unknown samples in each scenario.
It covered first navigation to another conversation, the new-conversation lazy
module, and child-agent conversation navigation. The existing assertions were
unchanged.

The first attempt failed all three cases before application setup because the
pinned browser executable was absent. Installing that exact headless browser,
with browser garbage collection disabled to preserve other installations, was
the only change before the successful retry. This does not attribute that
environment failure to application code.

`metrics.json` preserves all emitted metric records. The three `*.trace.json.gz`
files and `console.log.gz` are lossless copies of the raw synthetic diagnostic
captures; `artifacts.json` records sizes and SHA-256 digests. Decompression was
verified byte-for-byte. These captures contain local test URLs and synthetic
content, and were checked for common credential patterns before publication.
They contain no company documents or real provider responses. Decompress a trace
before loading it in Chrome's Performance panel.

Remaining qualification: a matched baseline/candidate run on stable AC power,
exact-candidate CI, and authenticated native Windows and Mac release-candidate
acceptance. This run clears none of those separate gates.
