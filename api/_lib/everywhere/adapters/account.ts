import { ACCOUNT_ID_PATTERN } from "../../../../packages/schema/src/everywhere.js"
import { tombstoneKey } from "../../codium-tombstone.js"
import { ACCOUNT_TOMBSTONE_KEY } from "../authority-format.js"
import type { AccountAuthorityPort } from "../authority.js"

/** Only the server's deletion module chooses the mode and key; request JSON never supplies either. */
export const codiumAccountAuthority: AccountAuthorityPort = async (account) => {
  if (!ACCOUNT_ID_PATTERN.test(account)) return
  const owner = account.toLowerCase()
  const key = tombstoneKey(owner)
  if (!ACCOUNT_TOMBSTONE_KEY.test(key) || !key.endsWith(`:${owner}`)) return
  return Object.freeze({ tombstoneKey: key })
}
