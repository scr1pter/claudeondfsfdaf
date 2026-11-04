# Evaluator corrections after original contract freeze

The original `BUILD_SPEC.md` bytes and all 50 group identities remain unchanged from b12b804. These changes correct or strengthen instrument behavior; none lower the product requirements or omit checks.

1. Capability issuance now accepts any nonempty opaque string, rather than imposing an undocumented 20-character minimum.
2. The documented journal basename accepts safe names containing dots, rather than imposing an undocumented filename alphabet.
3. Existing commit/revocation groups now cover a replacement capability with the same subject on successful replay, and a commit whose request body is held incomplete while revocation is acknowledged.
4. The typed SDK group now compares complete role/state unions and checks nested field/return `any`, rather than only rejecting one example invalid enum value.
5. The valid-JSON corruption probe prioritizes submitted business values, supports string or numeric/list transaction encodings, and tries independently restored scalar candidates rather than assuming the first string is checked payload. A prose storage format cannot universally distinguish checksummed payload from permitted metadata. This is evidence of rejection of a changed record, complemented by schema-independent partial-line, reordering and sequence-gap controls; it is not a proof of every possible checksum implementation.
6. Input negatives now include leading/trailing email whitespace, as already prohibited by the original requirement. A private reference parser bug was corrected; the requirement did not change.
7. Nonexpired-lease contention uses a long lease separate from the short expiry/reclaim case. Graceful shutdown permits five seconds; these avoid timing-based false failures without dropping expiry or process cleanup verification.
8. Valid identifiers that coincide with JavaScript object prototype names are covered inside existing identity/lifecycle groups. The original identifier regexes already allow them; the reference was corrected to use own-property map semantics.
9. Windows child processes are assigned to a non-inheritable kill-on-close Job Object while suspended, before authored code executes. Closing ownership contains detached descendants even after the initial process exits. All service, CLI, SDK and compiler invocations use this ownership; output readers and pipes are joined/closed. POSIX process-group containment is documented as weaker against deliberate session detachment.

Interpretation of the original global creation-status sentence: the explicit workspace uniqueness rule is tested as 409 for duplicate workspace ID. The 200 exact-creation replay status applies to the import creation endpoint, which alone specifies an idempotency-key replay protocol. No workspace replay protocol or key namespace is invented after the freeze.

Independent source review identified these corrections after the initial Node-positive reference run. Reference behavior and frozen requirements did not change to satisfy them.

10. A gate bridge retains every original boolean check and its raw report while translating status/exit-code spelling for the native-team runner. The independent evaluator and BUILD_SPEC bytes remain unchanged. The offline TypeScript compiler is explicitly bound and hashed. The headless native audit requires post-judge API, CLI and SDK verification; browser tools remain available, while the UI audit default still requires browser verification.
