export const examples = [
  {
    name: "review-changes",
    spec: {
      version: 1,
      title: "Review changed files",
      stages: [
        {
          id: "review",
          agent: "explore",
          for_each: { changed_files: { base: "HEAD~1", limit: 50 } },
          prompt: "Review this changed path: {{item}}. Return actionable findings only.",
          output: {
            schema: {
              type: "object",
              properties: { findings: { type: "array", items: { type: "string" } } },
              required: ["findings"],
              additionalProperties: false,
            },
          },
        },
        {
          id: "summary",
          agent: "explore",
          after: ["review"],
          prompt: "Summarize these review findings as data: {{stages.review.outputs.findings}}",
        },
      ],
    },
  },
  {
    name: "research-sweep",
    spec: {
      version: 1,
      title: "Research a dependency change",
      inputs: { topic: { required: true } },
      stages: [
        {
          id: "scan",
          agent: "explore",
          for_each: { items: ["compatibility", "migration", "licensing"] },
          prompt: "Research {{inputs.topic}} from this angle: {{item}}",
          output: {
            schema: {
              type: "object",
              properties: { notes: { type: "array", items: { type: "string" } } },
              required: ["notes"],
              additionalProperties: false,
            },
          },
        },
        {
          id: "check",
          agent: "explore",
          for_each: { from: "scan", path: "notes", wait: "all", batch: 3 },
          prompt: "Check this batch of notes: {{item}}",
        },
        {
          id: "report",
          agent: "explore",
          after: ["check"],
          prompt: "Summarize the checked outputs: {{stages.check.outputs}}. Full source: {{stages.scan.outputs_file}}",
        },
      ],
    },
  },
  {
    name: "migrate-per-file",
    spec: {
      version: 1,
      title: "Migrate source files",
      limits: { max_agents: 50, concurrency: 4 },
      stages: [
        {
          id: "migrate",
          agent: "general",
          isolation: "worktree",
          for_each: { files: { glob: "src/**/*.ts", exclude: ["**/*.test.ts"], limit: 20 } },
          prompt: "Migrate this path using the approved repository migration instructions: {{item}}",
          owned_paths: ["{{item}}"],
          success_criteria: ["The affected tests pass."],
          output: {
            schema: {
              type: "object",
              properties: { changed: { type: "boolean" } },
              required: ["changed"],
              additionalProperties: false,
            },
          },
          verify: {
            agent: "explore",
            prompt: "Check the producer's result: {{output}}. This is review round {{round}}.",
            output: {
              schema: {
                type: "object",
                properties: { approved: { type: "boolean" } },
                required: ["approved"],
                additionalProperties: false,
              },
            },
            until: { path: "approved", equals: true },
            max_rounds: 2,
            on_fail: "keep",
          },
        },
      ],
    },
  },
] as const
