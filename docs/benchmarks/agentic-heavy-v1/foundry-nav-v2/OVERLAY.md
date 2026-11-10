# Foundry project-navigation evaluator overlay

This is a separate correction to the evaluator's navigation precondition. The
original Foundry task, original paid plan, application deliveries, failed checks,
repair attempt and every charge remain unchanged.

Re-selecting the Projects navigation item can legitimately preserve an open
board. The old helper then looked for a project-list opener that was no longer
on screen. The corrected helper uses a visible **All projects** action when
needed, then still clicks the exact **Open project <target name>** control and
requires the visible **New task** control. It never accepts an arbitrary already
open board as the target, manipulates app state, or skips a workflow check.

The task JSON, wrapper, owned-process helper, empty scaffold and public build
specification are byte-identical. Seventeen of the eighteen original instrument
files are byte-identical; only `instrument/browser-eval.cjs` changes. Its exact
patch and old/new byte hashes are recorded in `helper.diff` and `overlay-provenance.json`.
All 32 API groups, 40 browser checks and four prerequisites remain required.

The evaluator command is the original `task.json` command, with `{task}` bound
explicitly to this directory. A continuation must freeze this entire overlay
manifest and disclose this substitution separately from the original paid plan.
This correction does not repair the application's bodyless order-cancel or
mobile overflow issues. Previously skipped workflows remain unverified until a
separate evaluation actually executes them on unchanged source.

Pure controls: `python -B -m unittest test_overlay -v` from this directory.
Real Chromium controls, when the coordinating agent grants the browser lease:

```text
node project-navigation-control.cjs --playwright <absolute installed module> --chrome <absolute Chrome executable> --out <new private output directory>
```

Qualification on November 2, 2026 (Pacific), made zero model/funded-meter calls:

- Six overlay byte/materialization controls, eleven unchanged Python instrument
  controls and thirty unchanged Node browser-helper controls passed.
- Ten real Chromium navigation controls passed, including missing exact opener,
  wrong board without a return action, no-op/hidden return actions, a target that
  does not open and a near-label opener. These are synthetic DOM controls.
- The known-positive, unchanged seventeen-file readiness-first application passed
  all 76 checks under this overlay. Its authored manifest is
  `b737c29f677d67d64961bbec1239420828947606ba5ef33af9edcbcaffc987be`.
- The unchanged thirty-nine-file Vector heavy delivery passed 74/76 with zero
  not-run checks. Its authored manifest is
  `4675be85beaa531ce3525bceca3a673659ed3c0f8e9e225aae634daa743f352e`.
  Bodyless order cancellation still returns400, and Customers/Inventory/Orders
  still overflow the mobile document. Both genuine failures remain failures.

The original Vector evaluation retains 64 passes, four failures and eight
not-run checks. The original 300-call episode, unchanged repair snapshots,
request-limit/failure flags and all charges are retained separately. This free
result corrects the evaluation precondition; it is neither a paid repair nor an
application fix, and it establishes no cost-saving or general quality claim.

The original provenance, qualification, README and hash-assertion controls are retained
byte-for-byte as historical artifacts. `test_overlay.py` supplies the updated
allowed-diff/hash checks; the old exact-original-browser hash assertion is not
applicable to the explicitly changed helper.

Before reproducing a raw-byte freeze on a different checkout, explicitly run
`python -B materialize.py`. It restores only LF/CRLF spellings whose exact
recorded hash matches, and refuses other changes or paths outside this overlay.
This handles historical metadata line endings without modifying its contents.
The original paid-plan byte manifest is
`59244487c280c959a3b517765c2b8b3d4dc176500f2a2046e22519718454b596`.
The older standalone qualification directory had four metadata newline
differences; the overlay uses the actual original paid-plan spellings. No
executable, scaffold, specification or browser-helper bytes changed during that
metadata alignment.

`qualify.py` runs the same wrapper on a new private copy of an explicitly supplied
synthetic source tree and installed dependency directory. It records before/after
authored hashes and retains all 76 per-check outcomes. It never reads funding
configuration or calls a model. Original application sources remain untouched.
