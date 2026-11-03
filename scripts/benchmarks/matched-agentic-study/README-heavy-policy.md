# Separately labelled heavy native-team policy

This profile is an instrument change for the heavy workflow study. It does not
change the frozen product candidate, previous four-identity evidence, old
funding phase or existing default APIs. No code here starts a funded service.

The fixed graph has seven autonomous identities and six immutable child slots:

```text
lead
  backend_coordinator
    backend_api
    backend_data
  frontend_worker
  qa_specialist
  team_judge
```

All seven use `gpt-6.1-sol`, High effort, auto summary and low verbosity, with
the existing 1,050,000 context limit and 32,000 output ceiling. The lead and
backend coordinator retain delegation declarations. Every other role has those
declarations removed while ordinary tools, custom grammars and message content
remain unchanged. The native inference gate enforces each exact parent edge:
the coordinator must already have an admitted immutable identity before either
backend child can infer. It refuses substitutions, extra roles, depth three,
cross-root ancestry, cycles and changes to ancestors' model/role facts. Same-ID
follow-ups are allowed; they never create another lifetime role slot.

The registry walks actual persisted ancestry to the owned root, verifying every
native edge and model selection. Codex's persisted declared depths must match
the chain; Vector's depth is calculated from native parent rows. Descendant
collection remains recursive and retains attempted/refused identities. A known,
tool-free generation helper attached to an admitted grandchild is separately
bounded and fully charged; it does not become an extra autonomous specialist.

The default profile still means one lead plus three direct children, depth one.
To select the heavy graph explicitly:

```python
registry = NativeRegistry(..., max_depth=2)
supervisor = OwnedSupervisor(..., funding_profile="heavy-matched-teams-high-v1")
arm = supervisor.begin(runtime, label, registry, HEAVY_ROLES,
                       role_parents=HEAVY_ROLE_PARENTS)
```

`HEAVY_ROLES` and `HEAVY_ROLE_PARENTS` are exported by `role_graph.py`. Native
adapter smoke and actual task-quality gates are separate requirements; synthetic
native fixtures are not evidence of task performance or cost savings.

## Explicit approved remaining allocation

`funding_profiles.py` contains a closed selection of two profiles. Omitting
`funding_profile` preserves the original phase and both cumulative $20 actor
caps. The explicit heavy profile pins phase `heavy-matched-teams-high-v1`,
unchanged global $48, cumulative Vector $24.73654725 and Codex $20.31968465,
request history at least 889 and total history at least $20.3038291. Its approved
phase plan SHA256 is
`5f75ba025ae3d4f3cde51b4d85586df63fee00e76fdcc300dc1ecd530a0e4c6e`.

These cumulative caps retain the exact prior charges and allocate the remaining
$27.6961709 equally: $13.84808545 per runtime. Historical actors remain sealed
at their existing $2.9437681 total. The witness checks the plan hash, caps,
historical floors, sealed actors and reconciliation of global/actor totals at
each funding-state check. Selecting an arbitrary phase or expanding any cap is
refused. No prior charge is reset or reclassified.

Every forwarded request, including native helpers, worker follow-ups and judge
calls, remains charged to its runtime. The 300-request/two-hour bound and one
formal same-lead repair remain. The $3 threshold gates a new formal repair only
after the current attempt and HTTP handlers settle; it does not interrupt an
attempt halfway through. Per-call reservation and approved actor/global caps
still apply. Unknown usage, transport, ancestry or closure is review, never a
free or passing task.

## Free verification

Run `python -m unittest discover -p "test_*.py" -v` here with the explicitly
reviewed `VECTOR_BENCH_METER_SOURCE` setting described in the base README. The
new heavy controls use synthetic native SQLite records and owned loopback fake
meters only. They start no Bun, coding CLI, browser, live controller or provider
connection. The original four-role controls remain in the same complete suite.
