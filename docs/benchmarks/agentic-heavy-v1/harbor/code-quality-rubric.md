# Blinded source review

Score each dimension 0–6, total 48. Use the same blinded reviewer and full source
snapshot for both arms. Cite concrete files/behavior and separate observed defects
from hypotheses. Functional acceptance is a prerequisite for an equivalence claim,
not a substitute for this review. A prototype is not production readiness.

| Dimension | Evidence for a strong score |
| --- | --- |
| Durable state and recovery | Transactions preserve transitions, crash recovery is explicit, completed effects cannot repeat, audit/log history remains intact. |
| Concurrency and queue ownership | One worker admission boundary enforces global capacity; idempotency, dependency and cancellation races have clear ownership. |
| Domain model and validation | Status/revision invariants are readable; malformed DAGs and cross-project references are rejected atomically. |
| HTTP and permission boundaries | Server checks actor roles/session state; resource errors and protected fields are consistent; artifact paths are owned. |
| Connected product behavior | Runbook snapshots, approvals, jobs, active releases, rollback and incidents retain correct relationships throughout their lifecycles. |
| Frontend state and accessibility | Real API data drives the UI; loading/conflict/error states preserve user input; forms, keyboard controls and responsive details are usable. |
| Structure and maintainability | Modules/functions reflect meaningful boundaries without needless abstractions; types describe persisted state and invalid transitions are hard to introduce. |
| Verification and clarity | Checks exercise real behavior and important failure paths; names and concise comments explain invariants; delivery includes useful local verification evidence. |

Anchors: 0 absent/broken; 1 severe gaps; 2 fragile prototype; 3 adequate with
material limitations; 4 solid with localized issues; 5 strong and clear; 6 unusually
complete, coherent and well supported for this bounded task. Do not reward line
count, agent count, token spending, a particular framework pattern or cosmetic
test volume. Review model/controller telemetry separately from application source.
