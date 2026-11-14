# Windows Stop: immutable timeout-phase diagnostic

This is a diagnostic candidate, not a Stop fix or a native acceptance result. It follows the `f830e3fdf` Windows helper job [132558654772](https://github.com/scr1pter/claudeondfsfdaf/actions/runs/43631024090/job/132558654772).

## Observed failure

The staged isolated overlay reports `native_failure`, stage `stop-root-retired`, cause `core_failure:no_ui_tree`, exit 1. This happens during the first UIA root observation, before any attempted pointer input. The caller's 50 ms ticket can include worker scheduling, COM/UIA setup, target/provider lookup and security checks. The existing result cannot identify which phase was observed when that ticket expired. Actor retirement alone does not establish the root cause.

The relevant UIA, overlay-driver and Electron fixture files are unchanged between the previously passing `a0e5ce8e` baseline and `f830e3fdf`. The fixture already forces renderer accessibility at launch, enables accessibility before constructing the target and awaits overlay readiness before reading actual Stop geometry. There is no evidence here of a signer, privilege or geometry bypass, nor evidence supporting one particular provider/setup cause.

## Candidate behavior

When the caller or worker first records deadline expiry, an optional diagnostic now samples the last observed closed UIA phase before replacing it with `actor_expired` or `actor_com_expired`. Sampling on both sides prevents a worker's earlier expiry marker from erasing the useful phase before the caller wakes. An atomic first-write rule prevents late work or a later timeout from replacing that snapshot. The existing cancellation/quarantine is unchanged. A retired actor may refine the existing failure stage only from this immutable sample; without a sample it retains the old retired classification. Healthy-actor diagnostics continue reading their live phase.

Pre-push peer review found a sentinel collision in the initial candidate: `none` was both the initial empty state and a valid unknown sample, so sampling `none` first could let a later sample overwrite it. The corrected encoding reserves integer zero only for unobserved and stores every sampled phase as its index plus one in a lock-free atomic. A first unknown sample is therefore immutable too. Decoding refuses values outside the existing finite phase table. Pure native regressions cover first `none` and an invalid phase followed by provider progress; neither may become a fabricated provider stage.

The sample is an observation at timeout, not proof that the sampled operation caused the delay. A sampled completion phase cannot admit a late result. Original exceptions, failure status, exit codes, 50 ms deadlines, cancellation, retirement, actor bounds, input receipts and all target/identity/geometry checks are unchanged. No retry, replacement actor, provider operation, UI text, native identifier or user content is added. Existing finite stage names are reused; the wire format does not expand.

Pure native cases cover queue/setup/provider samples, absence of a snapshot, late worker progress, repeated timeouts and unchanged failure/skip/exit classification. Source checks assert that sampling precedes cancellation and that the original deadline/quarantine remain. Native compilation and execution belong to CI; no local native, browser or owner input is authorized by this change.

## Provenance and required qualification

The helper version advances from `1.0.15` to `1.0.16` because native sources change. The existing measured Mac lock remains **enforced and untouched at 1.0.15**. The shared identity input changes the Mac source digest and generated binary version, so the old source digest/CDHashes must not be copied or treated as 1.0.16 evidence. A Mac build is expected to stop at that lock mismatch and emit `identity.lock.computed.json`; only actual qualified CI artifacts with exact revision, toolchain, architecture, digest and self-test provenance may support a separately reviewed lock update. No hash is invented here.

Windows likewise needs new exact-source builds, native units, isolated Stop and final x64/ARM64 package/Main-pin verification. Mac needs its exact-source measured lock, final packaged verifiers and seal checks. Prior 1.0.15 receipts remain scoped to that baseline. Signing, notarization, owner-device grants and publication remain separate gates. If the next Stop run succeeds, that alone does not prove this diagnostic changed runtime reliability.

## Existing CI measurement procedure for review

The existing `.github/workflows/computer-helper.yml` workflow can collect the candidate without changing the lock. Dispatch the pushed exact candidate revision with `helper-channel=prod`, `reuse-artifacts=false`, a unique revision-bound `artifact-suffix`, `full-desktop-e2e=false`, `isolated-desktop=false`, `privileged-required=false`, `windows-only=false` and `linux-only=false`. The workflow has no Mac-only selector; those values also run its ordinary Windows jobs. This measurement pass asks for no owner OS grants and does not publish a release. It uses the builder's existing ad-hoc CI identity, not Developer ID/notarization credentials.

Its `mac-build` job runs on `macos-15`, explicitly requires `/Applications/Xcode_16.4.app/Contents/Developer`, and records the actual Xcode/Swift versions. From `packages/desktop`, the existing ordered steps are:

1. Build twice with `bun --no-env-file ./scripts/build-computer-helper.ts --platform darwin --arch universal --channel "$VECTOR_CHANNEL" --out native/out/darwin` and the identical command with `--out native/out/darwin-repro`.
2. Require identical manifests and every shipping file's SHA-256 across both builds.
3. Run `bun --no-env-file ./scripts/computer-helper-selftest-node.ts --platform darwin --bin native/out/darwin/VectorComputer.app/Contents/MacOS/VectorComputer --tests native/out/darwin/tests --privileged off --report "$RUNNER_TEMP/computer-darwin-core.json"`.
4. Only after those prerequisites succeed, the existing `Enforce the measured production identity lock` step sets `VECTOR_COMPUTER_HELPER_PREBUILT=true` and runs `bun --no-env-file ./scripts/build-computer-helper.ts --platform darwin --arch universal --channel "$VECTOR_CHANNEL" --out native/out/darwin --check-lock`. It measures both real slice CDHashes and the actual source/toolchain identity. The old enforced lock should reject 1.0.16. This expected rejection is not a passing job.
5. The existing always-upload step preserves `native/out/darwin/identity.lock.computed.json` as `computer-helper-darwin-lock-candidate-<suffix>`, plus `computer-helper-darwin-reports-<suffix>`. Record exact workflow run, attempt, head, job, artifact ids and archive digests; inspect actual logs for the two-build comparison and required native checks. A candidate artifact by itself is insufficient if those prerequisites failed.

Only after reviewing that real provenance may the measured JSON be committed with `enforce:true`. The lock itself is excluded from the source digest; no other measured Mac source/build input may change between measurement and that pin commit. A fresh exact-head workflow must then pass the lock and downstream Mac matrix checks. Final packaged verifiers and unsigned artifacts-only preview remain later qualification, distinct from this initial measurement. Nothing in this procedure authorizes production signing, notarization, owner-device operations or publication.

## Local validation

Windows, Bun 1.3.14, coordinated exclusive Bun slot. At initial `8e792a72d`, from `packages/desktop`, `bun --no-env-file test --timeout 30000 ./scripts/computer-overlay-smoke-source.test.ts ./scripts/computer-overlay-smoke-report.test.ts` exited 0: **64 tests passed, 28,398 assertions, zero failures or skips**, 2.54 seconds. After the pre-push sentinel correction, that same command passed **64 tests, 28,402 assertions, zero failures or skips**, 1.54 seconds. The corrected source-wiring regression passed. This existing source suite compiles small synthetic JavaScript fixtures to inspect compiler metadata; it does not build or run a native helper, product desktop bundle or smoke app. `bun run typecheck` from the same package exited 0 after both revisions. Formatting and `git diff --check` passed.

The added C++ native test group has not been compiled or executed locally. No native/browser/input, owner application, signing or packaging operation ran. The Mac lock has no diff and remains enforced. Native Stop remains an unresolved failure until exact-source CI supplies new evidence; these passing source/type checks do not qualify it.
