// What can stop a vault operation, each with plain copy for the person. No message carries a key, a code, content or
// an amount.

export type VaultErrorCode =
  /** A piece, a manifest or the wrapped key does not open, or does not match its id. */
  | "damaged"
  /** The version needs a newer reader (`minReader`). */
  | "update"
  /** The recovery code has a typo (its checksum does not match). */
  | "typo"
  /** The recovery code is well formed but does not open this vault's key. */
  | "wrong-code"
  /** The store holds no vault, or not the version asked for. */
  | "not-found"
  /** The store already holds another vault. */
  | "exists"
  /** The GitHub repository is public, or could not be checked to be private. */
  | "public-repo"
  /** The store answered that the plan's vault quota is used (VAULT_QUOTA). */
  | "quota"
  /** The vault takes no uploads now (VAULT_READ_ONLY, or a paused or ended plan). */
  | "read-only"
  /** An uploaded object's size did not match what was declared (VAULT_SIZE_MISMATCH). */
  | "size-mismatch"
  /** Signing in, the plan or the perk is needed, or the store cannot be reached. */
  | "unavailable"

export class VaultError extends Error {
  readonly code: VaultErrorCode
  constructor(code: VaultErrorCode, message: string) {
    super(message)
    this.name = "VaultError"
    this.code = code
  }
}

export function isVaultError(error: unknown): error is VaultError {
  return error instanceof VaultError
}
