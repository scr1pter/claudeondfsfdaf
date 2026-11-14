# A54: Image and hostd

A54 builds the cloud computer itself: the image every computer starts from, the boot step that locks it down on every
session, and hostd, the daemon that runs the session on the computer. It builds on A52 (the provider, the viewer port,
the run-API host) and A53 (the boot command, the heartbeat, viewer tokens, the files flow). No image was built, pushed
or baked, and no provider, GitHub, Cloudflare or other service was called. Nothing was deployed or pushed.

## What changed

| Area | Files |
|---|---|
| Image | `packages/hosted-computer/image/Dockerfile` (Alpine pinned by digest), `boot.sh`, `boot-lib.sh`, `nftables.conf`, `chromium-policies.json`, `credential-guard.js`, `viewer.html`, `viewer.js` |
| hostd | `src/hostd.ts` (entry, real services, the agent's socket), `daemon.ts` (session loop), `computer.ts` (actions and screenshots), `actions.ts` (the computer-use format), `guard.ts` (the browser's debugging pipe and the guard), `procs.ts` (pausing and reaping), `git.ts`, `recorder.ts`, `wipe.ts`, `run.ts`, `run-api.ts`, `limits.ts` |
| Viewer | `src/viewer-proxy.ts`, `rfb.ts`, `websocket.ts` |
| Scripts | `script/bake-snapshot.ts`, `script/microvm-check.ts` |
| Package | `package.json`, `tsconfig.json`, `.gitignore`, `.dockerignore`; root `bun.lock` (workspace entry only) |
| Tests | `test/image.test.ts`, `actions`, `computer`, `daemon`, `hostd`, `git`, `procs`, `recorder`, `wipe`, `credential-guard`, `viewer-proxy`, `bake-snapshot`, `source` (`.test.ts`); `test/docker/in-image.mjs` (runs inside the image in CI) |
| Schema and server | `packages/schema/src/hosted.ts` (`HANDOFFS`, `Heartbeat.generation`, `Heartbeat.handoff`, `HeartbeatAnswer.pack`); `api/_lib/hosted-sessions.ts` (parses and keeps them, sends `pack`); `test/hosted-sessions-api.test.ts` |
| CI | `.github/workflows/vector-codium.yml` (typecheck `hosted-computer`, job `hosted-image`); `.github/workflows/vector-codium-e2e.yml` (input `hosted`, job `hosted-microvm`) |
| Docs | `docs/vector/MODEL-PLANS.md`, `docs/vector/owner-actions/hosted-computer.md` ("The image"), `codium-deviations.md` ("A54 Image and hostd") |

No edits to `api/_lib/model-plan-*.ts`. No generator inputs changed.

## How it works

- **Boot** (`/opt/vector/boot.sh --run-host <host> --session <id>`, root, every session): checks the two arguments;
  verifies the base archive against the digest stamped in at build and reinstalls `/opt/vector` and the browser policy
  from it; refuses a disk below the image's minimum generation; loads the firewall and reads it back; mounts memory disks
  and the agent's 10 GB disk; starts the display (no TCP), VNC (a Unix socket only the viewer user can open), the viewer
  proxy (port 6080, its own user) and hostd. Any failure stops the boot before anything starts.
- **Firewall:** out loopback, replies, DNS to the resolvers in `/etc/resolv.conf`, tcp/443 and IPv6 neighbour
  discovery; in the viewer port and replies; the agent and the browser cannot reach the viewer port on loopback.
- **hostd** heartbeats every 30 seconds through the run-API host (node:https, only content-type, accept,
  content-length and user-agent headers, no credential). The first answer's job starts the agent as uid 10001 (setpriv:
  no new privileges, no capabilities, group share only, umask 022), the browser when the ramp allows (uid 10004, its
  sandbox on, `--remote-debugging-pipe`) and the recorder (2 fps, 1-minute segments). A take-over pauses every agent
  process and the recorder; wrapping asks the agent to finish and ends it 20 seconds before `wrapBy`; the end of a job,
  however it comes, stops the browser, wipes its profile and reports `done`. `pack` packs `/data/work`, the size is
  reported, the upload link's PUT follows, and the copy is dropped once accepted.
- **Actions** (`POST /v1/computer` on the agent's socket) take the local computer-use format and answer frames and
  JPEG/WebP data URLs at most 1280 wide. Before typing or pressing, hostd asks the credential guard in the browser;
  password, one-time-code and card fields and CAPTCHAs are refused and the computer handed to the person (the reason
  goes out as `handoff`).
- **Tool calls** (`POST /v1/tool`): at a call's end hostd kills its process group and anything started during it that
  left the agent's tree.
- **Git** (`POST /v1/git`): clone, fetch and push through mirrors only hostd configures, with a one-repository token per
  step while every agent process is paused; pushes to `vector/…` only, through a bundle.
- **Viewer proxy:** single-use, five-minute viewer tokens for this session, checked with the heartbeat's key; view
  connections get the picture only, control connections input only during a take-over.

## Tests run here (one file at a time)

| Package | File | Result |
|---|---|---|
| hosted-computer | `test/image.test.ts` | 20 pass, 3 skip (Docker, CI) |
| hosted-computer | `test/actions.test.ts` | 11 pass |
| hosted-computer | `test/computer.test.ts` | 14 pass |
| hosted-computer | `test/daemon.test.ts` | 8 pass |
| hosted-computer | `test/hostd.test.ts` | 14 pass |
| hosted-computer | `test/git.test.ts` (real git against local repositories) | 8 pass |
| hosted-computer | `test/procs.test.ts` | 4 pass |
| hosted-computer | `test/recorder.test.ts` | 3 pass |
| hosted-computer | `test/wipe.test.ts` | 2 pass |
| hosted-computer | `test/credential-guard.test.ts` | 7 pass |
| hosted-computer | `test/viewer-proxy.test.ts` (a real proxy and a stand-in VNC server) | 15 pass |
| hosted-computer | `test/bake-snapshot.test.ts` | 6 pass |
| hosted-computer | `test/source.test.ts` | 3 pass |
| root | `test/hosted-sessions-api.test.ts` | 25 pass, 1 skip (Valkey) |
| root | `test/hosted-copy.test.ts`, `test/hosted-reaper.test.ts` | 5, 21 pass |
| cloud | `src/workflow-compliance.test.ts` | 22 pass |

Also run here: `bun run build` once, then `node --check` on both bundles, importing them under Node (no Bun import in
either), and a Node smoke test of the bundled viewer proxy against a stand-in VNC socket. `boot.sh` ran up to its root
check; `boot-lib.sh`'s firewall and disk-generation steps ran with a stand-in `nft`.

Typecheck: `packages/hosted-computer` (`tsgo --noEmit`, src, tests and scripts), `packages/schema`, and the root
`tsconfig.json` (api) are clean.

What S7 needs and where it is checked: root-owned nftables that fail closed (`image.test.ts` statically and with a
stand-in `nft`; the Docker job boots the image privileged and unprivileged); the run-API host refusing browser
headers (A53's tests; hostd sends none, `hostd.test.ts`); GitHub tokens only inside hostd's git steps while the agent
is paused (`git.test.ts` with real git: never on a command line or on disk, only in mirror steps, pause before and
resume after, also on failure).

## CI only

- **The Docker job** (`hosted-image` in `vector-codium.yml`): builds the image with a stand-in CLI, boots it in a
  privileged container and runs `test/docker/in-image.mjs` (users, no sudo or setuid, the firewall, TCP listeners, the
  VNC socket, the agent's egress, the data disk, viewer tokens, the browser policy, the credential guard in a real
  Chromium, the wipe), then checks that boot fails closed without the right to load a firewall. Docker is not run on
  this Mac, so the Dockerfile has never been built: an Alpine package name, a binary path or an x11vnc flag that differs
  from what was written will first show there.
- **The real-microVM check** (`hosted-microvm` in `vector-codium-e2e.yml`, input `hosted`): needs Vercel's written OK,
  the hosted test team and four `codium-test` secrets. It is the only check of the firewall on the provider's kernel,
  the loop-mounted disk there, the provider keeping control after the firewall loads, A53's `sudo: true` boot on an
  image without sudo, and Chromium's sandbox.
- **Never exercised anywhere:** a real VCR push and bake, a real session end to end (the agent's side does not exist
  yet), recordings uploaded, and git against real GitHub.

## For later packages

- **The computer-use build (Codex):** the engine's computer tool can drive a cloud computer through
  `VECTOR_COMPUTER_SOCKET` (`POST /v1/computer {v: 1, input}`, the same input as the local tool), mark tool-call bounds on
  `/v1/tool` (with the call's process group), and use `/v1/git` for clone, fetch and push. Its Codium requests must go
  to the run-API host with no credential and no `Sec-Fetch-*` header (Node's fetch adds `sec-fetch-mode` by itself).
- **A55:** recordings are 1-minute segments in `/run/vector/rec/<session>/seg-NNNNN.ts` on the computer; uploading them
  for the report is A55's (hostd has no upload for them yet). Repository jobs need `POST
  /api/hosted/sessions/<id>/git-token {repository, access}` → `{token, expiresAt}` (a one-repository installation token,
  at most an hour), which no package has built.
- **A56:** the beat now holds `handoff {reason, since}`; status can show "Vector needs you" from it. The live view page
  is served by the computer at its viewer URL; control links close when control goes back to the agent (code 4001).
- **A58:** the image workflow builds `bun run build`, puts the musl CLI at `bin/vector`, builds with
  `VECTOR_IMAGE_GENERATION`, pushes to the hosted team's registry and runs `bake-snapshot.ts`. The Docker job may move into
  `vector-hosted-ci.yml`.
- **Server-side image floor:** hostd reports `generation`; making the server rebuild computers below a floor is not
  built.

## Not done

- No image was built, pushed or baked; no microVM was started.
- The git-token route, the agent-side wiring and recording uploads (above).
- bun.lock gains only the new workspace's entry. Nothing was pushed or deployed.
