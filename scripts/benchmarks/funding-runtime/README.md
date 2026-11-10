# Historical study funding runtime: source archive

This makes the funding and policy-control source available from Git for review
and use on another machine. It is a copy-only archive of the current source files
identified by the study owner as the running instrument. It does not start,
replace, reconfigure or fund a gateway, and it does not attest bytes already loaded
inside a live process.

The reviewed historical provisioning is **$48 cumulative for the study**, with
**$20 cumulative allocations for each Foundry runtime actor**. Earlier charges,
sealed actors, reservations and journal history remain binding. These are study
limits and recorded rates, not current product pricing or a new allowance.

## Exact source closure

| Archived files | Purpose |
| --- | --- |
| `budget_gateway_v4.py` | Reviewed phase allocation and historical-prefix binding |
| `budget_gateway_v3.py` | Durable journal reconciliation, recovery and owned-server lifecycle |
| `budget_gateway_v2.py` | Admission/reservation/settlement and request handling |
| `budget_gateway.py` | Imported base pricing and request helpers |
| `foundry_policy_witness.py` | Separate keyless wire-policy witness |
| Five corresponding `test_*.py` modules | Original synthetic control-test source |

All ten files in [archive](archive) retain exact bytes; the
[manifest](manifest.json) records SHA-256 hashes, lengths and static imports.
No redaction or source rewrite was needed. V4 imports v3/v2, and v2 imports the
base gateway. The witness uses the standard library independently. No other local
Python dependency or dynamic loader was observed. Gateway startup/recovery uses
Windows `msvcrt` locking; this archive contains no portability rewrite.

The older gateway entrypoints retain obsolete round defaults, including the base
gateway's earlier $5 round. They are preserved because later modules import their
helpers; they are not replacement startup instructions. V4 retains its original
source-pinned approved-plan digest and exact historical-journal prefix checks.

## Verify without running the runtime

With Python 3.10 or later, run from this directory:

```text
python verify_source_archive.py
```

This hashes and parses source with `ast`; it never imports the archived gateway,
witness or test modules, reads private runtime files, opens a listener, or contacts
a provider. After repository-owner staging, `--git-index` additionally compares
the actual staged source blobs and staged `-text` attributes. Preparation does
not claim staged or committed byte verification. Original source whitespace and
line endings are preserved rather than reformatted.

The scan found two credential-shaped **synthetic controller fixtures** in tests.
Static review confirmed temporary directories, patched credential input and
synthetic/local handlers; the two narrow exceptions are recorded. No actual
credential/private-user-path finding remained. This is bounded pattern/context
review, not formal secret assurance. Several tests contain loopback socket/HTTP
fixtures, so none of the archived tests was imported or executed during this
publication. Their source is available for a separately reviewed free-test run.

## Another machine and existing study history

Git provides the code, not a funded continuation. To resume this same historical
study, the owner must appropriately supply the private authorization, matching
approved phase plan, complete original admission/receipt history, recovery/status
artifacts and credential handling. The original entrypoint validates the pinned
plan and history before accepting work. Preserve cumulative spending and unresolved
reservations; do not initialize empty replacement journals, reset old spend,
expand allocations, bypass the pinned plan, or run a second meter against the
same study. Review process/lock ownership and the target machine before any
operational startup.

No startup command or fresh funded directory is supplied here. Synthetic tests
create temporary histories and patch approval for their fixtures; that does not
authorize new billing. A fresh study must be explicit, separately authorized and
reviewed with its own appropriate plan. This archive does not invent a new funding
engine or silently convert the old allowance into a new study.

## Private runtime boundary

No API key, gateway/controller token, `gateway-config.json`, owner-budget or phase
document, actual phase-allocation state, journal, receipt, raw prompt/body log,
company document or native account/machine identifier is included. Runtime state
belongs outside this Git archive and must remain appropriately protected. Treat
runtime outputs as private; source publication is not permission to publish their
contents. The witness is keyless but can forward requests to a funded gateway
when actually started; it was not started here.
