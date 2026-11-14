// Help-text snapshots for every CLI command + key subcommand. Catches
// accidental flag removals, renames, and reordering in a single sweep —
// any change to the user-visible CLI surface shows up here as a diff.
//
// This is the broad coverage layer that makes the future Effect CLI
// migration (yargs → effect-smol/cli) safe to attempt: if a refactor
// preserves the surface, the snapshots stay green; if it doesn't, the
// diff tells you exactly which command(s) changed.
//
// Snapshots are taken at COLUMNS=120 so wrapping is stable across
// terminal sizes. The default vector tui command is excluded —
// `vector --help` includes an ASCII banner that pulls in the install
// version (changes per release), so we'd snapshot a moving target.
import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { cliIt } from "../../lib/cli-process"
import { normalizeForSnapshot, PATH_SEP } from "../../lib/snapshot"

// Composes `normalizeForSnapshot` (CRLF + tmpdir) with two help-specific
// rules:
//
//   1. The harness's `vector-cli-XXX` subdir under TMPDIR collapses to `<HOME>`.
//      `PATH_SEP` matches `/` and `\\` so the rule works on POSIX + Windows.
//
//   2. yargs wraps the `[string] [default: "..."]` clause based on the
//      pre-normalized default's character length, so different random home
//      path widths produce different leading-whitespace counts (or even
//      line-wraps onto a fresh line on Windows). `\s+` matches both forms.
function normalize(text: string): string {
  // Migration warnings are covered separately and are not part of the help body.
  return normalizeForSnapshot(text.replace(/^\[Vector\] VECTOR_.*deprecated; use VECTOR_.*instead\.\n/gm, ""), {
    pathReplacements: [
      // Mixed-case [A-Za-z0-9] because node's mkdtemp suffix is mixed-case
      // (the harness now uses FileSystem.makeTempDirectoryScoped under the
      // hood). A `[a-z0-9]+` regex would leave uppercase chars trailing.
      [new RegExp(`<TMPDIR>${PATH_SEP}vector-cli-[A-Za-z0-9]+`, "g"), "<HOME>"],
      [/\s+\[string\] \[default: "<HOME>"\]/g, ' [string] [default: "<HOME>"]'],
    ],
  })
}

// Top-level commands. Order matches what `vector --help` prints today;
// keep it in that order so the snapshot file reads as a table of contents.
// `completion` is intentionally excluded — it's a yargs built-in that emits
// top-level help on `--help` and exits 1; not a real vector command.
const TOP_LEVEL = [
  "acp",
  "mcp",
  "attach",
  "run",
  "debug",
  "providers", // aliased to `auth`
  "org",
  "agent",
  "upgrade",
  "uninstall",
  "serve",
  "web",
  "models",
  "stats",
  "export",
  "import",
  "github",
  "pr",
  "review",
  "session",
  "connected",
  "workflow",
  "plugin",
  "db",
] as const

// Subcommands worth pinning. Not exhaustive — the goal is one snapshot per
// distinct argv shape, not every leaf. Add new entries when a subcommand
// gains user-visible flags that we want to lock in.
const SUBCOMMANDS = [
  ["mcp", "list"],
  ["mcp", "add"],
  ["mcp", "auth"],
  ["mcp", "logout"],
  ["providers", "list"],
  ["providers", "login"],
  ["providers", "logout"],
  ["auth", "plugin"],
  ["auth", "plugin", "approve"],
  ["auth", "plugin", "revoke"],
  ["auth", "plugin", "list"],
  ["org", "list"],
  ["org", "switch"],
  ["org", "personal"],
  ["agent", "create"],
  ["agent", "list"],
  ["session", "list"],
  ["session", "delete"],
  ["github", "install"],
  ["github", "run"],
  ["github", "review"],
  ["db", "path"],
] as const

// Fixed wrap width so a developer's terminal doesn't affect snapshots.
// yargs honors COLUMNS; CI runners typically default to 80 which produces
// different wraps from a 200-col local terminal.
const SNAPSHOT_ENV = { COLUMNS: "120" }

describe("vector CLI help-text snapshots", () => {
  cliIt.live(
    "connected tools appear in top-level help only with the explicit experimental opt-in",
    ({ vector }) =>
      Effect.gen(function* () {
        for (const [broad, connect, visible] of [
          ["0", "0", false],
          ["0", "1", true],
          ["1", "0", false],
        ] as const) {
          const result = yield* vector.spawn(["--help"], {
            env: { ...SNAPSHOT_ENV, VECTOR_EXPERIMENTAL: broad, VECTOR_EXPERIMENTAL_CONNECT: connect },
          })
          expect(result.exitCode).toBe(0)
          expect(result.stderr.includes("vector connected")).toBe(visible)
        }
      }),
    60_000,
  )

  // Single test, parallel spawns. Each command's help fires under
  // `concurrency: 8` — wall-clock stays under ~10s even for ~35 commands,
  // versus ~1 minute if we serialized.
  cliIt.live(
    "every documented command emits stable help text",
    ({ vector }) =>
      Effect.gen(function* () {
        const topLevel = yield* vector.spawn(["--help"], { env: SNAPSHOT_ENV })
        expect(topLevel.exitCode).toBe(0)
        expect(topLevel.stderr.endsWith("\n")).toBe(true)
        expect(topLevel.stderr).toContain("--mini")
        expect(topLevel.stderr).not.toContain("--thinking")
        expect(topLevel.stderr).not.toContain("--variant")
        expect(topLevel.stderr).not.toContain("--demo")

        const argvs: Array<readonly string[]> = [...TOP_LEVEL.map((c) => [c] as const), ...SUBCOMMANDS]

        // Spawn in parallel, then assert in argv order so snapshot output is
        // deterministic and per-command failures don't abort the rest of
        // the sweep. `Effect.partition` is the canonical "run all, separate
        // failures from successes" primitive — no mutable accumulator needed.
        const [failures, results] = yield* Effect.partition(
          argvs,
          (argv) =>
            Effect.gen(function* () {
              const result = yield* vector.spawn([...argv, "--help"], { env: SNAPSHOT_ENV })
              if (result.exitCode !== 0) {
                return yield* Effect.fail(`vector ${argv.join(" ")}: exit ${result.exitCode}`)
              }
              return { argv, result }
            }),
          { concurrency: 8 },
        )

        for (const { argv, result } of results) {
          // yargs writes --help to stderr, not stdout. Snapshotting stderr
          // means our test catches the help body; stdout for these commands
          // is expected to be empty.
          expect(normalize(result.stderr)).toMatchSnapshot(`vector ${argv.join(" ")} --help`)
        }
        if (failures.length > 0) {
          throw new Error(`Help text failed for:\n  ${failures.join("\n  ")}`)
        }
      }),
    180_000,
  )
})
