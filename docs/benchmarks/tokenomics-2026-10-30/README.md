# Reproduce the offline audit

These are documentation/evidence artifacts. They do not change the application
or run automatically. No command below invokes a real model. The accounting
probe intentionally contains two failing contracts for defects in baseline
main. Do not add those red contracts to the passing product CI suite.

Use Bun 1.3.14, Git, Python and a dependency-installed checkout with application
source matching `78526052c0d576adec2904dc221fb67fdde573b0`. The report branch adds
only documentation. Keep one Bun workload at a time. Do not use the live runners
from other directories without a separate owner-approved budget.

## Materialize a scratch copy

The two `.ts.txt` files contain the exact synthetic production-boundary probes
with the machine-specific checkout replaced by `__VECTOR_ROOT__`. The Python
text artifact copies the existing footprint harness and makes the documented
Windows/sizing changes. It never reads credentials or changes product files.
It stops if its expected source seams have changed.

Run from the report checkout; replace angle-bracket placeholders:

```powershell
python docs/benchmarks/tokenomics-2026-10-30/adapter-prepare.py.txt --root <checkout> --out <scratch>
```

Put the Bun executable's directory on this shell's PATH. The fake model server
starts agents in isolated homes with synthetic keys and loopback-only endpoints.
The Windows adapter keeps required executable-resolution variables and a stable
TEMP, disables unavailable POSIX RSS sampling, and records RSS as null. It does
not remove a verification, edit a protected test, or substitute a fake test pass.

## Footprints

Run each command separately, serially. Repeat both sizes for each pinned tree;
keep the generated harness fixed and change `--engine-root` only.

```powershell
cd <checkout>/packages/engine
bun --no-env-file run <scratch>/footprint.ts --runtime vector,vector-openai --scenario solo-fix --sessions 2 --task-size standard --openai-model gpt-6.1-sol --engine-root <checkout> --out <scratch>/standard.json
bun --no-env-file run <scratch>/footprint.ts --runtime vector,vector-openai --scenario solo-fix --sessions 2 --task-size thorough --openai-model gpt-6.1-sol --engine-root <checkout> --out <scratch>/thorough.json
```

Each size is one two-session repetition per format on one fixture. Coding judge
is explicitly off, matching its default. A valid case requires exit zero, every
scripted operation consumed, successful verification output, unchanged protected
files, and passing independent fixture checks. Generic CLI runs do not activate
desktop autocomplete, the Hands bridge, GitHub-only policy or the paid gateway.

The generation script preserves UTF-8. The original executed adapter had some
mojibake in display-only separators after a local Python encoding round-trip;
its exact hash is retained in footprints.json. The portable version fixes those
diagnostic characters. Fixture operations, request prompts and assertions are
unchanged. Absolute checkout paths also change generated hashes. These are
declared reproduction differences, not new measured savings.

## Production-boundary probes

```powershell
cd <checkout>/packages/engine
bun --no-env-file test <scratch>/accounting-probe.test.ts --timeout 30000
cd <checkout>/packages/core
bun --no-env-file <scratch>/memory-cache-probe.ts
```

On baseline main, accounting should exit one with five passing controls and two
red BUG contracts. They check the production normalizer and title/guard boundary;
only event persistence is replaced by an isolated local broker. This is not a
complete processor-stream replay. Memory should exit zero, reporting the same
entry ID but different rendered bytes after an edit and no rendered line after
archive. It does not execute the private engine-fill path or measure provider
cache misses. Required forgetting/access revocation must remain effective.

If code or dependencies differ, retain failures and label them. Do not weaken
assertions to make the recorded numbers recur. The JSON files in this folder
are a numerical projection without headers, credential data or request bodies;
raw local logs remain private.
