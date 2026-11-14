# Release evidence observer

This read-only tool reconciles branch ancestry, draft PRs and exact-head GitHub
checks while feature agents keep working. It does not merge a branch, edit a
feature, dispatch or cancel CI, enable a service, approve a policy or publish a
release. It never calls a model or requests a provider credential.

Python 3.12 and Git with `--no-lazy-fetch` support (verified with Git 2.56)
are sufficient; there are no package dependencies. Missing objects in a
partial clone stay unknown instead of silently fetching during offline reads.

## Collect evidence

From the repository root, inspect cached local tracking refs without networking:

```text
python -B scripts/release-readiness/observer.py --policy scripts/release-readiness/policy-199113.json
```

To explicitly refresh all branch heads and read public GitHub metadata:

```text
python -B scripts/release-readiness/observer.py --fetch --github --policy scripts/release-readiness/policy-199113.json --output release-snapshot.json
```

Use `--format markdown` for the same snapshot as a readable table. `--repo`
selects another checkout and `--remote` selects its remote. Network operations
are opt-in. Fetch updates remote-tracking metadata only; it never pulls or
changes the checked-out branch. Public GitHub HTTPS remotes need no credential.
SSH, credential-bearing URLs and private authenticated APIs are intentionally
unsupported. A permission error or rate limit produces unknown metadata rather
than an invented successful check. Keep generated snapshots in a deliberate
evidence location rather than committing arbitrary logs or environment data.

## Interpret the result

- The default inventory is only the locally known refs. Configured fetch
  refspecs can hide branches; online collection uses the complete remote-head
  inventory instead of assuming the local list is complete.
- Shallow or unavailable history leaves nonidentical-head ancestry unknown;
  collecting refs does not silently deepen the checkout.
- Each source head is pinned. Required checks must match that head. A queued,
  skipped, neutral, cancelled, missing or inaccessible check is not passed.
- A branch can have merged source without a published release. Draft PRs remain
  unfinished work, and this tool never marks them ready or merges them.
- Heads are checked again after collection. A moving head supersedes that
  observation; incomplete data remains explicit. Inspect timestamps and
  consistency flags before using a saved snapshot.
- The policy's 28 common CI contexts are a reviewed observation list, not a
  substitute for branch protection, platform acceptance, generated-client
  checks, artifact identity or the protected publication workflow. Unknown
  lane-specific required-check policies stay unknown.
- Legal, owner, native-device, service and spending decisions remain external
  and unapproved in the output. No completion percentage or live-agent count is
  inferred. `releaseApproval` always says `not_assessed`.

Exit 0 means the snapshot was generated, **not** that the release is ready.
Failed and unknown checks may be present in a valid snapshot. Exit 1 means an
observation or policy could not be generated; argparse uses exit 2 for invalid
command-line arguments.

The checked-in `policy-199113.json` preserves the existing release boundary:
the merged runtime is included; Hands, Codium, `@vector`, Vectorscope upgrades
and cloud workspaces retain their separate launch/acceptance tracks. Keep
implementation ownership with the agents already working on those lanes.
The newly observed `process-finish` follow-up is explicitly mapped with unknown
.113 inclusion; a new branch is not automatic release scope.

The dated [integration hand-off](../../docs/vector/build/release-integration-2026-11-09.md)
records object-only pairwise conflicts and local validation. These simulations
never modify a branch, resolve its conflicts or qualify its behavior.

## Free tests

From this directory:

```text
python -B -m unittest test_observer.py
```

Tests use synthetic API responses and isolated temporary Git repositories.
They do not access GitHub, model providers, credentials or live workflows.

The owner-review and platform acceptance packet lives in
`docs/vector/owner-actions/release-199113.md`; the current and historical
integration record is `docs/vector/build/multiagent-merge-plan.md`.

## Local UI comparison

`compare_ui.py` is a separate Windows-only, provider-free measurement runner.
It uses this toolkit checkout's first-navigation harness against two explicitly
chosen production build roots, serially, with power journals and raw results.
`compare-ui.playwright.config.ts` disables server reuse through the inherited
production configuration. It starts only its own isolated preview server.

Install frozen dependencies in the toolkit and both build roots; put the
recorded Bun and Node versions on PATH. Use a fresh output directory and AC
power. See the [recorded comparison and commands](../../docs/vector/build/evidence/ui-comparison-ac-2026-11-09/README.md).
`--order candidate-first` supports the reverse-order batch. The runner verifies
scenario-repeat identities, preserves logs and cleans up its own test process
tree on abnormal exit. Exit 0 qualifies completion and sampled AC state only;
it is not a speed, model-quality or release certificate.
