# Local durable storage

Journal: transactions.jsonl

All runtime files live only beneath the supplied absolute `--data` directory,
outside authored source. No external service or installed dependency is used.
The service obtains exclusive ownership and finishes recovery before readiness.

## Journal format and transactions

The journal is UTF-8 JSONL. Each canonical JSON object ends with exactly one LF
and has these fields:

```text
{format: 1, seq: INTEGER, prevHash: HEX_SHA256, state: STATE, hash: HEX_SHA256}
```

Canonical encoding recursively sorts object keys, preserves array order, and
rejects values that JSON would coerce or omit. `hash` is lowercase SHA-256 of
the canonical object containing `format`, `seq`, `prevHash`, and `state`, without
`hash`. Sequence numbers start at 1 and increase by exactly one. The first
predecessor is 64 zeroes; subsequent predecessors equal the previous checksum.
Genesis contains schema version 1, a random owner derivation key, and an empty
workspace list. `.relay-lock/initialized.json` records the genesis checksum.

Each changed transaction appends a complete post-transaction state snapshot.
State includes workspace versions, normalized import rows, member revisions,
capability hashes/revocations, lease hashes/epochs, replay records, and events.
No raw CSV is retained; its exact-byte digest and canonical request fingerprint
are retained. Collections use arrays rather than untrusted object keys.

Writes are FIFO serialized and clone-on-write. Callback exceptions discard the
draft. Unchanged drafts append nothing. A changed draft is schema checked;
short writes are completed and the journal file is fsynced. Before publication
or a successful response, an acknowledged-tip anchor is also durably advanced.
Callback return values are transient and are **not**
automatically journaled. Safe replay results, business state, and exactly one
workspace event are persisted together. Exact replays and specified repeated
operations create neither journal records nor events.

An append/fsync/anchor-update failure that is fatal or exhausts the bounded
rename retry below poisons the store, rejecting queued/new operations instead
of risking further writes. Its durable outcome can be uncertain.
Closing drains accepted work, closes the journal, and then releases ownership.
`close()` is idempotent. The HTTP entrypoint first gates new business admission
(new requests receive 503 with Connection: close), drains accepted handlers and
their response completion/disconnection, then closes the listener, service,
and storage. It keeps the transport available while accepted bodies drain;
the service adapter also tracks its accepted handlers. Aborted/disconnected
requests do not block shutdown, but their accepted handlers are still awaited.

## Recovery and integrity

Recovery strictly decodes UTF-8 and verifies every complete LF-terminated line,
canonical representation, schema, checksum, sequence, predecessor, and stable
derivation key. Empty, malformed, truncated, tampered, reordered, sequence-gapped,
or missing initialized journals fail closed. Recovery never truncates, repairs,
resets, or rewrites a corrupt journal. Error messages do not include file
contents or request secrets.

`.relay-lock/tip.json` contains canonical JSON `{format:1,seq,hash}` plus LF.
After each journal append/fsync, the exclusive owner writes/fsyncs a unique
tip candidate and atomically renames it over the checked previous anchor, then
syncs the directory where supported. State becomes visible only afterward.
On Windows only, tip-rename EPERM, EBUSY, and EACCES receive at most seven
attempts with delays of 25, 50, 100, 200, 400, and 800 milliseconds (1,575 ms
total deliberate backoff, excluding filesystem latency). Each attempt rechecks
the directory's identity/type, the exact expected prior tip, and the synced
candidate's identity/type/size. The same candidate is retained across attempts;
the old tip is never unlinked first. Other errors are not retried. Exhaustion,
changed metadata/paths, and a rename that may have succeeded despite reporting
an error remain fail-closed and poison subsequent writes. Neither state nor a
successful result is published before rename and supported directory sync.
Recovery requires the anchored sequence/checksum to exist in the journal,
detecting deletion of even complete acknowledged trailing records. A missing
tip in an initialized store fails closed. Genesis creates its tip before the
initialization marker. A valid later journal tail can represent a crash after
journal fsync but before tip advancement/response: recovery preserves it and
advances the anchor before readiness, without rewriting the journal.

SHA-256 checksums and anchors detect accidental or un-rehashed alteration, not
an attacker able to rewrite all journal checksums and metadata. Whole-state
records and the immutable lock chain grow over time; there is no compaction or
retention limit. Backups must preserve the journal and reserved metadata together.

## Exclusive ownership

The reserved `.relay-lock` directory contains immutable `root.json` and
`next-PARENT_NONCE.json` generation records, plus `initialized.json` and the
mutable acknowledged `tip.json` anchor. A lock
record is canonical JSON plus LF:

```text
{format: 1, kind: "held" | "released", nonce: RANDOM_HEX, pid: INTEGER, parent: NONCE | null}
```

A fully written/fsynced, uniquely owned `.candidate-RANDOM.json` file is
published by an atomic exclusive hard link. Only this attempt's unpublished
candidate is removed; published lock-generation records are never unlinked or replaced.
Contenders follow the generation chain. A live or unverifiable PID refuses
startup; only a definitely dead owner or a release record permits succession.
Concurrent reclaimers target the same successor slot, so only one wins. No
other process is terminated. PID reuse conservatively blocks takeover.

A release generation is published only after journal access has ended. Old
records remain as metadata, not active lock resources. Unsupported atomic hard
links cause startup failure rather than an unsafe fallback. Unknown files are
not deleted. Reserved journal/metadata paths reject symlinks or unexpected file
types. Node and Bun on the current Windows filesystem support the hard-link
operation. Directory fsync is attempted where supported; Windows returns EPERM
for directory handles here, so directory-entry power-loss durability cannot be
promised. Journal and metadata **file** fsync is mandatory.

## Secret handling

Actual capabilities and lease tokens are never persisted in plaintext or
written to routine stdout/stderr, events, or errors. They are returned only in
the specified authenticated issuance/claim/creation responses. Capability and
lease verification use SHA-256 hashes. Commit fingerprints hash canonical
request bodies rather than retaining submitted lease tokens. Public import
projections exclude hashes, normalized rows, and lease internals.

Exact workspace creation replay regenerates the original opaque owner token
using a domain-separated HMAC of a durable random **non-capability** derivation
key and the workspace ID/random nonce. Only the resulting capability hash is
stored in capability records. This remains stable when the bootstrap changes.
The bootstrap itself is read from the environment and never stored.

The derivation key is sensitive recovery material: someone who can read the
journal can reconstruct owner capabilities. Thus hashed tokens do **not** make
the journal safe to disclose. Protect DATA_DIR and its backups with appropriate
OS access controls. Files are created with mode 0600 and directories with 0700
where supported; these are best-effort on Windows and do not replace ACLs.
No encryption-at-rest or hostile-local-user security guarantee is provided.
