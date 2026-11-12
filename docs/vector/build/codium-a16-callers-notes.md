# A16 caller and token implementation record

This work starts from the pushed A15 snapshot `56bb1b69`. Independent source and final test-addition reviews are closed with no confirmed blocker. Local tests and API/web typechecks passed; push and CI remain pending. No provider request, account setting, deployment or release-catalog change was performed.

## Local validation

219 unique test cases passed across 14 files, with no skipped cases:

| File                                              | Passing cases |
| ------------------------------------------------- | ------------: |
| `packages/web/test/model-plan-caller.test.ts`     |            37 |
| `test/model-plan-cli-tokens.test.ts`              |            20 |
| `packages/web/test/desktop-account.test.ts`       |            11 |
| `packages/web/test/model-plan-models-api.test.ts` |             4 |
| `packages/web/test/model-plan-status-api.test.ts` |             3 |
| `test/cli-token.test.ts`                          |             8 |
| `test/account-delete.test.ts`                     |             9 |
| `test/account-delete-api.test.ts`                 |             8 |
| `test/account-profile.test.ts`                    |             5 |
| `packages/web/test/free-models-api.test.ts`       |            41 |
| `packages/web/test/model-plans-api.test.ts`       |            44 |
| `packages/web/test/account-delete-body.test.ts`   |             3 |
| `packages/web/test/public-shares-api.test.ts`     |            10 |
| `packages/web/test/teams-api.test.ts`             |            16 |

API typecheck passed. The final web Astro check passed across 189 files with 0 errors, 0 warnings and 113 hints. Its first pass found only a known-purpose test array inferred as `string[]`; preserving the literal types fixed that test typing. The affected 37 cases and Astro passed again, including after final endpoint assertions.

Tests ran one file at a time through `vector-serial`, with 30-second timeouts and isolated temporary XDG paths. The new PKCE test used actual Valkey Lua to prove malformed saved purposes do not consume a code and concurrent exchanges have one winner. The same server verified single-jti revocation and sibling survival. Existing gateway/free-model suites ran against actual Valkey. Sharing and team HTTP/SQL suites used isolated loopback Postgres 16 databases and Valkey, including new single-grant revocation cases; no customer service was contacted. All test/typecheck processes exited and the ephemeral Valkey server was stopped before releasing the shared slot. The parent confirmed the disposable Postgres container was also stopped cleanly.

The new real HTTP CLI-purpose exchange case verifies saved-purpose authority, refusal of body upgrades, single use and desktop-portal separation. Adding it exposed suite-shared fake rate counters in the old desktop tests; isolating those counters per case preserved the within-case exhaustion test and made all 11 cases pass. No runtime correction was needed by these checks.

## Authority boundaries

Only paid chat and `/models` use the new marked-caller gate. The existing general account helper stays `vct_`-only and continues accepting valid unmarked grants for status and other existing account reads. A signed `desktop` or `cli` claim establishes the paid caller kind; client and purpose headers cannot mint either mark. The old public token POST remains unmarked regardless of body fields.

Client versions use bounded numeric three-component comparison against the configured minimum. Chat returns 426 for missing, old or malformed versions. `local` works only when neither production environment signal applies. Older `/models` reads return `enabled:false, models:[]`. The version gate is protocol compatibility, never account, tier or spending authority.

Run verifiers register only exact `vrt_` and `vht_` prefixes and duplicate production registrations fail. Scoped test registries do not replace production handlers. Returned run callers must bind a valid account, enabled source, future deadline and prefix-specific service; hosted callers also need a session ID. Verified run purpose overrides the request header. No production service registers a run verifier in A16: A17 must enforce service-sensitive tool/session guards, atomic admission and run ceilings before any real run token can spend. Those guards must use `kind:run` plus `run.service`, so a signed review purpose cannot evade them.

## PKCE and revocation

The code mint stores the `cli` purpose beside the account, state and PKCE challenge. The atomic exchange consumes that saved purpose; request fields cannot turn a desktop or deletion code into a CLI grant. Invalid stored purposes fail closed. Each CLI grant receives a fresh random `jti`; desktop and deletion behavior stays separate. Shared token parsing rejects extra dot segments and malformed signed claims.

Single-token revocation is an internal helper, with account, jti and expiry supplied from authenticated verified claims. No request-facing revoke endpoint is added. A repeated revocation resets the TTL from the same immutable signed expiry, avoiding a shorter prior TTL reopening that grant. Account-wide deletion revocation still overrides every grant.

The extra auth wiring beyond A16's enumerated files makes single revocation consistent at existing token-use boundaries: `free-models-chat.ts`, `public-shares.ts`, `teams.ts`, `account/profile.ts` and `account/cli-verify.ts`. These changes add no team or sharing features and preserve their access domains. Protected paths use authoritative account/jti checks. Profile and CLI verification retain their existing no-jti fail-open behavior; new jti grants require authoritative checks. `usage.ts` parses an account only for telemetry attribution and grants no access, so it stays synchronous. Billing's desktop-only check remains exact; CLI and run grants cannot gain desktop billing or deletion authority.

## Required A19 login integration

A16 acceptance covers backend HTTP code mint/exchange only. It does **not** establish that the released `vector login` can traverse the new flow. A19 must include these files in addition to its original client list:

- `packages/engine/src/cli/vector-account.ts`
- `packages/engine/src/cli/cmd/vector-login.ts`
- `packages/web/src/lib/desktop-sign-in.ts`
- `packages/web/src/components/marketing/account/CliTokenPage.tsx`
- Any callback/return-path plumbing needed by that existing client contract.

A19 must make the website accept and preserve the server-bound CLI purpose; implement the safe PKCE callback/loopback choice within the existing client contract; make engine login consume the one-use code and store the marked CLI grant without displaying it; and retain the legacy copy/paste endpoint as unmarked. A19's done gate requires an offline end-to-end login-flow test through website approval, callback, exchange and authenticated CLI use, including replay/purpose tampering refusal. This is a required gate, not an optional follow-up.

The current production SDK sends neither the new headers nor this new CLI exchange. Existing API integration tests use an explicit named modern-client fixture adapter to keep testing billing plumbing. Separate real HTTP negatives test the unadapted request boundary. This work is not launch-ready before A17/A18 admission/listing, A19 client/login integration and the remaining evidence/launch gates.
