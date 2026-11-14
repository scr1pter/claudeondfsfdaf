# Vector Hands: unreleased preparation and owner checklist

This is a review checklist, not authorization to publish installers or deploy a service. The source and native evidence ledger is [hands-progress.md](../build/hands-progress.md). Hands is unreleased. The owner will choose its release version after validation and review; keep `publishedDesktopVersion` at the actually published version until those installers are published.

## Reviewable release material

- User guide: [`/docs/vector-hands`](../../../packages/web/src/pages/docs/vector-hands.astro).
- Release entry and generated changelog: `packages/web/src/data/vector-releases.ts` and `packages/web/public/changelog.json`.
- Engineering/signing/identity procedures: [VECTOR-HANDS.md](../VECTOR-HANDS.md).
- Legal proposals: [hands-legal-draft.md](./hands-legal-draft.md). Existing privacy and terms pages are unchanged until explicit sign-off.

The feature name, helper icon and System Settings names require owner review. Bundle IDs, executable names, tool/config/IPC identifiers do not change with the brand. Production, beta and dev helpers have separate stable privacy identities.

## Evidence required before release

- Matching native build/reproducibility/core/OS matrix for the enforced measured helper lock, with immutable run IDs and actual reports.
- x64 and native ARM64 Windows unit, version, probe, protocol and lifecycle checks. A Windows-only run is not macOS evidence.
- Actual signing fixtures for unsigned and certificate paths, including the helper's own empty entitlements/runtime, final manifest/receipt, outer seal and post-fuse checks.
- Packaged verification of every shipping OS/architecture, production asar marker audit and actual compiled Windows pins.
- Real Electron overlay/Stop smoke on Linux, macOS and Windows, engine Node bundle smoke, desktop journey and final broad regression. Optional skips must remain named; a continued-on-error assertion failure is still a failure.

## Clean Mac checklist

Use a clean test account while Vector is not performing other work. Record OS version, architecture, build/channel/signing kind, helper version, source digest and exact result.

1. Start with Screen Recording and Accessibility absent. Verify setup explains both and opens the helper's own entries. Grant access yourself; no agent answers a privacy prompt.
2. Confirm the System Settings entry is Vector Hands (or its channel name), separately from Vector. Reopen after a genuine OS quit/reopen request and confirm the UI reports actual readiness.
3. Exercise app observation versus interaction, one-use and remembered approvals, identity changes, company denial and revocation during an active task.
4. Stop and Take over while typing/dragging; press Escape from another app and the configured global stop chord. Confirm no key/button remains held and a dead helper/engine removes the overlay.
5. Verify approved-only captures, notification and Vector masking, overlay exclusion, secure-field handoff, a browser extension prompt, and refused terminal/console/inspector routes.
6. Check a moved/resized window, multiple displays with different scales/negative origins, a non-US layout (including AZERTY), Unicode, an iOS Simulator flow and permitted background actions.
7. Lock/unlock, fast user switching, screen saver and sleep must revoke local action. No locked-session service or privilege change is installed.
8. Install a second build with the **unchanged helper**, then a build with an intentionally changed measured helper. Record grant persistence and whether macOS asks again; do not promise persistence from source inspection.

Reset remains disabled until its helper-only, no-administrator behavior is verified on **macOS 14, 15, 26 and 27**. Record all four results before setting the release build's `VECTOR_COMPUTER_RESET_VERIFIED=1`. A runtime environment setting cannot enable it. Ask Apple about eligibility for the persistent-content-capture entitlement separately; no entitlement is added by this checklist.

## Windows 11 checklist

Use a normal user session with real UAC enabled and Vector running without administrator rights.

Before these checks, open **Settings › Vector Hands** and choose **Start calibration** under **Verify takeover detection**. Move the real mouse or touchpad pointer, then press and release the same **Shift** key. Require **Mouse delivery: Verified**, **Keyboard delivery: Verified**, and **Calibrated — listener healthy**; wait for any **Checking listener health…** message to finish. Verify that incomplete gestures, injected input or listener health alone cannot complete calibration. Listener health checks the current listener, input routes and context; it does not continuously prove hardware delivery. Calibration must leave a paused run paused: explicitly choose **Finish** to enable Hands during setup or **Resume** for an existing run. Repeat after a helper/listener restart and exercise readiness loss during a run; configurations that cannot calibrate stay unavailable.

1. Exercise actual UAC secure desktop and an elevated app: both must hand off without capture/input. Also check a consent prompt configured on the ordinary desktop.
2. Verify a non-default/inaccessible input desktop, locked session, changed user/logon context and capture denial stop action truthfully.
3. Run actual pointer/Unicode/layout/drag/hold, Stop/takeover, helper crash and guardian recovery tests. Confirm synthetic input does not count as physical input and genuine hardware input revokes before further action.
4. Check multi-monitor DPI/negative origins, screen capture masking/affinity, secure edit controls and foreground-only UIA actions.
5. Run packaged checks on x64 and ARM64. Record Authenticode/Smart App Control/Defender results for the actual final bytes; a CI restricted-token fixture cannot prove real UAC behavior.

Complete [Apple Developer ID](./apple-developer-id.md) and Azure Trusted Signing setup through their owner accounts. Until Windows signing is available, document the unsigned preview posture and submit actual false positives to Microsoft's portal. Do not disable OS protection or install UIAccess workarounds.

## Provider and publication gates

The Codium gateway must accept images on Hands turns before releasing image-based Codium operation. Until the corresponding deployment is complete, Codium remains in screen-reader mode. A source change is not proof that the gateway is deployed.

Owner approval is required for the final docs/release notes, helper name/icon and any legal change. Then follow the existing release approval and signing workflow. Do not merge `hands` into `main`, tag/release, deploy the gateway/site, publish installers or change credentials merely because source work is complete.
