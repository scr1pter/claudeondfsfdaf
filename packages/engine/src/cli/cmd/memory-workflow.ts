import { EOL } from "os"
import { Effect } from "effect"
import { Brain } from "@vectordevai/core/brain/brain"
import type { BrainSchema } from "@vectordevai/core/brain/schema"
import { BrainWorkflow } from "@vectordevai/core/brain/workflow"
import { TaskSize } from "@vectordevai/core/task-size"
import { Instruction } from "@/session/instruction"
import { effectCmd, fail } from "../effect-cmd"
import { CliOwnerGate } from "../owner-gate"
import { UI } from "../ui"

// `vector memory workflow`: what the build agent's runs in the repository in the current directory passed with and cost,
// by size, and the cheaper default they support, as Settings > Memory > Workflow insights shows it. Reading it is open
// to the agent; changing the mode, exploring or resetting is the owner's. `--size` and `--variant` always win.

const TIERS = ["light", "standard", "thorough"] as const

export const MemoryWorkflowCommand = effectCmd({
  command: "workflow",
  describe: "see what effort, subagents and models got this repository's checks passing, and at what cost",
  builder: (yargs) =>
    yargs
      .command(MemoryWorkflowModeCommand)
      .command(MemoryWorkflowExploreCommand)
      .command(MemoryWorkflowResetCommand)
      .option("tier", { describe: "only this size", choices: TIERS })
      .option("json", { describe: "print JSON", type: "boolean", default: false }),
  handler: Effect.fn("Cli.memory.workflow")(function* (args) {
    const memory = yield* where
    const insights = yield* memory.workflow.insights(memory.place)
    const tiers = insights.tiers.filter((item) => !args.tier || item.tier === args.tier)
    if (args.json) return void process.stdout.write(`${JSON.stringify({ ...insights, tiers }, null, 2)}${EOL}`)
    UI.println(`Mode: ${MODE[insights.mode]}. Exploring: ${insights.explore ? "on" : "off"}.`)
    for (const item of tiers) {
      UI.empty()
      const advice = item.advice ?? item.wouldAdvise
      UI.println(
        `${UI.Style.TEXT_HIGHLIGHT_BOLD}${TaskSize.label(item.tier)}${UI.Style.TEXT_NORMAL}: ${
          advice
            ? `${item.advice ? "learned default" : "would use"} ${choice(advice)}. ${advice.reason}`
            : `the size's own defaults (${TaskSize.effort(item.tier)} effort)`
        }`,
      )
      if (item.arms.length === 0) UI.println(UI.Style.TEXT_DIM + "  No runs yet." + UI.Style.TEXT_NORMAL)
      for (const arm of item.arms) UI.println(`  ${row(arm)}`)
      if (item.excluded > 0)
        UI.println(
          UI.Style.TEXT_DIM +
            `  ${item.excluded} run${item.excluded === 1 ? "" : "s"} left out: you, the agent or config chose the effort, or the run read the web.` +
            UI.Style.TEXT_NORMAL,
        )
    }
    UI.empty()
    UI.println(UI.Style.TEXT_DIM + OWN + UI.Style.TEXT_NORMAL)
  }),
})

export const MemoryWorkflowModeCommand = effectCmd({
  command: "mode <mode>",
  describe: "apply: use learned defaults (the default). observe: only record runs. off: record nothing",
  builder: (yargs) => yargs.positional("mode", { choices: ["apply", "observe", "off"] as const, demandOption: true }),
  handler: Effect.fn("Cli.memory.workflow.mode")(function* (args) {
    yield* CliOwnerGate.refuse("change workflow insights")
    const brain = yield* Brain.Service
    const settings = yield* brain.setLearnSettings({ workflow: args.mode })
    UI.println(`Workflow insights: ${MODE[settings.workflow]}.`)
  }),
})

export const MemoryWorkflowExploreCommand = effectCmd({
  command: "explore <state>",
  describe: "try a setting cheaper by construction on one request in ten while it has too few runs (off by default)",
  builder: (yargs) => yargs.positional("state", { choices: ["on", "off"] as const, demandOption: true }),
  handler: Effect.fn("Cli.memory.workflow.explore")(function* (args) {
    yield* CliOwnerGate.refuse("change workflow exploration")
    const brain = yield* Brain.Service
    const settings = yield* brain.setLearnSettings({ workflowExplore: args.state === "on" })
    UI.println(`Exploring is ${settings.workflowExplore ? "on" : "off"}.`)
  }),
})

export const MemoryWorkflowResetCommand = effectCmd({
  command: "reset",
  describe:
    "forget the runs workflow insights learned from here (Settings > Memory also clears the app's model recommendations)",
  builder: (yargs) =>
    yargs
      .option("tier", { describe: "only this size", choices: TIERS })
      .option("yes", { describe: "confirm", type: "boolean", default: false }),
  handler: Effect.fn("Cli.memory.workflow.reset")(function* (args) {
    yield* CliOwnerGate.refuse("reset workflow insights")
    const what = args.tier ? `${TaskSize.label(args.tier)} runs` : "every run"
    if (!args.yes)
      return yield* fail(
        `This forgets ${what} workflow insights learned from here. Run it again with --yes to confirm.`,
      )
    const memory = yield* where
    const removed = yield* memory.workflow.reset(memory.place, args.tier ? { tier: args.tier } : {})
    UI.println(UI.Style.TEXT_SUCCESS_BOLD + `Forgot ${removed} run${removed === 1 ? "" : "s"}` + UI.Style.TEXT_NORMAL)
  }),
})

const MODE: Record<BrainSchema.WorkflowLearning, string> = {
  apply: "apply learned defaults",
  observe: "observe only",
  off: "off",
}

const OWN =
  "Your own picks always win. Learned defaults only drop Thorough's extra effort, skip subagents or use a cheaper subagent model; spend caps are unchanged."

const where = Effect.gen(function* () {
  const instruction = yield* Instruction.Service
  return { workflow: yield* BrainWorkflow.Service, place: yield* instruction.place() }
})

function choice(advice: BrainWorkflow.Advice) {
  return [
    advice.effort ? "default effort" : undefined,
    advice.split ? "working solo" : undefined,
    advice.subagentModel ? "the small model for subagents" : undefined,
  ]
    .filter((item): item is string => item !== undefined)
    .join(", ")
}

// One arm: effort · split · model, runs, pass rate, checked share and cost. Unknown cost is said, never shown as $0.
function row(stats: BrainWorkflow.ArmStats) {
  const arm = stats.arm
  const split =
    arm.split === "solo" ? "solo" : arm.subagentModel === "small" ? "subagents on the small model" : "subagents"
  const rate = stats.passRate === undefined ? "no checked runs" : `${Math.round(stats.passRate * 100)}% passed`
  const cost = stats.costUsd === undefined ? "cost unknown" : `avg $${stats.costUsd.toFixed(2)}`
  return `${arm.effort} effort · ${split} · ${arm.providerID}/${arm.modelID}: ${stats.rows} run${stats.rows === 1 ? "" : "s"}, ${rate}, ${Math.round(stats.checkedShare * 100)}% checked, ${cost}`
}
