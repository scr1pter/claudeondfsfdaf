# Free validation history

The initial 31-file draft was independently authored and published before runtime qualification. Only 41 pure controls had run; Bun, installation, servers, browsers, builds and typechecks were explicitly deferred. No final freeze was created. That historical state is superseded by `VALIDATION.md` and `QUALIFICATION-v1.json`.

Production candidate `a35c03d6a9bb16f16ec0187ad69c6c6420d10f19` was frozen before final task qualification/review. The task author did not inspect candidate source, paid coding outputs/reports or optimization hypotheses. The private reference is a synthetic calibration control, never a production candidate or study submission. The v1 seed retains direct-send behavior and contains no reference upgrade.

All earlier free attempts are retained in private evidence directory `outbox-qualification-20261102T024945Z`:

| Attempt | Result and interpretation |
| --- | --- |
| Seed negative 1 | Superseded product-failure report: proxy-only Chrome background denials were wrongly attributed to the app. Attribution was repaired and given positive/negative pure controls. |
| Seed negative 2 | Superseded product-failure report: transient owned-profile locks were wrongly reported as app I/O failures. Cleanup is now atomically owned, bounded and correctly classified. Four exact owned temporary leftovers were later removed; unrelated paths/processes were untouched. |
| Seed negative 3 | Explicit instrumentation failure; eight browser rows not run. Native lookup depended on the virtual evaluation home. Allowlisted Windows user-token path expansion replaced it. This attempt is not a browser pass. |
| Seed negative 4 | Valid earlier projection: 4 passed, 22 failed, all 26 executed. Later superseded by Unicode/verbatim clarification and final projection binding. |
| Reference positive 1 and 2 | 26 passed each on valid earlier projections; retained rather than relabelled as final-byte evidence. |

Review removed hidden constraints: generated admission IDs fit the maximum; ticket order is free; recovery may remain queued/sending/retryable; app-chosen stable error text is shown verbatim; no English error-word or attempt-label regex is required. Malformed/truncated app HTTP is product failure, while trusted-driver/control faults and evaluator I/O are instrumentation failures. Concurrent drains have a client-write barrier while the first provider request is held. Legitimate final freezing no longer makes lifecycle controls fail.

The final runtime projection has a real 26/26 positive, complete 4-pass/22-failure v1 negative, and five real semantic mutants rejected in intended groups without instrumentation errors. Protected-provider controls include Unicode limits, verbatim body text, idempotent effects, cancellation, lost responses and hard-stop durability. No cloud/model calls or provider credentials were involved.

The actual planned envelope raw browser profile subsequently passed its complete reference gate 26/26 with unchanged source and instrument bytes. Its separate raw-byte evidence and the line-ending-only variant comparison remain retained. Earlier controls prove only their own scope; runtime qualification does not substitute for final independent approval, the versioned byte freeze or committed-byte checks.
