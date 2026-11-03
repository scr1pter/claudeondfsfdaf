# Native cancellation mechanics, fake provider only

`native_probe.py` launches the pinned Codex CLI with the unchanged native command,
code mode and seven-role profile, an empty owned workspace, isolated home and an
ephemeral Python fake provider. It starts no Bun or browser, reads no real key,
controller configuration or receipt ledger, and cannot contact a funded gateway.
All synthetic charges are retained and reconciled. These are transport and
native lifecycle controls, never application benchmarks or quality scores.

The passive socket writer records successful terminal-frame writes without
changing forwarding behavior. A socket write is not an application-level ACK;
native accepted-response usage and task completion provide separate observations.
The deterministic cases distinguish:

- `final-tail`: a fully written terminal is accepted by Codex, which completes
  normally; a later SSE comment exposes the old witness's false cancellation.
- `message-inflight`: the coordinator sends a native message while a lead
  response is in progress. A labelled reasoning boundary permits native message
  delivery, which cancels the current request. Its upstream terminal is drained
  and billed but never written to the cancelled client.
- `interrupt-queued`: one streamed lead response creates two native children,
  waits until their requests are queued, then invokes native `interrupt_agent`
  on the frontend child. That child request never reaches the provider.
- `message-queued`: a retained exploratory scheduling case. It is not evidence
  of a genuine queued cancellation unless the actual native/audit outcome says so.

The original real Codex arm's ninth request has known completed usage and an
incoming coordinator message, but its old audit did not record terminal delivery.
Do not retroactively claim it was definitely a clean EOF or definitely midstream.
Original failure flags and charges remain intact. The free controls establish
that both behaviors can occur in the real native runtime.

Run one case into a new private output directory:

```powershell
python native_probe.py --codex-bin <pinned-codex.exe> `
  --out <new-private-directory> --mode message-inflight
```

Raw native IDs, prompts, provider bodies, runtime homes and transcripts remain
private. Public evidence contains only labelled synthetic counts, flags and
source hashes. Every exploratory attempt is retained; the three `frozen-before`
cases reproduce the final probe source against the unchanged witness.
