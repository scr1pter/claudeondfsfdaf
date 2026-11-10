# Local public-client checks

No dependencies or external services are used. All fixture data is synthetic.
Run with the provided Node executable (or `node` when it resolves to that runtime):

```powershell
& $env:NODE_EXE --test client-tests/transport.test.mjs
```

The transport suite creates bounded loopback HTTP fixtures and always closes them.
It invokes the actual exported SDK and real CLI subprocesses, checks every method
and command, exact request bodies, replay status handling, URL escaping, strict
argument counts, safe integer parsing, error streams, and credential redaction.
It does not assert backend business behavior using the fixture server.

The live suite is opt-in. The backend coordinator alone starts the API and chooses
its `DATA_DIR` outside source. Point the suite at that running local service with
an owner fixture key; it creates synthetic accounts, usage, invoices, credits and
dynamic keys through HTTP only. It never starts or stops the API:

```powershell
$env:LEDGER_CLIENT_TEST_URL = "http://127.0.0.1:$env:PORT"
$env:LEDGER_CLIENT_TEST_KEY = "owner-acme"
& $env:NODE_EXE --test client-tests/live-api.test.mjs
```

`types.mts` is a strict positive and `@ts-expect-error` negative fixture importing
the real public declarations. It is compile-only; do not execute it. If a local
TypeScript compiler is provided, run it without installing anything:

```powershell
& $env:NODE_EXE "<provided-local-typescript>/bin/tsc" --strict --noEmit --target ES2022 --module NodeNext --moduleResolution NodeNext client-tests/types.mts
```

No compiler is bundled or fetched. If none is available, report the typecheck as
not run, separately from passing runtime checks.
