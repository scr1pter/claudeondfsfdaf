// Vector Remote's end-to-end encryption lives in packages/core/src/remote/crypto.ts (WP A42 moved it there from here,
// unchanged in behaviour), so the phone app runs exactly the code the desktop does. This name stays for the desktop's
// own modules and tests.
export * from "@vectordevai/core/remote/crypto"
