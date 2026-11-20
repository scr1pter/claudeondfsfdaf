import {
  COMPUTER_SMOKE_REGION_WARM_MARK,
  warmComputerSmokeRegionCompiler,
} from "./computer-overlay-smoke-window-region"

// CI-only preparation before the real overlay proof. Any warm-up outcome is printed and the step still succeeds:
// the unchanged observer alone decides the region proof.
const result = await warmComputerSmokeRegionCompiler()
process.stdout.write(COMPUTER_SMOKE_REGION_WARM_MARK + JSON.stringify({ protocol: 1, ...result }) + "\n")
