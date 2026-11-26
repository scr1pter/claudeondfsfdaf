import type { IpcRenderer } from "electron"
import type { ReturnedGithubAgentsApi } from "../main/github-agents-returned-ipc"

export function returnedBrainPreloadApi(ipcRenderer: Pick<IpcRenderer, "invoke">): ReturnedGithubAgentsApi {
  return {
    returnedArtifacts: (input) => ipcRenderer.invoke("github-agents-returned-artifacts", input),
    previewReturned: (input) => ipcRenderer.invoke("github-agents-returned-preview", input),
    importReturned: (input) => ipcRenderer.invoke("github-agents-returned-import", input),
  }
}
