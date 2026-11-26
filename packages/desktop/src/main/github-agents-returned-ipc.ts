import type { GithubAgentsAPI } from "../../../app/src/features/github-agents/agents-model"

export type ReturnedGithubAgentsApi = Pick<GithubAgentsAPI, "returnedArtifacts" | "previewReturned" | "importReturned">

export function registerGithubAgentsReturnedIpc<Event>(
  handle: (channel: string, listener: (event: Event, input: unknown) => unknown) => void,
  assertTrustedRenderer: (event: Event) => void,
  api: ReturnedGithubAgentsApi,
) {
  const add = <Input>(channel: string, run: (input: Input) => unknown) =>
    handle(channel, (event, input) => {
      assertTrustedRenderer(event)
      return run(input as Input)
    })

  add("github-agents-returned-artifacts", api.returnedArtifacts)
  add("github-agents-returned-preview", api.previewReturned)
  add("github-agents-returned-import", api.importReturned)
}
