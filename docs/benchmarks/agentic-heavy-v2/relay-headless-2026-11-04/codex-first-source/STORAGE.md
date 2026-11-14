Journal: relay-transactions.jsonl

Each UTF-8 line is one complete durable transaction, terminated by LF. Its JSON
object has exactly `sequence`, `previousHash`, `state`, and `hash`. `sequence`
starts at 1 and increases by exactly one. `previousHash` is the preceding record's
lowercase SHA-256, or 64 zeroes for the first record. `hash` is the lowercase
SHA-256 of UTF-8 `JSON.stringify({ sequence, previousHash, state })` in that property
order. `state` is the complete post-transaction state: workspace data, capabilities
with only secret hashes, import rows and lease hashes, idempotency outcomes, and
audit events. A transaction is appended and fsynced before publication or response.
The single writer serializes copy-on-write transactions; failures publish no state.
An append failure poisons the running writer until it is restarted and recovered.

Recovery checks every line's JSON, exact transaction keys, sequence, previous hash,
checksum, and root state shape. Invalid UTF-8, incomplete trailing lines, empty
interior records, altered records, gaps, and reordering fail startup closed. The
service never truncates, replaces, or repairs an invalid journal. The journal is
append-only; this simple local implementation intentionally does not compact it.

Ownership is recorded in `.relay-owner/owner.json` with process ID and random
ownership nonce. A complete metadata directory is prepared before atomic rename
to its fixed name. On Windows an exclusive local named pipe keyed by the canonical
data-directory path prevents concurrent writers and serializes stale-owner
recovery. Linux uses the corresponding abstract local socket. Kernel ownership
vanishes on process death; the surviving metadata is reclaimed only after its
process is confirmed dead. Other platforms refuse stale-owner recovery rather
than use unsafe timeouts. No other process is terminated. Release checks the exact
ownership nonce and only removes the owned metadata and empty lock directory.
Acquisition, release, and prepared-record cleanup use `lstat` to require a real
directory and regular, non-symbolic, singly linked metadata. File and directory
identities and the owner nonce are checked before removal. Aliases and unexpected
entries remain intact and cause the operation to fail closed. Unknown files in a
stale ownership directory make recovery fail closed. Temporary
ownership directories abandoned before acquisition are not deleted by other owners.

All runtime files stay under the supplied absolute data directory. Secret tokens
are generated with cryptographic randomness and persisted only as SHA-256 hashes.
Bootstrap-derived creation replay tokens can be regenerated without persisting
their plaintext. The local ownership IPC carries no application data or secrets.

Optional keyed workspace creation records live in the root `workspaceKeys` array
and commit atomically with the workspace, owner capability hash, and creation
event. An exact keyed replay reconstructs the owner token with HMAC-SHA-256 keyed
by the current bootstrap token over `relay-owner:` followed by the independently
generated capability ID, `:`, and workspace ID, encoded as base64url. Its hash must
match the persisted owner capability hash before the response can be replayed.
A changed bootstrap token therefore produces a 409 conflict instead of a different
owner token. A changed request under the same key conflicts; creation without a
key also conflicts when its workspace ID already exists. Replays append no event
and do not advance the transaction journal.
