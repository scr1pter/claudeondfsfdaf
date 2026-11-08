import { expect } from "bun:test"
import { Effect } from "effect"
import { reply } from "../../lib/llm-server"
import { cliIt } from "../../lib/cli-process"
import { testProviderConfig } from "../../lib/test-provider"

function text(body: Record<string, unknown>) {
  const messages: unknown[] = Array.isArray(body.messages) ? body.messages : []
  const user = messages.findLast(
    (message): message is Record<string, unknown> =>
      typeof message === "object" && message !== null && "role" in message && message.role === "user",
  )
  if (typeof user?.content === "string") return user.content
  const parts: unknown[] = Array.isArray(user?.content) ? user.content : []
  return parts
    .map((part) => (typeof part === "object" && part !== null && "text" in part && typeof part.text === "string" ? part.text : ""))
    .join("\n")
}

function hasTool(body: Record<string, unknown>) {
  return (Array.isArray(body.messages) ? body.messages : []).some(
    (message: unknown) => typeof message === "object" && message !== null && "role" in message && message.role === "tool",
  )
}

for (const format of ["default", "json"] as const)
  cliIt.concurrent(
    `nested first-step activity keeps an idle background run alive in ${format} output without permission prompts`,
    ({ llm, vector }) =>
      Effect.gen(function* () {
        const asking = (marker: string) => (hit: { body: Record<string, unknown> }) => text(hit.body).includes(marker)
        const code = "let count=0; console.log('nested-start'); const timer=setInterval(()=>{console.log('nested-active');if(++count===8)clearInterval(timer)},250)"
        const quote = (value: string) =>
          "'" + value.replaceAll("'", process.platform === "win32" ? "''" : "'\\''") + "'"
        const command = (process.platform === "win32" ? "& " : "") + quote(process.execPath) + " -e " + quote(code)

        yield* llm.pushMatch(
          (hit) => asking("launch nested survey")(hit) && !hasTool(hit.body),
          reply().tool("task", {
            description: "Coordinate the nested survey",
            prompt: "COORDINATOR_BRIEF: use the nested leaf and report its result.",
            subagent_type: "activity-coordinator",
            background: true,
          }),
        )
        yield* llm.pushMatch(
          (hit) => asking("launch nested survey")(hit) && hasTool(hit.body),
          reply().text("The survey is running; I will resume when it finishes."),
        )
        yield* llm.pushMatch(
          (hit) => asking("COORDINATOR_BRIEF")(hit) && !hasTool(hit.body),
          reply().tool("task", {
            description: "Inspect the nested component",
            prompt: "LEAF_BRIEF: run the bounded activity command, then report completion.",
            subagent_type: "general",
            background: false,
          }),
        )
        yield* llm.pushMatch(
          (hit) => asking("COORDINATOR_BRIEF")(hit) && hasTool(hit.body),
          reply().text("The nested survey is complete."),
        )
        // The leaf remains in its first provider/tool step longer than the
        // parent's idle deadline. Its real tool metadata supplies activity;
        // there is no permission prompt or completed-step discovery yet.
        yield* llm.pushMatch(
          (hit) => asking("LEAF_BRIEF")(hit) && !hasTool(hit.body),
          reply().tool("bash", { command, description: "Emit bounded nested progress" }),
        )
        yield* llm.pushMatch(
          (hit) => asking("LEAF_BRIEF")(hit) && hasTool(hit.body),
          reply().text("The component is checked."),
        )
        yield* llm.pushMatch(asking("task-notification"), reply().text("The nested result is verified."))

        const result = yield* vector.run("launch nested survey", {
          format,
          extraArgs: ["--dangerously-skip-permissions", "--size", "thorough"],
          env: {
            VECTOR_RUN_BACKGROUND_WAIT_MS: "1000",
            // A finished helper's note is held in the parent's note window (TaskNotify) before it goes out; keep that
            // window inside the 1s idle deadline so only the nested work's activity is under test.
            VECTOR_EXPERIMENTAL_NOTE_QUIET_MS: "100",
            VECTOR_EXPERIMENTAL_NOTE_HOLD_MS: "500",
            VECTOR_CONFIG_CONTENT: JSON.stringify({
              ...testProviderConfig(llm.url),
              agent: {
                "activity-coordinator": {
                  mode: "subagent",
                  description: "A test-only coordinator for nested activity",
                  permission: { task: { general: "allow" } },
                },
              },
            }),
          },
          timeoutMs: 50_000,
        })

        vector.expectExit(result, 0)
        expect(result.stderr).not.toContain("Stopped waiting for")
        expect(result.stdout).toContain("The nested result is verified.")
        // Root launch/pause/resume + coordinator and leaf continuations only.
        // No timer-driven inference is needed during the bounded shell work.
        expect(yield* llm.hits).toHaveLength(7)
      }),
    60_000,
  )
