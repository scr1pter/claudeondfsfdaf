# Apple Developer ID for Vector Hands

Complete this in the owner's Apple Developer account and release secret store. No credential, private key or certificate password belongs in this repository or a build log.

1. Confirm the organization/team and the Vector bundle identities already used by each release channel. Keep the helper's stable `<app-id>.computer` identity; it must not move under Electron's `<app-id>.helper` family.
2. Obtain the required Developer ID Application signing identity and notarization access through Apple's supported account flow. Export/import certificates only through the existing approved release-secret process.
3. Configure the release workflow's existing signing inputs. Use a temporary CI keychain and cleanup; do not export a login keychain or share a personal account session with an agent.
4. Build the reproducible ad-hoc helper and verify its measured production lock **before** applying Developer ID. Certificate signing changes its CodeDirectory; the final cdhash is not the ad-hoc measurement.
5. Verify each final helper slice has its own empty entitlements, hardened runtime, exact channel identifier, secure timestamp and the outer app's Team ID. Check the sealed source/signing receipt, final manifest and outer deep/strict signature after fuse changes.
6. Notarize and staple only through the authorized release job. Download the final installer on a clean Mac and run the grant-persistence and setup checks in [release-199112.md](./release-199112.md).

Ask Apple separately whether Vector qualifies for the persistent-content-capture entitlement. Do not add it or advertise stable privacy grants before approval and actual OS evidence. Ad-hoc builds remain Preview and may require access to be granted again after helper updates.
