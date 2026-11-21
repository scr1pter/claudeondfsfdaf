import { registerEverywhereRunHooks } from "./run-hooks.js"

/*
 * EV-30 (VE-30b): Vector everywhere's run start and settle listeners, registered once per process while the everywhere
 * config is on. Vercel bundles each function's own import graph, so @vector's two routes that tell listeners import
 * this module: api/cloud-agents/mint.ts (the start hook, R-A2) and api/cloud-agents/settle.ts (the settle hook, R-A3),
 * as the functions that read runs import cloud-agents-run-registration.ts. ESM evaluates it once per process, so a
 * process that loads both routes registers once.
 */

registerEverywhereRunHooks()
