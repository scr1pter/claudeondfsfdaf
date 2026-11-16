import { productionJiraRoutes } from "../_lib/everywhere/runtime.js"

export const config = { api: { bodyParser: false } }
export const maxDuration = 60
export default productionJiraRoutes.uninstall
