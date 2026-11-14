/** Import-free contract: only this guarded program layout may read a sibling account-deletion tombstone. */
export const AUTHORITY_MARKER = "-- vector-everywhere-authority-v1\n"
export const ACCOUNT_TOMBSTONE_KEY = /^vector:codium:(?:live|test):tombstone:[0-9a-f-]{36}$/
