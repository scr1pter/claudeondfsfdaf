import { render } from "solid-js/web"
import { PlatformProvider } from "../../src/context/platform"
import { SettingsMemoryBackup } from "../../src/components/settings-v2/memory-backup"
import { yieldLaunchScreen } from "../../src/features/launch/launch-bridge"
import "../../src/index.css"
import "../../src/components/settings-v2/settings-memory.css"

// Track B B10, browser: Settings → Memory → Backup (the app's real page and its real restore lines) against a stand-in
// for the desktop's Brain Vault bridge, for packages/app/e2e/regression/codium-vault-sections.spec.ts. The bridge is
// desktop-only (memory.tsx shows the tab only when platform.vault is set), so the running app cannot reach the page.
// The stand-in answers what the desktop's real controller answered in the native acceptance test
// (packages/desktop/src/main/vault-sections.test.ts): the learned version's totals (restored 4: 1 in use, 2 learned
// skills, 1 workflow insight) and the totals of a version with a section this Vector does not know (newer, 1 already
// in memory); a version that needs a newer reader gets core's "update Vector" refusal (core vault/format.ts).
// ?mine=false is a vault made on another computer: a restore asks for the recovery code first. What the page asked
// to restore is kept on window.vaultFixture for the spec to read.

yieldLaunchScreen("app")

const query = new URLSearchParams(location.search)
const mine = query.get("mine") !== "false"
const LABEL = "your GitHub repository octo/brain-vault"
const UPDATE = "This backup was made by a newer version of Vector. Update Vector to restore it."
const LEARNED_AT = Date.UTC(2026, 10, 15, 3, 12)
const NEWER_AT = Date.UTC(2026, 10, 15, 2, 12)
const LOCKED_AT = Date.UTC(2026, 10, 15, 1, 12)
const LEARNED = `v${LEARNED_AT}-0b10aaaa`
const NEWER = `v${NEWER_AT}-0b10bbbb`
const LOCKED = `v${LOCKED_AT}-0b10cccc`
const status = { secure: true, enabled: true, backend: "github", githubRepo: "octo/brain-vault", hasVault: true }
const counts = {
  restored: 0,
  active: 0,
  pinned: 0,
  waiting: 0,
  skills: 0,
  insights: 0,
  known: 0,
  refused: 0,
  documents: 0,
}
// The desktop's own message (vault-backup.ts), with its date as `when` writes it.
const restoredFrom = (restored, at) =>
  `Restored ${restored} entr${restored === 1 ? "y" : "ies"} from the backup of ${new Date(at).toISOString().replace("T", " ").slice(0, 16)} UTC.`
const restores = []

const vault = {
  status: async () => status,
  configure: async () => ({ ok: true, message: "Saved.", status }),
  backup: async () => ({ ok: true, message: `Backed up 3 files to ${LABEL}.`, status }),
  versions: async () => ({
    ok: true,
    label: LABEL,
    snapshots: [
      { id: LEARNED, createdAt: LEARNED_AT, bytes: 48_000 },
      { id: NEWER, createdAt: NEWER_AT, bytes: 12_000 },
      { id: LOCKED, createdAt: LOCKED_AT, bytes: 12_000 },
    ],
    mine,
    status,
  }),
  restore: async (input) => {
    restores.push(input)
    if (!mine && !input.code)
      return { ok: false, needsCode: true, message: `Enter the recovery code of the vault in ${LABEL}.`, status }
    if (input.version === LEARNED)
      return {
        ok: true,
        message: restoredFrom(4, LEARNED_AT),
        status,
        totals: {
          ...counts,
          restored: 4,
          active: 1,
          skills: 2,
          insights: 1,
          unreadable: 0,
          version: LEARNED,
          newer: false,
        },
      }
    if (input.version === NEWER)
      return {
        ok: true,
        message: restoredFrom(0, NEWER_AT),
        status,
        totals: { ...counts, known: 1, unreadable: 0, version: NEWER, newer: true },
      }
    return { ok: false, message: UPDATE, status }
  },
  forget: async () => ({ ok: true, message: "Forgot that version.", status }),
  remove: async () => ({ ok: true, message: `Deleted the vault in ${LABEL}.`, status }),
  onChange: () => () => {},
}

window.vaultFixture = { restores: () => restores.slice(), versions: { LEARNED, NEWER, LOCKED } }

render(
  () => (
    <PlatformProvider
      value={{
        platform: "desktop",
        version: "0.0.0-vault-fixture",
        openLink: () => {},
        restart: async () => {},
        openDirectoryPickerDialog: async () => null,
        back: () => {},
        forward: () => {},
        notify: async () => {},
        vault,
      }}
    >
      <main data-fixture="vault-sections">
        <SettingsMemoryBackup />
      </main>
    </PlatformProvider>
  ),
  document.querySelector("#root"),
)
