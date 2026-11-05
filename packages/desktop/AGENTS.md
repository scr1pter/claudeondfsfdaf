# Desktop package notes

- Renderer process should only call `window.api` from `src/preload`.
- Main process should register IPC handlers in `src/main/ipc.ts`.

## Vector Hands native work

- Read `docs/vector/build/hands-progress.md`, the build spec and deviations before continuing the ordered native/release checkpoints.
- Coordinate one local Bun process at a time. Run named test files from their package and `bun typecheck`; full suites, native OS builds, packaging and Electron execution belong in CI.
- Do not use owner capture/input/clipboard/privacy settings as a test fixture. Native source coverage and injected tests are not evidence of actual granted OS behavior.
- Helper transport/lifecycle checks execute compiled bundles with actual Node. Bun may compile a bundle; do not replace the Node child runtime with Bun.
- Keep the measured macOS lock enforced. Verify exact source/artifact provenance before copying a candidate; never invent hashes. Already measured native/builder changes require a helper version bump.
- Preserve stable `computer` identifiers and per-channel helper bundle IDs. User-facing names come from `@vectordevai/schema/hands`.
- See `docs/vector/VECTOR-HANDS.md` and `docs/vector/owner-actions/release-199112.md` for signing order, manual evidence and owner release gates.
