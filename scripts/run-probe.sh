#!/usr/bin/env bash
# Runs one read-only probe for .github/workflows/fuji-readonly-probe.yml, shows its
# JSON on stdout and saves it to <output.json>, then maps the exit status:
#   0   OK
#   75  UNVERIFIED: the RPC endpoint rate-limited the probe or refused an eth_getLogs
#       range (scripts/lib/probe-rpc.mjs). The output is incomplete, not a finding:
#       reported as a warning and the step passes.
#   *   FAILED: the step fails.
# Each outcome is appended to probe-outcomes.txt and the job summary.
#
#   bash scripts/run-probe.sh <output.json> <script.mjs>
set -uo pipefail

out="$1"
script="$2"
node "$script" | tee "$out"
status=$?

case "$status" in
  0) outcome="OK" ;;
  75)
    outcome="UNVERIFIED (RPC limit; output incomplete, not a finding)"
    echo "::warning title=UNVERIFIED (RPC limit)::${script}: see the RPC_LIMIT line in this step's log; ${out} is incomplete. A private endpoint in the FUJI_RPC_URL / MAINNET_RPC_URL repository secrets avoids the public endpoint's limits."
    ;;
  *) outcome="FAILED (exit ${status})" ;;
esac
echo "${out}: ${outcome}" >> probe-outcomes.txt
if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then echo "- \`${script}\`: ${outcome}" >> "$GITHUB_STEP_SUMMARY"; fi

if [ "$status" -eq 75 ]; then exit 0; fi
exit "$status"
