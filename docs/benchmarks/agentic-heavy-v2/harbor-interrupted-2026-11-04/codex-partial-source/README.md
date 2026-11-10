# Harbor

A synthetic local release and incident operations console. No jobs execute commands or contact external systems.

```powershell
$env:DATA_DIR = 'C:\path\outside-source\harbor-data'
$env:PORT = '3000'
$env:WORKER_LIMIT = '2'
bun run typecheck
bun run build
bun run start
```

Open `http://127.0.0.1:3000`. Select an actor with the Actor control. Owen Operator can create and submit a protected release; Avery Admin can approve it. Authors cannot approve their own submissions. Val Viewer has read access. These are durable local simulation sessions, not production authentication.

Create a project, environments and a runbook, then create a release from its versioned snapshot. Step dependencies refer to step keys. A `once` failure can succeed after retry. Successfully completed jobs produce downloadable text artifacts; rollback restores a previous successful release in the same environment. Incidents retain status history and notes.

The default worker limit is two (valid range one through four). SQLite, durable sessions, queue state and generated artifacts remain under `DATA_DIR`; without that variable the server uses a `support-data` directory beside this source directory. Frontend assets are served from `dist`, including deep-link fallback.

With the server already running, `bun scripts/verify-api.ts` creates an isolated synthetic project and checks HTTP workflows. It retains those records as verification evidence. Browser verification uses only the separately supplied common browser client.
