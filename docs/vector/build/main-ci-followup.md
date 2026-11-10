# Main CI follow-up

Source baseline: `0dcbb8e2d1cc01d22d4b98695d651430f10f1d2c` (PR #20 merge).

The exact-main [test run 42515544563](https://github.com/scr1pter/claudeondfsfdaf/actions/runs/42515544563)
passed 19 required jobs and failed two; three optional jobs were skipped. These
changes address the three failing cases without changing product behavior.

## Findings and fixture changes

- [Linux engine shard 1, job 128837628648](https://github.com/scr1pter/claudeondfsfdaf/actions/runs/42515544563/job/128837628648):
  the isolated-helper terminal case read a counter as zero after polling had
  already observed at least three. The case failed after 3.32 seconds, before its
  polling budget could have elapsed. The fixture used `echo > file`, which exposes
  an empty file between truncation and writing. Counter samples now replace the
  previous file atomically. The assertions still require the helper's programs to
  terminate, the parent's program to remain alive, and the saved files to stop
  changing and match Git's snapshot.
- [Windows engine shard 1, job 128837628888](https://github.com/scr1pter/claudeondfsfdaf/actions/runs/42515544563/job/128837628888):
  the changed-server-identity case received `unreachable` instead of `changed`.
  The identity reader fails closed when its production 400 ms loopback discovery
  deadline expires. This case tests identity changes through real local sockets,
  so its explicit probe and verification now use a bounded 5-second fixture
  budget. Production deadlines are unchanged; the Core probe tests separately
  exercise expired identity reads and refusal to send prompts. The log does not
  establish which individual read missed its deadline.
- The same Windows job timed out after 60 seconds in the background-report
  permission case. That fixture holds the child's model stream until the parent's
  turn finishes. A local model defaults to one permit: if the child takes it
  before the parent's final request, each waits for the other. Only this fixture
  now configures two model permits, so the held child stream cannot block the
  parent's completion. All permission, provenance and no-network-leak assertions
  remain intact.

## Validation

Focused Linux checks used Bun 1.3.14, the serialized workload wrapper, a fresh set
of all four XDG directories per invocation, and `--timeout 30000`:

- The two affected `local-run.test.ts` cases passed: 9 assertions, 15.18 seconds.
- Both `isolation-terminal.test.ts` cases passed: 29 assertions, 18.18 seconds.
- A separate baseline control temporarily restored the background fixture's
  single permit with a 20-second case deadline. It also passed locally in 9.96
  seconds overall. Thus the scheduling-dependent Windows timeout was **not
  reproduced locally**, and no red/green reproduction is claimed. The final
  source was restored byte-for-byte after that control.
- `git diff --check` passed. The parent agent independently reviewed the two-file
  diff. No production source changed.

These are four passing focused cases with 38 assertions, not a full-suite result.
Native Windows CI and the mandatory pre-push package checks remain required for
this checkpoint; the original main workflow remains failed.
