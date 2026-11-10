# Relay Directory

A local, dependency-free HTTP service for durable, approved roster imports. It runs with current Node.js or Bun. All examples use synthetic local data. No packages, cloud credentials or deployment are needed.

Set `RELAY_BOOTSTRAP_TOKEN` to a locally generated administrator secret and start:

```text
node app.mjs --data ABSOLUTE_DIRECTORY --port 4125
bun app.mjs --data ABSOLUTE_DIRECTORY --port 4125
```

Choose a data directory outside this source tree. `DATA_DIR` and `PORT` are optional defaults for the corresponding flags. Port `0` selects an available port. The service binds to `127.0.0.1` and prints one readiness JSON line after verifying its journal and acquiring exclusive ownership. Send `shutdown` followed by a newline to its stdin to drain requests and release ownership. `GET /health` is public.

Use the bootstrap capability to create a workspace with `POST /v1/workspaces`. The response contains its owner capability. Owners issue editor, approver, worker and viewer capabilities within their workspace. Stage CSV using an editor, approve using a different subject, and claim and commit using a worker. Each operation is authorized against current persisted capabilities. The bootstrap capability has no directory access.

`node cli.mjs --help` lists the JSON CLI commands. Set `RELAY_URL` to the local service URL and `RELAY_TOKEN` to a workspace capability. See [CLIENT.md](CLIENT.md) for CLI and SDK usage and [STORAGE.md](STORAGE.md) for the journal and process-lock format.

The SDK is exported by `sdk.mjs`, with matching declarations in `sdk.d.mts`. Import `createClient` and `RelayError` directly; no installation is required.

Verification uses only synthetic data under `DATA_DIR`. Run `node verification/integration.mjs` with `DATA_DIR` set outside the source tree. `RELAY_TEST_RUNTIME` can select the service/CLI runtime (for example the absolute Bun executable), while the verification runner itself runs in Node. The harness starts and stops its own local services and reports each group as JSON. See `VERIFICATION.md` for recorded checks and limits.
