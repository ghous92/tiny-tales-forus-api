#!/usr/bin/env bash
# Wrapper for the globally installed `razorpay` CLI: credentials are pulled
# from GCP Secret Manager at call time and passed via the process environment
# only — nothing is written to disk (no ~/.razorpay/config.yaml) and no key
# material is ever printed.
#
# Usage:
#   scripts/dev/rzp.sh orders list --count 5
#   scripts/dev/rzp.sh orders fetch order_xxxxxxxxxxxx
#
# Requires: gcloud authed as an account with secretAccessor on the
# RAZORPAY_* secrets in laanya-prod (adixaiservice@gmail.com).
set -euo pipefail

PROJECT=laanya-prod

KEY_ID=$(gcloud secrets versions access latest --secret=RAZORPAY_KEY_ID --project "$PROJECT")
KEY_SECRET=$(gcloud secrets versions access latest --secret=RAZORPAY_KEY_SECRET --project "$PROJECT")

if [[ "$KEY_ID" == *PLACEHOLDER* || "$KEY_SECRET" == *PLACEHOLDER* ]]; then
  echo "Razorpay secrets in Secret Manager are still placeholders." >&2
  echo "Add real TEST keys first (values from dashboard.razorpay.com):" >&2
  echo '  printf %s "rzp_test_..." | gcloud secrets versions add RAZORPAY_KEY_ID --data-file=- --project=laanya-prod' >&2
  echo '  printf %s "<key secret>" | gcloud secrets versions add RAZORPAY_KEY_SECRET --data-file=- --project=laanya-prod' >&2
  exit 1
fi

RAZORPAY_KEY_ID="$KEY_ID" RAZORPAY_KEY_SECRET="$KEY_SECRET" exec razorpay "$@"
