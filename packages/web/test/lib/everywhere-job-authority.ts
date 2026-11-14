import { randomBytes } from "node:crypto"
import { accountGuards, authorizedCommands, checkAccount } from "../../../../api/_lib/everywhere/authority"
import { installationAuthority, installGuards, linkMember, readInstallSnapshot, readInstallState, readLinkSnapshot } from "../../../../api/_lib/everywhere/identity"
import type { JobsContext, NewJob } from "../../../../api/_lib/everywhere/jobs"
import { everywhereKeys, userIdValid } from "../../../../api/_lib/everywhere/keys"
import { sha256Hex } from "../../../../api/_lib/everywhere/signature"
import { getValue } from "../../../../api/_lib/everywhere/store"
import { ACCOUNT_ID_PATTERN, installationPlatform } from "../../../../packages/schema/src/everywhere"

/** Generated persisted authority for isolated state-machine tests; native intake tests use real linking workflows. */
export async function seedJobAuthority(ctx: JobsContext, input: Pick<NewJob, "platform" | "installation" | "sponsor" | "requester">) {
  if (input.platform === "github") return
  if (installationPlatform(input.installation) !== input.platform || !ACCOUNT_ID_PATTERN.test(input.sponsor) ||
    !userIdValid(input.installation, input.requester.userId)) throw new Error("Invalid fixture native identity")
  const account = input.sponsor.toLowerCase()
  await checkAccount(ctx, account)
  let install = await readInstallSnapshot(ctx.store, input.installation)
  if (!install) {
    if (await readInstallState(ctx.store, input.installation) ||
      await getValue(ctx.store, everywhereKeys.installEpoch(input.installation)) !== undefined)
      throw new Error("Fixture cannot seed over a closed or retired installation")
    const revision = randomBytes(16).toString("base64url")
    await authorizedCommands(ctx.store, [...await accountGuards(ctx, account),
      { key: everywhereKeys.install(input.installation) }, { key: everywhereKeys.installEpoch(input.installation) }], [
      ["SET", everywhereKeys.install(input.installation), JSON.stringify({ connector: account, revision, scopes: [], installedAt: ctx.now })],
      ["SET", everywhereKeys.installEpoch(input.installation), revision],
      ["SADD", everywhereKeys.installs(account), input.installation],
    ])
    install = await readInstallSnapshot(ctx.store, input.installation)
  }
  if (!install) throw new Error("Fixture native authority missing")
  let linked = await readLinkSnapshot(ctx.store, input.installation, input.requester.userId)
  if (linked && linked.record.account !== account) throw new Error("Fixture requester belongs to another account; choose a distinct native user")
  const guards = [...await accountGuards(ctx, account), ...await installGuards(ctx, input.installation, install),
    { key: everywhereKeys.link(input.installation, input.requester.userId), value: linked?.raw }]
  if (!linked) {
    await authorizedCommands(ctx.store, guards, [
      ["SET", everywhereKeys.link(input.installation, input.requester.userId), JSON.stringify({ account, linkedAt: ctx.now, revision: randomBytes(16).toString("base64url") })],
      ["SADD", everywhereKeys.linked(input.installation), input.requester.userId],
      ["SADD", everywhereKeys.links(account), linkMember(input.installation, input.requester.userId)],
    ])
    linked = await readLinkSnapshot(ctx.store, input.installation, input.requester.userId)
  }
  if (!linked) throw new Error("Fixture person authority missing")
  // Repair only fixture indexes while preserving the exact existing grant and
  // person. This cannot turn a changed or held grant into fresh authority.
  await authorizedCommands(ctx.store, [...await accountGuards(ctx, account), ...await installGuards(ctx, input.installation, install),
    { key: everywhereKeys.link(input.installation, input.requester.userId), value: linked.raw }], [
    ["SADD", everywhereKeys.installs(install.record.connector), input.installation],
    ["SADD", everywhereKeys.linked(input.installation), input.requester.userId],
    ["SADD", everywhereKeys.links(account), linkMember(input.installation, input.requester.userId)],
  ])
  return {
    installationRecord: install.raw,
    linkRecord: linked.raw,
    installRevision: installationAuthority(install),
    linkRevision: linked.record.revision ?? sha256Hex(linked.raw),
  }
}
