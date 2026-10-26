#!/usr/bin/env bash
# End-to-end smoke test of the payments module against a RUNNING tinytales-api,
# using the real Razorpay TEST-mode API (via the razorpay CLI) plus a locally
# signed webhook. No Checkout UI and no real money involved.
#
# Flow proven:
#   mint real phone-verified ID token  →  PUT a cart line  →  ensure an address
#   →  POST /v1/payments/orders (server-priced)  →  cross-check the order on
#   Razorpay via `razorpay orders fetch`  →  POST a correctly HMAC-signed
#   payment.captured webhook  →  order is `paid` AND the cart is cleared
#   →  replay the webhook (idempotency no-op).
#
# Usage:
#   scripts/dev/verify-payments.sh                       # http://localhost:8080
#   scripts/dev/verify-payments.sh https://tinytales-api-staging-69070121252.asia-southeast1.run.app
#
# Webhook secret: taken from $RAZORPAY_WEBHOOK_SECRET if set (use this when the
# local server's .env differs from Secret Manager), else fetched from Secret
# Manager. It must match what the TARGET server was booted with, or the signed
# webhook will (correctly) get a 400.
#
# SAFETY: refuses to run if the server reports mode "live" — the simulated
# webhook marks an order paid without a real payment, which must never happen
# against live keys.
set -euo pipefail

API=${1:-http://localhost:8080}
DIR=$(cd "$(dirname "$0")" && pwd)
PROJECT=tinytalesforus-prod

command -v jq >/dev/null || { echo "jq is required" >&2; exit 1; }

step() { printf '\n== %s\n' "$1"; }
fail() { echo "FAIL: $1" >&2; exit 1; }

step "Minting phone-verified ID token"
TOKEN=$(node "$DIR/mint-token.mjs")
AUTH="Authorization: Bearer $TOKEN"

step "Picking a catalog sku"
SKU=$(curl -sf "$API/v1/catalog" | jq -r '.products[0].variants[0].sku')
[ -n "$SKU" ] && [ "$SKU" != null ] || fail "no sku in /v1/catalog"
echo "sku: $SKU"

step "Putting cart line (qty 1)"
curl -sf -X PUT "$API/v1/cart/items/$SKU" -H "$AUTH" \
  -H 'content-type: application/json' -d '{"qty":1}' >/dev/null

step "Ensuring a saved address"
ADDRESS_ID=$(curl -sf "$API/v1/addresses" -H "$AUTH" | jq -r '.[0].id // empty')
if [ -z "$ADDRESS_ID" ]; then
  ADDRESS_ID=$(curl -sf -X POST "$API/v1/addresses" -H "$AUTH" \
    -H 'content-type: application/json' \
    -d '{"name":"Payments Smoke Test","phone":"9000000000","pincode":"110001","city":"New Delhi","state":"Delhi","houseNumber":"1","roadArea":"Test Road"}' \
    | jq -r '.id')
fi
[ -n "$ADDRESS_ID" ] || fail "could not obtain an address id"
echo "addressId: $ADDRESS_ID"

step "Creating payment order (server-priced)"
CREATE=$(curl -s -w '\n%{http_code}' -X POST "$API/v1/payments/orders" -H "$AUTH" \
  -H 'content-type: application/json' -d "{\"addressId\":\"$ADDRESS_ID\"}")
CODE=$(tail -1 <<<"$CREATE")
ORDER_JSON=$(sed '$d' <<<"$CREATE")
if [ "$CODE" = 503 ]; then
  fail "503 payments_disabled — server has no Razorpay keys or payments.enabled=false"
fi
[ "$CODE" = 201 ] || fail "POST /orders returned $CODE: $ORDER_JSON"
ORDER_ID=$(jq -r '.orderId' <<<"$ORDER_JSON")
AMOUNT_PAISE=$(jq -r '.amountPaise' <<<"$ORDER_JSON")
MODE=$(jq -r '.mode' <<<"$ORDER_JSON")
echo "orderId: $ORDER_ID  amountPaise: $AMOUNT_PAISE  mode: $MODE"

if [ "$MODE" != test ]; then
  echo "REFUSING TO CONTINUE: the server reports mode \"$MODE\"." >&2
  echo "This script simulates a payment.captured webhook, which would mark a" >&2
  echo "real order as paid without any money moving. Run it only against a" >&2
  echo "server configured with rzp_test_* keys." >&2
  exit 1
fi

step "Cross-checking order on Razorpay (razorpay CLI, keys from Secret Manager)"
RZP_ORDER=$("$DIR/rzp.sh" orders fetch "$ORDER_ID")
RZP_AMOUNT=$(jq -r '.amount' <<<"$RZP_ORDER")
[ "$RZP_AMOUNT" = "$AMOUNT_PAISE" ] || fail "Razorpay order amount $RZP_AMOUNT != server $AMOUNT_PAISE"
echo "Razorpay has the order, amount matches ($RZP_AMOUNT paise, status $(jq -r '.status' <<<"$RZP_ORDER"))"

step "Posting signed payment.captured webhook"
if [ -z "${RAZORPAY_WEBHOOK_SECRET:-}" ]; then
  RAZORPAY_WEBHOOK_SECRET=$(gcloud secrets versions access latest --secret=RAZORPAY_WEBHOOK_SECRET --project "$PROJECT")
fi
[[ "$RAZORPAY_WEBHOOK_SECRET" != *PLACEHOLDER* ]] || fail "RAZORPAY_WEBHOOK_SECRET is still a placeholder"
BODY=$(jq -cn --arg oid "$ORDER_ID" --argjson amt "$AMOUNT_PAISE" \
  '{event:"payment.captured",payload:{payment:{entity:{id:"pay_smoke_simulated",order_id:$oid,amount:$amt,currency:"INR"}}}}')
SIG=$(BODY="$BODY" WHS="$RAZORPAY_WEBHOOK_SECRET" node -e \
  'const{createHmac}=require("node:crypto");process.stdout.write(createHmac("sha256",process.env.WHS).update(process.env.BODY).digest("hex"))')
unset RAZORPAY_WEBHOOK_SECRET
WH_CODE=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$API/v1/payments/webhook" \
  -H 'content-type: application/json' -H "x-razorpay-signature: $SIG" --data-binary "$BODY")
[ "$WH_CODE" = 200 ] || fail "webhook returned $WH_CODE (signature mismatch? server webhook secret differs from the one used here)"

step "Verifying order is paid and cart is cleared"
STATUS=$(curl -sf "$API/v1/payments/orders/$ORDER_ID" -H "$AUTH" | jq -r '.status')
[ "$STATUS" = paid ] || fail "order status is \"$STATUS\", expected paid"
CART_COUNT=$(curl -sf "$API/v1/cart" -H "$AUTH" | jq -r '.count')
[ "$CART_COUNT" = 0 ] || fail "cart count is $CART_COUNT after payment, expected 0"

step "Replaying webhook (idempotency)"
REPLAY_CODE=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$API/v1/payments/webhook" \
  -H 'content-type: application/json' -H "x-razorpay-signature: $SIG" --data-binary "$BODY")
[ "$REPLAY_CODE" = 200 ] || fail "webhook replay returned $REPLAY_CODE"
STATUS2=$(curl -sf "$API/v1/payments/orders/$ORDER_ID" -H "$AUTH" | jq -r '.status')
[ "$STATUS2" = paid ] || fail "order status after replay is \"$STATUS2\""

printf '\nPASS — order %s: created (%s paise, test mode), visible on Razorpay, paid via signed webhook, cart cleared, replay was a no-op.\n' "$ORDER_ID" "$AMOUNT_PAISE"
