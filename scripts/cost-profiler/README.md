# Receipt cost profiler

A standard-library Python CLI for closed Codex/Vector benchmark arms. It never
calls a provider or changes native state. Use an external output directory.

```powershell
python profile.py --run-dir C:/private/closed-pair --receipts C:/private/round/receipts.jsonl --output C:/audit/projection.json
python -m unittest -v
```

Run these commands from this directory. `--run-dir` accepts an arm directory
containing `witness-audit.jsonl`, or a pair directory containing `codex` and/or
`vector` arm directories. It is repeatable. An arm must contain an
`owned_scope_closed` witness record. `--provisional` explicitly permits snapshots
before closure; these cannot support a final comparison or savings claim. A
closure marker with incomplete terminal/receipt reconciliation also forces a
provisional result. The recorded closure amount is checked with an explicit
one-trillionth-dollar tolerance for serialized binary-float rounding.

Each arm's `arm_bound` record scopes the receipt ledger by exact actor, label,
and batch hash. Every scoped receipt is retained, including failed, cancelled,
unmatched, and missing-price records. `measuredUsd` on the actual receipt is the
authoritative amount. Decimal arithmetic preserves recorded amounts. Unknown
amounts remain unknown; `knownMeasuredUsd` is not a complete total when
`measuredUsdComplete` is false. Receipt sequences must be unique.

Witness records reconcile receipts by exact request SHA and registered receipt
sequence, or by exact SHA and a bounded receipt start time. Native records join
only by exact role and input/output/total usage plus a bounded request interval.
Codex additionally uses the hashed native identity and exact response ID where
available. Candidate edges must be unique in both directions. Repeated hashes
and equal usage vectors never justify a greedy match. The default completion
slack is five seconds; changing `--time-slack-ms` is a sensitivity analysis, not
permission to force coverage. Vector native lifetimes include tool execution;
the provider interval must fit inside that lifetime with the stated slack, rather
than requiring the provider to finish near the end of a long tool. Native dollar
fields never affect a join.

The Codex adapter reads only `id, agent_role` from native `state_*.sqlite` with
SQLite `mode=ro` and `PRAGMA query_only=ON`, plus native rollout metadata and tool
records. It does not inspect logs, memories, controller configuration, or source
files. `token_usage_record` counts responses; repeated `token_count` snapshots
are not additional requests. A response's `thread_id` supplies its actual owner
when fork histories contain inherited parent session metadata; inherited tool
calls from other turns are excluded. The Vector adapter verifies exported transcript
files against their manifest before reading assistant step-finish/tool metadata.

The projection publishes local charge indexes, roles, aggregate costs, counts,
and conservative tool categories. It omits native IDs, hashes, machine paths,
prompts, tool arguments, and tool outputs. A whole mixed turn is explicitly
heuristic. Shell execution is not automatically labelled verification or
read-only, and literal calls inside a code wrapper are separate heuristic hints.

Timeout diagnostics distinguish actual `task_manage.wait` calls whose parsed
result has `timedOut: true` from ordinary waits, then count immediate same-role
followups and consecutive timed-out wait-only turns. These observations can
motivate a future experiment preserving independent work, user steering, and
verification. Duplicate serialized input items, repeated request bytes, repeated
read inputs, and repeated tool outputs are also observations: their necessity
is not established by repetition alone. The profiler does not subtract QA,
assume avoidable dollars, judge current provider prices, or claim paired quality
or efficiency results.
