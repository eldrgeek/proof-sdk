#!/usr/bin/env bash
# run-live-checks.sh <label> — run every Proof live check against the build the VPS is serving now.
# 1. Records which build is being served.
# 2. Creates fresh documents on the VPS (make-docs.py), one per check, named <check>-<label>.
# 3. Runs each probe in probes/, saving its full output to runs/<label>/<check>.log and its exit code, captured on
#    its own statement straight after the probe (never after a command substitution), then prints a short summary.
# 4. Prints the How-To's health and per-document server-log counts (health-and-logs.py).
# It never prints tokens or keys, and it does NOT deploy: deploy deliberately first with
#   ssh vps '~/proof-data/proof-deploy.sh <ref>'
# Usage: bash run-live-checks.sh <label>
# Authored 2026-09-14 by Claude Opus 5 (CCc) for Mike Wolf.

LABEL="$1"
if [ -z "$LABEL" ]; then echo "usage: run-live-checks.sh <label>" >&2; exit 2; fi
HERE="$(cd "$(dirname "$0")" && pwd)"
P="$HERE/probes"
OUT="$HERE/runs/$LABEL"
mkdir -p "$OUT"

ssh vps 'cd ~/proof-sdk && git log --oneline -1' > "$OUT/build.txt"
echo "serving: $(cat "$OUT/build.txt")"
ssh vps "python3 - $LABEL" < "$HERE/make-docs.py" > "$OUT/docs.txt"
echo "documents created: $(wc -l < "$OUT/docs.txt" | tr -d ' ')"

url() {
  ssh vps "python3 -c \"import json;print(json.load(open('/home/ubuntu/proof-data/$1-$LABEL.json'))['tokenUrl'])\""
}

# run <check> <extra env assignments, space-separated, may be empty> <probe file>
run() {
  local check="$1" vars="$2" probe="$3"
  local doc_url
  doc_url="$(url "$check")"
  # shellcheck disable=SC2086
  env PROOF_DOC_URL="$doc_url" $vars node "$P/$probe" > "$OUT/$check.log" 2>&1
  local rc=$?
  echo "== $check (exit $rc)"
  if [ "$probe" = "e2e-suggest.mjs" ]; then
    grep -E "^(FAIL|SKIP)|steps passed|server /state" "$OUT/$check.log" | cut -c1-300
  else
    grep -vE "^    dispatch" "$OUT/$check.log" | cut -c1-300
  fi
}

run e2e-plain       "TEXT=plain OUT_DIR=$OUT/e2e-plain"       e2e-suggest.mjs
run e2e-brackets    "TEXT=brackets OUT_DIR=$OUT/e2e-brackets" e2e-suggest.mjs
run two-rev-suggest "MODE=suggest SEPARATE_BROWSERS=1"        two-reviewer-probe.mjs
run two-rev-edit    "MODE=edit SEPARATE_BROWSERS=1"           two-reviewer-probe.mjs
run two-rev-same-suggest "MODE=suggest SEPARATE_BROWSERS=1 SAME_PARAGRAPH=1" two-reviewer-probe.mjs
run two-rev-same-edit    "MODE=edit SEPARATE_BROWSERS=1 SAME_PARAGRAPH=1"    two-reviewer-probe.mjs
run rest-reject     ""                                        rest-reject-live-probe.mjs
run agent-live      ""                                        agent-live-probe.mjs
run agent-concurrent ""                                       agent-concurrent-probe.mjs
run closetab        "CLOSE_DELAY_MS=300"                      close-tab-probe.mjs
run ai-block-accept "ACTION=accept"                           ai-block-probe.mjs
run ai-block-reject "ACTION=reject"                           ai-block-probe.mjs
run ai-format-1     "SET=1"                                   ai-format-probe.mjs
run ai-format-2     "SET=2"                                   ai-format-probe.mjs
run ai-format-3     "SET=3"                                   ai-format-probe.mjs

echo "== How-To health and server-log counts"
ssh vps "python3 - $LABEL" < "$HERE/health-and-logs.py" | tee "$OUT/health.txt"
