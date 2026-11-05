#!/bin/bash
set -euo pipefail

signing_dir="$RUNNER_TEMP/vector-hands-signing-${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}"
if [[ ! -e "$signing_dir" ]]; then exit 0; fi
if [[ ! -d "$signing_dir" || -L "$signing_dir" ]]; then
  echo "signing-cleanup result=invalid-directory"
  exit 1
fi

# Revoke only this generated certificate, then prove Deny and actual negative
# code-sign trust before restoring the user's exact keychain search list/deleting
# private material. The explicit Deny record remains until this disposable VM dies.
node "$GITHUB_WORKSPACE/.github/scripts/computer-helper-signing-verification.mjs" --cleanup "$signing_dir"
