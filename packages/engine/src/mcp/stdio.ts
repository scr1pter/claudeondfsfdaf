import { ProcessIsolation } from "@vectordevai/core/process-isolation"
import { untrustedChildEnvironment } from "@vectordevai/core/child-environment"

/** The SDK owns transport cleanup; the shared launch floor owns the kernel boundary. */
export async function localTransport(input: {
  command: string
  args: string[]
  cwd: string
  env: Record<string, string>
}) {
  const { StdioClientTransport } = await import("@modelcontextprotocol/sdk/client/stdio.js")
  const isolated = ProcessIsolation.launch(input.command, input.args, { cwd: input.cwd })
  return new StdioClientTransport({
    command: isolated.file,
    args: isolated.args,
    cwd: input.cwd,
    env: untrustedChildEnvironment(input.env),
    stderr: "pipe",
  })
}
