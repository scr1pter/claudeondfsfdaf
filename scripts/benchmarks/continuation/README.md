# Missing Codex arm: explicit, reviewed continuation

`codex_arm.py` is a separate recovery helper outside the frozen matched-team
instrument. Its default is **plan only**. It reads the explicitly named original
plan and result evidence, public source, frozen instruments and runtime hashes.
It does not read a controller capability or receipt ledger, contact a gateway,
start a runtime/browser or invoke a model until `--run` is explicit and the
continuation plan and digest match.

This helper is closed to the original heavy Foundry pair plan
`b84c72848d9fea3d33e7fce8f3e1121938be1e8d5e53cc8023497060935f8857`
and product source `479303cf229badc0fa2c770f27d7d845dfa4fa68`. It validates
the original result, closure and audit hashes and both identical 39-file saved
Vector snapshots. Vector used 300 requests / $6.7876388 and remains a product
failure with native execution review required. Its original result and every
review flag remain intact. The original Codex result must still be exactly
`not_run_after_prior_arm_review`, and its original runtime directory must not
exist.

The only new admission is `foundry-codex`, with the original fixed seven native
identities, nested role graph, Sol/High/auto/low, context/output/image capability,
300-request/two-hour limit and at most one same-lead repair. The settled repair
threshold remains $13.84808545, and the actual cumulative actor/global limits
remain $20.31968465/$48. No Vector rerun, extra actor, cap expansion, source
change or automatic next pair is supported. All calls and repairs are billed.

Immediately before admission the actual ledger must be idle, not halted, have
zero active/reserved/open calls and exactly 1,189 historical requests. Its
unchanged expected usage is $27.0914679 global, $17.6761006 Vector and
$6.4715992 Codex, allowing only the existing $0.00000001 accumulation tolerance.
A new call, changed actor history or uncertain closure blocks admission. The
wrapper permits only one mutation admission and never retries its ambiguous
outcome. The real gateway's unchanged reservation checks and limits still
apply to every provider request.

An optional navigation checker correction requires **all three** explicit flags:
`--evaluation-overlay DIR --overlay-manifest FILE --expected-overlay-sha SHA`.
The manifest is a reviewed complete `relative/path -> SHA256` JSON map and its
SHA is the canonical JSON digest. The overlay must contain exactly the base
task files plus the explicitly whitelisted overlay provenance, helper diff,
navigation control, pure controls, byte-restoration/qualification tools and overlay
documentation; the only changed original file is
`instrument/browser-eval.cjs`. Prompt, seed, task.json, wrapper and every other
original byte (including original provenance and qualification) must remain unchanged. The immutable evaluator command's
`{task}` is bound to that separately frozen overlay. The continuation plan and
summary label the evaluation version and retain the original Vector feedback
confound: its repair received the original checker's false navigation failures.
Any unchanged-source Vector re-evaluation is a separate free operation, not
permission to rerun the Vector model or rewrite the original result.

Create a new private continuation plan outside every input/output tree:

```powershell
python codex_arm.py --original-plan <original-private-pair>/plan.json `
  --team-runner-root <unchanged-reviewed-matched-agentic-study> `
  --out <new-private-codex-output> --write-plan <new-private-reviewed-plan.json>
```

After independent review, use the same arguments and optional overlay inputs,
adding:

```powershell
--run --reviewed-plan <reviewed-plan.json> --expected-continuation-sha <printed-SHA> `
  --controller-config <existing-private-local-controller.json> `
  --receipt-jsonl <existing-private-authoritative-receipts.jsonl>
```

The helper reuses the **unchanged** `NativeAdapter`, `coordinate_team_arm`,
`OwnedSupervisor` and frozen independent evaluator. Its own output is new;
original files are read only. Output summaries retain the original Vector arm
verbatim and attach the new Codex arm separately. Even a passing Codex result
cannot mark the original pair complete, waive Vector review or establish a
quality/efficiency win. Blinded 48-point code review remains pending.

Pure controls (no private evidence, controller, native runtimes or browser):

```powershell
python -m unittest test_codex_arm -v
```

All runtime outputs, plans containing local paths, receipts, native transcripts,
capabilities and screenshots remain private and must never enter Git.
