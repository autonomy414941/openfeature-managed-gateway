#!/usr/bin/env bash
set -euo pipefail

BASE_URL="${BASE_URL:-http://openfeature-gateway.46.225.49.219.nip.io}"

health_payload="$(curl -fsS "$BASE_URL/api/health")"
status="$(printf '%s' "$health_payload" | jq -r '.status')"
if [[ "$status" != "ok" ]]; then
  echo "health check failed: $health_payload" >&2
  exit 1
fi

workspace_payload="$(curl -fsS -X POST "$BASE_URL/api/workspaces" \
  -H 'content-type: application/json' \
  --data '{"workspaceName":"Smoke Workspace","environment":"production","source":"smoke","selfTest":true}')"

workspace_id="$(printf '%s' "$workspace_payload" | jq -r '.workspace.workspaceId')"
sandbox_key="$(printf '%s' "$workspace_payload" | jq -r '.workspace.sandboxApiKey')"
if [[ -z "$workspace_id" || "$workspace_id" == "null" || -z "$sandbox_key" || "$sandbox_key" == "null" ]]; then
  echo "workspace create failed: $workspace_payload" >&2
  exit 1
fi

flag_payload="$(curl -fsS -X POST "$BASE_URL/api/flags/upsert" \
  -H 'content-type: application/json' \
  --data "{\"workspaceId\":\"$workspace_id\",\"apiKey\":\"$sandbox_key\",\"flagKey\":\"new-checkout\",\"defaultVariant\":\"off\",\"rolloutPercent\":100,\"source\":\"smoke\",\"selfTest\":true}")"

saved_flag="$(printf '%s' "$flag_payload" | jq -r '.flag.flagKey')"
if [[ "$saved_flag" != "new-checkout" ]]; then
  echo "flag save failed: $flag_payload" >&2
  exit 1
fi

eval_payload="$(curl -fsS -X POST "$BASE_URL/api/evaluate" \
  -H 'content-type: application/json' \
  --data "{\"workspaceId\":\"$workspace_id\",\"apiKey\":\"$sandbox_key\",\"flagKey\":\"new-checkout\",\"targetingKey\":\"customer-42\",\"defaultValue\":false,\"source\":\"smoke\",\"selfTest\":true}")"

eval_value="$(printf '%s' "$eval_payload" | jq -r '.value')"
if [[ "$eval_value" != "true" ]]; then
  echo "evaluation failed: $eval_payload" >&2
  exit 1
fi

checkout_payload="$(curl -fsS -X POST "$BASE_URL/api/billing/checkout" \
  -H 'content-type: application/json' \
  --data "{\"workspaceId\":\"$workspace_id\",\"source\":\"smoke\",\"selfTest\":true}")"

checkout_mode="$(printf '%s' "$checkout_payload" | jq -r '.checkoutMode')"
if [[ "$checkout_mode" != "payment_link" ]]; then
  echo "checkout failed: $checkout_payload" >&2
  exit 1
fi

proof_payload="$(curl -fsS -X POST "$BASE_URL/api/billing/proof" \
  -H 'content-type: application/json' \
  --data "{\"workspaceId\":\"$workspace_id\",\"payerEmail\":\"selftest@example.com\",\"transactionId\":\"smoke-$(date +%s)\",\"source\":\"smoke\",\"selfTest\":true}")"

proof_status="$(printf '%s' "$proof_payload" | jq -r '.status')"
prod_key="$(printf '%s' "$proof_payload" | jq -r '.productionApiKey')"
if [[ "$proof_status" != "accepted" || -z "$prod_key" || "$prod_key" == "null" ]]; then
  echo "proof failed: $proof_payload" >&2
  exit 1
fi

of_payload="$(curl -fsS -X POST "$BASE_URL/api/openfeature/v1/flags/new-checkout/evaluate" \
  -H 'content-type: application/json' \
  -H "x-api-key: $prod_key" \
  --data '{"context":{"targetingKey":"customer-99"},"defaultValue":false,"source":"smoke","selfTest":true}')"

of_reason="$(printf '%s' "$of_payload" | jq -r '.reason')"
if [[ "$of_reason" != "ROLLOUT" && "$of_reason" != "DEFAULT" ]]; then
  echo "openfeature endpoint failed: $of_payload" >&2
  exit 1
fi

metrics_payload="$(curl -fsS "$BASE_URL/api/metrics")"
workspace_created="$(printf '%s' "$metrics_payload" | jq -r '.totals.includingSelfTests.workspace_created')"
payment_proofs="$(printf '%s' "$metrics_payload" | jq -r '.totals.includingSelfTests.payment_evidence_submitted')"
if [[ "$workspace_created" == "null" || "$workspace_created" -lt 1 || "$payment_proofs" -lt 1 ]]; then
  echo "metrics missing expected events: $metrics_payload" >&2
  exit 1
fi

echo "healthStatus=$status"
echo "workspaceId=$workspace_id"
echo "flagKey=$saved_flag"
echo "evaluationValue=$eval_value"
echo "checkoutMode=$checkout_mode"
echo "proofStatus=$proof_status"
echo "openfeatureReason=$of_reason"
echo "workspaceCreatedIncludingSelfTests=$workspace_created"
echo "paymentProofIncludingSelfTests=$payment_proofs"
