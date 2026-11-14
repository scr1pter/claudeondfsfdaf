# Prospective headless startup mode

This is an optional operational mode for a future, separately frozen plan. It
does not change the frozen R2 source, study results, model, reasoning, context,
tools, image availability, role graph, price schedule or financial authorization.

The default `maximum-request` startup gate still requires enough global and
actor headroom for the unchanged USD5.73 maximum possible single request. This
startup check does not itself reserve or spend money. UI behavior stays on that
default gate.

A future headless seven-role plan may explicitly select
`--startup-affordability-mode per-request`. Startup then requires finite positive
global and actor headroom. This is recorded in the plan and arm preflight. Actual
reservation is deferred to the existing before-upstream gate, which computes
the same conservative bound for the exact normalized input and requested output.
No request body, model setting, context, image, output ceiling, rate or financial
hold is reduced to make a request fit. Every forward still requires its complete
bound before any provider work. Missing or uncertain accounting still fails
closed. No arm, next arm or next task starts automatically.

Synthetic controls exercise both runtimes with USD1.50 headroom: default startup
refuses, opt-in startup accepts, an adequate text request passes the real owned
admission gate, and larger text or USD5.73 image bounds are refused before the
provider callback can run. Zero, negative, NaN and unreviewed modes are refused.
History and both unknown liabilities are unchanged. The new coordinator control
also proves this mode cannot apply to UI or non-seven-role profiles.

Before any funded use, the operator reviews the exact new source and frozen
plan within the owner's already authorized USD20 cap, and qualifies the changed
instrument with actual native fake-provider runs. This does not require new
owner permission; only a funding increase would require additional authorization.
Those native/runtime checks have **not** been run for this prospective change.
Inherited qualification evidence belongs to its original earlier instrument.

All new checks are Python-only synthetic fixtures. They make no provider or
live controller call, read no key and launch no Bun, Chrome or native coding CLI.
Run from this directory: `python -B -m unittest -q test_startup.py test_carry.py`.
