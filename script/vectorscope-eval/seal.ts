import {
  constants,
  createCipheriv,
  createDecipheriv,
  createPrivateKey,
  createPublicKey,
  privateDecrypt,
  publicEncrypt,
  randomBytes,
  type KeyObject,
} from "node:crypto"

// Sealing to the owner's key, shared by the paid eval job (ci.ts seal and unseal) and the outcome ledger (outcomes.ts,
// VS-46a). It imports node:crypto only, so a script that seals loads no model-sending code: ci.ts re-exports these
// names, and outcomes.ts imports this file rather than ci.ts, which loads run.ts and the replay drivers.

// A vectorscope-eval environment variable (not a secret): the owner's RSA public key in PEM form. Paid mode refuses
// to start without it, so no result can reach the artifact unsealed.
export const PUBLIC_KEY_ENV = "VECTORSCOPE_EVAL_PUBLIC_KEY"
export const SEALED_SCHEMA = "vectorscope-sealed/1"
// The outcome ledger's only file inside its sealed bundle (VS-46a). A sealed ledger expires 180 days after collection,
// and only `outcomes.ts open` checks that, so ci.ts unseal refuses a bundle that holds it.
export const OUTCOME_LEDGER_FILE = "outcomes-ledger.json"
const MIN_KEY_BITS = 3072

// The owner's public key, or why it cannot seal: RSA of at least MIN_KEY_BITS bits, in PEM form.
export function publicKey(pem: string | undefined): KeyObject | string {
  const missing = `${PUBLIC_KEY_ENV} must be the owner's RSA public key (PEM, at least ${MIN_KEY_BITS} bits), set as a variable of the vectorscope-eval environment. The repository is public, so results are uploaded only sealed to it.`
  if (!pem?.trim()) return missing
  try {
    const key = createPublicKey(pem)
    const bits = key.asymmetricKeyDetails?.modulusLength ?? 0
    return key.asymmetricKeyType === "rsa" && bits >= MIN_KEY_BITS ? key : missing
  } catch {
    return missing
  }
}

export interface Sealed {
  schema: typeof SEALED_SCHEMA
  algorithm: "RSA-OAEP-256 + AES-256-GCM"
  key: string // the content key, encrypted to the owner's public key, base64
  iv: string
  tag: string
  data: string // the files as JSON, encrypted with the content key, base64
}

// Encrypts files (name to content) to an RSA public key: a fresh AES-256-GCM key for the content, wrapped with
// RSA-OAEP over SHA-256. Only the matching private key opens it.
export function seal(files: Record<string, Buffer>, pem: string | KeyObject): Sealed {
  const key = typeof pem === "string" ? createPublicKey(pem) : pem
  const content = randomBytes(32)
  const iv = randomBytes(12)
  const cipher = createCipheriv("aes-256-gcm", content, iv)
  const plain = Buffer.from(
    JSON.stringify(Object.fromEntries(Object.entries(files).map(([name, data]) => [name, data.toString("base64")]))),
  )
  const data = Buffer.concat([cipher.update(plain), cipher.final()])
  return {
    schema: SEALED_SCHEMA,
    algorithm: "RSA-OAEP-256 + AES-256-GCM",
    key: publicEncrypt({ key, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" }, content).toString(
      "base64",
    ),
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    data: data.toString("base64"),
  }
}

export function unseal(sealed: Sealed, pem: string): Record<string, Buffer> {
  if (sealed?.schema !== SEALED_SCHEMA) throw new Error(`not a ${SEALED_SCHEMA} file`)
  const content = privateDecrypt(
    { key: createPrivateKey(pem), padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" },
    Buffer.from(sealed.key, "base64"),
  )
  const decipher = createDecipheriv("aes-256-gcm", content, Buffer.from(sealed.iv, "base64"))
  decipher.setAuthTag(Buffer.from(sealed.tag, "base64"))
  const plain = Buffer.concat([decipher.update(Buffer.from(sealed.data, "base64")), decipher.final()])
  const files = JSON.parse(plain.toString("utf8")) as Record<string, string>
  return Object.fromEntries(Object.entries(files).map(([name, data]) => [name, Buffer.from(data, "base64")]))
}
