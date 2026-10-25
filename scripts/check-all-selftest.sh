#!/usr/bin/env bash
# Mutation proof for scripts/check-all.mjs: a broken stub and a signalled hang must make the runner red.
# Pipes in shell hide a child's exit code; the runner uses spawnSync and must not.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
RUNNER=(node "$ROOT/scripts/check-all.mjs")

tmpdir() { mktemp -d "${TMPDIR:-/tmp}/check-all-selftest.XXXXXX"; }

# Stub that exits 1.
D1=$(tmpdir)
trap 'rm -rf "$D1" "$D2" "$D3"' EXIT
cat >"$D1/broken-stub-check.mjs" <<'EOF'
#!/usr/bin/env node
console.log('FAIL broken-stub-check: intentional breakage');
process.exit(1);
EOF
if "${RUNNER[@]}" --scripts-dir "$D1"; then
  echo "check-all-selftest: expected non-zero for exit-1 stub" >&2
  exit 1
fi
echo "check-all-selftest: exit-1 stub rejected"

# Stub that exits 0 but prints a failure marker.
D2=$(tmpdir)
cat >"$D2/silent-fail-check.mjs" <<'EOF'
#!/usr/bin/env node
console.log('FAIL silent-fail-check: exit 0 but marked fail');
process.exit(0);
EOF
if "${RUNNER[@]}" --scripts-dir "$D2"; then
  echo "check-all-selftest: expected non-zero for FAIL marker with exit 0" >&2
  exit 1
fi
echo "check-all-selftest: FAIL marker with exit 0 rejected"

# Stub killed by signal (runner uses a short timeout; no shell pipe).
D3=$(tmpdir)
cat >"$D3/hang-check.mjs" <<'EOF'
#!/usr/bin/env node
setInterval(() => {}, 60_000);
EOF
if "${RUNNER[@]}" --scripts-dir "$D3" --timeout-ms 300; then
  echo "check-all-selftest: expected non-zero when check is signalled" >&2
  exit 1
fi
echo "check-all-selftest: signalled check rejected"

echo "check-all-selftest: all cases passed"
