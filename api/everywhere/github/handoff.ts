import { createGithubHandoff } from "../../_lib/everywhere/github/adapter.js"
import { productionHandoffDeps } from "../../_lib/everywhere/runtime.js"

export const maxDuration = 60
export default createGithubHandoff(productionHandoffDeps())
