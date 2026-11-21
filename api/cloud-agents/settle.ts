import { cloudAgentsApi } from "../_lib/cloud-agents-api.js"
import "../_lib/everywhere/run-hooks-registration.js"

export const config = { api: { bodyParser: false } }
export default cloudAgentsApi.settle
