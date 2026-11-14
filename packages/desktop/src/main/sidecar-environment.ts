import { untrustedChildEnvironment } from "@vectordevai/core/child-environment"

// Splits the environment the engine sidecar starts with. Any process of the
// same user can read another process's launch environment (`ps eww` on macOS,
// /proc/<pid>/environ on Linux), and an agent's shell command is such a
// process. Launched with Vector's own secrets, the sidecar would hand that
// command the Vector Cloud bridge token, which runs account actions without the
// prompts the agent's tool asks, and the vault key the cloud credentials are
// encrypted with. So `launch` keeps only what untrusted children may see, and
// `secrets` travel in the sidecar's start message, which sets them in-process
// where a launch-environment read cannot see them.
//
// `start` holds values that only ever travel in the start message (the Hands bridge pair): they are removed from
// the launch environment even when a name alone would let it through.
export function sidecarEnvironment(source: NodeJS.ProcessEnv, start: Readonly<Record<string, string>> = {}) {
  const launch = untrustedChildEnvironment(source)
  for (const key of Object.keys(start)) delete launch[key]
  return {
    launch,
    secrets: {
      ...Object.fromEntries(
        Object.entries(source).flatMap(([key, value]) =>
          typeof value === "string" && !Object.hasOwn(launch, key) ? [[key, value] as const] : [],
        ),
      ),
      ...start,
    },
  }
}
