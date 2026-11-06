# Relay command line and JavaScript client

Run `node cli.mjs --help` or `bun cli.mjs --help` for JSON command help. Set
`RELAY_URL` to the running local service origin and `RELAY_TOKEN` to a capability
for the target workspace. Each command prints one JSON value on success. Errors
produce one JSON error on stderr and a nonzero exit status. Commands share the
server's durable state; the CLI does not keep a second roster or token file.

For example, an editor can stage a synthetic CSV with
`node cli.mjs stage demo --file synthetic.csv --base-version 0 --key initial`.
A different approver subject approves the returned import ID, then a worker claims
and commits it. The claim result includes the lease token needed by the commit
command. Keep command output containing a lease token in memory rather than
redirecting it to disk. The `events` command accepts optional `--after` and
`--limit` flags; all other listed command options are required.

Import `createClient` and `RelayError` from `./sdk.mjs`. Construct a client with
`createClient({ baseUrl, token })`; neither value has a default. Methods return
the service's JSON response object, including the outer `workspace` or `import`
property. All methods are asynchronous. HTTP failures reject with a `RelayError`
whose `status` is the HTTP status, `code` is the service error code, and `message`
is the service message. Configuration and transport errors have status zero.
The adjacent `sdk.d.mts` declaration exports the exact workspace roles, import
states, member/import records, audit events, response shapes and client interface.

The client never follows redirects with a bearer capability. Network failures
use generic messages, while CLI errors additionally redact the configured URL,
capability and lease-token option. Server capability issuance and workspace
creation use the authenticated HTTP endpoints described in `BUILD_SPEC.md`;
the required CLI/SDK covers roster and import workflows.
