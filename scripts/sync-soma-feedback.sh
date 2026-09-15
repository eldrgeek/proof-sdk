#!/bin/sh
# Canonical soma-feedback v4.1 (2026-08-07), plus the Proof+ A1b identity fix.
set -eu
repo=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
canonical=${SOMA_FEEDBACK_SOURCE:-/Users/mikewolf/Projects/SOMA/standards/soma-feedback}
scratch=$(mktemp -d "${TMPDIR:-/tmp}/proof-soma-feedback.XXXXXX")
trap 'rm -f "$scratch/soma-feedback.js" "$scratch/soma-feedback.css"; rmdir "$scratch"' EXIT
cp "$canonical/soma-feedback.js" "$canonical/soma-feedback.css" "$scratch/"
# Fail on upstream drift instead of silently losing the security fix on re-sync.
patch --batch --fuzz=0 -d "$scratch" -p0 < "$repo/scripts/soma-feedback-identity.patch"
for asset in soma-feedback.js soma-feedback.css; do
  if [ "${1:-}" = '--check' ]; then
    cmp "$scratch/$asset" "$repo/public/vendor/soma-feedback/$asset"
  else
    cp "$scratch/$asset" "$repo/public/vendor/soma-feedback/$asset"
  fi
done
