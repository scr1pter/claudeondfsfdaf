import { agentsApi } from "./agents-model"
import { createAgentsStatus } from "./agents-status"
import { useAgentsAuthority } from "./use-authority"

export function useAgentsStatus(cwd: () => string | undefined, onRetire?: () => void) {
  const live = createAgentsStatus({ cwd, api: agentsApi, onRetire })
  useAgentsAuthority(live.reload)
  return live
}
