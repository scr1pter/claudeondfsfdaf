import { onCleanup } from "solid-js"
import { usePlatform } from "@/context/platform"
import { onCodiumChange } from "@/vector-account"

/** Events carry no credentials into this feature. Every notification retires the current authority conservatively. */
export function useAgentsAuthority(retire: () => void) {
  const platform = usePlatform()
  const unsubscribe = platform.vectorAccount?.onChange(() => retire())
  if (unsubscribe) onCleanup(unsubscribe)
  onCleanup(onCodiumChange(retire))
}
