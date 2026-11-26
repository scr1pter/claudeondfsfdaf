// The fixed synthetic child only inspects its own descriptor metadata. Its receipt contains no identities or bytes.
export const inspectOwnDescriptorMetadata = String.raw`(expected, fixedDescriptors) => {
  const { fstatSync, readdirSync } = require("node:fs")
  const descriptors = fixedDescriptors ?? readdirSync("/proc/self/fd")
  if (descriptors.length > 1024) throw new Error("Too many descriptors to attest")
  let stdout = false
  let matched = false
  for (const name of descriptors) {
    if (!/^\d+$/.test(name)) continue
    const fd = Number(name)
    let stat
    try {
      stat = fstatSync(fd, { bigint: true })
    } catch (error) {
      // The enumeration itself briefly opens a descriptor. It can already be closed here.
      if (error.code === "EBADF") continue
      throw error
    }
    if (fd === 1) stdout = true
    if (String(stat.dev) + ":" + String(stat.ino) === expected) matched = true
  }
  return { stdout, matched }
}`

export function descriptorReceipt(value: unknown, matched: boolean) {
  return (
    !!value &&
    typeof value === "object" &&
    "stdout" in value &&
    value.stdout === true &&
    "matched" in value &&
    value.matched === matched
  )
}
