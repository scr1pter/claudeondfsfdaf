import { productionSlackRoutes } from "../_lib/everywhere/runtime.js"

export const config = { api: { bodyParser: false } }
export default productionSlackRoutes.interactivity
