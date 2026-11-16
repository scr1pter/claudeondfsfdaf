# Vector Local packet capture evidence

The Verify workflow's **Vector Local desktop packet capture (30 minutes)** job supplies reproducible evidence for the L2 network-log gate. A new job definition or a short smoke run is not a passing gate. Before release, inspect the successful artifact for the release commit and assess the remaining surfaces below. Keep the air-gap job separate: being unable to connect does not prove that the network log accounts for captured requests.

## Workload and isolation

The job builds the current checkout's Node engine with the checked-in model catalog and runs it alongside the locked Electron runtime. It records the Git commit, SHA-256 of that engine bundle, and desktop package version. It does not use the published CLI.

The Linux wrapper creates private network and mount namespaces. Only loopback and a dummy sink interface exist inside them. IPv4 and IPv6 default routes go to that sink, and a private resolver file sends DNS there too. There is no interface to the host's network. Unexpected connection attempts can therefore appear in the capture and fail the audit without reaching an outside host. Xvfb uses its Unix socket. The capture sees only this isolated fixture workload, not other processes' traffic.

All responses come from a temporary HTTP fixture. The engine and Electron receive a small, explicit environment, temporary config, data and cache folders, and no account credentials. Electron uses temporary user/session data, a mock keychain and a basic password store. The runner does not replace `HOME` or read an account's auth file. The fixture has one text file and one tool-calling model response; it makes no paid model request and downloads no model.

For at least 1,800 seconds, a cycle starts roughly every 30 seconds:

1. A sandboxed Electron renderer creates a session through the built engine's API. The engine calls the local fixture model, performs a real Read tool call on the fixture file, calls the model again, and returns the expected text.
2. The agent browser's production partition loads a cross-origin redirect, two scripts from one host, and an image from another host. The production Chromium dispatcher and browser guards run, including the WebRTC IP policy.
3. A late-created, unlabelled session is refused. An automatic update request is refused; an explicitly permitted update check reaches the fixture.
4. Web access None refuses a browser page, then the fixture restores Web access Ask for the next cycle.

The desktop uses its production startup policy, Chromium dispatcher, browser preferences and update-check wrapper. The engine uses the built server, provider path, tool execution and persistent network log. The small renderer replaces the product's UI only for this verification workload.

## What the audit requires

`local-mode-capture-audit.ts` checks the packet metadata against actual desktop and engine network-log events. It rejects:

- missing source/build identity, missing isolation, dropped packets, a duration under 30 minutes, fewer than 30 completed cycles, an unexplained gap over 90 seconds, or any failed workload check;
- non-loopback traffic, UDP, unknown fixture ports, undecoded TCP payload streams, ambiguous packet fields, or no decoded HTTP requests;
- a captured HTTP request without an allowed network-log event for its origin and method near its timestamp;
- any inference event without a matching captured request, or a cycle without captured and logged engine inference.

Chromium's production log deliberately records each browser origin once per page. The audit permits the same subresource event to account for the two scripts, within its short time window. Redirect and update fixture origins are distinct so each operation has an observable log event. It does not manufacture network-log events to fit the capture.

Production also omits requests that stay on this computer from the Chromium log. The fixture separately records only its renderer's exact API routes, methods and timestamps, plus loading its own page. Those controls and their CORS preflights are counted separately. They are not a blanket loopback exception: model inference must match the engine's own log.

## Evidence to inspect

The job uploads `vector-local-capture-<commit>` even on failure. The artifact contains:

- `result.json`: pass/fail, reasons, identity, duration and comparison counts;
- `workload.json`: start/end/cycle timestamps, individual checks and exact fixture control routes;
- `traffic.pcap`, `tcpdump.log`, `packets.json`: the real capture, drop count and field-only decoded metadata;
- `isolation.json`, `interfaces.json`, `routes.json`, `routes-v6.json`, `resolv.conf`, `hosts`: namespace and sink configuration (`hosts` adds only this machine's own name, so sudo's host lookup stays off the DNS sink);
- `events.json`, `desktop-events.json`, `fixture-hits.json`: actual network-log events and fixture observations;
- workload and engine/Electron diagnostic logs.

The packet file includes synthetic request bodies from this fixture, including generated agent prompts and the fixture file's content. It must not be repurposed to capture a signed-in desktop or unrelated traffic. The ordinary network log continues to store origins without paths, query strings, headers or bodies.

For a short debugging run from `packages/desktop`, first build the current engine as the workflow does, install the locked Electron runtime, then run:

```sh
VECTOR_CAPTURE_DURATION_MS=31000 bun --no-env-file scripts/local-mode-capture.ts /tmp/vector-local-capture-short
```

This checks two real Electron/engine cycles but performs no packet capture and cannot pass L2. On the isolated Linux runner, the wrapper fixes the duration at 1,800,000 ms; passing an abbreviated duration to the workload cannot make the audit pass.

## Remaining coverage

This evidence is limited to the named workload on Linux. It does not exercise the complete product UI, every first-run/background service, the research browser's proxy or search bridge, TLS and company certificates, service/shared-worker transports, operating-system update integration, external processes, or Windows/macOS network behavior. A successful result is not evidence that those unexercised surfaces sent nothing. Keep the dedicated real Electron Local and research-browser smoke tests, and review their documented residuals, alongside this artifact.

The fixture model is not a real vendor model or a recorded server response. G-Fit, G-R, the timed local-model research runs and real Ollama, LM Studio, vLLM, llama.cpp and SGLang recordings remain independent requirements. Do not mark those complete from this job. Keep L2 marked pending until the full CI capture succeeds, and attach its precise workload and platform to the result. A passing artifact demonstrates capture/log agreement for this fixture workload; it does not establish that a full desktop or all-platform capture passed.
