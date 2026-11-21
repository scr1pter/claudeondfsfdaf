# vector-mention-fixes: A59-INV-P1 ship commands and B08 thread binding

Branch `vector-mention-fixes`, cut from origin/main `6601d963d`. It covers two Vector v2 leftover P0 items for @vector. Both stay dormant: Ship Desk's capture job runs only with the repository variable `VECTOR_SHIP_DESK`, which stays unset, and every `api/cloud-agents` route answers its fixed 503 while `MODEL_PLANS_ENABLED` or `VECTOR_GITHUB_BRAIN_ENABLED` is off.

Fold these entries into the lane docs (`vector-at-mention-deviations.md`, `codium-track-b-checkpoint.md`) when the lane is next edited.

## 2026-11-21, A59-INV-P1: `vector ship` prints server refusal text in public Actions logs

**The gap.** INV-P1 (spec :370 at `6601d963d`) says the CLI never prints a server error body in Actions. `vector ship ticket` printed `result.reason`, which is the server's `error.message`, and `vector ship capture` printed `ShipError` messages built from the server's body. vectordev.ai's Ship Desk refusals include "Your Vector Codium plan does not include Ship Desk." and "Ship Desk is on hold for this account while its payment is reviewed.", so a capture job's log could show the account's plan or payment state.

**The fix** (`packages/engine/src/cli/cmd/ship.ts` only; return shapes unchanged; `packages/core/src/review/workflow.ts` untouched):

- A pure, exported `refusalLine(fixed, detail, env)`. It returns `fixed` when `env.GITHUB_ACTIONS === "true"` or the detail is empty or blank, and `fixed + " " + detail` otherwise.
- The ticket path prints `refusalLine("Ship Desk: no capture ticket.", result.reason, process.env)`.
- The capture's catch uses `refusalLine("Ship Desk: vectordev.ai refused this capture.", error.message, process.env)` only for a `ShipError` with a `status`, which only `captureApi` sets from vectordev.ai's answer. The capture's own refusals (Windows, no Chrome, a held environment, a storage upload) keep their text.

**What changes for the person.** In Actions, a local ticket reason such as "No run token." is no longer printed; the generated workflow already discards that output. Outside Actions, a server refusal of the capture gains the fixed prefix.

**Tests** (`packages/engine/test/cli/ship.test.ts`, new describe "INV-P1: refusals in GitHub Actions", 3 tests; 14 in the file). A loopback `Bun.serve` on 127.0.0.1:0 plays vectordev.ai: it refuses the ticket with the plan text and the capture's card with the payment-hold text. Both commands run through yargs in this process with `process.stderr.write` spied (UI prints to stderr). Each case sets or deletes `GITHUB_ACTIONS` (CI runners set it), deletes the job variables the capture refuses (`ACTIONS_ID_TOKEN_REQUEST_*`, `VECTOR_CLI_TOKEN`, `RUNNER_TEMP`), and restores the environment and `process.exitCode` in `finally`.

- In Actions: the ticket prints `Ship Desk: no capture ticket.`, the capture prints `Error: Ship Desk: vectordev.ai refused this capture.`, the server was asked for `ticket` then `card`, and neither output matches `/plan|payment|Codium/i`. The capture's fixed-line and request assertions are guarded off win32, where the capture refuses on this computer first; the no-leak assertion runs everywhere.
- Outside Actions: both outputs carry the server's sentence after the fixed line.
- Pure `refusalLine` rows: `GITHUB_ACTIONS` `true`, unset and `false`; an empty, blank and undefined detail.

**Runs** (`cd packages/engine && bun test --timeout 30000 test/cli/ship.test.ts`):

- Red (only `ship.ts` reverted from a saved diff): 11 pass, 3 fail. In Actions the ticket printed `Ship Desk: no capture ticket. Your Vector Codium plan does not include Ship Desk.`; outside Actions the capture printed the bare server sentence; `refusalLine` did not exist.
- Green (the diff re-applied, sha256 matched): 14 pass, 0 fail.
- Mutation 1, `refusalLine` ignores `env`: 2 fail (the Actions case on the plan text, and the pure row). Restored, sha256 matched.
- Mutation 2, the capture's catch prints every message raw: 2 fail (the payment-hold text in both cases). Restored, sha256 matched.
- `cd packages/engine && bun typecheck`: clean.
