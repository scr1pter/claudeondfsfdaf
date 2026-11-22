# R46-2: show skipped DNS checks

22 Nov 2026. Local candidate based on main `c515de62465db817ff309f4237023f9704fe7983`.

The remaining §9 item is the product follow-up recorded in `codium-p7-repairs.md`, “R46-2” and “For the lead.” The
unsafe partial-DNS lookup was already repaired on main. A failed A or AAAA lookup must still leave the host
inconclusive: no HTTP probe, outage verdict or incident. This candidate makes the existing last-check observation
visible; it does not change that rule.

The Worker already returns each monitor’s latest `reason` and `checkedAt`. The monitor listing now reads its signed
`state` answer when the current eligible configuration is synced. An optional `resolverFailedAt` reaches the screen
only for one matching monitor row on an active account, with verified/probed flags, exact `resolver` reason and a
positive safe timestamp no later than the request time. Duplicate, malformed, unrelated or unreadable observations
are omitted. Reading configured URLs continues to work when the Worker cannot be read.

Both desktop Settings → Production and phone Production show “Last check skipped: DNS lookup failed.” Otherwise
eligible URLs say “Checks configured,” since settings eligibility alone does not prove a completed probe. A later
public DNS result replaces the last reason and removes the warning through the same API path.

No Worker runtime, schema, storage, caps, flags, incident policy or consent text changes. There are no new counters,
thresholds or alerts. No deployment or live ops/provider request was made.

## Local verification

All Bun commands use `/workspace/.tools/vector-serial`, one file at a time from package directories, with
`--no-env-file`, `--timeout 30000` for tests, and lock-identical shared dependencies.

- Red: the real API/Worker/screen integration test, with the fake account’s plan and config both synced and DNS
  attempts asserted, failed on unchanged main because the monitor response had no resolver observation (6 pass,
  1 fail). The fixture’s sites and all external services are scripted in memory; its SQL is real SQLite.
- Green: `test/ops-screens.test.ts`: 8 pass, 83 assertions. This covers repeated DNS failures with no site probes,
  reports or incidents, state-read failure, recovery after public DNS, and rejected duplicate/malformed observations.
- `packages/app/src/features/cloud/ops/ops-model.test.ts`: 15 pass, 153 assertions. This covers the shared display
  wording and strict optional-field decoding, including ineligible monitors.
- Existing `test/on-call.test.ts`: 30 pass, 1 existing Valkey integration skip, 301 assertions.
- Existing `packages/ops-worker/test/ssrf.test.ts`: 12 pass, 285 assertions, including the partial-lookup safety rule.
- API typecheck from `packages/engine` with `--project ../../tsconfig.json`: pass. App typecheck: pass.

This is a local candidate only. It has not been pushed, merged or activated.
