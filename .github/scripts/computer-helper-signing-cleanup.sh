#!/bin/bash
set -euo pipefail

signing_dir="$RUNNER_TEMP/vector-hands-signing-${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}"
if [[ ! -e "$signing_dir" ]]; then exit 0; fi
if [[ ! -d "$signing_dir" || -L "$signing_dir" ]]; then
  echo "signing-cleanup result=invalid-directory"
  exit 1
fi

failed=0
bounded_cleanup() {
  stage="$1"
  shift
  echo "signing-cleanup stage=$stage result=started"
  if "$@" >/dev/null 2>&1; then
    echo "signing-cleanup stage=$stage result=success"
    return
  else
    result=$?
    echo "signing-cleanup stage=$stage result=failed status=$result"
    failed=1
  fi
}

if [[ -f "$signing_dir/signing.crt" ]]; then
  # Run the alarm in the same privileged process that becomes security, rather
  # than applying a timeout only to its unprivileged sudo parent.
  bounded_cleanup trust-removal sudo -n /usr/bin/perl -e 'alarm 30; exec @ARGV or die "cleanup-exec-failed\n"' \
    /usr/bin/security remove-trusted-cert -d "$signing_dir/signing.crt"
fi
if [[ -f "$signing_dir/signing.keychain-db" ]]; then
  bounded_cleanup keychain-removal /usr/bin/perl -e 'alarm 30; exec @ARGV or die "cleanup-exec-failed\n"' \
    /usr/bin/security delete-keychain "$signing_dir/signing.keychain-db"
fi

# Keep the public certificate and any remaining keychain for the always-step retry
# when OS removal fails. The loose private key and archive are never needed.
rm -f "$signing_dir/signing.key" "$signing_dir/signing.p12" "$signing_dir/request.cnf"
if [[ "$failed" == 0 ]]; then rm -rf "$signing_dir"; fi
exit "$failed"
