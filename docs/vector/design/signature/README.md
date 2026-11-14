# Vector Signature: the v2 desktop redesign

This folder is the source of the Vector v2 redesign: every concept board, plus the specs behind them.

- **Live canvas (claude.ai, private to the owner's account):** https://claude.ai/artifact/H5htgm9tPE9WnxNoKMDwAG. It has 22 interactive boards in 8 rows, and each board's Tweaks switch its states.
- **Status (2026-11-14):** concept approved by the owner. Nothing is implemented yet.
- **Order of work:**
  1. Finish and merge every in-flight feature into `main`. See `docs/vector/build/v2-handoff.md`.
  2. Build this redesign behind a flag (`shell.signature`).
  3. Build the new features it shows: On-call, Plan and Artifacts (and the Simulator, the commands and the walkthrough).

## What the owner said, in substance

- **Sidebar and look:**
  - Keep the Signature sidebar, but with no project logo tiles.
  - The look should feel like the polished desktop coding apps: a calm graphite sidebar, hairlines, an opaque stage. It is not Apple's "liquid glass".
- **Blend with today's app:**
  - Keep today's top buttons (branch, Ready, Tasks, Changes, Terminal, usage, context ring), only smaller.
  - Keep today's account row: avatar, then "You · Codium Max", then Help and Settings.
  - Keep today's Changes screen as it is.
- **Composer:**
  - The chatbar follows the Signature design.
  - The chips under it are **one row**, never two. The host is an icon with a "This Mac" tooltip, followed by the project, model, mode, effort, speed and usage ring.
- **Browser:** match the owner's reference.
  - A page tab strip with "+", and dev servers, more, pop-out, expand and close on the right.
  - One slim row: back, forward, reload, a rounded URL field with an accent focus ring, and a pick-element button.
  - The empty state is a centred dev-server card ("vector-web :4321 ▶") that starts the server.
- **Fewer controls.** The owner said of crowding: "this is too much". New features must not add clutter.
- **Future features to place in the design:**
  - Plan, Artifacts and an iOS Simulator as side-panel panes, opened from one Panels button.
  - On-call as a sidebar item: @vector requests from GitHub, Slack, Linear and Jira.
  - Computer use as commands (`/computer`, `/cloud`, …) instead of buttons.
  - A short beginner walkthrough: a welcome card and four stops.

## Files

| File | What it is |
|---|---|
| `specs/1-concept.md` | The original Signature concept: sidebar, tokens (`--vxs-*`), native vibrancy, Live strip |
| `specs/2-blend.md` | The blend of Signature with today's app: header, composer, Changes, browser concepts A/B/C, one-row chips (section 4.4), browser reference (section 6.G), open decisions |
| `specs/3-screens.md` | Vectorscope, Settings, Tasks, Search, Connected tools and Automations screens |
| `specs/4-places.md` | Where the future features live: panes, On-call, commands, walkthrough. Section 7 has 13 open decisions |
| `canvas/canvas.json` | Canvas layout: board positions, row titles, notes |
| `canvas/*.dc.html` | The boards: Main, Sidebar, Chat, Changes, Tasks, Browser-A/B/C, Vectorscope-Home/Review, Settings-General/Models/Account, Search, Connections, Automations, Plan, Artifacts, Simulator, Oncall, Commands, Walkthrough |

The `.dc.html` files use the Design canvas format: an `<x-dc>` template plus one `class Component extends DCLogic` script. They render on the canvas above, not as plain web pages.

## Open decisions (owner)

- **Blend spec section 10:**
  - pickers below or inside the composer;
  - browser shape (A as the default, with B and C as modes, is recommended);
  - Settings as a full window or with the sidebar visible;
  - Vectorscope as its own screen;
  - the purple or neutral active state;
  - and others.
- **Screens spec section 10:** 12 items.
- **Places spec section 7:** 13 items:
  - the Panels button;
  - On-call as a sidebar item;
  - replacing today's 43-step tour;
  - On-call hours;
  - teammates;
  - and others.
