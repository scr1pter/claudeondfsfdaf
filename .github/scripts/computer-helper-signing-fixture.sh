#!/bin/bash
set -euo pipefail
signing_dir="$RUNNER_TEMP/vector-hands-signing-${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}"
mkdir -m 700 "$signing_dir"
keychain="$signing_dir/signing.keychain-db"
certificate="$signing_dir/signing.crt"
cleanup() {
  result=$?
  trap - EXIT
  if ! bash "$GITHUB_WORKSPACE/.github/scripts/computer-helper-signing-cleanup.sh"; then
    if [[ "$result" == 0 ]]; then result=1; fi
  fi
  exit "$result"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
password="$(openssl rand -hex 24)"
echo "::add-mask::$password"
identity="Vector Hands CI Signing ${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}"
cat > "$signing_dir/request.cnf" <<EOF
[req]
distinguished_name=subject
prompt=no
x509_extensions=extensions
[subject]
CN=$identity
[extensions]
basicConstraints=critical,CA:FALSE
keyUsage=critical,digitalSignature
extendedKeyUsage=codeSigning
EOF
openssl req -x509 -newkey rsa:2048 -sha256 -nodes -days 1 -config "$signing_dir/request.cnf" -keyout "$signing_dir/signing.key" -out "$certificate"
openssl pkcs12 -export -inkey "$signing_dir/signing.key" -in "$certificate" -out "$signing_dir/signing.p12" -passout "pass:$password" -keypbe PBE-SHA1-3DES -certpbe PBE-SHA1-3DES -macalg sha1
/usr/bin/security create-keychain -p "$password" "$keychain"
/usr/bin/security unlock-keychain -p "$password" "$keychain"
/usr/bin/security import "$signing_dir/signing.p12" -k "$keychain" -P "$password" -T /usr/bin/codesign
/usr/bin/security set-key-partition-list -S apple-tool:,apple:,codesign: -s -k "$password" "$keychain"
sudo /usr/bin/security add-trusted-cert -d -r trustRoot -p codeSign -k "$keychain" "$certificate"
VECTOR_TEST_CODESIGN_IDENTITY="$identity" VECTOR_TEST_CODESIGN_KEYCHAIN="$keychain" VECTOR_TEST_CODESIGN_CERTIFICATE="$certificate" bun test --only-failures --timeout 120000 ./scripts/computer-helper-sign.test.ts --test-name-pattern '^native certificate signing'
