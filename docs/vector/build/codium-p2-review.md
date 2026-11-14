# Codium P2 source review

Reviewed on 29 October 2026 against the committed Codium build contract and the
owner decisions in `codium-tiers-v3-changes.md`. This is a source/test checkpoint,
not provider acceptance, a deployment or permission to enable sales.

## Scope and integration

The review covers A09–A14 from inherited P1 base `591cd1f0`: plan changes and
consent, risk and allowance ramps, runtime switches and funding, owner controls,
signed spend callbacks, and Stripe setup/configuration. Per-package notes retain
their focused and real-Valkey results.

Clean integration `9ccc9372` combines A14 `615855fb` with exact approved main
`dfc98974329f17c6814a923ac12ebe38b6673f38`. The sole conflict was the context
fixture's tool list. It now reads the actual browser tool description in place
of the removed search tool. No generated client was edited manually. The merge
preserves main's release, privacy, first-launch and agent-environment changes.
It changes no separately owned cloud-agent implementation.

The integration passed 72 focused checks across context, owner, account status,
retired top-up behavior and model-plan policy files, plus API and web typechecks.
The initial owner run skipped its optional Valkey case; the later complete
repair batch exercised that case against local Valkey.

## Review results

The financial/security/cost review found no remaining confirmed blocker in
carry provenance and late-debit accounting, deferred/versioned liability,
collection ownership and held-invoice recovery, funding timestamp bounds,
Google owner authorization, immutable refund targets, spend escalation or
setup ownership checks.

The contract/test review found two omissions, fixed separately at `f920f1dd`:
the explicit payment-method portal flow and complete billing-readiness projection
on the owner dashboard. A14's CI also identified four required historical Stripe
identity comparisons caught by the current-name scan. Its repair permits only
those exact file/line matches, requires each once, and retains negative checks
for current offers and reuse elsewhere. See [the repair record](codium-p2-repairs.md).

Both reviewers rechecked these changes and closed their reported findings. One
contract reviewer had authored A11 funding, the A12 frontend, A14 configuration/
economics and the narrow name-guard repair. Those portions received corroborating
contract checks here. The separate financial/security review was independent of
their implementation; review independence varied by file.

The repair batch passed 116 tests across four files, including actual HTTP
request handling and the owner intent's real-Valkey case. API and web checks
passed; the web check reported zero errors and zero warnings. All local workloads
ran serially and the temporary Valkey was stopped.

Five implemented billing crons remain installed. Seven future service schedules
are explicitly gated until their corresponding routes exist, preserving the
repository's no-missing-cron rule while later work packages are built.

## Remaining gates

After this record the full pre-push check passed, the canonical source was
pushed, and the phase CI ran on the exact repaired source `4539d83b`: scoped
run 40810014805 and full general run 40810044741 both succeeded, the latter with
all 15 jobs including the Linux and Windows browser suites.

Protected provider acceptance still requires the owner's test environment and
authorization. Stripe acceptance of the 3-D Secure request fields and actual
setup operations, OpenRouter management behavior, and Vercel's live callback
delivery were not exercised against real services. A60's legal, configuration,
release and go-live gates remain outstanding. No production account setting,
key, credit purchase, deployment or sales switch changed during this review.
