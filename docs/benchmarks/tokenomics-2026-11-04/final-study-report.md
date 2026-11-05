# Tokenomics study: final engineering and operations report

All paid work in this round is closed. The key-holding gateway exited after
active requests, current reservations and available batch calls reached zero.
Its listener is absent and the financial journal hashes are unchanged through
shutdown. No additional API inference was used for the final accounting fixes.

## Measured outcomes

| Cohort | Vector API cost | Codex API cost | Interpretation |
| --- | ---: | ---: | --- |
| Three custom single-agent tasks | $2.0209317 | $2.1275694 | 5.0% lower aggregate recorded cost; both 76/76 checks; Vector no lower task review total. Two development replications, one held-out task, one trial each. |
| Relay nested-team build | $6.6391490 | $4.6033534 | Both final snapshots 53/54; original Vector gate not run. Vector higher static-review totals but lower on two dimensions in one review. No matching-quality savings claim. |
| LedgerDesk maintenance | $1.4211116 | $2.3666455 | Both snapshots 53/54, with different check provenance. Actual lifecycle Vector 5 roles versus Codex 7; Vector QA/judge never started and static reviews were lower. No completed-team efficiency comparison. |

All costs use recorded provider usage at the study schedule, not invoices or
subscription prices. The studies are not pooled into a larger performance
claim. The strong three-task result does not establish universal savings,
statistical significance, production reliability or billion-token performance.

The failed Relay assertion was 403 versus expected 401 for a bootstrap credential;
both products denied access. The failed LedgerDesk assertion was 404 versus
expected 400 for a nonexistent account in a key scope; both rejected it. Separate
free probes isolated these differences without changing original results.

Two independent source reviewers locked each pair's scores before runtime
mapping or results disclosure. Their original findings and familiarity limits
are retained. A separate post-run Relay journal-loss probe confirmed the
generated Vector app refused all three damaged-state startups; the generated
Codex app restarted with lost acknowledged state. This does not add acceptance
points or turn a post-run observation into a preregistered benchmark.

## Product changes

The final product source is `89525f448be3d2c650af528b1328d210e822d149`, incorporating:

- `1a3d07c`: context-summary calls now reach the existing budget guard, including
  known, unknown and interrupted usage and the original launching run.
- `94c27c6`: completed calls retain their guard charge through cancellation,
  with interruptible verification and the original interruption preserved.
- `89525f4`: failures before guard-recording entry retain one financial charge;
  failures after entry are not retried because the charge may already exist.

Models, reasoning, context, output allowance, tool access and verification
requirements were not reduced. No new model call, executor or registry was added.
These accounting fixes are not claimed to cause the earlier paid savings. The
paid maintenance experiment used `94c27c6`; the last correction was validated
after paid work closed.

The last correction does not reconstruct a rolled-back terminal part or promise
universal storage recovery. A part-derived subtotal can remain absent while
assistant/global usage and the budget guard retain the bill. Failed storage
transactions are not reported as successful.

## Validation

The suites overlap; the counts below are not additive.

| Validation | Result |
| --- | --- |
| Context-summary accounting suite | 281 passed; 8 baseline failures corrected |
| Cancellation controls | 6 baseline failures/2 normal passes; all 8 corrected controls passed |
| Publication-error negative control | 12 failed/4 passed on unchanged source |
| Expanded publication-error matrix | 24 passed; 252 assertions |
| Latest processor/usage suite | 109 passed; 704 assertions |
| Guard, abort and background checks | 37 passed, 8 existing skips; 160 assertions |
| Final combined controls | 32 passed; 324 assertions |
| Required pre-push workspace typechecks | 23/23 passed |
| Independent source review | No blocking regression found |

Actual native fake-provider qualification exercised both runtimes, seven native
identities, browser/image tools, background delivery, an intentional exit 7 and
successful post-judge API/CLI/SDK commands. No live provider inference was used
for qualification. This native qualification used the paid candidate `94c27c6`; the later
publication-error fallback was checked through actual processor fixtures and
workspace typechecks. Original source hashes, positive reference checks, working
seed results and targeted damaged-reference controls remain recorded separately.

## Additional-$20 accounting

| Item | USD |
| --- | ---: |
| Known recorded usage in the additional round | 16.6138509 |
| Unresolved charge reservation carried inside this round | 1.4477650 |
| Unused upper-exposure allowance | 1.9383841 |
| Total authorized additional exposure | 20.0000000 |

Both final trials stopped on `single-call reservation headroom insufficient`.
The unused allowance could not cover their rejected conservative reservations;
no padding or further partial workflow was run. This allowance is not a claim
about the API account's actual remaining credit balance.

Across the entire study history, known usage is $46.1929459 and two older unknown
charges retain reservations totaling $7.177765. Overall upper exposure remains
$53.3707109 under the unchanged $55.309095 continuation limit. All 768 current
phase admissions are settled; older history is explicitly not fully settled.
No unknown charge was silently refunded, repriced or declared free.

## Delivery and reproducibility

The consolidated GitHub branch is `tokenomics-delivery`. It contains the product
fixes, qualified benchmark instrumentation, cost profiler, sanitized receipts,
original generated source, locked reviews, editable investor report inputs and
the final PDF. Retired synthetic reference implementations were released only
after paid work and blinded reviews closed; they are no longer unseen holdouts.

Immutable snapshot bytes, including CRLF and final empty lines, are preserved
and checked against Git blobs. Credentials, raw private financial journals,
dependency trees, vendor binaries and private reasoning transcripts are excluded
from publication. No cloud deployment was performed in this round.

An exact-input-counting transport improvement is documented only as a future
proposal. It is not implemented, qualified or credited with savings. Further
fully completed, adequately funded team comparisons remain necessary before
claiming a general multi-agent cost advantage.
