# A17 context and reservation policy decision

The owner selected: **"Use larger fixed reservations to preserve context windows; requests may require more available balance."** This authorizes a larger fixed reservation derivation and updates to the prior hold table while preserving the current context windows. It does not authorize provider calls, settings changes or new route qualification. The concrete derivation below is implemented in `api/_lib/codium-reservations.ts`; a token estimate alone is still not a hard provider-cost proof. No real model or metadata request was made for this investigation.

## What the repository proves

`requireModelPlanContext` in `api/_lib/model-plan-chat.ts` estimates input tokens as `ceil((JSON bytes - escape overhead) / 4)`. It admits that estimate plus the requested output within the configured window. This is an estimate, not a tokenizer or provider-enforced prompt cap.

For entries with `promptTokenLimit`, the separate `promptBound` counts ASCII at half a token per character, non-ASCII at a token per byte, and adds 2,000 for framing. Its existing comment explicitly acknowledges that dense random hashes can tokenize more densely. Neither this bound nor the context estimate proves the fixed per-step hold is the largest possible provider charge.

The unchanged October 23 capture records a 1,048,576-token native ZDR endpoint window for Kimi, Argon and DeepSeek. The active Kimi/Argon configured window is 128,000, with an 8,192-token reply and a fixed public reservation of 0.337920 at the configured $2/$10 per million ceilings. A roughly 450,000-byte ASCII request can pass the local four-byte estimate. The provider-native million-token window does not enforce the smaller configured 128,000 window. The exact model-token count and actual bill for that synthetic input have **not** been measured and are not asserted here.

The algebra permits up to `4 × (configured window - output budget)` decoded JSON bytes under the context estimate. At 128,000/8,192 that is 479,232 bytes. This illustrates why charging only 128,000 input tokens is not established by the local check; it does not assert that every byte is a token for any particular model.

There is a related historical pricing gate: the capture contains Haiku's higher-price tier at 100,000 actual prompt tokens and Luna's at 272,000. An approximate ASCII prompt bound cannot certify those actual-token thresholds. A larger fixed reservation policy must consider reachable captured price tiers and cache-write prices too. Changing only the token multiplier while retaining an unproven low-price tier would not establish a hard amount.

## Policy choices reviewed with the owner

| Choice                                                   | Concrete behavior                                                                                                                                                                                                   | Tradeoff                                                                                                                                                                                                              |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Larger fixed reservations, preserving windows (selected) | Derive one conservative per-model amount from all locally admissible input, reply and reachable price tiers; reserve the same public amount regardless of request size. Preserve the advertised compaction windows. | More of the month is temporarily reserved; fewer expensive parallel steps may fit. The approved hold table changes. Derivation still needs explicit framing/tokenizer assumptions and provider evidence where absent. |
| Strict admission, preserving reservations                | Reject/compact earlier whenever a conservative token/framing bound cannot fit the existing window/price tier and reservation. Keep the approved fixed hold amounts.                                                 | Typical usable conversations can be shorter than today's client estimate and advertised compaction behavior. The window policy and existing context tests change.                                                     |
| Explicitly soft per-step budgets                         | Retain the current estimates and fixed table, record actual reported costs, and describe daily/run caps as admission limits on reservations rather than guaranteed maximum provider spend.                          | A step may exceed its reservation; the daily/run dollar ceilings are not hard guarantees. The account's provider key limit remains the independent monthly backstop.                                                  |

These choices are distinct from the store's atomic mechanics. Tests can prove that concurrent reservations cannot pass the same stored balance, that counters and ticket settlement are idempotent, and that account/group/global concurrency is enforced. They cannot turn an approximate token estimate into a hard provider-cost proof.

## Gates retained during the decision

- Active model access floors must still follow the owner policy: Kimi and Argon require Pro even while the larger catalog is staged.
- The 18-candidate catalog is not activated. Unknown model/route/effort/provider-pin facts remain unqualified and answer unavailable.
- No provider call, live metadata probe, credit purchase, deployment or account-setting change is authorized by this decision note.
- The selected larger-reservation policy must have a reviewed concrete derivation and corresponding tests before A17's affected policy can be accepted. The answer does not qualify missing provider facts or authorize a claim stronger than the available evidence.

## Derivation as implemented

One attempt reserves the captured native input window plus the configured maximum reply, each at the highest captured base, override, cache-write or reasoning rate (and never below the configured rate), rounded up to whole micro-dollars (`capturedReservationMicro`). The full native window is counted as input without subtracting the reply, deliberately. Max and Ultra may dispatch a second attempt before any byte, and a 429/503 is not proof the first cost nothing, so they reserve exactly two attempts (`modelPlanReservation`: `requiredMicro = attempts × attemptMicro`). Context windows are unchanged.

| Active model | Captured route         | One attempt (micro-dollars) | Plus and Pro | Max and Ultra |
| ------------ | ---------------------- | --------------------------: | -----------: | ------------: |
| DeepSeek     | `nebius/fp8`           |                     334,234 |      334,234 |       668,468 |
| Haiku        | `amazon-bedrock`       |                   1,040,000 |    1,040,000 |     2,080,000 |
| Luna         | `azure`                |                     268,644 |      268,644 |       537,288 |
| Kimi         | `moonshotai/mxfp4`     |                   2,179,072 |    2,179,072 |     4,358,144 |
| Argon        | `google-vertex/global` |                   2,179,072 |    2,179,072 |     4,358,144 |

Kimi and Argon require Pro. These are reservations, not measured invoices or public prices, and they do not qualify a route: `ROUTE_ACCEPTANCES` is empty, so every real route stays unavailable before any credential, hold or fetch until approved external acceptance evidence exists (A60). `packages/web/test/model-plan-reservations.test.ts` pins these amounts against the October 23 capture's digest.

With the daily (25% Plus/Pro), Brain (10%) and run-ceiling (10%) shares, some model, purpose and plan combinations cannot be admitted at the private credit amounts (Haiku's 1.04 per attempt against a Plus run ceiling, for example). That follows the owner's choice and the contract formula; it is a sizing consequence to review before sales, not a defect.

A second sizing consequence for the same review: a provider refusal or transport failure after dispatch carries no cost report, so it is settled as an unknown outcome and commits each dispatched attempt at its full reservation to the period's spend floor (permanent for the period; before A17 the hold was released at once). One refused Kimi or Argon request on Pro consumes 2.179072 USD of allowance; a Max or Ultra retry whose two attempts both fail consumes two attempts (`codium-deviations.md`, "Unknown outcomes are charged"). The multiplier per refusal is one request: since the P3 review the gateway marks every answer it gives after dispatch (`dispatched: true`) and clients never resend a marked answer by themselves (`codium-deviations.md`, "P3 review decisions"). Before that repair the engine resent a provider 429, 402 or other refusal up to ten times within 15 minutes, so one throttled Pro turn on Kimi could commit up to eleven attempts (about 24 USD of allowance, unless Pro's daily share refused it first) and one Ultra turn up to eleven two-attempt reservations. What remains for the owner to size is the person or agent choosing to resend: every resend of a refused request commits one more reservation, and parallel agents each pay their own.

## Validation

The test and typecheck evidence for this policy and the rest of A17 is in `codium-a17-admission-notes.md` ("Local validation" and "Commit gate"). `model-plan-reservations.test.ts` (9 pass) pins the table above. The real-Lua admission and gateway files (`model-plan-admit.test.ts`, 66 pass; `model-plans-api.test.ts`, 67 pass) cover reservations held in full until settlement and a `broken` settlement charging the dispatched attempts at their fixed reservation. A duplicate settlement cannot change the charge, and a reported actual cost above the reservation is still metered. None of this is provider acceptance: route, native-window and reasoning-bound acceptance remain A60's external gate, and CI has not run yet.
